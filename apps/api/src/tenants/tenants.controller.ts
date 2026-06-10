import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { randomToken } from '../common/crypto';
import { hashPassword } from '../auth/passwords';

const updateTenantSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  settings: z.record(z.unknown()).optional(),
});

const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  role: z.enum(['admin', 'approver', 'analyst', 'viewer']),
});

const changeRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'approver', 'analyst', 'viewer']),
});

@Controller('v1/tenant')
export class TenantsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async get(@CurrentAuth() auth: AuthContext) {
    const tenant = await this.db.queryOne(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT id, name, slug, plan, status, settings, llm_budget_usd_month, created_at
         FROM tenants WHERE id = $1`,
      [auth.tenantId],
    );
    if (!tenant) throw new NotFoundException();
    return tenant;
  }

  @Patch()
  @RequirePermission('tenant:manage')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateTenantSchema))
    body: z.infer<typeof updateTenantSchema>,
  ) {
    const tenant = await this.db.queryOne(
      { tenantId: auth.tenantId, userId: auth.userId },
      `UPDATE tenants SET
         name = COALESCE($2, name),
         settings = COALESCE($3, settings),
         updated_at = now()
       WHERE id = $1
       RETURNING id, name, slug, plan, settings`,
      [auth.tenantId, body.name ?? null, body.settings ? JSON.stringify(body.settings) : null],
    );
    await this.audit.write(auth, {
      event: 'tenant.updated',
      objectType: 'tenant',
      objectId: auth.tenantId,
      after: body,
    });
    return tenant;
  }

  @Get('members')
  async members(@CurrentAuth() auth: AuthContext) {
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT m.id, m.status, m.created_at, u.email, u.name, r.name AS role
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         JOIN roles r ON r.id = m.role_id
        WHERE m.tenant_id = $1
        ORDER BY m.created_at`,
      [auth.tenantId],
    );
    return { items: rows };
  }

  /**
   * Dev-mode invite: creates the user with a generated temporary password
   * returned once in the response. Production replaces this with an email
   * invitation flow (documented gap, docs/dev/known-gaps.md).
   */
  @Post('members/invite')
  @RequirePermission('members:manage')
  async invite(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(inviteSchema)) body: z.infer<typeof inviteSchema>,
  ) {
    const tempPassword = randomToken(12);
    const passwordHash = await hashPassword(tempPassword);
    const result = await this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (c) => {
        let userId: string;
        const existing = await c.query<{ id: string }>(
          `SELECT id FROM users WHERE email = $1`,
          [body.email],
        );
        if (existing.rows[0]) {
          userId = existing.rows[0].id;
        } else {
          const created = await c.query<{ id: string }>(
            `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
            [body.email, body.name, passwordHash],
          );
          userId = created.rows[0]!.id;
        }
        const role = await c.query<{ id: string }>(
          `SELECT id FROM roles WHERE tenant_id IS NULL AND name = $1`,
          [body.role],
        );
        const membership = await c.query<{ id: string }>(
          `INSERT INTO memberships (tenant_id, user_id, role_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id, status = 'active'
           RETURNING id`,
          [auth.tenantId, userId, role.rows[0]!.id],
        );
        return { membershipId: membership.rows[0]!.id, userId, isNew: !existing.rows[0] };
      },
    );
    await this.audit.write(auth, {
      event: 'member.invited',
      objectType: 'membership',
      objectId: result.membershipId,
      after: { email: body.email, role: body.role },
    });
    return {
      membershipId: result.membershipId,
      ...(result.isNew ? { temporaryPassword: tempPassword } : {}),
    };
  }

  @Patch('members/:id')
  @RequirePermission('members:manage')
  async changeRole(
    @CurrentAuth() auth: AuthContext,
    @Param('id') membershipId: string,
    @Body(new ZodValidationPipe(changeRoleSchema)) body: z.infer<typeof changeRoleSchema>,
  ) {
    const updated = await this.db.queryOne<{ id: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `UPDATE memberships SET role_id = (SELECT id FROM roles WHERE tenant_id IS NULL AND name = $3)
        WHERE id = $1 AND tenant_id = $2
        RETURNING id`,
      [membershipId, auth.tenantId, body.role],
    );
    if (!updated) throw new NotFoundException('Membership not found');
    await this.audit.write(auth, {
      event: 'member.role_changed',
      objectType: 'membership',
      objectId: membershipId,
      after: { role: body.role },
    });
    return { ok: true };
  }
}
