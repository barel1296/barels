<#
.SYNOPSIS
  Registers (or removes) the Golden Influencer background services as Windows scheduled tasks.

.DESCRIPTION
  Creates two tasks that start at boot, run whether or not anyone is logged on (S4U logon,
  no stored password), restart on failure every minute and have no time limit:
    GoldenInfluencer-Platform     API + worker
    GoldenInfluencer-ComfyBridge  VEC bridge to the existing ComfyUI (only if COMFYUI_URL is set)
    GoldenInfluencer-LLM          optional native llama.cpp server (only if LLM_SERVER_EXE is set)
  ComfyUI keeps its own start-up arrangement; this script never starts, stops or changes it.
  An LLM server started some other way (Ollama, LM Studio, Docker) is left alone too.
  Requires an elevated PowerShell.

.EXAMPLE
  deploy\windows\register-services.ps1 -InstallRoot D:\golden -Start
  deploy\windows\register-services.ps1 -InstallRoot D:\golden -Remove
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$InstallRoot, [switch]$Start, [switch]$Remove, [string]$User = "$env:USERDOMAIN\$env:USERNAME")
. "$PSScriptRoot\common.ps1"
if (-not $script:IsWin) { Fail 'scheduled tasks are Windows-only' }
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'run this from an elevated PowerShell (Run as administrator)' }

$tasks = @(
  @{ Name = 'GoldenInfluencer-Platform'; Service = 'platform' },
  @{ Name = 'GoldenInfluencer-ComfyBridge'; Service = 'comfy-bridge' },
  @{ Name = 'GoldenInfluencer-LLM'; Service = 'llm' }
)
if ($Remove) {
  foreach ($t in $tasks) {
    if (Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false
      Write-Ok "removed $($t.Name)"
    }
  }
  return
}

$envPath = Resolve-EnvFile '' $InstallRoot
$cfg = Read-EnvFile $envPath
$runner = Join-Path $PSScriptRoot 'run-service.ps1'
foreach ($t in $tasks) {
  if ($t.Service -eq 'comfy-bridge' -and (Get-EnvValue $cfg 'COMFYUI_URL') -eq '') {
    Write-Note "skipping $($t.Name): COMFYUI_URL is not set (run discover-comfyui.ps1 -WriteEnv first)"
    continue
  }
  if ($t.Service -eq 'llm' -and (Get-EnvValue $cfg 'LLM_SERVER_EXE') -eq '') {
    Write-Note "skipping $($t.Name): LLM_SERVER_EXE is not set (the LLM server is managed elsewhere)"
    continue
  }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Service $($t.Service) -InstallRoot `"$InstallRoot`"" -WorkingDirectory (Get-PlatformDir)
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -Description "Golden Influencer $($t.Service)" -Force | Out-Null
  Write-Ok "registered $($t.Name) (runs as $User)"
  if ($Start) { Start-ScheduledTask -TaskName $t.Name; Write-Ok "started $($t.Name)" }
}
Write-Note "Logs: $(Join-Path $InstallRoot 'logs')"
