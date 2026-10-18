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

export interface AuthConfig {
  sessionTtlHours: number;
  sessionIdleMinutes: number;
  /** Secure cookie flag. Disable only for plain-http local testing. */
  cookieSecure: boolean;
  maxFailedLogins: number;
  lockoutMinutes: number;
  totpIssuer: string;
}

export interface MonitoringConfig {
  /** Bearer token for GET /metrics; null = metrics endpoint disabled. */
  metricsToken: string | null;
  nodeName: string;
  gpuMonitorEnabled: boolean;
  /** Command printing nvidia-smi CSV (see modules/monitoring.ts). Configurable, never a hardcoded path. */
  gpuMonitorCommand: string;
  gpuSampleIntervalMs: number;
  gpuAlertTempC: number;
  gpuAlertVramPct: number;
  /** Directory receiving write-once audit seal exports; null = no export. */
  auditExportDir: string | null;
  /** A backup older than this raises an alert. */
  backupMaxAgeHours: number;
}

/** Local LLM served through an OpenAI-compatible HTTP API (llama.cpp server, vLLM, Ollama, LM Studio). */
export interface LlmConfig {
  baseUrl: string | null; // …/v1 ; null = LLM features disabled (replies queue for humans)
  apiKey: string | null;
  /** Model identifier as the local server names it. Configuration only; nothing is hardcoded. */
  chatModel: string | null;
  /** Optional separate guard/classifier model; null = rule-based guard only. */
  guardModel: string | null;
  timeoutMs: number;
  /** P1 chat lane: maximum concurrent requests to the local server. */
  maxConcurrency: number;
  maxReplyTokens: number;
  temperature: number;
  contextMessages: number;
}

export interface TelegramConfig {
  apiBaseUrl: string;
  pollTimeoutSeconds: number;
  pollIntervalMs: number;
  /** Telegram user ids of staff/test accounts that the membership audit never removes. */
  allowlistedUserIds: string[];
}

export interface InstagramConfig {
  graphBaseUrl: string;
  graphVersion: string;
  /** Public HTTPS base (e.g. a Cloudflare Tunnel hostname) Instagram uses to fetch media; null = IG publishing disabled. */
  publicMediaBaseUrl: string | null;
  containerPollIntervalMs: number;
  containerTimeoutSeconds: number;
}

export interface PaymentsConfig {
  /** HMAC key for invoice payloads (>= 32 bytes). */
  invoiceSecret: Buffer;
  subscriptionGraceHours: number;
  subscriptionPeriodSeconds: number;
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
  auth: AuthConfig;
  monitoring: MonitoringConfig;
  llm: LlmConfig;
  telegram: TelegramConfig;
  instagram: InstagramConfig;
  payments: PaymentsConfig;
  conversation: { replyDebounceMs: number };
  publishing: { adapters: string[] };
  /** Job runner concurrency (non-GPU background work). */
  jobConcurrency: number;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function num(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function opt(env: Env, name: string): string | null {
  const v = env[name];
  return v === undefined || v === '' ? null : v;
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
    auth: {
      sessionTtlHours: int(env, 'SESSION_TTL_H', 12, 1),
      sessionIdleMinutes: int(env, 'SESSION_IDLE_MIN', 120, 5),
      cookieSecure: bool(env, 'SESSION_COOKIE_SECURE', true),
      maxFailedLogins: int(env, 'LOGIN_MAX_FAILURES', 5, 1),
      lockoutMinutes: int(env, 'LOGIN_LOCKOUT_MIN', 15, 1),
      totpIssuer: env.TOTP_ISSUER ?? 'Golden Influencer',
    },
    monitoring: {
      metricsToken: opt(env, 'METRICS_TOKEN'),
      nodeName: env.NODE_NAME ?? hostname(),
      gpuMonitorEnabled: bool(env, 'GPU_MONITOR_ENABLED', false),
      gpuMonitorCommand:
        env.GPU_MONITOR_COMMAND ??
        'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits',
      gpuSampleIntervalMs: int(env, 'GPU_SAMPLE_INTERVAL_MS', 15_000, 1000),
      gpuAlertTempC: num(env, 'GPU_ALERT_TEMP_C', 87),
      gpuAlertVramPct: num(env, 'GPU_ALERT_VRAM_PCT', 97),
      auditExportDir: opt(env, 'AUDIT_EXPORT_DIR'),
      backupMaxAgeHours: int(env, 'BACKUP_MAX_AGE_H', 30, 1),
    },
    llm: {
      baseUrl: opt(env, 'LLM_BASE_URL')?.replace(/\/+$/, '') ?? null,
      apiKey: opt(env, 'LLM_API_KEY'),
      chatModel: opt(env, 'LLM_CHAT_MODEL'),
      guardModel: opt(env, 'LLM_GUARD_MODEL'),
      timeoutMs: int(env, 'LLM_TIMEOUT_MS', 60_000, 100),
      maxConcurrency: int(env, 'LLM_MAX_CONCURRENCY', 2, 1),
      maxReplyTokens: int(env, 'LLM_MAX_REPLY_TOKENS', 300, 16),
      temperature: num(env, 'LLM_TEMPERATURE', 0.7),
      contextMessages: int(env, 'LLM_CONTEXT_MESSAGES', 20, 2),
    },
    telegram: {
      apiBaseUrl: (env.TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org').replace(/\/+$/, ''),
      pollTimeoutSeconds: int(env, 'TELEGRAM_POLL_TIMEOUT_S', 25, 0),
      pollIntervalMs: int(env, 'TELEGRAM_POLL_INTERVAL_MS', 1000, 10),
      allowlistedUserIds: (env.TELEGRAM_ALLOWLIST_USER_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    },
    instagram: {
      graphBaseUrl: (env.INSTAGRAM_GRAPH_BASE_URL ?? 'https://graph.instagram.com').replace(/\/+$/, ''),
      graphVersion: env.INSTAGRAM_GRAPH_VERSION ?? 'v23.0',
      publicMediaBaseUrl: opt(env, 'PUBLIC_MEDIA_BASE_URL')?.replace(/\/+$/, '') ?? null,
      containerPollIntervalMs: int(env, 'INSTAGRAM_CONTAINER_POLL_MS', 5000, 10),
      containerTimeoutSeconds: int(env, 'INSTAGRAM_CONTAINER_TIMEOUT_S', 300, 1),
    },
    payments: {
      invoiceSecret: Buffer.from(env.INVOICE_SECRET ?? env.ASSET_URL_SECRET ?? '', 'base64'),
      subscriptionGraceHours: int(env, 'SUBSCRIPTION_GRACE_H', 48, 0),
      subscriptionPeriodSeconds: int(env, 'SUBSCRIPTION_PERIOD_S', 2_592_000, 60),
    },
    publishing: {
      /** Channel adapters that may execute publications, e.g. "instagram,telegram". Empty = nothing leaves the platform. */
      adapters: (env.PUBLISHING_ADAPTERS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    },
    conversation: {
      replyDebounceMs: int(env, 'CONVERSATION_REPLY_DEBOUNCE_MS', 2500, 0),
    },
    jobConcurrency: int(env, 'JOB_CONCURRENCY', 4, 1),
  };
}

export const paths = { repoRoot, contractDir: resolve(repoRoot, 'contracts/visual-engine') };
