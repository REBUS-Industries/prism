# PRISM.Agent — workstation install

PRISM.Agent is the Windows service that runs on each Rhino workstation
in the pool. It connects outbound to the PRISM server over WSS, advertises
its capabilities, and processes conversion / receive jobs against an
in-process Rhino 8 host.

## Prerequisites

- Windows 10 / 11 / Server 2019+ x64
- **Rhino 8** installed and licensed (Zoo or single-user)
- Outbound HTTPS + WSS to `prism.rebus.industries` (port 443)
- An admin PowerShell session

## Install

1. **Download the latest agent zip** from the [releases page](https://github.com/REBUS-ORBIT/prism/releases/latest)
   (file: `PRISM.Agent-vX.Y.Z.zip`).
2. **Unblock + extract** to a temp location:

   ```powershell
   Unblock-File .\PRISM.Agent-vX.Y.Z.zip
   Expand-Archive .\PRISM.Agent-vX.Y.Z.zip -DestinationPath .\PRISM.Agent
   cd .\PRISM.Agent
   ```

3. **Run the installer** from an elevated PowerShell:

   ```powershell
   ./install.ps1 `
     -PrismUrl wss://prism.rebus.industries/ws/agent `
     -NodeName $env:COMPUTERNAME `
     -Slots 2
   ```

   - `PrismUrl`: the agent WS endpoint (use `ws://10.0.200.211:8765/ws/agent`
     for LAN-direct, bypassing Caddy)
   - `NodeName`: friendly name surfaced in the admin pool
   - `Slots`: how many concurrent conversion jobs this machine handles
     (recommended: number of physical cores ÷ 2, capped at 4)

   The installer:
   - copies the payload to `C:\Program Files\PRISM.Agent\`
   - writes `agent-config.json`
   - registers + starts the `PRISM.Agent` Windows service
   - configures the service to restart automatically on failure

## Verify

```powershell
Get-Service PRISM.Agent
Get-Content C:\ProgramData\PRISM.Agent\logs\*.log -Tail 20 -Wait
```

In the [admin UI](https://prism.rebus.industries/admin/) the workstation
will appear under **Workstations** with `online` status within ~5 seconds.

## Configuration file

`C:\Program Files\PRISM.Agent\agent-config.json`:

```json
{
  "prismUrl": "wss://prism.rebus.industries/ws/agent",
  "nodeName": "RB-DA2-PC01",
  "slots":    2,
  "machineId": "auto",
  "logDir":   "C:\\ProgramData\\PRISM.Agent\\logs"
}
```

Edit + `Restart-Service PRISM.Agent` to apply changes.

## Roles

By default the agent advertises all three roles:

- `conversion` — accepts upload conversion jobs
- `layering`   — answers /prepare layer-inspection queries
- `receive`    — produces .3dm / .step from ORBIT versions

Disable a role in the admin UI per workstation (Workstations -> Edit)
to gate dispatch.

## Uninstall

```powershell
./uninstall.ps1
# Or, keeping logs / config:
./uninstall.ps1 -KeepData
```

## Troubleshooting

- **Service starts then immediately stops** — check `C:\ProgramData\PRISM.Agent\logs\`.
  Usually means Rhino 8 isn't installed at the expected path, or the
  Rhino.Inside bootstrap failed.
- **Service is online in admin but jobs never dispatch** — likely no
  matching format in `supportedFormats` or `isEnabled=false`. Edit the
  workstation row in the admin UI.
- **Job dispatches but fails immediately** — most often an ORBIT auth
  problem. Confirm `orbit_token` / `orbit_dev_token` are set in admin
  Settings, and that the workstation can reach `orbit-server` on the LAN.
