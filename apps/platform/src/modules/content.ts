import type { Db } from '../db/tx.js';
import { maybeOne, one } from '../db/tx.js';
import { canonicalSha256Hex, canonicalize } from '../lib/canonical-json.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { auditCtx, outbox } from './audit.js';
import { type Ctx, requireInfluencerAccess, requirePermission } from './context.js';
import { getInfluencer } from './identity.js';

export const CONTENT_FORMATS = [
  'ig_image',
  'ig_carousel',
  'ig_reel',
  'ig_story_image',
  'ig_story_video',
  'tg_post',
  'tg_album',
  'tg_video',
  'tg_paid_media',
  'bot_paid_media',
] as const;

export const RATINGS = ['general', 'suggestive', 'mature', 'explicit'] as const;
export type Rating = (typeof RATINGS)[number];

export interface ContentItemRow {
  id: string;
  workspace_id: string;
  influencer_id: string;
  format: string;
  planned_for: Date | null;
  target_rating: Rating;
  assessed_rating: Rating | null;
  status: string;
  brief: Record<string, unknown> | null;
  current_revision_id: string | null;
  is_sponsored: boolean;
  sponsor_disclosure: string | null;
}

export interface RevisionRow {
  id: string;
  workspace_id: string;
  content_item_id: string;
  revision: number;
  caption: string | null;
  hashtags: string[];
  alt_text: string | null;
  cta: Record<string, unknown> | null;
  disclosure_text: string;
  content_hash: Buffer;
  created_by_type: string;
  created_by_id: string;
  created_at: Date;
}

export async function createContentItem(
  db: Db,
  ctx: Ctx,
  influencerId: string,
  input: {
    format: string;
    planned_for?: string | null;
    target_rating?: Rating;
    brief?: Record<string, unknown> | null;
    is_sponsored?: boolean;
    sponsor_disclosure?: string | null;
  },
): Promise<ContentItemRow> {
  requirePermission(ctx, 'content.create');
  await getInfluencer(db, ctx, influencerId);
  if (input.target_rating === 'explicit') {
    throw unprocessable('RATING_DISABLED', 'explicit content is disabled platform-wide (docs/03)');
  }
  if (input.is_sponsored && !input.sponsor_disclosure) {
    throw badRequest('SPONSOR_DISCLOSURE_REQUIRED', 'Sponsored content needs sponsor_disclosure');
  }
  const id = uuidv7();
  const row = await one<ContentItemRow>(
    db,
    `INSERT INTO content.content_items (id, workspace_id, influencer_id, format, planned_for, target_rating, brief, status,
       is_sponsored, sponsor_disclosure, created_by_type, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      id,
      ctx.workspaceId,
      influencerId,
      input.format,
      input.planned_for ?? null,
      input.target_rating ?? 'general',
      input.brief ? JSON.stringify(input.brief) : null,
      input.brief ? 'briefed' : 'planned',
      input.is_sponsored ?? false,
      input.sponsor_disclosure ?? null,
      ctx.actor.type === 'agent' ? 'agent' : 'user',
      ctx.actor.id,
    ],
  );
  await auditCtx(db, ctx, { influencerId, action: 'content.item_create', subjectType: 'content_item', subjectId: id, changes: { after: input } });
  return row;
}

export async function loadContentItem(db: Db, ctx: Ctx, itemId: string, lock = false): Promise<ContentItemRow> {
  const row = await maybeOne<ContentItemRow>(db, `SELECT * FROM content.content_items WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [itemId]);
  if (!row) throw notFound('Content item', itemId);
  requireInfluencerAccess(ctx, row.influencer_id);
  return row;
}

/**
 * H(caption, hashtags, alt text, CTA, disclosure, ordered asset sha256s and roles):
 * exactly what a reviewer approves and what may be published (docs/05).
 */
export function revisionContentHash(r: {
  caption: string | null;
  hashtags: string[];
  alt_text: string | null;
  cta: Record<string, unknown> | null;
  disclosure_text: string;
  assets: { position: number; role: string; sha256: string }[];
}): Buffer {
  return Buffer.from(
    canonicalSha256Hex({
      caption: r.caption,
      hashtags: r.hashtags,
      alt_text: r.alt_text,
      cta: r.cta,
      disclosure_text: r.disclosure_text,
      assets: [...r.assets].sort((a, b) => a.position - b.position),
    }),
    'hex',
  );
}

export async function createRevision(
  db: Db,
  ctx: Ctx,
  itemId: string,
  input: {
    caption?: string | null;
    hashtags?: string[];
    alt_text?: string | null;
    cta?: Record<string, unknown> | null;
    assets: { media_asset_id: string; role: 'primary' | 'carousel' | 'cover' | 'teaser' | 'full' }[];
  },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'content.create');
  const item = await loadContentItem(db, ctx, itemId, true);
  if (['published', 'archived', 'scheduled', 'partially_published'].includes(item.status)) {
    throw conflict('CONTENT_ITEM_LOCKED', `Content item is ${item.status}; create a new item instead`);
  }
  if (input.assets.length === 0) throw badRequest('ASSETS_REQUIRED', 'A revision needs at least one media asset');
  const ids = input.assets.map((a) => a.media_asset_id);
  if (new Set(ids).size !== ids.length) throw badRequest('DUPLICATE_ASSET', 'An asset may appear only once per revision');
  const { rows: assets } = await db.query<{ id: string; influencer_id: string; status: string; sha256: Buffer; engine_kind: string | null; origin: string }>(
    'SELECT id, influencer_id, status, sha256, engine_kind, origin FROM content.media_assets WHERE id = ANY($1::uuid[])',
    [ids],
  );
  const byId = new Map(assets.map((a) => [a.id, a]));
  for (const id of ids) {
    const a = byId.get(id);
    if (!a || a.influencer_id !== item.influencer_id) throw unprocessable('ASSET_NOT_OWNED', 'Assets must belong to the same influencer', { media_asset_id: id });
    if (a.status !== 'valid') throw unprocessable('ASSET_NOT_VALID', `Asset is ${a.status}; only QA-valid assets can be used`, { media_asset_id: id });
    if (a.origin !== 'generated' && a.origin !== 'edited') {
      throw unprocessable('ASSET_NOT_CONTENT', 'Only generated or edited media can be published (reference uploads cannot)', { media_asset_id: id });
    }
  }
  const influencer = await getInfluencer(db, ctx, item.influencer_id);
  const disclosure = influencer.ai_disclosure_short;
  const ordered = input.assets.map((a, i) => ({ position: i, role: a.role, sha256: byId.get(a.media_asset_id)!.sha256.toString('hex'), media_asset_id: a.media_asset_id }));
  const contentHash = revisionContentHash({
    caption: input.caption ?? null,
    hashtags: input.hashtags ?? [],
    alt_text: input.alt_text ?? null,
    cta: input.cta ?? null,
    disclosure_text: disclosure,
    assets: ordered.map(({ position, role, sha256 }) => ({ position, role, sha256 })),
  });
  const { next } = await one<{ next: number }>(
    db,
    'SELECT coalesce(max(revision), 0) + 1 AS next FROM content.content_revisions WHERE content_item_id = $1',
    [itemId],
  );
  const id = uuidv7();
  const revision = await one<RevisionRow>(
    db,
    `INSERT INTO content.content_revisions (id, workspace_id, content_item_id, revision, caption, hashtags, alt_text, cta,
       disclosure_text, content_hash, created_by_type, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      id,
      ctx.workspaceId,
      itemId,
      next,
      input.caption ?? null,
      input.hashtags ?? [],
      input.alt_text ?? null,
      input.cta ? JSON.stringify(input.cta) : null,
      disclosure,
      contentHash,
      ctx.actor.type === 'agent' ? 'agent' : 'user',
      ctx.actor.id,
    ],
  );
  for (const a of ordered) {
    await db.query('INSERT INTO content.revision_assets (revision_id, position, media_asset_id, role) VALUES ($1, $2, $3, $4)', [
      id,
      a.position,
      a.media_asset_id,
      a.role,
    ]);
  }
  // Older pending approvals cannot approve content that is no longer current.
  const superseded = await db.query<{ id: string }>(
    `UPDATE approvals.approval_requests ar SET status = 'superseded'
       FROM content.content_revisions cr
      WHERE ar.subject_type = 'content_revision' AND ar.subject_id = cr.id AND cr.content_item_id = $1
        AND ar.status = 'pending' RETURNING ar.id`,
    [itemId],
  );
  await db.query(
    `UPDATE content.content_items SET current_revision_id = $2, updated_at = now(),
        status = CASE WHEN status IN ('approved', 'changes_requested', 'rejected') THEN 'ready_for_review' ELSE status END
      WHERE id = $1`,
    [itemId, id],
  );
  await auditCtx(db, ctx, {
    influencerId: item.influencer_id,
    action: 'content.revision_create',
    subjectType: 'content_revision',
    subjectId: id,
    metadata: { content_item_id: itemId, revision: next, content_hash: contentHash.toString('hex'), assets: ordered, superseded_approvals: superseded.rows.map((r) => r.id) },
  });
  return {
    ...publicRevision(revision),
    assets: ordered,
    contains_contract_mock_assets: assets.some((a) => a.engine_kind === 'contract_mock'),
  };
}

export function publicRevision(r: RevisionRow): Omit<RevisionRow, 'content_hash'> & { content_hash: string } {
  return { ...r, content_hash: r.content_hash.toString('hex') };
}

/**
 * Opens a human approval request for the item's current revision. The request
 * snapshots exactly what will be published and binds it with payload_hash.
 */
export async function requestApproval(db: Db, ctx: Ctx, revisionId: string, ttlHours: number): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'content.submit');
  const revision = await maybeOne<RevisionRow>(db, 'SELECT * FROM content.content_revisions WHERE id = $1', [revisionId]);
  if (!revision) throw notFound('Revision', revisionId);
  const item = await loadContentItem(db, ctx, revision.content_item_id, true);
  if (item.current_revision_id !== revisionId) throw conflict('REVISION_NOT_CURRENT', 'Only the current revision can be submitted for approval');
  const open = await maybeOne(
    db,
    `SELECT id FROM approvals.approval_requests WHERE subject_type = 'content_revision' AND subject_id = $1 AND status IN ('pending', 'approved')`,
    [revisionId],
  );
  if (open) throw conflict('APPROVAL_EXISTS', 'This revision already has a pending or approved request', { approval_request_id: (open as { id: string }).id });
  const { rows: assets } = await db.query<{ position: number; role: string; media_asset_id: string; sha256: Buffer; engine_kind: string | null; status: string; qa_summary: Record<string, unknown> }>(
    `SELECT ra.position, ra.role, ra.media_asset_id, m.sha256, m.engine_kind, m.status, m.qa_summary
       FROM content.revision_assets ra JOIN content.media_assets m ON m.id = ra.media_asset_id
      WHERE ra.revision_id = $1 ORDER BY ra.position`,
    [revisionId],
  );
  const invalid = assets.filter((a) => a.status !== 'valid');
  if (invalid.length > 0) throw unprocessable('ASSET_NOT_VALID', 'Revision contains assets that are no longer valid', { media_asset_ids: invalid.map((a) => a.media_asset_id) });
  const snapshot = {
    action_type: 'content.publish',
    influencer_id: item.influencer_id,
    content_item_id: item.id,
    format: item.format,
    target_rating: item.target_rating,
    revision_id: revision.id,
    revision: revision.revision,
    content_hash: revision.content_hash.toString('hex'),
    caption: revision.caption,
    hashtags: revision.hashtags,
    alt_text: revision.alt_text,
    cta: revision.cta,
    disclosure_text: revision.disclosure_text,
    assets: assets.map((a) => ({
      position: a.position,
      role: a.role,
      media_asset_id: a.media_asset_id,
      sha256: a.sha256.toString('hex'),
      engine_kind: a.engine_kind,
      qa_decision: (a.qa_summary as { decision?: string }).decision ?? null,
    })),
  };
  const payloadHash = Buffer.from(canonicalSha256Hex(snapshot), 'hex');
  const id = uuidv7();
  const request = await one(
    db,
    `INSERT INTO approvals.approval_requests (id, workspace_id, influencer_id, subject_type, subject_id, action_type, risk_level,
       payload_snapshot, payload_hash, requested_by_type, requested_by_id, required_role, required_approvals, expires_at)
     VALUES ($1, $2, $3, 'content_revision', $4, 'content.publish', 'medium', $5, $6, $7, $8, 'reviewer', 1,
             now() + make_interval(hours => $9))
     RETURNING id, status, subject_id, action_type, risk_level, required_role, required_approvals, expires_at, created_at`,
    [id, ctx.workspaceId, item.influencer_id, revisionId, canonicalize(snapshot), payloadHash, ctx.actor.type === 'agent' ? 'agent' : 'user', ctx.actor.id, ttlHours],
  );
  await db.query(`UPDATE content.content_items SET status = 'ready_for_review', updated_at = now() WHERE id = $1`, [item.id]);
  await auditCtx(db, ctx, {
    influencerId: item.influencer_id,
    action: 'approval.request',
    subjectType: 'content_revision',
    subjectId: revisionId,
    approvalRequestId: id,
    metadata: { payload_hash: payloadHash.toString('hex'), content_hash: snapshot.content_hash },
  });
  await outbox(db, { workspaceId: ctx.workspaceId, eventType: 'approvals.requested', aggregateType: 'approval_request', aggregateId: id, payload: { subject_type: 'content_revision', subject_id: revisionId } });
  return { ...request, payload_hash: payloadHash.toString('hex'), payload_snapshot: snapshot };
}

export async function getContentItem(db: Db, ctx: Ctx, itemId: string): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'content.read');
  const item = await loadContentItem(db, ctx, itemId);
  const revisions = await db.query<RevisionRow>('SELECT * FROM content.content_revisions WHERE content_item_id = $1 ORDER BY revision', [itemId]);
  return { ...item, revisions: revisions.rows.map(publicRevision) };
}

export async function listMediaAssets(db: Db, ctx: Ctx, influencerId: string, filter: { visual_job_id?: string; status?: string }): Promise<unknown[]> {
  requirePermission(ctx, 'content.read');
  requireInfluencerAccess(ctx, influencerId);
  const { rows } = await db.query(
    `SELECT id, kind, mime_type, bytes, width, height, encode(sha256, 'hex') AS sha256, origin, status, status_reason,
            visual_job_id, engine_kind, qa_summary, provenance, created_at
       FROM content.media_assets
      WHERE influencer_id = $1 AND ($2::uuid IS NULL OR visual_job_id = $2) AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC LIMIT 200`,
    [influencerId, filter.visual_job_id ?? null, filter.status ?? null],
  );
  return rows;
}
