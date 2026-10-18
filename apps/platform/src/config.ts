import { hostname } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type MasterKey, parseMasterKey } from './lib/crypto.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Repository root, from either src/ (tsx) or dist/src/ (compiled). */
const repoRoot = resolve(here, basename(dirname(here)) === 'dist' ? '../../../..' : '../../..');

export interface WorkerConfig {
  workerId: string;
  dispatchIntervalMs: number;
  pollIntervalMs: number;
  publishIntervalMs: number;
  engineHealthIntervalMs: number;
  leaseSeconds: number;
  /** Platform retry policy (contract §8): attempts per request_id, exponential backoff with full jitter. */
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** Aging: a queued job gains one priority class per step waited (never above P2). */
  agingStepSeconds: number;
  /** A job whose deadline is closer than this is dispatched as P2. */
  deadlineUrgencySeconds: number;
  /** Platform cap on per-job runtime; effective timeout = min(manifest max_runtime_s, cap). */
  jobTimeoutCapSeconds: number;
  /** Grace after a timeout-triggered cancel before the slot is reclaimed without engine confirmation. */
  timeoutGraceSeconds: number;
}

export interface Config {
  databaseUrl: string;
  workerDatabaseUrl: string;
  migrationDatabaseUrl: string | null;
  httpHost: string;
  httpPort: number;
  /** Base URL the visual engine uses to fetch signed reference assets from the platform. */
  publicBaseUrl: string;
  mediaRoot: string;
  contractDir: string;
  migrationsDir: string;
  masterKey: MasterKey;
  masterKeys: Map<string, MasterKey>;
  assetUrlSecret: Buffer;
  assetUrlTtlSeconds: number;
  engineHttpTimeoutMs: number;
  approvalTtlHours: number;
  /**
   * Default GPU-seconds per influencer per day for fair-share scheduling. This is a
   * policy placeholder, NOT a measured capacity: set it from the capacity worksheet
   * (docs/13 §7) once the B-* benchmarks have run on the workstation.
   */
  defaultGpuQuotaSecondsPerDay: number;
  worker: WorkerConfig;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function int(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

export function loadConfig(env: Env = process.env): Config {
  const masterKey = parseMasterKey(env.MASTER_KEY_ID ?? 'local-1', required(env, 'MASTER_KEY'));
  const masterKeys = new Map<string, MasterKey>([[masterKey.id, masterKey]]);
  if (env.MASTER_KEY_PREVIOUS && env.MASTER_KEY_PREVIOUS_ID) {
    const prev = parseMasterKey(env.MASTER_KEY_PREVIOUS_ID, env.MASTER_KEY_PREVIOUS);
    masterKeys.set(prev.id, prev);
  }
  const assetUrlSecret = Buffer.from(required(env, 'ASSET_URL_SECRET'), 'base64');
  if (assetUrlSecret.length < 32) throw new Error('ASSET_URL_SECRET must be at least 32 bytes, base64-encoded');
  const httpPort = int(env, 'HTTP_PORT', 8080, 0);
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    workerDatabaseUrl: required(env, 'WORKER_DATABASE_URL'),
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL ?? null,
    httpHost: env.HTTP_HOST ?? '127.0.0.1',
    httpPort,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${httpPort}`).replace(/\/+$/, ''),
    mediaRoot: resolve(env.MEDIA_ROOT ?? resolve(repoRoot, 'var/media')),
    contractDir: resolve(env.CONTRACT_DIR ?? resolve(repoRoot, 'contracts/visual-engine')),
    migrationsDir: resolve(env.MIGRATIONS_DIR ?? resolve(repoRoot, 'db/migrations')),
    masterKey,
    masterKeys,
    assetUrlSecret,
    assetUrlTtlSeconds: int(env, 'ASSET_URL_TTL_S', 900, 30),
    engineHttpTimeoutMs: int(env, 'ENGINE_HTTP_TIMEOUT_MS', 10_000, 100),
    approvalTtlHours: int(env, 'APPROVAL_TTL_H', 72, 1),
    defaultGpuQuotaSecondsPerDay: int(env, 'DEFAULT_GPU_QUOTA_S_DAY', 1800, 0),
    worker: {
      workerId: env.WORKER_ID ?? `${hostname()}-${process.pid}`,
      dispatchIntervalMs: int(env, 'DISPATCH_INTERVAL_MS', 1000, 10),
      pollIntervalMs: int(env, 'POLL_INTERVAL_MS', 2000, 10),
      publishIntervalMs: int(env, 'PUBLISH_INTERVAL_MS', 10_000, 10),
      engineHealthIntervalMs: int(env, 'ENGINE_HEALTH_INTERVAL_MS', 30_000, 100),
      leaseSeconds: int(env, 'LEASE_S', 60, 1),
      maxAttempts: int(env, 'JOB_MAX_ATTEMPTS', 3, 1),
      retryBaseMs: int(env, 'RETRY_BASE_MS', 10_000, 0),
      retryMaxMs: int(env, 'RETRY_MAX_MS', 300_000, 0),
      agingStepSeconds: int(env, 'AGING_STEP_S', 600, 1),
      deadlineUrgencySeconds: int(env, 'DEADLINE_URGENCY_S', 900, 0),
      jobTimeoutCapSeconds: int(env, 'JOB_TIMEOUT_CAP_S', 3600, 1),
      timeoutGraceSeconds: int(env, 'TIMEOUT_GRACE_S', 120, 0),
    },
  };
}

export const paths = { repoRoot, contractDir: resolve(repoRoot, 'contracts/visual-engine') };
