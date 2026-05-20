<#
.SYNOPSIS
  Installs PRISM.Agent as a Windows service on the local workstation.

.DESCRIPTION
  - Copies the publish payload to C:\Program Files\PRISM.Agent\
  - Writes agent-config.json from the supplied parameters (or prompts)
  - Registers and starts the Windows service "PRISM.Agent"

.PARAMETER PrismUrl
  The PRISM server WS URL (e.g. wss://prism.rebus.industries/ws/agent).

.PARAMETER NodeName
  Human-readable name shown in the admin UI. Defaults to the machine name.

.PARAMETER Slots
  Concurrent worker slots this agent exposes. Defaults to 1.

.EXAMPLE
  pwsh ./install.ps1 -PrismUrl wss://prism.rebus.industries/ws/agent -NodeName RB-DA2-PC01 -Slots 2
#>

param(
    [Parameter(Mandatory)] [string] $PrismUrl,
    [string] $NodeName = $env:COMPUTERNAME,
    [int]    $Slots    = 1,
    [string] $InstallDir = "C:\Program Files\PRISM.Agent",
    [string] $DataDir    = "C:\ProgramData\PRISM.Agent"
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "install.ps1 must be run from an elevated PowerShell."
}

Write-Host "PRISM.Agent installer"
Write-Host "  Server   : $PrismUrl"
Write-Host "  Node     : $NodeName"
Write-Host "  Slots    : $Slots"
Write-Host "  InstallDir: $InstallDir"
Write-Host "  DataDir  : $DataDir"

New-Item -Path $InstallDir -ItemType Directory -Force | Out-Null
New-Item -Path $DataDir    -ItemType Directory -Force | Out-Null
New-Item -Path (Join-Path $DataDir 'logs') -ItemType Directory -Force | Out-Null

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$payload = Get-ChildItem -Path $scriptRoot -Filter PRISM.Agent.exe -Recurse | Select-Object -First 1
if (-not $payload) { throw "PRISM.Agent.exe not found alongside install.ps1" }

Write-Host "Copying payload from $($payload.DirectoryName) -> $InstallDir"
Copy-Item -Path (Join-Path $payload.DirectoryName '*') -Destination $InstallDir -Recurse -Force

$config = @{
    prismUrl     = $PrismUrl
    nodeName     = $NodeName
    slots        = $Slots
    logDir       = (Join-Path $DataDir 'logs')
    machineId    = 'auto'
} | ConvertTo-Json -Depth 4
$configPath = Join-Path $InstallDir 'agent-config.json'
Set-Content -Path $configPath -Value $config -Encoding UTF8
Write-Host "Wrote $configPath"

$svcName = 'PRISM.Agent'
$exePath = Join-Path $InstallDir 'PRISM.Agent.exe'

if (Get-Service -Name $svcName -ErrorAction SilentlyContinue) {
    Write-Host "Stopping existing service..."
    Stop-Service $svcName -Force -ErrorAction SilentlyContinue
    sc.exe delete $svcName | Out-Null
    Start-Sleep -Seconds 2
}

Write-Host "Registering Windows service..."
New-Service -Name $svcName `
            -BinaryPathName "`"$exePath`"" `
            -DisplayName 'PRISM Workstation Agent' `
            -Description 'REBUS-ORBIT PRISM conversion agent (Rhino headless host)' `
            -StartupType Automatic | Out-Null

# Restart policy: try 3 times with 30-second waits, then leave it failed
# so the admin can see it in services.msc.
sc.exe failure $svcName reset= 86400 actions= restart/30000/restart/30000/restart/30000 | Out-Null

Write-Host "Starting $svcName..."
Start-Service $svcName

Write-Host "Done. Tail the log at: $(Join-Path $DataDir 'logs')"
