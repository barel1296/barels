# Evidence: Windows deployment package, exercised on Linux (2026-10-18)

## What this is

The scripts in [`deploy/windows/`](../../../deploy/windows/README.md) were executed end to end under **PowerShell 7.4.6 on Linux** (the cloud development container). They ran against:

- a **freshly initialised PostgreSQL 16.15 cluster** with password authentication (port 55433);
- the repository's **SIMULATED ComfyUI** and **SIMULATED LLM** servers (`apps/platform/src/simulators/`);
- for the GPU steps, a **simulated `nvidia-smi`**: a shell script that prints fixed CSV values.

The test driver (a scratch shell script, not part of the repository) called each script exactly as a person would, and captured its output and exit code.

## What this is NOT

- **Not Windows.** Windows PowerShell 5.1, scheduled tasks, the CIM/`Get-NetTCPConnection` scan for ComfyUI processes, `icacls` and `robocopy` were **not executed** anywhere. On Linux the scripts take their `chmod`/copy code paths instead.
- **Not real hardware.** No GPU, no real ComfyUI, no real LLM. The integration run correctly labels itself `SIMULATED backends: comfyui, llm (script exercise, NOT hardware acceptance)` with `acceptance_evidence: false`.
- **Not acceptance.** The real acceptance run is [`deploy/windows/ACCEPTANCE-TESTS.md`](../../../deploy/windows/ACCEPTANCE-TESTS.md) on the workstation.

Secrets in the output are replaced with `<redacted>`: the owner API token, the TOTP secret, and the throwaway passwords for this scratch cluster. Scratch paths are shown as `<scratch>`.

## Results

| # | Script | Result | Notes |
|---|---|---|---|
| 01 | `install.ps1 -Postgres native -OwnerEmail …` | exit 0 | Env file filled from `ops/env.example`, all secrets generated, roles + database created, migrations 0001–0008 applied, partitions created, workspace + owner + password + TOTP enrolment |
| 02 | `install.ps1` again | exit 0 | Idempotent: no value regenerated, `applied: []` |
| 03 | `migrate.ps1` | exit 0 | Nothing pending, all partitions present |
| 04 | `discover-comfyui.ps1 -Url … -WriteEnv -CheckPackages` | exit 0 | Simulated ComfyUI found and probed, `COMFYUI_URL` written, the Track A test package `sim.portrait` checked against `/object_info` |
| 05 | `register-services.ps1` | exit 1 (**expected**) | "scheduled tasks are Windows-only": not executable on Linux. Services were started with `run-service.ps1` instead |
| 06 | `health-check.ps1` | exit 0 | All critical checks ok; `gpu unknown` (no `nvidia-smi`) |
| 07 | `conformance.ps1` | exit 0 | VEC v1 16/16 CONFORMANT against the **bridge** (`engine_kind=comfyui`) in front of the simulated ComfyUI |
| 08 | `llm-bench.ps1 -WithGpu` | exit 0 | Measured the **simulator**. The numbers say nothing about any model |
| 09 | `integration-test.ps1 -Generate` | exit 0 | 7/7 steps passed: health, ComfyUI probe, conformance, LLM, API smoke, engine health + sync, one generation through platform → bridge → simulated ComfyUI → ingest (1 media asset). Labelled SIMULATED (see `09-integration-run/summary.md`) |
| 10 | `backup.ps1` | exit 0 | `pg_dump` custom format (1257 TOC entries) verified with `pg_restore --list`, SHA-256 in `10-backup-manifest.json`, media mirror, `bridge.zip`, run recorded |
| 11 | `restore.ps1` (Test mode) | exit 0 | Checksum verified, restored into a new database, counts reported, database dropped, `restore_test` recorded |
| 12 | `restore.ps1 -Mode Replace -Force` | exit 0 | Influencer `after-backup`, created after the backup, is gone after the restore. The previous database is kept as `golden_e2e_before_restore_<stamp>`. The source backup is re-recorded (`12-replace-check.txt`) |
| 13 | `health-check.ps1` after the restore | exit 0 | Healthy; backup age `ok` (the re-recorded backup); GPU line parsed from the simulated `nvidia-smi` |
| 14 | `gpu-monitor.ps1` with the simulated `nvidia-smi` | exit 2 (**expected**) | The fixed simulated values (98% VRAM, 88 °C) exceed the default thresholds, so breaches are reported. Per-GPU and per-process CSVs are in `14-gpu/` |

## Bugs found and fixed by this exercise

| Bug | Effect on Windows if not fixed | Fix |
|---|---|---|
| `Invoke-Platform` returned node's console output together with the exit code | `install.ps1` would swallow the owner API token and the TOTP URI (both shown only once), and report a successful `workspace:create` as failed | Output goes to the host; only the exit code is returned |
| `Out-File -Encoding utf8` in Windows PowerShell 5.1 writes a byte-order mark | `backup:record` (Node `JSON.parse`) would fail on every manifest, so backups would never be recorded and `BACKUP_STALE` would fire | BOM-free JSON writer (`Write-JsonFile`); the CLI also strips a BOM |
| Redirected native stderr under `ErrorActionPreference=Stop` is fatal in Windows PowerShell 5.1 | The platform service would die on its first warning line on stderr | `Invoke-Tolerant` around redirected native commands |
| Windows PowerShell 5.1 decodes native output with the OEM code page | Garbled UTF-8 in logs | Console output encoding set to UTF-8 |
| `health-check.ps1` assumed every component has a `detail` field (strict mode) | The detailed component report was lost | Optional-property access (`Get-Prop`) |
| An unexpected `nvidia-smi` line aborted the whole health check | A GPU glitch hid every other check | GPU check isolated, reported as `unknown` |
| The restored database never contains the record of the backup it came from | `BACKUP_STALE` right after a successful recovery | Replace mode re-records the source backup |
| ComfyUI `system_stats` fields vary by version (strict mode) | Discovery could fail on older ComfyUI builds | `Get-Prop` for every optional field |
| The integration run called itself REAL even against simulators | Simulated evidence could be mistaken for acceptance | Simulator detection; `acceptance_evidence: false` |
