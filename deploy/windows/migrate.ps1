<#
.SYNOPSIS
  Applies database migrations (checksum-verified, safe to re-run) and creates upcoming partitions.

.DESCRIPTION
  Uses MIGRATION_DATABASE_URL (role aios_migrator) from golden.env. Take a backup first when
  upgrading an existing installation (backup.ps1); the runner refuses to continue if an applied
  migration file was changed.

.EXAMPLE
  deploy\windows\migrate.ps1 -InstallRoot D:\golden
#>
[CmdletBinding()]
param([string]$InstallRoot, [string]$EnvFile, [int]$PartitionMonths = 3)
. "$PSScriptRoot\common.ps1"
$envPath = Resolve-EnvFile $EnvFile $InstallRoot
Write-Step 'Applying migrations'
Invoke-Platform $envPath 'cli.js' @('db:migrate') | Out-Null
Write-Step "Ensuring partitions for the next $PartitionMonths months"
Invoke-Platform $envPath 'cli.js' @('db:maintain', '--months', "$PartitionMonths") | Out-Null
Write-Ok 'database schema is current'
