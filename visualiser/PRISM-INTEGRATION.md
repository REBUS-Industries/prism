# PRISM ↔ Visualiser Integration Contract

This document describes how the **PRISM visualiser** drives an Unreal Engine
project end-to-end, and the division of responsibilities between **PRISM**, the
**UE plugin team** (ORBIT connector + Rebus fixture-control plugins), and the
**portal**. It is a shared reference for the portal dev and the UE-project dev so
everyone implements against the same contract.

Read alongside:
- the portal's **UE Fixture Control & Motion Spec** (control descriptors, motion
  rig math, IES) — owned by the portal/UE-plugin side,
- the **ORBIT UE5 Connector** plan (`OrbitConnector.UE5` / `orbit-cli`) — owned by
  the connector dev.

---

## 1. End-to-end workflow & ownership

| Step | What happens | Owner |
|---|---|---|
| 1 | Portal issues "start visualiser" with an ORBIT **project + model (+ version)** and an API key | **Portal** |
| 2 | PRISM server validates the key/scope, selects an online **Visualise-role** workstation, dispatches the run | **PRISM** |
| 3 | PRISM agent on the workstation launches the UE project (headless `-game` + Pixel Streaming) | **PRISM** |
| 4 | UE imports the ORBIT model into the live world | **UE plugin (OrbitConnector)** |
| 5 | Pixel Streaming starts; PRISM relays it (signalling + TURN) to the browser viewer | **PRISM** |
| 6 | Operator controls fixtures/camera/selection; the portal sends control over the WebRTC data channel | **Portal → UE plugin (RebusVisualiser)** |

PRISM owns steps 2, 3, 5 (dispatch, launch, transport). The UE plugin owns step 4
(import) and step 6's consumer side (control intake + fixture behaviour). The
portal owns steps 1 and 6's producer side.

---

## 2. Current PRISM ORBIT-connector workflow (what runs today)

PRISM already implements the connector-import path: a fixed UE project that bundles
the ORBIT connector plugin + Pixel Streaming, launched headless, with the plugin
importing the model at runtime.

1. **Portal → server:** `POST /api/visualiser/streams` (`{ projectId, modelId,
   versionId?, orbitTarget }`), auth = API key with `visualiser:create_stream`
   scope. Server selects a `can_visualise` workstation and dispatches the run to
   its agent with a resolved ORBIT token.
2. **Agent → orchestrator:** the agent spawns the orchestrator with a run manifest
   (ORBIT target + token + run id).
3. **Orchestrator chooses the import path** (tri-state — CLI `--connector-import`,
   env `PRISM_VISUALISER_CONNECTOR_IMPORT`, default **auto**):
   - **Connector-import (production):** resolves the configured fixed project
     (`PRISM_VISUALISER_TEMPLATE_PROJECT`) and verifies via `OrbitConnectorLocator`
     that it ships **`Plugins/OrbitConnector/OrbitConnector.uplugin`** and
     **`Plugins/OrbitConnector/ThirdParty/Cli/win-x64/orbit-cli.exe`**. If present,
     it copies the project to a local cache and uses it.
   - **Legacy Interchange (fallback):** if no connector project is detected, the
     orchestrator does the ORBIT receive itself, stages a `.glb`, and runs
     `import_orbit.py` to build a per-run level. (Being phased out.)
4. **Launch (headless production):**
   ```
   UnrealEditor-Cmd.exe <project>.uproject [<levelPath>] -game \
     -RenderOffScreen -ResX=1920 -ResY=1080 \
     -PixelStreamingURL=ws://127.0.0.1:<streamerPort> \
     -PixelStreamingID=orbit_<shortRunId> \
     -Unattended -NoSplash -NoPause -stdout -FullStdOutLogOutput -log \
     -OrbitServer=<url> -OrbitProject=<id> -OrbitModel=<id> \
     [-OrbitVersion=<id>] [-OrbitToken=<pat>] [-OrbitTarget=prod|dev]
   ```
5. **Plugin imports at runtime:** the connector's `FOrbitHeadlessAutoImport` reads
   the `-Orbit*` tokens at module init and calls `UOrbitImportSubsystem::OrbitImport`
   once the game world begins play. `orbit-cli` pulls the model from ORBIT, writes a
   `.glb`, and glTFRuntime loads it into the streamed world.
6. **Streaming transport:** per-run Cirrus/Wilbur signalling with distinct
   **streamer / player / SFU** ports, the PS2 **WebRTC data channel** (inherent to
   the streamer), and **coturn TURN** on VM 211 for NAT traversal. The browser
   viewer connects through the PRISM signalling proxy.

**PRISM's contract with the UE project is simply:** *launch it `-game` with PS2 +
the `-Orbit*` tokens; the project's connector plugin performs the import.* Any
project that bundles `Plugins/OrbitConnector/` (uplugin + `orbit-cli`) with PS2
enabled is driven identically and auto-detected — no PRISM change required.

---

## 3. Pixel Streaming transport details (PRISM-provided)

- **Signalling:** PRISM brings up the PS2 Cirrus/Wilbur signalling server per run,
  allocating free **streamer**, **player/HTTP**, and **SFU** ports (the SFU port is
  passed explicitly as `--sfu_port` so Wilbur never collides on the default 8889).
- **Streamer match:** PRISM waits for the UE streamer to register
  (`LogPixelStreaming2EpicRtc … RoomSignallingContextObserver::OnJoined … [Joined]`)
  before marking the run ready.
- **Data channel:** part of the PS2 streamer by default. The portal's
  `emitUIInteraction` control descriptors ride this channel and are delivered to
  UE's `PixelStreamingInput.OnInputEvent`. **PRISM requires no change to carry it.**
- **TURN:** coturn on VM 211 (`visualiser.rebus.industries`), credentials minted
  per session, for browsers that can't reach the host directly. Bundle:
  `turn:visualiser.rebus.industries:3478` + `turns:…:5349`, HMAC-SHA1 credential
  over `<expiry>:<runid-seg>`, `ttl 86400`; relay UDP range `52000–56999`.
- **Multi-viewer:** a single run serves ~5 concurrent browser viewers with
  view-only / control permission tiers, a single-controller lock, and
  shareable links. PRISM's signalling proxy (`signallingProxyRegistry.ts`)
  routes each viewer independently, and the agent's `SignallingBridge` opens one
  local signalling WS per viewer for clean demux. Share links are minted via the
  `/viewer/` page + share-link endpoints (DB table `visualiser_share_links`).
- **Render mode:** production uses `-RenderOffScreen` (headless). The portal routes
  fixture control over the data channel (not viewport input injection), which
  sidesteps the headless `-RenderOffScreen` viewport-repaint caveat by design.

---

## 4. Token handoff

PRISM resolves an ORBIT token server-side and passes it to UE via `-OrbitToken`.
The connector falls back to `ORBIT_TOKEN` / a cached `orbit-cli` login if no token
is supplied. The token authorises `orbit-cli`'s pull from the ORBIT server for the
requested project/model/version. (The portal must ensure the target project is
shared with PRISM's ORBIT service-token user.)

---

## 5. Responsibility split — what each side adds

### PRISM provides today (done)
- Start-stream API, API-key scopes, workstation eligibility (`can_visualise`), run
  lifecycle/status.
- Agent dispatch + UE launch (`-game` PS2, connector auto-detect, `-Orbit*` tokens).
- Pixel Streaming transport: per-run signalling (streamer/player/SFU ports), the
  WebRTC **data channel**, coturn TURN, the browser player + signalling proxy.
- ORBIT token handoff to the plugin.

### PRISM may need to add (pending decisions)
- **Remote Control** — only if the portal needs to drive import/scene/quality over
  the UE Remote Control API rather than (a) PRISM's `-Orbit*` launch tokens for
  import and (b) the data channel for runtime control. PRISM does **not** enable
  the Remote Control plugin/port today. **Decision needed (see §6 Q1).**

### UE plugin team adds (the streamed project's plugins)
- **Model import** — the `OrbitConnector.UE5` plugin: `UOrbitImportSubsystem` +
  `FOrbitHeadlessAutoImport` that reads PRISM's `-Orbit*` tokens, bundled
  `orbit-cli`, glTFRuntime load. (Already the path PRISM drives.)
- **Control intake** — a `PixelStreamingInput` component on the PlayerController
  bound to `OnInputEvent`, parsing the portal's JSON descriptors and routing to the
  fixture-control subsystem, incl. the new `SelectFixtures` highlight.
- **Fixture behaviour & parity** — pan/tilt motion-rig math matching the Orbit
  viewer (Y-up convention, `pivotOffset`, tilt-under-pan compensation, multi-axis
  composition, `matrixSource`), IES photometrics, source size.
- **Packaging** — the single streamed project must bundle **both** plugins
  (`OrbitConnector` for import + `RebusVisualiser` for control) **plus** PS2 enabled
  and the `PixelStreamingInput` component, with `orbit-cli` staged at
  `Plugins/OrbitConnector/ThirdParty/Cli/win-x64/orbit-cli.exe` so PRISM auto-detects
  the connector path.

### Portal provides (per its spec)
- Emits control + selection as JSON descriptors over the data channel
  (`emitUIInteraction`); re-sends selection on `Ready`.
- Serves `/api/ue/scene`, `/api/ue/fixtures/{id}` (motion rig, photometrics, IES,
  source), `/meshes`. MVR is upload-time only — never sent to UE at runtime.

---

## 6. Open questions for the portal / UE-project dev

1. **Remote Control: needed or not?** Does anything (import trigger, scene/quality
   settings) go over UE **Remote Control**, or is the model:
   *(a) import via PRISM's `-Orbit*` launch tokens, and (b) all runtime control via
   the data channel*? This decides whether PRISM must enable the Remote Control
   plugin/port in the launched project.
2. **One plugin or two?** — **RESOLVED (UE dev, 2026-06-02).** The two plugins do
   different jobs and **coexist**: `OrbitConnector` = model import at launch (PRISM
   passes `-Orbit*` tokens; its `orbit-cli` + glTFRuntime pull the model into the
   live world; PRISM auto-detects the production project by the presence of
   `Plugins/OrbitConnector/`), and `RebusVisualiser` = runtime control intake (the
   `PixelStreamingInput.OnInputEvent` handler). `RebusVisualiser` **layers on top of**
   `OrbitConnector` — it does not replace it. The production project ships **both**
   (or merges into one plugin that still exposes the `OrbitConnector` import layout +
   `orbit-cli` where PRISM's locator expects it). Removing `OrbitConnector` would
   break the whole launch/import path. No PRISM change required.
3. **Which project is production?** The dev is building a new UE project; we expect
   to combine it with the current connector project. Confirm the canonical
   production project, and that it bundles: `Plugins/OrbitConnector/` (uplugin +
   `orbit-cli`), the fixture-control plugin, PS2 enabled, and the `PixelStreamingInput`
   component on the PlayerController.

---

## 7. Combining the projects (current direction)

PRISM currently runs its own UE project carrying the ORBIT connector + Pixel
Streaming. The dev is building a new project with the fixture-control plugin. The
plan is to **merge into one production project** that bundles both capabilities.
Because PRISM's only requirement is "a project that ships `Plugins/OrbitConnector/`
(uplugin + `orbit-cli`) with PS2 enabled, launched `-game` with the `-Orbit*`
tokens," the merged project works with **no PRISM change** as long as that layout is
preserved. PRISM auto-detects the connector and drives it identically; the dev's
fixture-control plugin + `PixelStreamingInput` handler layer on top to consume the
portal's data-channel control.
