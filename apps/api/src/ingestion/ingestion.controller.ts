import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Put,
  Param,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { ClickHouseService } from '../db/clickhouse.service';
import { ZodValidationPipe } from '../common/zod.pipe';
import { CurrentAuth, Public, RequirePermission } from '../auth/decorators';
import { sha256Hex } from '../common/crypto';
import type { AuthContext } from '../auth/auth.types';
import { createHash } from 'node:crypto';

const eventSchema = z.object({
  eventName: z.string().min(1).max(80),
  eventTime: z.string().datetime(),
  userId: z.string().min(1).max(128),
  appId: z.string().uuid(),
  platform: z.enum(['ios', 'android', 'web']).default('android'),
  country: z.string().length(2).default('XX'),
  appVersion: z.string().max(32).default(''),
  revenueUsd: z.number().finite().default(0),
  properties: z.record(z.string()).default({}),
});

const batchSchema = z.object({ events: z.array(eventSchema).min(1).max(1000) });

const taxonomyEntrySchema = z.object({
  description: z.string().default(''),
  category: z.enum(['lifecycle', 'monetization', 'product', 'marketing']).default('product'),
  schema: z.record(z.unknown()).default({}),
  status: z.enum(['active', 'deprecated']).default('active'),
});

function hash64(s: string): string {
  // ClickHouse UInt64 payload hash: first 8 bytes of sha256 as unsigned int.
  const h = createHash('sha256').update(s).digest();
  return (h.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString();
}

@Controller('v1')
export class IngestionController {
  constructor(
    private readonly db: DbService,
    private readonly ch: ClickHouseService,
  ) {}

  /**
   * First-party event ingestion, authenticated by API key (scope: ingest).
   * Unknown events are quarantined (taxonomy violation), never silently
   * dropped and never admitted to the normalized table.
   */
  @Public()
  @Post('ingest/events')
  async ingest(
    @Headers('x-api-key') apiKey: string | undefined,
    @Body(new ZodValidationPipe(batchSchema)) body: z.infer<typeof batchSchema>,
  ) {
    if (!apiKey) throw new UnauthorizedException('Missing X-Api-Key');
    const keyRow = await this.db.withContext({}, async (c) => {
      // Pre-auth lookup by unguessable key hash (api_keys is RLS-exempt by
      // design — see migrations/001). Only active, unexpired keys match.
      const res = await c.query<{ tenant_id: string; scopes: string[] }>(
        `SELECT tenant_id, scopes FROM api_keys
          WHERE key_hash = $1 AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())`,
        [sha256Hex(apiKey)],
      );
      return res.rows[0] ?? null;
    });
    if (!keyRow || !keyRow.scopes.includes('ingest')) {
      throw new UnauthorizedException('Invalid API key');
    }
    const tenantId = keyRow.tenant_id;

    const taxonomy = await this.db.query<{ event_name: string; status: string }>(
      { tenantId },
      `SELECT event_name, status FROM event_taxonomy WHERE tenant_id = $1`,
      [tenantId],
    );
    const known = new Map(taxonomy.map((t) => [t.event_name, t.status]));

    const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const rawRows = body.events.map((e) => ({
      tenant_id: tenantId,
      source: 'firstparty',
      entity_kind: 'event',
      external_id: `${e.userId}:${e.eventTime}:${e.eventName}`,
      payload: JSON.stringify(e),
      payload_hash: hash64(JSON.stringify(e)),
      ingested_at: now,
      sync_run_id: '',
    }));
    await this.ch.insertRows('raw_events', rawRows);

    const accepted: typeof body.events = [];
    const quarantined: { eventName: string; reason: string; sample: unknown }[] = [];
    for (const e of body.events) {
      const status = known.get(e.eventName);
      if (status === 'active') accepted.push(e);
      else {
        quarantined.push({
          eventName: e.eventName,
          reason: status === 'deprecated' ? 'schema_mismatch' : 'unknown_event',
          sample: e,
        });
      }
    }

    if (accepted.length > 0) {
      await this.ch.insertRows(
        'events',
        accepted.map((e) => ({
          tenant_id: tenantId,
          app_id: e.appId,
          event_name: e.eventName,
          event_time: e.eventTime.replace('T', ' ').replace('Z', ''),
          user_id: e.userId,
          platform: e.platform,
          country: e.country,
          app_version: e.appVersion,
          source_install: '',
          campaign_id: '00000000-0000-0000-0000-000000000000',
          revenue_usd: e.revenueUsd,
          properties: e.properties,
          source: 'firstparty',
        })),
      );
    }

    for (const q of quarantined) {
      await this.db.query(
        { tenantId },
        `INSERT INTO taxonomy_violations (tenant_id, event_name, reason, sample)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, event_name, reason)
         DO UPDATE SET count = taxonomy_violations.count + 1, last_seen = now()`,
        [tenantId, q.eventName, q.reason, JSON.stringify(q.sample)],
      );
    }

    return {
      accepted: accepted.length,
      quarantined: quarantined.length,
    };
  }

  @Get('taxonomy')
  @RequirePermission('metrics:read')
  async taxonomy(@CurrentAuth() auth: AuthContext) {
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT event_name, description, category, schema, status, version
         FROM event_taxonomy WHERE tenant_id = $1 ORDER BY event_name`,
      [auth.tenantId],
    );
    return { items: rows };
  }

  @Put('taxonomy/events/:name')
  @RequirePermission('taxonomy:manage')
  async upsertTaxonomy(
    @CurrentAuth() auth: AuthContext,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(taxonomyEntrySchema))
    body: z.infer<typeof taxonomyEntrySchema>,
  ) {
    if (!/^[a-z][a-z0-9_]{1,79}$/.test(name)) {
      throw new BadRequestException('Invalid event name (snake_case required)');
    }
    await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `INSERT INTO event_taxonomy (tenant_id, event_name, description, category, schema, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, event_name)
       DO UPDATE SET description = $3, category = $4, schema = $5, status = $6,
                     version = event_taxonomy.version + 1`,
      [auth.tenantId, name, body.description, body.category, JSON.stringify(body.schema), body.status],
    );
    return { ok: true };
  }

  @Get('taxonomy/violations')
  @RequirePermission('health:read')
  async violations(@CurrentAuth() auth: AuthContext) {
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT event_name, reason, count, first_seen, last_seen
         FROM taxonomy_violations WHERE tenant_id = $1 ORDER BY last_seen DESC`,
      [auth.tenantId],
    );
    return { items: rows };
  }
}
