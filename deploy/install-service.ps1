<#
  Registers the ITRM Tracker Node app as a Windows Scheduled Task that starts at boot, runs as SYSTEM,
  restarts on failure and logs to <AppPath>\logs\app.log. Run from an elevated (Administrator) PowerShell.

  Usage:  .\deploy\install-service.ps1 -AppPath C:\inetpub\itrm-tracker
          .\deploy\install-service.ps1 -AppPath C:\inetpub\itrm-tracker -Remove
#>
param(
  [string]$AppPath = (Split-Path -Parent $PSScriptRoot),
  [string]$TaskName = "ITRM-Tracker-Node",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

if ($Remove) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed task $TaskName"
  return
}

$AppPath = (Resolve-Path $AppPath).Path
if (-not (Test-Path "$AppPath\server.js")) { throw "server.js not found in $AppPath" }
if (-not (Test-Path "$AppPath\.env")) { throw ".env not found in $AppPath (copy .env.example to .env and fill it in)" }
if (-not (Test-Path "$AppPath\node_modules\mssql")) { throw "Dependencies missing. Run 'npm install --omit=dev' in $AppPath first." }

# Prefer the bundled Node, then whatever is on PATH.
$node = "$AppPath\node-v24.19.0-win-x64\node.exe"
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }

New-Item -ItemType Directory -Force -Path "$AppPath\logs" | Out-Null

$cmd = "/c `"`"$node`" server.js >> logs\app.log 2>&1`""
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmd -WorkingDirectory $AppPath
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName

Start-Sleep -Seconds 5
Write-Host "Task '$TaskName' registered and started. Node: $node"
Write-Host "Check: curl.exe http://127.0.0.1:3000/healthz   |   log: $AppPath\logs\app.log"
