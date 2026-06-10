import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from '../auth/decorators';
import type { RequestWithAuth } from '../auth/auth.types';

/**
 * Declarative permission enforcement: @RequirePermission('actions:read').
 * Runs after AuthGuard. A route without a permission decorator is only
 * reachable authenticated (or @Public, explicitly).
 */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;
    const req = context.switchToHttp().getRequest<RequestWithAuth>();
    if (!req.auth) return false;
    if (!req.auth.permissions.has(required)) {
      throw new ForbiddenException(`Missing permission: ${required}`);
    }
    return true;
  }
}
