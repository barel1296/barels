import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import type { AuthContext } from '../auth/auth.types';

export interface AuditEntry {
  event: string;
  objectType: string;
  objectId: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  async write(auth: AuthContext, entry: AuditEntry): Promise<void> {
    await this.db.query(
      { tenantId: auth.tenantId, userId: auth.kind === 'user' ? auth.userId : undefined },
      `INSERT INTO audit_logs
         (tenant_id, actor_type, actor_id, event, object_type, object_id,
          before_ref, after_ref, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        auth.tenantId,
        auth.kind === 'user' ? 'user' : auth.kind === 'service' ? 'system' : 'api_key',
        auth.userId,
        entry.event,
        entry.objectType,
        entry.objectId,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.ip ?? null,
        entry.userAgent ?? null,
      ],
    );
  }

  async list(
    auth: AuthContext,
    filters: { event?: string; objectType?: string; limit: number; before?: string },
  ): Promise<Record<string, unknown>[]> {
    const conds: string[] = ['tenant_id = $1'];
    const params: unknown[] = [auth.tenantId];
    if (filters.event) {
      params.push(filters.event);
      conds.push(`event = $${params.length}`);
    }
    if (filters.objectType) {
      params.push(filters.objectType);
      conds.push(`object_type = $${params.length}`);
    }
    if (filters.before) {
      params.push(filters.before);
      conds.push(`at < $${params.length}`);
    }
    params.push(filters.limit);
    return this.db.query(
      { tenantId: auth.tenantId },
      `SELECT id, actor_type, actor_id, event, object_type, object_id,
              before_ref, after_ref, at
         FROM audit_logs
        WHERE ${conds.join(' AND ')}
        ORDER BY at DESC
        LIMIT $${params.length}`,
      params,
    );
  }
}
