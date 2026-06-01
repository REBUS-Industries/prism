<#
.SYNOPSIS
  Configure (or disable) Windows auto-logon for the PRISM Visualiser
  workstation so a persistent, GPU-backed interactive session always
  exists for the PRISM agent to launch Unreal Engine into.

.DESCRIPTION
  The PRISM agent runs as an *interactive* scheduled task ("PRISM.Agent",
  LogonType=Interactive, triggers AtLogOn + AtStartup) under the local
  workstation account. It spawns prism-visualiser.exe -> UnrealEditor-Cmd
  as child processes, so UE lands in the SAME Windows session as the agent.

  That session is a real interactive desktop session and therefore has
  access to the discrete GPU (e.g. the RTX 6000 Ada on RB-DA2-PC01).
  A *disconnected* RDP session keeps the GPU and keeps UE rendering, but
  **logging off destroys the session** and takes the agent + UE with it.

  The durable fix is to make a persistent interactive session that exists
  at boot and is never logged off:

    1. Enable auto-logon of the LOCAL workstation account at boot. Windows
       creates the console session automatically on every boot (reboot-safe),
       the PRISM.Agent AtLogOn trigger fires inside it, and UE inherits the
       GPU-backed session.
    2. Operators connect with RDP/Parsec for maintenance and ALWAYS
       *Disconnect* (never *Log off*). Disconnect leaves the session -- and
       any live stream -- running in the background.

  This script ONLY touches the local-account auto-logon registry values
  under HKLM\...\Winlogon. It backs the key up to a timestamped .reg file
  before making any change. It never stores domain credentials.

  CREDENTIAL HANDLING
  -------------------
  Auto-logon needs the account password. Two storage options:

    * Sysinternals Autologon (PREFERRED): stores the password as an
      encrypted LSA secret, not as plaintext in the registry. If
      Autologon64.exe is on PATH or supplied via -SysinternalsAutologon,
      this script shells out to it.

    * Registry DefaultPassword (FALLBACK): plaintext under Winlogon.
      Used only when you pass -Password and Sysinternals Autologon is not
      available. Acceptable for a dedicated local render account on a
      LAN-only box, but less secure.

  If you run this WITHOUT a password (the default), it runs in PREPARE
  mode: it backs up the key, sets the non-secret values
  (DefaultUserName / DefaultDomainName), leaves AutoAdminLogon=0 so the
  next boot is unaffected, and prints the exact command to finish
  enabling. This avoids any risk of a broken boot before the password
  is set.

.PARAMETER User
  Local account to auto-logon. Default: 'LocalUser'.

.PARAMETER Domain
  Logon domain. For a local account this is the COMPUTER NAME. Default:
  $env:COMPUTERNAME. Do NOT pass an AD domain here -- keep this a local
  account so no domain credentials are stored on the box.

.PARAMETER Password
  Plaintext password for -User. When supplied (and Sysinternals Autologon
  is not used) the script fully enables auto-logon via the registry
  DefaultPassword value. Omit to run in PREPARE mode.

.PARAMETER SysinternalsAutologon
  Path to Autologon64.exe / Autologon.exe. When supplied together with
  -Password, the script uses Sysinternals Autologon (LSA-secret storage)
  instead of the plaintext registry value.

.PARAMETER Disable
  Turn auto-logon OFF: set AutoAdminLogon=0 and remove DefaultPassword.
  Leaves DefaultUserName/DefaultDomainName intact (harmless).

.PARAMETER BackupDir
  Directory for the Winlogon .reg backup. Default:
  C:\ProgramData\PRISM.Agent\backups.

.EXAMPLE
  # PREPARE only (no password): safe to run any time, no boot impact.
  & 'C:\Program Files\PRISM.Agent\install\Set-VisualiserAutoLogon.ps1'

.EXAMPLE
  # Fully enable using the encrypted LSA-secret store (preferred).
  & 'C:\Program Files\PRISM.Agent\install\Set-VisualiserAutoLogon.ps1' `
      -SysinternalsAutologon 'C:\Tools\Autologon64.exe' -Password 'P@ss'

.EXAMPLE
  # Fully enable via the registry fallback (plaintext DefaultPassword).
  & 'C:\Program Files\PRISM.Agent\install\Set-VisualiserAutoLogon.ps1' -Password 'P@ss'

.EXAMPLE
  # Turn auto-logon back off.
  & 'C:\Program Files\PRISM.Agent\install\Set-VisualiserAutoLogon.ps1' -Disable
#>

param(
    [string] $User    = 'LocalUser',
    [string] $Domain  = $env:COMPUTERNAME,
    [string] $Password,
    [string] $SysinternalsAutologon,
    [switch] $Disable,
    [string] $BackupDir = 'C:\ProgramData\PRISM.Agent\backups'
)

$ErrorActionPreference = 'Stop'

# Elevation required: Winlogon values + LSA secrets are HKLM-backed.
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Set-VisualiserAutoLogon.ps1 must be run from an elevated PowerShell."
}

$winlogonReg = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$winlogonKey = 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'

# ---- Always back up the Winlogon key first ----
New-Item -Path $BackupDir -ItemType Directory -Force | Out-Null
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $BackupDir "Winlogon-$stamp.reg"
Write-Host "Backing up Winlogon key -> $backup"
& reg.exe export $winlogonKey $backup /y | Out-Null
if ($LASTEXITCODE -ne 0) { throw "reg export failed ($LASTEXITCODE); aborting before any change." }

function Set-WinlogonValue([string]$Name, [string]$Value) {
    Set-ItemProperty -Path $winlogonReg -Name $Name -Value $Value -Type String
}

# ---- Disable path ----
if ($Disable) {
    Write-Host "Disabling auto-logon..."
    Set-WinlogonValue 'AutoAdminLogon' '0'
    Remove-ItemProperty -Path $winlogonReg -Name 'DefaultPassword' -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $winlogonReg -Name 'AutoLogonCount'  -ErrorAction SilentlyContinue
    Write-Host "Auto-logon disabled. DefaultUserName/DefaultDomainName left intact."
    Write-Host "NOTE: If you used Sysinternals Autologon, also run 'Autologon64.exe' once and click 'Disable' to clear the LSA secret."
    return
}

# ---- Non-secret values (safe in both PREPARE and ENABLE modes) ----
Write-Host "Setting DefaultUserName = $User"
Set-WinlogonValue 'DefaultUserName' $User
Write-Host "Setting DefaultDomainName = $Domain"
Set-WinlogonValue 'DefaultDomainName' $Domain
# AutoLogonCount makes auto-logon a one-shot; we want it permanent, so clear it.
Remove-ItemProperty -Path $winlogonReg -Name 'AutoLogonCount' -ErrorAction SilentlyContinue

$useSysinternals = -not [string]::IsNullOrWhiteSpace($SysinternalsAutologon)

if ([string]::IsNullOrEmpty($Password)) {
    # ---- PREPARE mode: do NOT enable; no boot impact ----
    Set-WinlogonValue 'AutoAdminLogon' '0'
    Write-Host ""
    Write-Host "PREPARE mode complete (auto-logon NOT yet enabled; next boot is unaffected)."
    Write-Host "Backup: $backup"
    Write-Host ""
    Write-Host "To FINISH enabling, an operator who knows the $User password runs ONE of:"
    Write-Host "  # Preferred (encrypted LSA secret):"
    Write-Host "  & '$PSCommandPath' -SysinternalsAutologon 'C:\Tools\Autologon64.exe' -Password '<pwd>'"
    Write-Host "  # Fallback (plaintext registry DefaultPassword):"
    Write-Host "  & '$PSCommandPath' -Password '<pwd>'"
    return
}

# ---- ENABLE mode ----
if ($useSysinternals) {
    if (-not (Test-Path $SysinternalsAutologon)) {
        throw "Sysinternals Autologon not found at: $SysinternalsAutologon"
    }
    Write-Host "Enabling auto-logon via Sysinternals Autologon (LSA secret)..."
    # Autologon[64].exe <user> <domain> <password> [/accepteula]
    & $SysinternalsAutologon $User $Domain $Password /accepteula
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Autologon returned $LASTEXITCODE. Verify the credentials and rerun."
    }
    # Autologon sets AutoAdminLogon=1 itself; make sure DefaultUserName matches.
    Set-WinlogonValue 'AutoAdminLogon' '1'
    # Belt-and-braces: ensure no stale plaintext password remains.
    Remove-ItemProperty -Path $winlogonReg -Name 'DefaultPassword' -ErrorAction SilentlyContinue
}
else {
    Write-Host "Enabling auto-logon via registry DefaultPassword (plaintext fallback)..."
    Set-WinlogonValue 'AutoAdminLogon'  '1'
    Set-WinlogonValue 'DefaultPassword' $Password
}

Write-Host ""
Write-Host "Auto-logon ENABLED for $Domain\$User."
Write-Host "Backup: $backup"
Write-Host "Reboot when convenient to validate: the box should log $User onto the"
Write-Host "console session automatically and the PRISM.Agent task should start in it."
Write-Host ""
Write-Host "OPERATIONAL RULE: connect with RDP/Parsec for maintenance, then DISCONNECT."
Write-Host "NEVER 'Log off' -- that destroys the GPU session and stops the visualiser."
