<#
.SYNOPSIS
  Finds the EXISTING ComfyUI installation and reports how to connect to it. Read-only.

.DESCRIPTION
  - Looks for running ComfyUI processes (python ... main.py / ComfyUI in the command line, the
    portable build's run_nvidia_gpu.bat, ComfyUI Desktop) and the ports they listen on.
  - Probes candidate URLs with GET /system_stats (version, Python, GPU, VRAM) and counts the
    installed node types with GET /object_info.
  - Optionally checks Track A's workflow packages against that installation
    (missing node types, model files a loader does not list).
  - With -WriteEnv, writes COMFYUI_URL into <InstallRoot>\config\golden.env (the platform's own
    file). It never writes to ComfyUI, its folders, models, custom nodes, workflows or settings.

.EXAMPLE
  deploy\windows\discover-comfyui.ps1 -InstallRoot D:\golden -WriteEnv
  deploy\windows\discover-comfyui.ps1 -Url http://127.0.0.1:8188 -CheckPackages -InstallRoot D:\golden
#>
[CmdletBinding()]
param(
  [string]$InstallRoot,
  [string]$EnvFile,
  # Extra URLs to probe (the ComfyUI default port 8188 on loopback is always tried).
  [string[]]$Url = @(),
  [switch]$WriteEnv,
  [switch]$CheckPackages,
  [string]$OutFile
)
. "$PSScriptRoot\common.ps1"

$report = [ordered]@{ discovered_at = (Get-Date).ToString('o'); processes = @(); candidates = @(); selected = $null; packages = $null }

Write-Step 'Looking for ComfyUI processes (read-only)'
$ports = New-Object System.Collections.Generic.List[int]
$ports.Add(8188)
if ($script:IsWin) {
  try {
    $procs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match 'ComfyUI|comfyui' -or ($_.Name -match 'python' -and $_.CommandLine -match 'main\.py')) })
    foreach ($p in $procs) {
      $listen = @(Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique)
      foreach ($lp in $listen) { if (-not $ports.Contains([int]$lp)) { $ports.Add([int]$lp) } }
      $guess = $null
      if ($p.CommandLine -match '([A-Za-z]:\\[^"]*?ComfyUI[^\\"]*)') { $guess = $Matches[1] }
      $report.processes += [ordered]@{
        pid = $p.ProcessId
        name = $p.Name
        executable = $p.ExecutablePath
        install_dir_guess = $guess
        listening_ports = $listen
        command_line = $p.CommandLine
      }
    }
  } catch { Write-Warn2 "process scan failed: $($_.Exception.Message)" }
} else {
  Write-Note 'not Windows: process scan skipped, probing URLs only'
}
Write-Ok "$($report.processes.Count) ComfyUI-like process(es); ports to probe: $($ports -join ', ')"

$urls = New-Object System.Collections.Generic.List[string]
foreach ($u in $Url) { $urls.Add($u.TrimEnd('/')) }
foreach ($p in $ports) { foreach ($h in @('127.0.0.1', 'localhost')) { $c = "http://${h}:$p"; if (-not $urls.Contains($c)) { $urls.Add($c) } } }

Write-Step 'Probing /system_stats'
foreach ($u in $urls) {
  $r = Invoke-Http "$u/system_stats" -TimeoutSec 4
  if (-not $r.ok -or $null -eq $r.json -or -not ($r.json.PSObject.Properties.Name -contains 'devices')) {
    $report.candidates += [ordered]@{ url = $u; reachable = $false; error = $r.error }
    continue
  }
  $sys = Get-Prop $r.json 'system'
  $devs = @($r.json.devices | ForEach-Object { [ordered]@{ name = (Get-Prop $_ 'name'); type = (Get-Prop $_ 'type'); vram_total_mb = [math]::Round([double](Get-Prop $_ 'vram_total') / 1MB); vram_free_mb = [math]::Round([double](Get-Prop $_ 'vram_free') / 1MB) } })
  $nodes = $null
  $oi = Invoke-Http "$u/object_info" -TimeoutSec 60
  if ($oi.ok -and $null -ne $oi.json) { $nodes = @($oi.json.PSObject.Properties).Count }
  $entry = [ordered]@{
    url = $u
    reachable = $true
    comfyui_version = Get-Prop $sys 'comfyui_version'
    python_version = Get-Prop $sys 'python_version'
    pytorch_version = Get-Prop $sys 'pytorch_version'
    embedded_python = Get-Prop $sys 'embedded_python'
    os = Get-Prop $sys 'os'
    devices = $devs
    node_types = $nodes
  }
  $report.candidates += $entry
  if ($null -eq $report.selected) { $report.selected = $entry }
  $gpus = ($devs | ForEach-Object { "$($_.name) ($($_.vram_total_mb) MB)" }) -join '; '
  Write-Ok "$u  ComfyUI $($entry.comfyui_version)  GPU: $gpus  node types: $nodes"
}

if ($null -eq $report.selected) {
  Write-Warn2 'No ComfyUI answered. Start ComfyUI the way you normally do (nothing here starts or changes it) and run this again, or pass -Url.'
} else {
  if ($WriteEnv) {
    $envPath = Resolve-EnvFile $EnvFile $InstallRoot
    Set-EnvValue $envPath 'COMFYUI_URL' $report.selected.url
    Write-Ok "COMFYUI_URL=$($report.selected.url) written to $envPath (platform configuration only)"
  } else {
    Write-Note "Set COMFYUI_URL=$($report.selected.url) in golden.env (or re-run with -WriteEnv)"
  }
  if ($CheckPackages) {
    $envPath = Resolve-EnvFile $EnvFile $InstallRoot
    $cfg = Read-EnvFile $envPath
    $pk = Get-EnvValue $cfg 'COMFY_BRIDGE_PACKAGES_DIR'
    if ($pk -eq '') { Write-Warn2 'COMFY_BRIDGE_PACKAGES_DIR is not set; skipping the package check' }
    else {
      Write-Step "Checking Track A packages in $pk against $($report.selected.url) (read-only)"
      $tmp = [System.IO.Path]::GetTempFileName()
      try {
        Push-Location (Get-PlatformDir)
        try {
          & (Get-NodeExe $cfg) "--env-file=$envPath" (Join-Parts @('dist', 'src', 'comfy-bridge', 'main.js')) check-packages --url $report.selected.url --packages $pk | Out-File -FilePath $tmp -Encoding utf8
          $code = $LASTEXITCODE
        } finally { Pop-Location }
        $report.packages = Get-Content $tmp -Raw | ConvertFrom-Json
        if ($code -eq 0) { Write-Ok 'all packages can run on this ComfyUI' } else { Write-Warn2 'some packages cannot run here yet (missing node types or model files): see the report' }
      } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
    }
  }
}

$json = $report | ConvertTo-Json -Depth 10
if ($OutFile) { [System.IO.File]::WriteAllText((Get-FullPath $OutFile), $json, (New-Object System.Text.UTF8Encoding($false))); Write-Ok "report written to $OutFile" } else { $json }
