import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from './audit.service';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import type { AuthContext } from '../auth/auth.types';

@Controller('v1/audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit:read')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query('event') event?: string,
    @Query('objectType') objectType?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200);
    const rows = await this.audit.list(auth, { event, objectType, before, limit: n });
    return { items: rows };
  }
}
