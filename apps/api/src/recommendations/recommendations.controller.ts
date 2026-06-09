import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { REJECTION_REASON_CODES } from '@gros/shared';
import { DbService } from '../db/db.service';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.types';

const dismissSchema = z.object({
  reasonCode: z.enum(REJECTION_REASON_CODES),
  note: z.string().max(1000).optional(),
});

@Controller('v1/recommendations')
export class RecommendationsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('recs:read')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query('status') status?: string,
    @Query('category') category?: string,
  ) {
    const conds = ['tenant_id = $1'];
    const params: unknown[] = [auth.tenantId];
    if (status) {
      params.push(status);
      conds.push(`status = $${params.length}`);
    }
    if (category) {
      params.push(category);
      conds.push(`category = $${params.length}`);
    }
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT id, session_id, playbook_key, title, summary, category, confidence,
              predicted_impact, status, expires_at, created_at
         FROM recommendations
        WHERE ${conds.join(' AND ')}
        ORDER BY created_at DESC LIMIT 100`,
      params,
    );
    return { items: rows };
  }

  @Get('stats')
  @RequirePermission('recs:read')
  async stats(@CurrentAuth() auth: AuthContext) {
    const rows = await this.db.query<{
      playbook_key: string | null;
      total: string;
      approved: string;
      rejected: string;
      avg_confidence: string | null;
    }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT playbook_key,
              count(*) AS total,
              count(*) FILTER (WHERE status = 'approved') AS approved,
              count(*) FILTER (WHERE status IN ('rejected', 'dismissed')) AS rejected,
              avg(confidence) AS avg_confidence
         FROM recommendations
        WHERE tenant_id = $1
        GROUP BY playbook_key`,
      [auth.tenantId],
    );
    return { items: rows };
  }

  @Get(':id')
  @RequirePermission('recs:read')
  async get(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    const rec = await this.db.queryOne(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT r.*,
         (SELECT json_agg(json_build_object(
            'id', e.id, 'kind', e.kind, 'metricKey', e.metric_key,
            'params', e.params, 'resultDigest', e.result_digest,
            'executedAt', e.executed_at))
           FROM evidence e WHERE e.id = ANY (r.evidence_ids)) AS evidence,
         (SELECT json_agg(json_build_object(
            'id', a.id, 'kind', a.kind, 'status', a.status, 'diff', a.diff,
            'diffHash', a.diff_hash) ORDER BY a.created_at)
           FROM actions a WHERE a.recommendation_id = r.id) AS actions
         FROM recommendations r
        WHERE r.id = $1 AND r.tenant_id = $2`,
      [id, auth.tenantId],
    );
    if (!rec) throw new NotFoundException();
    return rec;
  }

  @Post(':id/dismiss')
  @RequirePermission('recs:manage')
  async dismiss(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(dismissSchema)) body: z.infer<typeof dismissSchema>,
  ) {
    const updated = await this.db.queryOne<{ id: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `UPDATE recommendations
          SET status = 'dismissed',
              rejection = $3,
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status = 'proposed'
        RETURNING id`,
      [id, auth.tenantId, JSON.stringify({ ...body, by: auth.userId })],
    );
    if (!updated) throw new NotFoundException('Recommendation not found or not dismissible');
    await this.audit.write(auth, {
      event: 'recommendation.dismissed',
      objectType: 'recommendation',
      objectId: id,
      after: body,
    });
    return { ok: true };
  }
}
