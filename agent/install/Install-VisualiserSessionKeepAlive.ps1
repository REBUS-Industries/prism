<#
.SYNOPSIS
  (OPTIONAL hardening) Install a scheduled task that keeps the PRISM
  Visualiser's interactive session homed on the physical console so it
  always has the discrete GPU, even after an RDP disconnect.

.DESCRIPTION
  Background: the PRISM agent + Unreal Engine run inside the interactive
  Windows session of the auto-logon account (see Set-VisualiserAutoLogon.ps1).
  A *disconnected* RDP session keeps the GPU on this hardware, so the
  primary fix (auto-logon + "disconnect, never log off") is usually enough.

  This OPTIONAL watchdog adds defense-in-depth for fleets that prefer the
  GPU session to live on the physical console at all times: when the target
  user's session is DISCONNECTED and not already on the console, it runs
    tscon <sessionId> /dest:console
  which re-homes that session to the console terminal WITHOUT logging it
  off (all processes keep running). It NEVER touches a session that is
  actively connected, so an operator who is currently RDP'd in is never
  kicked.

  The task runs as SYSTEM (tscon requires SYSTEM to redirect another
  session), at startup and on a short repeating interval.

  This script is OPT-IN and not run by install.ps1.

.PARAMETER User
  Account whose disconnected session should be returned to the console.
  Default: 'LocalUser'.

.PARAMETER IntervalMinutes
  Repeat interval for the watchdog. Default: 2.

.PARAMETER Uninstall
  Remove the scheduled task and the helper script.

.PARAMETER InstallDir
  Where to drop the watchdog worker script. Default:
  C:\ProgramData\PRISM.Agent.

.EXAMPLE
  & 'C:\Program Files\PRISM.Agent\install\Install-VisualiserSessionKeepAlive.ps1'

.EXAMPLE
  & 'C:\Program Files\PRISM.Agent\install\Install-VisualiserSessionKeepAlive.ps1' -Uninstall
#>

param(
    [string] $User           = 'LocalUser',
    [int]    $IntervalMinutes = 2,
    [switch] $Uninstall,
    [string] $InstallDir     = 'C:\ProgramData\PRISM.Agent'
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Install-VisualiserSessionKeepAlive.ps1 must be run from an elevated PowerShell."
}

$taskName    = 'PRISM.VisualiserSessionKeepAlive'
$workerPath  = Join-Path $InstallDir 'visualiser-session-keepalive.ps1'

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Removed scheduled task '$taskName'."
    } else {
        Write-Host "Scheduled task '$taskName' not present."
    }
    if (Test-Path $workerPath) { Remove-Item $workerPath -Force; Write-Host "Removed $workerPath." }
    return
}

# ---- Worker script: return a DISCONNECTED target-user session to console ----
$worker = @'
# PRISM Visualiser session keep-alive worker (runs as SYSTEM).
# Returns a DISCONNECTED session owned by the target user to the physical
# console so it retains the discrete GPU. Never touches a connected session.
param([string] $User = "LocalUser")

$ErrorActionPreference = "SilentlyContinue"

# Parse `query session` output. Columns are fixed-width; the leading ">"
# marks the current session. We look for the target user in a Disc state.
$lines = (& query session) 2>$null
if (-not $lines) { exit 0 }

# Is any session already on the console with an active user? If so, do nothing.
$consoleActive = $false
foreach ($l in $lines) {
    if ($l -match '^\s*>?console\s+(\S+)\s+\d+\s+Active') { $consoleActive = $true }
}
if ($consoleActive) { exit 0 }

foreach ($l in $lines) {
    # SESSIONNAME USERNAME ID STATE ...
    if ($l -match '^\s*>?(\S*)\s+(\S+)\s+(\d+)\s+(\w+)') {
        $sessName = $matches[1]
        $userName = $matches[2]
        $sessId   = $matches[3]
        $state    = $matches[4]
        if ($userName -ieq $User -and $state -ieq 'Disc' -and $sessName -ne 'console') {
            & tscon $sessId /dest:console
            break
        }
    }
}
exit 0
'@

New-Item -Path $InstallDir -ItemType Directory -Force | Out-Null
Set-Content -Path $workerPath -Value $worker -Encoding UTF8
Write-Host "Wrote watchdog worker -> $workerPath"

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$workerPath`" -User `"$User`""

$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2)

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'PRISM Visualiser: keep the GPU session homed on the physical console (returns a disconnected target-user session to console via tscon).' | Out-Null

Write-Host "Registered scheduled task '$taskName' (SYSTEM, AtStartup + every $IntervalMinutes min)."
Write-Host "It only re-homes a DISCONNECTED '$User' session; connected sessions are never touched."
