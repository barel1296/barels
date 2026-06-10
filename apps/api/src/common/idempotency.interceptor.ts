import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request } from 'express';
import { from, Observable, of, switchMap, tap } from 'rxjs';
import { DbService } from '../db/db.service';
import { sha256Hex } from './crypto';
import type { RequestWithAuth } from '../auth/auth.types';

/**
 * Honors `Idempotency-Key` on authenticated POSTs (docs/04 §4.3):
 *  - first request: response body is stored under (tenant, key, request hash)
 *  - replay with the same key+payload: the stored response is returned
 *  - same key, DIFFERENT payload: 422 (client bug — never silently re-run)
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly db: DbService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & RequestWithAuth>();
    const key = req.header('idempotency-key');
    if (req.method !== 'POST' || !key || !req.auth) {
      return next.handle();
    }
    if (!/^[\w-]{8,128}$/.test(key)) {
      throw new UnprocessableEntityException('Invalid Idempotency-Key format');
    }
    const auth = req.auth;
    const requestHash = sha256Hex(
      `${req.method} ${req.path} ${JSON.stringify(req.body ?? null)}`,
    );

    return from(
      this.db.queryOne<{ request_hash: string; response_body: unknown }>(
        { tenantId: auth.tenantId, userId: auth.userId },
        `SELECT request_hash, response_body FROM idempotency_keys
          WHERE tenant_id = $1 AND key = $2`,
        [auth.tenantId, key],
      ),
    ).pipe(
      switchMap((existing) => {
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new UnprocessableEntityException(
              'Idempotency-Key was already used with a different payload',
            );
          }
          return of(existing.response_body);
        }
        return next.handle().pipe(
          tap((body) => {
            void this.db
              .query(
                { tenantId: auth.tenantId, userId: auth.userId },
                `INSERT INTO idempotency_keys (tenant_id, key, request_hash, response_body, status_code)
                 VALUES ($1, $2, $3, $4, 200)
                 ON CONFLICT (tenant_id, key) DO NOTHING`,
                [auth.tenantId, key, requestHash, JSON.stringify(body ?? null)],
              )
              .catch(() => undefined);
          }),
        );
      }),
    );
  }
}
