import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  decomposeRequestSchema,
  metricQueryRequestSchema,
  type DecomposeRequest,
  type MetricQueryRequest,
} from '@gros/shared';
import { MetricsService } from './metrics.service';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import type { AuthContext } from '../auth/auth.types';

@Controller('v1/metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('definitions')
  @RequirePermission('metrics:read')
  async definitions(@CurrentAuth() auth: AuthContext) {
    const defs = await this.metrics.listDefinitions(auth.tenantId);
    return {
      items: defs.map((d) => ({
        key: d.key,
        version: d.version,
        displayName: d.display_name,
        dimensions: d.dimensions,
        grains: d.grains,
        valueFormat: d.value_format,
        caveats: d.caveats,
      })),
    };
  }

  @Post('query')
  @RequirePermission('metrics:read')
  async query(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(metricQueryRequestSchema)) body: MetricQueryRequest,
  ) {
    return this.metrics.query(auth.tenantId, body);
  }

  @Post('decompose')
  @RequirePermission('metrics:read')
  async decompose(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(decomposeRequestSchema)) body: DecomposeRequest,
  ) {
    return this.metrics.decompose(auth.tenantId, body);
  }
}
