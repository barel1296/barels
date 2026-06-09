import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { ZodValidationPipe } from '../common/zod.pipe';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { AuditService } from '../audit/audit.service';
import { encryptSecret } from '../common/crypto';
import { loadConfig } from '../config/config';
import type { AuthContext } from '../auth/auth.types';

const createIntegrationSchema = z.object({
  sourceKey: z.string().min(1),
  name: z.string().min(1).max(120),
  externalAccountId: z.string().max(120).optional(),
  /**
   * Credentials are accepted only to be envelope-encrypted at rest; they are
   * never returned by any endpoint. Live connector sync is a roadmap Phase-1
   * item (docs/dev/known-gaps.md) — integrations register and store config
   * but no external API is called from this build.
   */
  credentials: z.record(z.string()).optional(),
  config: z.record(z.unknown()).default({}),
});

const patchIntegrationSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(['paused', 'pending']).optional(),
  config: z.record(z.unknown()).optional(),
});

@Controller('v1')
export class IntegrationsController {
  private readonly cfg = loadConfig();

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get('data-sources')
  @RequirePermission('metrics:read')
  async dataSources(@CurrentAuth() auth: AuthContext) {
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT key, category, display_name, capabilities, min_sync_interval_min
         FROM data_sources ORDER BY display_name`,
    );
    return { items: rows };
  }

  @Get('integrations')
  @RequirePermission('metrics:read')
  async list(@CurrentAuth() auth: AuthContext) {
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT i.id, i.source_key, i.name, i.external_account_id, i.scopes_granted,
              i.status, i.health, i.config, i.created_at,
              (SELECT row_to_json(s) FROM (
                 SELECT status, kind, rows_ingested, started_at, finished_at
                   FROM sync_runs WHERE integration_id = i.id
                  ORDER BY started_at DESC LIMIT 1) s) AS last_sync
         FROM integrations i
        WHERE i.tenant_id = $1
        ORDER BY i.created_at`,
      [auth.tenantId],
    );
    return { items: rows };
  }

  @Post('integrations')
  @RequirePermission('integrations:manage')
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createIntegrationSchema))
    body: z.infer<typeof createIntegrationSchema>,
  ) {
    const source = await this.db.queryOne<{ key: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT key FROM data_sources WHERE key = $1`,
      [body.sourceKey],
    );
    if (!source) throw new NotFoundException(`Unknown data source: ${body.sourceKey}`);

    const credentialsEnc = body.credentials
      ? encryptSecret(JSON.stringify(body.credentials), this.cfg.CREDENTIALS_MASTER_KEY)
      : null;

    const row = await this.db.queryOne<{ id: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `INSERT INTO integrations
         (tenant_id, source_key, name, external_account_id, credentials_enc, config, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id`,
      [
        auth.tenantId,
        body.sourceKey,
        body.name,
        body.externalAccountId ?? null,
        credentialsEnc,
        JSON.stringify(body.config),
      ],
    );
    await this.audit.write(auth, {
      event: 'integration.created',
      objectType: 'integration',
      objectId: row!.id,
      after: { sourceKey: body.sourceKey, name: body.name },
    });
    return { id: row!.id };
  }

  @Patch('integrations/:id')
  @RequirePermission('integrations:manage')
  async patch(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(patchIntegrationSchema))
    body: z.infer<typeof patchIntegrationSchema>,
  ) {
    const updated = await this.db.queryOne<{ id: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `UPDATE integrations SET
         name = COALESCE($3, name),
         status = COALESCE($4, status),
         config = COALESCE($5, config),
         updated_at = now()
       WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [id, auth.tenantId, body.name ?? null, body.status ?? null,
       body.config ? JSON.stringify(body.config) : null],
    );
    if (!updated) throw new NotFoundException();
    await this.audit.write(auth, {
      event: 'integration.updated',
      objectType: 'integration',
      objectId: id,
      after: body,
    });
    return { ok: true };
  }

  @Delete('integrations/:id')
  @RequirePermission('integrations:manage')
  async remove(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    const removed = await this.db.queryOne<{ id: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `UPDATE integrations SET status = 'broken', credentials_enc = NULL, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [id, auth.tenantId],
    );
    if (!removed) throw new NotFoundException();
    await this.audit.write(auth, {
      event: 'integration.revoked',
      objectType: 'integration',
      objectId: id,
    });
    return { ok: true };
  }

  @Get('integrations/:id/sync-runs')
  @RequirePermission('metrics:read')
  async syncRuns(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT id, kind, status, rows_ingested, error, started_at, finished_at
         FROM sync_runs WHERE integration_id = $1 AND tenant_id = $2
        ORDER BY started_at DESC LIMIT 50`,
      [id, auth.tenantId],
    );
    return { items: rows };
  }
}
