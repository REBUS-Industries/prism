<#
.SYNOPSIS  Removes the PRISM.Agent Windows service and on-disk payload.
#>
param(
    [string] $InstallDir = "C:\Program Files\PRISM.Agent",
    [string] $DataDir    = "C:\ProgramData\PRISM.Agent",
    [switch] $KeepData
)

$ErrorActionPreference = 'Stop'
$svcName = 'PRISM.Agent'

if (Get-Service -Name $svcName -ErrorAction SilentlyContinue) {
    Write-Host "Stopping $svcName..."
    Stop-Service $svcName -Force -ErrorAction SilentlyContinue
    sc.exe delete $svcName | Out-Null
    Start-Sleep -Seconds 2
}

if (Test-Path $InstallDir) {
    Write-Host "Removing $InstallDir"
    Remove-Item -Path $InstallDir -Recurse -Force
}

if (-not $KeepData -and (Test-Path $DataDir)) {
    Write-Host "Removing $DataDir"
    Remove-Item -Path $DataDir -Recurse -Force
} elseif ($KeepData) {
    Write-Host "Keeping data dir at $DataDir"
}

Write-Host "Uninstalled."
