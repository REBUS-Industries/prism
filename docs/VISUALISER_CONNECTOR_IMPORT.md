# Visualiser — OrbitConnector.UE5 import path

This documents the connector-driven import path added to the PRISM visualiser
(orchestrator v0.5.13 / connector v0.1.24). It explains how to enable it, the
exact runtime flow, the config/env that drives it, and the prerequisite the
operator must satisfy on the workstation.

> **TL;DR** — point the agent at a fixed UE project that contains the built
> `OrbitConnector.UE5` plug-in + `orbit-cli.exe`, and the orchestrator will
> launch *that* project in `-game` + PixelStreaming and let the connector pull +
> load the selected ORBIT model, instead of staging glTF and running the
> Interchange Python importer.

---

## Why

The original streaming path is self-contained: the orchestrator pulls ORBIT over
its own REST receive pipeline, writes glTF to disk, fetches/scaffolds a template
project, imports the glTF with `import_orbit.py` (UE Interchange), then streams.

The connector path instead reuses the same `orbit-cli pull` → glTF/GLB →
`glTFRuntime` runtime-load mechanism that the interactive UE5 connector already
ships, *inside the streamed `-game` instance*. Benefits: one import code path
shared with the interactive connector, no separate Interchange template to keep
in sync, and the operator controls the exact project (lighting, post, level)
that gets streamed.

**The Interchange path is retained** as the fallback so a misconfigured fixed
project never fully regresses the working visualiser.

---

## Enabling it

Three inputs, all on the **agent**:

| Setting (`AgentConfig`) | Env forwarded to orchestrator | Meaning |
| --- | --- | --- |
| `VisualiserTemplateProjectPath` | `PRISM_VISUALISER_TEMPLATE_PROJECT` | Absolute path to the fixed UE project, e.g. `C:\PRISM\Templates\REBUS_Visualiser`. |
| `VisualiserConnectorImport` (`bool?`) | `PRISM_VISUALISER_CONNECTOR_IMPORT` (`1`/`0`, omitted when null) | `true`=force connector, `false`=force Interchange, `null`=auto-detect. |
| `VisualiserFullEditor` (`bool`) | `PRISM_VISUALISER_FULL_EDITOR` | Existing editor-streaming path; takes precedence over connector import. |

**Path selection precedence** (in `Program.cs` `RunPhaseFAsync`):

1. **Full-editor** if enabled → opens the fixed project in the editor (unchanged).
2. **Connector import** if `TryPrepareConnectorImportAsync` returns a prepared
   project. That happens when:
   - the env/flag is `1`/`true` (forced), **or**
   - the env/flag is unset (auto) **and** the fixed project resolves and
     `OrbitConnectorLocator.Detect(...).IsUsable` is true (plug-in + `orbit-cli`
     both present);
   - and is suppressed when the env/flag is `0`/`false`.
3. **Interchange** otherwise (default fallback; also the fallback if preparing
   the fixed project throws).

---

## Runtime flow

```
PRISM API  ── start visualiser session (project/model/version) ──▶ server
   server ── dispatch visualiser job ──▶ agent (VisualiserJob)
   agent  ── spawn: prism-visualiser stream … ──▶ orchestrator
                     + env PRISM_VISUALISER_TEMPLATE_PROJECT=C:\PRISM\Templates\REBUS_Visualiser
                     + env PRISM_VISUALISER_CONNECTOR_IMPORT (when set)
   orchestrator (RunPhaseFAsync):
     • TryPrepareConnectorImportAsync → prepares the fixed project, resolves the
       ORBIT bearer token, builds OrbitImportParams{server,project,model,version,token,target}
     • emits prism-visualiser/connector-import/v1 (stdout)
     • starts signalling (Wilbur), then UnrealLauncher.LaunchGameMode(… orbitImport)
   UnrealEditor-Cmd  REBUS_Visualiser.uproject -game -RenderOffScreen
                     -PixelStreamingURL=ws://127.0.0.1:<port> -PixelStreamingID=<id>
                     -OrbitServer= -OrbitProject= -OrbitModel= [-OrbitVersion=] [-OrbitToken=] [-OrbitTarget=]
   connector (FOrbitHeadlessAutoImport):
     • parses -Orbit* at module init, waits for the game world to BeginPlay
     • UOrbitImportSubsystem::OrbitImport(…)  → orbit-cli pull → glTFRuntime load
     • logs ORBIT_IMPORT_AUTOSTART / _PROGRESS / _READY / _FAILED to stdout
   orchestrator → emits visualisationReady once the stream is live; pixel-streams.
```

Files/functions:

- Orchestrator: `Program.cs::RunPhaseFAsync`, `Program.cs::TryPrepareConnectorImportAsync`,
  `Unreal/OrbitConnectorLocator.cs::Detect`, `Unreal/OrbitImportParams.cs`,
  `Pipeline/VisualiserPipeline.cs::StartStreamingAsync` / `ResolveOrbitTokenAsync`,
  `Unreal/UnrealLauncher.cs::LaunchGameMode` / `BuildGameStartInfoCore`.
- Agent: `Config/AgentConfig.cs::VisualiserConnectorImport`,
  `Pipeline/VisualiserJob.cs` (env forwarding + stdout event handling).
- Connector: `OrbitHeadlessAutoImport.{h,cpp}`, wired in
  `OrbitConnectorRuntime.cpp::StartupModule/ShutdownModule`. See the connector's
  `PRISM-INTEGRATION.md` §D for the marker contract.

---

## Progress / errors

The connector writes machine-readable markers to UE stdout (forwarded under
`-stdout -FullStdOutLogOutput`):

```
ORBIT_IMPORT_AUTOSTART {"server":"prod","project":"…","model":"…","version":"latest","target":"prod"}
ORBIT_IMPORT_PROGRESS 42.0 Downloading meshes…
ORBIT_IMPORT_READY {"ok":true,"components":128,"meshes":128,"message":"…"}
ORBIT_IMPORT_FAILED {"ok":false,"message":"…"}
```

These are surfaced in the orchestrator log for diagnostics. The orchestrator's
`visualisationReady` / `visualisationFailed` still come from the stream lifecycle
(unchanged), so the agent↔server protocol is backward-compatible.

The bearer token is passed as `-OrbitToken=` and is **never logged** (the
connector and `orbit-cli` both redact it).

---

## Prerequisite the operator MUST satisfy

The fixed project (default `C:\PRISM\Templates\<ProjectName>`, e.g.
`…\REBUSVis`) must actually contain the **built** connector + CLI:

```
C:\PRISM\Templates\<ProjectName>\
  Plugins\OrbitConnector\OrbitConnector.uplugin
  Plugins\OrbitConnector\ThirdParty\Cli\win-x64\orbit-cli.exe   (or Binaries\…)
```

**The agent's "Pull latest UE template" feature satisfies this automatically**
(agent v0.3.19+): it downloads the `orbit-ue-template` project into
`VisualiserTemplateRoot` (`C:\PRISM\Templates`), merges the latest
`OrbitConnector.UE5` plug-in (+ bundled `orbit-cli.exe` + the `glTFRuntime`
dependency) into the project's `Plugins\`, **compiles the project's Editor
target with UnrealBuildTool** (agent v0.3.21+, so the headless `-game` launch
has module binaries), and repoints `VisualiserTemplateProjectPath` at the
installed project. Because that location is local + already built, the
orchestrator opens it **in place** — it no longer mirrors it into
`%LOCALAPPDATA%` (visualiser v0.5.16+; a UNC/remote source is still mirrored as
a fallback).

If the `.uplugin` or `orbit-cli.exe` is missing, `OrbitConnectorLocator.Detect`
reports `IsUsable=false` and (in auto mode) the orchestrator falls back to
Interchange. Re-running the template pull (or pointing
`VisualiserTemplateProjectPath` at a project that already ships the built
plug-in) is the fix.

> The orchestrator references the CLI under the plug-in's `ThirdParty\Cli\win-x64`
> by default (`OrbitConnectorLocator.CliRelativePath`). If your packaging places
> `orbit-cli.exe` elsewhere, update that constant to match.

---

## Test / deploy plan (when approved)

1. Build the connector for UE 5.x and install it into
   `C:\PRISM\Templates\REBUS_Visualiser` (verify the two paths above exist).
2. On the workstation agent, set `VisualiserTemplateProjectPath` to the fixed
   project and leave `VisualiserConnectorImport` unset (auto-detect) for the
   first run; check the orchestrator log shows the
   `prism-visualiser/connector-import/v1` event and `ORBIT_IMPORT_*` markers.
3. Start a visualiser session via the PRISM API, select a known-good model,
   confirm geometry pops into the streamed view and the stream is interactive.
4. Negative test: temporarily rename the plug-in folder → confirm the
   orchestrator falls back to Interchange and still streams.
5. Only after sign-off: merge the PRs, tag the connector (`v0.1.24`) and the
   visualiser (`visualiser-v0.5.13`), and roll out per normal release flow.
