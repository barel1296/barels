import type { FastifyInstance } from 'fastify';
import { safeEqual } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { acknowledgeAlert, closeAlert, listAlerts } from '../modules/alerts.js';
import { verifyAuditChain } from '../modules/audit-seal.js';
import { requirePlatformAdmin } from '../modules/context.js';
import { retryJob } from '../modules/jobs-queue.js';
import { healthReport, prometheusMetrics } from '../modules/monitoring.js';
import type { Services } from '../services.js';
import type { Api } from './server.js';

/** Operations endpoints. Platform-level data, so platform administrators only. */
export function registerOpsRoutes(app: FastifyInstance, svc: Services, _api: Api): void {
  // Readiness probe: component statuses only, no details (public, for local service managers).
  app.get('/readyz', { config: { public: true } }, async (_req, reply) => {
    const r = await healthReport(svc);
    const summary = Object.fromEntries(Object.entries(r.components).map(([k, v]) => [k, v.status]));
    return reply.status(r.status === 'down' ? 503 : 200).send({ status: r.status, components: summary });
  });

  // Prometheus scrape endpoint; disabled unless METRICS_TOKEN is set.
  app.get('/metrics', { config: { public: true } }, async (req, reply) => {
    const token = svc.config.monitoring.metricsToken;
    if (!token) throw new AppError(404, 'NOT_FOUND', 'metrics disabled');
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), token)) throw new AppError(401, 'UNAUTHORIZED', 'metrics token required');
    return reply.type('text/plain; version=0.0.4').send(await prometheusMetrics(svc));
  });

  app.get('/v1/ops/health', async (req) => {
    requirePlatformAdmin(req.ctx);
    return healthReport(svc);
  });

  app.get<{ Querystring: { status?: 'open' | 'all' } }>('/v1/ops/alerts', async (req) => {
    requirePlatformAdmin(req.ctx);
    return listAlerts(svc.workerPool, req.query.status === 'all' ? 'all' : 'open');
  });

  app.post<{ Params: { id: string } }>('/v1/ops/alerts/:id/ack', async (req) => {
    requirePlatformAdmin(req.ctx);
    if (!(await acknowledgeAlert(svc.workerPool, req.params.id, req.ctx.userId!))) throw notFound('Open alert', req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/v1/ops/alerts/:id/resolve', async (req) => {
    requirePlatformAdmin(req.ctx);
    if (!(await closeAlert(svc.workerPool, req.params.id))) throw notFound('Alert', req.params.id);
    return { ok: true };
  });

  app.get<{ Querystring: { status?: string; queue?: string } }>('/v1/ops/jobs', async (req) => {
    requirePlatformAdmin(req.ctx);
    const { rows } = await svc.workerPool.query(
      `SELECT id, workspace_id, queue, name, job_key, status, priority, attempts, max_attempts, run_at, last_error, created_at, completed_at
         FROM core.jobs WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR queue = $2)
        ORDER BY created_at DESC LIMIT 200`,
      [req.query.status ?? null, req.query.queue ?? null],
    );
    const summary = await svc.workerPool.query(`SELECT queue, status, count(*)::int AS n FROM core.jobs GROUP BY queue, status ORDER BY queue, status`);
    return { summary: summary.rows, jobs: rows };
  });

  app.post<{ Params: { id: string } }>('/v1/ops/jobs/:id/retry', async (req) => {
    requirePlatformAdmin(req.ctx);
    if (!(await retryJob(svc.workerPool, req.params.id))) throw notFound('Dead job', req.params.id);
    return { ok: true };
  });

  app.get('/v1/ops/periodic', async (req) => {
    requirePlatformAdmin(req.ctx);
    const { rows } = await svc.workerPool.query('SELECT * FROM core.periodic_tasks ORDER BY name');
    return rows;
  });

  app.get<{ Querystring: { minutes?: string } }>('/v1/ops/gpu', async (req) => {
    requirePlatformAdmin(req.ctx);
    const minutes = Math.min(Math.max(Number(req.query.minutes ?? 60) || 60, 1), 24 * 60);
    const { rows } = await svc.workerPool.query(
      `SELECT node, gpu_index, gpu_name, captured_at, util_pct, vram_used_mb, vram_total_mb, temp_c, power_w, source
         FROM ops.gpu_samples WHERE captured_at > now() - make_interval(mins => $1) ORDER BY captured_at`,
      [minutes],
    );
    return { minutes, samples: rows, monitor_enabled: svc.config.monitoring.gpuMonitorEnabled };
  });

  app.get('/v1/ops/backups', async (req) => {
    requirePlatformAdmin(req.ctx);
    const { rows } = await svc.workerPool.query('SELECT * FROM ops.backup_runs ORDER BY started_at DESC LIMIT 50');
    return rows;
  });

  app.post('/v1/ops/audit/verify', async (req) => {
    requirePlatformAdmin(req.ctx);
    return verifyAuditChain(svc.workerPool);
  });
}
