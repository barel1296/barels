import {
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import type { AuthContext, RequestWithAuth } from './auth.types';

export const IS_PUBLIC_KEY = 'gros:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSION_KEY = 'gros:permission';
export const RequirePermission = (permission: string) =>
  SetMetadata(PERMISSION_KEY, permission);

export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<RequestWithAuth>();
    if (!req.auth) throw new Error('CurrentAuth used on unauthenticated route');
    return req.auth;
  },
);
