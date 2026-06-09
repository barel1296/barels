import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { REJECTION_REASON_CODES } from '@gros/shared';
import { ActionsService } from './actions.service';
import { DbService } from '../db/db.service';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.types';

const approveSchema = z.object({
  confirmDiffHash: z.string().min(16),
});

const rejectSchema = z.object({
  reasonCode: z.enum(REJECTION_REASON_CODES),
  note: z.string().max(1000).optional(),
});

const policySchema = z.object({
  rules: z.object({
    requiredPermission: z.string().optional(),
    maxMagnitudeUsd: z.number().nullable().optional(),
    twoPersonAboveUsd: z.number().nullable().optional(),
    expiryHours: z.number().int().min(1).max(720).optional(),
  }),
  // L2 is the ceiling in this build: the execution layer is not wired, so
  // higher levels are rejected at the API boundary, not just unused.
  autonomyLevel: z.literal(2),
});

@Controller('v1')
export class ActionsController {
  constructor(
    private readonly actions: ActionsService,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get('actions')
  @RequirePermission('actions:read')
  async list(@CurrentAuth() auth: AuthContext, @Query('status') status?: string) {
    return { items: await this.actions.list(auth, status) };
  }

  @Get('actions/:id')
  @RequirePermission('actions:read')
  async get(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    return this.actions.get(auth, id);
  }

  @Post('actions/:id/approve')
  @HttpCode(200)
  @RequirePermission('actions:read') // per-kind approve permission checked in service
  async approve(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(approveSchema)) body: z.infer<typeof approveSchema>,
  ) {
    return this.actions.approve(auth, id, body.confirmDiffHash);
  }

  @Post('actions/:id/reject')
  @HttpCode(200)
  @RequirePermission('actions:read')
  async reject(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectSchema)) body: z.infer<typeof rejectSchema>,
  ) {
    await this.actions.reject(auth, id, body.reasonCode, body.note);
    return { ok: true };
  }

  @Get('approval-policies')
  @RequirePermission('actions:read')
  async policies(@CurrentAuth() auth: AuthContext) {
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT action_kind, rules, autonomy_level, updated_at
         FROM approval_policies WHERE tenant_id = $1 ORDER BY action_kind`,
      [auth.tenantId],
    );
    return { items: rows };
  }

  @Put('approval-policies/:kind')
  @RequirePermission('policies:manage')
  async updatePolicy(
    @CurrentAuth() auth: AuthContext,
    @Param('kind') kind: string,
    @Body(new ZodValidationPipe(policySchema)) body: z.infer<typeof policySchema>,
  ) {
    await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `UPDATE approval_policies
          SET rules = $3, autonomy_level = $4, updated_at = now()
        WHERE tenant_id = $1 AND action_kind = $2`,
      [auth.tenantId, kind, JSON.stringify(body.rules), body.autonomyLevel],
    );
    await this.audit.write(auth, {
      event: 'policy.updated',
      objectType: 'approval_policy',
      objectId: kind,
      after: body,
    });
    return { ok: true };
  }

  @Get('guardrails')
  @RequirePermission('actions:read')
  async guardrails(@CurrentAuth() auth: AuthContext) {
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT key, description, params, enabled, updated_at
         FROM guardrail_policies WHERE tenant_id = $1 ORDER BY key`,
      [auth.tenantId],
    );
    return { items: rows };
  }
}
