<#
.SYNOPSIS
  Golden Influencer — workstation verification and environment fingerprint (Windows).

.DESCRIPTION
  Collects the FACTS the capacity plan depends on, instead of assuming them:
  installed RAM, free storage, GPU model / VRAM / driver / CUDA compatibility,
  and which services are running (PostgreSQL, ComfyUI / visual engine, local
  LLM server, Docker, WSL). Nothing is changed on the machine.

  Output is JSON (stdout, or -OutFile) shaped for ops.environment_fingerprints
  (docs/14 §1). Fields that could not be read are null and listed in
  "missing"; an incomplete fingerprint cannot satisfy a benchmark gate.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File ops\scripts\verify-host.ps1 -OutFile fingerprint.json
#>
[CmdletBinding()]
param(
  [string]$OutFile,
  [int[]]$EnginePorts = @(8188),
  [int[]]$LlmPorts = @(8000, 8080, 11434),
  [int]$PostgresPort = 5432,
  # Minimums from docs/15 §4. Reported as checks; this script never "passes" a host by assumption.
  [int]$MinRamGB = 64,
  [int]$MinFreeDiskGB = 500
)

$ErrorActionPreference = 'Stop'
$missing = New-Object System.Collections.Generic.List[string]

function Try-Get([string]$name, [scriptblock]$block) {
  try { return & $block } catch { $missing.Add($name) | Out-Null; return $null }
}

function Test-Port([int]$port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($null -eq $c) { return $null }
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    return [ordered]@{ port = $port; listening = $true; process = $p.ProcessName; pid = $c.OwningProcess; address = $c.LocalAddress }
  } catch { return [ordered]@{ port = $port; listening = $false } }
}

$os = Try-Get 'os' {
  $o = Get-CimInstance Win32_OperatingSystem
  [ordered]@{ caption = $o.Caption; version = $o.Version; build = $o.BuildNumber; architecture = $o.OSArchitecture; last_boot = $o.LastBootUpTime.ToString('o') }
}

$cpu = Try-Get 'cpu' {
  $c = Get-CimInstance Win32_Processor | Select-Object -First 1
  [ordered]@{ name = $c.Name.Trim(); cores = $c.NumberOfCores; logical_processors = $c.NumberOfLogicalProcessors; max_clock_mhz = $c.MaxClockSpeed }
}

$ram = Try-Get 'ram' {
  $modules = @(Get-CimInstance Win32_PhysicalMemory)
  $installed = ($modules | Measure-Object -Property Capacity -Sum).Sum
  $visible = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
  $array = Get-CimInstance Win32_PhysicalMemoryArray -ErrorAction SilentlyContinue | Select-Object -First 1
  [ordered]@{
    installed_gb = [math]::Round($installed / 1GB, 1)
    visible_to_os_gb = [math]::Round($visible / 1GB, 1)
    modules = @($modules | ForEach-Object { [ordered]@{ capacity_gb = [math]::Round($_.Capacity / 1GB, 1); speed_mts = $_.ConfiguredClockSpeed; slot = $_.DeviceLocator } })
    slots_total = if ($array) { $array.MemoryDevices } else { $null }
    max_supported_gb = if ($array -and $array.MaxCapacityEx) { [math]::Round($array.MaxCapacityEx / 1MB, 0) } else { $null }
  }
}

$disks = Try-Get 'storage' {
  @(Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Fixed' } | ForEach-Object {
    [ordered]@{ drive = "$($_.DriveLetter):"; filesystem = $_.FileSystem; size_gb = [math]::Round($_.Size / 1GB, 1); free_gb = [math]::Round($_.SizeRemaining / 1GB, 1) }
  })
}
$physical = Try-Get 'physical_disks' {
  @(Get-PhysicalDisk | ForEach-Object { [ordered]@{ model = $_.FriendlyName; media = "$($_.MediaType)"; bus = "$($_.BusType)"; size_gb = [math]::Round($_.Size / 1GB, 0); health = "$($_.HealthStatus)" } })
}

$gpu = $null
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
  $gpu = Try-Get 'gpu' {
    $q = & nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap,power.limit,power.max_limit,pstate,temperature.gpu --format=csv,noheader,nounits
    $header = (& nvidia-smi) -join "`n"
    $cuda = if ($header -match 'CUDA Version:\s*([0-9.]+)') { $Matches[1] } else { $null }
    @($q | ForEach-Object {
      $f = $_.Split(',') | ForEach-Object { $_.Trim() }
      [ordered]@{
        name = $f[0]; vram_total_mb = [int]$f[1]; driver_version = $f[2]; compute_capability = $f[3]
        power_limit_w = $f[4]; power_max_limit_w = $f[5]; pstate = $f[6]; temperature_c = $f[7]
        max_cuda_version_supported_by_driver = $cuda
      }
    })
  }
} else { $missing.Add('gpu (nvidia-smi not found)') | Out-Null }

$nvcc = Try-Get 'cuda_toolkit' {
  $c = Get-Command nvcc -ErrorAction SilentlyContinue
  if ($c) { ((& nvcc --version) -join ' ') -replace '.*release ([0-9.]+).*', '$1' } else { 'not installed (only needed for building CUDA code)' }
}

$power = Try-Get 'power_plan' { ((powercfg /getactivescheme) -join ' ').Trim() }
$onAc = Try-Get 'power_source' { $b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue; if ($b) { [ordered]@{ battery_present = $true; status = $b.BatteryStatus } } else { [ordered]@{ battery_present = $false } } }

$services = Try-Get 'services' {
  [ordered]@{
    postgresql = @(Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | ForEach-Object { [ordered]@{ name = $_.Name; status = "$($_.Status)" } })
    postgres_port = Test-Port $PostgresPort
    visual_engine_ports = @($EnginePorts | ForEach-Object { Test-Port $_ })
    llm_ports = @($LlmPorts | ForEach-Object { Test-Port $_ })
    docker = [bool](Get-Command docker -ErrorAction SilentlyContinue)
    wsl = Try-Get 'wsl' { ((wsl.exe --status) -join ' ') -replace "`0", '' }
    comfyui_processes = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'comfy' } | ForEach-Object { [ordered]@{ pid = $_.ProcessId; command = $_.CommandLine } })
  }
}

$node = Try-Get 'node' { (& node --version).Trim() }
$psql = Try-Get 'psql' { (& psql --version).Trim() }

$checks = [ordered]@{
  ram_installed_gb_at_least_min = if ($ram) { $ram.installed_gb -ge $MinRamGB } else { $null }
  largest_free_disk_gb_at_least_min = if ($disks) { (($disks | Measure-Object -Property free_gb -Maximum).Maximum) -ge $MinFreeDiskGB } else { $null }
  nvidia_gpu_present = [bool]$gpu
  visual_engine_listening = if ($services) { [bool]($services.visual_engine_ports | Where-Object { $_.listening }) } else { $null }
  postgres_listening = if ($services -and $services.postgres_port) { [bool]$services.postgres_port.listening } else { $false }
}

$fingerprint = [ordered]@{
  schema = 'golden.environment_fingerprint/1'
  captured_at = (Get-Date).ToUniversalTime().ToString('o')
  hostname = $env:COMPUTERNAME
  os = $os; cpu = $cpu; ram = $ram; storage = $disks; physical_disks = $physical
  gpu = $gpu; cuda_toolkit = $nvcc; power_plan = $power; power_source = $onAc
  services = $services; node = $node; psql = $psql
  checks = $checks
  thresholds = [ordered]@{ min_ram_gb = $MinRamGB; min_free_disk_gb = $MinFreeDiskGB; source = 'docs/15 section 4' }
  missing = $missing
  complete = ($missing.Count -eq 0)
}

$json = $fingerprint | ConvertTo-Json -Depth 8
$sha = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($json))).Replace('-', '').ToLower()
$out = [ordered]@{ fingerprint = $fingerprint; fingerprint_hash = $sha } | ConvertTo-Json -Depth 9
if ($OutFile) { $out | Out-File -FilePath $OutFile -Encoding utf8; Write-Host "fingerprint written to $OutFile (complete=$($fingerprint.complete))" } else { $out }
