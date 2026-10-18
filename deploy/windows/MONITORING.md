# Monitoring

There are three layers. All of them are local; nothing is sent off the machine.

| Layer | Where you see it | What it covers |
|---|---|---|
| **Platform self-monitoring** (always on) | Dashboard → **Ops** (health, alerts, dead jobs, GPU, backups); **Overview** (open alerts) | Database and migrations, visual engines, LLM, job queues, Telegram polling, payments reconciliation, GPU temperature and VRAM, backup age |
| **Workstation checks** (scripts) | `health-check.ps1` output, `evidence\` reports, Task Scheduler "Last Run Result" | The processes and ports from the outside: PostgreSQL, API, bridge, ComfyUI, LLM server, GPU, disk |
| **Logs** | `<InstallRoot>\logs\` (30 days), `core.audit_log` | Every request (JSON lines), worker errors, the bridge, the LLM server; every business action in the append-only audit log |

> **Status:** the platform's monitoring is covered by automated tests on Linux. `health-check.ps1` and `gpu-monitor.ps1` were exercised under PowerShell 7 on Linux, with simulated ComfyUI/LLM and a simulated `nvidia-smi`. They have **not** yet run on the workstation.

## 1. Platform self-monitoring

The worker samples and evaluates continuously. Alerts are deduplicated: one open alert per condition, with an occurrence counter.

- Conditions that clear resolve their alert automatically: the engine is back, the GPU has cooled, a backup was made.
- Everything else is acknowledged and resolved by an operator in **Ops**.

| Alert code | Raised when | What to do |
|---|---|---|
| `MIGRATIONS_PENDING` | Code is newer than the database schema | Run `migrate.ps1`, restart the platform task |
| `ENGINE_UNREACHABLE` | The bridge (or another engine) does not answer `/health` | Is `GoldenInfluencer-ComfyBridge` running? Is ComfyUI up? See TROUBLESHOOTING §3 |
| `GPU_TEMP_HIGH` / `GPU_VRAM_HIGH` | Latest sample ≥ `GPU_ALERT_TEMP_C` (87 °C) / ≥ `GPU_ALERT_VRAM_PCT` (97%) | Check cooling and the OEM performance mode; run `gpu-monitor.ps1` to see which process holds VRAM |
| `GPU_MONITOR_FAILED` | `nvidia-smi` could not be run | Driver problem, or `GPU_MONITOR_COMMAND` is wrong |
| `BACKUP_STALE` | No successful backup in `BACKUP_MAX_AGE_H` (30 h) | Check the `GoldenInfluencer-Backup` task and `backup.ps1` output |
| `JOB_DEAD_LETTERED` | A background job failed all its attempts | Ops → Dead-lettered jobs: read the error, fix the cause, **Retry** |
| `TELEGRAM_TOKEN_REJECTED` | Telegram refused a bot token (revoked or regenerated) | Reconnect the bot on the influencer's Setup page |
| `TELEGRAM_POLL_CONFLICT` | Another program is polling the same bot | Stop the other program (only one consumer per bot is allowed) |
| `INSTAGRAM_TOKEN_REJECTED` | Meta refused the Instagram token | Reconnect the Instagram account |
| `PAYMENT_UNMATCHED`, `STAR_TX_UNMATCHED`, `PAYMENT_NOT_IN_LEDGER` | Reconciliation found a Stars transaction and a payment that do not match | Money page → investigate before any manual refund; never edit payments by hand |
| `PAYMENT_RECOVERED_FROM_LEDGER` | A payment missing locally was rebuilt from Telegram's ledger (info) | None; review that access was granted |
| `REFUND_FAILED` | Telegram rejected an approved refund | Retry from the Money page or contact the fan |
| `PROPOSAL_EXECUTION_FAILED` | An approved agent proposal could not be executed | Agents page: read the execution error |
| `CONTENT_QA_HOLD` | Automated QA found a critical issue in content awaiting approval | The item returns to rework; review it |
| `ESCALATION_*` | A fan conversation needs a human (self-harm, minor signal, dispute, request for a human) | Escalations page, within its SLA |
| `COMMENT_*` | A risky Instagram comment was held | Review in the influencer's comments |

### Endpoints

| Endpoint | Auth | Use |
|---|---|---|
| `GET /healthz` | none | Liveness: the process answers |
| `GET /readyz` | none | Readiness summary, one status per component |
| `GET /metrics` | `Authorization: Bearer <METRICS_TOKEN>` | Prometheus text format (below) |
| `GET /v1/ops/health` | staff session (admin) | Detailed component report (same as `node dist/src/cli.js health`) |
| `GET /v1/ops/alerts`, `/v1/ops/gpu?minutes=60`, `/v1/ops/backups`, `/v1/ops/jobs?status=dead` | staff session | What the Ops page shows |

Prometheus metrics (gauges):

- `golden_visual_jobs{state}`;
- `golden_jobs{queue,status}`;
- `golden_outbox_pending`;
- `golden_alerts_open{severity}`;
- `golden_gpu_util_percent`, `golden_gpu_vram_used_mb`, `golden_gpu_vram_total_mb`, `golden_gpu_temperature_c` and `golden_gpu_power_w`, each labelled `{node,gpu}`;
- `golden_llm_requests_in_flight`, `golden_llm_requests_queued`, `golden_llm_requests_total`, `golden_llm_errors_total`, `golden_llm_latency_p95_ms`.

No Prometheus or Grafana is installed by this package. If you run one, scrape `http://127.0.0.1:8080/metrics` with the bearer token.

> **Not implemented yet:** pushing critical alerts to a phone (for example, to an operator Telegram chat). Until then, check **Ops**, or rely on the scheduled health check (below) and Task Scheduler.

## 2. Scheduled health check

Run it every 15 minutes and keep its JSON output. A critical failure gives exit code 1, which Task Scheduler shows as the "Last Run Result":

```powershell
$cmd = '-NoProfile -ExecutionPolicy Bypass -Command "& D:\golden\app\deploy\windows\health-check.ps1 -InstallRoot D:\golden -Json | Out-File D:\golden\logs\health-latest.json; exit $LASTEXITCODE"'
Register-ScheduledTask -TaskName GoldenInfluencer-HealthCheck -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument $cmd) `
  -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)) `
  -Principal (New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U)
```

Critical checks (exit 1 if not `ok`):

- PostgreSQL port;
- `/healthz`;
- the database and migrations components.

Everything else is reported as `ok`, `degraded`, `down`, `disabled`, `not_configured` or `unknown`. `-MinFreeGB` (default 50) sets the disk threshold for the media volume.

## 3. GPU and VRAM

The platform samples the GPU every `GPU_SAMPLE_INTERVAL_MS` (15 s) when `GPU_MONITOR_ENABLED=true` (the default in the template). It stores the samples in `ops.gpu_samples` and shows the last hour on the Ops page.

For investigations and benchmarks, `gpu-monitor.ps1` samples faster and adds **per-process** VRAM:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\gpu-monitor.ps1 -InstallRoot D:\golden -IntervalSec 1 -DurationSec 600
```

It writes three files to `evidence\`:

- `gpu-<stamp>.csv`: time, util %, VRAM used/total/%, °C, W;
- `gpu-procs-<stamp>.csv`: per-process VRAM, which shows how ComfyUI's `python.exe` and the LLM server share the card;
- `gpu-summary-<stamp>.json`: peaks and threshold breaches. The exit code is 2 if a threshold was crossed.

On Windows (WDDM), `nvidia-smi` sometimes reports per-process memory as `[N/A]`; the rows are still written so the processes are visible.

`llm-bench.ps1 -WithGpu` and `integration-test.ps1 -Generate` start this sampler automatically during their runs.

## 4. Logs

| File | Content |
|---|---|
| `logs\platform-YYYYMMDD.log` | API requests and errors (JSON lines, pino), worker `[worker:<loop>]` errors, start/exit markers from `run-service.ps1` |
| `logs\comfy-bridge-YYYYMMDD.log` | Bridge start-up (packages loaded/rejected), job errors |
| `logs\llm-YYYYMMDD.log` | llama.cpp server output (only for the `GoldenInfluencer-LLM` task) |

Logs older than 30 days are deleted when a service restarts. Request logs record the method, URL and status, not request bodies, so passwords and message text are not in them.

Business history is in the database, not in log files:

- `core.audit_log` is append-only and hash-chained (sealed by the worker);
- `inference.visual_job_events` records every job's steps;
- the dashboard shows lineage per content item.

Verify the audit chain at any time with `node dist/src/cli.js audit:verify` (from `apps\platform`, with `--env-file`).
