<#
.SYNOPSIS
  Runs the Visual Engine Contract v1 conformance suite against a VEC endpoint and saves the report.

.DESCRIPTION
  Default target is the local ComfyUI bridge (http://COMFY_BRIDGE_HOST:COMFY_BRIDGE_PORT/vec/v1) with
  VEC_ENGINE_TOKEN from golden.env. The suite exercises the contract with the reserved native
  workflow __conformance__.solid_color (bridge setting COMFY_BRIDGE_CONFORMANCE=true): it does NOT
  load models or run any Track A workflow, and it does not change ComfyUI.

  Writes <InstallRoot>\evidence\vec-conformance-<stamp>.json. Exit code 0 = CONFORMANT,
  1 = NOT CONFORMANT, 2 = could not run.

  Conformance is necessary but not sufficient: it proves the bridge speaks VEC v1 correctly, not
  that a Track A workflow produces good images. Use integration-test.ps1 -Generate for that.

.EXAMPLE
  deploy\windows\conformance.ps1 -InstallRoot D:\golden
  deploy\windows\conformance.ps1 -InstallRoot D:\golden -EngineUrl http://127.0.0.1:8190/vec/v1
#>
[CmdletBinding()]
param([string]$InstallRoot, [string]$EnvFile, [string]$EngineUrl, [string]$Token, [string]$OutDir)
. "$PSScriptRoot\common.ps1"

$envPath = Resolve-EnvFile $EnvFile $InstallRoot
$cfg = Read-EnvFile $envPath
if (-not $EngineUrl) { $EngineUrl = "http://$(Get-EnvValue $cfg 'COMFY_BRIDGE_HOST' '127.0.0.1'):$(Get-EnvValue $cfg 'COMFY_BRIDGE_PORT' '8190')/vec/v1" }
if (-not $Token) { $Token = Get-EnvValue $cfg 'VEC_ENGINE_TOKEN' }
if (-not $Token) { Fail 'VEC_ENGINE_TOKEN is empty in golden.env (and -Token was not given)' }
if ((Get-EnvValue $cfg 'COMFY_BRIDGE_CONFORMANCE' 'true') -eq 'false') { Write-Warn2 'COMFY_BRIDGE_CONFORMANCE=false: the bridge does not offer the conformance workflow, so job tests will fail' }
if (-not $OutDir) { $OutDir = if ($InstallRoot) { Join-Path $InstallRoot 'evidence' } else { (Get-Location).Path } }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$report = Join-Path $OutDir ("vec-conformance-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

Write-Step "VEC v1 conformance against $EngineUrl"
# The token goes through the environment, not the command line (process lists are readable).
$env:VEC_ENGINE_TOKEN = $Token
try {
  $code = Invoke-Platform $envPath (Join-Path 'conformance' 'main.js') @('--engine-url', $EngineUrl, '--report', $report) -AllowFailure
} finally { Remove-Item Env:\VEC_ENGINE_TOKEN -ErrorAction SilentlyContinue }
switch ($code) {
  0 { Write-Ok "CONFORMANT; report: $report" }
  1 { Write-Warn2 "NOT CONFORMANT; report: $report" }
  default { Write-Warn2 "the suite could not run (exit $code): is the bridge running? (run-service.ps1 -Service comfy-bridge)" }
}
exit $code
