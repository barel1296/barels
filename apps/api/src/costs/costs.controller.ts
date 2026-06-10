import { Body, Controller, Get, Put } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.types';

const budgetSchema = z.object({
  monthlyUsd: z.number().min(0).max(100000),
  hardStop: z.boolean(),
  softAlertRatio: z.number().min(0.1).max(1),
});

@Controller('v1/costs')
export class CostsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get('llm')
  @RequirePermission('costs:read')
  async ledger(@CurrentAuth() auth: AuthContext) {
    const byAgent = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT coalesce(agent, 'unattributed') AS agent, model,
              sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out,
              sum(cost_usd) AS cost_usd, count(*) AS calls
         FROM llm_cost_ledger
        WHERE tenant_id = $1 AND at >= date_trunc('month', now())
        GROUP BY 1, 2 ORDER BY cost_usd DESC`,
      [auth.tenantId],
    );
    const daily = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT date_trunc('day', at)::date AS day, sum(cost_usd) AS cost_usd
         FROM llm_cost_ledger
        WHERE tenant_id = $1 AND at >= now() - interval '30 days'
        GROUP BY 1 ORDER BY 1`,
      [auth.tenantId],
    );
    return { byAgent, daily };
  }

  @Get('budget')
  @RequirePermission('costs:read')
  async budget(@CurrentAuth() auth: AuthContext) {
    const budget = await this.db.queryOne(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT monthly_usd, hard_stop, soft_alert_ratio FROM cost_budgets WHERE tenant_id = $1`,
      [auth.tenantId],
    );
    const spent = await this.db.queryOne<{ spent: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT coalesce(sum(cost_usd), 0) AS spent FROM llm_cost_ledger
        WHERE tenant_id = $1 AND at >= date_trunc('month', now())`,
      [auth.tenantId],
    );
    return { ...budget, spentThisMonthUsd: Number(spent?.spent ?? 0) };
  }

  @Put('budget')
  @RequirePermission('tenant:manage')
  async setBudget(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(budgetSchema)) body: z.infer<typeof budgetSchema>,
  ) {
    await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `INSERT INTO cost_budgets (tenant_id, monthly_usd, hard_stop, soft_alert_ratio, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id)
       DO UPDATE SET monthly_usd = $2, hard_stop = $3, soft_alert_ratio = $4, updated_at = now()`,
      [auth.tenantId, body.monthlyUsd, body.hardStop, body.softAlertRatio],
    );
    await this.audit.write(auth, {
      event: 'cost_budget.updated',
      objectType: 'cost_budget',
      objectId: auth.tenantId,
      after: body,
    });
    return { ok: true };
  }
}
