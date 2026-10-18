import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Services } from '../services.js';
import { raiseAlert, resolveAlert } from './alerts.js';

const exec = promisify(execFile);

export interface GpuSample {
  gpu_index: number;
  gpu_name: string | null;
  util_pct: number | null;
  vram_used_mb: number | null;
  vram_total_mb: number | null;
  temp_c: number | null;
  power_w: number | null;
}

const numOrNull = (v: string | undefined) => {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === '' || /N\/A|not supported/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** Parses `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits`. */
export function parseNvidiaSmiCsv(out: string): GpuSample[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const f = line.split(',').map((x) => x.trim());
      // The name is the only free-text field: read the five numbers from the end, so a comma in a
      // name cannot shift them into the wrong columns.
      const n = f.length > 7 ? f.slice(-5) : f.slice(2);
      return {
        gpu_index: Number(f[0] ?? 0),
        gpu_name: (f.length > 7 ? f.slice(1, -5).join(', ') : f[1]) ?? null,
        util_pct: numOrNull(n[0]),
        vram_used_mb: numOrNull(n[1]),
        vram_total_mb: numOrNull(n[2]),
        temp_c: numOrNull(n[3]),
        power_w: numOrNull(n[4]),
      };
    })
    .filter((s) => Number.isInteger(s.gpu_index));
}

/**
 * Samples the GPU with the configured command (split on whitespace, executed
 * without a shell), stores the samples and raises/clears temperature and VRAM
 * alerts. Disabled unless GPU_MONITOR_ENABLED=true.
 */
export async function sampleGpu(svc: Services): Promise<GpuSample[]> {
  const cfg = svc.config.monitoring;
  if (!cfg.gpuMonitorEnabled) return [];
  const [cmd, ...args] = cfg.gpuMonitorCommand.split(/\s+/).filter(Boolean);
  let samples: GpuSample[];
  try {
    const { stdout } = await exec(cmd!, args, { timeout: 10_000, windowsHide: true });
    samples = parseNvidiaSmiCsv(stdout);
    await resolveAlert(svc.workerPool, `gpu_monitor_failed:${cfg.nodeName}`);
  } catch (err) {
    await raiseAlert(svc.workerPool, {
      severity: 'warning',
      source: 'gpu',
      code: 'GPU_MONITOR_FAILED',
      dedupKey: `gpu_monitor_failed:${cfg.nodeName}`,
      message: `GPU monitor command failed: ${(err as Error).message.slice(0, 300)}`,
    });
    return [];
  }
  for (const s of samples) {
    await svc.workerPool.query(
      `INSERT INTO ops.gpu_samples (node, gpu_index, gpu_name, util_pct, vram_used_mb, vram_total_mb, temp_c, power_w, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'nvidia_smi')`,
      [cfg.nodeName, s.gpu_index, s.gpu_name, s.util_pct, s.vram_used_mb, s.vram_total_mb, s.temp_c, s.power_w],
    );
    const tempKey = `gpu_temp:${cfg.nodeName}:${s.gpu_index}`;
    if (s.temp_c !== null && s.temp_c >= cfg.gpuAlertTempC) {
      await raiseAlert(svc.workerPool, { severity: 'warning', source: 'gpu', code: 'GPU_TEMP_HIGH', dedupKey: tempKey, message: `GPU ${s.gpu_index} at ${s.temp_c} °C (threshold ${cfg.gpuAlertTempC} °C)`, details: { ...s } });
    } else if (s.temp_c !== null) {
      await resolveAlert(svc.workerPool, tempKey);
    }
    const vramKey = `gpu_vram:${cfg.nodeName}:${s.gpu_index}`;
    if (s.vram_used_mb !== null && s.vram_total_mb) {
      const pct = (100 * s.vram_used_mb) / s.vram_total_mb;
      if (pct >= cfg.gpuAlertVramPct) {
        await raiseAlert(svc.workerPool, { severity: 'warning', source: 'gpu', code: 'GPU_VRAM_HIGH', dedupKey: vramKey, message: `GPU ${s.gpu_index} VRAM at ${pct.toFixed(1)}%`, details: { ...s } });
      } else {
        await resolveAlert(svc.workerPool, vramKey);
      }
    }
  }
  return samples;
}

/** Records the visual engine's own resource view (GET /resources) as samples. */
export async function sampleEngineResources(svc: Services): Promise<number> {
  const { rows } = await svc.workerPool.query(`SELECT * FROM inference.visual_engines WHERE status = 'active' AND health <> 'unreachable'`);
  let n = 0;
  for (const engine of rows) {
    try {
      const r = await svc.engineClients.forRow(engine).getResources();
      await svc.workerPool.query(
        `INSERT INTO ops.gpu_samples (node, gpu_index, gpu_name, vram_used_mb, vram_total_mb, source)
         VALUES ($1, 0, $2, $3, $4, 'engine_resources')`,
        [engine.engine_key, engine.reported_engine_id, r.vram_in_use_mb ?? null, r.vram_total_mb ?? null],
      );
      n++;
    } catch {
      // Engine health is tracked by the health loop.
    }
  }
  return n;
}

export type ComponentStatus = 'ok' | 'degraded' | 'down' | 'disabled';

export interface HealthReport {
  status: ComponentStatus;
  checked_at: string;
  components: Record<string, { status: ComponentStatus; detail?: Record<string, unknown> | string }>;
}

function worst(statuses: ComponentStatus[]): ComponentStatus {
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';
  return 'ok';
}

/** Detailed component health for operators (and the readiness probe, summarised). */
export async function healthReport(svc: Services): Promise<HealthReport> {
  const c: HealthReport['components'] = {};
  try {
    await svc.workerPool.query('SELECT 1');
    c.database = { status: 'ok' };
  } catch (err) {
    c.database = { status: 'down', detail: (err as Error).message };
    return { status: 'down', checked_at: new Date().toISOString(), components: c };
  }
  try {
    const files = (await readdir(svc.config.migrationsDir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const latest = files.at(-1)?.slice(0, 4) ?? null;
    const applied = await svc.workerPool.query<{ v: string | null }>('SELECT max(version) AS v FROM public.schema_migrations');
    const v = applied.rows[0]?.v ?? null;
    c.migrations = v === latest ? { status: 'ok', detail: { version: v } } : { status: 'down', detail: { applied: v, expected: latest } };
  } catch (err) {
    c.migrations = { status: 'degraded', detail: (err as Error).message };
  }
  const engines = await svc.workerPool.query<{ engine_key: string; health: string; engine_kind: string | null; last_seen_at: Date | null }>(
    `SELECT engine_key, health, engine_kind, last_seen_at FROM inference.visual_engines WHERE status = 'active'`,
  );
  c.visual_engine =
    engines.rows.length === 0
      ? { status: 'disabled', detail: 'no engine registered' }
      : {
          status: engines.rows.every((e) => ['ready', 'busy'].includes(e.health)) ? 'ok' : engines.rows.some((e) => ['ready', 'busy'].includes(e.health)) ? 'degraded' : 'down',
          detail: { engines: engines.rows },
        };
  c.llm = svc.config.llm.baseUrl ? await svc.llm.health() : { status: 'disabled', detail: 'LLM_BASE_URL not set' };
  const jobs = await svc.workerPool.query<{ dead: number; backlog: number; oldest_s: number | null }>(
    `SELECT count(*) FILTER (WHERE status = 'dead')::int AS dead,
            count(*) FILTER (WHERE status = 'queued' AND run_at <= now())::int AS backlog,
            extract(epoch FROM now() - min(run_at) FILTER (WHERE status = 'queued' AND run_at <= now()))::float8 AS oldest_s
       FROM core.jobs`,
  );
  const j = jobs.rows[0]!;
  c.job_queue = { status: j.dead > 0 || (j.oldest_s ?? 0) > 600 ? 'degraded' : 'ok', detail: j };
  const telegram = await svc.workerPool.query<{ account_ref: string; age_s: number }>(
    `SELECT account_ref, extract(epoch FROM now() - updated_at)::float8 AS age_s FROM core.poll_cursors WHERE source = 'telegram_updates'`,
  );
  c.telegram_polling =
    telegram.rows.length === 0
      ? { status: 'disabled', detail: 'no bot polling yet' }
      : { status: telegram.rows.some((t) => t.age_s > 300) ? 'degraded' : 'ok', detail: { bots: telegram.rows } };
  const alerts = await svc.workerPool.query<{ critical: number; warning: number }>(
    `SELECT count(*) FILTER (WHERE severity = 'critical')::int AS critical, count(*) FILTER (WHERE severity = 'warning')::int AS warning
       FROM ops.alerts WHERE status = 'open'`,
  );
  c.alerts = { status: alerts.rows[0]!.critical > 0 ? 'degraded' : 'ok', detail: alerts.rows[0]! };
  const backup = await svc.workerPool.query<{ age_h: number | null }>(
    `SELECT extract(epoch FROM now() - max(finished_at))::float8 / 3600 AS age_h FROM ops.backup_runs WHERE kind = 'backup' AND status = 'succeeded'`,
  );
  const age = backup.rows[0]?.age_h ?? null;
  c.backup = age === null ? { status: 'degraded', detail: 'no successful backup recorded' } : { status: age > svc.config.monitoring.backupMaxAgeHours ? 'degraded' : 'ok', detail: { age_hours: Math.round(age * 10) / 10 } };
  const gpu = await svc.workerPool.query(
    `SELECT DISTINCT ON (node, gpu_index) node, gpu_index, gpu_name, util_pct, vram_used_mb, vram_total_mb, temp_c, power_w, captured_at
       FROM ops.gpu_samples WHERE source = 'nvidia_smi' AND captured_at > now() - interval '5 minutes'
      ORDER BY node, gpu_index, captured_at DESC`,
  );
  c.gpu = svc.config.monitoring.gpuMonitorEnabled ? { status: gpu.rowCount ? 'ok' : 'degraded', detail: { latest: gpu.rows } } : { status: 'disabled', detail: 'GPU_MONITOR_ENABLED=false' };
  const relevant = Object.entries(c)
    .filter(([k]) => !['alerts', 'backup', 'gpu'].includes(k))
    .map(([, v]) => v.status)
    .filter((s) => s !== 'disabled');
  return { status: worst(relevant), checked_at: new Date().toISOString(), components: c };
}

/** Alert rules evaluated periodically (backup age, dead jobs, stale engine). */
export async function evaluateAlertRules(svc: Services): Promise<void> {
  const report = await healthReport(svc);
  const backup = report.components.backup!;
  if (backup.status !== 'ok') {
    await raiseAlert(svc.workerPool, { severity: 'warning', source: 'backup', code: 'BACKUP_STALE', dedupKey: 'backup_stale', message: 'No successful backup within BACKUP_MAX_AGE_H', details: { detail: backup.detail } });
  } else {
    await resolveAlert(svc.workerPool, 'backup_stale');
  }
  for (const e of ((report.components.visual_engine?.detail as { engines?: { engine_key: string; health: string }[] })?.engines ?? [])) {
    const key = `engine_down:${e.engine_key}`;
    if (e.health === 'unreachable') {
      await raiseAlert(svc.workerPool, { severity: 'critical', source: 'engine', code: 'ENGINE_UNREACHABLE', dedupKey: key, message: `Visual engine ${e.engine_key} is unreachable` });
    } else {
      await resolveAlert(svc.workerPool, key);
    }
  }
  if (report.components.migrations?.status === 'down') {
    await raiseAlert(svc.workerPool, { severity: 'critical', source: 'database', code: 'MIGRATIONS_PENDING', dedupKey: 'migrations_pending', message: 'Database schema is not at the expected migration', details: { detail: report.components.migrations.detail } });
  } else {
    await resolveAlert(svc.workerPool, 'migrations_pending');
  }
}

/** Prometheus text exposition of platform gauges (computed from the database). */
export async function prometheusMetrics(svc: Services): Promise<string> {
  const lines: string[] = [];
  const gauge = (name: string, help: string, values: { labels?: Record<string, string>; value: number }[]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const v of values) {
      const labels = v.labels ? `{${Object.entries(v.labels).map(([k, val]) => `${k}="${val.replace(/["\\\n]/g, '_')}"`).join(',')}}` : '';
      lines.push(`${name}${labels} ${Number.isFinite(v.value) ? v.value : 0}`);
    }
  };
  const vj = await svc.workerPool.query<{ state: string; n: number }>('SELECT state, count(*)::int AS n FROM inference.visual_jobs GROUP BY state');
  gauge('golden_visual_jobs', 'Visual jobs by state', vj.rows.map((r) => ({ labels: { state: r.state }, value: r.n })));
  const jobs = await svc.workerPool.query<{ queue: string; status: string; n: number }>('SELECT queue, status, count(*)::int AS n FROM core.jobs GROUP BY queue, status');
  gauge('golden_jobs', 'Background jobs by queue and status', jobs.rows.map((r) => ({ labels: { queue: r.queue, status: r.status }, value: r.n })));
  const outbox = await svc.workerPool.query<{ n: number }>('SELECT count(*)::int AS n FROM core.outbox_events WHERE dispatched_at IS NULL');
  gauge('golden_outbox_pending', 'Undispatched outbox events', [{ value: outbox.rows[0]!.n }]);
  const alerts = await svc.workerPool.query<{ severity: string; n: number }>(`SELECT severity, count(*)::int AS n FROM ops.alerts WHERE status = 'open' GROUP BY severity`);
  gauge('golden_alerts_open', 'Open alerts by severity', alerts.rows.map((r) => ({ labels: { severity: r.severity }, value: r.n })));
  const gpu = await svc.workerPool.query<{ node: string; gpu_index: number; util_pct: number | null; vram_used_mb: number | null; vram_total_mb: number | null; temp_c: number | null; power_w: number | null }>(
    `SELECT DISTINCT ON (node, gpu_index) node, gpu_index, util_pct, vram_used_mb, vram_total_mb, temp_c, power_w
       FROM ops.gpu_samples WHERE source = 'nvidia_smi' ORDER BY node, gpu_index, captured_at DESC`,
  );
  for (const [metric, field, help] of [
    ['golden_gpu_util_percent', 'util_pct', 'GPU utilisation (latest sample)'],
    ['golden_gpu_vram_used_mb', 'vram_used_mb', 'GPU memory used (latest sample)'],
    ['golden_gpu_vram_total_mb', 'vram_total_mb', 'GPU memory total'],
    ['golden_gpu_temperature_c', 'temp_c', 'GPU temperature (latest sample)'],
    ['golden_gpu_power_w', 'power_w', 'GPU power draw (latest sample)'],
  ] as const) {
    gauge(
      metric,
      help,
      gpu.rows.filter((r) => r[field] !== null).map((r) => ({ labels: { node: r.node, gpu: String(r.gpu_index) }, value: Number(r[field]) })),
    );
  }
  const llm = svc.llm.stats();
  gauge('golden_llm_requests_in_flight', 'LLM requests currently executing', [{ value: llm.inFlight }]);
  gauge('golden_llm_requests_queued', 'LLM requests waiting for the chat lane', [{ value: llm.queued }]);
  gauge('golden_llm_requests_total', 'LLM requests since start', [{ value: llm.total }]);
  gauge('golden_llm_errors_total', 'LLM request errors since start', [{ value: llm.errors }]);
  gauge('golden_llm_latency_p95_ms', 'LLM latency p95 over the last 200 requests', [{ value: llm.p95Ms ?? 0 }]);
  return `${lines.join('\n')}\n`;
}
