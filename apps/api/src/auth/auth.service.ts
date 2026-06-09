import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { ACTION_KINDS } from '@gros/shared';
import { DbService } from '../db/db.service';
import { JwtTokenService } from './jwt.service';
import { loadConfig } from '../config/config';
import { sha256Hex, randomToken } from '../common/crypto';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  userId: string;
  role: string;
}

const DEFAULT_GUARDRAILS: { key: string; description: string; params: Record<string, unknown> }[] = [
  {
    key: 'max_budget_change_pct_per_day',
    description: 'Maximum budget change per entity per day (%)',
    params: { maxPct: 25 },
  },
  {
    key: 'max_budget_change_usd',
    description: 'Maximum absolute daily budget change without elevated approval',
    params: { maxUsd: 5000 },
  },
  {
    key: 'blast_radius_pct',
    description: 'Max share of tenant daily spend affected by one action',
    params: { maxPct: 10 },
  },
  {
    key: 'entity_change_cooldown_hours',
    description: 'Minimum hours between changes to the same entity',
    params: { hours: 24 },
  },
  {
    key: 'data_health_gate',
    description: 'Block actions while the relevant health domain is red',
    params: {},
  },
];

@Injectable()
export class AuthService {
  private readonly cfg = loadConfig();

  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtTokenService,
  ) {}

  /** Bootstrap: first user creates the tenant and becomes Owner. */
  async register(input: {
    email: string;
    password: string;
    name: string;
    tenantName: string;
    tenantSlug: string;
  }): Promise<TokenPair> {
    const passwordHash = await bcrypt.hash(input.password, 12);
    return this.db.withContext({}, async (c) => {
      const existing = await c.query('SELECT 1 FROM users WHERE email = $1', [
        input.email,
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new ConflictException('Email already registered');
      }
      const slugTaken = await c.query('SELECT 1 FROM tenants WHERE slug = $1', [
        input.tenantSlug,
      ]);
      if ((slugTaken.rowCount ?? 0) > 0) {
        throw new ConflictException('Tenant slug already taken');
      }

      const userRes = await c.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [input.email, input.name, passwordHash],
      );
      const userId = userRes.rows[0]!.id;
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);

      const tenantRes = await c.query<{ id: string }>(
        `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
        [input.tenantName, input.tenantSlug],
      );
      const tenantId = tenantRes.rows[0]!.id;
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

      const roleRes = await c.query<{ id: string }>(
        `SELECT id FROM roles WHERE tenant_id IS NULL AND name = 'owner'`,
      );
      await c.query(
        `INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
        [tenantId, userId, roleRes.rows[0]!.id],
      );

      // Tenant defaults: cost budget, approval policies (all kinds L2),
      // guardrail policies, health domains.
      await c.query(`INSERT INTO cost_budgets (tenant_id) VALUES ($1)`, [tenantId]);
      for (const kind of ACTION_KINDS) {
        await c.query(
          `INSERT INTO approval_policies (tenant_id, action_kind, rules, autonomy_level)
           VALUES ($1, $2, $3, 2)`,
          [
            tenantId,
            kind,
            JSON.stringify({
              requiredPermission: `actions:approve:${kind}`,
              maxMagnitudeUsd: kind === 'budget_change' ? 5000 : null,
              twoPersonAboveUsd: null,
              expiryHours: 72,
            }),
          ],
        );
      }
      for (const g of DEFAULT_GUARDRAILS) {
        await c.query(
          `INSERT INTO guardrail_policies (tenant_id, key, description, params)
           VALUES ($1, $2, $3, $4)`,
          [tenantId, g.key, g.description, JSON.stringify(g.params)],
        );
      }
      for (const domain of ['attribution', 'spend', 'revenue', 'events', 'skan']) {
        await c.query(
          `INSERT INTO health_status (tenant_id, domain, status, declared_by)
           VALUES ($1, $2, 'green', 'system')`,
          [tenantId, domain],
        );
      }

      await c.query(
        `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, event, object_type, object_id, after_ref)
         VALUES ($1, 'user', $2, 'tenant.created', 'tenant', $1, $3)`,
        [tenantId, userId, JSON.stringify({ name: input.tenantName, slug: input.tenantSlug })],
      );

      const refreshToken = await this.issueRefreshToken(c, userId, tenantId);
      return {
        accessToken: this.jwt.signAccess({ sub: userId, ten: tenantId, rol: 'owner' }),
        refreshToken,
        tenantId,
        userId,
        role: 'owner',
      };
    });
  }

  async login(email: string, password: string, tenantSlug?: string): Promise<TokenPair> {
    return this.db.withContext({}, async (c) => {
      const userRes = await c.query<{ id: string; password_hash: string | null; status: string }>(
        `SELECT id, password_hash, status FROM users WHERE email = $1`,
        [email],
      );
      const user = userRes.rows[0];
      if (!user || !user.password_hash || user.status !== 'active') {
        throw new UnauthorizedException('Invalid credentials');
      }
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) throw new UnauthorizedException('Invalid credentials');

      await c.query(`SELECT set_config('app.user_id', $1, true)`, [user.id]);
      const memberships = await c.query<{ tenant_id: string; role_name: string; slug: string }>(
        `SELECT m.tenant_id, r.name AS role_name, t.slug
           FROM memberships m
           JOIN roles r ON r.id = m.role_id
           JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1 AND m.status = 'active'`,
        [user.id],
      );
      const membership = tenantSlug
        ? memberships.rows.find((m) => m.slug === tenantSlug)
        : memberships.rows[0];
      if (!membership) throw new UnauthorizedException('No active membership');

      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [membership.tenant_id]);
      const refreshToken = await this.issueRefreshToken(c, user.id, membership.tenant_id);
      await c.query(
        `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, event, object_type, object_id)
         VALUES ($1, 'user', $2, 'auth.login', 'user', $2)`,
        [membership.tenant_id, user.id],
      );
      return {
        accessToken: this.jwt.signAccess({
          sub: user.id,
          ten: membership.tenant_id,
          rol: membership.role_name,
        }),
        refreshToken,
        tenantId: membership.tenant_id,
        userId: user.id,
        role: membership.role_name,
      };
    });
  }

  /** Rotating refresh: old token revoked, replacement issued atomically. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const hash = sha256Hex(refreshToken);
    return this.db.withContext({}, async (c) => {
      const res = await c.query<{
        id: string;
        user_id: string;
        tenant_id: string;
        expires_at: string;
        revoked_at: string | null;
      }>(
        // RLS note: refresh flow runs pre-auth; look up via the self_tokens
        // policy by first resolving the user from the token row using a
        // SECURITY-bounded approach: hash is unguessable (256-bit), and the
        // row carries its own user/tenant ids.
        `SELECT id, user_id, tenant_id, expires_at, revoked_at
           FROM refresh_tokens WHERE token_hash = $1`,
        [hash],
      );
      const row = res.rows[0];
      if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
        throw new UnauthorizedException('Invalid refresh token');
      }
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [row.user_id]);
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [row.tenant_id]);

      const roleRes = await c.query<{ name: string }>(
        `SELECT r.name FROM memberships m JOIN roles r ON r.id = m.role_id
          WHERE m.user_id = $1 AND m.tenant_id = $2 AND m.status = 'active'`,
        [row.user_id, row.tenant_id],
      );
      const role = roleRes.rows[0];
      if (!role) throw new UnauthorizedException('Membership not active');

      const newToken = await this.issueRefreshToken(c, row.user_id, row.tenant_id);
      await c.query(
        `UPDATE refresh_tokens SET revoked_at = now(), rotated_to = NULL WHERE id = $1`,
        [row.id],
      );
      return {
        accessToken: this.jwt.signAccess({
          sub: row.user_id,
          ten: row.tenant_id,
          rol: role.name,
        }),
        refreshToken: newToken,
        tenantId: row.tenant_id,
        userId: row.user_id,
        role: role.name,
      };
    });
  }

  async logout(refreshToken: string): Promise<void> {
    const hash = sha256Hex(refreshToken);
    await this.db.withContext({}, async (c) => {
      const res = await c.query<{ user_id: string }>(
        `SELECT user_id FROM refresh_tokens WHERE token_hash = $1`,
        [hash],
      );
      const row = res.rows[0];
      if (!row) return;
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [row.user_id]);
      await c.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`,
        [hash],
      );
    });
  }

  private async issueRefreshToken(
    c: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    userId: string,
    tenantId: string,
  ): Promise<string> {
    const token = randomToken(48);
    const expires = new Date(Date.now() + this.cfg.REFRESH_TOKEN_TTL_SEC * 1000);
    await c.query(
      `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, tenantId, sha256Hex(token), expires.toISOString()],
    );
    return token;
  }
}
