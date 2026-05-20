# Install PRISM.Agent on a Rhino workstation

The PRISM workstation agent is a Windows-only .NET 8 service that drives
Rhino 8 via [Rhino.Inside](https://github.com/mcneel/rhino.inside) and
connects to PRISM Server over WSS. One agent process hosts N concurrent
worker slots; each slot has its own Rhino subprocess.

This is a placeholder install guide — Phase 8 will produce a signed `.msi`
attached to GitHub Releases. Until then, manual install steps:

## Prerequisites

- Windows 10 / 11 or Windows Server 2019+
- Rhino 8 installed and licensed (Zoo at `10.0.1.161` or local license)
- .NET 8 Runtime (the .msi installer will bundle this)
- Network reachability to `prism.rebus.industries:443` and
  `orbit.rebus.industries:443`

## Manual install (pre-MSI)

1. Download the latest `PRISM.Agent.zip` from
   [Releases](https://github.com/REBUS-ORBIT/prism/releases).
2. Extract to `C:\Program Files\PRISM.Agent\`.
3. Copy `agent-config.example.json` to `agent-config.json` and edit:
   ```jsonc
   {
     "prismUrl": "wss://prism.rebus.industries/ws/agent",
     "nodeName": "RB-DA2-PC01",
     "machineId": "auto",        // or paste a stable GUID
     "slots": 2,                 // concurrent Rhino instances
     "roles": ["conversion", "layering"]
   }
   ```
4. Install as a Windows service (PowerShell elevated):
   ```powershell
   sc.exe create PRISMAgent binPath= "C:\Program Files\PRISM.Agent\PRISM.Agent.exe" start= auto
   sc.exe start PRISMAgent
   ```
5. Verify in PRISM admin:
   - Open `https://prism.rebus.industries/admin/workstations`.
   - The new agent should appear within ~5s of starting the service.

## Logs

- Service stdout: `C:\ProgramData\PRISM.Agent\logs\agent.log`
- Rhino subprocess logs: `C:\ProgramData\PRISM.Agent\logs\slot-<n>.log`

## Updating

```powershell
sc.exe stop PRISMAgent
Expand-Archive -Force PRISM.Agent.zip -DestinationPath "C:\Program Files\PRISM.Agent\"
sc.exe start PRISMAgent
```

## Uninstall

```powershell
sc.exe stop PRISMAgent
sc.exe delete PRISMAgent
Remove-Item -Recurse -Force "C:\Program Files\PRISM.Agent"
Remove-Item -Recurse -Force "C:\ProgramData\PRISM.Agent"
```
