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

## ORBIT IDs as a UE command-line variable (all launch paths)

The ORBIT **session identity** — `-OrbitServer=`, `-OrbitProject=`,
`-OrbitModel=`, `-OrbitVersion=` (omitted when "latest"), `-OrbitTarget=` — is
appended to the UE command line on **every** streaming launch path, not just the
connector-import path:

| Launch path | Builder (`Unreal/UnrealLauncher.cs`) | Identity args | `-OrbitToken=` |
| --- | --- | --- | --- |
| Streaming `-game` (connector-import) | `BuildGameStartInfoCore` | ✅ | ✅ (needed to pull) |
| Streaming `-game` (Interchange fallback) | `BuildGameStartInfoCore` | ✅ | ❌ |
| Full-editor + stream | `BuildFullEditorStreamingStartInfoCore` | ✅ | ❌ |

All three call the shared `AppendOrbitArgs(psi, orbitImport)` helper. The
orchestrator builds the identity from the run manifest for **every** session
(`Program.cs::RunPhaseFAsync`) and only adds the bearer `-OrbitToken=` on the
connector-import path (`orbitImport with { Token = … }`). The
project/model/version/server/target are **not secret** and are logged; the token
is a secret and is **never** logged (only a `set (redacted)` / `<unset>`
indicator), exactly like `-RebusApiKey=` (see `PORTAL_INTEGRATION.md`).

This means the command line is the **UE-native shared variable**: any
plugin/module (the connector, the Portal plugin, a Blueprint library, …) can read
the IDs without depending on the connector. The canonical accessor:

```cpp
// Anywhere a UE module/plugin has run (module Startup, GameInstance init,
// subsystem Initialize, an actor's BeginPlay, etc.). FCommandLine::Get()
// returns the full process command line UE was launched with.
FString OrbitProject, OrbitModel, OrbitVersion, OrbitServer;
FParse::Value(FCommandLine::Get(), TEXT("OrbitProject="), OrbitProject);
FParse::Value(FCommandLine::Get(), TEXT("OrbitModel="),   OrbitModel);
FParse::Value(FCommandLine::Get(), TEXT("OrbitVersion="), OrbitVersion); // empty == latest
FParse::Value(FCommandLine::Get(), TEXT("OrbitServer="),  OrbitServer);  // "prod" | "dev" | https URL
```

> `FParse::Value` matches the `Key=` token anywhere on the command line and
> handles optional quoting, so values with spaces round-trip. Do **not** read
> `-OrbitToken=` from outside the connector's auth path — treat it as a secret.

### Recommended companion change (connector repo — NOT in this PRISM repo)

The "expose the IDs as a Blueprint-/subsystem-readable `UObject` property" piece
is UE C++ that belongs in the **`OrbitConnector.UE5`** plugin in the
`orbit-connectors` repo (its source is not vendored into this PRISM checkout, so
it is not changed here). Suggested shape — a tiny `UGameInstanceSubsystem` that
parses the command line once and exposes the IDs to Blueprint and other plugins:

```cpp
UCLASS()
class ORBITCONNECTOR_API UOrbitSessionSubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()
public:
    virtual void Initialize(FSubsystemCollectionBase& Collection) override
    {
        const TCHAR* Cmd = FCommandLine::Get();
        FParse::Value(Cmd, TEXT("OrbitProject="), ProjectId);
        FParse::Value(Cmd, TEXT("OrbitModel="),   ModelId);
        FParse::Value(Cmd, TEXT("OrbitVersion="), VersionId);
        FParse::Value(Cmd, TEXT("OrbitServer="),  Server);
        // NB: never expose -OrbitToken= here; it is a secret.
    }

    UPROPERTY(BlueprintReadOnly, Category="Orbit") FString ProjectId;
    UPROPERTY(BlueprintReadOnly, Category="Orbit") FString ModelId;
    UPROPERTY(BlueprintReadOnly, Category="Orbit") FString VersionId; // empty == latest
    UPROPERTY(BlueprintReadOnly, Category="Orbit") FString Server;
};
```

Other plugins read it with
`GetGameInstance()->GetSubsystem<UOrbitSessionSubsystem>()`. A `UBlueprintFunctionLibrary`
with `static` getters is an equally valid alternative if a subsystem is too
heavy. Either way, the PRISM-side plumbing above already guarantees the IDs are
on the command line for it to read.

---

## Imported model orientation

The imported model needs a **90° clockwise yaw about the vertical Z axis** to be
correctly oriented in the visualiser. The two import paths apply this in
different places:

- **Interchange path (this repo):** the importer
  `Unreal/PythonScripts/import_orbit.py` yaws the spawned model root by the
  named constant `ORBIT_IMPORT_YAW_DEGREES` (default **`+90.0`**). The value is
  positive because UE is left-handed / Z-up and a *positive* yaw turns +X→+Y =
  **clockwise** when viewed top-down, which is the requested direction. Override
  per workstation (no rebuild) with the env var
  **`PRISM_VISUALISER_IMPORT_YAW_DEG`** (`-90` flips it, `0` disables, `180`
  reverses). Note this is independent of `Staging/CoordinateTransform.cs`, which
  only scales (×100) and mirrors Y for handedness — it applies **no** rotation,
  so the importer yaw is not stacked on an existing correction.

- **Connector-import path (`orbit-connectors` repo — NOT vendored here):** the
  model is loaded by **glTFRuntime** inside the `-game` instance via
  `FOrbitHeadlessAutoImport`, so the orientation is governed by the connector's
  glTFRuntime load config / spawned-actor rotation, **not** by this orchestrator.
  The orchestrator's staged glTF (`GltfWriter` / `CoordinateTransform`) does **not**
  feed this path — `orbit-cli pull` produces its own glTF — so the Interchange
  fix above does not affect it. **Recommended companion change (in the connector
  repo):** apply the same +90° CW (i.e. `Yaw = +90`) about Z where the connector
  configures the glTFRuntime load — e.g. set the actor/scene `Rotation` on the
  `FglTFRuntimeStaticMeshConfig` / spawn transform in `FOrbitHeadlessAutoImport`
  (or expose a matching `OrbitImportYawDegrees` knob). Use the same sign + naming
  so the two paths stay consistent.

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

## GitHub API token & rate limits (`PRISM_GITHUB_TOKEN`)

The template pull and the version picker call the **GitHub REST API**
(resolve the template release + assets, resolve the `OrbitConnector-UE5`
plug-in asset, and list releases for the dropdown). A single pull makes
**~2–4 API calls**; the picker endpoints add ~1 per cache refresh.

Without a token, GitHub allows only **60 requests/hour per IP** (shared,
anonymous), so a few pulls or dropdown opens exhaust the budget and the pull
fails with:

```
GitHub API rate limit exceeded (HTTP 403) … Set PRISM_GITHUB_TOKEN … Limit resets at <time>.
```

**Fix: configure a GitHub token** (a GitHub PAT — scope `public_repo`, or `repo`
if `orbit-ue-template` / `orbit-connectors` are private; generate at
<https://github.com/settings/tokens>). An authenticated token lifts the limit
to **5000 requests/hour**. Set it in **both** places that call GitHub:

| Component | Where to set it | Applies after |
| --- | --- | --- |
| **Agent** (workstation — runs the pull) | **Preferred (agent v0.3.26+): the agent web UI** — the *GitHub token* field in the Visualiser/Template card (write-only; shows "token set" once saved). It is stored in the agent config and **read at pull time, so no restart is needed**. Alternatively a `PRISM_GITHUB_TOKEN` (or `GITHUB_TOKEN`) **environment variable** on the workstation. The configured token takes **precedence** over the env vars. | Web UI: immediately (next pull). Env var: restart the agent. |
| **Server** (admin version dropdown) | `infra/.env` → `PRISM_GITHUB_TOKEN=…` (passed through by `infra/docker-compose.yml`). | Recreate the `prism-server` container. |

Call-volume safeguards already in place: the agent and server release-list
endpoints cache for 5 minutes **and** revalidate with an `ETag`
(`If-None-Match`) — a `304 Not Modified` refresh does **not** count against the
limit. A 403/429 with `x-ratelimit-remaining: 0` is reported distinctly (with
the reset time) rather than as a generic failure; the admin picker surfaces it
as HTTP 429.

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
