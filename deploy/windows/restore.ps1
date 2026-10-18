<#
.SYNOPSIS
  Restores a Golden Influencer backup. Default mode is a non-destructive RESTORE TEST.

.DESCRIPTION
  -Mode Test (default): restores db.dump into a new database (golden_restore_<stamp>), verifies the
     dump checksum, schema version and key row counts, records a 'restore_test' run, then drops the
     test database (unless -KeepDatabase). Production data is not touched. Run monthly.
  -Mode Replace: real recovery. Needs -Force and typing the database name. Stops the platform tasks,
     renames the current database to <db>_before_restore_<stamp> (kept for rollback), restores the
     dump under the original name, restores media from the mirror (adds missing files only), records a
     'restore' run and starts the tasks again.

  A PostgreSQL superuser URL (-PgAdminUrl, prompted if omitted) is needed to create/rename
  databases. ComfyUI and its files are never touched.

.EXAMPLE
  deploy\windows\restore.ps1 -InstallRoot D:\golden -BackupDir D:\golden\backups\20261018-020000
  deploy\windows\restore.ps1 -InstallRoot D:\golden -BackupDir ... -Mode Replace -Force
#>
[CmdletBinding()]
param(
  [string]$InstallRoot,
  [string]$EnvFile,
  [Parameter(Mandatory = $true)][string]$BackupDir,
  [ValidateSet('Test', 'Replace')][string]$Mode = 'Test',
  [string]$PgAdminUrl,
  [switch]$Force,
  [switch]$KeepDatabase,
  [switch]$NoRecord
)
. "$PSScriptRoot\common.ps1"

$envPath = Resolve-EnvFile $EnvFile $InstallRoot
$cfg = Read-EnvFile $envPath
$manifestPath = Join-Path $BackupDir 'manifest.json'
if (-not (Test-Path $manifestPath)) { Fail "no manifest.json in $BackupDir" }
$m = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($m.status -ne 'succeeded') { Fail "the backup is marked $($m.status); refusing to restore it" }
$dump = Join-Path $BackupDir $m.database.file
Write-Step 'Verifying the backup'
if ((Get-FileSha256 $dump) -ne $m.database.sha256) { Fail 'db.dump checksum does not match the manifest' }
Write-Ok 'db.dump checksum matches'

$psql = Find-PgTool 'psql'
$pgRestore = Find-PgTool 'pg_restore'
if (-not $psql -or -not $pgRestore) { Fail 'psql/pg_restore (PostgreSQL 16 client tools) not found' }
$app = ConvertFrom-PgUrl (Get-EnvValue $cfg 'MIGRATION_DATABASE_URL')
if (-not $PgAdminUrl) {
  $su = Read-Host 'PostgreSQL superuser name'
  $secure = Read-Host "Password for $su" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuth([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  $PgAdminUrl = "postgres://$([System.Uri]::EscapeDataString($su)):$([System.Uri]::EscapeDataString($plain))@$($app.Host):$($app.Port)/postgres"
}
$admin = ConvertFrom-PgUrl $PgAdminUrl
function Invoke-AdminSql([string]$Sql, [string]$Database = 'postgres') {
  $env:PGPASSWORD = $admin.Password
  try {
    $out = & $psql --no-psqlrc -v ON_ERROR_STOP=1 -At --host $admin.Host --port $admin.Port --username $admin.User --dbname $Database -c $Sql
    if ($LASTEXITCODE -ne 0) { Fail "psql failed: $Sql" }
    return $out
  } finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
}
function Restore-Into([string]$Database) {
  Invoke-AdminSql "CREATE DATABASE `"$Database`" OWNER aios_migrator" | Out-Null
  Invoke-AdminSql "REVOKE ALL ON DATABASE `"$Database`" FROM PUBLIC; GRANT CONNECT ON DATABASE `"$Database`" TO aios_app, aios_worker" | Out-Null
  $env:PGPASSWORD = $admin.Password
  try {
    & $pgRestore --exit-on-error --no-password --host $admin.Host --port $admin.Port --username $admin.User --dbname $Database --jobs 4 $dump
    if ($LASTEXITCODE -ne 0) { Fail "pg_restore into $Database failed ($LASTEXITCODE)" }
  } finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
}
function Get-Checks([string]$Database) {
  $sql = @"
SELECT json_build_object(
  'schema_version', (SELECT max(version) FROM public.schema_migrations),
  'workspaces', (SELECT count(*) FROM core.workspaces),
  'influencers', (SELECT count(*) FROM identity.influencers),
  'fans', (SELECT count(*) FROM crm.fans),
  'messages', (SELECT count(*) FROM conversation.messages),
  'payments', (SELECT count(*) FROM monetization.payments),
  'media_assets', (SELECT count(*) FROM content.media_assets),
  'audit_rows', (SELECT count(*) FROM core.audit_log),
  'audit_seals', (SELECT count(*) FROM core.audit_seals))
"@
  return (Invoke-AdminSql $sql $Database) | ConvertFrom-Json
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$run = [ordered]@{ started_at = (Get-Date).ToString('o'); finished_at = $null; status = 'running'; location = $BackupDir; error = $null; mode = $Mode; checks = $null; backup_manifest = $m }
$kind = if ($Mode -eq 'Test') { 'restore_test' } else { 'restore' }
try {
  if ($Mode -eq 'Test') {
    $target = "$($app.Database)_restore_$stamp"
    Write-Step "Restoring into a NEW database $target (production untouched)"
    Restore-Into $target
    $run.checks = Get-Checks $target
    Write-Ok ("schema {0}; {1} influencers, {2} fans, {3} messages, {4} payments, {5} media assets" -f $run.checks.schema_version, $run.checks.influencers, $run.checks.fans, $run.checks.messages, $run.checks.payments, $run.checks.media_assets)
    if (-not $KeepDatabase) { Invoke-AdminSql "DROP DATABASE `"$target`"" | Out-Null; Write-Ok "dropped $target" } else { Write-Note "kept $target for inspection" }
  } else {
    if (-not $Force) { Fail 'Replace mode needs -Force' }
    $confirm = Read-Host "Type the database name ($($app.Database)) to replace it with the backup from $($m.started_at)"
    if ($confirm -ne $app.Database) { Fail 'confirmation did not match' }
    if ($script:IsWin) {
      foreach ($t in @('GoldenInfluencer-Platform', 'GoldenInfluencer-ComfyBridge')) { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
      Write-Ok 'platform tasks stopped'
    }
    Invoke-AdminSql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$($app.Database)' AND pid <> pg_backend_pid()" | Out-Null
    $previous = "$($app.Database)_before_restore_$stamp"
    Invoke-AdminSql "ALTER DATABASE `"$($app.Database)`" RENAME TO `"$previous`"" | Out-Null
    Write-Ok "current database kept as $previous (drop it once the restore is confirmed)"
    Restore-Into $app.Database
    $run.checks = Get-Checks $app.Database
    # The dump is taken before its own backup run is recorded, so the restored database does not
    # know about the backup it came from; record it again so backup-age monitoring stays correct.
    if (-not $NoRecord) { Invoke-Platform $envPath 'cli.js' @('backup:record', '--manifest', $manifestPath, '--kind', 'backup') -AllowFailure | Out-Null }
    if ($m.media -and $m.media.mirror -and (Test-Path $m.media.mirror)) {
      $media = Get-EnvValue $cfg 'MEDIA_ROOT'
      Write-Step "Restoring missing media files into $media"
      if ($script:IsWin) { & robocopy $m.media.mirror $media /E /XC /XN /XO /R:2 /W:5 /NP /NFL /NDL /NJH | Out-Null }
      else { Copy-Item -Path (Join-Path $m.media.mirror '*') -Destination $media -Recurse -Force }
    }
    if ($script:IsWin) { foreach ($t in @('GoldenInfluencer-Platform', 'GoldenInfluencer-ComfyBridge')) { Start-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue } }
    Write-Ok "restored; schema $($run.checks.schema_version). Run migrate.ps1 if this backup predates the installed code, then health-check.ps1."
  }
  $run.status = 'succeeded'
} catch {
  $run.status = 'failed'
  $run.error = $_.Exception.Message
  Write-Warn2 $run.error
} finally {
  $run.finished_at = (Get-Date).ToString('o')
  $out = Join-Path $BackupDir "$kind-$stamp.json"
  Write-JsonFile $out $run
  if (-not $NoRecord) {
    $code = Invoke-Platform $envPath 'cli.js' @('backup:record', '--manifest', $out, '--kind', $kind) -AllowFailure
    if ($code -ne 0) { Write-Warn2 'could not record the run in the platform' }
  }
}
if ($run.status -ne 'succeeded') { exit 1 }
