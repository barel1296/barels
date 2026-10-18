import { sealAuditLog } from './modules/audit-seal.js';
import type { JobHandler } from './modules/jobs-queue.js';
import { evaluateAlertRules, sampleEngineResources } from './modules/monitoring.js';
import type { EventSubscription } from './modules/outbox.js';
import type { PeriodicTask } from './modules/periodic.js';
import type { Services } from './services.js';
import { contributions } from './wiring.js';

/**
 * Central wiring of background work: job handlers (core.jobs), outbox event
 * subscriptions and periodic tasks. Feature modules export a `Contribution`
 * listed in wiring.ts, so the worker has a single source of truth.
 */
export interface Registry {
  handlers: Map<string, JobHandler>;
  subscriptions: EventSubscription[];
  periodic: PeriodicTask[];
  /** Long-running worker loops contributed by integrations (e.g. Telegram long polling). */
  loops: WorkerLoop[];
}

export interface WorkerLoop {
  name: string;
  intervalMs: number;
  /** One tick of the production loop. */
  run: () => Promise<unknown>;
  /** A bounded, non-blocking pass for `runWorkerOnce` (tests, `cli worker:once`); defaults to `run`. */
  once?: () => Promise<unknown>;
  /** Called when the worker stops. */
  stop?: () => Promise<void>;
}

export type Contribution = (svc: Services, r: Registry) => void;

function core(svc: Services, r: Registry): void {
  r.periodic.push(
    { name: 'audit.seal', intervalSeconds: 3600, run: () => sealAuditLog(svc.workerPool, svc.config.monitoring.auditExportDir) },
    { name: 'ops.alert_rules', intervalSeconds: 300, run: () => evaluateAlertRules(svc) },
    { name: 'ops.engine_resources', intervalSeconds: 60, run: () => sampleEngineResources(svc) },
    {
      name: 'ops.retention',
      intervalSeconds: 86_400,
      run: async () => {
        const jobs = await svc.workerPool.query(`DELETE FROM core.jobs WHERE status IN ('succeeded', 'cancelled') AND completed_at < now() - interval '14 days'`);
        const gpu = await svc.workerPool.query(`DELETE FROM ops.gpu_samples WHERE captured_at < now() - interval '30 days'`);
        return { jobs_deleted: jobs.rowCount, gpu_samples_deleted: gpu.rowCount };
      },
    },
  );
}

export function buildRegistry(svc: Services): Registry {
  const r: Registry = { handlers: new Map(), subscriptions: [], periodic: [], loops: [] };
  core(svc, r);
  for (const c of contributions) c(svc, r);
  return r;
}
