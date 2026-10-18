# Golden Influencer: Windows workstation deployment

This folder installs and operates the platform on the Windows workstation that **already runs ComfyUI** (RTX 5090 Laptop GPU, 24 GB VRAM). Everything runs on that one machine and listens on `127.0.0.1` only.

> **Status of this package.**
> - All scripts parse under PowerShell 7.4.
> - The cross-platform parts were **executed under PowerShell 7.4 on Linux**, against a fresh PostgreSQL 16 cluster and the repository's **simulated** ComfyUI and LLM servers: install, migrate, run-service, discovery, health-check, conformance, llm-bench, integration-test, backup, restore (Test and Replace) and gpu-monitor (with a simulated `nvidia-smi`). The evidence is in [`docs/evidence/m10-windows-package/`](../../docs/evidence/m10-windows-package/README.md).
> - **Nothing has been executed on Windows yet.** The Windows-only parts were not run anywhere: scheduled tasks, the process/port scan of ComfyUI, `icacls`, `robocopy`, and Windows PowerShell 5.1 itself.
> - The first run on the workstation is the real test. Follow [ACCEPTANCE-TESTS.md](ACCEPTANCE-TESTS.md).

## What it installs, and what it never touches

| Installed / managed | Never touched |
|---|---|
| The platform: API + background worker + admin dashboard (one Node.js process) | ComfyUI: its folders, models, custom nodes, workflows, settings, Python environment |
| The ComfyUI **bridge**: a separate Node.js process that speaks VEC v1 to the platform and the ComfyUI HTTP API to the existing ComfyUI | ComfyUI's start-up arrangement (it keeps starting the way it does today) |
| PostgreSQL 16 roles and the `golden` database (native, Docker, or an existing server) | Any other database on that server |
| Optional: a native llama.cpp server task for the local LLM ([LOCAL-LLM.md](LOCAL-LLM.md)) | An LLM server you already run some other way (Ollama, LM Studio, Docker) |
| Folders under `-InstallRoot` (below) | Anything outside `-InstallRoot` and the repository checkout |

The bridge only **uses** ComfyUI the way its web UI does:

- it queues prompts from Track A workflow packages;
- it uploads reference images into `input\golden-refs\`;
- it reads history and outputs;
- it interrupts only its own prompts.

See [COMFYUI.md](COMFYUI.md).

## Prerequisites

| Requirement | Notes |
|---|---|
| Windows 11 (or 10 22H2), an administrator account for setup | Services run as your account through scheduled tasks (S4U logon, no stored password) |
| **Node.js 22.12 or newer** (LTS, x64 `.msi`) | `node --version`. The scripts run `node --env-file=...` |
| **Git** | To clone and update the repository |
| **PostgreSQL 16**: the native installer (recommended), or Docker Desktop | With the native installer, keep "Command Line Tools" selected: `pg_dump`, `pg_restore` and `psql` are needed for backups |
| NVIDIA driver | Already installed for ComfyUI. `nvidia-smi` is used read-only for monitoring |
| ComfyUI | Already installed and running. Note the port it listens on (default 8188) |
| A local LLM server | See [LOCAL-LLM.md](LOCAL-LLM.md). It can be set up after the install |
| Disk | Put `-InstallRoot` on the large NVMe volume: media, backups and logs live there |

Windows PowerShell 5.1 (built in) and PowerShell 7 both work. If the repository came as a downloaded ZIP, unblock the scripts first: `Get-ChildItem -Recurse deploy\windows\*.ps1 | Unblock-File`. Run each script with `powershell -ExecutionPolicy Bypass -File <script> ...`, or set `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

## Folder layout

```
<InstallRoot>\            e.g. D:\golden
  config\golden.env       all configuration and secrets (ACL: you, SYSTEM, Administrators)
  media\                  content-addressed media store (MEDIA_ROOT)
  packages\               Track A workflow packages for the bridge (COMFY_BRIDGE_PACKAGES_DIR)
  bridge\                 bridge job state (COMFY_BRIDGE_DATA_DIR)
  backups\                dated backups + media-mirror\
  audit\                  sealed audit exports (AUDIT_EXPORT_DIR)
  logs\                   platform-YYYYMMDD.log, comfy-bridge-..., llm-... (30 days)
  evidence\               health, conformance, benchmark and integration-test reports
```

The repository checkout can live anywhere, for example `D:\golden\app`. The scripts find it from their own location.

## Install (about 15 minutes)

All commands run in an **elevated** PowerShell from the repository root.

**1. Clone the repository**

```powershell
git clone <repository-url> D:\golden\app
cd D:\golden\app
```

**2. Install the platform.** Pick one way to get PostgreSQL:

```powershell
# Native PostgreSQL 16 already installed and running (recommended):
powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -InstallRoot D:\golden -Postgres native `
  -OwnerEmail you@example.com -OwnerName "Your Name"
#   → asks for the PostgreSQL superuser name and password (used once, not stored)

# Or PostgreSQL in Docker Desktop (ops\docker-compose.yml, 127.0.0.1:5432):
powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -InstallRoot D:\golden -Postgres docker `
  -OwnerEmail you@example.com -OwnerName "Your Name"
```

What `install.ps1` does:

1. Checks Node.js.
2. Creates the folders.
3. Creates `config\golden.env` from [`ops/env.example`](../../ops/env.example) and **generates every secret** (master key, URL-signing and invoice secrets, engine and metrics tokens, database passwords).
4. Runs `npm ci` and builds.
5. Creates the database roles and the database.
6. Applies the migrations.
7. Creates your workspace and owner account: it asks for a password, then prints an **API token** and a **TOTP enrolment URI**.

It is safe to run again: existing values are never overwritten, and migrations that are already applied are skipped.

> **Do these two things now:**
> - Store the owner API token in your password manager. Add the `otpauth://` URI to an authenticator app.
> - Copy `MASTER_KEY` from `golden.env` to an **offline** place (a password manager entry or a printed copy in a safe). Without it, no stored bot or Instagram credential can ever be decrypted, even from a backup.

**3. Connect to the existing ComfyUI (read-only discovery)**

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\discover-comfyui.ps1 -InstallRoot D:\golden -WriteEnv
```

This finds the running ComfyUI process and its port, reads `/system_stats` and `/object_info`, and writes `COMFYUI_URL` into `golden.env`. Copy Track A's workflow packages into `D:\golden\packages`, then re-run with `-CheckPackages`. That reports any missing node types or model files **without changing ComfyUI**. Details: [COMFYUI.md](COMFYUI.md).

**4. Set up the local LLM.** Follow [LOCAL-LLM.md](LOCAL-LLM.md). It ends with `LLM_BASE_URL` and `LLM_CHAT_MODEL` set in `golden.env`.

**5. Register and start the services**

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\register-services.ps1 -InstallRoot D:\golden -Start
```

This creates up to three scheduled tasks. Each starts at boot, runs whether or not you are logged on, restarts every minute on failure and has no time limit:

- `GoldenInfluencer-Platform`;
- `GoldenInfluencer-ComfyBridge` (only if `COMFYUI_URL` is set);
- `GoldenInfluencer-LLM` (only if `LLM_SERVER_EXE` is set).

**6. Check health, then run the acceptance tests**

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\health-check.ps1 -InstallRoot D:\golden
$env:GI_API_TOKEN = '<owner token>'
powershell -ExecutionPolicy Bypass -File deploy\windows\integration-test.ps1 -InstallRoot D:\golden -RegisterEngine
```

**7. Open the dashboard** at <http://127.0.0.1:8080/admin/>. Sign in with your email, password and TOTP code.

**8. Schedule backups** (daily at 02:30; see [BACKUP-RESTORE.md](BACKUP-RESTORE.md)):

```powershell
$a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -ExecutionPolicy Bypass -File D:\golden\app\deploy\windows\backup.ps1 -InstallRoot D:\golden'
Register-ScheduledTask -TaskName GoldenInfluencer-Backup -Action $a -Trigger (New-ScheduledTaskTrigger -Daily -At 02:30) `
  -Principal (New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U)
```

## Script reference

| Script | What it does | Changes anything? |
|---|---|---|
| `install.ps1` | Prerequisites, folders, env file + secrets, build, database, migrations, owner | Yes (idempotent) |
| `migrate.ps1` | Applies pending migrations (checksum-verified) and creates upcoming partitions | Database schema |
| `discover-comfyui.ps1` | Finds the existing ComfyUI, probes it, checks Track A packages; `-WriteEnv` sets `COMFYUI_URL` | Only `golden.env` with `-WriteEnv` |
| `register-services.ps1` | Scheduled tasks for platform, bridge, optional LLM; `-Start`, `-Remove` | Task Scheduler |
| `run-service.ps1` | Runs one service in the foreground with daily logs (used by the tasks; handy for debugging) | No |
| `health-check.ps1` | PostgreSQL, API, readiness, components, metrics, bridge, ComfyUI, LLM, GPU, disk; `-Json`; exit 1 on a critical failure | No |
| `gpu-monitor.ps1` | Samples GPU and per-process VRAM to CSV; exit 2 on a threshold breach | No |
| `conformance.ps1` | VEC v1 conformance suite against the bridge | No (runs the native test workflow only) |
| `llm-bench.ps1` | Measures the local LLM with the platform's workloads; `-WithGpu` | No |
| `integration-test.ps1` | Real end-to-end acceptance run with an evidence folder; `-RegisterEngine`, `-Generate` | Registers the engine (with `-RegisterEngine`); one generation (with `-Generate`) |
| `backup.ps1` | Database dump (verified), media mirror, bridge state, audit exports, retention | Writes backups |
| `restore.ps1` | `-Mode Test` (default, into a scratch database) or `-Mode Replace -Force` | Test: no. Replace: yes, keeps the old database |
| `compose.llm.yml` | Optional llama.cpp server in Docker | — |

## Configuration (`config\golden.env`)

[`ops/env.example`](../../ops/env.example) documents every key. The installer fills in paths and secrets. You set:

- `COMFYUI_URL`: written by `discover-comfyui.ps1 -WriteEnv`.
- `LLM_BASE_URL` and `LLM_CHAT_MODEL`: see LOCAL-LLM.md. Optionally the `LLM_SERVER_*` keys.
- `PUBLISHING_ADAPTERS`: empty, so nothing leaves the machine. Set `telegram` and/or `instagram` only once those are connected and approved.
- `PUBLIC_MEDIA_BASE_URL`: needed for Instagram only. Instagram fetches images over public HTTPS. Expose **only** `/v1/assets/*/content` through a tunnel or reverse proxy; never the whole API.
- `TELEGRAM_ALLOWLIST_USER_IDS`: limits the bots to your beta testers.
- `COST_*`: your own cost estimates for the analytics page.

Bot tokens and Instagram tokens are **not** in this file. They are entered in the dashboard and stored encrypted per influencer.

Restart the platform task after changing the file: `Restart-ScheduledTask`, or Stop + Start in Task Scheduler.

## Upgrading

```powershell
cd D:\golden\app
powershell -ExecutionPolicy Bypass -File deploy\windows\backup.ps1 -InstallRoot D:\golden          # 1. backup first
Stop-ScheduledTask GoldenInfluencer-Platform; Stop-ScheduledTask GoldenInfluencer-ComfyBridge
git pull                                                                                          # 2. new code
powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -InstallRoot D:\golden -Postgres existing   # 3. build + migrate
Start-ScheduledTask GoldenInfluencer-Platform; Start-ScheduledTask GoldenInfluencer-ComfyBridge
powershell -ExecutionPolicy Bypass -File deploy\windows\health-check.ps1 -InstallRoot D:\golden  # 4. verify
```

Migrations only move forward. To roll back, restore the backup from step 1 (`restore.ps1 -Mode Replace`) and check out the previous commit.

## Removing it

`register-services.ps1 -InstallRoot D:\golden -Remove` deletes the tasks. Then, if wanted:

- drop the `golden` database and the `aios_*` roles;
- delete `D:\golden`.

ComfyUI is unaffected, apart from reference images left in its `input\golden-refs\` folder, which you may delete.

## Security notes

- Every port binds to `127.0.0.1`: API 8080, bridge 8190, PostgreSQL 5432, LLM 8081. Do not open them in the firewall.
- `golden.env` is restricted to your account, SYSTEM and Administrators. Backups made with `-IncludeSecrets` contain it, so store those encrypted and offline.
- `SESSION_COOKIE_SECURE=false` is only acceptable because the dashboard is served on `http://127.0.0.1`. Set it to `true` if you put HTTPS in front.
- Production deployment is a separate, explicitly approved step. Nothing here publishes content until `PUBLISHING_ADAPTERS` is set and an influencer is activated.

More: [MONITORING.md](MONITORING.md) · [BACKUP-RESTORE.md](BACKUP-RESTORE.md) · [TROUBLESHOOTING.md](TROUBLESHOOTING.md) · [ACCEPTANCE-TESTS.md](ACCEPTANCE-TESTS.md)
