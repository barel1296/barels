import type pg from 'pg';
import type { Config } from '../../config.js';
import { EngineCallError, EngineClient } from '../../contract/client.js';
import { CONTRACT_VERSION, type EngineInfo } from '../../contract/types.js';
import type { ContractValidator } from '../../contract/validator.js';
import type { Db } from '../../db/tx.js';
import { maybeOne, one, withTx } from '../../db/tx.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { AppError, PG, conflict, notFound, pgCode, unprocessable } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/ids.js';
import { audit, auditCtx } from '../audit.js';
import { type Actor, type Ctx, requirePermission, requirePlatformAdmin } from '../context.js';
import { registerManifest } from './workflows.js';

export interface EngineRow {
  id: string;
  engine_key: string;
  base_url: string;
  contract_version: string;
  token_ciphertext: Buffer;
  token_nonce: Buffer;
  data_key_ciphertext: Buffer;
  wrapping_key_id: string;
  reported_engine_id: string | null;
  reported_engine_version: string | null;
  engine_kind: 'comfyui' | 'contract_mock' | 'other' | null;
  capabilities: Record<string, unknown>;
  advertised_max_concurrent_jobs: number | null;
  dispatch_limit: number | null;
  media_lane_vram_mb: number | null;
  status: 'active' | 'paused' | 'disabled';
  health: string;
  last_seen_at: Date | null;
  last_sync_at: Date | null;
  updated_at: Date;
}

/** Columns safe to return through the API (never the token). */
export const PUBLIC_ENGINE_COLUMNS = `id, engine_key, base_url, contract_version, reported_engine_id, reported_engine_version,
  engine_kind, capabilities, advertised_max_concurrent_jobs, dispatch_limit, media_lane_vram_mb, status, health,
  last_seen_at, last_sync_at, last_error, created_at, updated_at`;

const tokenAad = (engineKey: string) => `visual_engine:${engineKey}`;

/** Engine clients with decrypted tokens, cached per engine row version. */
export class EngineClients {
  private readonly cache = new Map<string, { updatedAt: number; client: EngineClient }>();

  constructor(
    private readonly config: Config,
    private readonly validator: ContractValidator,
  ) {}

  forRow(row: EngineRow): EngineClient {
    const cached = this.cache.get(row.id);
    if (cached && cached.updatedAt === row.updated_at.getTime()) return cached.client;
    const token = decryptSecret(
      this.config.masterKeys,
      {
        ciphertext: row.token_ciphertext,
        nonce: row.token_nonce,
        dataKeyCiphertext: row.data_key_ciphertext,
        wrappingKeyId: row.wrapping_key_id,
      },
      tokenAad(row.engine_key),
    );
    const client = this.create(row.base_url, token);
    this.cache.set(row.id, { updatedAt: row.updated_at.getTime(), client });
    return client;
  }

  create(baseUrl: string, token: string): EngineClient {
    return new EngineClient({ baseUrl, token, validator: this.validator, timeoutMs: this.config.engineHttpTimeoutMs });
  }
}

function assertSupported(info: EngineInfo): void {
  if (!info.contract_versions.includes(CONTRACT_VERSION)) {
    throw unprocessable('UNSUPPORTED_CONTRACT_VERSION', `Engine supports ${info.contract_versions.join(', ')}; platform requires ${CONTRACT_VERSION}`);
  }
}

function engineErrorToApp(err: unknown): AppError {
  if (err instanceof EngineCallError) {
    return new AppError(502, 'ENGINE_CALL_FAILED', `Engine call failed: ${err.message}`, { engine_error: err.error });
  }
  return err as AppError;
}

/**
 * Registers a visual engine (platform admin). The engine must answer GET /engine
 * with a valid contract payload before it is stored; its token is envelope-encrypted.
 */
export async function registerEngine(
  db: Db,
  ctx: Ctx,
  clients: EngineClients,
  config: Config,
  input: { engine_key: string; base_url: string; token: string; dispatch_limit?: number | null; media_lane_vram_mb?: number | null },
): Promise<Record<string, unknown>> {
  requirePlatformAdmin(ctx);
  const baseUrl = input.base_url.replace(/\/+$/, '');
  let info: EngineInfo;
  try {
    info = await clients.create(baseUrl, input.token).getEngine();
  } catch (err) {
    throw engineErrorToApp(err);
  }
  assertSupported(info);
  const env = encryptSecret(config.masterKey, input.token, tokenAad(input.engine_key));
  const id = uuidv7();
  try {
    const row = await one(
      db,
      `INSERT INTO inference.visual_engines (id, engine_key, base_url, contract_version, token_ciphertext, token_nonce,
         data_key_ciphertext, wrapping_key_id, reported_engine_id, reported_engine_version, engine_kind, capabilities,
         advertised_max_concurrent_jobs, dispatch_limit, media_lane_vram_mb, health, last_seen_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now(), $17)
       RETURNING ${PUBLIC_ENGINE_COLUMNS}`,
      [
        id,
        input.engine_key,
        baseUrl,
        CONTRACT_VERSION,
        env.ciphertext,
        env.nonce,
        env.dataKeyCiphertext,
        env.wrappingKeyId,
        info.engine_id,
        info.engine_version,
        info.engine_kind,
        JSON.stringify(info.capabilities),
        info.capabilities.max_concurrent_jobs,
        input.dispatch_limit ?? null,
        input.media_lane_vram_mb ?? null,
        info.status,
        ctx.userId,
      ],
    );
    await auditCtx(db, ctx, {
      workspaceId: null,
      action: 'engine.register',
      subjectType: 'visual_engine',
      subjectId: id,
      metadata: {
        engine_key: input.engine_key,
        base_url: baseUrl,
        engine_kind: info.engine_kind,
        engine_id: info.engine_id,
        engine_version: info.engine_version,
        contract_versions: info.contract_versions,
      },
    });
    return row;
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('ENGINE_EXISTS', `Engine ${input.engine_key} already registered`);
    throw err;
  }
}

export async function listEngines(db: Db, ctx: Ctx): Promise<unknown[]> {
  requirePermission(ctx, 'workflow.read');
  const { rows } = await db.query(`SELECT ${PUBLIC_ENGINE_COLUMNS} FROM inference.visual_engines ORDER BY engine_key`);
  return rows;
}

export async function loadEngine(db: Db | pg.Pool, engineId: string): Promise<EngineRow> {
  const row = await maybeOne<EngineRow>(db, 'SELECT * FROM inference.visual_engines WHERE id = $1', [engineId]);
  if (!row) throw notFound('Engine', engineId);
  return row;
}

/** Refreshes reported identity, capabilities and health from GET /engine. */
export async function refreshEngineHealth(pool: pg.Pool, clients: EngineClients, engine: EngineRow): Promise<string> {
  try {
    const info = await clients.forRow(engine).getEngine();
    assertSupported(info);
    await pool.query(
      `UPDATE inference.visual_engines
          SET health = $2, reported_engine_id = $3, reported_engine_version = $4, engine_kind = $5, capabilities = $6,
              advertised_max_concurrent_jobs = $7, last_seen_at = now(), last_error = NULL
        WHERE id = $1`,
      [engine.id, info.status, info.engine_id, info.engine_version, info.engine_kind, JSON.stringify(info.capabilities), info.capabilities.max_concurrent_jobs],
    );
    return info.status;
  } catch (err) {
    const error = err instanceof EngineCallError ? err.error : { code: 'INTERNAL', message: (err as Error).message };
    await pool.query(`UPDATE inference.visual_engines SET health = 'unreachable', last_error = $2 WHERE id = $1`, [
      engine.id,
      JSON.stringify(error),
    ]);
    return 'unreachable';
  }
}

export interface SyncReport {
  engine_id: string;
  engine_kind: string | null;
  added: string[];
  unchanged: string[];
  conflicts: { workflow: string; registered_sha256: string; engine_sha256: string }[];
  invalid: { workflow: string; reason: string }[];
  hash_mismatch: { workflow: string; listed: string; computed: string }[];
  no_longer_offered: string[];
}

/**
 * Capability discovery (contract §5): lists the engine's workflows, fetches each
 * manifest, verifies manifest_sha256, registers new versions as `registered`
 * (never auto-approved) and records availability per engine.
 */
export async function syncEngineWorkflows(pool: pg.Pool, clients: EngineClients, validator: ContractValidator, engineId: string, actor: Actor): Promise<SyncReport> {
  const engine = await loadEngine(pool, engineId);
  const client = clients.forRow(engine);
  const listed = await client.listWorkflows();
  const report: SyncReport = {
    engine_id: engineId,
    engine_kind: engine.engine_kind,
    added: [],
    unchanged: [],
    conflicts: [],
    invalid: [],
    hash_mismatch: [],
    no_longer_offered: [],
  };
  const seen: string[] = [];
  for (const entry of listed) {
    const ref = `${entry.workflow_key}@${entry.version}`;
    let manifest;
    try {
      manifest = await client.getManifest(entry.workflow_key, entry.version);
    } catch (err) {
      report.invalid.push({ workflow: ref, reason: (err as Error).message });
      continue;
    }
    if (manifest.workflow_key !== entry.workflow_key || manifest.version !== entry.version) {
      report.invalid.push({ workflow: ref, reason: 'manifest key/version differs from the catalogue entry' });
      continue;
    }
    await withTx(pool, async (db) => {
      let result;
      try {
        result = await registerManifest(db, validator, manifest, { actor, engineId });
      } catch (err) {
        report.invalid.push({ workflow: ref, reason: (err as Error).message });
        return;
      }
      if (result.sha256 !== entry.manifest_sha256) {
        report.hash_mismatch.push({ workflow: ref, listed: entry.manifest_sha256, computed: result.sha256 });
      }
      if (result.outcome === 'conflict') {
        report.conflicts.push({ workflow: ref, registered_sha256: result.existingSha256!, engine_sha256: result.sha256 });
        await audit(db, {
          workspaceId: null,
          actor,
          action: 'workflow.manifest_conflict',
          subjectType: 'visual_workflow',
          subjectId: result.workflow!.id,
          metadata: { engine_id: engineId, workflow: ref, registered_sha256: result.existingSha256, engine_sha256: result.sha256 },
        });
        // A changed manifest under the same version is never offered for dispatch.
        await db.query(
          `INSERT INTO inference.engine_workflows (engine_id, workflow_id, available) VALUES ($1, $2, false)
           ON CONFLICT (engine_id, workflow_id) DO UPDATE SET available = false, last_seen_at = now()`,
          [engineId, result.workflow!.id],
        );
        return;
      }
      (result.outcome === 'added' ? report.added : report.unchanged).push(ref);
      seen.push(result.workflow!.id);
      await db.query(
        `INSERT INTO inference.engine_workflows (engine_id, workflow_id, available) VALUES ($1, $2, true)
         ON CONFLICT (engine_id, workflow_id) DO UPDATE SET available = true, last_seen_at = now()`,
        [engineId, result.workflow!.id],
      );
      if (result.outcome === 'added') {
        await audit(db, {
          workspaceId: null,
          actor,
          action: 'workflow.register',
          subjectType: 'visual_workflow',
          subjectId: result.workflow!.id,
          metadata: { engine_id: engineId, workflow: ref, manifest_sha256: result.sha256, source: 'engine_sync' },
        });
      }
    });
  }
  const gone = await pool.query<{ workflow_key: string; version: string }>(
    `UPDATE inference.engine_workflows ew SET available = false
       FROM inference.visual_workflows w
      WHERE ew.workflow_id = w.id AND ew.engine_id = $1 AND ew.available AND NOT (ew.workflow_id = ANY($2::uuid[]))
      RETURNING w.workflow_key, w.version`,
    [engineId, seen],
  );
  report.no_longer_offered = gone.rows.map((r) => `${r.workflow_key}@${r.version}`);
  await pool.query('UPDATE inference.visual_engines SET last_sync_at = now() WHERE id = $1', [engineId]);
  await withTx(pool, (db) =>
    audit(db, {
      workspaceId: null,
      actor,
      action: 'engine.sync',
      subjectType: 'visual_engine',
      subjectId: engineId,
      metadata: { ...report },
    }),
  );
  return report;
}
