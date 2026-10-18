import type { Db } from '../db/tx.js';
import { type Ctx, requireInfluencerAccess, requirePermission } from './context.js';
import { loadContentItem, publicRevision, type RevisionRow } from './content.js';
import { publicJob, type JobRow } from './visual/jobs.js';

const hex = (b: Buffer | null) => (b ? b.toString('hex') : null);

/**
 * Full lineage of a content item, assembled from the system of record: which
 * persona version, workflow version, engine, reference assets and adapters
 * produced it; every job event; every QA check and its decision; who approved
 * or rejected and why; which channel and account it is scheduled on; GPU cost;
 * and every audit entry touching any of these subjects.
 */
export async function contentLineage(db: Db, ctx: Ctx, itemId: string): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'audit.read');
  const item = await loadContentItem(db, ctx, itemId);

  const jobs = await db.query<JobRow>('SELECT * FROM inference.visual_jobs WHERE content_item_id = $1 ORDER BY created_at', [itemId]);
  const jobIds = jobs.rows.map((j) => j.id);
  const events = await db.query(
    `SELECT visual_job_id, id, occurred_at, event_type, from_state, to_state, attempt, engine_job_id, actor_type, actor_id, details
       FROM inference.visual_job_events WHERE visual_job_id = ANY($1::uuid[]) ORDER BY id`,
    [jobIds],
  );
  const workflows = await db.query(
    `SELECT id, workflow_key, version, manifest_sha256, status, decided_by, decided_at, decision_note
       FROM inference.visual_workflows WHERE id = ANY($1::uuid[])`,
    [jobs.rows.map((j) => j.workflow_id)],
  );
  const engines = await db.query(
    `SELECT id, engine_key, engine_kind, reported_engine_id, reported_engine_version FROM inference.visual_engines WHERE id = ANY($1::uuid[])`,
    [jobs.rows.map((j) => j.engine_id).filter(Boolean)],
  );
  const personas = await db.query(
    `SELECT id, version, status, approved_by, approved_at FROM identity.persona_versions WHERE id = ANY($1::uuid[])`,
    [jobs.rows.map((j) => j.persona_version_id)],
  );

  const assets = await db.query<{ id: string; sha256: Buffer }>(
    `SELECT id, kind, mime_type, bytes, width, height, sha256, status, status_reason, visual_job_id, engine_kind, qa_summary,
            provenance, storage_key, created_at
       FROM content.media_assets WHERE visual_job_id = ANY($1::uuid[]) ORDER BY created_at`,
    [jobIds],
  );
  const assetIds = assets.rows.map((a) => a.id);
  const validations = await db.query(
    `SELECT subject_id, check_type, check_key, provider, score, threshold, passed, advisory, details, created_at
       FROM content.validation_results WHERE subject_type = 'media_asset' AND subject_id = ANY($1::uuid[]) ORDER BY created_at`,
    [assetIds],
  );

  const revisions = await db.query<RevisionRow>('SELECT * FROM content.content_revisions WHERE content_item_id = $1 ORDER BY revision', [itemId]);
  const revisionIds = revisions.rows.map((r) => r.id);
  const revisionAssets = await db.query(
    `SELECT revision_id, position, media_asset_id, role FROM content.revision_assets WHERE revision_id = ANY($1::uuid[]) ORDER BY revision_id, position`,
    [revisionIds],
  );
  const approvals = await db.query<{ id: string; payload_hash: Buffer }>(
    `SELECT id, subject_id AS revision_id, action_type, status, payload_hash, requested_by_type, requested_by_id, required_role,
            expires_at, created_at, decided_at
       FROM approvals.approval_requests WHERE subject_type = 'content_revision' AND subject_id = ANY($1::uuid[]) ORDER BY created_at`,
    [revisionIds],
  );
  const decisions = await db.query<{ payload_hash_seen: Buffer }>(
    `SELECT approval_request_id, approver_user_id, decision, payload_hash_seen, comment, decided_at
       FROM approvals.approval_decisions WHERE approval_request_id = ANY($1::uuid[]) ORDER BY decided_at`,
    [approvals.rows.map((a) => a.id)],
  );

  const publications = await db.query<{ id: string; authorized_content_hash: Buffer | null }>(
    `SELECT p.id, p.status, p.scheduled_for, p.published_at, p.authorized_content_hash, p.authorization_kind, p.approval_request_id,
            p.external_post_id, p.permalink, p.last_error, p.revision_id,
            json_build_object('id', c.id, 'kind', c.kind, 'external_id', c.external_id, 'username', c.username) AS channel,
            json_build_object('id', a.id, 'provider', a.provider, 'external_account_id', a.external_account_id,
                              'display_name', a.display_name) AS account
       FROM publishing.publications p
       JOIN publishing.channels c ON c.id = p.channel_id
       JOIN core.integration_accounts a ON a.id = c.integration_account_id
      WHERE p.content_item_id = $1 ORDER BY p.created_at`,
    [itemId],
  );

  const subjectIds = [itemId, ...jobIds, ...assetIds, ...revisionIds, ...publications.rows.map((p) => p.id)];
  const auditRows = await db.query(
    `SELECT id, occurred_at, actor_type, actor_id, action, subject_type, subject_id, approval_request_id, request_id, trace_id, changes, metadata
       FROM core.audit_log WHERE subject_id = ANY($1::text[]) ORDER BY occurred_at, id`,
    [subjectIds],
  );

  const engineKinds = [...new Set(jobs.rows.map((j) => j.engine_kind).filter(Boolean))];
  return {
    content_item: item,
    validation_scope: engineKinds.length === 0 ? 'not_generated' : engineKinds.every((k) => k === 'contract_mock') ? 'contract_mock' : engineKinds.includes('contract_mock') ? 'mixed' : 'real_engine',
    persona_versions: personas.rows,
    workflows: workflows.rows,
    engines: engines.rows,
    visual_jobs: jobs.rows.map((j) => ({ ...publicJob(j), events: events.rows.filter((e) => e.visual_job_id === j.id) })),
    media_assets: assets.rows.map((a) => ({
      ...a,
      sha256: hex(a.sha256),
      validation_results: validations.rows.filter((v) => v.subject_id === a.id),
    })),
    revisions: revisions.rows.map((r) => ({ ...publicRevision(r), assets: revisionAssets.rows.filter((ra) => ra.revision_id === r.id) })),
    approvals: approvals.rows.map((a) => ({
      ...a,
      payload_hash: hex(a.payload_hash),
      decisions: decisions.rows.filter((d) => (d as unknown as { approval_request_id: string }).approval_request_id === a.id).map((d) => ({ ...d, payload_hash_seen: hex(d.payload_hash_seen) })),
    })),
    publications: publications.rows.map((p) => ({ ...p, authorized_content_hash: hex(p.authorized_content_hash) })),
    cost: {
      gpu_seconds: jobs.rows.reduce((s, j) => s + Number(j.gpu_seconds), 0),
      wall_seconds: jobs.rows.reduce((s, j) => s + Number(j.wall_seconds), 0),
      attempts: jobs.rows.reduce((s, j) => s + j.attempt, 0),
      note: 'Engine-reported GPU time. Currency cost is attributed from measured energy and amortisation (docs/12) once those are recorded.',
    },
    engagement: null,
    revenue: null,
    audit: auditRows.rows,
  };
}

export async function influencerAudit(db: Db, ctx: Ctx, influencerId: string, limit = 200): Promise<unknown[]> {
  requirePermission(ctx, 'audit.read');
  requireInfluencerAccess(ctx, influencerId);
  const { rows } = await db.query(
    `SELECT id, occurred_at, actor_type, actor_id, action, subject_type, subject_id, approval_request_id, request_id, metadata
       FROM core.audit_log WHERE influencer_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2`,
    [influencerId, Math.min(limit, 1000)],
  );
  return rows;
}
