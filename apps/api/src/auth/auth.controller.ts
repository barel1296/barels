import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService, type TokenPair } from './auth.service';
import { Public, CurrentAuth } from './decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.service';
import { loadConfig } from '../config/config';
import type { AuthContext } from './auth.types';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(128),
  name: z.string().min(1).max(120),
  tenantName: z.string().min(1).max(120),
  tenantSlug: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]+$/),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantSlug: z.string().optional(),
});

const refreshSchema = z.object({ refreshToken: z.string().min(10).optional() });

function setAuthCookies(res: Response, pair: TokenPair): void {
  const cfg = loadConfig();
  const secure = cfg.NODE_ENV === 'production';
  res.cookie('gros_access', pair.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: cfg.ACCESS_TOKEN_TTL_SEC * 1000,
    path: '/',
  });
  res.cookie('gros_refresh', pair.refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: cfg.REFRESH_TOKEN_TTL_SEC * 1000,
    path: '/v1/auth',
  });
}

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: DbService,
  ) {}

  @Public()
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: z.infer<typeof registerSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const pair = await this.auth.register(body);
    setAuthCookies(res, pair);
    return { tenantId: pair.tenantId, userId: pair.userId, role: pair.role, accessToken: pair.accessToken };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const pair = await this.auth.login(body.email, body.password, body.tenantSlug);
    setAuthCookies(res, pair);
    return { tenantId: pair.tenantId, userId: pair.userId, role: pair.role, accessToken: pair.accessToken };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: z.infer<typeof refreshSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookieHeader = req.header('cookie') ?? '';
    const fromCookie = /(?:^|;\s*)gros_refresh=([^;]+)/.exec(cookieHeader)?.[1];
    const token = body.refreshToken ?? (fromCookie && decodeURIComponent(fromCookie));
    if (!token) {
      return { error: 'missing refresh token' };
    }
    const pair = await this.auth.refresh(token);
    setAuthCookies(res, pair);
    return { tenantId: pair.tenantId, userId: pair.userId, role: pair.role, accessToken: pair.accessToken };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookieHeader = req.header('cookie') ?? '';
    const fromCookie = /(?:^|;\s*)gros_refresh=([^;]+)/.exec(cookieHeader)?.[1];
    if (fromCookie) await this.auth.logout(decodeURIComponent(fromCookie));
    res.clearCookie('gros_access', { path: '/' });
    res.clearCookie('gros_refresh', { path: '/v1/auth' });
  }

  @Get('me')
  async me(@CurrentAuth() auth: AuthContext) {
    const user = await this.db.queryOne<{ id: string; email: string; name: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT id, email, name FROM users WHERE id = $1`,
      [auth.userId],
    );
    const tenant = await this.db.queryOne<{ id: string; name: string; slug: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT id, name, slug FROM tenants WHERE id = $1`,
      [auth.tenantId],
    );
    return {
      user,
      tenant,
      role: auth.roleName,
      permissions: [...auth.permissions].sort(),
    };
  }
}
