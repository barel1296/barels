<#
.SYNOPSIS
  Installs the Golden Influencer platform on the Windows workstation (idempotent).

.DESCRIPTION
  1. Checks prerequisites (Node.js >= 22.12, npm; PostgreSQL 16 tools or Docker).
  2. Creates the data folders under -InstallRoot (config, media, backups, bridge, packages, logs, evidence, audit).
  3. Creates <InstallRoot>\config\golden.env from ops\env.example if it does not exist,
     fills in paths and generates secrets that are still empty. Existing values are never overwritten.
  4. Installs dependencies and builds the platform (npm ci, npm run build).
  5. Prepares PostgreSQL: -Postgres docker (ops\docker-compose.yml), native (db:bootstrap with a
     superuser URL) or existing (roles and database already exist).
  6. Applies migrations and creates upcoming partitions.
  7. Optionally creates the workspace and its owner (password + TOTP enrolment).

  It does NOT install, modify or touch ComfyUI, its models, custom nodes or workflows. ComfyUI is
  only discovered later (discover-comfyui.ps1, read-only). It does not start services
  (register-services.ps1) and does not deploy anything to production.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -InstallRoot D:\golden -Postgres native -PgAdminUrl postgres://postgres@127.0.0.1:5432/postgres -OwnerEmail you@example.com -OwnerName "Your Name"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [ValidateSet('docker', 'native', 'existing')][string]$Postgres = 'native',
  # Superuser connection for -Postgres native (prompted if omitted). Not stored.
  [string]$PgAdminUrl,
  [switch]$SkipBuild,
  [string]$OwnerEmail,
  [string]$OwnerName,
  [string]$WorkspaceSlug = 'studio',
  [string]$WorkspaceName = 'Golden Studio'
)
. "$PSScriptRoot\common.ps1"

$repo = Get-RepoRoot
$platform = Get-PlatformDir

# --- 1. Prerequisites -------------------------------------------------------------
Write-Step 'Checking prerequisites'
if (-not (Test-CommandExists 'node')) { Fail 'Node.js 22.12 or newer is required (https://nodejs.org); install the LTS build and reopen the shell' }
$nodeVersion = (& node --version).TrimStart('v')
$parts = $nodeVersion.Split('.') | ForEach-Object { [int]$_ }
if ($parts[0] -lt 22 -or ($parts[0] -eq 22 -and $parts[1] -lt 12)) { Fail "Node.js $nodeVersion found; 22.12 or newer is required (node --env-file and the test runner depend on it)" }
Write-Ok "Node.js $nodeVersion"
if (-not (Test-CommandExists 'npm')) { Fail 'npm not found (it ships with Node.js)' }
if ($Postgres -eq 'docker') {
  if (-not (Test-CommandExists 'docker')) { Fail 'Docker Desktop is required for -Postgres docker' }
  Write-Ok 'Docker found'
}
$pgDump = Find-PgTool 'pg_dump'
if ($pgDump) { Write-Ok "PostgreSQL client tools: $(Split-Path $pgDump)" } else { Write-Warn2 'pg_dump/pg_restore not found: backups need the PostgreSQL 16 client tools on PATH' }

# --- 2. Folders ---------------------------------------------------------------------
Write-Step "Creating folders under $InstallRoot"
$dirs = [ordered]@{}
foreach ($name in @('config', 'media', 'backups', 'bridge', 'packages', 'logs', 'evidence', 'audit')) {
  $d = Join-Path $InstallRoot $name
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  $dirs[$name] = (Resolve-Path $d).Path
}
Write-Ok ($dirs.Values -join ', ')

# --- 3. Environment file -----------------------------------------------------------------
$envFile = Join-Path $dirs.config 'golden.env'
Write-Step "Preparing $envFile"
if (-not (Test-Path $envFile)) {
  Copy-Item -LiteralPath (Join-Parts @($repo, 'ops', 'env.example')) -Destination $envFile
  Write-Ok 'created from ops/env.example'
} else {
  Write-Note 'exists; only empty values are filled in'
}
$cfg = Read-EnvFile $envFile
function Set-IfEmpty([string]$Key, [string]$Value, [switch]$Secret) {
  if ((Get-EnvValue $script:cfg $Key) -eq '') {
    Set-EnvValue $envFile $Key $Value
    $script:cfg[$Key] = $Value
    if ($Secret) { Write-Ok "$Key generated" } else { Write-Ok "$Key = $Value" }
  }
}
Set-IfEmpty 'MEDIA_ROOT' ($dirs.media -replace '\\', '/')
Set-IfEmpty 'AUDIT_EXPORT_DIR' ($dirs.audit -replace '\\', '/')
Set-IfEmpty 'COMFY_BRIDGE_DATA_DIR' ($dirs.bridge -replace '\\', '/')
Set-IfEmpty 'COMFY_BRIDGE_PACKAGES_DIR' ($dirs.packages -replace '\\', '/')
Set-IfEmpty 'NODE_NAME' ([System.Net.Dns]::GetHostName())
Set-IfEmpty 'NODE_EXE' ((Get-Command node).Source -replace '\\', '/')
Set-IfEmpty 'MASTER_KEY' (New-Secret 32) -Secret
Set-IfEmpty 'ASSET_URL_SECRET' (New-Secret 32) -Secret
Set-IfEmpty 'INVOICE_SECRET' (New-Secret 32) -Secret
Set-IfEmpty 'VEC_ENGINE_TOKEN' (New-UrlSafeToken 32) -Secret
Set-IfEmpty 'METRICS_TOKEN' (New-UrlSafeToken 24) -Secret
foreach ($k in @('PG_SUPERUSER_PASSWORD', 'PG_MIGRATOR_PASSWORD', 'PG_APP_PASSWORD', 'PG_WORKER_PASSWORD')) {
  if ($Postgres -eq 'existing' -and $k -ne 'PG_SUPERUSER_PASSWORD') { continue }
  if ($Postgres -ne 'docker' -and $k -eq 'PG_SUPERUSER_PASSWORD') { continue }
  Set-IfEmpty $k (New-UrlSafeToken 24) -Secret
}
$pgHost = Get-EnvValue $cfg 'PG_HOST' '127.0.0.1'
$pgPort = Get-EnvValue $cfg 'PG_PORT' '5432'
$db = Get-EnvValue $cfg 'GOLDEN_DB' 'golden'
foreach ($pair in @(@('DATABASE_URL', 'aios_app', 'PG_APP_PASSWORD'), @('WORKER_DATABASE_URL', 'aios_worker', 'PG_WORKER_PASSWORD'), @('MIGRATION_DATABASE_URL', 'aios_migrator', 'PG_MIGRATOR_PASSWORD'))) {
  $current = Get-EnvValue $cfg $pair[0]
  $pw = Get-EnvValue $cfg $pair[2]
  if (($current -eq '' -or $current -match 'CHANGE_ME') -and $pw -ne '') {
    $url = "postgres://$($pair[1]):$([System.Uri]::EscapeDataString($pw))@${pgHost}:$pgPort/$db"
    Set-EnvValue $envFile $pair[0] $url
    $cfg[$pair[0]] = $url
    Write-Ok "$($pair[0]) set (role $($pair[1]))"
  } elseif ($current -match 'CHANGE_ME') {
    Write-Warn2 "$($pair[0]) still contains CHANGE_ME: set the $($pair[1]) password in $envFile"
  }
}
Restrict-FileToOwner $envFile
Write-Ok 'env file readable only by this account, SYSTEM and Administrators'

# --- 4. Build ----------------------------------------------------------------------------
if (-not $SkipBuild) {
  Write-Step 'Installing dependencies and building (npm ci, npm run build)'
  Push-Location $platform
  try {
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Fail 'npm ci' }
    & npm run build
    if ($LASTEXITCODE -ne 0) { Fail 'npm run build' }
  } finally { Pop-Location }
  Write-Ok 'built apps/platform/dist'
}

# --- 5. PostgreSQL ------------------------------------------------------------------------
Write-Step "Preparing PostgreSQL ($Postgres)"
if ($Postgres -eq 'docker') {
  & docker compose -f (Join-Parts @($repo, 'ops', 'docker-compose.yml')) --env-file $envFile up -d
  if ($LASTEXITCODE -ne 0) { Fail 'docker compose up' }
  $deadline = (Get-Date).AddMinutes(2)
  while (-not (Test-TcpPort $pgHost ([int]$pgPort))) {
    if ((Get-Date) -gt $deadline) { Fail "PostgreSQL did not open ${pgHost}:$pgPort" }
    Start-Sleep -Seconds 2
  }
  Start-Sleep -Seconds 3
  Write-Ok 'PostgreSQL container up (roles and database are created on first start)'
} elseif ($Postgres -eq 'native') {
  if (-not (Test-TcpPort $pgHost ([int]$pgPort))) { Fail "PostgreSQL is not listening on ${pgHost}:$pgPort; install PostgreSQL 16 and start its service first" }
  if (-not $PgAdminUrl) {
    $su = Read-Host 'PostgreSQL superuser name' -ErrorAction Stop
    $secure = Read-Host "Password for $su" -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuth([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    $PgAdminUrl = "postgres://$([System.Uri]::EscapeDataString($su)):$([System.Uri]::EscapeDataString($plain))@${pgHost}:$pgPort/postgres"
  }
  $env:PG_ADMIN_URL = $PgAdminUrl
  try {
    Invoke-Platform $envFile 'cli.js' @('db:bootstrap', '--database', $db) | Out-Null
  } finally { Remove-Item Env:\PG_ADMIN_URL -ErrorAction SilentlyContinue }
  Write-Ok 'roles aios_migrator / aios_app / aios_worker and the database are ready'
} else {
  Write-Note 'using the existing roles and database from golden.env'
}

# --- 6. Migrations ---------------------------------------------------------------------------
Write-Step 'Applying migrations'
Invoke-Platform $envFile 'cli.js' @('db:migrate') | Out-Null
Invoke-Platform $envFile 'cli.js' @('db:maintain', '--months', '3') | Out-Null
Write-Ok 'schema up to date; partitions for the next 3 months exist'

# --- 7. Owner -----------------------------------------------------------------------------------
if ($OwnerEmail) {
  if (-not $OwnerName) { $OwnerName = $OwnerEmail }
  Write-Step "Creating workspace '$WorkspaceSlug' and owner $OwnerEmail"
  $code = Invoke-Platform $envFile 'cli.js' @('workspace:create', '--slug', $WorkspaceSlug, '--name', $WorkspaceName, '--owner-email', $OwnerEmail, '--owner-name', $OwnerName, '--platform-admin') -AllowFailure
  if ($code -ne 0) { Write-Warn2 'workspace:create failed (it may already exist); continuing with the credentials step' }
  # Unattended installs may pass the password in GI_NEW_PASSWORD; otherwise it is prompted for.
  if (-not $env:GI_NEW_PASSWORD) {
    $secure = Read-Host "Choose a password for $OwnerEmail (min 12 characters)" -AsSecureString
    $env:GI_NEW_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuth([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  }
  try {
    Invoke-Platform $envFile 'cli.js' @('user:set-password', '--email', $OwnerEmail) | Out-Null
  } finally { Remove-Item Env:\GI_NEW_PASSWORD -ErrorAction SilentlyContinue }
  Write-Note 'Store the owner API token printed above; scan the otpauth URI below with an authenticator app (both shown once):'
  Invoke-Platform $envFile 'cli.js' @('user:enroll-totp', '--email', $OwnerEmail) | Out-Null
}

Write-Step 'Done'
Write-Host @"

Next steps (see deploy\windows\README.md):
  1. Discover the existing ComfyUI (read-only):   deploy\windows\discover-comfyui.ps1 -InstallRoot "$InstallRoot" -WriteEnv
  2. Set up the local LLM and put LLM_BASE_URL / LLM_CHAT_MODEL in $envFile (deploy\windows\LOCAL-LLM.md)
  3. Register and start the services:            deploy\windows\register-services.ps1 -InstallRoot "$InstallRoot"
  4. Check health:                               deploy\windows\health-check.ps1 -InstallRoot "$InstallRoot"
  5. Run the acceptance tests on the hardware:   deploy\windows\integration-test.ps1 -InstallRoot "$InstallRoot"
  Back up MASTER_KEY from $envFile OFFLINE now: without it no stored credential can be decrypted.
"@
