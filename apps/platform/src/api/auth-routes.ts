import type { FastifyInstance } from 'fastify';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { verifyPassword } from '../lib/password.js';
import { audit, auditCtx } from '../modules/audit.js';
import { requirePermission } from '../modules/context.js';
import {
  LoginRateLimiter,
  SESSION_COOKIE,
  beginSetup,
  confirmSetup,
  issueSetupToken,
  login,
  logout,
  parseCookies,
  revokeUserSessions,
  sessionCookies,
  setPassword,
} from '../modules/sessions.js';
import type { Services } from '../services.js';
import type { Api } from './server.js';

const ROLES = ['owner', 'admin', 'compliance_officer', 'content_manager', 'reviewer', 'chat_operator', 'finance', 'analyst', 'viewer'];

export function registerAuthRoutes(app: FastifyInstance, svc: Services, api: Api): void {
  const limiter = new LoginRateLimiter(20);
  const pub = { config: { public: true } };

  app.post<{ Body: { email: string; password: string; totp: string; workspace?: string } }>(
    '/v1/auth/login',
    {
      ...pub,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password', 'totp'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 320 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
            totp: { type: 'string', pattern: '^[0-9]{6}$' },
            workspace: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!limiter.allow(req.ip)) throw new AppError(429, 'RATE_LIMITED', 'Too many login attempts from this address');
      const r = await login(svc.appPool, svc.config, { ...req.body, ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
      reply.header('set-cookie', sessionCookies(svc.config.auth, r));
      return { user: r.user, workspace: r.workspace, role: r.role, csrf_token: r.csrfToken, expires_at: r.expiresAt.toISOString() };
    },
  );

  app.post('/v1/auth/logout', async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await logout(svc.appPool, token);
    reply.header('set-cookie', sessionCookies(svc.config.auth, null));
    return { ok: true };
  });

  app.get('/v1/auth/session', async (req) => {
    const user = await svc.appPool.query<{ email: string; display_name: string; mfa_enrolled_at: Date | null }>(
      'SELECT email, display_name, mfa_enrolled_at FROM core.users WHERE id = $1',
      [req.ctx.userId],
    );
    const ws = await svc.appPool.query<{ slug: string; name: string }>('SELECT slug, name FROM core.workspaces WHERE id = $1', [req.ctx.workspaceId]);
    return {
      user: { id: req.ctx.userId, ...user.rows[0] },
      workspace: { id: req.ctx.workspaceId, ...ws.rows[0] },
      is_platform_admin: req.ctx.isPlatformAdmin,
      permissions: [...req.ctx.permissions].sort(),
    };
  });

  app.post<{ Body: { current_password: string; new_password: string } }>(
    '/v1/auth/password',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['current_password', 'new_password'],
          properties: { current_password: { type: 'string', maxLength: 1024 }, new_password: { type: 'string', minLength: 12, maxLength: 1024 } },
        },
      },
    },
    async (req, reply) => {
      const row = await svc.appPool.query<{ password_hash: string | null }>('SELECT password_hash FROM core.users WHERE id = $1', [req.ctx.userId]);
      if (!(await verifyPassword(req.body.current_password, row.rows[0]?.password_hash ?? null))) throw forbidden('Current password is incorrect');
      await setPassword(svc.appPool, req.ctx.userId!, req.body.new_password);
      await api.tenant(req, (db) => audit(db, { workspaceId: req.ctx.workspaceId, actor: req.ctx.actor, action: 'auth.password_changed', subjectType: 'user', subjectId: req.ctx.userId! }));
      reply.header('set-cookie', sessionCookies(svc.config.auth, null));
      return { ok: true, note: 'All sessions were signed out; log in again.' };
    },
  );

  // Invite flow (public, token-bound).
  app.post<{ Body: { setup_token: string; password: string } }>(
    '/v1/auth/setup',
    {
      ...pub,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['setup_token', 'password'],
          properties: { setup_token: { type: 'string', minLength: 20, maxLength: 200 }, password: { type: 'string', minLength: 12, maxLength: 1024 } },
        },
      },
    },
    async (req) => {
      if (!limiter.allow(req.ip)) throw new AppError(429, 'RATE_LIMITED', 'Too many attempts');
      const enrol = await beginSetup(svc.appPool, svc.config, req.body.setup_token, req.body.password);
      return { otpauth_uri: enrol.uri, totp_secret: enrol.secret, next: 'POST /v1/auth/setup/confirm with a code from the authenticator app' };
    },
  );

  app.post<{ Body: { setup_token: string; totp: string } }>(
    '/v1/auth/setup/confirm',
    {
      ...pub,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['setup_token', 'totp'],
          properties: { setup_token: { type: 'string', minLength: 20, maxLength: 200 }, totp: { type: 'string', pattern: '^[0-9]{6}$' } },
        },
      },
    },
    async (req) => {
      await confirmSetup(svc.appPool, svc.config, req.body.setup_token, req.body.totp);
      return { ok: true };
    },
  );

  // --- User administration (owner/admin: user.manage) ---------------------------
  app.get('/v1/admin/users', async (req) => {
    requirePermission(req.ctx, 'user.manage');
    const { rows } = await svc.appPool.query(
      `SELECT u.id, u.email, u.display_name, u.status AS user_status, u.is_platform_admin, u.mfa_enrolled_at, u.last_login_at, u.locked_until,
              (u.setup_token_hash IS NOT NULL) AS setup_pending, m.status AS membership_status, r.key AS role
         FROM core.memberships m JOIN core.users u ON u.id = m.user_id JOIN core.roles r ON r.id = m.role_id
        WHERE m.workspace_id = $1 ORDER BY u.email`,
      [req.ctx.workspaceId],
    );
    return rows;
  });

  app.post<{ Body: { email: string; display_name: string; role: string } }>(
    '/v1/admin/users',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'display_name', 'role'],
          properties: { email: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+$', maxLength: 320 }, display_name: { type: 'string', minLength: 1, maxLength: 120 }, role: { type: 'string', enum: ROLES } },
        },
      },
    },
    async (req, reply) => {
      requirePermission(req.ctx, 'user.manage');
      if (req.body.role === 'owner' && req.ctx.isPlatformAdmin !== true) throw forbidden('Only a platform administrator can create owners');
      const out = await api.tenant(req, async (db, ctx) => {
        const existing = await db.query<{ id: string }>('SELECT id FROM core.users WHERE email = $1', [req.body.email]);
        const userId = existing.rows[0]?.id ?? uuidv7();
        if (!existing.rows[0]) {
          await db.query(`INSERT INTO core.users (id, email, display_name, idp_issuer, idp_subject) VALUES ($1, $2, $3, 'local', $2::citext::text)`, [userId, req.body.email, req.body.display_name]);
        }
        const member = await db.query('SELECT 1 FROM core.memberships WHERE workspace_id = $1 AND user_id = $2', [ctx.workspaceId, userId]);
        if (member.rowCount) throw conflict('ALREADY_MEMBER', 'This user is already a member of the workspace');
        await db.query(
          `INSERT INTO core.memberships (workspace_id, user_id, role_id) SELECT $1, $2, id FROM core.roles WHERE key = $3 AND workspace_id IS NULL`,
          [ctx.workspaceId, userId, req.body.role],
        );
        await auditCtx(db, ctx, { action: 'user.invite', subjectType: 'user', subjectId: userId, metadata: { role: req.body.role } });
        return { userId, isNew: !existing.rows[0] };
      });
      const setupToken = out.isNew ? await issueSetupToken(svc.appPool, out.userId) : null;
      return reply.status(201).send({
        user_id: out.userId,
        setup_token: setupToken,
        note: setupToken ? 'Give the setup token to the person over a trusted channel; it expires in 24 hours and works once.' : 'Existing account added to this workspace.',
      });
    },
  );

  app.patch<{ Params: { id: string }; Body: { role?: string; status?: 'active' | 'suspended' } }>(
    '/v1/admin/users/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', additionalProperties: false, properties: { role: { type: 'string', enum: ROLES }, status: { type: 'string', enum: ['active', 'suspended'] } } },
      },
    },
    async (req) => {
      requirePermission(req.ctx, 'user.manage');
      if (req.params.id === req.ctx.userId) throw forbidden('You cannot change your own role or status');
      return api.tenant(req, async (db, ctx) => {
        const m = await db.query<{ id: string; role: string; status: string }>(
          `SELECT m.id, r.key AS role, m.status FROM core.memberships m JOIN core.roles r ON r.id = m.role_id WHERE m.workspace_id = $1 AND m.user_id = $2`,
          [ctx.workspaceId, req.params.id],
        );
        const current = m.rows[0];
        if (!current) throw notFound('Member', req.params.id);
        const demotingOwner = current.role === 'owner' && ((req.body.role && req.body.role !== 'owner') || req.body.status === 'suspended');
        if (demotingOwner) {
          const owners = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM core.memberships m JOIN core.roles r ON r.id = m.role_id WHERE m.workspace_id = $1 AND r.key = 'owner' AND m.status = 'active'`,
            [ctx.workspaceId],
          );
          if (owners.rows[0]!.n <= 1) throw conflict('LAST_OWNER', 'The workspace must keep at least one active owner');
        }
        if (req.body.role === 'owner' && !ctx.isPlatformAdmin) throw forbidden('Only a platform administrator can grant the owner role');
        if (req.body.role) {
          await db.query(`UPDATE core.memberships SET role_id = (SELECT id FROM core.roles WHERE key = $2 AND workspace_id IS NULL) WHERE id = $1`, [current.id, req.body.role]);
        }
        if (req.body.status) await db.query('UPDATE core.memberships SET status = $2 WHERE id = $1', [current.id, req.body.status]);
        await auditCtx(db, ctx, { action: 'user.membership_update', subjectType: 'user', subjectId: req.params.id, changes: { before: current, after: req.body } });
        if (req.body.status === 'suspended' || req.body.role) await revokeUserSessions(svc.appPool, req.params.id, 'membership_changed');
        return { ok: true };
      });
    },
  );

  app.post<{ Params: { id: string } }>('/v1/admin/users/:id/reset-credentials', async (req) => {
    requirePermission(req.ctx, 'user.manage');
    if (req.params.id === req.ctx.userId) throw badRequest('INVALID_REQUEST', 'Use the password change endpoint for your own account');
    const member = await svc.appPool.query('SELECT 1 FROM core.memberships WHERE workspace_id = $1 AND user_id = $2', [req.ctx.workspaceId, req.params.id]);
    if (!member.rowCount) throw notFound('Member', req.params.id);
    await revokeUserSessions(svc.appPool, req.params.id, 'credentials_reset');
    await svc.appPool.query('UPDATE core.users SET password_hash = NULL, totp_ciphertext = NULL, mfa_enrolled_at = NULL WHERE id = $1', [req.params.id]);
    const token = await issueSetupToken(svc.appPool, req.params.id);
    await api.tenant(req, (db) => audit(db, { workspaceId: req.ctx.workspaceId, actor: req.ctx.actor, action: 'user.credentials_reset', subjectType: 'user', subjectId: req.params.id }));
    return { setup_token: token };
  });
}
