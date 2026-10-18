<#
.SYNOPSIS
  Checks every Golden Influencer service on the workstation and exits non-zero if a critical one fails.

.DESCRIPTION
  PostgreSQL port, platform /healthz and /readyz, detailed component health (migrations, engines,
  LLM, jobs, backups), /metrics, ComfyUI bridge /vec/v1/health, ComfyUI /system_stats (read-only)
  local LLM /models, GPU (nvidia-smi), free disk on the data drive.
  Only reads; never restarts or changes anything.

.EXAMPLE
  deploy\windows\health-check.ps1 -InstallRoot D:\golden
  deploy\windows\health-check.ps1 -InstallRoot D:\golden -Json > health.json
#>
[CmdletBinding()]
param([string]$InstallRoot, [string]$EnvFile, [switch]$Json, [int]$MinFreeGB = 50)
. "$PSScriptRoot\common.ps1"

$envPath = Resolve-EnvFile $EnvFile $InstallRoot
$cfg = Read-EnvFile $envPath
$results = New-Object System.Collections.Generic.List[object]
function Add-Result([string]$Name, [string]$Status, [string]$Detail, [switch]$Critical) {
  $results.Add([pscustomobject]@{ check = $Name; status = $Status; critical = [bool]$Critical; detail = $Detail })
}

# PostgreSQL
$pgHost = Get-EnvValue $cfg 'PG_HOST' '127.0.0.1'
$pgPort = [int](Get-EnvValue $cfg 'PG_PORT' '5432')
if (Test-TcpPort $pgHost $pgPort) { Add-Result 'postgresql' 'ok' "${pgHost}:$pgPort listening" -Critical } else { Add-Result 'postgresql' 'down' "${pgHost}:$pgPort not reachable" -Critical }

# Platform API
$httpHost = Get-EnvValue $cfg 'HTTP_HOST' '127.0.0.1'
if ($httpHost -eq '0.0.0.0') { $httpHost = '127.0.0.1' }
$base = "http://${httpHost}:$(Get-EnvValue $cfg 'HTTP_PORT' '8080')"
$hz = Invoke-Http "$base/healthz"
Add-Result 'platform_api' $(if ($hz.ok) { 'ok' } else { 'down' }) $(if ($hz.ok) { $base } else { "$base/healthz: $($hz.error)" }) -Critical
$rz = Invoke-Http "$base/readyz"
Add-Result 'platform_ready' $(if ($rz.ok) { 'ok' } else { 'degraded' }) $(if ($rz.json) { ($rz.json | ConvertTo-Json -Compress -Depth 5) } else { $rz.error })
$mt = Get-EnvValue $cfg 'METRICS_TOKEN'
if ($mt) {
  $m = Invoke-Http "$base/metrics" @{ Authorization = "Bearer $mt" }
  Add-Result 'metrics' $(if ($m.ok) { 'ok' } else { 'degraded' }) $(if ($m.ok) { 'Prometheus metrics served' } else { $m.error })
}

# Detailed component report from the platform (database, migrations, engines, LLM, jobs, backups).
try {
  Push-Location (Get-PlatformDir)
  try { $raw = Invoke-Tolerant { & (Get-NodeExe $cfg) "--env-file=$envPath" (Join-Parts @('dist', 'src', 'cli.js')) health 2>$null | Out-String } } finally { Pop-Location }
  $h = $raw | ConvertFrom-Json
  foreach ($p in $h.components.PSObject.Properties) {
    $st = [string]$p.Value.status
    $crit = @('database', 'migrations') -contains $p.Name
    $detail = if ($p.Value.PSObject.Properties['detail']) { $p.Value.detail | ConvertTo-Json -Compress -Depth 6 } else { '' }
    Add-Result "component:$($p.Name)" $st $detail -Critical:$crit
  }
} catch { Add-Result 'component_report' 'unknown' "cli health failed: $($_.Exception.Message)" }

# ComfyUI bridge and ComfyUI itself (read-only)
$token = Get-EnvValue $cfg 'VEC_ENGINE_TOKEN'
$comfy = Get-EnvValue $cfg 'COMFYUI_URL'
if ($comfy) {
  $bridge = "http://$(Get-EnvValue $cfg 'COMFY_BRIDGE_HOST' '127.0.0.1'):$(Get-EnvValue $cfg 'COMFY_BRIDGE_PORT' '8190')/vec/v1/health"
  $b = Invoke-Http $bridge @{ Authorization = "Bearer $token" }
  Add-Result 'comfy_bridge' $(if ($b.ok) { 'ok' } else { 'down' }) $(if ($b.ok) { "ComfyUI $(Get-Prop $b.json 'comfyui_version')" } else { "$bridge : $($b.error)" })
  $s = Invoke-Http "$comfy/system_stats"
  if ($s.ok -and (Get-Prop $s.json 'devices')) {
    $d = @($s.json.devices)[0]
    Add-Result 'comfyui' 'ok' ("{0}; VRAM free {1} / {2} MB" -f (Get-Prop $d 'name'), [math]::Round([double](Get-Prop $d 'vram_free') / 1MB), [math]::Round([double](Get-Prop $d 'vram_total') / 1MB))
  } else { Add-Result 'comfyui' 'down' "$comfy/system_stats: $($s.error)" }
} else { Add-Result 'comfyui' 'not_configured' 'COMFYUI_URL is empty (run discover-comfyui.ps1)' }

# Local LLM
$llm = Get-EnvValue $cfg 'LLM_BASE_URL'
if ($llm) {
  $hdr = @{}
  $key = Get-EnvValue $cfg 'LLM_API_KEY'
  if ($key) { $hdr.Authorization = "Bearer $key" }
  $l = Invoke-Http "$llm/models" $hdr
  $model = Get-EnvValue $cfg 'LLM_CHAT_MODEL'
  if ($l.ok) {
    $ids = @($l.json.data | ForEach-Object { $_.id })
    if ($ids -contains $model) { Add-Result 'llm' 'ok' "$model served at $llm" } else { Add-Result 'llm' 'degraded' "$llm answers but does not list LLM_CHAT_MODEL=$model (lists: $($ids -join ', '))" }
  } else { Add-Result 'llm' 'down' "$llm/models: $($l.error)" }
} else { Add-Result 'llm' 'not_configured' 'LLM_BASE_URL is empty: AI replies and agents are off' }

# GPU
if (Test-CommandExists 'nvidia-smi') {
  try {
    $line = (Invoke-Tolerant { & nvidia-smi --query-gpu=name,memory.used,memory.total,temperature.gpu,utilization.gpu --format=csv,noheader,nounits 2>$null } | Select-Object -First 1)
    $f = $line.Split(',') | ForEach-Object { $_.Trim() }
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    $pct = [math]::Round(100 * [double]::Parse($f[1], $inv) / [double]::Parse($f[2], $inv))
    $status = if ([double]::Parse($f[3], $inv) -ge [double](Get-EnvValue $cfg 'GPU_ALERT_TEMP_C' '87') -or $pct -ge [double](Get-EnvValue $cfg 'GPU_ALERT_VRAM_PCT' '97')) { 'degraded' } else { 'ok' }
    Add-Result 'gpu' $status ("{0}: VRAM {1}/{2} MB ({3}%), {4} C, util {5}%" -f $f[0], $f[1], $f[2], $pct, $f[3], $f[4])
  } catch { Add-Result 'gpu' 'unknown' "nvidia-smi output not understood: $($_.Exception.Message)" }
} else { Add-Result 'gpu' 'unknown' 'nvidia-smi not found' }

# Disk
$media = Get-EnvValue $cfg 'MEDIA_ROOT'
if ($media -and (Test-Path $media)) {
  $root = [System.IO.Path]::GetPathRoot((Resolve-Path $media).Path)
  $drive = New-Object System.IO.DriveInfo($root)
  $freeGb = [math]::Round($drive.AvailableFreeSpace / 1GB, 1)
  Add-Result 'disk' $(if ($freeGb -ge $MinFreeGB) { 'ok' } else { 'degraded' }) "$freeGb GB free on $root (media root)"
}

$failed = @($results | Where-Object { $_.critical -and $_.status -ne 'ok' })
if ($Json) {
  [ordered]@{ checked_at = (Get-Date).ToString('o'); healthy = ($failed.Count -eq 0); results = $results } | ConvertTo-Json -Depth 6
} else {
  $results | Format-Table check, status, detail -AutoSize -Wrap | Out-String -Width 200 | Write-Host
  if ($failed.Count) { Write-Warn2 "critical checks failing: $(($failed | ForEach-Object { $_.check }) -join ', ')" } else { Write-Ok 'all critical checks pass' }
}
if ($failed.Count) { exit 1 }
