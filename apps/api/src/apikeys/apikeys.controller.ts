import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AuditService } from '../audit/audit.service';
import { randomToken, sha256Hex } from '../common/crypto';
import type { AuthContext } from '../auth/auth.types';

const createKeySchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(['ingest', 'metrics:read'])).min(1),
});

@Controller('v1/api-keys')
export class ApiKeysController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('apikeys:manage')
  async list(@CurrentAuth() auth: AuthContext) {
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT id, name, key_prefix, scopes, expires_at, last_used_at, revoked_at, created_at
         FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [auth.tenantId],
    );
    return { items: rows };
  }

  @Post()
  @RequirePermission('apikeys:manage')
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createKeySchema)) body: z.infer<typeof createKeySchema>,
  ) {
    const secret = `gros_${randomToken(32)}`;
    const row = await this.db.queryOne<{ id: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [auth.tenantId, body.name, sha256Hex(secret), secret.slice(0, 12), body.scopes],
    );
    await this.audit.write(auth, {
      event: 'apikey.created',
      objectType: 'api_key',
      objectId: row!.id,
      after: { name: body.name, scopes: body.scopes },
    });
    // The secret is shown exactly once and never stored in plaintext.
    return { id: row!.id, secret };
  }

  @Delete(':id')
  @RequirePermission('apikeys:manage')
  async revoke(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    const row = await this.db.queryOne<{ id: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `UPDATE api_keys SET revoked_at = now()
        WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL RETURNING id`,
      [id, auth.tenantId],
    );
    if (!row) throw new NotFoundException();
    await this.audit.write(auth, {
      event: 'apikey.revoked',
      objectType: 'api_key',
      objectId: id,
    });
    return { ok: true };
  }
}
