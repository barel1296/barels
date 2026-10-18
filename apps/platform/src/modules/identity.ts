import type { Db } from '../db/tx.js';
import { maybeOne, one } from '../db/tx.js';
import { sha256Hex } from '../lib/canonical-json.js';
import { PG, badRequest, conflict, forbidden, notFound, pgCode, unprocessable } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { EXTENSION_BY_MIME, readDimensions, sniffMime } from '../lib/media.js';
import { isValidRange } from '../lib/semver.js';
import { auditCtx, outbox } from './audit.js';
import type { ContentStore } from './content-store.js';
import { type Ctx, requireInfluencerAccess, requirePermission } from './context.js';
import { resolveWorkflowVersion } from './visual/workflows.js';

// -----------------------------------------------------------------------------
// Influencers
// -----------------------------------------------------------------------------

export interface InfluencerRow {
  id: string;
  workspace_id: string;
  slug: string;
  display_name: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  ai_disclosure_short: string;
  ai_disclosure_long: string;
  timezone: string;
  primary_language: string;
  active_persona_version_id: string | null;
  autonomy_paused: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateInfluencerInput {
  slug: string;
  display_name: string;
  ai_disclosure_short: string;
  ai_disclosure_long: string;
  timezone: string;
  primary_language: string;
  runtime?: RuntimeConfigInput;
}

export interface RuntimeConfigInput {
  content_tier?: 'lite' | 'standard' | 'plus';
  gpu_quota_seconds_day?: number;
  free_replies_per_day?: number;
  premium_replies_per_day?: number;
  languages?: string[];
  quiet_hours?: Record<string, unknown>;
  paused?: boolean;
  default_conversation_mode?: 'ai_auto' | 'ai_draft' | 'human';
  redisclosure_every_messages?: number;
  redisclosure_every_hours?: number;
  memory_enabled?: boolean;
}

function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw badRequest('INVALID_TIMEZONE', `Unknown IANA time zone ${tz}`);
  }
}

/**
 * Creates an influencer with its own runtime configuration. Nothing is copied
 * from other influencers: persona, references, adapters, bindings, thresholds,
 * channels and fan data all start empty.
 */
export async function createInfluencer(
  db: Db,
  ctx: Ctx,
  input: CreateInfluencerInput,
  defaults: { gpuQuotaSecondsPerDay: number },
): Promise<InfluencerRow> {
  requirePermission(ctx, 'influencer.create');
  assertTimezone(input.timezone);
  if (!/AI/i.test(input.ai_disclosure_short) || !/AI/i.test(input.ai_disclosure_long)) {
    throw unprocessable('DISCLOSURE_REQUIRED', 'Both AI disclosures must state that the persona is AI-generated');
  }
  const id = uuidv7();
  let row: InfluencerRow;
  try {
    row = await one<InfluencerRow>(
      db,
      `INSERT INTO identity.influencers (id, workspace_id, slug, display_name, ai_disclosure_short, ai_disclosure_long,
         timezone, primary_language)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, ctx.workspaceId, input.slug, input.display_name, input.ai_disclosure_short, input.ai_disclosure_long, input.timezone, input.primary_language],
    );
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('SLUG_TAKEN', `Influencer slug ${input.slug} already exists`);
    throw err;
  }
  const rt = input.runtime ?? {};
  await db.query(
    `INSERT INTO identity.persona_runtime_config (influencer_id, workspace_id, content_tier, gpu_quota_seconds_day,
       free_replies_per_day, premium_replies_per_day, languages, quiet_hours, paused, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      ctx.workspaceId,
      rt.content_tier ?? 'lite',
      rt.gpu_quota_seconds_day ?? defaults.gpuQuotaSecondsPerDay,
      rt.free_replies_per_day ?? 0,
      rt.premium_replies_per_day ?? 0,
      rt.languages ?? [input.primary_language],
      JSON.stringify(rt.quiet_hours ?? {}),
      rt.paused ?? false,
      ctx.userId,
    ],
  );
  await auditCtx(db, ctx, {
    influencerId: id,
    action: 'influencer.create',
    subjectType: 'influencer',
    subjectId: id,
    changes: { after: { ...input } },
  });
  await outbox(db, {
    workspaceId: ctx.workspaceId,
    eventType: 'identity.influencer_created',
    aggregateType: 'influencer',
    aggregateId: id,
    payload: { influencer_id: id, slug: input.slug },
  });
  return row;
}

export async function getInfluencer(db: Db, ctx: Ctx, influencerId: string): Promise<InfluencerRow> {
  requirePermission(ctx, 'influencer.read');
  requireInfluencerAccess(ctx, influencerId);
  const row = await maybeOne<InfluencerRow>(db, 'SELECT * FROM identity.influencers WHERE id = $1', [influencerId]);
  if (!row) throw notFound('Influencer', influencerId);
  return row;
}

export async function getInfluencerDetail(db: Db, ctx: Ctx, influencerId: string): Promise<Record<string, unknown>> {
  const influencer = await getInfluencer(db, ctx, influencerId);
  // Sequential: a single client cannot run queries concurrently.
  const runtime = await maybeOne(db, 'SELECT * FROM identity.persona_runtime_config WHERE influencer_id = $1', [influencerId]);
  const personas = await db.query(
    `SELECT id, version, status, change_summary, created_by, approved_by, approved_at, created_at
       FROM identity.persona_versions WHERE influencer_id = $1 ORDER BY version`,
    [influencerId],
  );
  const refs = await db.query(
    `SELECT r.id, r.kind, r.is_canonical, r.approved_by, r.retired_at, r.media_asset_id, m.sha256, m.mime_type, m.width, m.height
       FROM identity.reference_assets r JOIN content.media_assets m ON m.id = r.media_asset_id
      WHERE r.influencer_id = $1 ORDER BY r.created_at`,
    [influencerId],
  );
  const adapters = await db.query(
    `SELECT id, kind, status, engine_ref, workflow_keys, registered_by, approved_by, approved_at, created_at
       FROM identity.model_adapters WHERE influencer_id = $1 ORDER BY created_at`,
    [influencerId],
  );
  const bindings = await db.query(`SELECT * FROM identity.workflow_bindings WHERE influencer_id = $1 AND status = 'active' ORDER BY purpose`, [influencerId]);
  const thresholds = await db.query(
    `SELECT * FROM identity.qa_thresholds WHERE status = 'active' AND (influencer_id = $1 OR influencer_id IS NULL)
      ORDER BY check_key`,
    [influencerId],
  );
  return {
    ...influencer,
    runtime_config: runtime,
    persona_versions: personas.rows,
    reference_assets: refs.rows.map((r) => ({ ...r, sha256: Buffer.isBuffer(r.sha256) ? r.sha256.toString('hex') : r.sha256 })),
    adapters: adapters.rows,
    workflow_bindings: bindings.rows,
    qa_thresholds: thresholds.rows,
  };
}

export async function listInfluencers(db: Db, ctx: Ctx): Promise<InfluencerRow[]> {
  requirePermission(ctx, 'influencer.read');
  const { rows } = await db.query<InfluencerRow>('SELECT * FROM identity.influencers ORDER BY created_at');
  return ctx.influencerScope ? rows.filter((r) => ctx.influencerScope!.has(r.id)) : rows;
}

const INFLUENCER_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['active', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: [],
};

export async function setInfluencerStatus(db: Db, ctx: Ctx, influencerId: string, status: InfluencerRow['status']): Promise<InfluencerRow> {
  requirePermission(ctx, 'influencer.update');
  const current = await getInfluencer(db, ctx, influencerId);
  if (!INFLUENCER_STATUS_TRANSITIONS[current.status]?.includes(status)) {
    throw conflict('INVALID_STATUS_TRANSITION', `Cannot move influencer from ${current.status} to ${status}`);
  }
  if (status === 'active' && !current.active_persona_version_id) {
    throw conflict('NO_ACTIVE_PERSONA', 'An influencer can be activated only with an approved, active persona version');
  }
  const row = await one<InfluencerRow>(
    db,
    'UPDATE identity.influencers SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [influencerId, status],
  );
  await auditCtx(db, ctx, {
    influencerId,
    action: 'influencer.status_change',
    subjectType: 'influencer',
    subjectId: influencerId,
    changes: { before: { status: current.status }, after: { status } },
  });
  return row;
}

export async function updateRuntimeConfig(db: Db, ctx: Ctx, influencerId: string, input: RuntimeConfigInput): Promise<unknown> {
  requirePermission(ctx, 'influencer.update');
  await getInfluencer(db, ctx, influencerId);
  const before = await one(db, 'SELECT * FROM identity.persona_runtime_config WHERE influencer_id = $1', [influencerId]);
  const row = await one(
    db,
    `UPDATE identity.persona_runtime_config SET
        content_tier = coalesce($2, content_tier),
        gpu_quota_seconds_day = coalesce($3, gpu_quota_seconds_day),
        free_replies_per_day = coalesce($4, free_replies_per_day),
        premium_replies_per_day = coalesce($5, premium_replies_per_day),
        languages = coalesce($6, languages),
        quiet_hours = coalesce($7, quiet_hours),
        paused = coalesce($8, paused),
        default_conversation_mode = coalesce($10, default_conversation_mode),
        redisclosure_every_messages = coalesce($11, redisclosure_every_messages),
        redisclosure_every_hours = coalesce($12, redisclosure_every_hours),
        memory_enabled = coalesce($13, memory_enabled),
        updated_by = $9, updated_at = now()
      WHERE influencer_id = $1 RETURNING *`,
    [
      influencerId,
      input.content_tier ?? null,
      input.gpu_quota_seconds_day ?? null,
      input.free_replies_per_day ?? null,
      input.premium_replies_per_day ?? null,
      input.languages ?? null,
      input.quiet_hours ? JSON.stringify(input.quiet_hours) : null,
      input.paused ?? null,
      ctx.userId,
      input.default_conversation_mode ?? null,
      input.redisclosure_every_messages ?? null,
      input.redisclosure_every_hours ?? null,
      input.memory_enabled ?? null,
    ],
  );
  // Fully automatic replies are a separate, explicitly audited decision (docs/README D9).
  if (input.default_conversation_mode === 'ai_auto') requirePermission(ctx, 'conversation.manage');
  await auditCtx(db, ctx, {
    influencerId,
    action: 'influencer.runtime_config_update',
    subjectType: 'influencer',
    subjectId: influencerId,
    changes: { before, after: row },
  });
  return row;
}

// -----------------------------------------------------------------------------
// Persona versions: draft → in_review → approved → active (→ retired)
// -----------------------------------------------------------------------------

export interface PersonaInput {
  personality: Record<string, unknown>;
  writing_style: Record<string, unknown>;
  biography: Record<string, unknown>;
  visual_identity: Record<string, unknown>;
  conversation_rules: Record<string, unknown>;
  voice_profile?: Record<string, unknown> | null;
  change_summary?: string | null;
}

export interface PersonaVersionRow {
  id: string;
  workspace_id: string;
  influencer_id: string;
  version: number;
  status: 'draft' | 'in_review' | 'approved' | 'active' | 'retired';
  personality: Record<string, unknown>;
  writing_style: Record<string, unknown>;
  biography: Record<string, unknown>;
  visual_identity: Record<string, unknown>;
  conversation_rules: Record<string, unknown>;
  created_by: string | null;
  approved_by: string | null;
}

/** Persona guard rails (docs/01 C1–C4): fictional adult persona, disclosure rules present. */
function validatePersona(input: PersonaInput): void {
  const bio = input.biography;
  if (bio.fictional !== true) {
    throw unprocessable('PERSONA_POLICY', 'biography.fictional must be true: personas are fictional characters, never real people');
  }
  if (typeof bio.age_years !== 'number' || !Number.isInteger(bio.age_years) || bio.age_years < 18) {
    throw unprocessable('PERSONA_POLICY', 'biography.age_years must be an integer >= 18: personas are adults');
  }
  if (Object.keys(input.visual_identity).length === 0) {
    throw unprocessable('PERSONA_POLICY', 'visual_identity must describe the persona');
  }
  if (typeof input.conversation_rules.disclosure !== 'string' || !/AI/i.test(input.conversation_rules.disclosure)) {
    throw unprocessable('PERSONA_POLICY', 'conversation_rules.disclosure must state that conversations are with an AI');
  }
}

export async function createPersonaVersion(db: Db, ctx: Ctx, influencerId: string, input: PersonaInput): Promise<PersonaVersionRow> {
  requirePermission(ctx, 'persona.edit');
  await getInfluencer(db, ctx, influencerId);
  validatePersona(input);
  // Serialise version numbering per influencer.
  await db.query('SELECT id FROM identity.influencers WHERE id = $1 FOR UPDATE', [influencerId]);
  const { next } = await one<{ next: number }>(
    db,
    'SELECT coalesce(max(version), 0) + 1 AS next FROM identity.persona_versions WHERE influencer_id = $1',
    [influencerId],
  );
  const row = await one<PersonaVersionRow>(
    db,
    `INSERT INTO identity.persona_versions (id, workspace_id, influencer_id, version, personality, writing_style,
       biography, visual_identity, voice_profile, conversation_rules, change_summary, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      uuidv7(),
      ctx.workspaceId,
      influencerId,
      next,
      JSON.stringify(input.personality),
      JSON.stringify(input.writing_style),
      JSON.stringify(input.biography),
      JSON.stringify(input.visual_identity),
      input.voice_profile ? JSON.stringify(input.voice_profile) : null,
      JSON.stringify(input.conversation_rules),
      input.change_summary ?? null,
      ctx.userId,
    ],
  );
  await auditCtx(db, ctx, {
    influencerId,
    action: 'persona.version_create',
    subjectType: 'persona_version',
    subjectId: row.id,
    metadata: { version: next },
  });
  return row;
}

async function loadPersona(db: Db, ctx: Ctx, personaVersionId: string): Promise<PersonaVersionRow> {
  const row = await maybeOne<PersonaVersionRow>(db, 'SELECT * FROM identity.persona_versions WHERE id = $1 FOR UPDATE', [personaVersionId]);
  if (!row) throw notFound('Persona version', personaVersionId);
  requireInfluencerAccess(ctx, row.influencer_id);
  return row;
}

async function personaTransition(
  db: Db,
  ctx: Ctx,
  row: PersonaVersionRow,
  to: PersonaVersionRow['status'],
  action: string,
  extraSet = '',
  extraParams: unknown[] = [],
): Promise<PersonaVersionRow> {
  const updated = await one<PersonaVersionRow>(
    db,
    `UPDATE identity.persona_versions SET status = $2${extraSet} WHERE id = $1 RETURNING *`,
    [row.id, to, ...extraParams],
  );
  await auditCtx(db, ctx, {
    influencerId: row.influencer_id,
    action,
    subjectType: 'persona_version',
    subjectId: row.id,
    changes: { before: { status: row.status }, after: { status: to } },
    metadata: { version: row.version },
  });
  return updated;
}

/** One persona version with its full content (to review it, or to start the next draft from it). */
export async function getPersonaVersion(db: Db, ctx: Ctx, personaVersionId: string): Promise<PersonaVersionRow> {
  requirePermission(ctx, 'influencer.read');
  const row = await maybeOne<PersonaVersionRow>(db, 'SELECT * FROM identity.persona_versions WHERE id = $1', [personaVersionId]);
  if (!row) throw notFound('Persona version', personaVersionId);
  requireInfluencerAccess(ctx, row.influencer_id);
  return row;
}

export async function submitPersonaVersion(db: Db, ctx: Ctx, personaVersionId: string): Promise<PersonaVersionRow> {
  requirePermission(ctx, 'persona.edit');
  const row = await loadPersona(db, ctx, personaVersionId);
  if (row.status !== 'draft') throw conflict('INVALID_STATUS_TRANSITION', `Persona version is ${row.status}, expected draft`);
  return personaTransition(db, ctx, row, 'in_review', 'persona.version_submit');
}

export async function approvePersonaVersion(db: Db, ctx: Ctx, personaVersionId: string): Promise<PersonaVersionRow> {
  requirePermission(ctx, 'persona.approve');
  const row = await loadPersona(db, ctx, personaVersionId);
  if (row.status !== 'in_review') throw conflict('INVALID_STATUS_TRANSITION', `Persona version is ${row.status}, expected in_review`);
  if (row.created_by && row.created_by === ctx.userId) {
    throw forbidden('The author of a persona version cannot approve it');
  }
  return personaTransition(db, ctx, row, 'approved', 'persona.version_approve', ', approved_by = $3, approved_at = now()', [ctx.userId]);
}

/** Activates an approved persona version; the previously active version is retired. */
export async function activatePersonaVersion(db: Db, ctx: Ctx, personaVersionId: string): Promise<PersonaVersionRow> {
  requirePermission(ctx, 'persona.activate');
  const row = await loadPersona(db, ctx, personaVersionId);
  if (row.status !== 'approved') throw conflict('INVALID_STATUS_TRANSITION', `Persona version is ${row.status}, expected approved`);
  const previous = await maybeOne<PersonaVersionRow>(
    db,
    `SELECT * FROM identity.persona_versions WHERE influencer_id = $1 AND status = 'active' FOR UPDATE`,
    [row.influencer_id],
  );
  if (previous) await personaTransition(db, ctx, previous, 'retired', 'persona.version_retire');
  const activated = await personaTransition(db, ctx, row, 'active', 'persona.version_activate');
  await db.query('UPDATE identity.influencers SET active_persona_version_id = $2, updated_at = now() WHERE id = $1', [
    row.influencer_id,
    row.id,
  ]);
  await outbox(db, {
    workspaceId: ctx.workspaceId,
    eventType: 'identity.persona_activated',
    aggregateType: 'influencer',
    aggregateId: row.influencer_id,
    payload: { persona_version_id: row.id, version: row.version, previous_version_id: previous?.id ?? null },
  });
  return activated;
}

// -----------------------------------------------------------------------------
// Reference assets (identity material, per influencer, approved before use)
// -----------------------------------------------------------------------------

const REFERENCE_KINDS = ['face_canonical', 'face_angle', 'body', 'outfit', 'style', 'environment'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export async function uploadReferenceAsset(
  db: Db,
  ctx: Ctx,
  store: ContentStore,
  influencerId: string,
  input: { kind: string; bytes: Buffer; declaredMime: string | undefined; notes?: string | null },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'reference_asset.upload');
  await getInfluencer(db, ctx, influencerId);
  if (!(REFERENCE_KINDS as readonly string[]).includes(input.kind)) {
    throw badRequest('INVALID_REFERENCE_KIND', `kind must be one of ${REFERENCE_KINDS.join(', ')}`);
  }
  const mime = sniffMime(input.bytes);
  if (!mime || !mime.startsWith('image/')) throw unprocessable('UNSUPPORTED_MEDIA', 'Reference assets must be PNG, JPEG or WebP images');
  if (input.declaredMime && input.declaredMime !== mime) {
    throw unprocessable('MIME_MISMATCH', `Declared ${input.declaredMime} but the content is ${mime}`);
  }
  const sha = sha256Hex(input.bytes);
  const key = store.keyFor(ctx.workspaceId, influencerId, sha, EXTENSION_BY_MIME[mime]);
  await store.put(key, input.bytes, sha);
  const dims = readDimensions(input.bytes, mime);
  const assetId = uuidv7();
  await db.query(
    `INSERT INTO content.media_assets (id, workspace_id, influencer_id, kind, storage_key, mime_type, bytes, width, height,
       sha256, origin, provenance, status)
     VALUES ($1, $2, $3, 'image', $4, $5, $6, $7, $8, $9, 'uploaded', $10, 'valid')`,
    [
      assetId,
      ctx.workspaceId,
      influencerId,
      key,
      mime,
      input.bytes.length,
      dims?.width ?? null,
      dims?.height ?? null,
      Buffer.from(sha, 'hex'),
      JSON.stringify({ source: 'staff_upload', uploaded_by: ctx.userId }),
    ],
  );
  const refId = uuidv7();
  await db.query(
    `INSERT INTO identity.reference_assets (id, workspace_id, influencer_id, media_asset_id, kind, is_canonical, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [refId, ctx.workspaceId, influencerId, assetId, input.kind, input.kind === 'face_canonical', input.notes ?? null],
  );
  await auditCtx(db, ctx, {
    influencerId,
    action: 'reference_asset.upload',
    subjectType: 'reference_asset',
    subjectId: refId,
    metadata: { media_asset_id: assetId, sha256: sha, kind: input.kind, mime_type: mime },
  });
  return { id: refId, media_asset_id: assetId, kind: input.kind, sha256: sha, mime_type: mime, approved: false };
}

export async function approveReferenceAsset(db: Db, ctx: Ctx, referenceId: string): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'reference_asset.approve');
  const row = await maybeOne<{ id: string; influencer_id: string; approved_by: string | null; retired_at: Date | null }>(
    db,
    'SELECT id, influencer_id, approved_by, retired_at FROM identity.reference_assets WHERE id = $1 FOR UPDATE',
    [referenceId],
  );
  if (!row) throw notFound('Reference asset', referenceId);
  requireInfluencerAccess(ctx, row.influencer_id);
  if (row.retired_at) throw conflict('REFERENCE_RETIRED', 'Reference asset is retired');
  if (row.approved_by) throw conflict('ALREADY_APPROVED', 'Reference asset is already approved');
  await db.query('UPDATE identity.reference_assets SET approved_by = $2 WHERE id = $1', [referenceId, ctx.userId]);
  await auditCtx(db, ctx, {
    influencerId: row.influencer_id,
    action: 'reference_asset.approve',
    subjectType: 'reference_asset',
    subjectId: referenceId,
  });
  return { id: referenceId, approved: true };
}

// -----------------------------------------------------------------------------
// Adapters (registered by Track A; opaque engine_ref; approved before use)
// -----------------------------------------------------------------------------

export async function registerAdapter(
  db: Db,
  ctx: Ctx,
  influencerId: string,
  input: { kind: 'lora' | 'other'; engine_ref: string; workflow_keys?: string[]; dataset_manifest_ref?: string | null; eval_metrics?: Record<string, unknown> | null },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'adapter.register');
  await getInfluencer(db, ctx, influencerId);
  const id = uuidv7();
  const row = await one(
    db,
    `INSERT INTO identity.model_adapters (id, workspace_id, influencer_id, provider, kind, engine_ref, workflow_keys,
       dataset_manifest_ref, eval_metrics, status, registered_by)
     VALUES ($1, $2, $3, 'visual_engine', $4, $5, $6, $7, $8, 'ready', $9)
     RETURNING id, influencer_id, kind, engine_ref, workflow_keys, status, approved_by, created_at`,
    [
      id,
      ctx.workspaceId,
      influencerId,
      input.kind,
      input.engine_ref,
      input.workflow_keys ?? [],
      input.dataset_manifest_ref ?? null,
      input.eval_metrics ? JSON.stringify(input.eval_metrics) : null,
      ctx.userId,
    ],
  );
  await auditCtx(db, ctx, {
    influencerId,
    action: 'adapter.register',
    subjectType: 'model_adapter',
    subjectId: id,
    metadata: { kind: input.kind, engine_ref: input.engine_ref },
  });
  return row;
}

export async function approveAdapter(db: Db, ctx: Ctx, adapterId: string): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'persona.approve');
  const row = await maybeOne<{ influencer_id: string; approved_by: string | null; registered_by: string | null; status: string }>(
    db,
    'SELECT influencer_id, approved_by, registered_by, status FROM identity.model_adapters WHERE id = $1 FOR UPDATE',
    [adapterId],
  );
  if (!row) throw notFound('Adapter', adapterId);
  requireInfluencerAccess(ctx, row.influencer_id);
  if (row.status !== 'ready') throw conflict('ADAPTER_NOT_READY', `Adapter is ${row.status}`);
  if (row.approved_by) throw conflict('ALREADY_APPROVED', 'Adapter is already approved');
  if (row.registered_by === ctx.userId) throw forbidden('The registrant of an adapter cannot approve it');
  await db.query('UPDATE identity.model_adapters SET approved_by = $2, approved_at = now() WHERE id = $1', [adapterId, ctx.userId]);
  await auditCtx(db, ctx, { influencerId: row.influencer_id, action: 'adapter.approve', subjectType: 'model_adapter', subjectId: adapterId });
  return { id: adapterId, approved: true };
}

// -----------------------------------------------------------------------------
// Workflow bindings and QA thresholds (per influencer configuration)
// -----------------------------------------------------------------------------

export async function upsertBinding(
  db: Db,
  ctx: Ctx,
  influencerId: string,
  input: {
    purpose: string;
    workflow_key: string;
    version_range: string;
    default_parameters?: Record<string, unknown>;
    priority_class?: string | null;
    output_count?: number | null;
  },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'binding.manage');
  await getInfluencer(db, ctx, influencerId);
  if (!isValidRange(input.version_range)) {
    throw badRequest('INVALID_VERSION_RANGE', 'version_range must be an exact version, ^MAJOR.MINOR[.PATCH] or ~MAJOR.MINOR[.PATCH]');
  }
  const resolved = await resolveWorkflowVersion(db, input.workflow_key, input.version_range);
  if (!resolved) {
    throw unprocessable('NO_APPROVED_VERSION', `No approved version of ${input.workflow_key} satisfies ${input.version_range}`);
  }
  const previous = await maybeOne<{ id: string }>(
    db,
    `UPDATE identity.workflow_bindings SET status = 'retired', updated_at = now()
      WHERE influencer_id = $1 AND purpose = $2 AND status = 'active' RETURNING id`,
    [influencerId, input.purpose],
  );
  const id = uuidv7();
  const row = await one(
    db,
    `INSERT INTO identity.workflow_bindings (id, workspace_id, influencer_id, purpose, workflow_key, version_range,
       default_parameters, priority_class, output_count, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      id,
      ctx.workspaceId,
      influencerId,
      input.purpose,
      input.workflow_key,
      input.version_range,
      JSON.stringify(input.default_parameters ?? {}),
      input.priority_class ?? null,
      input.output_count ?? null,
      ctx.userId,
    ],
  );
  await auditCtx(db, ctx, {
    influencerId,
    action: 'workflow_binding.set',
    subjectType: 'workflow_binding',
    subjectId: id,
    changes: { before: previous ? { binding_id: previous.id } : null, after: input },
    metadata: { resolves_to: resolved.version },
  });
  return { ...row, resolves_to: resolved.version };
}

export async function setQaThreshold(
  db: Db,
  ctx: Ctx,
  input: {
    influencer_id: string | null;
    check_key: string;
    min_score?: number | null;
    max_score?: number | null;
    required?: boolean;
    on_fail?: 'reject' | 'flag';
  },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'qa_threshold.manage');
  if (input.influencer_id) await getInfluencer(db, ctx, input.influencer_id);
  if (input.min_score == null && input.max_score == null && !input.required) {
    throw badRequest('INVALID_THRESHOLD', 'Set min_score, max_score or required');
  }
  await db.query(
    `UPDATE identity.qa_thresholds SET status = 'retired'
      WHERE workspace_id = $1 AND influencer_id IS NOT DISTINCT FROM $2 AND check_key = $3 AND status = 'active'`,
    [ctx.workspaceId, input.influencer_id, input.check_key],
  );
  const id = uuidv7();
  try {
    const row = await one(
      db,
      `INSERT INTO identity.qa_thresholds (id, workspace_id, influencer_id, check_key, min_score, max_score, required, on_fail, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, ctx.workspaceId, input.influencer_id, input.check_key, input.min_score ?? null, input.max_score ?? null, input.required ?? false, input.on_fail ?? 'reject', ctx.userId],
    );
    await auditCtx(db, ctx, {
      influencerId: input.influencer_id,
      action: 'qa_threshold.set',
      subjectType: 'qa_threshold',
      subjectId: id,
      changes: { after: input },
    });
    return row;
  } catch (err) {
    if (pgCode(err) === PG.checkViolation) throw badRequest('INVALID_THRESHOLD', 'min_score must not exceed max_score');
    throw err;
  }
}

