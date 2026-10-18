# Backup and restore

A complete backup needs **three** things. None of them is enough alone:

1. **The database.** `pg_dump` of `golden`: personas, fans, conversations, memories, payments, content, audit.
2. **The media store.** `MEDIA_ROOT`: content-addressed and immutable, so it is mirrored incrementally.
3. **`MASTER_KEY`.** Keep it **offline**, separately. Bot and Instagram tokens and the engine token are stored encrypted with it. Without it, a restored database still works, but every credential must be re-entered.

`backup.ps1` covers 1 and 2, plus the bridge state and audit exports. Item 3 is your offline copy, made at install time.

ComfyUI, its models and workflows are **not** part of this backup; Track A owns them. Neither is the LLM model file, which you can download again.

> **Evidence:** `backup.ps1` and `restore.ps1` were executed with PowerShell 7.4 on Linux against PostgreSQL 16.15, a full installed schema and generated media:
>
> - a backup;
> - a restore test into a scratch database;
> - a Replace restore that rolled back a change made after the backup and kept the previous database;
> - retention.
>
> See [`docs/evidence/m10-windows-package/`](../../docs/evidence/m10-windows-package/README.md). On Windows, `robocopy` and the `icacls` restriction replace the Linux code paths; those were **not** executed.

## Backup

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\backup.ps1 -InstallRoot D:\golden [-Destination E:\golden-backups] [-Keep 14] [-IncludeSecrets]
```

It creates `<Destination>\<yyyyMMdd-HHmmss>\`, by default `D:\golden\backups\…`, containing:

| File | Content |
|---|---|
| `db.dump` | `pg_dump --format=custom` as `aios_migrator`. It is checked by reading it back with `pg_restore --list` before the backup counts as good. Access is restricted to the owner. |
| `manifest.json` | Start/end time, host, status, dump size, **SHA-256**, TOC entry count, media mirror summary, extras |
| `bridge.zip`, `audit.zip` | Bridge job state and outputs; sealed audit exports |
| `golden.env` | **Only with `-IncludeSecrets`.** Contains `MASTER_KEY` and the passwords. Keep such backups encrypted and offline |

The media store is mirrored to `<Destination>\media-mirror\`:

- `robocopy /E /XO` on Windows;
- only new files are copied;
- files are never deleted from the mirror. They are named by their hash, so the mirror only grows.

Each run is recorded in `ops.backup_runs` (dashboard → Ops → Backups). The platform raises `BACKUP_STALE` when no successful backup is younger than `BACKUP_MAX_AGE_H` (30 h). Retention keeps the newest `-Keep` dated folders; the media mirror is kept.

**Schedule** (daily at 02:30, as your account, without a stored password):

```powershell
$a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -ExecutionPolicy Bypass -File D:\golden\app\deploy\windows\backup.ps1 -InstallRoot D:\golden'
Register-ScheduledTask -TaskName GoldenInfluencer-Backup -Action $a -Trigger (New-ScheduledTaskTrigger -Daily -At 02:30) `
  -Principal (New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U)
```

**Off-machine copy.** Copy the newest dated folder and `media-mirror\` to an external disk or NAS weekly. A backup on the same NVMe does not survive the loss of that drive or the laptop.

The client tools (`pg_dump`, `pg_restore`, `psql`) must be installed: select "Command Line Tools" in the PostgreSQL installer. The scripts look in `PATH` and in `C:\Program Files\PostgreSQL\*\bin`.

## Restore test (monthly, non-destructive)

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\restore.ps1 -InstallRoot D:\golden -BackupDir D:\golden\backups\20261018-020000
```

Steps:

1. Checks the dump's SHA-256 against the manifest.
2. Asks for a PostgreSQL **superuser**, or takes `-PgAdminUrl`. It needs the right to create databases; the password is not stored.
3. Restores into a **new** database, `golden_restore_<stamp>`. Production is untouched.
4. Reports the schema version and row counts: influencers, fans, messages, payments, media assets, audit rows and seals.
5. Drops the test database (add `-KeepDatabase` to inspect it), then records a `restore_test` run.

A restore test that fails is an incident: fix the backup before you need it.

## Real recovery (Replace)

Use this when the database is lost or corrupted, or a bad change must be rolled back.

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\restore.ps1 -InstallRoot D:\golden -BackupDir <folder> -Mode Replace -Force
#   → type the database name to confirm
```

Steps:

1. Verifies the checksum and asks for confirmation: you type the database name.
2. Stops `GoldenInfluencer-Platform` and `GoldenInfluencer-ComfyBridge`, and closes the remaining connections.
3. **Renames** the current database to `golden_before_restore_<stamp>`. Nothing is deleted, so you can go back.
4. Restores the dump as `golden`, re-records the backup it came from, and copies media files missing from `MEDIA_ROOT` out of the mirror. Existing files are never overwritten.
5. Starts the tasks again and records a `restore` run.

Then:

- Run `migrate.ps1` if the backup is older than the installed code, then `health-check.ps1`.
- Check the dashboard, then drop `golden_before_restore_<stamp>` once you are sure.
- Data written after the backup is not in the restored database. Payments are healed by reconciliation, which re-reads Telegram's Stars ledger. Re-check any refunds made in that window.

## A new machine (disaster recovery)

1. Install the prerequisites and run `install.ps1` with the **same** `-InstallRoot` layout.
2. Before starting any service, replace the generated `MASTER_KEY` and `MASTER_KEY_ID` in the new `golden.env` with your offline copy. Alternatively, restore `golden.env` from an `-IncludeSecrets` backup and keep the new machine's database passwords.
3. Copy the backup folder and `media-mirror\` to the new machine, then run `restore.ps1 -Mode Replace -Force`.
4. Run `discover-comfyui.ps1 -WriteEnv` for that machine's ComfyUI, set up the LLM, then `register-services.ps1 -Start`.
5. Run `health-check.ps1`, then `integration-test.ps1`.

## Key rotation

To rotate the master key:

1. Move `MASTER_KEY`/`MASTER_KEY_ID` to `MASTER_KEY_PREVIOUS`/`MASTER_KEY_PREVIOUS_ID`.
2. Set a new key with `node dist/src/cli.js keys:generate`.
3. Restart.

New secrets use the new key; old ones still decrypt with the previous one. Keep **both** keys offline until a re-encryption job exists; that job is not yet implemented.
