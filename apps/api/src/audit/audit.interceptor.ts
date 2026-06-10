import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { AuditService } from './audit.service';
import type { RequestWithAuth } from '../auth/auth.types';

/**
 * Writes an audit record for every authenticated mutating request.
 * Controllers/services can refine the event via req.auditEvent/auditObject;
 * otherwise a generic "<METHOD> <path>" event is recorded. Failures to audit
 * are logged loudly but do not mask the original response (the DB-level
 * append-only audit of domain tables is the second line).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Audit');

  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & RequestWithAuth>();
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    return next.handle().pipe(
      tap(() => {
        if (!mutating || !req.auth) return;
        const route = (req.route as { path?: string } | undefined)?.path ?? req.path;
        void this.audit
          .write(req.auth, {
            event: req.auditEvent ?? `${req.method} ${route}`,
            objectType: req.auditObject?.type ?? 'http_request',
            objectId: req.auditObject?.id ?? route,
            before: req.auditObject?.before,
            after: req.auditObject?.after,
            ip: req.ip,
            userAgent: req.header('user-agent'),
          })
          .catch((err: unknown) =>
            this.logger.error(`audit write failed: ${String(err)}`),
          );
      }),
    );
  }
}
