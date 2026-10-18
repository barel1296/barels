<#
.SYNOPSIS
  REAL end-to-end acceptance run on the workstation: platform, database, ComfyUI bridge, existing
  ComfyUI, local LLM and GPU. Collects an evidence folder. Nothing here is simulated.

.DESCRIPTION
  Steps (each is recorded as passed / failed / skipped with its evidence file):
    1. health        health-check.ps1 (critical services must be up)
    2. comfyui       read-only discovery of the existing ComfyUI + Track A package check
    3. conformance   VEC v1 conformance against the bridge (native test workflow, no models)
    4. llm           local LLM benchmark with GPU sampling (-LlmRuns per scenario)
    5. api           API smoke with an API token: /v1/me, engines, influencers, approvals,
                     dashboard page
    6. engine        the bridge is registered as a visual engine: refresh health + sync workflows
                     (-RegisterEngine registers it first if it is missing; needs a platform admin)
    7. generate      (only with -Generate) one REAL generation through the platform:
                     POST /v1/influencers/<id>/visual-jobs for -Purpose (the influencer's
                     workflow binding chooses the Track A workflow), poll to a terminal state,
                     sample the GPU meanwhile, list the produced media assets
  The run writes <InstallRoot>\evidence\integration-<stamp>\summary.json and summary.md and
  exits 0 only if every step that ran passed.

  The API token comes from -ApiToken or the GI_API_TOKEN environment variable (the owner token
  printed by install.ps1, or one from "cli user:add"). It is never written to the evidence.

  Telegram Stars payments, Instagram publishing and fan conversations need real accounts and a
  human tester; they are listed as manual steps in ACCEPTANCE-TESTS.md.

.EXAMPLE
  $env:GI_API_TOKEN = '<owner token>'
  deploy\windows\integration-test.ps1 -InstallRoot D:\golden
  deploy\windows\integration-test.ps1 -InstallRoot D:\golden -Generate -InfluencerId <uuid> -Purpose feed_image
#>
[CmdletBinding()]
param(
  [string]$InstallRoot,
  [string]$EnvFile,
  [string]$ApiToken = $env:GI_API_TOKEN,
  [int]$LlmRuns = 5,
  # Minimum JSON-validity and output-guard pass rates for the LLM step.
  [double]$MinRate = 0.9,
  [switch]$SkipLlm,
  [switch]$SkipConformance,
  [switch]$RegisterEngine,
  [string]$EngineKey = 'ws-comfyui',
  [switch]$Generate,
  [string]$InfluencerId,
  [string]$Purpose,
  # Extra job parameters as JSON, e.g. '{"aspect_ratio":"4:5"}'. Only parameters the workflow
  # manifest declares are accepted by the platform.
  [string]$ParametersJson = '{}',
  [int]$GenerateTimeoutSec = 900
)
. "$PSScriptRoot\common.ps1"

$envPath = Resolve-EnvFile $EnvFile $InstallRoot
$cfg = Read-EnvFile $envPath
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$root = if ($InstallRoot) { Join-Path $InstallRoot 'evidence' } else { Join-Path (Split-Path (Split-Path $envPath)) 'evidence' }
$ev = Join-Path $root "integration-$stamp"
New-Item -ItemType Directory -Force -Path $ev | Out-Null
$ev = Get-FullPath $ev
$steps = New-Object System.Collections.Generic.List[object]
function Add-Step([string]$Name, [string]$Status, [string]$Detail, [string]$Evidence = $null) {
  $steps.Add([pscustomobject]@{ step = $Name; status = $Status; detail = $Detail; evidence = $Evidence })
  $msg = "{0,-12} {1,-8} {2}" -f $Name, $Status.ToUpper(), $Detail
  if ($Status -eq 'passed') { Write-Ok $msg } elseif ($Status -eq 'skipped') { Write-Note $msg } else { Write-Warn2 $msg }
}
function Save-Json([string]$Name, $Object) {
  $p = Join-Path $ev $Name
  Write-JsonFile $p $Object 12
  return $p
}
$pwshExe = (Get-Process -Id $PID).Path
function Invoke-Script([string]$Script, [string[]]$Arguments, [string]$LogName) {
  $log = Join-Path $ev $LogName
  Invoke-Tolerant { & $pwshExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot $Script) @Arguments *> $log }
  return @{ code = $LASTEXITCODE; log = $log }
}
$common = @('-EnvFile', $envPath)
if ($InstallRoot) { $common += @('-InstallRoot', $InstallRoot) }

# --- Environment facts (what this evidence is about) ------------------------------------------
$facts = [ordered]@{
  started_at = (Get-Date).ToString('o')
  execution = 'REAL (workstation)'
  host = [System.Net.Dns]::GetHostName()
  os = [System.Environment]::OSVersion.VersionString
  powershell = $PSVersionTable.PSVersion.ToString()
  node = (& node --version)
  git_commit = $null
  gpu = $null
  comfyui_url = Get-EnvValue $cfg 'COMFYUI_URL'
  comfyui_version = $null
  comfyui_device = $null
  llm_model = Get-EnvValue $cfg 'LLM_CHAT_MODEL'
  simulated_backends = @()
}
if (Test-CommandExists 'git') { Push-Location (Get-RepoRoot); try { $facts.git_commit = Invoke-Tolerant { & git rev-parse HEAD 2>$null } } finally { Pop-Location } }
if (Test-CommandExists 'nvidia-smi') { $facts.gpu = (& nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader | Select-Object -First 1) }
# The repository's simulators identify themselves; a run against any of them is a script
# exercise, never hardware acceptance evidence.
$simulated = New-Object System.Collections.Generic.List[string]
if ($facts.comfyui_url) {
  $st = Invoke-Http "$($facts.comfyui_url)/system_stats"
  if ($st.ok) {
    $facts.comfyui_version = Get-Prop (Get-Prop $st.json 'system') 'comfyui_version'
    $facts.comfyui_device = Get-Prop (@(Get-Prop $st.json 'devices'))[0] 'name'
    if ("$($facts.comfyui_version) $($facts.comfyui_device)" -match 'simulat') { $simulated.Add('comfyui') }
  }
}
$llmBase = Get-EnvValue $cfg 'LLM_BASE_URL'
if ($llmBase) {
  $lh = @{}
  if (Get-EnvValue $cfg 'LLM_API_KEY') { $lh.Authorization = "Bearer $(Get-EnvValue $cfg 'LLM_API_KEY')" }
  $lm = Invoke-Http "$llmBase/models" $lh
  if ($lm.ok -and (@($lm.json.data) | Where-Object { "$($_.owned_by)" -match 'simulat' })) { $simulated.Add('llm') }
}
$facts.simulated_backends = $simulated.ToArray()
if ($simulated.Count) {
  $facts.execution = "SIMULATED backends: $($simulated -join ', ') (script exercise, NOT hardware acceptance)"
  Write-Warn2 $facts.execution
}
Write-Step "Integration run $stamp on $($facts.host) -> $ev"

# --- 1. Health ------------------------------------------------------------------------------
$r = Invoke-Script 'health-check.ps1' ($common + @('-Json')) 'health.json'
$critical = $r.code -eq 0
Add-Step 'health' $(if ($critical) { 'passed' } else { 'failed' }) $(if ($critical) { 'critical services up' } else { 'a critical check failed (see health.json)' }) $r.log

# --- 2. ComfyUI (read-only) -------------------------------------------------------------------
if ($facts.comfyui_url) {
  $args2 = @('-Url', $facts.comfyui_url, '-OutFile', (Join-Path $ev 'comfyui-discovery.json')) + $common
  if (Get-EnvValue $cfg 'COMFY_BRIDGE_PACKAGES_DIR') { $args2 += '-CheckPackages' }
  $r = Invoke-Script 'discover-comfyui.ps1' $args2 'comfyui-discovery.log'
  Add-Step 'comfyui' $(if ($r.code -eq 0) { 'passed' } else { 'failed' }) "existing ComfyUI at $($facts.comfyui_url) (read-only probe)" (Join-Path $ev 'comfyui-discovery.json')
} else { Add-Step 'comfyui' 'failed' 'COMFYUI_URL is empty: run discover-comfyui.ps1 -WriteEnv' }

# --- 3. VEC conformance -----------------------------------------------------------------------
if ($SkipConformance) { Add-Step 'conformance' 'skipped' '-SkipConformance' }
else {
  $r = Invoke-Script 'conformance.ps1' ($common + @('-OutDir', $ev)) 'conformance.log'
  Add-Step 'conformance' $(if ($r.code -eq 0) { 'passed' } else { 'failed' }) $(if ($r.code -eq 0) { 'bridge is VEC v1 conformant' } elseif ($r.code -eq 1) { 'NOT CONFORMANT' } else { 'could not run' }) $r.log
}

# --- 4. Local LLM ---------------------------------------------------------------------------------
if ($SkipLlm) { Add-Step 'llm' 'skipped' '-SkipLlm' }
elseif (-not (Get-EnvValue $cfg 'LLM_BASE_URL')) { Add-Step 'llm' 'failed' 'LLM_BASE_URL is empty (see LOCAL-LLM.md)' }
else {
  $r = Invoke-Script 'llm-bench.ps1' ($common + @('-Runs', "$LlmRuns", '-Concurrency', '2', '-WithGpu', '-OutDir', $ev)) 'llm-bench.log'
  $detail = 'benchmark failed (see llm-bench.log)'
  $status = 'failed'
  $bench = Get-ChildItem -LiteralPath $ev -Filter 'llm-bench-*.json' | Select-Object -First 1
  if ($r.code -eq 0 -and $bench) {
    $b = Get-Content $bench.FullName -Raw | ConvertFrom-Json
    $chat = @($b.results | Where-Object { $_.scenario -eq 'persona_reply' }) | Select-Object -First 1
    # A scenario fails on request errors, or when fewer than -MinRate of its replies were valid JSON
    # (agents and memory need it) or passed the output guard (fans see these replies).
    $weak = @($b.results | Where-Object {
        $_.ok -lt $_.requests -or
        ($_.PSObject.Properties['json_valid_rate'] -and $_.json_valid_rate -lt $MinRate) -or
        ($_.PSObject.Properties['guard_pass_rate'] -and $_.guard_pass_rate -lt $MinRate) })
    $status = if ($weak.Count -eq 0) { 'passed' } else { 'failed' }
    $detail = if ($chat) { "persona_reply p50 $($chat.latency_ms.p50) ms, p95 $($chat.latency_ms.p95) ms, $(if ($null -ne $chat.completion_tokens_per_s_p50) { [math]::Round([double]$chat.completion_tokens_per_s_p50, 1) } else { 'n/a' }) tok/s" } else { 'report written' }
    if ($weak.Count) { $detail += "; below threshold: $(($weak | ForEach-Object { $_.scenario }) -join ', ')" }
  }
  Add-Step 'llm' $status $detail $(if ($bench) { $bench.FullName } else { $r.log })
}

# --- 5. API smoke -------------------------------------------------------------------------------
$httpHost = Get-EnvValue $cfg 'HTTP_HOST' '127.0.0.1'
if ($httpHost -eq '0.0.0.0') { $httpHost = '127.0.0.1' }
$api = "http://${httpHost}:$(Get-EnvValue $cfg 'HTTP_PORT' '8080')"
$auth = @{ Authorization = "Bearer $ApiToken" }
$me = $null
$engines = @()
if (-not $ApiToken) { Add-Step 'api' 'skipped' 'no API token (-ApiToken or GI_API_TOKEN)' }
else {
  $calls = [ordered]@{}
  foreach ($path in @('/v1/me', '/v1/platform/engines', '/v1/influencers', '/v1/approvals')) {
    $res = Invoke-Http "$api$path" $auth
    $calls[$path] = [ordered]@{ ok = $res.ok; status = $res.status; error = $res.error; body = $res.json }
  }
  $page = Invoke-Http "$api/admin/"
  $calls['/admin/'] = [ordered]@{ ok = $page.ok; status = $page.status; error = $page.error }
  $p = Save-Json 'api-smoke.json' $calls
  $me = $calls['/v1/me'].body
  if ($calls['/v1/platform/engines'].ok) { $engines = @($calls['/v1/platform/engines'].body) }
  $bad = @($calls.Keys | Where-Object { -not $calls[$_].ok -and -not ($_ -eq '/v1/platform/engines' -and $calls[$_].status -eq 403) })
  Add-Step 'api' $(if ($bad.Count -eq 0) { 'passed' } else { 'failed' }) $(if ($bad.Count -eq 0) { "authenticated as $($me.user_id) (platform admin: $($me.is_platform_admin))" } else { "failed: $($bad -join ', ')" }) $p
}

# --- 6. Visual engine registration ----------------------------------------------------------------
$bridgeUrl = "http://$(Get-EnvValue $cfg 'COMFY_BRIDGE_HOST' '127.0.0.1'):$(Get-EnvValue $cfg 'COMFY_BRIDGE_PORT' '8190')/vec/v1"
if (-not $ApiToken -or -not $me) { Add-Step 'engine' 'skipped' 'needs the API step' }
elseif (-not $me.is_platform_admin) { Add-Step 'engine' 'skipped' 'the API token is not a platform admin' }
else {
  $engine = $engines | Where-Object { $_.base_url.TrimEnd('/') -eq $bridgeUrl } | Select-Object -First 1
  if (-not $engine -and $RegisterEngine) {
    $reg = Invoke-Http "$api/v1/platform/engines" $auth 30 'POST' @{ engine_key = $EngineKey; base_url = $bridgeUrl; token = (Get-EnvValue $cfg 'VEC_ENGINE_TOKEN') }
    if ($reg.ok) { $engine = $reg.json; Write-Note "registered engine $EngineKey -> $bridgeUrl" } else { Write-Warn2 "engine registration failed: $($reg.error)" }
  }
  if (-not $engine) { Add-Step 'engine' 'failed' "no engine with base_url $bridgeUrl (rerun with -RegisterEngine, or register it in the dashboard)" }
  else {
    $h = Invoke-Http "$api/v1/platform/engines/$($engine.id)/health" $auth 30 'POST' @{}
    $s = Invoke-Http "$api/v1/platform/engines/$($engine.id)/sync" $auth 60 'POST' @{}
    $p = Save-Json 'engine.json' ([ordered]@{ engine = $engine; health = $h.json; health_error = $h.error; sync = $s.json; sync_error = $s.error })
    Add-Step 'engine' $(if ($h.ok -and $s.ok) { 'passed' } else { 'failed' }) "engine $($engine.engine_key): health $(if ($h.ok) { 'ok' } else { $h.error }); sync $(if ($s.ok) { 'ok' } else { $s.error })" $p
  }
}

# --- 7. One real generation through the platform -------------------------------------------------------
if (-not $Generate) { Add-Step 'generate' 'skipped' 'pass -Generate -InfluencerId <uuid> -Purpose <binding> to run one real generation' }
elseif (-not $ApiToken -or -not $InfluencerId -or -not $Purpose) { Add-Step 'generate' 'failed' '-Generate needs -ApiToken/GI_API_TOKEN, -InfluencerId and -Purpose' }
else {
  $gpuJob = $null
  if (Test-CommandExists 'nvidia-smi') {
    $gpuJob = Start-Job -ScriptBlock { param($m, $o) & $m -OutDir $o -IntervalSec 1 -DurationSec 0 -Quiet } -ArgumentList (Join-Path $PSScriptRoot 'gpu-monitor.ps1'), $ev
  }
  $job = $null
  $final = $null
  $started = Get-Date
  try {
    $body = @{ idempotency_key = "integration-$stamp"; purpose = $Purpose; parameters = ($ParametersJson | ConvertFrom-Json); output_count = 1 }
    $created = Invoke-Http "$api/v1/influencers/$InfluencerId/visual-jobs" $auth 30 'POST' $body
    if (-not $created.ok) { throw "visual job was not created: $($created.status) $($created.error)" }
    $job = $created.json
    Write-Note "visual job $($job.id) created; polling (timeout $GenerateTimeoutSec s)"
    $deadline = $started.AddSeconds($GenerateTimeoutSec)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 3
      $g = Invoke-Http "$api/v1/visual-jobs/$($job.id)" $auth
      if ($g.ok) {
        $final = $g.json
        if (@('succeeded', 'failed', 'cancelled') -contains $final.state) { break }
      }
    }
    $assets = Invoke-Http "$api/v1/influencers/$InfluencerId/media-assets?visual_job_id=$($job.id)" $auth
    $p = Save-Json 'generation.json' ([ordered]@{ request = $body; job = $final; media_assets = $assets.json; elapsed_s = [math]::Round(((Get-Date) - $started).TotalSeconds, 1) })
    $n = @($assets.json).Count
    $ok = $final -and $final.state -eq 'succeeded' -and $final.validation_scope -eq 'real_engine' -and $n -gt 0
    $detail = if ($final) { "job $($final.state) in $([math]::Round(((Get-Date) - $started).TotalSeconds)) s, platform validation_scope=$($final.validation_scope); $n media asset(s)$(if ($final.error_code) { "; error $($final.error_code)" })" } else { 'no job status before the timeout' }
    # The platform only knows the bridge reports engine_kind=comfyui; say so when ComfyUI itself is simulated.
    if ($simulated.Contains('comfyui')) { $detail += '; the ComfyUI behind the bridge is SIMULATED' }
    Add-Step 'generate' $(if ($ok) { 'passed' } else { 'failed' }) $detail $p
  } catch {
    Add-Step 'generate' 'failed' $_.Exception.Message
  } finally {
    if ($gpuJob) { Stop-Job $gpuJob; Remove-Job $gpuJob -Force }
  }
}

# --- Summary ------------------------------------------------------------------------------------------
$facts.finished_at = (Get-Date).ToString('o')
$ran = @($steps | Where-Object { $_.status -ne 'skipped' })
$failed = @($steps | Where-Object { $_.status -eq 'failed' })
$summary = [ordered]@{ facts = $facts; passed = ($failed.Count -eq 0 -and $ran.Count -gt 0); acceptance_evidence = ($simulated.Count -eq 0); steps = $steps }
Save-Json 'summary.json' $summary | Out-Null
$md = New-Object System.Collections.Generic.List[string]
$md.Add("# Integration run $stamp")
$md.Add('')
$md.Add("Execution: **$($facts.execution)** on $($facts.host) ($($facts.os)); GPU: $(if ($facts.gpu) { $facts.gpu } else { 'none detected' }); ComfyUI: $($facts.comfyui_version) on $($facts.comfyui_device); LLM: $($facts.llm_model); commit $($facts.git_commit).")
$md.Add('')
$md.Add('| Step | Status | Detail | Evidence |')
$md.Add('|---|---|---|---|')
foreach ($s in $steps) { $md.Add("| $($s.step) | $($s.status) | $($s.detail -replace '\|', '/') | $(if ($s.evidence) { Split-Path $s.evidence -Leaf }) |") }
$md.Add('')
$md.Add("Result: **$(if ($summary.passed) { 'PASSED' } else { 'NOT PASSED' })** ($($ran.Count) step(s) ran, $($failed.Count) failed, $($steps.Count - $ran.Count) skipped).$(if ($simulated.Count) { ' Simulated backends were used: this is NOT acceptance evidence.' })")
[System.IO.File]::WriteAllLines((Join-Path $ev 'summary.md'), $md.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
Write-Step "Evidence: $ev"
if (-not $summary.passed) { exit 1 }
