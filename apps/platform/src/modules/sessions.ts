import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { AuthConfig, Config } from '../config.js';
import { withTenant, withTx } from '../db/tx.js';
import { decryptSecret, encryptSecret, hashToken, safeEqual } from '../lib/crypto.js';
import { AppError, badRequest, unauthorized } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { audit } from './audit.js';
import type { Principal } from './auth.js';

/**
 * Staff authentication for the admin dashboard: password (scrypt) + mandatory
 * TOTP, server-side sessions in core.sessions (only token hashes are stored),
 * double-submit CSRF tokens, and lockout after repeated failures. API tokens
 * (modules/auth.ts) remain for automation.
 */
export const SESSION_COOKIE = 'gi_session';
export const CSRF_COOKIE = 'gi_csrf';

const totpAad = (userId: string) => `user_totp:${userId}`;

interface UserAuthRow {
  id: string;
  email: string;
  display_name: string;
  status: string;
  password_hash: string | null;
  totp_ciphertext: Buffer | null;
  totp_nonce: Buffer | null;
  totp_data_key: Buffer | null;
  totp_wrapping_key_id: string | null;
  totp_last_step: number | null;
  failed_login_count: number;
  locked_until: Date | null;
}

function decryptTotp(config: Config, u: UserAuthRow): string | null {
  if (!u.totp_ciphertext || !u.totp_nonce || !u.totp_data_key || !u.totp_wrapping_key_id) return null;
  return decryptSecret(
    config.masterKeys,
    { ciphertext: u.totp_ciphertext, nonce: u.totp_nonce, dataKeyCiphertext: u.totp_data_key, wrappingKeyId: u.totp_wrapping_key_id },
    totpAad(u.id),
  );
}

export interface LoginResult {
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
  user: { id: string; email: string; display_name: string };
  workspace: { id: string; slug: string; name: string };
  role: string;
}

/** Simple in-memory per-IP limiter for the login endpoint (defence in depth beside per-user lockout). */
export class LoginRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly perMinute = 20) {}
  allow(key: string): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    this.hits.set(key, arr);
    return arr.length <= this.perMinute;
  }
}

export async function login(
  pool: pg.Pool,
  config: Config,
  input: { email: string; password: string; totp: string; workspace?: string | null; ip?: string | null; userAgent?: string | null },
): Promise<LoginResult> {
  const auth = config.auth;
  const fail = async (u: UserAuthRow | null, reason: string): Promise<never> => {
    if (u) {
      const count = u.failed_login_count + 1;
      await pool.query(
        `UPDATE core.users SET failed_login_count = $2::int,
                locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int) ELSE locked_until END
          WHERE id = $1`,
        [u.id, count, auth.maxFailedLogins, auth.lockoutMinutes],
      );
    }
    await withTx(pool, (db) =>
      audit(db, {
        workspaceId: null,
        actor: { type: 'external', id: input.ip ?? 'unknown' },
        action: 'auth.login_failed',
        subjectType: 'user',
        subjectId: u?.id ?? 'unknown',
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: { reason, email_hash: hashToken(input.email.toLowerCase()).toString('hex').slice(0, 16) },
      }),
    );
    // Same message for every failure: no account enumeration.
    throw new AppError(401, 'LOGIN_FAILED', 'Invalid email, password or authentication code');
  };

  const { rows } = await pool.query<UserAuthRow>(
    `SELECT id, email, display_name, status, password_hash, totp_ciphertext, totp_nonce, totp_data_key, totp_wrapping_key_id,
            totp_last_step, failed_login_count, locked_until
       FROM core.users WHERE email = $1`,
    [input.email],
  );
  const u = rows[0] ?? null;
  const passwordOk = await verifyPassword(input.password, u?.password_hash ?? null);
  if (!u || u.status !== 'active') return fail(u, 'unknown_or_disabled');
  if (u.locked_until && u.locked_until > new Date()) {
    throw new AppError(429, 'LOGIN_LOCKED', 'Too many failed attempts; try again later');
  }
  if (!passwordOk) return fail(u, 'password');
  const secret = decryptTotp(config, u);
  if (!secret) throw new AppError(403, 'MFA_NOT_ENROLLED', 'Two-factor authentication is not set up for this account; complete account setup first');
  const step = verifyTotp(secret, input.totp, Math.floor(Date.now() / 1000), u.totp_last_step);
  if (step === null) return fail(u, 'totp');

  const membership = await pool.query<{ workspace_id: string; slug: string; name: string; role: string }>(
    `SELECT m.workspace_id, w.slug, w.name, r.key AS role
       FROM core.memberships m JOIN core.workspaces w ON w.id = m.workspace_id AND w.status = 'active'
       JOIN core.roles r ON r.id = m.role_id
      WHERE m.user_id = $1 AND m.status = 'active' AND ($2::text IS NULL OR w.slug = $2)
      ORDER BY m.created_at LIMIT 1`,
    [u.id, input.workspace ?? null],
  );
  const ws = membership.rows[0];
  if (!ws) return fail(u, 'no_membership');

  const sessionToken = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + auth.sessionTtlHours * 3600_000);
  await withTenant(pool, ws.workspace_id, async (db) => {
    await db.query(
      `UPDATE core.users SET failed_login_count = 0, locked_until = NULL, totp_last_step = $2, last_login_at = now() WHERE id = $1`,
      [u.id, step],
    );
    const sessionId = uuidv7();
    await db.query(
      `INSERT INTO core.sessions (id, user_id, workspace_id, token_hash, csrf_hash, expires_at, idle_expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7), $8, $9)`,
      [sessionId, u.id, ws.workspace_id, hashToken(sessionToken), hashToken(csrfToken), expiresAt, auth.sessionIdleMinutes, input.ip ?? null, input.userAgent ?? null],
    );
    await audit(db, {
      workspaceId: ws.workspace_id,
      actor: { type: 'user', id: u.id },
      action: 'auth.login',
      subjectType: 'session',
      subjectId: sessionId,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  });
  return {
    sessionToken,
    csrfToken,
    expiresAt,
    user: { id: u.id, email: u.email, display_name: u.display_name },
    workspace: { id: ws.workspace_id, slug: ws.slug, name: ws.name },
    role: ws.role,
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Resolves a session cookie to a principal; unsafe methods must present the CSRF token. */
export async function authenticateSession(
  pool: pg.Pool,
  auth: AuthConfig,
  sessionToken: string,
  method: string,
  csrfHeader: string | undefined,
): Promise<Principal & { sessionId: string }> {
  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    workspace_id: string;
    csrf_hash: Buffer;
    is_platform_admin: boolean;
    membership_id: string;
    role_id: string;
    role_key: string;
    last_seen_at: Date;
  }>(
    `SELECT s.id, s.user_id, s.workspace_id, s.csrf_hash, u.is_platform_admin, m.id AS membership_id, r.id AS role_id, r.key AS role_key, s.last_seen_at
       FROM core.sessions s
       JOIN core.users u ON u.id = s.user_id AND u.status = 'active'
       JOIN core.workspaces w ON w.id = s.workspace_id AND w.status = 'active'
       JOIN core.memberships m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id AND m.status = 'active'
       JOIN core.roles r ON r.id = m.role_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND s.idle_expires_at > now()`,
    [hashToken(sessionToken)],
  );
  const s = rows[0];
  if (!s) throw unauthorized('Session expired or invalid');
  if (!SAFE_METHODS.has(method.toUpperCase())) {
    if (!csrfHeader || !safeEqual(hashToken(csrfHeader), s.csrf_hash)) throw new AppError(403, 'CSRF_FAILED', 'Missing or invalid CSRF token');
  }
  if (Date.now() - s.last_seen_at.getTime() > 60_000) {
    await pool.query(`UPDATE core.sessions SET last_seen_at = now(), idle_expires_at = now() + make_interval(mins => $2) WHERE id = $1`, [s.id, auth.sessionIdleMinutes]);
  }
  const [perms, scopes] = [
    await pool.query<{ permission: string }>('SELECT permission FROM core.role_permissions WHERE role_id = $1', [s.role_id]),
    await pool.query<{ influencer_id: string }>('SELECT influencer_id FROM core.membership_influencer_scopes WHERE membership_id = $1', [s.membership_id]),
  ];
  return {
    sessionId: s.id,
    userId: s.user_id,
    workspaceId: s.workspace_id,
    tokenId: s.id,
    isPlatformAdmin: s.is_platform_admin,
    role: s.role_key,
    permissions: new Set(perms.rows.map((p) => p.permission)),
    influencerScope: scopes.rows.length ? new Set(scopes.rows.map((x) => x.influencer_id)) : null,
  };
}

export async function logout(pool: pg.Pool, sessionToken: string): Promise<void> {
  await pool.query(`UPDATE core.sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE token_hash = $1 AND revoked_at IS NULL`, [hashToken(sessionToken)]);
}

export async function revokeUserSessions(pool: pg.Pool, userId: string, reason: string): Promise<number> {
  const res = await pool.query(`UPDATE core.sessions SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, reason]);
  return res.rowCount ?? 0;
}

// -----------------------------------------------------------------------------
// Credentials management (CLI and invite flow)
// -----------------------------------------------------------------------------

export async function setPassword(pool: pg.Pool, userId: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await pool.query('UPDATE core.users SET password_hash = $2, password_changed_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1', [userId, hash]);
  await revokeUserSessions(pool, userId, 'password_changed');
}

/** Generates and stores a new TOTP secret (encrypted). Returns the otpauth URI to show once. */
export async function enrollTotp(pool: pg.Pool, config: Config, userId: string, email: string): Promise<{ secret: string; uri: string }> {
  const secret = generateTotpSecret();
  const env = encryptSecret(config.masterKey, secret, totpAad(userId));
  await pool.query(
    `UPDATE core.users SET totp_ciphertext = $2, totp_nonce = $3, totp_data_key = $4, totp_wrapping_key_id = $5, totp_last_step = NULL, mfa_enrolled_at = now()
      WHERE id = $1`,
    [userId, env.ciphertext, env.nonce, env.dataKeyCiphertext, env.wrappingKeyId],
  );
  await revokeUserSessions(pool, userId, 'mfa_reset');
  return { secret, uri: otpauthUri(config.auth.totpIssuer, email, secret) };
}

/** Creates a single-use setup token (24 h) for an invited user. */
export async function issueSetupToken(pool: pg.Pool, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query(`UPDATE core.users SET setup_token_hash = $2, setup_expires_at = now() + interval '24 hours' WHERE id = $1`, [userId, hashToken(token)]);
  return token;
}

/**
 * Step 1 of account setup: set the password with the setup token; returns a new
 * TOTP enrolment (shown once). Step 2 (`confirmSetup`) proves the authenticator works.
 */
export async function beginSetup(pool: pg.Pool, config: Config, setupToken: string, password: string): Promise<{ uri: string; secret: string }> {
  const { rows } = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM core.users WHERE setup_token_hash = $1 AND setup_expires_at > now() AND status = 'active'`,
    [hashToken(setupToken)],
  );
  const u = rows[0];
  if (!u) throw new AppError(400, 'SETUP_TOKEN_INVALID', 'Setup link is invalid or expired');
  try {
    await setPassword(pool, u.id, password);
  } catch (err) {
    throw badRequest('WEAK_PASSWORD', (err as Error).message);
  }
  return enrollTotp(pool, config, u.id, u.email);
}

export async function confirmSetup(pool: pg.Pool, config: Config, setupToken: string, code: string): Promise<void> {
  const { rows } = await pool.query<UserAuthRow>(
    `SELECT id, email, display_name, status, password_hash, totp_ciphertext, totp_nonce, totp_data_key, totp_wrapping_key_id, totp_last_step,
            failed_login_count, locked_until
       FROM core.users WHERE setup_token_hash = $1 AND setup_expires_at > now()`,
    [hashToken(setupToken)],
  );
  const u = rows[0];
  if (!u) throw new AppError(400, 'SETUP_TOKEN_INVALID', 'Setup link is invalid or expired');
  const secret = decryptTotp(config, u);
  const step = secret ? verifyTotp(secret, code, Math.floor(Date.now() / 1000), null) : null;
  if (step === null) throw new AppError(400, 'TOTP_INVALID', 'The authentication code is not valid');
  await pool.query(`UPDATE core.users SET setup_token_hash = NULL, setup_expires_at = NULL, totp_last_step = $2 WHERE id = $1`, [u.id, step]);
  await withTx(pool, (db) => audit(db, { workspaceId: null, actor: { type: 'user', id: u.id }, action: 'auth.setup_completed', subjectType: 'user', subjectId: u.id }));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookies(auth: AuthConfig, r: { sessionToken: string; csrfToken: string; expiresAt: Date } | null): string[] {
  const secure = auth.cookieSecure ? '; Secure' : '';
  if (!r) {
    return [`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`, `${CSRF_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0${secure}`];
  }
  const exp = r.expiresAt.toUTCString();
  return [
    `${SESSION_COOKIE}=${r.sessionToken}; Path=/; HttpOnly; SameSite=Strict; Expires=${exp}${secure}`,
    `${CSRF_COOKIE}=${r.csrfToken}; Path=/; SameSite=Strict; Expires=${exp}${secure}`,
  ];
}
