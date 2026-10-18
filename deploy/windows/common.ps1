# Shared helpers for the Golden Influencer Windows deployment scripts.
# Compatible with Windows PowerShell 5.1 and PowerShell 7. Dot-source it:
#   . "$PSScriptRoot\common.ps1"

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

$script:IsWin = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
# Windows PowerShell 5.1 writes UTF-16 for > and >>; keep every log and report UTF-8.
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
# Node writes UTF-8; Windows PowerShell 5.1 would decode it with the OEM code page.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Get-RepoRoot { (Resolve-Path (Join-Path (Join-Path $PSScriptRoot '..') '..')).Path }
function Get-PlatformDir { Join-Path (Join-Path (Get-RepoRoot) 'apps') 'platform' }
function Join-Parts([string[]]$Parts) {
  $p = $Parts[0]
  for ($i = 1; $i -lt $Parts.Length; $i++) { $p = Join-Path $p $Parts[$i] }
  return $p
}

# .NET file APIs resolve relative paths against the process directory, not the PowerShell location.
function Get-FullPath([string]$Path) { return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path) }

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    OK  $Message" -ForegroundColor Green }
function Write-Note([string]$Message) { Write-Host "    ..  $Message" -ForegroundColor Gray }
function Write-Warn2([string]$Message) { Write-Host "    !!  $Message" -ForegroundColor Yellow }
function Fail([string]$Message) { throw "FAILED: $Message" }

# Windows PowerShell 5.1 turns redirected native stderr (2>&1, *>, 2>$null) into error records, which
# $ErrorActionPreference = 'Stop' makes fatal. Run such commands through this; returns their output.
function Invoke-Tolerant([scriptblock]$Block) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block } finally { $ErrorActionPreference = $saved }
}

# A property's value, or $null when it is absent (Set-StrictMode makes a missing property an
# error, and ComfyUI versions report different fields).
function Get-Prop($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $p = $Object.PSObject.Properties[$Name]
  if ($p) { return $p.Value }
  return $null
}

function Test-CommandExists([string]$Name) { return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue) }

function Resolve-EnvFile([string]$EnvFile, [string]$InstallRoot) {
  if ($EnvFile) { return (Resolve-Path $EnvFile).Path }
  if ($InstallRoot) { return (Join-Parts @($InstallRoot, 'config', 'golden.env')) }
  if ($env:GOLDEN_ENV_FILE) { return $env:GOLDEN_ENV_FILE }
  Fail 'pass -InstallRoot or -EnvFile (or set GOLDEN_ENV_FILE)'
}

# Reads KEY=VALUE lines (comments and blanks ignored) into an ordered hashtable.
function Read-EnvFile([string]$Path) {
  $map = [ordered]@{}
  if (-not (Test-Path $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $k = $t.Substring(0, $i).Trim()
    $v = $t.Substring($i + 1).Trim()
    if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) { $v = $v.Substring(1, $v.Length - 2) }
    $map[$k] = $v
  }
  return $map
}

function Get-EnvValue($Map, [string]$Key, [string]$Default = '') {
  if ($Map.Contains($Key) -and $Map[$Key] -ne '') { return [string]$Map[$Key] }
  return $Default
}

# Sets KEY=VALUE in the env file: replaces the active line, else a commented "# KEY=" line, else appends.
function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
  $lines = New-Object System.Collections.Generic.List[string]
  if (Test-Path $Path) { foreach ($l in Get-Content -LiteralPath $Path -Encoding UTF8) { $lines.Add([string]$l) } }
  $k = [regex]::Escape($Key)
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match ('^\s*' + $k + '=')) { $idx = $i; break } }
  if ($idx -lt 0) { for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match ('^\s*#\s*' + $k + '=')) { $idx = $i; break } } }
  if ($idx -ge 0) { $lines[$idx] = "$Key=$Value" } else { $lines.Add("$Key=$Value") }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines((Get-FullPath $Path), $lines.ToArray(), $utf8)
}

function New-Secret([int]$Bytes = 32) {
  $buf = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($buf)
  $rng.Dispose()
  return [Convert]::ToBase64String($buf)
}

function New-UrlSafeToken([int]$Bytes = 32) {
  return (New-Secret $Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# The Node.js executable recorded by install.ps1 (NODE_EXE), so services and scripts use the version
# that was checked even when the service account's PATH differs; falls back to PATH.
function Get-NodeExe($Map) {
  $n = Get-EnvValue $Map 'NODE_EXE'
  if ($n -and (Test-Path -LiteralPath $n)) { return $n }
  return 'node'
}

# Runs a built platform entry point with the env file: node --env-file=<file> dist/src/<script> <args>.
# Its output goes to the console (never into the caller's pipeline); returns only the exit code.
function Invoke-Platform([string]$EnvFile, [string]$Script, [string[]]$Arguments = @(), [switch]$AllowFailure) {
  $platform = Get-PlatformDir
  $entry = Join-Parts @($platform, 'dist', 'src', $Script)
  if (-not (Test-Path $entry)) { Fail "$entry not found; run the build (install.ps1, or npm run build in apps/platform)" }
  $node = Get-NodeExe (Read-EnvFile $EnvFile)
  Push-Location $platform
  try {
    & $node "--env-file=$EnvFile" $entry @Arguments | Out-Host
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  if ($code -ne 0 -and -not $AllowFailure) { Fail "node $Script $($Arguments -join ' ') exited with $code" }
  return $code
}

function Invoke-Http([string]$Url, [hashtable]$Headers = @{}, [int]$TimeoutSec = 10, [string]$Method = 'GET', $Body = $null) {
  try {
    $params = @{ Uri = $Url; Method = $Method; Headers = $Headers; TimeoutSec = $TimeoutSec; UseBasicParsing = $true }
    if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress); $params.ContentType = 'application/json' }
    $r = Invoke-WebRequest @params
    $json = $null
    try { $json = $r.Content | ConvertFrom-Json } catch { $json = $null }
    return [pscustomobject]@{ ok = $true; status = [int]$r.StatusCode; json = $json; error = $null }
  } catch {
    $status = $null
    try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = $null }
    # The API's error body ({"error":{"code","message"}}) says why; keep it.
    $message = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $message = $_.ErrorDetails.Message
      try { $e = ($_.ErrorDetails.Message | ConvertFrom-Json).error; if ($e) { $message = "$($e.code): $($e.message)" } } catch { }
    }
    return [pscustomobject]@{ ok = $false; status = $status; json = $null; error = $message }
  }
}

function Test-TcpPort([string]$HostName, [int]$Port, [int]$TimeoutMs = 1500) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync($HostName, $Port)
    return ($task.Wait($TimeoutMs) -and $client.Connected)
  } catch { return $false } finally { $client.Dispose() }
}

# JSON without a byte-order mark (Windows PowerShell 5.1's Out-File -Encoding utf8 adds one, which
# Node's JSON.parse rejects).
function Write-JsonFile([string]$Path, $Object, [int]$Depth = 10) {
  $text = ($Object | ConvertTo-Json -Depth $Depth) + "`n"
  [System.IO.File]::WriteAllText((Get-FullPath $Path), $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-FileSha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

# Parses postgres://user:pass@host:port/db into parts (for pg_dump/pg_restore environment).
function ConvertFrom-PgUrl([string]$Url) {
  $u = [System.Uri]$Url
  $user, $pass = $u.UserInfo.Split(':', 2)
  return [pscustomobject]@{
    Host = $u.Host
    Port = if ($u.Port -gt 0) { $u.Port } else { 5432 }
    User = [System.Uri]::UnescapeDataString($user)
    Password = if ($pass) { [System.Uri]::UnescapeDataString($pass) } else { '' }
    Database = $u.AbsolutePath.TrimStart('/')
  }
}

# Every installed copy of a PostgreSQL client tool: PATH first, then Program Files\PostgreSQL\<version>\bin.
function Get-PgToolCandidates([string]$Name) {
  $found = New-Object System.Collections.Generic.List[string]
  foreach ($cmd in @(Get-Command $Name -All -CommandType Application -ErrorAction SilentlyContinue)) { if (-not $found.Contains($cmd.Source)) { $found.Add($cmd.Source) } }
  if ($script:IsWin) {
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
      if (-not $base) { continue }
      foreach ($c in @(Get-ChildItem -Path (Join-Path $base 'PostgreSQL') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
        $exe = Join-Parts @($c.FullName, 'bin', "$Name.exe")
        if ((Test-Path $exe) -and -not $found.Contains($exe)) { $found.Add($exe) }
      }
    }
  }
  return $found.ToArray()
}

function Get-PgToolMajor([string]$Exe) {
  $v = "$(Invoke-Tolerant { & $Exe --version 2>$null })"
  if ($v -match '(\d+)\.\d+') { return [int]$Matches[1] }
  return 0
}

# A client tool for a server of major version $ServerMajor: the same major if installed, else the
# nearest newer one (an older pg_dump refuses a newer server; a newer pg_restore can emit settings an
# older server rejects). Without $ServerMajor: the first one found.
function Find-PgTool([string]$Name, [int]$ServerMajor = 0) {
  $all = @(Get-PgToolCandidates $Name)
  if ($all.Count -eq 0) { return $null }
  if ($ServerMajor -le 0) { return $all[0] }
  $tools = @($all | ForEach-Object { [pscustomobject]@{ path = $_; major = (Get-PgToolMajor $_) } })
  $same = @($tools | Where-Object { $_.major -eq $ServerMajor })
  if ($same.Count) { return $same[0].path }
  $newer = @($tools | Where-Object { $_.major -gt $ServerMajor } | Sort-Object major)
  if ($newer.Count) { return $newer[0].path }
  return $all[0]
}

# Major version of the server behind a ConvertFrom-PgUrl connection (0 if it cannot be read).
function Get-PgServerMajor($Conn) {
  $psql = Find-PgTool 'psql'
  if (-not $psql) { return 0 }
  $env:PGPASSWORD = $Conn.Password
  try {
    $n = "$(Invoke-Tolerant { & $psql --no-psqlrc -At --host $Conn.Host --port $Conn.Port --username $Conn.User --dbname $Conn.Database -c 'SHOW server_version_num' 2>$null })".Trim()
  } finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
  if ($n -match '^\d+$') { return [int][math]::Floor([int]$n / 10000) }
  return 0
}

# Stops node processes started with this env file (platform, bridge): stopping a scheduled task can
# leave its child process running. Windows only (uses the process command lines).
function Stop-InstallProcesses([string]$EnvPath) {
  if (-not $script:IsWin) { return 0 }
  $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($EnvPath) })
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  return $procs.Count
}

function Restrict-FileToOwner([string]$Path) {
  if (-not $script:IsWin) { & chmod 600 $Path; return }
  # Remove inherited permissions; keep the current user, SYSTEM and Administrators.
  & icacls $Path /inheritance:r /grant:r "$($env:USERNAME):(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
}
