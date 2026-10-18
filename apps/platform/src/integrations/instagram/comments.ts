import type pg from 'pg';
import type { Db } from '../../db/tx.js';
import { maybeOne, one } from '../../db/tx.js';
import { decryptSecret } from '../../lib/crypto.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/ids.js';
import type { Services } from '../../services.js';
import { raiseAlert } from '../../modules/alerts.js';
import { audit, auditCtx } from '../../modules/audit.js';
import { type Ctx, requireInfluencerAccess, requirePermission } from '../../modules/context.js';
import { checkOutbound, classifyInbound } from '../../modules/conversation/guard.js';
import { credentialAad } from '../../modules/integrations.js';
import { InstagramApiError, InstagramClient, type IgComment } from './client.js';

/**
 * Instagram comments: periodic ingestion for recent posts, rule-based risk
 * classification (crisis, minors, threats raise alerts), and staff replies or
 * hiding through the Graph API. Replies pass the same output guard as chat.
 * Commenters are not turned into fan records (data minimisation); a comment is
 * linked to a fan only when that Instagram identity is already known.
 */
interface IgChannel {
  id: string;
  workspace_id: string;
  influencer_id: string;
  external_id: string;
  integration_account_id: string;
}

export async function instagramClientFor(svc: Services, accountId: string): Promise<InstagramClient> {
  const a = await one<{ workspace_id: string; provider: string; external_account_id: string; credential_ciphertext: Buffer; credential_nonce: Buffer; data_key_ciphertext: Buffer; wrapping_key_id: string }>(
    svc.workerPool,
    `SELECT workspace_id, provider, external_account_id, credential_ciphertext, credential_nonce, data_key_ciphertext, wrapping_key_id FROM core.integration_accounts WHERE id = $1`,
    [accountId],
  );
  const token = decryptSecret(
    svc.config.masterKeys,
    { ciphertext: a.credential_ciphertext, nonce: a.credential_nonce, dataKeyCiphertext: a.data_key_ciphertext, wrappingKeyId: a.wrapping_key_id },
    credentialAad(a.workspace_id, a.provider, a.external_account_id),
  );
  return new InstagramClient(svc.config.instagram.graphBaseUrl, svc.config.instagram.graphVersion, token);
}

const RISK = new Set(['self_harm_risk', 'minor_signal', 'threat_or_illegal']);

export async function ingestInstagramComments(svc: Services, opts: { days?: number; maxPages?: number } = {}): Promise<{ channels: number; new: number; flagged: number }> {
  const db = svc.workerPool;
  const channels = await db.query<IgChannel>(
    `SELECT c.id, c.workspace_id, c.influencer_id, c.external_id, c.integration_account_id FROM publishing.channels c
       JOIN core.integration_accounts a ON a.id = c.integration_account_id
      WHERE c.kind = 'instagram_account' AND c.status = 'active' AND a.status = 'active'`,
  );
  let fresh = 0;
  let flagged = 0;
  for (const ch of channels.rows) {
    const ig = await instagramClientFor(svc, ch.integration_account_id);
    const pubs = await db.query<{ id: string; external_post_id: string }>(
      `SELECT id, external_post_id FROM publishing.publications WHERE channel_id = $1 AND status = 'published' AND external_post_id IS NOT NULL
          AND published_at > now() - make_interval(days => $2) ORDER BY published_at DESC LIMIT 50`,
      [ch.id, opts.days ?? 14],
    );
    for (const pub of pubs.rows) {
      let after: string | undefined;
      for (let page = 0; page < (opts.maxPages ?? 5); page++) {
        let res;
        try {
          res = await ig.comments(pub.external_post_id, after);
        } catch (err) {
          if (err instanceof InstagramApiError && err.authFailure) {
            await db.query(`UPDATE core.integration_accounts SET status = 'needs_reauth', updated_at = now() WHERE id = $1`, [ch.integration_account_id]);
            await raiseAlert(db, { workspaceId: ch.workspace_id, severity: 'critical', source: 'instagram', code: 'INSTAGRAM_TOKEN_REJECTED', dedupKey: `instagram:token:${ch.integration_account_id}`, message: 'Instagram rejected the access token; reconnect the account' });
          }
          throw err;
        }
        for (const c of res.data) {
          for (const item of [c, ...(c.replies?.data ?? []).map((r) => ({ ...r, parent_id: c.id }))]) {
            const r = await storeComment(db, ch, pub.id, item as IgComment);
            fresh += r.created ? 1 : 0;
            flagged += r.flagged ? 1 : 0;
          }
        }
        after = res.paging?.cursors?.after;
        if (!after || !res.paging?.next) break;
      }
    }
  }
  return { channels: channels.rows.length, new: fresh, flagged };
}

async function storeComment(db: pg.Pool, ch: IgChannel, publicationId: string, c: IgComment): Promise<{ created: boolean; flagged: boolean }> {
  if (c.from?.id === ch.external_id) return { created: false, flagged: false }; // our own replies
  const signals = classifyInbound(c.text ?? '');
  const risky = signals.filter((s) => RISK.has(s));
  const fan = c.from?.id
    ? await maybeOne<{ fan_id: string }>(
        db,
        `SELECT fan_id FROM crm.fan_identities WHERE workspace_id = $1 AND platform = 'instagram' AND scope_ref = $2 AND platform_user_id = $3`,
        [ch.workspace_id, ch.external_id, c.from.id],
      )
    : null;
  const id = uuidv7();
  const ins = await db.query(
    `INSERT INTO publishing.comments (id, workspace_id, influencer_id, channel_id, publication_id, external_comment_id, parent_external_id, fan_id,
       author_platform_user_id, author_username, body, classification, status, commented_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (channel_id, external_comment_id) DO NOTHING`,
    [
      id,
      ch.workspace_id,
      ch.influencer_id,
      ch.id,
      publicationId,
      c.id,
      c.parent_id ?? null,
      fan?.fan_id ?? null,
      c.from?.id ?? null,
      c.username ?? c.from?.username ?? null,
      c.text ?? '',
      JSON.stringify({ signals, method: 'rules_v1' }),
      risky.length ? 'escalated' : 'new',
      c.timestamp ? new Date(c.timestamp) : new Date(),
    ],
  );
  if (!ins.rowCount) return { created: false, flagged: false };
  if (risky.length) {
    await raiseAlert(db, {
      workspaceId: ch.workspace_id,
      severity: risky.includes('self_harm_risk') ? 'critical' : 'warning',
      source: 'instagram',
      code: `COMMENT_${risky[0]!.toUpperCase()}`,
      dedupKey: `comment:${id}`,
      message: `An Instagram comment needs a human (${risky.join(', ')})`,
      details: { comment_id: id, channel_id: ch.id },
    });
  }
  return { created: true, flagged: risky.length > 0 };
}

// -----------------------------------------------------------------------------
// Staff moderation
// -----------------------------------------------------------------------------
export async function listComments(db: Db, ctx: Ctx, influencerId: string, status?: string): Promise<unknown[]> {
  requirePermission(ctx, 'comment.read');
  requireInfluencerAccess(ctx, influencerId);
  const { rows } = await db.query(
    `SELECT id, channel_id, publication_id, external_comment_id, parent_external_id, author_username, body, classification, status, commented_at
       FROM publishing.comments WHERE influencer_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY commented_at DESC LIMIT 500`,
    [influencerId, status ?? null],
  );
  return rows;
}

async function commentFor(db: Db, ctx: Ctx, id: string, permission: string) {
  requirePermission(ctx, permission);
  const c = await maybeOne<{ id: string; influencer_id: string; channel_id: string; external_comment_id: string; status: string; integration_account_id: string; kind: string }>(
    db,
    `SELECT m.id, m.influencer_id, m.channel_id, m.external_comment_id, m.status, ch.integration_account_id, ch.kind
       FROM publishing.comments m JOIN publishing.channels ch ON ch.id = m.channel_id WHERE m.id = $1`,
    [id],
  );
  if (!c) throw notFound('Comment', id);
  requireInfluencerAccess(ctx, c.influencer_id);
  if (c.kind !== 'instagram_account') throw conflict('UNSUPPORTED_CHANNEL', 'Only Instagram comments can be moderated here');
  return c;
}

/** Replies publicly as the influencer (staff action; the AI disclosure is in the account bio and the guard applies). */
export async function replyToComment(svc: Services, db: Db, ctx: Ctx, commentId: string, body: string): Promise<{ action_id: string }> {
  const c = await commentFor(db, ctx, commentId, 'comment.reply');
  const violations = checkOutbound(body, 2200);
  if (violations.length) throw new AppError(422, 'GUARD_VIOLATION', 'The reply breaks platform rules', { violations });
  const actionId = uuidv7();
  await db.query(
    `INSERT INTO publishing.comment_actions (id, workspace_id, comment_id, action, body, actor_type, actor_id, status) VALUES ($1, $2, $3, 'reply', $4, $5, $6, 'pending')`,
    [actionId, ctx.workspaceId, commentId, body, ctx.actor.type === 'agent' ? 'agent' : ctx.actor.type === 'system' ? 'system' : 'user', ctx.actor.id],
  );
  const ig = await instagramClientFor(svc, c.integration_account_id);
  try {
    await ig.replyToComment(c.external_comment_id, body);
  } catch (err) {
    await db.query(`UPDATE publishing.comment_actions SET status = 'failed' WHERE id = $1`, [actionId]);
    await auditCtx(db, ctx, { influencerId: c.influencer_id, action: 'comment.reply_failed', subjectType: 'comment', subjectId: commentId, metadata: { error: (err as Error).message } });
    throw new AppError(502, 'INSTAGRAM_ERROR', (err as Error).message);
  }
  await db.query(`UPDATE publishing.comment_actions SET status = 'done' WHERE id = $1`, [actionId]);
  await db.query(`UPDATE publishing.comments SET status = 'replied' WHERE id = $1`, [commentId]);
  await auditCtx(db, ctx, { influencerId: c.influencer_id, action: 'comment.reply', subjectType: 'comment', subjectId: commentId, metadata: { action_id: actionId } });
  return { action_id: actionId };
}

export async function setCommentHidden(svc: Services, db: Db, ctx: Ctx, commentId: string, hide: boolean): Promise<{ status: string }> {
  const c = await commentFor(db, ctx, commentId, 'comment.moderate');
  const ig = await instagramClientFor(svc, c.integration_account_id);
  await ig.hideComment(c.external_comment_id, hide).catch((err: Error) => {
    throw new AppError(502, 'INSTAGRAM_ERROR', err.message);
  });
  await db.query(
    `INSERT INTO publishing.comment_actions (workspace_id, comment_id, action, actor_type, actor_id, status) VALUES ($1, $2, $3, $4, $5, 'done')`,
    [ctx.workspaceId, commentId, hide ? 'hide' : 'unhide', ctx.actor.type === 'agent' ? 'agent' : 'user', ctx.actor.id],
  );
  const status = hide ? 'hidden' : 'new';
  await db.query(`UPDATE publishing.comments SET status = $2 WHERE id = $1`, [commentId, status]);
  await auditCtx(db, ctx, { influencerId: c.influencer_id, action: hide ? 'comment.hide' : 'comment.unhide', subjectType: 'comment', subjectId: commentId });
  return { status };
}

export async function resolveComment(db: Db, ctx: Ctx, commentId: string, status: 'ignored' | 'new'): Promise<{ status: string }> {
  requirePermission(ctx, 'comment.moderate');
  const c = await maybeOne<{ influencer_id: string }>(db, 'SELECT influencer_id FROM publishing.comments WHERE id = $1', [commentId]);
  if (!c) throw notFound('Comment', commentId);
  requireInfluencerAccess(ctx, c.influencer_id);
  await db.query(`UPDATE publishing.comments SET status = $2 WHERE id = $1`, [commentId, status]);
  await audit(db, { workspaceId: ctx.workspaceId, influencerId: c.influencer_id, actor: ctx.actor, action: `comment.mark_${status}`, subjectType: 'comment', subjectId: commentId });
  return { status };
}
