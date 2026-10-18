import { setTimeout as sleep } from 'node:timers/promises';
import { JobRunner } from './modules/jobs-queue.js';
import { sampleGpu } from './modules/monitoring.js';
import { dispatchOutbox } from './modules/outbox.js';
import { runDuePeriodic } from './modules/periodic.js';
import { publisherTick } from './modules/publishing.js';
import { buildRegistry, type Registry } from './registry.js';
import { dispatchTick } from './modules/visual/dispatcher.js';
import { refreshEngineHealth, type EngineRow } from './modules/visual/engines.js';
import { ingestRecoveryTick, pollTick } from './modules/visual/poller.js';
import type { Services } from './services.js';

export async function engineHealthTick(svc: Services): Promise<void> {
  const { rows } = await svc.workerPool.query<EngineRow>(`SELECT * FROM inference.visual_engines WHERE status = 'active'`);
  for (const engine of rows) await refreshEngineHealth(svc.workerPool, svc.engineClients, engine);
}

export function jobRunnerFor(svc: Services, registry: Registry, lanes: { queues?: string[]; excludeQueues?: string[]; concurrency?: number } = {}): JobRunner {
  return new JobRunner(svc.workerPool, registry.handlers, {
    workerId: svc.config.worker.workerId,
    leaseSeconds: Math.max(svc.config.worker.leaseSeconds, 120),
    concurrency: lanes.concurrency ?? svc.config.jobConcurrency,
    ...(lanes.queues ? { queues: lanes.queues } : {}),
    ...(lanes.excludeQueues ? { excludeQueues: lanes.excludeQueues } : {}),
  });
}

/** Queues with their own runner, so payment integrity never waits behind LLM or maintenance work. */
export const DEDICATED_QUEUES = ['payments', 'conversation'] as const;

/**
 * One full pass of every background step, in dependency order (used by tests and
 * `cli worker:once`). Periodic tasks run only when `periodic` is true.
 */
export async function runWorkerOnce(svc: Services, opts: { registry?: Registry; periodic?: boolean } = {}): Promise<void> {
  const registry = opts.registry ?? buildRegistry(svc);
  await dispatchTick(svc);
  await pollTick(svc);
  await ingestRecoveryTick(svc);
  await publisherTick(svc);
  for (const l of registry.loops) await (l.once ?? l.run)();
  await dispatchOutbox(svc.workerPool, registry.subscriptions);
  await jobRunnerFor(svc, registry).runOnce();
  if (opts.periodic) await runDuePeriodic(svc.workerPool, registry.periodic);
}

/**
 * Background worker loops (single process on the workstation). Each loop is
 * isolated: an error in one tick is logged and the loop continues.
 */
export class Worker {
  private running = false;
  private loops: Promise<void>[] = [];
  private readonly registry: Registry;

  constructor(private readonly svc: Services) {
    this.registry = buildRegistry(svc);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const w = this.svc.config.worker;
    this.loops = [
      this.loop('engine-health', w.engineHealthIntervalMs, () => engineHealthTick(this.svc)),
      this.loop('dispatch', w.dispatchIntervalMs, () => dispatchTick(this.svc)),
      this.loop('poll', w.pollIntervalMs, () => pollTick(this.svc)),
      this.loop('ingest-recovery', w.pollIntervalMs * 5, () => ingestRecoveryTick(this.svc)),
      this.loop('publish', w.publishIntervalMs, () => publisherTick(this.svc)),
      this.loop('outbox', 500, () => dispatchOutbox(this.svc.workerPool, this.registry.subscriptions)),
      this.loop('jobs:payments', 100, () => jobRunnerFor(this.svc, this.registry, { queues: ['payments'], concurrency: 2 }).runOnce()),
      this.loop('jobs:conversation', 200, () => jobRunnerFor(this.svc, this.registry, { queues: ['conversation'] }).runOnce()),
      this.loop('jobs', 250, () => jobRunnerFor(this.svc, this.registry, { excludeQueues: [...DEDICATED_QUEUES] }).runOnce()),
      this.loop('periodic', 5_000, () => runDuePeriodic(this.svc.workerPool, this.registry.periodic)),
      this.loop('gpu-monitor', this.svc.config.monitoring.gpuSampleIntervalMs, () => sampleGpu(this.svc)),
      ...this.registry.loops.map((l) => this.loop(l.name, l.intervalMs, l.run)),
    ];
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.registry.loops.map((l) => l.stop?.() ?? Promise.resolve()));
    await Promise.allSettled(this.loops);
  }

  private async loop(name: string, intervalMs: number, tick: () => Promise<unknown>): Promise<void> {
    while (this.running) {
      try {
        await tick();
      } catch (err) {
        console.error(`[worker:${name}] ${(err as Error).stack ?? err}`);
      }
      const until = Date.now() + intervalMs;
      while (this.running && Date.now() < until) await sleep(Math.min(100, intervalMs));
    }
  }
}
