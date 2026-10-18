import type pg from 'pg';
import type { Db } from '../db/tx.js';
import { maybeOne, one, withTx } from '../db/tx.js';
import { decryptSecret } from '../lib/crypto.js';
import { PG, badRequest, conflict, notFound, pgCode, unprocessable } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { sha256Bytes } from '../lib/canonical-json.js';
import type { Services } from '../services.js';
import { audit, auditCtx, outbox } from './audit.js';
import { type Actor, type Ctx, requireInfluencerAccess, requirePermission } from './context.js';
import { RATINGS, type Rating, loadContentItem } from './content.js';
import { credentialAad } from './integrations.js';

// -----------------------------------------------------------------------------
// Channel adapters (Instagram Graph API, Telegram Bot API). Adapters are opt-in
// (PUBLISHING_ADAPTERS): without one, due publications are held with
// NO_CHANNEL_ADAPTER instead of being reported as published.
// -----------------------------------------------------------------------------

export interface PublishRequest {
  publicationId: string;
  idempotencyKey: string;
  channel: { id: string; kind: string; external_id: string; username: string | null };
  revision: { id: string; caption: string | null; hashtags: string[]; alt_text: string | null; disclosure_text: string };
  assets: { media_asset_id: string; role: string; mime_type: string; path: string }[];
  credential: string;
  platformFlags: Record<string, unknown>;
}

export interface PublishingAdapter {
  readonly channelKind: string;
  /**
   * Must be idempotent on idempotencyKey where the platform allows it. Throw to fail; set `ambiguous` on the
   * error if the outcome is unknown, or `retryAfterMs` if the request was definitely not applied.
   */
  publish(req: PublishRequest): Promise<{ externalPostId: string; permalink?: string | null }>;
}

export class PublishingAdapters {
  private readonly byKind = new Map<string, PublishingAdapter>();

  register(adapter: PublishingAdapter): void {
    this.byKind.set(adapter.channelKind, adapter);
  }

  get(kind: string): PublishingAdapter | undefined {
    return this.byKind.get(kind);
  }
}

const PUBLISHER_ACTOR: Actor = { type: 'system', id: 'publisher' };
const MAX_PUBLISH_ATTEMPTS = 5;

function ratingIndex(r: Rating): number {
  return RATINGS.indexOf(r);
}

async function revisionHasMockAssets(db: Db | pg.Pool, revisionId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM content.revision_assets ra JOIN content.media_assets m ON m.id = ra.media_asset_id
      WHERE ra.revision_id = $1 AND m.engine_kind = 'contract_mock' LIMIT 1`,
    [revisionId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Schedules the item's approved current revision on a channel. Authorization
 * is bound to the approved content hash; the DB trigger re-checks it.
 */
export async function schedulePublication(
  db: Db,
  ctx: Ctx,
  svc: Pick<Services, 'publishingAdapters'>,
  itemId: string,
  input: { channel_id: string; scheduled_for: string; revision_id?: string | null },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'publication.schedule');
  const item = await loadContentItem(db, ctx, itemId, true);
  if (!item.current_revision_id) throw conflict('NO_REVISION', 'Content item has no revision');
  if (input.revision_id && input.revision_id !== item.current_revision_id) {
    throw conflict('REVISION_NOT_CURRENT', 'Only the current revision can be scheduled');
  }
  const revision = await one<{ id: string; content_hash: Buffer }>(db, 'SELECT id, content_hash FROM content.content_revisions WHERE id = $1', [
    item.current_revision_id,
  ]);
  const approval = await maybeOne<{ id: string; payload_snapshot: { content_hash?: string } }>(
    db,
    `SELECT id, payload_snapshot FROM approvals.approval_requests
      WHERE subject_type = 'content_revision' AND subject_id = $1 AND status = 'approved'
      ORDER BY decided_at DESC LIMIT 1`,
    [revision.id],
  );
  if (!approval) throw conflict('NOT_APPROVED', 'The current revision has no approved approval request');
  if (approval.payload_snapshot.content_hash !== revision.content_hash.toString('hex')) {
    throw conflict('UNAUTHORIZED_CONTENT', 'Approved payload does not match the revision content hash');
  }
  const channel = await maybeOne<{ id: string; influencer_id: string; kind: string; status: string; publish_frozen: boolean; max_rating: Rating; account_status: string }>(
    db,
    `SELECT c.id, c.influencer_id, c.kind, c.status, c.publish_frozen, c.max_rating, a.status AS account_status
       FROM publishing.channels c JOIN core.integration_accounts a ON a.id = c.integration_account_id
      WHERE c.id = $1`,
    [input.channel_id],
  );
  if (!channel) throw notFound('Channel', input.channel_id);
  if (channel.influencer_id !== item.influencer_id) throw unprocessable('CHANNEL_NOT_OWNED', 'Channel belongs to another influencer');
  if (channel.status !== 'active' || channel.publish_frozen) throw conflict('CHANNEL_UNAVAILABLE', `Channel is ${channel.publish_frozen ? 'frozen' : channel.status}`);
  if (channel.account_status !== 'active') throw conflict('ACCOUNT_UNAVAILABLE', `Integration account is ${channel.account_status}`);
  const rating = item.assessed_rating ?? item.target_rating;
  if (ratingIndex(rating) > ratingIndex(channel.max_rating)) {
    throw unprocessable('RATING_EXCEEDS_CHANNEL', `Content rated ${rating} exceeds channel maximum ${channel.max_rating}`);
  }
  const invalid = await db.query(
    `SELECT m.id FROM content.revision_assets ra JOIN content.media_assets m ON m.id = ra.media_asset_id
      WHERE ra.revision_id = $1 AND m.status <> 'valid'`,
    [revision.id],
  );
  if (invalid.rowCount) throw unprocessable('ASSET_NOT_VALID', 'Revision contains assets that are no longer valid');
  const when = new Date(input.scheduled_for);
  if (Number.isNaN(when.getTime())) throw badRequest('INVALID_SCHEDULE', 'scheduled_for must be an ISO 8601 timestamp');
  if (when.getTime() < Date.now() - 60_000) throw badRequest('INVALID_SCHEDULE', 'scheduled_for is in the past');

  const id = uuidv7();
  let publication;
  try {
    publication = await one(
      db,
      `INSERT INTO publishing.publications (id, workspace_id, influencer_id, content_item_id, revision_id, channel_id,
         scheduled_for, status, authorized_content_hash, authorization_kind, approval_request_id, platform_flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled', $8, 'human_approval', $9, $10) RETURNING *`,
      [id, ctx.workspaceId, item.influencer_id, item.id, revision.id, channel.id, when, revision.content_hash, approval.id, JSON.stringify({ is_ai_generated: true })],
    );
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('ALREADY_SCHEDULED', 'This item already has a publication on this channel');
    throw err;
  }
  await db.query(`UPDATE content.content_items SET status = 'scheduled', updated_at = now() WHERE id = $1`, [item.id]);
  const mock = await revisionHasMockAssets(db, revision.id);
  const adapterAvailable = svc.publishingAdapters.get(channel.kind) !== undefined;
  await auditCtx(db, ctx, {
    influencerId: item.influencer_id,
    action: 'publication.schedule',
    subjectType: 'publication',
    subjectId: id,
    approvalRequestId: approval.id,
    metadata: {
      content_item_id: item.id,
      revision_id: revision.id,
      channel_id: channel.id,
      channel_kind: channel.kind,
      scheduled_for: when.toISOString(),
      authorized_content_hash: revision.content_hash.toString('hex'),
      contains_contract_mock_assets: mock,
      adapter_available: adapterAvailable,
    },
  });
  await outbox(db, { workspaceId: ctx.workspaceId, eventType: 'publishing.scheduled', aggregateType: 'publication', aggregateId: id, payload: { channel_id: channel.id, scheduled_for: when.toISOString() } });
  return {
    ...publicPublication(publication as PublicationRow),
    execution: {
      adapter_available: adapterAvailable,
      contains_contract_mock_assets: mock,
      will_execute: adapterAvailable && !mock,
      blocked_reason: mock ? 'MOCK_ASSET_NOT_PUBLISHABLE' : adapterAvailable ? null : 'NO_CHANNEL_ADAPTER',
    },
  };
}

interface PublicationRow {
  id: string;
  workspace_id: string;
  influencer_id: string;
  content_item_id: string;
  revision_id: string;
  channel_id: string;
  status: string;
  authorized_content_hash: Buffer | null;
  last_error: { code?: string } | null;
  platform_flags: Record<string, unknown>;
  attempts: number;
}

export function publicPublication(p: PublicationRow): Record<string, unknown> {
  return { ...p, authorized_content_hash: p.authorized_content_hash ? p.authorized_content_hash.toString('hex') : null };
}

export async function cancelPublication(db: Db, ctx: Ctx, publicationId: string, reason: string | null): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'publication.cancel');
  const pub = await maybeOne<PublicationRow>(db, 'SELECT * FROM publishing.publications WHERE id = $1 FOR UPDATE', [publicationId]);
  if (!pub) throw notFound('Publication', publicationId);
  requireInfluencerAccess(ctx, pub.influencer_id);
  if (!['pending_authorization', 'scheduled'].includes(pub.status)) throw conflict('NOT_CANCELLABLE', `Publication is ${pub.status}`);
  const row = await one<PublicationRow>(db, `UPDATE publishing.publications SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *`, [publicationId]);
  await db.query(
    `UPDATE content.content_items SET status = 'approved', updated_at = now()
      WHERE id = $1 AND status = 'scheduled'
        AND NOT EXISTS (SELECT 1 FROM publishing.publications WHERE content_item_id = $1 AND status IN ('scheduled', 'publishing', 'published'))`,
    [pub.content_item_id],
  );
  await auditCtx(db, ctx, { influencerId: pub.influencer_id, action: 'publication.cancel', subjectType: 'publication', subjectId: publicationId, metadata: { reason } });
  return publicPublication(row);
}

export async function listPublications(db: Db, ctx: Ctx, influencerId: string): Promise<unknown[]> {
  requirePermission(ctx, 'publication.read');
  requireInfluencerAccess(ctx, influencerId);
  const { rows } = await db.query<PublicationRow>('SELECT * FROM publishing.publications WHERE influencer_id = $1 ORDER BY scheduled_for DESC LIMIT 200', [
    influencerId,
  ]);
  return rows.map(publicPublication);
}

async function holdPublication(db: Db, pub: PublicationRow, code: string, message: string): Promise<void> {
  if (pub.last_error?.code === code) return; // already reported; avoid audit spam on every tick
  await db.query(`UPDATE publishing.publications SET last_error = $2, updated_at = now() WHERE id = $1`, [
    pub.id,
    JSON.stringify({ code, message, at: new Date().toISOString() }),
  ]);
  await audit(db, {
    workspaceId: pub.workspace_id,
    influencerId: pub.influencer_id,
    actor: PUBLISHER_ACTOR,
    action: 'publication.held',
    subjectType: 'publication',
    subjectId: pub.id,
    metadata: { code, message },
  });
}

/**
 * Executes due publications. Every guard is re-checked at execution time
 * (approval hash via DB trigger, channel freeze, influencer status, contract-mock
 * assets, adapter availability). A publication is never marked published
 * without a provider-confirmed post id.
 */
export async function publisherTick(svc: Services): Promise<{ held: number; published: number; failed: number }> {
  const result = { held: 0, published: 0, failed: 0 };
  const due = await svc.workerPool.query<{ id: string }>(
    `SELECT id FROM publishing.publications WHERE status = 'scheduled' AND scheduled_for <= now() ORDER BY scheduled_for LIMIT 20`,
  );
  for (const { id } of due.rows) {
    const claim = await withTx(svc.workerPool, async (db) => {
      const pub = await maybeOne<PublicationRow & { kind: string; external_id: string; channel_status: string; publish_frozen: boolean; influencer_status: string; integration_account_id: string }>(
        db,
        `SELECT p.*, c.kind, c.external_id, c.status AS channel_status, c.publish_frozen, i.status AS influencer_status, c.integration_account_id
           FROM publishing.publications p
           JOIN publishing.channels c ON c.id = p.channel_id
           JOIN identity.influencers i ON i.id = p.influencer_id
          WHERE p.id = $1 AND p.status = 'scheduled' FOR UPDATE OF p SKIP LOCKED`,
        [id],
      );
      if (!pub) return null;
      if (await revisionHasMockAssets(db, pub.revision_id)) {
        await holdPublication(db, pub, 'MOCK_ASSET_NOT_PUBLISHABLE', 'revision contains contract-mock output; it can never be published');
        return null;
      }
      if (pub.channel_status !== 'active' || pub.publish_frozen) {
        await holdPublication(db, pub, 'CHANNEL_UNAVAILABLE', 'channel is paused, disconnected or frozen');
        return null;
      }
      const stop = await maybeOne<{ key: string }>(
        db,
        `SELECT key FROM core.feature_flags WHERE key = 'kill_switch.publishing' AND value = 'true'::jsonb
            AND (workspace_id IS NULL OR workspace_id = $1) AND (influencer_id IS NULL OR influencer_id = $2) LIMIT 1`,
        [pub.workspace_id, pub.influencer_id],
      );
      if (stop) {
        await holdPublication(db, pub, 'KILL_SWITCH', 'publishing is stopped by a kill switch');
        return null;
      }
      if (pub.influencer_status !== 'active') {
        await holdPublication(db, pub, 'INFLUENCER_NOT_ACTIVE', `influencer is ${pub.influencer_status}`);
        return null;
      }
      const adapter = svc.publishingAdapters.get(pub.kind);
      if (!adapter) {
        await holdPublication(db, pub, 'NO_CHANNEL_ADAPTER', `no publishing adapter enabled for ${pub.kind} (PUBLISHING_ADAPTERS); not executed`);
        return null;
      }
      const opKey = `publish:${pub.id}`;
      const op = await one<{ id: string }>(
        db,
        `INSERT INTO core.external_operations (workspace_id, idempotency_key, provider, operation, subject_type, subject_id, request_hash, status, attempts)
         VALUES ($1, $2, $3, 'publish', 'publication', $4, $5, 'in_flight', 1)
         ON CONFLICT (idempotency_key) DO UPDATE SET attempts = core.external_operations.attempts + 1, status = 'in_flight', updated_at = now()
         RETURNING id`,
        [pub.workspace_id, opKey, pub.kind, pub.id, pub.authorized_content_hash ?? sha256Bytes(pub.id)],
      );
      // The trigger re-verifies the approval binding and the contract-mock guard here.
      await db.query(
        `UPDATE publishing.publications SET status = 'publishing', external_operation_id = $2, attempts = attempts + 1, updated_at = now() WHERE id = $1`,
        [pub.id, op.id],
      );
      return { pub, adapter, opKey, opId: op.id };
    });
    if (!claim) {
      result.held++;
      continue;
    }
    const { pub, adapter, opKey, opId } = claim;
    try {
      const request = await buildPublishRequest(svc, pub.id, opKey);
      const out = await adapter.publish(request);
      await withTx(svc.workerPool, async (db) => {
        await db.query(
          `UPDATE publishing.publications SET status = 'published', external_post_id = $2, permalink = $3, published_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
          [pub.id, out.externalPostId, out.permalink ?? null],
        );
        await db.query(`UPDATE core.external_operations SET status = 'succeeded', external_ref = $2, completed_at = now(), updated_at = now() WHERE id = $1`, [opId, out.externalPostId]);
        await db.query(`UPDATE content.content_items SET status = 'published', updated_at = now() WHERE id = $1`, [pub.content_item_id]);
        await audit(db, { workspaceId: pub.workspace_id, influencerId: pub.influencer_id, actor: PUBLISHER_ACTOR, action: 'publication.published', subjectType: 'publication', subjectId: pub.id, metadata: { external_post_id: out.externalPostId, channel_id: pub.channel_id } });
      });
      result.published++;
    } catch (err) {
      const ambiguous = (err as { ambiguous?: boolean }).ambiguous === true;
      const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
      if (!ambiguous && retryAfterMs !== undefined && pub.attempts < MAX_PUBLISH_ATTEMPTS) {
        // Definitely not applied (rate limit, quota, container still processing): try again later.
        await withTx(svc.workerPool, async (db) => {
          await db.query(
            `UPDATE publishing.publications SET status = 'scheduled', scheduled_for = now() + make_interval(secs => $2::float8 / 1000), last_error = $3, updated_at = now() WHERE id = $1`,
            [pub.id, retryAfterMs, JSON.stringify({ code: 'PUBLISH_RETRY', message: (err as Error).message, attempt: pub.attempts })],
          );
          await db.query(`UPDATE core.external_operations SET status = 'failed_retryable', last_error = $2, updated_at = now() WHERE id = $1`, [opId, JSON.stringify({ message: (err as Error).message })]);
        });
        result.failed++;
        continue;
      }
      await withTx(svc.workerPool, async (db) => {
        await db.query(`UPDATE publishing.publications SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`, [
          pub.id,
          ambiguous ? 'unknown' : 'failed',
          JSON.stringify({ code: ambiguous ? 'PUBLISH_OUTCOME_UNKNOWN' : 'PUBLISH_FAILED', message: (err as Error).message }),
        ]);
        await db.query(`UPDATE core.external_operations SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`, [
          opId,
          ambiguous ? 'unknown' : 'failed_permanent',
          JSON.stringify({ message: (err as Error).message }),
        ]);
        await audit(db, { workspaceId: pub.workspace_id, influencerId: pub.influencer_id, actor: PUBLISHER_ACTOR, action: ambiguous ? 'publication.unknown' : 'publication.failed', subjectType: 'publication', subjectId: pub.id, metadata: { error: (err as Error).message } });
      });
      result.failed++;
    }
  }
  return result;
}

async function buildPublishRequest(svc: Services, publicationId: string, idempotencyKey: string): Promise<PublishRequest> {
  const db = svc.workerPool;
  const p = await one<{
    id: string;
    workspace_id: string;
    platform_flags: Record<string, unknown>;
    channel_id: string;
    kind: string;
    external_id: string;
    username: string | null;
    revision_id: string;
    caption: string | null;
    hashtags: string[];
    alt_text: string | null;
    disclosure_text: string;
    provider: string;
    external_account_id: string;
    credential_ciphertext: Buffer;
    credential_nonce: Buffer;
    data_key_ciphertext: Buffer;
    wrapping_key_id: string;
  }>(
    db,
    `SELECT p.id, p.workspace_id, p.platform_flags, c.id AS channel_id, c.kind, c.external_id, c.username, r.id AS revision_id, r.caption, r.hashtags,
            r.alt_text, r.disclosure_text, a.provider, a.external_account_id, a.credential_ciphertext, a.credential_nonce,
            a.data_key_ciphertext, a.wrapping_key_id
       FROM publishing.publications p
       JOIN publishing.channels c ON c.id = p.channel_id
       JOIN core.integration_accounts a ON a.id = c.integration_account_id
       JOIN content.content_revisions r ON r.id = p.revision_id
      WHERE p.id = $1`,
    [publicationId],
  );
  const assets = await db.query<{ media_asset_id: string; role: string; mime_type: string; storage_key: string }>(
    `SELECT ra.media_asset_id, ra.role, m.mime_type, m.storage_key FROM content.revision_assets ra
       JOIN content.media_assets m ON m.id = ra.media_asset_id WHERE ra.revision_id = $1 ORDER BY ra.position`,
    [p.revision_id],
  );
  const credential = decryptSecret(
    svc.config.masterKeys,
    { ciphertext: p.credential_ciphertext, nonce: p.credential_nonce, dataKeyCiphertext: p.data_key_ciphertext, wrappingKeyId: p.wrapping_key_id },
    credentialAad(p.workspace_id, p.provider, p.external_account_id),
  );
  return {
    publicationId,
    idempotencyKey,
    channel: { id: p.channel_id, kind: p.kind, external_id: p.external_id, username: p.username },
    revision: { id: p.revision_id, caption: p.caption, hashtags: p.hashtags, alt_text: p.alt_text, disclosure_text: p.disclosure_text },
    assets: assets.rows.map((a) => ({ media_asset_id: a.media_asset_id, role: a.role, mime_type: a.mime_type, path: svc.store.pathOf(a.storage_key) })),
    credential,
    platformFlags: p.platform_flags,
  };
}
