<#
.SYNOPSIS
  Samples the NVIDIA GPU (VRAM, utilisation, temperature, power) and per-process VRAM to CSV files.

.DESCRIPTION
  Read-only: runs nvidia-smi and nothing else. Use it during benchmarks and acceptance tests to see
  how ComfyUI and the local LLM server share the 24 GB card, or leave it running to investigate
  out-of-memory errors. The platform also samples the GPU itself when GPU_MONITOR_ENABLED=true
  (stored in ops.gpu_samples, shown in the dashboard, alerts on GPU_ALERT_TEMP_C / GPU_ALERT_VRAM_PCT);
  this script is the stand-alone equivalent and adds the per-process view.

  Writes <OutDir>\gpu-<stamp>.csv and <OutDir>\gpu-procs-<stamp>.csv and prints a summary
  (peak VRAM, peak temperature, threshold breaches). Exit code 2 if a threshold was crossed.

.EXAMPLE
  deploy\windows\gpu-monitor.ps1 -InstallRoot D:\golden -DurationSec 600 -IntervalSec 2
  deploy\windows\gpu-monitor.ps1 -OutDir . -DurationSec 0      # until Ctrl+C
#>
[CmdletBinding()]
param(
  [string]$InstallRoot,
  [string]$OutDir,
  [int]$IntervalSec = 5,
  # 0 = run until Ctrl+C.
  [int]$DurationSec = 300,
  [double]$VramAlertPct = 97,
  [int]$TempAlertC = 87,
  [switch]$Quiet
)
. "$PSScriptRoot\common.ps1"

if (-not (Test-CommandExists 'nvidia-smi')) { Fail 'nvidia-smi not found (install the NVIDIA driver, or add C:\Windows\System32 to PATH)' }
if (-not $OutDir) { $OutDir = if ($InstallRoot) { Join-Path $InstallRoot 'evidence' } else { (Get-Location).Path } }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = Get-FullPath $OutDir
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$gpuCsv = Join-Path $OutDir "gpu-$stamp.csv"
$procCsv = Join-Path $OutDir "gpu-procs-$stamp.csv"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($gpuCsv, "timestamp,gpu_index,gpu_name,util_pct,vram_used_mb,vram_total_mb,vram_pct,temp_c,power_w`n", $utf8)
[System.IO.File]::WriteAllText($procCsv, "timestamp,gpu_uuid,pid,process_name,used_vram_mb`n", $utf8)

function ConvertTo-Num([string]$Text) {
  $d = 0.0
  if ([double]::TryParse($Text.Trim(), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$d)) { return $d }
  return $null
}
function Format-Csv([object[]]$Values) {
  return (($Values | ForEach-Object {
        $s = if ($null -eq $_) { '' } elseif ($_ -is [double]) { $_.ToString([System.Globalization.CultureInfo]::InvariantCulture) } else { [string]$_ }
        if ($s -match '[",]') { '"' + $s.Replace('"', '""') + '"' } else { $s }
      }) -join ',')
}

$peak = @{ vram_mb = 0.0; vram_pct = 0.0; temp_c = 0.0; util_pct = 0.0; power_w = 0.0 }
$breaches = New-Object System.Collections.Generic.List[string]
$samples = 0
$deadline = if ($DurationSec -gt 0) { (Get-Date).AddSeconds($DurationSec) } else { [datetime]::MaxValue }
if (-not $Quiet) { Write-Step "Sampling every $IntervalSec s$(if ($DurationSec -gt 0) { " for $DurationSec s" } else { ' until Ctrl+C' }) -> $gpuCsv" }
try {
  while ((Get-Date) -lt $deadline) {
    $ts = (Get-Date).ToString('o')
    $lines = @(& nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits)
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "nvidia-smi exited with $LASTEXITCODE" }
    foreach ($line in $lines) {
      if (-not $line) { continue }
      $f = $line.Split(',') | ForEach-Object { $_.Trim() }
      $used = ConvertTo-Num $f[3]; $total = ConvertTo-Num $f[4]; $temp = ConvertTo-Num $f[5]; $util = ConvertTo-Num $f[2]; $power = ConvertTo-Num $f[6]
      $pct = if ($null -ne $used -and $total) { [math]::Round(100 * $used / $total, 1) } else { $null }
      [System.IO.File]::AppendAllText($gpuCsv, (Format-Csv @($ts, $f[0], $f[1], $util, $used, $total, $pct, $temp, $power)) + "`n", $utf8)
      if ($null -ne $used -and $used -gt $peak.vram_mb) { $peak.vram_mb = $used }
      if ($null -ne $pct -and $pct -gt $peak.vram_pct) { $peak.vram_pct = $pct }
      if ($null -ne $temp -and $temp -gt $peak.temp_c) { $peak.temp_c = $temp }
      if ($null -ne $util -and $util -gt $peak.util_pct) { $peak.util_pct = $util }
      if ($null -ne $power -and $power -gt $peak.power_w) { $peak.power_w = $power }
      if ($null -ne $pct -and $pct -ge $VramAlertPct) { $breaches.Add("$ts GPU $($f[0]) VRAM $pct%") }
      if ($null -ne $temp -and $temp -ge $TempAlertC) { $breaches.Add("$ts GPU $($f[0]) $temp C") }
      if (-not $Quiet) { Write-Note ("{0}  GPU {1}  VRAM {2}/{3} MB ({4}%)  util {5}%  {6} C  {7} W" -f (Get-Date -Format 'HH:mm:ss'), $f[0], $used, $total, $pct, $util, $temp, $power) }
    }
    # Per-process VRAM (compute processes: ComfyUI's python, the LLM server). On Windows with WDDM
    # the driver may report used_memory as [N/A]; the row is still written so the process is visible.
    $procs = @(Invoke-Tolerant { & nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>$null })
    foreach ($p in $procs) {
      if (-not $p -or $p -match 'No running') { continue }
      $f = $p.Split(',') | ForEach-Object { $_.Trim() }
      [System.IO.File]::AppendAllText($procCsv, (Format-Csv @($ts, $f[0], $f[1], $f[2], $f[3])) + "`n", $utf8)
    }
    $samples++
    Start-Sleep -Seconds $IntervalSec
  }
} finally {
  $summary = [ordered]@{
    samples = $samples
    peak_vram_mb = $peak.vram_mb
    peak_vram_pct = $peak.vram_pct
    peak_temp_c = $peak.temp_c
    peak_util_pct = $peak.util_pct
    peak_power_w = $peak.power_w
    thresholds = [ordered]@{ vram_pct = $VramAlertPct; temp_c = $TempAlertC }
    breaches = $breaches.ToArray()
    gpu_csv = $gpuCsv
    process_csv = $procCsv
  }
  $summaryPath = Join-Path $OutDir "gpu-summary-$stamp.json"
  Write-JsonFile $summaryPath $summary
  if (-not $Quiet) {
    Write-Ok ("{0} samples; peak VRAM {1} MB ({2}%), peak {3} C, peak util {4}%, peak {5} W" -f $samples, $peak.vram_mb, $peak.vram_pct, $peak.temp_c, $peak.util_pct, $peak.power_w)
    if ($breaches.Count) { Write-Warn2 "$($breaches.Count) threshold breach(es); first: $($breaches[0])" }
    Write-Note "summary: $summaryPath"
  }
}
if ($breaches.Count) { exit 2 }
