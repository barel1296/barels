/**
 * Small pool of terrain workers with a synchronous main-thread fallback
 * (used when module workers are unavailable, e.g. some file:// contexts).
 */
import { TerrainGenerator, generateHeightmap, type ChunkData, type ChunkRequest } from './terrainGen';

type Msg = { type: string; id: number; [k: string]: unknown };
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; msg: Msg };

export class TerrainWorkerPool {
  private workers: Worker[] = [];
  private busy: number[] = [];
  private pending = new Map<number, Pending>();
  private queue: { msg: Msg }[] = [];
  private nextId = 1;
  private fallback: TerrainGenerator | null = null;

  constructor(seed: number, count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
    try {
      for (let k = 0; k < count; k++) {
        const w = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (ev) => this.onMessage(k, ev.data);
        w.onerror = (e) => {
          console.warn('Terrain worker failed, using main thread', e);
          this.enableFallback(seed);
        };
        w.postMessage({ type: 'init', seed });
        this.workers.push(w);
        this.busy.push(0);
      }
    } catch (e) {
      console.warn('Module workers unavailable, generating terrain on the main thread', e);
      this.enableFallback(seed);
    }
  }

  private enableFallback(seed: number): void {
    if (this.fallback) return;
    this.fallback = new TerrainGenerator(seed);
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.queue = [];
    // Re-run everything still pending — queued or already sent to a dead worker.
    const pending = [...this.pending.values()].map((p) => p.msg);
    pending.forEach((msg, i) => setTimeout(() => this.runFallback(msg), i));
  }

  get capacity(): number {
    return this.fallback ? 1 : this.workers.length * 2;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  chunk(req: ChunkRequest): Promise<ChunkData> {
    return this.submit({ type: 'chunk', req }) as Promise<ChunkData>;
  }

  heightmap(size: number, half: number): Promise<Float32Array> {
    return this.submit({ type: 'heightmap', size, half }) as Promise<Float32Array>;
  }

  private submit(body: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const msg = { ...body, id } as Msg;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, msg });
      if (this.fallback) {
        // Defer so callers can batch; keeps frames responsive.
        setTimeout(() => this.runFallback(msg), 0);
        return;
      }
      this.queue.push({ msg });
      this.pump();
    });
  }

  private runFallback(msg: Msg): void {
    const g = this.fallback!;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    try {
      if (msg.type === 'chunk') p.resolve(g.generate(msg.req as ChunkRequest));
      else p.resolve(generateHeightmap(g.world, msg.size as number, msg.half as number));
    } catch (e) {
      p.reject(e);
    }
  }

  private pump(): void {
    while (this.queue.length) {
      let best = -1;
      for (let k = 0; k < this.workers.length; k++) {
        if (this.busy[k] < 2 && (best < 0 || this.busy[k] < this.busy[best])) best = k;
      }
      if (best < 0) return;
      const item = this.queue.shift()!;
      this.busy[best]++;
      this.workers[best].postMessage(item.msg);
    }
  }

  private onMessage(k: number, data: { id: number; data: unknown }): void {
    this.busy[k] = Math.max(0, this.busy[k] - 1);
    const p = this.pending.get(data.id);
    if (p) {
      this.pending.delete(data.id);
      p.resolve(data.data);
    }
    this.pump();
  }

  /** Drop queued (not yet started) jobs. */
  clearQueue(): void {
    for (const item of this.queue) {
      const p = this.pending.get(item.msg.id);
      this.pending.delete(item.msg.id);
      p?.reject(new Error('cancelled'));
    }
    this.queue = [];
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
