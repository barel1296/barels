import { setTimeout as sleep } from 'node:timers/promises';
import { publisherTick } from './modules/publishing.js';
import { dispatchTick } from './modules/visual/dispatcher.js';
import { refreshEngineHealth, type EngineRow } from './modules/visual/engines.js';
import { ingestRecoveryTick, pollTick } from './modules/visual/poller.js';
import type { Services } from './services.js';

export async function engineHealthTick(svc: Services): Promise<void> {
  const { rows } = await svc.workerPool.query<EngineRow>(`SELECT * FROM inference.visual_engines WHERE status = 'active'`);
  for (const engine of rows) await refreshEngineHealth(svc.workerPool, svc.engineClients, engine);
}

/** One full pass of every background step, in dependency order (used by tests and `cli worker:once`). */
export async function runWorkerOnce(svc: Services): Promise<void> {
  await dispatchTick(svc);
  await pollTick(svc);
  await ingestRecoveryTick(svc);
  await publisherTick(svc);
}

/**
 * Background worker loops (single process on the workstation). Each loop is
 * isolated: an error in one tick is logged and the loop continues.
 */
export class Worker {
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(private readonly svc: Services) {}

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
    ];
  }

  async stop(): Promise<void> {
    this.running = false;
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
