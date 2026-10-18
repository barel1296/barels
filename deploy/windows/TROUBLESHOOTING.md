# Troubleshooting and recovery

Start every investigation with:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\health-check.ps1 -InstallRoot D:\golden
```

Then look at **Ops** in the dashboard and at `D:\golden\logs\`. To see a service's own output, stop its task and run it in the foreground:

```powershell
Stop-ScheduledTask GoldenInfluencer-Platform
powershell -ExecutionPolicy Bypass -File deploy\windows\run-service.ps1 -Service platform -InstallRoot D:\golden
# Ctrl+C, then Start-ScheduledTask GoldenInfluencer-Platform
```

Nothing in this guide changes ComfyUI. Where ComfyUI itself is the problem, the fix belongs to Track A.

## 1. Installation

| Symptom | Cause | Fix |
|---|---|---|
| `running scripts is disabled on this system` | Execution policy | Use `powershell -ExecutionPolicy Bypass -File ...`, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `... is not digitally signed` / script blocked | Downloaded ZIP marks the files | `Get-ChildItem -Recurse deploy\windows\*.ps1 \| Unblock-File` |
| `Node.js 22.12 or newer is required` | Old Node | Install the current Node 22 LTS (x64 MSI), open a **new** PowerShell |
| `npm ci` fails with EPERM / file locked | Antivirus scanning `node_modules`, or a running platform | Stop the tasks; add an exclusion for the repository folder; retry |
| `PostgreSQL is not listening on 127.0.0.1:5432` | Service stopped, or a different port | `Get-Service postgresql*`; start it. Set `PG_HOST`/`PG_PORT` and the three `*_DATABASE_URL` values in `golden.env` if the port differs |
| `db:bootstrap` fails with `password authentication failed` | Wrong superuser password | Re-run; it is asked for again (not stored) |
| `... still contains CHANGE_ME` | Running `-Postgres existing` without setting URLs | Put the real role passwords in `DATABASE_URL`, `WORKER_DATABASE_URL`, `MIGRATION_DATABASE_URL` |
| Migration error `checksum mismatch` | A migration file was edited after being applied | Never edit applied migrations. `git checkout` the original file. New changes go in a new migration |
| `workspace:create failed (it may already exist)` | Re-running the installer with `-OwnerEmail` | Expected on a re-run. Use the dashboard's Users page, or `cli user:setup-token --email ...` for a new setup link |

## 2. Platform / dashboard

| Symptom | Cause | Fix |
|---|---|---|
| `http://127.0.0.1:8080/admin/` does not load | Platform task not running | Task Scheduler → `GoldenInfluencer-Platform` → Last Run Result; `logs\platform-*.log` |
| Log ends with `environment variable ... is required` or a config error | Missing/invalid value in `golden.env` | Fix the key named in the message; restart the task |
| Sign-in fails with the right password | TOTP clock drift, or the account is locked after failed attempts | Sync Windows time (`w32tm /resync`); wait `LOGIN_LOCKOUT_MIN` (15 min). An admin can reset credentials on the Users page |
| Signed out immediately / CSRF errors | `SESSION_COOKIE_SECURE=true` on plain http | Set it to `false` for `http://127.0.0.1`, or use HTTPS |
| Page says "You do not have permission" | Role lacks the permission | Users page: give a role with that permission (e.g. `compliance_officer` approves personas and references) |
| "awaiting another reviewer/approver" | Four-eyes rule: authors cannot approve their own persona versions, adapters or content | Have a second account approve |
| Health: `MIGRATIONS_PENDING` | Code updated without migrating | `migrate.ps1`, restart the platform task |
| Ops shows dead-lettered jobs | A background job exhausted its retries | Read its error; fix the cause; **Retry** |

## 3. ComfyUI bridge and generation

| Symptom | Cause | Fix |
|---|---|---|
| `discover-comfyui.ps1` finds nothing | ComfyUI not running, or on another port | Start ComfyUI the usual way; re-run with `-Url http://127.0.0.1:<port>` |
| Bridge task not created | `COMFYUI_URL` empty | `discover-comfyui.ps1 -WriteEnv`, then `register-services.ps1` again |
| Bridge log: `0 workflow package(s)` or `rejected` | Packages missing or invalid | Check `COMFY_BRIDGE_PACKAGES_DIR` layout `<key>\<version>\{manifest,workflow_api,bindings}.json`; the log names the problem; Track A fixes packages |
| `check-packages`: missing node types / model files | This ComfyUI lacks a custom node or model the workflow uses | **Track A** installs it. This package never does |
| `ENGINE_UNREACHABLE` | Bridge down or token mismatch | Bridge log; `VEC_ENGINE_TOKEN` must equal the token registered on the platform (re-register the engine after changing it) |
| Conformance fails C01 (auth) | Token mismatch | As above |
| Jobs stay `queued` | No approved workflow, influencer not active, binding missing, kill switch on, GPU quota used up, or `media_lane_vram_mb` lower than the workflow's `vram_mb_peak` | Job detail (`GET /v1/visual-jobs/<id>` events) names the reason; fix that |
| Job fails `RESOURCE_EXHAUSTED` (out of memory) | ComfyUI ran out of VRAM, often because the LLM is resident | Retries happen automatically. Persistent: lower `LLM_SERVER_CTX`/`LLM_SERVER_PARALLEL` or use a smaller LLM quantization; give Track A the `gpu-monitor.ps1` CSVs |
| Job fails `MODEL_UNAVAILABLE` | A model/file named in the workflow is missing in ComfyUI ("value not in list") | Track A |
| Job fails `TIMEOUT` | Longer than `min(timeout_s, manifest max_runtime_s)` | Check for queued manual ComfyUI work; Track A adjusts `max_runtime_s` with measurements |
| Generated image not shown / not publishable | Output failed verification or QA | Media page shows validation results; QA thresholds per influencer |

**Recovering a stuck job:** cancel it from the API or dashboard. The bridge interrupts only its own prompt; anything someone queued manually in ComfyUI is left alone. Restarting the bridge is safe: job state is persisted in `COMFY_BRIDGE_DATA_DIR`, and running prompts are re-read from ComfyUI's history.

## 4. Local LLM

| Symptom | Cause | Fix |
|---|---|---|
| Health: `llm degraded ... does not list LLM_CHAT_MODEL` | Name mismatch | llama.cpp: `LLM_CHAT_MODEL` is passed as `--alias`, so restart the LLM task. Ollama: use the exact `ollama list` name |
| `llm-...log`: CUDA error / no devices | Wrong llama.cpp build or driver | Use a CUDA 12.8+ build with its matching `cudart` files in the same folder; `llama-server --list-devices` |
| Replies are slow, or LLM `timeout` errors in the log | Too few slots or too much context; GPU contention with ComfyUI | `llm-bench.ps1 -WithGpu`; adjust `LLM_SERVER_PARALLEL`/`LLM_MAX_CONCURRENCY` together; see LOCAL-LLM.md §4 |
| Memory extraction / agents produce `invalid_output` | The server ignores JSON mode or the model is weak at JSON | `llm-bench.ps1`: `json_valid_rate` must be ≥ 0.9; try another server or model |
| Fans get no reply at all | Influencer paused; kill switch `conversations`; consent not given; daily free-reply allowance used; conversation in `human` mode or escalated | Inbox shows the mode and drafts; influencer page shows kill switches and allowances |

## 5. Telegram and Instagram

| Symptom | Cause | Fix |
|---|---|---|
| `TELEGRAM_TOKEN_REJECTED` | Token revoked in @BotFather | Reconnect the bot (Setup page) with the new token |
| `TELEGRAM_POLL_CONFLICT` | Another program polls the same bot, or a webhook is set on it | Stop the other consumer, or remove the webhook (`deleteWebhook`). The platform only polls; it never changes a bot's webhook itself |
| Bot answers "closed beta" | `TELEGRAM_ALLOWLIST_USER_IDS` is set and the user is not in it | Add the tester's numeric user id, or empty it for public use |
| Stars payment shown in Telegram but no access | Payment arrived while the platform was down | Reconciliation recovers it from the Stars ledger (`PAYMENT_RECOVERED_FROM_LEDGER`); check Money page |
| Instagram publish fails: media URL not reachable | `PUBLIC_MEDIA_BASE_URL` not publicly reachable over HTTPS | Fix the tunnel/proxy; it must reach `/v1/assets/<id>/content` only |
| Publication status `unknown` | Ambiguous failure (timeout after sending) | Check the account. The platform never re-posts automatically after an ambiguous failure; resolve it manually |
| Nothing is published at all | `PUBLISHING_ADAPTERS` empty, kill switch `publishing` on, channel frozen, or approval missing | By design; set the adapter once the channel is approved |

## 6. GPU and hardware

| Symptom | Fix |
|---|---|
| `GPU_TEMP_HIGH` | Laptop on a stand, vents clear, OEM performance mode as benchmarked (docs/14 §1); check `gpu-monitor.ps1` temperature curve |
| `GPU_VRAM_HIGH` | `gpu-monitor.ps1`: see which process holds VRAM (`gpu-procs-*.csv`) |
| `nvidia-smi` not found | It ships with the driver in `C:\Windows\System32`; repair the NVIDIA driver installation |
| Laptop sleeps and services stop | Power plan: never sleep on AC; the tasks restart automatically after resume (`StartWhenAvailable`) |

## 7. Database

| Symptom | Fix |
|---|---|
| Disk full | Check `MEDIA_ROOT` and `backups\` sizes; lower `-Keep`; move old backups off-machine. PostgreSQL stops accepting writes when its disk is full; free space first, then restart the service |
| Corrupted or lost database | `restore.ps1 -Mode Replace -Force` from the newest good backup ([BACKUP-RESTORE.md](BACKUP-RESTORE.md)) |
| Need to undo a bad bulk change | Same as above; the current database is kept as `golden_before_restore_<stamp>` for comparison |
| `audit:verify` reports a broken chain | Do not "fix" rows. Preserve the database (backup), then investigate: the chain exists to make tampering visible |

## 8. Emergency stop

| Scope | How |
|---|---|
| One influencer's autonomy, conversations or publishing | Influencer page → kill switches |
| All media generation | Insert the `kill_switch.media_generation` feature flag (see `apps/platform/README.md` → Kill switches) |
| Everything | `Stop-ScheduledTask GoldenInfluencer-Platform` (and `-ComfyBridge`). Telegram keeps undelivered updates for up to 24 hours, until the bots are polled again. ComfyUI keeps running untouched |
