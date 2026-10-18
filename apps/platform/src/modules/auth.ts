import type pg from 'pg';
import type { Db } from '../db/tx.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import type { Ctx } from './context.js';

export interface Principal {
  userId: string;
  workspaceId: string;
  tokenId: string;
  isPlatformAdmin: boolean;
  role: string;
  permissions: Set<string>;
  influencerScope: Set<string> | null;
}

const TOKEN_RE = /^gi_[A-Za-z0-9_-]{43}$/;

/** Issues a staff API token. The plaintext is returned once; only its SHA-256 is stored. */
export async function issueApiToken(
  db: Db,
  input: { userId: string; workspaceId: string; name: string; createdBy: string | null; expiresAt?: Date | null },
): Promise<{ id: string; token: string }> {
  const token = generateToken('gi');
  const id = uuidv7();
  await db.query(
    `INSERT INTO core.api_tokens (id, user_id, workspace_id, name, token_prefix, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, input.userId, input.workspaceId, input.name, token.slice(0, 10), hashToken(token), input.expiresAt ?? null, input.createdBy],
  );
  return { id, token };
}

/** Resolves a bearer token to an active user + active membership + role permissions. */
export async function authenticate(pool: pg.Pool, token: string): Promise<Principal> {
  if (!TOKEN_RE.test(token)) throw unauthorized();
  const { rows } = await pool.query<{
    token_id: string;
    user_id: string;
    workspace_id: string;
    is_platform_admin: boolean;
    membership_id: string;
    role_key: string;
    role_id: string;
    last_used_at: Date | null;
  }>(
    `SELECT t.id AS token_id, t.user_id, t.workspace_id, u.is_platform_admin, m.id AS membership_id,
            r.key AS role_key, r.id AS role_id, t.last_used_at
       FROM core.api_tokens t
       JOIN core.users u ON u.id = t.user_id AND u.status = 'active'
       JOIN core.workspaces w ON w.id = t.workspace_id AND w.status = 'active'
       JOIN core.memberships m ON m.user_id = t.user_id AND m.workspace_id = t.workspace_id AND m.status = 'active'
       JOIN core.roles r ON r.id = m.role_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) throw unauthorized();
  const [perms, scopes] = await Promise.all([
    pool.query<{ permission: string }>('SELECT permission FROM core.role_permissions WHERE role_id = $1', [row.role_id]),
    pool.query<{ influencer_id: string }>(
      'SELECT influencer_id FROM core.membership_influencer_scopes WHERE membership_id = $1',
      [row.membership_id],
    ),
  ]);
  if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 5 * 60_000) {
    await pool.query('UPDATE core.api_tokens SET last_used_at = now() WHERE id = $1', [row.token_id]);
  }
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    tokenId: row.token_id,
    isPlatformAdmin: row.is_platform_admin,
    role: row.role_key,
    permissions: new Set(perms.rows.map((p) => p.permission)),
    influencerScope: scopes.rows.length > 0 ? new Set(scopes.rows.map((s) => s.influencer_id)) : null,
  };
}

export function ctxFromPrincipal(
  p: Principal,
  meta: { requestId: string; traceId?: string | null; ip?: string | null; userAgent?: string | null },
): Ctx {
  return {
    workspaceId: p.workspaceId,
    actor: { type: 'user', id: p.userId },
    userId: p.userId,
    permissions: p.permissions,
    isPlatformAdmin: p.isPlatformAdmin,
    influencerScope: p.influencerScope,
    requestId: meta.requestId,
    traceId: meta.traceId ?? null,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  };
}
