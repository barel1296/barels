<#
.SYNOPSIS
  CI ONLY: prepares a SIMULATED setup so integration-test.ps1 can run its generation step on a
  machine without ComfyUI or a GPU (GitHub's Windows runner).

.DESCRIPTION
  Uses the real platform API and CLI against the platform installed by install.ps1:
  - creates three users with the CLI: a platform admin, a content manager and a compliance officer
    (persona approval needs a second person);
  - registers the bridge as an engine, syncs it, approves the simulated test workflow;
  - creates an influencer, persona draft -> review -> approval -> activation, a reference image,
    and a feed_photo binding.
  Writes <InstallRoot>\evidence\ci-seed.json with the influencer id and the admin API token.
  Never use this on the workstation: there, the Golden Influencer is set up in the dashboard.
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$InstallRoot, [string]$WorkflowKey = 'sim.portrait')
. "$PSScriptRoot\..\common.ps1"

$envPath = Resolve-EnvFile '' $InstallRoot
$cfg = Read-EnvFile $envPath
$api = "http://127.0.0.1:$(Get-EnvValue $cfg 'HTTP_PORT' '8080')"
$node = Get-NodeExe $cfg

function New-CiUser([string]$Email, [string]$Role, [switch]$PlatformAdmin) {
  $a = @((Join-Parts @('dist', 'src', 'cli.js')), 'user:add', '--workspace', 'studio', '--email', $Email, '--name', $Role, '--role', $Role)
  if ($PlatformAdmin) { $a += '--platform-admin' }
  Push-Location (Get-PlatformDir)
  try { $out = (& $node "--env-file=$envPath" @a) -join "`n" } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Fail "user:add $Email" }
  return ($out.Substring($out.IndexOf('{')) | ConvertFrom-Json).token
}
function Invoke-Api([string]$Token, [string]$Method, [string]$Path, $Body = $null, [byte[]]$Bytes = $null) {
  $p = @{ Uri = "$api$Path"; Method = $Method; Headers = @{ Authorization = "Bearer $Token" }; UseBasicParsing = $true }
  if ($null -ne $Bytes) { $p.Body = $Bytes; $p.ContentType = 'image/png' }
  elseif ($null -ne $Body) { $p.Body = ($Body | ConvertTo-Json -Depth 10 -Compress); $p.ContentType = 'application/json' }
  # Without a body PowerShell would send Content-Type x-www-form-urlencoded, which the API rejects.
  elseif ($Method -ne 'GET') { $p.Body = '{}'; $p.ContentType = 'application/json' }
  return Invoke-RestMethod @p
}

Write-Step 'CI seeding (SIMULATED ComfyUI behind the real bridge)'
$admin = New-CiUser 'ci-admin@example.test' 'admin' -PlatformAdmin
$manager = New-CiUser 'ci-manager@example.test' 'content_manager'
$compliance = New-CiUser 'ci-compliance@example.test' 'compliance_officer'

$bridge = "http://$(Get-EnvValue $cfg 'COMFY_BRIDGE_HOST' '127.0.0.1'):$(Get-EnvValue $cfg 'COMFY_BRIDGE_PORT' '8190')/vec/v1"
$engine = Invoke-Api $admin 'POST' '/v1/platform/engines' @{ engine_key = 'ws-comfyui'; base_url = $bridge; token = (Get-EnvValue $cfg 'VEC_ENGINE_TOKEN') }
Invoke-Api $admin 'POST' "/v1/platform/engines/$($engine.id)/sync" @{} | Out-Null
$wf = @(Invoke-Api $admin 'GET' "/v1/platform/workflows?key=$WorkflowKey") | Select-Object -First 1
if (-not $wf) { Fail "workflow $WorkflowKey was not synced from the bridge" }
Invoke-Api $admin 'POST' "/v1/platform/workflows/$($wf.id)/decision" @{ decision = 'approve'; note = 'CI: simulated ComfyUI only' } | Out-Null
Write-Ok "engine registered, $WorkflowKey approved"

$inf = Invoke-Api $admin 'POST' '/v1/influencers' @{ slug = 'golden'; display_name = 'Golden (CI, simulated)'; ai_disclosure_short = 'AI-generated virtual creator'; ai_disclosure_long = 'This account is an AI-generated virtual character. Images are AI-generated; messages are automated.'; timezone = 'Europe/Lisbon'; primary_language = 'en' }
$pv = Invoke-Api $manager 'POST' "/v1/influencers/$($inf.id)/persona-versions" @{
  personality = @{ traits = @('curious', 'warm') }
  writing_style = @{ tone = 'playful'; emoji_policy = 'sparse' }
  biography = @{ fictional = $true; age_years = 27; home_city = 'a fictional seaside town' }
  visual_identity = @{ hair = 'auburn bob'; eyes = 'green' }
  conversation_rules = @{ disclosure = 'I am an AI-generated virtual creator.' }
  change_summary = 'CI persona'
}
Invoke-Api $manager 'POST' "/v1/persona-versions/$($pv.id)/submit" | Out-Null
Invoke-Api $compliance 'POST' "/v1/persona-versions/$($pv.id)/approve" | Out-Null
Invoke-Api $admin 'POST' "/v1/persona-versions/$($pv.id)/activate" | Out-Null
Invoke-Api $admin 'POST' "/v1/influencers/$($inf.id)/status" @{ status = 'active' } | Out-Null
Write-Ok "influencer $($inf.id) active with an approved persona"

# A 32x32 solid PNG made by the platform's own encoder.
Push-Location (Get-PlatformDir)
try { $b64 = & $node -e "import(require('url').pathToFileURL('dist/src/lib/png.js').href).then((m) => process.stdout.write(m.encodeSolidPng(32, 32, [10, 200, 30]).toString('base64')))" } finally { Pop-Location }
$ref = Invoke-Api $manager 'POST' "/v1/influencers/$($inf.id)/reference-assets?kind=face_canonical" -Bytes ([Convert]::FromBase64String($b64))
Invoke-Api $compliance 'POST' "/v1/reference-assets/$($ref.id)/approve" | Out-Null
Invoke-Api $manager 'PUT' "/v1/influencers/$($inf.id)/workflow-bindings/feed_photo" @{ workflow_key = $WorkflowKey; version_range = '^1.0'; default_parameters = @{ aspect_ratio = '4:5'; scene = 'CI smoke test on a simulated ComfyUI' }; priority_class = 'scheduled_image' } | Out-Null
Write-Ok 'reference image approved, feed_photo bound'

$out = Join-Path (Join-Path $InstallRoot 'evidence') 'ci-seed.json'
Write-JsonFile $out ([ordered]@{ influencer_id = $inf.id; engine_id = $engine.id; admin_token = $admin })
Write-Ok "wrote $out"
