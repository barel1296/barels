<#
.SYNOPSIS
  Benchmarks the configured LOCAL language model with the platform's own workloads.

.DESCRIPTION
  Calls the OpenAI-compatible server at LLM_BASE_URL with model LLM_CHAT_MODEL (from golden.env)
  and measures persona chat replies (latency p50/p95, completion tokens/s, output-guard pass rate),
  fan-memory extraction and an agent envelope (JSON schema validity). Nothing is estimated: the
  report only describes the server and model it ran against, on this machine, at this time.

  Optionally samples the GPU in parallel (-WithGpu) so the report shows the VRAM the model used.
  Run it once with ComfyUI idle and once while a ComfyUI job is running to see contention.

  Writes <InstallRoot>\evidence\llm-bench-<stamp>.json (+ gpu-*.csv with -WithGpu).

.EXAMPLE
  deploy\windows\llm-bench.ps1 -InstallRoot D:\golden -Runs 20 -Concurrency 2 -WithGpu
#>
[CmdletBinding()]
param([string]$InstallRoot, [string]$EnvFile, [int]$Runs = 20, [int]$Concurrency = 2, [switch]$WithGpu, [string]$OutDir)
. "$PSScriptRoot\common.ps1"

$envPath = Resolve-EnvFile $EnvFile $InstallRoot
$cfg = Read-EnvFile $envPath
$base = Get-EnvValue $cfg 'LLM_BASE_URL'
$model = Get-EnvValue $cfg 'LLM_CHAT_MODEL'
if (-not $base -or -not $model) { Fail 'set LLM_BASE_URL and LLM_CHAT_MODEL in golden.env first (see LOCAL-LLM.md)' }
if (-not $OutDir) { $OutDir = if ($InstallRoot) { Join-Path $InstallRoot 'evidence' } else { (Get-Location).Path } }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $OutDir "llm-bench-$stamp.json"

$hdr = @{}
$key = Get-EnvValue $cfg 'LLM_API_KEY'
if ($key) { $hdr.Authorization = "Bearer $key" }
$models = Invoke-Http "$base/models" $hdr
if (-not $models.ok) { Fail "$base/models is not reachable: $($models.error)" }
$ids = @($models.json.data | ForEach-Object { $_.id })
if ($ids -notcontains $model) { Write-Warn2 "the server does not list $model (it lists: $($ids -join ', ')); continuing, the server may alias it" }

$gpuJob = $null
if ($WithGpu) {
  if (Test-CommandExists 'nvidia-smi') {
    $monitor = Join-Path $PSScriptRoot 'gpu-monitor.ps1'
    $gpuJob = Start-Job -ScriptBlock { param($m, $o) & $m -OutDir $o -IntervalSec 1 -DurationSec 0 -Quiet } -ArgumentList $monitor, $OutDir
    Write-Note 'GPU sampling started (1 s)'
  } else { Write-Warn2 'nvidia-smi not found: no GPU samples' }
}

Write-Step "Benchmarking $model at $base ($Runs runs per scenario, concurrency $Concurrency)"
try {
  $code = Invoke-Platform $envPath 'cli.js' @('llm:bench', '--runs', "$Runs", '--concurrency', "$Concurrency", '--out', $out) -AllowFailure
} finally {
  if ($gpuJob) { Stop-Job $gpuJob; Remove-Job $gpuJob -Force; Write-Note "GPU samples: $(Join-Path $OutDir 'gpu-*.csv')" }
}
if ($code -ne 0) { Fail "llm:bench exited with $code" }
Write-Ok "report: $out"
