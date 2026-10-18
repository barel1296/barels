import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { canonicalize, sha256Bytes } from '../lib/canonical-json.js';

/**
 * Tamper evidence for core.audit_log (docs/09): rows are sealed per workspace
 * into a hash chain in core.audit_seals and optionally exported as write-once
 * JSONL files. Rows newer than LAG are left for the next run so that late
 * commits with lower ids cannot fall into an already sealed range.
 */
const LAG_MINUTES = 10;
const BATCH = 5000;

interface AuditRow {
  id: number;
  occurred_at: Date;
  workspace_id: string | null;
  influencer_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  subject_type: string;
  subject_id: string;
  approval_request_id: string | null;
  proposal_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  changes: unknown;
  metadata: unknown;
}

const COLUMNS = `id, occurred_at, workspace_id, influencer_id, actor_type, actor_id, action, subject_type, subject_id,
  approval_request_id, proposal_id, request_id, trace_id, changes, metadata`;

function rowLine(r: AuditRow): string {
  return canonicalize({ ...r, occurred_at: r.occurred_at.toISOString() });
}

export function rowsHash(rows: AuditRow[]): Buffer {
  return sha256Bytes(rows.map(rowLine).join('\n'));
}

export function chainHash(prev: Buffer | null, rowsDigest: Buffer): Buffer {
  return sha256Bytes(Buffer.concat([prev ?? Buffer.alloc(0), rowsDigest]));
}

export async function sealAuditLog(pool: pg.Pool, exportDir: string | null): Promise<{ seals: number; rows: number }> {
  const scopes = await pool.query<{ workspace_id: string | null }>(
    `SELECT DISTINCT a.workspace_id FROM core.audit_log a
      WHERE a.occurred_at < now() - make_interval(mins => $1)
        AND a.id > coalesce((SELECT max(last_log_id) FROM core.audit_seals s WHERE s.workspace_id IS NOT DISTINCT FROM a.workspace_id), 0)`,
    [LAG_MINUTES],
  );
  let seals = 0;
  let total = 0;
  for (const { workspace_id } of scopes.rows) {
    const last = await pool.query<{ last_log_id: number; seal_hash: Buffer }>(
      `SELECT last_log_id, seal_hash FROM core.audit_seals WHERE workspace_id IS NOT DISTINCT FROM $1 ORDER BY id DESC LIMIT 1`,
      [workspace_id],
    );
    const prev = last.rows[0] ?? null;
    const { rows } = await pool.query<AuditRow>(
      `SELECT ${COLUMNS} FROM core.audit_log
        WHERE workspace_id IS NOT DISTINCT FROM $1 AND id > $2 AND occurred_at < now() - make_interval(mins => $3)
        ORDER BY id LIMIT $4`,
      [workspace_id, prev?.last_log_id ?? 0, LAG_MINUTES, BATCH],
    );
    if (rows.length === 0) continue;
    const digest = rowsHash(rows);
    const seal = chainHash(prev?.seal_hash ?? null, digest);
    const first = rows[0]!.id;
    const lastId = rows.at(-1)!.id;
    let exportedRef: string | null = null;
    if (exportDir) {
      await mkdir(exportDir, { recursive: true });
      exportedRef = join(exportDir, `audit-${workspace_id ?? 'platform'}-${String(first).padStart(12, '0')}-${String(lastId).padStart(12, '0')}.jsonl`);
      const trailer = canonicalize({ seal: { workspace_id, first_log_id: first, last_log_id: lastId, rows_hash: digest.toString('hex'), prev_seal_hash: prev?.seal_hash.toString('hex') ?? null, seal_hash: seal.toString('hex') } });
      // 'wx': never overwrite an existing export (write-once).
      await writeFile(exportedRef, `${rows.map(rowLine).join('\n')}\n${trailer}\n`, { flag: 'wx' });
    }
    await pool.query(
      `INSERT INTO core.audit_seals (workspace_id, first_log_id, last_log_id, rows_hash, prev_seal_hash, seal_hash, exported_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [workspace_id, first, lastId, digest, prev?.seal_hash ?? null, seal, exportedRef],
    );
    seals++;
    total += rows.length;
  }
  return { seals, rows: total };
}

export interface ChainProblem {
  workspace_id: string | null;
  seal_id: number;
  problem: string;
}

/** Recomputes every seal from the current audit rows and checks the chain links. */
export async function verifyAuditChain(pool: pg.Pool): Promise<{ ok: boolean; seals_checked: number; problems: ChainProblem[] }> {
  const seals = await pool.query<{ id: number; workspace_id: string | null; first_log_id: number; last_log_id: number; rows_hash: Buffer; prev_seal_hash: Buffer | null; seal_hash: Buffer }>(
    'SELECT id, workspace_id, first_log_id, last_log_id, rows_hash, prev_seal_hash, seal_hash FROM core.audit_seals ORDER BY workspace_id NULLS FIRST, id',
  );
  const problems: ChainProblem[] = [];
  const lastByScope = new Map<string, { seal: Buffer; lastId: number }>();
  for (const s of seals.rows) {
    const scope = s.workspace_id ?? 'platform';
    const prev = lastByScope.get(scope) ?? null;
    const startAfter = prev?.lastId ?? 0;
    const { rows } = await pool.query<AuditRow>(
      `SELECT ${COLUMNS} FROM core.audit_log WHERE workspace_id IS NOT DISTINCT FROM $1 AND id > $2 AND id <= $3 ORDER BY id`,
      [s.workspace_id, startAfter, s.last_log_id],
    );
    const digest = rowsHash(rows);
    if (!digest.equals(s.rows_hash)) problems.push({ workspace_id: s.workspace_id, seal_id: s.id, problem: 'rows changed, added or removed since sealing' });
    if ((prev?.seal ?? null) === null ? s.prev_seal_hash !== null : !prev!.seal.equals(s.prev_seal_hash ?? Buffer.alloc(0))) {
      problems.push({ workspace_id: s.workspace_id, seal_id: s.id, problem: 'chain link broken (prev_seal_hash)' });
    }
    if (!chainHash(s.prev_seal_hash, s.rows_hash).equals(s.seal_hash)) problems.push({ workspace_id: s.workspace_id, seal_id: s.id, problem: 'seal_hash does not match' });
    lastByScope.set(scope, { seal: s.seal_hash, lastId: s.last_log_id });
  }
  return { ok: problems.length === 0, seals_checked: seals.rows.length, problems };
}
