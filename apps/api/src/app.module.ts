import {
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { MetricsModule } from './metrics/metrics.module';
import { ProblemDetailsFilter } from './common/problem.filter';
import { AuditInterceptor } from './audit/audit.interceptor';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { requestIdMiddleware } from './common/request-id.middleware';
import { securityHeadersMiddleware } from './common/security-headers.middleware';
import { TenantsController } from './tenants/tenants.controller';
import { IntegrationsController } from './integrations/integrations.controller';
import { IngestionController } from './ingestion/ingestion.controller';
import { HealthController } from './health/health.controller';
import { SessionsController } from './sessions/sessions.controller';
import { RecommendationsController } from './recommendations/recommendations.controller';
import { ActionsController } from './actions/actions.controller';
import { ActionsService } from './actions/actions.service';
import { CostsController } from './costs/costs.controller';
import { DashboardController } from './dashboard/dashboard.controller';
import { ApiKeysController } from './apikeys/apikeys.controller';

@Module({
  imports: [
    DbModule,
    AuditModule,
    AuthModule,
    MetricsModule,
    // Rate limits: a general per-IP ceiling plus a tight burst limiter.
    // Auth endpoints carry stricter @Throttle overrides on the controller.
    ThrottlerModule.forRoot([
      { name: 'burst', ttl: 1_000, limit: 20 },
      { name: 'sustained', ttl: 60_000, limit: 300 },
    ]),
  ],
  controllers: [
    TenantsController,
    IntegrationsController,
    IngestionController,
    HealthController,
    SessionsController,
    RecommendationsController,
    ActionsController,
    CostsController,
    DashboardController,
    ApiKeysController,
  ],
  providers: [
    ActionsService,
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestIdMiddleware, securityHeadersMiddleware).forRoutes('*');
  }
}
