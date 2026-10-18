<#
.SYNOPSIS
  Backs up the Golden Influencer platform: database, media store, bridge state and audit exports.

.DESCRIPTION
  Creates <Destination>\<yyyyMMdd-HHmmss>\ with:
    db.dump          pg_dump custom format of the platform database (role aios_migrator)
    manifest.json    what was backed up, sizes, SHA-256 of the dump, TOC entry count, schema version
  and keeps an incremental mirror of the content-addressed media store in <Destination>\media-mirror
  (files are immutable and named by hash, so the mirror only ever grows; robocopy on Windows).
  The run is recorded in ops.backup_runs (dashboard -> Ops; alert when older than BACKUP_MAX_AGE_H).

  NOT included unless -IncludeSecrets: golden.env (it holds MASTER_KEY and passwords). Keep an
  OFFLINE copy of MASTER_KEY; without it the encrypted bot and Instagram tokens cannot be restored.
  ComfyUI, its models and workflows are not touched and not backed up here (Track A owns them).

.EXAMPLE
  deploy\windows\backup.ps1 -InstallRoot D:\golden
  deploy\windows\backup.ps1 -InstallRoot D:\golden -Destination E:\golden-backups -Keep 30
#>
[CmdletBinding()]
param([string]$InstallRoot, [string]$EnvFile, [string]$Destination, [int]$Keep = 14, [switch]$SkipMedia, [switch]$IncludeSecrets, [switch]$NoRecord)
. "$PSScriptRoot\common.ps1"

$envPath = Resolve-EnvFile $EnvFile $InstallRoot
$cfg = Read-EnvFile $envPath
if (-not $Destination) {
  if (-not $InstallRoot) { Fail 'pass -Destination or -InstallRoot' }
  $Destination = Join-Path $InstallRoot 'backups'
}
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dir = Join-Path $Destination $stamp
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$manifest = [ordered]@{ started_at = (Get-Date).ToString('o'); finished_at = $null; status = 'running'; location = $dir; error = $null; host = [System.Net.Dns]::GetHostName(); database = $null; media = $null; extras = @() }

try {
  # --- Database --------------------------------------------------------------------
  Write-Step 'Dumping the database'
  $pgDump = Find-PgTool 'pg_dump'
  $pgRestore = Find-PgTool 'pg_restore'
  if (-not $pgDump -or -not $pgRestore) { Fail 'pg_dump/pg_restore (PostgreSQL 16 client tools) not found' }
  $conn = ConvertFrom-PgUrl (Get-EnvValue $cfg 'MIGRATION_DATABASE_URL')
  $dump = Join-Path $dir 'db.dump'
  $env:PGPASSWORD = $conn.Password
  try {
    & $pgDump --format=custom --compress=6 --no-password --host $conn.Host --port $conn.Port --username $conn.User --file $dump $conn.Database
    if ($LASTEXITCODE -ne 0) { Fail "pg_dump exited with $LASTEXITCODE" }
    $toc = @(& $pgRestore --list $dump | Where-Object { $_ -and -not $_.StartsWith(';') })
    if ($LASTEXITCODE -ne 0 -or $toc.Count -eq 0) { Fail 'the dump cannot be read back (pg_restore --list)' }
  } finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
  Restrict-FileToOwner $dump
  $item = Get-Item $dump
  $manifest.database = [ordered]@{ file = 'db.dump'; bytes = $item.Length; sha256 = (Get-FileSha256 $dump); toc_entries = $toc.Count; database = $conn.Database }
  Write-Ok ("db.dump {0:N1} MB, {1} TOC entries" -f ($item.Length / 1MB), $toc.Count)

  # --- Media (content-addressed, incremental mirror) ---------------------------------------
  $media = Get-EnvValue $cfg 'MEDIA_ROOT'
  if (-not $SkipMedia -and $media -and (Test-Path $media)) {
    Write-Step 'Mirroring the media store (incremental)'
    $mirror = Join-Path $Destination 'media-mirror'
    New-Item -ItemType Directory -Force -Path $mirror | Out-Null
    if ($script:IsWin) {
      # /E: copy subfolders; /XO: skip older; no /MIR so files deleted at the source stay in the mirror.
      & robocopy $media $mirror /E /XO /R:2 /W:5 /NP /NFL /NDL /NJH | Out-Null
      if ($LASTEXITCODE -ge 8) { Fail "robocopy failed with $LASTEXITCODE" }
    } else {
      Get-ChildItem -LiteralPath $media -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring((Resolve-Path $media).Path.Length).TrimStart('/', '\')
        $target = Join-Path $mirror $rel
        if (-not (Test-Path $target)) {
          New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
          Copy-Item -LiteralPath $_.FullName -Destination $target
        }
      }
    }
    $files = @(Get-ChildItem -LiteralPath $mirror -Recurse -File)
    $manifest.media = [ordered]@{ mirror = $mirror; files = $files.Count; bytes = ($files | Measure-Object Length -Sum).Sum }
    Write-Ok ("media mirror: {0} files, {1:N1} MB" -f $files.Count, ($manifest.media.bytes / 1MB))
  }

  # --- Bridge state and audit exports -------------------------------------------------------
  foreach ($pair in @(@('COMFY_BRIDGE_DATA_DIR', 'bridge'), @('AUDIT_EXPORT_DIR', 'audit'))) {
    $src = Get-EnvValue $cfg $pair[0]
    if ($src -and (Test-Path $src)) {
      $zip = Join-Path $dir "$($pair[1]).zip"
      $content = @(Get-ChildItem -LiteralPath $src -Force)
      if ($content.Count -gt 0) {
        Compress-Archive -Path (Join-Path $src '*') -DestinationPath $zip -Force
        $manifest.extras += [ordered]@{ name = $pair[1]; file = "$($pair[1]).zip"; sha256 = (Get-FileSha256 $zip) }
        Write-Ok "$($pair[1]).zip"
      }
    }
  }
  if ($IncludeSecrets) {
    Copy-Item -LiteralPath $envPath -Destination (Join-Path $dir 'golden.env')
    Restrict-FileToOwner (Join-Path $dir 'golden.env')
    Write-Warn2 'golden.env (secrets) copied: store this backup encrypted and offline'
    $manifest.extras += [ordered]@{ name = 'env'; file = 'golden.env' }
  }
  $manifest.status = 'succeeded'
} catch {
  $manifest.status = 'failed'
  $manifest.error = $_.Exception.Message
  Write-Warn2 $manifest.error
} finally {
  $manifest.finished_at = (Get-Date).ToString('o')
  $mf = Join-Path $dir 'manifest.json'
  Write-JsonFile $mf $manifest
  if (-not $NoRecord) {
    $code = Invoke-Platform $envPath 'cli.js' @('backup:record', '--manifest', $mf, '--kind', 'backup') -AllowFailure
    if ($code -ne 0) { Write-Warn2 'could not record the run in the platform (is the database up?)' }
  }
}

# --- Retention (dated backup folders only; the media mirror is kept) -----------------------------
$old = @(Get-ChildItem -LiteralPath $Destination -Directory | Where-Object { $_.Name -match '^\d{8}-\d{6}$' } | Sort-Object Name -Descending | Select-Object -Skip $Keep)
foreach ($o in $old) { Remove-Item -LiteralPath $o.FullName -Recurse -Force; Write-Note "removed old backup $($o.Name)" }

if ($manifest.status -ne 'succeeded') { exit 1 }
Write-Ok "backup complete: $dir"
