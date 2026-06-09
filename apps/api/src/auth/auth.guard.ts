import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DbService } from '../db/db.service';
import { loadConfig } from '../config/config';
import { JwtTokenService } from './jwt.service';
import { IS_PUBLIC_KEY } from './decorators';
import {
  SERVICE_PERMISSIONS,
  type AuthContext,
  type RequestWithAuth,
} from './auth.types';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly cfg = loadConfig();

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtTokenService,
    private readonly db: DbService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & RequestWithAuth>();

    // 1. Internal service token (worker plane).
    const serviceToken = req.header('x-service-token');
    if (serviceToken) {
      if (serviceToken !== this.cfg.SERVICE_TOKEN) {
        throw new UnauthorizedException('Invalid service token');
      }
      const tenantId = req.header('x-tenant-id');
      if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) {
        throw new UnauthorizedException('Service calls require X-Tenant-Id');
      }
      req.auth = {
        kind: 'service',
        userId: 'service:worker',
        tenantId,
        roleName: 'service',
        permissions: new Set<string>(SERVICE_PERMISSIONS),
      };
      return true;
    }

    // 2. Bearer JWT (header or httpOnly cookie set by login).
    const header = req.header('authorization');
    const cookieToken = parseCookies(req.header('cookie'))['gros_access'];
    const token = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : cookieToken;
    if (!token) throw new UnauthorizedException('Missing credentials');

    const payload = this.jwt.verifyAccess(token);
    const permissions = await this.loadPermissions(payload.sub, payload.ten);
    if (permissions === null) {
      throw new UnauthorizedException('Membership not active');
    }
    const auth: AuthContext = {
      kind: 'user',
      userId: payload.sub,
      tenantId: payload.ten,
      roleName: payload.rol,
      permissions,
    };
    req.auth = auth;
    return true;
  }

  private async loadPermissions(
    userId: string,
    tenantId: string,
  ): Promise<Set<string> | null> {
    const rows = await this.db.query<{ permission_key: string }>(
      { tenantId, userId },
      `SELECT rp.permission_key
         FROM memberships m
         JOIN role_permissions rp ON rp.role_id = m.role_id
        WHERE m.user_id = $1 AND m.tenant_id = $2 AND m.status = 'active'`,
      [userId, tenantId],
    );
    if (rows.length === 0) {
      const member = await this.db.queryOne(
        { tenantId, userId },
        `SELECT 1 AS ok FROM memberships
          WHERE user_id = $1 AND tenant_id = $2 AND status = 'active'`,
        [userId, tenantId],
      );
      if (!member) return null;
    }
    return new Set(rows.map((r) => r.permission_key));
  }
}
