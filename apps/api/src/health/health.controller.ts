import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { CurrentAuth, Public, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.types';

const overrideSchema = z.object({
  domain: z.enum(['attribution', 'spend', 'revenue', 'events', 'skan']),
  status: z.enum(['green', 'yellow', 'red']),
  reason: z.string().min(5),
});

const declareSchema = z.object({
  domain: z.enum(['attribution', 'spend', 'revenue', 'events', 'skan']),
  status: z.enum(['green', 'yellow', 'red']),
  reasons: z.array(z.record(z.unknown())).default([]),
});

@Controller()
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Liveness probe (no auth, no tenant data). */
  @Public()
  @Get('healthz')
  healthz() {
    return { status: 'ok', service: 'gros-api' };
  }

  @Get('v1/health/status')
  @RequirePermission('health:read')
  async status(@CurrentAuth() auth: AuthContext) {
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT domain, status, reasons, declared_by, declared_at
         FROM health_status WHERE tenant_id = $1 ORDER BY domain`,
      [auth.tenantId],
    );
    return { items: rows };
  }

  @Get('v1/health/checks')
  @RequirePermission('health:read')
  async checks(
    @CurrentAuth() auth: AuthContext,
    @Query('domain') domain?: string,
    @Query('status') status?: string,
  ) {
    const conds = ['tenant_id = $1'];
    const params: unknown[] = [auth.tenantId];
    if (domain) {
      params.push(domain);
      conds.push(`domain = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conds.push(`status = $${params.length}`);
    }
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT id, check_key, domain, scope, status, observed, threshold, run_at
         FROM data_quality_checks WHERE ${conds.join(' AND ')}
        ORDER BY run_at DESC LIMIT 100`,
      params,
    );
    return { items: rows };
  }

  /** Tracking Agent (service auth) declares domain health. */
  @Post('v1/health/declare')
  @RequirePermission('health:manage')
  async declare(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(declareSchema)) body: z.infer<typeof declareSchema>,
  ) {
    await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `INSERT INTO health_status (tenant_id, domain, status, reasons, declared_by, declared_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (tenant_id, domain)
       DO UPDATE SET status = $3, reasons = $4, declared_by = $5, declared_at = now()`,
      [
        auth.tenantId,
        body.domain,
        body.status,
        JSON.stringify(body.reasons),
        auth.kind === 'service' ? 'tracking_agent' : auth.userId,
      ],
    );
    await this.audit.write(auth, {
      event: 'health.declared',
      objectType: 'health_status',
      objectId: body.domain,
      after: { status: body.status },
    });
    return { ok: true };
  }

  /** Human override of a health gate — always logged with a reason. */
  @Post('v1/health/override')
  @RequirePermission('health:manage')
  async override(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(overrideSchema)) body: z.infer<typeof overrideSchema>,
  ) {
    await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `INSERT INTO health_status (tenant_id, domain, status, reasons, declared_by, declared_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (tenant_id, domain)
       DO UPDATE SET status = $3, reasons = $4, declared_by = $5, declared_at = now()`,
      [
        auth.tenantId,
        body.domain,
        body.status,
        JSON.stringify([{ override: true, reason: body.reason }]),
        auth.userId,
      ],
    );
    await this.audit.write(auth, {
      event: 'health.overridden',
      objectType: 'health_status',
      objectId: body.domain,
      after: body,
    });
    return { ok: true };
  }
}
