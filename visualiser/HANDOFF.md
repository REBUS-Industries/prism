# PRISM Visualiser — Engineering Handoff

> Audience: the next AI coding agent (and human dev) continuing development of the
> **PRISM Visualiser** — an Unreal Engine 5.7 Pixel Streaming subsystem that streams
> an interactive 3D view of an ORBIT model (or a fixed UE template project) to a
> browser. This document is self-contained: it assumes **no** prior context from the
> session that produced it.
>
> Everything below was verified against the live source tree on 2026-06-02. Where a
> fact could not be confirmed from code/docs it is called out explicitly in
> [§11 Unverified / double-check](#11-unverified--to-double-check).

---

## 1. TL;DR / current status

The Visualiser is **operational end-to-end on the render workstation PC01** (RTX 6000
Ada). A browser viewer can watch — and (as controller) drive — a live UE 5.7 Pixel
Streaming session of an ORBIT model, on- or off-LAN (TURN verified working).

**Current versions (verified):**

| Component | Version | Source of truth |
|---|---|---|
| PRISM Agent (.NET 8 WinForms tray app) | **v0.3.16** | `agent/src/PRISM.Agent/PRISM.Agent.csproj` `<Version>` |
| Visualiser Orchestrator (`prism-visualiser.exe`) | **v0.5.14** | `visualiser/Directory.Build.props` `<VisualiserVersion>` |
| PRISM Server image | rolling deploy off `main` (untagged); image `ghcr.io/rebus-orbit/prism-server` | `infra/docker-compose.yml`, `.github/workflows/server.yml` |
| DB migration level | **0006** (`0006_visualiser_share_links.sql`) | `server/src/db/migrations/` |
| ORBIT UE5/Rhino connector (separate repo) | **v0.1.27** | `.cursor/rules/connectors.mdc` (note: `docs/SESSION_HANDOFF.md` documents through v0.1.26) |

**What works now (this session's accomplishments):**

- Full bring-up on PC01. The cascade of failures that blocked it earlier is fixed
  across agent v0.3.9→v0.3.16 / orchestrator v0.5.6→v0.5.14:
  - PixelStreaming2 / Wilbur signalling auto-bootstrap on first run (`SignallingBootstrap`).
  - UE 5.7 / Wilbur "streamer registered" log-shape recognition (`OnJoined`, etc.).
  - Black-screen fix (lighting + camera framing in the import script).
  - Imported-geometry discovery + headless-safe spawn + persist-to-disk.
  - `signalling_not_found`, `ue_game_start_timeout`, `ue_import_failed` (-1/3) all fixed.
  - Distinct Wilbur **SFU** port per run (kills the `EADDRINUSE :::8889` death).
  - Deterministic `.uproject` selection (stale `MyProject.uproject` no longer shadows).
- **Full-editor GUI streaming mode** (open the real Unreal Editor on PC01 *and* stream
  the level-editor viewport to the browser).
- Project staging evolved: ORBIT-import (Interchange) → `REBUS_TEMPLATE` (a C++ project)
  → **`MINIMAL_CUBE`** isolation project (the current **code default**).
- **Multi-viewer** shipped & live: shareable links, `view`/`control` tiers, single-controller
  lock, per-viewer demux (~5 viewers/run).
- Start timeouts raised to **600 s** (server + orchestrator full-editor budget).
- **TURN/coturn verified end-to-end** for off-LAN viewers.

**Where it runs:** PRISM server = VM 212 (`prism.rebus.industries:8765`). Render
workstation = **RB-DA2-PC01** (agent + orchestrator + UE 5.7). coturn = VM 212
(`visualiser.rebus.industries` → `185.48.165.165`).

---

## 2. Architecture & data flow

Three processes plus coturn. The server never parses the Pixel Streaming sub-protocol;
it is a transparent relay between the browser and the agent's local Wilbur.

```mermaid
sequenceDiagram
    participant P as Portal / Admin SPA / Share-link viewer (browser)
    participant S as PRISM server (VM 212, Fastify/TS)
    participant A as PRISM Agent (PC01, .NET tray)
    participant O as Orchestrator (prism-visualiser.exe)
    participant U as UE 5.7 + Wilbur (PC01)
    participant T as coturn (VM 212)

    P->>S: POST /api/visualiser/streams {projectId,modelId,versionId?}<br/>(API key, scope visualiser:create_stream)
    S->>S: insert visualiser_runs row (status=queued)<br/>register ready waiter (timeout 600s)
    S->>A: WS startVisualisation {runId, orbit token, server, ids}
    A->>O: spawn prism-visualiser.exe stream --server … --run-id … --json<br/>(ORBIT_PAT_* + PRISM_VISUALISER_* env)
    O->>O: bootstrap Wilbur (first run); allocate player/streamer/SFU ports
    O->>U: launch UE (-game / -windowed / full UnrealEditor.exe)<br/>+ import (Interchange OR OrbitConnector OR full-editor project)
    U-->>O: stdout: streamer registered (RoomSignallingContextObserver::OnJoined)
    O-->>A: stdout JSON: prism-visualiser/ready/v1 {signallingUrl=ws://127.0.0.1:<player>}
    A-->>S: WS visualisationReady {runId, streamerId}
    S-->>P: 200 ready/v1 {signallingUrl=wss://…/ws/visualiser/<runId>/signalling, playerUrl, turn}
    P->>S: POST …/signalling-token  →  HS256 JWT (runId, tier, viewerId)
    P->>S: WS /ws/visualiser/<runId>/signalling?token=JWT
    S->>A: WS signallingFrame {runId, viewerId, payload/payloadB64}
    A->>U: per-viewer local Wilbur player WS (SignallingBridge) → WebRTC offer/answer/ICE
    U-->>P: WebRTC media + data channel (direct, or relayed via coturn T using minted TURN creds)
```

**Key properties:**

- **Synchronous create.** `POST /streams` blocks until the agent reports `ready`/`failed`
  or the 600 s timeout fires (`server/src/api/visualiser.ts`, `visualiser/runRegistry.ts`).
- **Signalling is double-relayed:** browser ⇄ server WS proxy ⇄ agent WS ⇄ local Wilbur ⇄ UE.
  WebRTC **media + the input data channel go peer-to-peer** (browser↔UE), using STUN/TURN —
  they do **not** traverse PRISM. The control-gate (view vs control) is therefore enforced
  server-side by suppressing the client + (defence-in-depth) dropping input frames on the
  bridge; a hard guarantee needs the UE template's `PixelStreaming2.InputController=Host`.
- **One local Wilbur player WS per browser viewer** (1:1), keyed `(runId, viewerId)`, so a
  2nd viewer's SDP/ICE never collides with the 1st (the old single-WS demux froze viewers).

---

## 3. Repo map

All paths relative to `PRISM/` unless noted.

### Orchestrator — `visualiser/src/PRISM.Visualiser.Orchestrator/`
| File / folder | Role |
|---|---|
| `Program.cs` | `System.CommandLine` entrypoint (`stream`, `cache`); phase driver `RunPhaseFAsync`; `--connector-import` tri-state; `TryPrepareConnectorImportAsync`; emits `connector-import/v1`. |
| `Pipeline/VisualiserPipeline.cs` | Orchestrates receive→stage→import→stream. `ReceiveAndStageAsync`, `ImportAsync` (Interchange + Phase-J MVR), `StartStreamingAsync` (Wilbur + UE + streamer-connected wait), `PrepareTemplateProjectAsync`, `StartFullEditor`. Allocates distinct player/streamer/**SFU** ports. |
| `Pipeline/TemplateProjectProvider.cs` | Resolves the **fixed** template project from `PRISM_VISUALISER_TEMPLATE_PROJECT` (= agent `VisualiserTemplateProjectPath`). **Local source → opens IN PLACE** (the agent pull installs+compiles into `C:\PRISM\Templates\<name>`, so no second copy); **UNC/remote source → mirrors** to `%LOCALAPPDATA%\PRISM.Visualiser\templates\<name>` via robocopy `/E /XO` (fallback). **`SelectUproject`** deterministically picks `<TemplateName>.uproject`. Mirror **MUST keep `Binaries/`+`Build/`** for C++ projects. Used by BOTH the full-editor and connector-import paths. |
| `PixelStreaming/SignallingSupervisor.cs` | Locates Wilbur (`dist\index.js`) / legacy Cirrus + node.exe; spawns it; parses the ready line + the **5 named streamer-connected patterns** (`OnJoined`, `PlayerJoined`, `EndpointIdConfirm`, `EndpointId`, `LegacyCirrus`); emits `--sfu_port`; 750 ms post-ready crash check. |
| `PixelStreaming/SignallingBootstrap.cs` | First-run `get_ps_servers.bat` + `start.bat` to fetch/build Wilbur; marker under `state/signalling_ready_<sha>.flag`. |
| `PixelStreaming/PixelStreamingSession.cs` / `PortAllocator.cs` | Session lifetime (UE-first shutdown) + free-port allocation. |
| `Unreal/UnrealLauncher.cs` | Spawns `UnrealEditor-Cmd.exe` (import `-run=PythonScript -script=`; stream `-game`) and `UnrealEditor.exe` (full editor / full-editor-streaming). Writes PS2 editor cvars into **`Config/DefaultGame.ini`** (`WriteEditorStreamingConfig`). Appends `-Orbit*` tokens for connector import. |
| `Unreal/UnrealEnvironment.cs` | UE-root resolution (env → default `C:\Program Files\Epic Games\UE_5.7\` → registry) + path normalization. |
| `Unreal/TemplateFetcher.cs` / `ProjectScaffolder.cs` | Interchange path: fetch `orbit-ue-template` release zip + per-run scaffold. |
| `Unreal/OrbitConnectorLocator.cs` / `OrbitImportParams.cs` | Connector-import path: detect `Plugins/OrbitConnector/` + `orbit-cli.exe`; carry `-Orbit*` params. |
| `Unreal/MvrGdtfDetector.cs` / `PythonScripts/import_{orbit,mvr}.py(.in)` | Interchange import + Phase-J MVR/GDTF (DMX) second pass. |
| `OrbitApi/`, `Staging/`, `Converters/`, `Auth/` | Phase-C receive (ORBIT→glTF), content-addressed cache, token sources. |
| `Models/{Ready,Failed,Staged,Imported}Event.cs` | Stdout JSON event shapes (`prism-visualiser/*/v1`). |
| `tests/PRISM.Visualiser.Orchestrator.Tests/` | xUnit; SignallingSupervisor/Bootstrap, PortAllocator, ConnectorImport, scaffolder, etc. (~136 tests). |

### Agent — `agent/src/PRISM.Agent/`
| File | Role |
|---|---|
| `Pipeline/VisualiserJob.cs` | Owns one orchestrator child process. Resolves the EXE, builds CLI args, sets `ORBIT_PAT_*` + `PRISM_VISUALISER_*` env, pumps stdout JSON → `visualisationReady/Failed/Ended` upstream, kills the process tree on cancel. |
| `Visualiser/SignallingBridge.cs` | **Per-viewer** bridge: one `ClientWebSocket` to the local Wilbur player port. Forwards frames both ways; gates input frames when `!AllowInput`. |
| `Visualiser/SignallingBridgeRegistry.cs` | Singleton; bridges keyed `runId\|viewerId`; `RegisterLocalCirrus`, `GetOrCreateAsync`, `SetViewerControl`, `DropViewerAsync`, `DropAsync`. |
| `Visualiser/VisualiserRunRegistry.cs` | Per-agent concurrency cap + active-run tracking. |
| `Ws/AgentMessageDispatcher.cs` | Routes `startVisualisation`, `cancelVisualisation`, `signallingFrame`, `signallingViewerClose`, `setViewerControl`. |
| `Config/AgentConfig.cs` | Persisted config incl. `UnrealEngineRoot`, `VisualiserTemplateProjectPath` (**default `C:\PRISM\Templates\MINIMAL_CUBE`**), `VisualiserDebugWindow`, `VisualiserFullEditor`, `VisualiserConnectorImport` (`bool?`, default null/auto), `VisualiserOrchestratorPath`. |
| `Tray/SettingsForm.cs`, `WebUi/AgentWebUi.cs`, `WebUi/IndexHtml.cs` | Tray + local web UI (`:7421`) toggles: debug-window, full-editor, template-project path. |
| `install/*.ps1`, `install/PRISM.Agent.iss` | Installer + visualiser-session helpers (auto-logon, keep-alive, AV exclusions). |

### Server — `server/src/`
| File | Role |
|---|---|
| `api/visualiser.ts` | All `/api/visualiser/*` REST routes (see §4). |
| `ws/signallingProxy.ts` | `/ws/visualiser/:runId/signalling?token=` — browser↔agent frame relay; per-viewer registration; auto-grants control to first control-tier viewer. |
| `ws/visualiserControl.ts` | `/ws/visualiser/:runId/control?token=` — `take`/`release`, controller-state push. |
| `ws/signallingProxyRegistry.ts` | In-proc per-run state: viewers map, controller lock, control subscribers, `forwardAgentToBrowser` (1:1 routing). |
| `ws/agentProtocol.ts` | Inbound `visualisationReady/Failed/Ended`, `signallingFrame`; outbound `signallingFrame` / `signallingViewerClose` / `setViewerControl`. |
| `ws/gateway.ts` | Registers the signalling + control WS plugins. |
| `visualiser/turnCredentials.ts` | Mints RFC-7635 long-term TURN creds (HMAC-SHA1). |
| `visualiser/signallingToken.ts` | HS256 5-min signalling JWT (claims `runId`, `tier`, `viewerId`). |
| `visualiser/shareLinks.ts` | Mint/hash opaque share tokens (SHA-256 stored). |
| `visualiser/runRegistry.ts` | Promise waiter that the `POST /streams` handler blocks on. |
| `jobs/dispatcher.ts` | `tryDispatchVisualisation` — reserves a `can_visualise` workstation, sends `startVisualisation`. |
| `db/schema.ts`, `db/migrations/0003,0004,0006…` | `visualiser_runs`, `visualiser_share_links`. |

### Infra & docs
- `infra/docker-compose.yml`, `infra/.env.example` — server env (TURN/JWT/timeout).
- `infra/coturn/{docker-compose.yml,turnserver.conf,UNIFI_RULES.md,SETUP_NOTES.md}`.
- `visualiser/{README.md,CHANGELOG.md}`, `visualiser/PRISM-INTEGRATION.md`.
- `docs/VISUALISER_CONNECTOR_IMPORT.md`, `docs/VISUALISER_WORKSTATION_SESSION.md`, `docs/VISUALISER_MERGE_ORDER.md`.

---

## 4. Multi-viewer model

A run serves **~5 concurrent browser viewers** without an SFU. Each viewer is an
independent Pixel Streaming player.

**Tiers & lock.** Each signalling JWT carries a `tier` (`view` | `control`) and a stable
`viewerId`. Exactly one viewer per run may hold **control** at a time (the single-controller
lock lives in-memory in `signallingProxyRegistry.ts` — no DB). `view`-tier viewers can never
take control. The first control-tier viewer to connect is auto-granted the lock
(`autoGrantIfVacant`). `take`/`release` happen on the dedicated control channel.

**Per-viewer demux.** Server routes inbound agent frames to the single matching viewer by
`viewerId` (not broadcast). The agent's `SignallingBridgeRegistry` opens **one local Wilbur
player WS per `(runId, viewerId)`**, so per-player SDP/ICE never collides.

**Input gate.** When a viewer is not the controller the server pushes `setViewerControl
{canControl:false}`; the agent's `SignallingBridge.AllowInput=false` drops PS input/command
frames (`mousemove`, `keydown`, `emitUIInteraction`, `command`, gamepad, touch…). WebRTC
negotiation (offer/answer/iceCandidate), streamer discovery and keepalives always pass.

**Share links.** `visualiser_share_links` table (`run_id` FK **cascade**, `token_hash` unique,
`tier` default `view`, `created_by`, `expires_at`, `revoked_at`; migration `0006`). Plaintext
token is shown **once** in the URL; only its SHA-256 hash is stored. Share viewers (no portal
account) `POST …/shares/exchange` the token and get a tier-scoped signalling JWT. Links
auto-die with the run (exchange refuses any run not `streaming`).

**Endpoints (`server/src/api/visualiser.ts`):**

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/visualiser/streams` | API key + scope `visualiser:create_stream` (admin/ORBIT bypass scope) | Create + block until ready (600 s). Returns `ready/v1` + `turn`. |
| `GET /api/visualiser/streams` | auth | List runs (newest first). |
| `GET /api/visualiser/streams/:runId` | auth | Single run; mints fresh `turn` when `streaming`. |
| `DELETE /api/visualiser/streams/:runId` | owner API key OR admin | `cancelVisualisation` + mark `ended`. |
| `POST …/:runId/signalling-token` | owner/admin | Mint control-tier signalling JWT. |
| `POST …/:runId/shares` | owner/admin OR key w/ `visualiser:join_stream` | Mint share link (`tier`, optional TTL ≤ 24 h). |
| `POST …/:runId/shares/exchange` | **public** | Redeem share token → tier-scoped JWT + `signallingUrl` + `turn`. |
| `GET …/:runId/shares` / `DELETE …/:runId/shares/:id` | owner/admin | List / revoke share links. |
| `GET /api/visualiser/workstations` | admin | `can_visualise` pool for the SPA dropdown. |
| WS `/ws/visualiser/:runId/signalling?token=` | signalling JWT | Browser↔agent frame relay. |
| WS `/ws/visualiser/:runId/control?token=` | signalling JWT | `take`/`release` + controller state. |

Scopes are defined in `server/src/api/keys.ts` (`visualiser:create_stream`, `visualiser:join_stream`).

---

## 5. TURN / coturn

- **Image/host:** `coturn/coturn:4.6` on VM 212, `network_mode=host` (`infra/coturn/docker-compose.yml`).
- **DNS:** `visualiser.rebus.industries` → `185.48.165.165` → NAT'd to `10.0.200.212` by the UniFi gateway.
- **Listeners:** UDP+TCP `:3478` (STUN/TURN), TLS `:5349` (`turns:`). Relay range **`52000–56999`**
  (narrowed to dodge WireGuard `51820`). `external-ip=185.48.165.165/10.0.200.212`.
- **Auth scheme:** `use-auth-secret` (RFC 7635 §3 long-term). Server mints
  `username = <unix-exp>:<runid-segment>`, `credential = base64(HMAC-SHA1(static-auth-secret, username))`,
  `ttl 86400`. **`static-auth-secret` MUST byte-equal the server's `TURN_SECRET`** env var.
- **Hardening:** broad `denied-peer-ip` (all RFC-1918/loopback/etc.) with explicit
  `allowed-peer-ip` carve-outs for the workstation VLANs (`10.0.10.200–250`, `10.0.200.200–250`).
  `total-quota=200`, `user-quota=50`. TLS cert synced from Caddy via a daily cron.
- **Server bundle** (`visualiser/turnCredentials.ts`): default
  `["turn:visualiser.rebus.industries:3478","turns:…:5349"]`, overridable via `TURN_URLS_OVERRIDE`.
  When `TURN_SECRET` is unset it returns the `turn: null` sentinel → browser falls back to STUN/LAN-only.

**Verified:** coturn healthy, secret matches, credential format correct, `:3478` internet-reachable,
TURN confirmed working end-to-end this session.
**Not yet confirmed:** UniFi WAN DNAT for the **relay UDP range `52000–56999`** and **`5349/TLS`**
(only `:3478` confirmed). Prove with an actual off-LAN viewer test. See `infra/coturn/UNIFI_RULES.md`.

---

## 6. Build / run / deploy

### Build the orchestrator
```powershell
dotnet build  visualiser/PRISM.Visualiser.sln -c Release -warnaserror
dotnet test   visualiser/PRISM.Visualiser.sln -c Release --logger "console;verbosity=minimal"
# Publish the sidecar EXE (assembly name is prism-visualiser.exe):
dotnet publish visualiser/src/PRISM.Visualiser.Orchestrator/PRISM.Visualiser.Orchestrator.csproj `
    -c Release -r win-x64 -o publish/visualiser/
```
Bump version in `visualiser/Directory.Build.props` (`<VisualiserVersion>`); CI tag is
`visualiser-v<version>` (`.github/workflows/visualiser-msi.yml`, trigger `tags: ['visualiser-v*']`).

### Build the agent
```powershell
dotnet build agent/PRISM.Agent.sln -c Release
```
Version lives in `agent/src/PRISM.Agent/PRISM.Agent.csproj` (`<Version>`). The orchestrator is
**bundled into the agent zip** under `Visualiser/` (the agent probes `…\Visualiser\prism-visualiser.exe`,
then legacy names / Program Files — see `VisualiserJob.CandidateOrchestratorPaths`).

### Hot-patch loop on PC01 (fast iteration without a full release)
- Replace `…\PRISM.Agent\Visualiser\prism-visualiser.exe` (orchestrator-only change), **or**
- Point `VisualiserOrchestratorPath` / `PRISM_VISUALISER_ORCHESTRATOR_PATH` at a dev build.
- Toggles that apply on the **next run with no restart**: `VisualiserDebugWindow`,
  `VisualiserFullEditor`, `VisualiserTemplateProjectPath`, `VisualiserConnectorImport` (tray / web UI / config).
- Env overrides honoured by the orchestrator: `PRISM_VISUALISER_DEBUG_WINDOW`,
  `PRISM_VISUALISER_FULL_EDITOR`, `PRISM_VISUALISER_TEMPLATE_PROJECT`,
  `PRISM_VISUALISER_CONNECTOR_IMPORT`, `PRISM_VISUALISER_CIRRUS_SCRIPT`/`_NODE_EXE`/`_CIRRUS_URL`,
  `UNREAL_ENGINE_ROOT`.

### Cut a release
- **Agent MSI/zip:** push tag `vX.Y.Z` (the `agent.yml` filter excludes `visualiser-*`). CI builds
  a win-x64 publish zip + GH Release; the matching `## vX.Y.Z` CHANGELOG section is auto-extracted
  as the release body.
- **Orchestrator:** bundled into the agent zip; also tagged independently as `visualiser-vX.Y.Z`
  via `visualiser-msi.yml`.
- **Server image:** rolling deploy off `main` via `server.yml` → `ghcr.io/rebus-orbit/prism-server`,
  deployed to `/opt/prism` on VM 212 by the self-hosted deploy runner (`runs-on: [self-hosted, prism-deploy]`).
  (Runner identity per `server.yml` comment = LXC 261 at `10.0.200.61`; see §11 re: the SRV03 naming
  discrepancy.)

### Install on PC01
`agent/install/install.ps1` is elevated and takes `-PrismUrl` (mandatory) plus `-NodeName`,
`-Slots`, `-InstallDir`, `-DataDir`, `-WebUiPort`, `-WebUiLocalhostOnly`, `-LaunchNow`, `-ForceConfig`.
Visualiser-session helpers ship alongside: `Set-VisualiserAutoLogon.ps1`,
`Install-VisualiserSessionKeepAlive.ps1`, `Set-VisualiserAvExclusions.ps1`. (See §11 — the
`-ReleaseTag` flag referenced elsewhere is **not** a parameter of this script.)

---

## 7. Gotchas & hard-won lessons

1. **UE 5.7 / Wilbur changed the signalling log shapes.** The legacy `Streamer connected:`
   line is gone. The orchestrator now matches 5 named patterns (`SignallingSupervisor.StreamerConnectedPatterns`);
   the canonical one is UE-side `LogPixelStreaming2EpicRtc … RoomSignallingContextObserver::OnJoined …
   state=[Joined]`. It merges **both** Wilbur stdout **and** UE stdout (the `OnJoined` line is only on UE's
   stdout) before matching. Order matters — `OnJoined` must stay first.

2. **A C++ template project needs `Binaries/` + `Build/` staged.** `REBUS_TEMPLATE` is a C++ project;
   `TemplateProjectProvider` excludes only `Saved/Intermediate/DerivedDataCache/.vs/.git`. If you exclude
   `Binaries/`, UE fails with "Incompatible or missing module" and exits code 1 (it can't compile
   non-interactively). `MINIMAL_CUBE` (Blueprint-only) sidesteps this and is the current code default.

3. **PS2 editor cvars go in `Config/DefaultGame.ini`, NOT `DefaultEngine.ini`.** The settings class
   `UPixelStreaming2PluginSettings` is `UCLASS(config = Game)`. The managed block written by
   `WriteEditorStreamingConfig` is: `EditorSource=LevelEditorViewport`, `EditorStartOnLaunch=True`,
   `EditorUseRemoteSignallingServer=True`, `ConnectionURL=ws://127.0.0.1:<streamerPort>`. Auto-start fires
   from `OnMainFrameCreationFinished` (after the viewport is up) — early `-ExecCmds` no-op.

4. **Wilbur dies on `EADDRINUSE` for the SFU port.** Wilbur always binds an SFU WS; unset, it falls back
   to `config.json`'s `8889`, which collides across back-to-back runs. It logs its ready line (so the
   matcher fires and UE launches) then throws an **unhandled** `Error: listen EADDRINUSE :::8889` and the
   whole node process dies — UE then loops on `socket connect failed`. Fix: allocate a distinct free
   `--sfu_port` per run + a 750 ms post-ready crash check that fails fast.

5. **Stale `MyProject.uproject` shadowing.** The local template cache is a persistent robocopy `/E /XO`
   mirror (no `/PURGE`), so a leftover `MyProject.uproject` lingers. The old
   `EnumerateFiles("*.uproject").FirstOrDefault()` took the alphabetically-first one (no PixelStreaming2)
   → `ue_game_start_timeout`. `SelectUproject` now prefers the descriptor matching the template dir name,
   else the most-recently-modified, and loudly warns about extras.

6. **The Visualiser dies if the operator LOGS OFF PC01.** Logging off tears down the interactive session
   and the GPU. A **disconnected** RDP session keeps the RTX 6000 Ada alive. **Golden rule: RDP/Parsec →
   Disconnect, NEVER Log off.** Auto-logon helpers shipped (`agent/install/Set-VisualiserAutoLogon.ps1`,
   `Install-VisualiserSessionKeepAlive.ps1`); see `docs/VISUALISER_WORKSTATION_SESSION.md`.

7. **Cold full-editor first-open needs the 600 s budget.** A fresh-cache C++ project compiles shaders +
   builds the DDC before the level-editor viewport (and thus the streamer) appears. Orchestrator full-editor
   streamer-connect budget = 600 s; this must stay ≤ server `VISUALISER_START_TIMEOUT_MS` (now 600 000).

8. **`UnrealEditor-Cmd.exe` for `-game`, `UnrealEditor.exe` for full editor.** Both share the engine monolith,
   but `-Cmd` links the Console subsystem so stdout/stderr are inherited cleanly (the GUI binary's
   stdout listener is unreliable from a non-console parent). `-game` does NOT pass `-NullRHI` (it needs the
   RHI + NVENC); import (`-run=PythonScript`) does use `-NullRHI`.

9. **Headless `-NullRHI` import is Slate-fragile.** `AssetImportTask` and `spawn_actor_from_object` route
   through Slate/EditorFramework and crash under the commandlet — use Interchange + the class-spawn path,
   and flush imported assets to disk before saving the level. (See orchestrator CHANGELOG v0.5.8–v0.5.11.)

10. **UE-log prefix on Python markers.** UE re-emits Python `print` as `[ts][ch]LogPython: …`, so marker
    parsing must scan anywhere in the line (`TryFindMarker`), not column-0 (`StartsWith`).

11. **Input does not traverse PRISM.** PS input rides the peer-to-peer WebRTC data channel. View-only is
    enforced by client suppression + the bridge's signalling-frame gate; for a hard guarantee against a
    modified client, the UE template must set `PixelStreaming2.InputController=Host`.

---

## 8. Outstanding work & suggested next features

### Open items (from this session)
- **Prove off-LAN viewer end-to-end.** Confirm the UniFi WAN DNAT covers the coturn relay UDP range
  `52000–56999` **and** `5349/TLS` (only `:3478` confirmed). Test from a real off-LAN browser; hook in at
  `infra/coturn/UNIFI_RULES.md` + a `turns:` ICE-only test.
- **Operator-verify multi-viewer live:** 2nd tab no-freeze, a `view`-only share link cannot drive, and
  take/release control works. Exercises `signallingProxyRegistry` + per-viewer `SignallingBridge`.
- **Finish PC01 auto-logon + reboot** to make the workstation survive unattended restarts
  (`Set-VisualiserAutoLogon.ps1`).
- **Finish the `OrbitConnector.UE5` import path on the workstation.** The orchestrator support is shipped
  (orchestrator v0.5.13, `--connector-import` tri-state, `connector-import/v1` event, `OrbitConnectorLocator`);
  it needs the **built** connector + `orbit-cli.exe` staged into the fixed project
  (`Plugins/OrbitConnector/…`, see `docs/VISUALISER_CONNECTOR_IMPORT.md`). Connector C++ is compile-pending
  on a UE-capable box. Connector repo is at v0.1.27 and in active development.

### Suggested next features (grounded in current design)
- **Promote a canonical production project + `v1.0.0-ue5.7` template tag.** Merge `OrbitConnector` (import)
  + `RebusVisualiser` (control) into one project that preserves the `Plugins/OrbitConnector/` layout PRISM
  auto-detects (`PRISM-INTEGRATION.md` §7). No PRISM change required if the layout holds.
- **Orchestrator robustness:** pass `-EnablePlugins=PixelStreaming2` in code so a project missing the
  plugin still streams (`UnrealLauncher` arg build) — currently relies on the `.uproject` declaring it.
- **Quality/bitrate controls.** Thread PS2 encoder cvars (resolution, target bitrate, fps) from a
  `POST /streams` body field → `startVisualisation` → orchestrator `-game` args (`UnrealLauncher`
  resolution is already parameterised via `DefaultGameResX/Y`).
- **Session persistence / reconnect.** Today `agent_sessions` rows are deleted on socket close and the run
  is ephemeral; a viewer reconnect re-mints a viewerId. Persist controller state and allow a graceful
  viewer reconnect window in `signallingProxyRegistry`.
- **Standalone player page.** `buildPlayerUrl` currently deep-links the admin SPA hash route; the share
  flow already serves `/viewer/#/<runId>?st=…`. Finish a first-class `/visualiser/<runId>/player` page.
- **Multi-session per workstation.** `VisualiserMaxConcurrent`/`Slots` default to 1 (GPU-bound). Benchmark
  NVENC + VRAM headroom before raising; `ResolveSignallingPortHint` already spreads per-slot ports.

---

## 9. How to test / smoke-test a run

### Local orchestrator dry-run (no ORBIT/UE/Wilbur)
```powershell
prism-visualiser.exe stream --server prod --project P --model M --version V --run-id test --dry-run --json
```
Healthy: a single `prism-visualiser/ready/v1` JSON line on stdout, exit 0.

### Full smoke test against PC01
1. Ensure PC01: agent online (`can_visualise`), UE 5.7 installed, a logged-in **interactive** session
   (RDP → Disconnect), template project present (`C:\PRISM\Templates\MINIMAL_CUBE` or `…\REBUS_Visualiser`).
2. `POST /api/visualiser/streams` with a valid `projectId`/`modelId` (key with `visualiser:create_stream`).
3. Open the returned `playerUrl` (admin SPA) or mint a share link and open `/viewer/#/<runId>?st=…`.

### What "healthy" looks like in the logs

**Orchestrator stdout (agent forwards as `[orchestrator stdout]`):**
- `signalling launch flavour=wilbur … playerPort=… streamerPort=… sfuPort=…`
- `phase-f: allocated playerPort=… streamerPort=… sfuPort=… webrtcPorts=[…]`
- `phase-f: streamer registered (matched OnJoined) elapsed=<X.X>s`
- `phase-f: streamer connected pid=… streamerId=orbit_… matchedPattern=OnJoined`
- final JSON: `{"schema":"prism-visualiser/ready/v1","status":"ready","signallingUrl":"ws://127.0.0.1:<player>","streamerId":"orbit_…"}`

**Agent:** `visualiser job: orchestrator reports ready …` → `signalling bridge: connected to local Cirrus
ws://127.0.0.1:<player> for runId=… viewerId=…`.

**Server:** `POST /streams` returns 200 `ready/v1` with `signallingUrl=wss://…/ws/visualiser/<runId>/signalling`,
`playerUrl`, and a non-null `turn` bundle; the run row flips to `status=streaming`.

**Browser:** signalling WS connects (`browser signalling ws connected`), WebRTC offer/answer/ICE complete,
video + (controller) data channel go Active, the streamed viewport shows the **lit, framed** model (not black).

**Failure codes to recognise** (orchestrator `failed/v1` `code` → agent → run `failureReason`):
`ue_root_not_found`, `signalling_not_found`, `signalling_bootstrap_failed`, `node_not_found`,
`signalling_start_timeout`, `ue_game_start_timeout`, `ue_game_crashed`, `ue_import_failed`,
`gpu_preflight_failed`; server-side `start_timeout` (504), `dispatch_failed` (`no_workstation_available`,
`all_workstations_busy`, `version_unavailable`, `misconfigured`).

---

## 10. References

- `visualiser/README.md` — orchestrator CLI, exit codes, phases.
- `visualiser/CHANGELOG.md` — orchestrator history v0.1.0 → **v0.5.14** (every bug fix narrated).
- `visualiser/PRISM-INTEGRATION.md` — PRISM ↔ UE contract, ownership split, connector-import.
- `docs/VISUALISER_CONNECTOR_IMPORT.md` — the `OrbitConnector.UE5` import path (enable/flow/prereqs).
- `docs/VISUALISER_WORKSTATION_SESSION.md` — RDP "disconnect not log off", auto-logon, GPU session.
- `docs/VISUALISER_MERGE_ORDER.md`, `docs/RELEASE_STRATEGY.md`, `docs/ANTIVIRUS_EXCLUSIONS.md`,
  `docs/SCHEDULED_TASK_RESILIENCE.md`, `docs/PORTAL_INTEGRATION.md`.
- `PRISM/CHANGELOG.md` — agent + server history (latest tagged agent **v0.3.16**; multi-viewer + TURN-verified
  notes; `## Unreleased` connector-import).
- `docs/SESSION_HANDOFF.md` + `docs/UE5_VISUALISER_ARCHITECTURE.md` — the ORBIT UE5 connector handoff
  (connector through v0.1.26 there; rule says repo is at v0.1.27).
- `infra/coturn/{turnserver.conf,UNIFI_RULES.md,SETUP_NOTES.md}`, `infra/docker-compose.yml`, `infra/.env.example`.
- `.cursor/plans/orbit_ue5_connector_*.plan.md`, `prism-orbit-native-build_*.plan.md`,
  `prism_visualiser_role_*.plan.md`, `prism_agent_and_admin_polish_*.plan.md`.
- Deep session history (large; grep, don't read linearly):
  `C:\Users\dom\.cursor\projects\empty-window\agent-transcripts\48e2ad58-75a4-41ba-90d5-6d09b572c4b0\48e2ad58-75a4-41ba-90d5-6d09b572c4b0.jsonl`.

---

## 11. Unverified / to double-check

These could not be confirmed from the code/docs and should be checked before relying on them:

1. **`install.ps1 -ReleaseTag vX.Y.Z`** — the install script has **no** `-ReleaseTag` parameter
   (its mandatory param is `-PrismUrl`). The tag-based install flow described in the brief may live in a
   separate fetch step, the Inno installer, or the README — confirm the actual install-by-tag procedure.
2. **Deploy runner identity.** `server.yml` uses `runs-on: [self-hosted, prism-deploy]` and a comment names
   it **LXC 261 at `10.0.200.61`**. The brief described it as "RB-DA2-Runner1 / CT 261 on SRV03 (flaky)".
   Reconcile the runner's true host/identity.
3. **Connector version.** `.cursor/rules/connectors.mdc` says the canonical checkout is **v0.1.27**, but
   `docs/SESSION_HANDOFF.md` (dated 2026-06-02) documents through **v0.1.26**. Confirm the current published
   connector tag.
4. **PC01 effective config vs code defaults.** The agent's *code* default is
   `VisualiserTemplateProjectPath=C:\PRISM\Templates\MINIMAL_CUBE`, `VisualiserConnectorImport=null` (auto),
   `VisualiserFullEditor=false`. But `docs/SESSION_HANDOFF.md` reports PC01's *deployed* `agent-config.json`
   as `visualiserConnectorImport:true`, `visualiserTemplateProjectPath:C:\PRISM\Templates\REBUS_Visualiser`.
   Verify which mode PC01 is actually running.
5. **"session 18" master-briefing entry.** `REBUS System/CLAUDE.md` is now a router (the full briefing moved
   to `legacy-archive/` + `architecture/decisions/CHANGELOG.md`, which is not present in this checkout). The
   per-session "Completed (2026-06-02, session 18 …)" wording could not be read directly; the facts above are
   sourced from `PRISM/CHANGELOG.md` and `docs/SESSION_HANDOFF.md` instead.
6. **MVR/GDTF Phase-J end-to-end.** The detector + second UE pass exist and are unit-tested, but real
   MVR→DMX import has not been validated on a UE box with the DMX plugin (gated on the artist template).
