# PRISM.Agent

PRISM.Agent is a .NET 8 Windows service that hosts Rhino inside the process via
[Rhino.Inside](https://www.nuget.org/packages/Rhino.Inside/) and processes
CAD/mesh conversion jobs dispatched by the PRISM server.

---

## Installation

1. Download the latest `PRISM.Agent-*.zip` from the [GitHub Actions artifacts](../../actions).
2. Extract alongside `install.ps1` / `uninstall.ps1`.
3. Run from an elevated PowerShell:

```powershell
pwsh ./install.ps1 -PrismUrl wss://prism.rebus.industries/ws/agent -NodeName RB-DA2-PCxx -Slots 2
```

The installer copies the binary to `C:\Program Files\PRISM.Agent\`, writes
`agent-config.json`, and registers the `PRISM.Agent` Windows service with
automatic-restart on failure.

---

## Configuration (`agent-config.json`)

Place `agent-config.json` next to the exe or at `C:\ProgramData\PRISM.Agent\agent-config.json`.

```json
{
  "prismUrl":   "wss://prism.rebus.industries/ws/agent",
  "nodeName":   "RB-DA2-PC01",
  "machineId":  "auto",
  "slots":      2,
  "roles":      ["conversion", "layering"],
  "rhinoVersion": "auto",
  "logDir":     "C:\\ProgramData\\PRISM.Agent\\logs"
}
```

| Field | Default | Description |
|---|---|---|
| `prismUrl` | `wss://prism.rebus.industries/ws/agent` | PRISM server WebSocket endpoint |
| `nodeName` | machine hostname | Display name in the admin UI |
| `machineId` | `"auto"` | Stable ID; `"auto"` generates and persists a UUID in ProgramData |
| `slots` | `1` | Concurrent worker slots (Rhino is not re-entrant; controls queue depth) |
| `roles` | `["conversion","layering","receive"]` | Job types this node accepts |
| `rhinoVersion` | `"auto"` | **Rhino version selection** — see below |
| `logDir` | `C:\ProgramData\PRISM.Agent\logs` | Directory for Serilog file sink |

---

## Rhino Version Selection (`rhinoVersion`)

PRISM.Agent uses `Rhino.Inside` to host Rhino inside the .NET process.  On a
machine with multiple Rhino versions installed you can pin which one to use.

| Value | Behaviour |
|---|---|
| `"auto"` *(default)* | Calls `RhinoFinder.FindRhinoSystemDirectory(useLatest: true)` — selects the **highest** Rhino version installed on the machine. |
| `"8"` | Requires Rhino 8 specifically. Logs an error and exits if Rhino 8 is not installed. |
| `"9"` | Requires Rhino 9 specifically (future-proofing). Logs an error and exits if Rhino 9 is not installed. |
| *(any other string)* | Warning logged; falls back to `"auto"`. |

When no Rhino installation is found, the agent starts but logs a warning and
cannot process jobs until Rhino is installed.  This is by design — the service
can register with the PRISM server and come online as soon as Rhino is installed
and the service is restarted.

### Startup log example

```
info: PRISM.Agent.Rhino.RhinoVersionSelector[0]
      Rhino version selected: C:\Program Files\Rhino 8\System
info: PRISM.Agent.Rhino.RhinoHost[0]
      RhinoHost initialised (Rhino bootstrap deferred to installer / first job)
```

---

## Build

The agent is built by `.github/workflows/agent.yml` on every push to `main`
(paths under `agent/`, `shared/contracts/`, or `vendor/orbit-monorepo/`) and on
`workflow_dispatch`.

### NuGet version pinning

The project pins:

| Package | Version | Notes |
|---|---|---|
| `Rhino.Inside` | `9.0.26084.13070-beta` | Latest Rhino 8 hosting series on nuget.org |
| `RhinoCommon` | `8.31.26126.13431` | Compile-time stubs; `ExcludeAssets="runtime"` — Rhino supplies the DLL at runtime |

**Versioning note:** McNeel publishes `Rhino.Inside 9.x-beta` for hosting Rhino 8
inside another .NET process (`Rhino.Inside` major = Rhino major + 1).  The
`Rhino.Inside` package on nuget.org lists `RhinoCommon >= 9.x-wip` as a
transitive dependency (reflecting the package's development against the Rhino 9
WIP branch), but the resolver and finder code it ships does not expose any
Rhino-version-specific types in its public API.  We suppress `NU1605` (package
downgrade) and pin RhinoCommon to a known-good Rhino 8 stable release so CI
builds against clean stubs.

At runtime on a Rhino 8 workstation, `Resolver.Initialize(systemDir)` hooks
`AppDomain.AssemblyResolve` so all Rhino assembly loads come from the installed
Rhino 8 directory.

### CI NuGet source isolation

`agent/NuGet.Config` uses `<clear />` plus an explicit `nuget.org` entry to
block any McNeel WIP feeds that may be registered at the machine or user level on
the `windows-latest` GitHub Actions runner.  The Restore step also passes
`--source https://api.nuget.org/v3/index.json` as belt-and-suspenders.

---

## Supported formats

`.3dm`, `.dwg`, `.dxf`, `.fbx`, `.obj`, `.stl`, `.ply`,
`.3mf`, `.dae`, `.step` / `.stp`, `.iges` / `.igs`

---

## Uninstall

```powershell
pwsh ./uninstall.ps1            # removes service + files
pwsh ./uninstall.ps1 -KeepData  # removes service + files but keeps ProgramData
```
