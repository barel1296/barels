<#
.SYNOPSIS
  Runs one Golden Influencer process in the foreground with daily log files. Used by the scheduled
  tasks that register-services.ps1 creates; can also be run by hand for troubleshooting.

.PARAMETER Service
  platform      API + background worker (apps/platform/dist/src/main.js)
  comfy-bridge  VEC v1 bridge in front of the existing ComfyUI (only when COMFYUI_URL is set)
  llm           optional native llama.cpp server (LLM_SERVER_EXE + LLM_MODEL_PATH), listening on
                the host/port of LLM_BASE_URL and serving the model under the LLM_CHAT_MODEL name
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('platform', 'comfy-bridge', 'llm')][string]$Service,
  [string]$InstallRoot,
  [string]$EnvFile
)
. "$PSScriptRoot\common.ps1"
$envPath = Resolve-EnvFile $EnvFile $InstallRoot
$cfg = Read-EnvFile $envPath
$logDir = if ($InstallRoot) { Join-Path $InstallRoot 'logs' } else { Join-Path (Split-Path (Split-Path $envPath)) 'logs' }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("{0}-{1}.log" -f $Service, (Get-Date -Format 'yyyyMMdd'))

$platform = Get-PlatformDir
$exe = 'node'
if ($Service -eq 'platform') {
  $args2 = @("--env-file=$envPath", (Join-Parts @($platform, 'dist', 'src', 'main.js')))
} elseif ($Service -eq 'comfy-bridge') {
  if ((Get-EnvValue $cfg 'COMFYUI_URL') -eq '') { Fail 'COMFYUI_URL is not set; run discover-comfyui.ps1 first' }
  $args2 = @("--env-file=$envPath", (Join-Parts @($platform, 'dist', 'src', 'comfy-bridge', 'main.js')), 'serve')
} else {
  $exe = Get-EnvValue $cfg 'LLM_SERVER_EXE'
  $modelPath = Get-EnvValue $cfg 'LLM_MODEL_PATH'
  $baseUrl = Get-EnvValue $cfg 'LLM_BASE_URL'
  $alias = Get-EnvValue $cfg 'LLM_CHAT_MODEL'
  if (-not $exe -or -not (Test-Path $exe)) { Fail 'LLM_SERVER_EXE is not set or does not exist (see LOCAL-LLM.md)' }
  if (-not $modelPath -or -not (Test-Path $modelPath)) { Fail 'LLM_MODEL_PATH is not set or does not exist' }
  if (-not $baseUrl -or -not $alias) { Fail 'LLM_BASE_URL and LLM_CHAT_MODEL must be set' }
  $u = [System.Uri]$baseUrl
  $args2 = @('-m', $modelPath, '--host', $u.Host, '--port', "$($u.Port)", '--alias', $alias, '--jinja',
    '-c', (Get-EnvValue $cfg 'LLM_SERVER_CTX' '8192'), '-np', (Get-EnvValue $cfg 'LLM_SERVER_PARALLEL' '2'),
    '-ngl', (Get-EnvValue $cfg 'LLM_SERVER_GPU_LAYERS' '999'))
  $key = Get-EnvValue $cfg 'LLM_API_KEY'
  if ($key) { $args2 += @('--api-key', $key) }
  $extra = Get-EnvValue $cfg 'LLM_SERVER_EXTRA_ARGS'
  if ($extra) { $args2 += @($extra -split '\s+' | Where-Object { $_ }) }
}
"[{0}] starting {1}" -f (Get-Date -Format o), $Service | Out-File -FilePath $log -Append -Encoding utf8
Push-Location $platform
try {
  Invoke-Tolerant { & $exe @args2 *>> $log }
  $code = $LASTEXITCODE
} finally { Pop-Location }
"[{0}] {1} exited with {2}" -f (Get-Date -Format o), $Service, $code | Out-File -FilePath $log -Append -Encoding utf8
# Old logs are kept for 30 days.
Get-ChildItem $logDir -Filter "$Service-*.log" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -ErrorAction SilentlyContinue
exit $code
