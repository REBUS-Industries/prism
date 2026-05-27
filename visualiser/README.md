# PRISM Visualiser

Windows-native orchestrator that turns an ORBIT model version into a live
Unreal-Engine + Pixel-Streaming session. Designed to be spawned by the
PRISM Agent on a workstation that has UE installed; reads ORBIT objects +
blobs from the configured ORBIT server, imports them into a UE editor
session, brings up Cirrus (the signalling server), and hands the agent a
`playerUrl` + `signallingUrl` over stdout so the agent can publish the
ready state back to the PRISM server.

## Status — Phase B scaffold (non-functional)

This is the **Phase B** drop. Only `--dry-run` is wired up. The scaffold
proves the skeleton boots and emits a wire-compatible ready event. No
real ORBIT fetch, no UE, no Pixel Streaming, no cache eviction.

Phases C – F will land the real fetch / stage / launch / supervise paths
on top of this skeleton without changing the public CLI surface.

## Layout

```
visualiser/
├── PRISM.Visualiser.sln
├── Directory.Build.props                  ← shared Version, Nullable, LangVersion, etc.
├── CHANGELOG.md
├── src/PRISM.Visualiser.Orchestrator/
│   ├── PRISM.Visualiser.Orchestrator.csproj
│   ├── Program.cs                         ← System.CommandLine wiring
│   ├── Models/
│   │   ├── RunManifest.cs                 ← per-run immutable state
│   │   ├── ServerConfig.cs                ← prod / dev URL placeholders
│   │   └── ReadyEvent.cs                  ← "prism-visualiser/ready/v1"
│   ├── Ipc/ReadyHandshake.cs              ← writes the JSON line to stdout
│   ├── Process/
│   │   ├── JobObject.cs                   ← Win32 KILL_ON_JOB_CLOSE
│   │   └── ProcessSupervisor.cs           ← log capture skeleton
│   ├── Logging/StructuredLog.cs           ← Serilog (stderr + file)
│   └── Cache/CacheRoot.cs                 ← %LOCALAPPDATA%\PRISM.Visualiser\cache
└── tests/PRISM.Visualiser.Orchestrator.Tests/
    └── ReadyHandshakeTests.cs             ← JSON shape parity
```

## Build

From the repo root:

```powershell
dotnet build PRISM/visualiser/PRISM.Visualiser.sln -c Release
```

Or just the orchestrator:

```powershell
dotnet build PRISM/visualiser/src/PRISM.Visualiser.Orchestrator -c Release
```

## Test

```powershell
dotnet test PRISM/visualiser/tests/PRISM.Visualiser.Orchestrator.Tests
```

## Run (dry-run only — Phase B)

```powershell
$runId = [guid]::NewGuid().ToString()
dotnet run --project PRISM/visualiser/src/PRISM.Visualiser.Orchestrator -- `
  stream `
    --server prod `
    --project demo `
    --model demo `
    --version demo `
    --run-id $runId `
    --signalling-port-hint 8888 `
    --json `
    --dry-run
```

Sample output (single line on stdout, `\n` terminated):

```json
{"schema":"prism-visualiser/ready/v1","status":"ready","runId":"…","projectId":"demo","modelId":"demo","versionId":"demo","playerUrl":"http://127.0.0.1:0/","signallingUrl":"ws://127.0.0.1:0/","streamerId":"orbit_…","ueProcessId":0,"signallingProcessId":0,"logsDir":"C:\\Users\\…\\AppData\\Local\\PRISM.Visualiser\\runs\\…\\logs"}
```

Serilog goes to **stderr** (Information+) and to a rolling file under
`%LOCALAPPDATA%\PRISM.Visualiser\runs\<runId>\logs\orchestrator.log`
(Verbose+).

## CLI surface

```
prism-visualiser stream
  --server <prod|dev>            ORBIT environment selector
  --project <id>                 ORBIT project id
  --model <id>                   ORBIT model id
  --version <id>                 ORBIT version id
  --run-id <uuid>                caller-supplied run UUID
  --signalling-port-hint <port>  preferred Cirrus port
  --json                         required; ready event is JSON on stdout
  [--dry-run]                    skip real work; emit fake ready event

prism-visualiser cache prune
  --older-than <duration>        e.g. 14d, 12h, 30m (stub in Phase B)
```

## Job Object semantics

`Program.Main` creates a Win32 Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and assigns the current process to
it before parsing any arguments. `JobObject.AddProcess(pid)` is the
entry point Phase E/F will call for the Cirrus + UE child processes the
real `stream` path spawns. If the orchestrator dies for any reason — a
caller kills its parent agent shell, the OS reaps it, an unhandled
exception escapes Main — the children die with it. No orphan UE / Cirrus
processes ever.

## Versioning

The orchestrator versions independently of the PRISM Agent. Single
source of truth lives in
[`Directory.Build.props`](./Directory.Build.props):

```xml
<VisualiserVersion>0.1.0</VisualiserVersion>
```

CI publishes a release on a tag matching `visualiser-v<VisualiserVersion>`
to
[`REBUS-ORBIT/prism-visualiser`](https://github.com/REBUS-ORBIT/prism-visualiser).

## Links

- Plan: `.cursor/plans/prism_visualiser_role_d36fa628.plan.md`
- Companion: `BUILD.md` §10 ("Server → agent WS")
- Changelog: [./CHANGELOG.md](./CHANGELOG.md)
