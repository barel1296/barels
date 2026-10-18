import type { ContractValidator } from '../../contract/validator.js';
import type { WorkflowManifest } from '../../contract/types.js';
import type { Db } from '../../db/tx.js';
import { maybeOne, one } from '../../db/tx.js';
import { manifestSha256 } from '../../lib/canonical-json.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/ids.js';
import { maxSatisfying, parseSemver } from '../../lib/semver.js';
import { auditCtx } from '../audit.js';
import { type Actor, type Ctx, requirePermission, requirePlatformAdmin } from '../context.js';

export type WorkflowStatus = 'registered' | 'approved' | 'rejected' | 'deprecated' | 'disabled';

export interface WorkflowRow {
  id: string;
  workflow_key: string;
  version: string;
  contract_version: string;
  task: string;
  title: string;
  output_kind: 'image' | 'video';
  manifest: WorkflowManifest;
  manifest_sha256: string;
  gpu_required: boolean;
  vram_mb_peak: number | null;
  max_runtime_s: number;
  default_priority: string | null;
  is_conformance: boolean;
  deprecated: boolean;
  sunset_at: Date | null;
  status: WorkflowStatus;
  registered_from_engine_id: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  created_at: Date;
}

/** Statuses a job may run under (deprecated versions remain usable until sunset_at). */
export function isUsable(w: Pick<WorkflowRow, 'status' | 'sunset_at'>, now = new Date()): boolean {
  if (w.status === 'approved') return true;
  if (w.status === 'deprecated') return !w.sunset_at || w.sunset_at > now;
  return false;
}

/**
 * Highest usable version of `key` satisfying `range`. Non-deprecated versions
 * win over deprecated ones (contract §4.2: bindings should move off deprecated).
 */
export async function resolveWorkflowVersion(db: Db, key: string, range: string): Promise<WorkflowRow | null> {
  const { rows } = await db.query<WorkflowRow>(
    `SELECT * FROM inference.visual_workflows WHERE workflow_key = $1 AND status IN ('approved', 'deprecated')`,
    [key],
  );
  const usable = rows.filter((r) => isUsable(r));
  const preferred = usable.filter((r) => !r.deprecated && r.status === 'approved');
  for (const pool of [preferred, usable]) {
    const version = maxSatisfying(pool.map((r) => r.version), range);
    if (version) return pool.find((r) => r.version === version)!;
  }
  return null;
}

export async function listWorkflows(db: Db, ctx: Ctx, filter: { status?: string; key?: string }): Promise<Omit<WorkflowRow, 'manifest'>[]> {
  requirePermission(ctx, 'workflow.read');
  const { rows } = await db.query(
    `SELECT w.id, w.workflow_key, w.version, w.contract_version, w.task, w.title, w.output_kind, w.manifest_sha256,
            w.gpu_required, w.vram_mb_peak, w.max_runtime_s, w.default_priority, w.is_conformance, w.deprecated,
            w.sunset_at, w.status, w.registered_from_engine_id, w.decided_by, w.decided_at, w.decision_note, w.created_at,
            coalesce(json_agg(json_build_object('engine_id', ew.engine_id, 'available', ew.available, 'last_seen_at', ew.last_seen_at))
                     FILTER (WHERE ew.engine_id IS NOT NULL), '[]') AS engines
       FROM inference.visual_workflows w
       LEFT JOIN inference.engine_workflows ew ON ew.workflow_id = w.id
      WHERE ($1::text IS NULL OR w.status = $1) AND ($2::text IS NULL OR w.workflow_key = $2)
      GROUP BY w.id
      ORDER BY w.workflow_key, w.version_major, w.version_minor, w.version_patch, w.version`,
    [filter.status ?? null, filter.key ?? null],
  );
  return rows;
}

export async function getWorkflow(db: Db, ctx: Ctx, workflowId: string): Promise<WorkflowRow> {
  requirePermission(ctx, 'workflow.read');
  const row = await maybeOne<WorkflowRow>(db, 'SELECT * FROM inference.visual_workflows WHERE id = $1', [workflowId]);
  if (!row) throw notFound('Workflow', workflowId);
  return row;
}

export type RegisterOutcome = 'added' | 'unchanged' | 'conflict';

/**
 * Registers a manifest (from engine sync or manual upload). Validates it against
 * the contract schema and checks that its input_schema compiles. A known
 * (key, version) with a different hash is refused (MANIFEST_IMMUTABLE).
 */
export async function registerManifest(
  db: Db,
  validator: ContractValidator,
  manifest: WorkflowManifest,
  source: { actor: Actor; engineId: string | null },
): Promise<{ outcome: RegisterOutcome; workflow: WorkflowRow | null; sha256: string; existingSha256?: string }> {
  const check = validator.validate('workflow-manifest', manifest);
  if (!check.ok) throw unprocessable('MANIFEST_INVALID', 'Manifest does not match the workflow-manifest schema', { violations: check.violations });
  try {
    validator.assertCompilable(manifest.input_schema);
  } catch (err) {
    throw unprocessable('MANIFEST_INVALID', `input_schema does not compile: ${(err as Error).message}`);
  }
  if (manifest.outputs.count.min > manifest.outputs.count.max) {
    throw unprocessable('MANIFEST_INVALID', 'outputs.count.min exceeds outputs.count.max');
  }
  const sha = manifestSha256(manifest as unknown as Record<string, unknown>);
  const existing = await maybeOne<WorkflowRow>(
    db,
    'SELECT * FROM inference.visual_workflows WHERE workflow_key = $1 AND version = $2 FOR UPDATE',
    [manifest.workflow_key, manifest.version],
  );
  if (existing) {
    if (existing.manifest_sha256 !== sha) return { outcome: 'conflict', workflow: existing, sha256: sha, existingSha256: existing.manifest_sha256 };
    // Lifecycle fields may change without changing the hash.
    const deprecated = manifest.deprecated === true;
    const sunsetAt = manifest.sunset_at ? new Date(manifest.sunset_at) : null;
    if (deprecated !== existing.deprecated || (sunsetAt?.getTime() ?? null) !== (existing.sunset_at?.getTime() ?? null)) {
      const updated = await one<WorkflowRow>(
        db,
        `UPDATE inference.visual_workflows
            SET deprecated = $2, sunset_at = $3,
                status = CASE WHEN $2 AND status = 'approved' THEN 'deprecated' ELSE status END,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [existing.id, deprecated, sunsetAt],
      );
      return { outcome: 'unchanged', workflow: updated, sha256: sha };
    }
    return { outcome: 'unchanged', workflow: existing, sha256: sha };
  }
  const v = parseSemver(manifest.version)!;
  const row = await one<WorkflowRow>(
    db,
    `INSERT INTO inference.visual_workflows (id, workflow_key, version, version_major, version_minor, version_patch,
       version_prerelease, contract_version, task, title, output_kind, manifest, manifest_sha256, gpu_required,
       vram_mb_peak, max_runtime_s, default_priority, deprecated, sunset_at, registered_from_engine_id,
       registered_by_type, registered_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
     RETURNING *`,
    [
      uuidv7(),
      manifest.workflow_key,
      manifest.version,
      v.major,
      v.minor,
      v.patch,
      v.prerelease,
      manifest.contract_version,
      manifest.task,
      manifest.title,
      manifest.outputs.kind,
      JSON.stringify(manifest),
      sha,
      manifest.resources.gpu_required,
      manifest.resources.vram_mb_peak ?? null,
      manifest.timeouts.max_runtime_s,
      manifest.resources.default_priority ?? null,
      manifest.deprecated === true,
      manifest.sunset_at ?? null,
      source.engineId,
      source.actor.type === 'user' ? 'user' : 'system',
      source.actor.id,
    ],
  );
  return { outcome: 'added', workflow: row, sha256: sha };
}

/** Manual registration by a platform admin (e.g. a manifest handed over before the engine serves it). */
export async function registerManifestManually(db: Db, ctx: Ctx, validator: ContractValidator, manifest: WorkflowManifest): Promise<WorkflowRow> {
  requirePlatformAdmin(ctx);
  const result = await registerManifest(db, validator, manifest, { actor: ctx.actor, engineId: null });
  if (result.outcome === 'conflict') {
    throw conflict('MANIFEST_IMMUTABLE', `${manifest.workflow_key}@${manifest.version} is already registered with a different manifest`, {
      registered_sha256: result.existingSha256,
      submitted_sha256: result.sha256,
    });
  }
  await auditCtx(db, ctx, {
    workspaceId: null,
    action: result.outcome === 'added' ? 'workflow.register' : 'workflow.register_noop',
    subjectType: 'visual_workflow',
    subjectId: result.workflow!.id,
    metadata: { workflow_key: manifest.workflow_key, version: manifest.version, manifest_sha256: result.sha256, source: 'manual' },
  });
  return result.workflow!;
}

const DECISIONS: Record<'approve' | 'reject' | 'disable' | 'deprecate', { from: WorkflowStatus[]; to: WorkflowStatus }> = {
  approve: { from: ['registered'], to: 'approved' },
  reject: { from: ['registered'], to: 'rejected' },
  deprecate: { from: ['approved'], to: 'deprecated' },
  disable: { from: ['registered', 'approved', 'deprecated'], to: 'disabled' },
};

/**
 * Platform decision on a workflow version (contract §5). Approval is the gate
 * that lets jobs use a version; Track A provides quality and licence evidence
 * out of band, referenced in `note`.
 */
export async function decideWorkflow(
  db: Db,
  ctx: Ctx,
  workflowId: string,
  decision: keyof typeof DECISIONS,
  note: string,
): Promise<WorkflowRow> {
  requirePlatformAdmin(ctx);
  const rule = DECISIONS[decision];
  const current = await maybeOne<WorkflowRow>(db, 'SELECT * FROM inference.visual_workflows WHERE id = $1 FOR UPDATE', [workflowId]);
  if (!current) throw notFound('Workflow', workflowId);
  if (!rule.from.includes(current.status)) {
    throw conflict('INVALID_STATUS_TRANSITION', `Cannot ${decision} a workflow that is ${current.status}`);
  }
  const row = await one<WorkflowRow>(
    db,
    `UPDATE inference.visual_workflows
        SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4,
            deprecated = deprecated OR $2 = 'deprecated', updated_at = now()
      WHERE id = $1 RETURNING *`,
    [workflowId, rule.to, ctx.userId, note],
  );
  await auditCtx(db, ctx, {
    workspaceId: null,
    action: `workflow.${decision}`,
    subjectType: 'visual_workflow',
    subjectId: workflowId,
    changes: { before: { status: current.status }, after: { status: rule.to } },
    metadata: { workflow_key: current.workflow_key, version: current.version, note, manifest_sha256: current.manifest_sha256 },
  });
  return row;
}
