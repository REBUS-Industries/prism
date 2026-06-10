# Changelog

All notable changes to **PRISM** (server + agent + connector submodule) live
here. Versions tagged on this repo are agent versions; server image tags follow
the same numbering when bumped, otherwise server ships as rolling deploys off
`main` via the `server-image` workflow.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Release-notes convention

Each `## vX.Y.Z` section below is auto-extracted into the matching GitHub
Release body on tag push (see `.github/workflows/agent.yml`, step *Extract
release notes from CHANGELOG*). Use the format:

    ## vX.Y.Z â€” Optional title

    - Bullet describing change 1
    - Bullet describing change 2

The CI extracts everything between `## vX.Y.Z` and the next `## v` heading,
verbatim, so subsections (`### Fixed`, `### Added`, blockquotes, etc.) come
through unchanged. Lines preceding the first `## v` header (including the
`## Unreleased` working area) are ignored by the extractor.

---

## Unreleased

### Investigated â€” Parent-model (tree) import blocked by "no versions yet" error

- **Root cause identified.** `server/src/jobs/dispatcher.ts` (lines ~419â€“439) calls `getLatestVersionId` (ORBIT GraphQL `model.versions(limit:1)`) before launching UE. A parent container model (e.g. `building`) that has no committed versions of its own â€” only submodels like `building/shell` â€” returns `null`, and the dispatcher immediately rejects the run with `version_unavailable`. The UE connector is never reached, which is why v0.4.8/v0.4.9 connector changes had no effect.
- **Fix specified, not yet implemented.** Full change specification (root cause, 4-layer fix, and test plan) documented in `PRISM/docs/PARENT_MODEL_IMPORT_HANDOFF.md`. The fix introduces an `importMode: 'tree'` flag on the `POST /api/visualiser/streams` API that bypasses version resolution, threads `modelName` + `importMode` through the dispatcher â†’ agent protocol â†’ orchestrator CLI â†’ UE command line, and adds a branch in `FOrbitHeadlessAutoImport.cpp` to call `OrbitImportTree` instead of `OrbitImport`.

### Fixed â€” Visualiser stream no longer drops at ~5 minutes while being watched

- **Root cause.** The signalling-WS JWT had a 300 s (5-minute) TTL and the
  browser player refreshed it only ONCE after connect. Epic's PS frontend
  re-invokes its (synchronous) signalling-URL builder on every auto-reconnect,
  so the first time the signalling socket reconnected after ~5 min it
  re-presented the now-expired token; the server rejected the WS with 4401 and
  the lib's auto-reconnect could not recover â€” dropping an actively-watched
  viewer right at the 5-minute mark. (300 s == the reported symptom.)
- **Web.** `PixelStreamingPlayer.vue` now keeps the cached signalling URL's
  token fresh â€” refreshing on a 60 s interval AND immediately on disconnect â€”
  so every (re)connect carries a live JWT. The stable per-viewer `viewerId` is
  preserved across refreshes, so the Wilbur player + controller seat survive.
- **Server.** `JWT_SIGNALLING_TTL_SEC` default raised **300 -> 3600** (1 hour)
  so a normal session + reconnects never outlive a single token; still
  env-configurable. The replay window stays bounded (token is scoped to one
  ephemeral runId + viewer seat).
- **Web (hardening).** Explicitly pin the Pixel Streaming **AFK watchdog OFF**
  (`AFKDetection=false`, `AFKTimeoutSecs=0`) in the viewer Config. It is off by
  default in the lib, but the AFK timeout is the only code path that emits the
  literal "You have been disconnected due to inactivity." string, so pinning it
  guarantees a long-watched (input-idle) stream can never be AFK-reaped even if
  a lib default or stray URL param changed.

### Fixed â€” Visualiser idle reaper now viewer-aware (no more "no activity" false positives)

- **Server.** A live (`streaming`) visualiser run is now only reaped for
  inactivity when it has **zero connected browser viewers** â€” never while a
  viewer is watching. The authoritative signal is the count of open viewer
  signalling sockets in `signallingProxyRegistry` (a viewer keeps that socket
  open for the whole session), so a viewer who is merely WATCHING (no
  mouse/keyboard input) is correctly counted as active. This avoids the
  false-positive class where "activity" was conflated with recent
  signalling/input traffic â€” in PRISM's non-SFU topology the WebRTC media +
  input data channel go peer-to-peer and the signalling stream goes quiet a
  few seconds after negotiation even while the viewer is actively watching.
- New `server/src/visualiser/idleReaper.ts`: when the last viewer of a run
  disconnects, a per-run countdown starts; any viewer (re)connect cancels it.
  If it elapses the run is ended with a clear, diagnosable reason
  (`no viewers connected for Ns`) and the GPU is reclaimed (agent
  `cancelVisualisation`, row â†’ `ended` with `failureReason='idle_no_viewers'`,
  slot released, signalling sockets closed).
- Configurable via `VISUALISER_IDLE_TIMEOUT_MS` (default **600000** = 10 min;
  `0` disables). This is **separate from** the pre-`streaming`
  `VISUALISER_START_TIMEOUT_MS` start timeout â€” the two are not conflated.

### Docs â€” Visualiser multi-viewer & session-control API (docs-only)

- New `docs/API_MULTIVIEW_SESSION_CONTROL.md`: the session lifecycle state
  machine (`queuedâ†’importingâ†’streamingâ†’ended/failed`), every
  `/api/visualiser/*` REST endpoint (including the previously-undocumented
  share-link routes), the serverâ†”agent WS protocol
  (`startVisualisation`/`visualisationReady`/`Failed`/`Ended`/`cancelVisualisation`/
  `signallingFrame`/`signallingViewerClose`/`setViewerControl`), the multi-viewer
  model (per-viewer demux, view/control tiers, single-controller lock + control
  WS, input gate, share links, â‰ˆ5-viewer / single-tenant limits), and
  end-to-end examples. Cross-linked from `PORTAL_INTEGRATION.md`.
- OpenAPI (`server/src/docs/openapi.ts`): documented the share-link endpoints
  (`POST`/`GET /streams/{runId}/shares`, public `â€¦/shares/exchange`,
  `DELETE â€¦/shares/{id}`) + schemas; added `viewerId`/`tier` to the
  signalling-token response; corrected the start-timeout note to the current
  600 s code default.

### Visualiser â€” OrbitConnector.UE5 import path (feature branch, not yet tagged)

- **Agent `AgentConfig.VisualiserConnectorImport`** (`bool?`, tri-state): `true`
  forces the connector-import path, `false` forces the legacy Interchange path,
  `null` (default) lets the orchestrator auto-detect based on whether the fixed
  visualiser project carries a usable `OrbitConnector.UE5` plug-in + `orbit-cli`.
- **`VisualiserJob`** now always forwards `PRISM_VISUALISER_TEMPLATE_PROJECT`
  (from `VisualiserTemplateProjectPath`) to the orchestrator â€” previously
  full-editor only â€” and forwards `PRISM_VISUALISER_CONNECTOR_IMPORT` when the
  config is set. It also recognises the orchestrator's
  `prism-visualiser/connector-import/v1` stdout event.
- Orchestrator + connector details: see `PRISM/visualiser/CHANGELOG.md`
  (v0.5.13), `orbit-connectors` CHANGELOG (v0.1.24), and
  `PRISM/docs/VISUALISER_CONNECTOR_IMPORT.md`.
- Agentâ†”server protocol is unchanged (backward-compatible).

## v0.3.42 -- 2026-06-10 -- Live server URL reconnect

- Live server URL reconnect -- changing PrismServerUrl in settings or tray now reconnects immediately without requiring a reinstall

## v0.3.41 -- 2026-06-09 -- Pass explicit submodel IDs through dispatch chain

- Pass explicit submodel IDs through dispatch chain; UE connector now receives -OrbitSubmodelIds= arg and can bypass orbit-cli models lookup to pull correct submodels directly

## v0.3.40 -- 2026-06-09 -- Bundle visualiser v0.5.23 orbit-cli server URL fix

- Bundle visualiser v0.5.23 -- fixes orbit-cli pull using server alias instead of URL; import now resolves against the self-hosted ORBIT instance

## v0.3.39 -- 2026-06-08 -- Bundle visualiser orchestrator into agent CI + installer

- Bundle visualiser orchestrator into agent installer; agent CI now builds orchestrator in lockstep and stamps it with the agent version.
- gent.yml: added isualiser/** to paths trigger so orchestrator changes rebuild the agent package; orchestrator build + zip staging runs before the Inno Setup step and is included in PRISM.Agent-v0.3.39.zip under Visualiser/.
- isualiser-msi.yml: push trigger removed -- orchestrator now ships bundled with the agent; the separate visualiser MSI workflow is disabled.

## v0.3.38 -- 2026-06-08 -- Parent model (tree) import

### Added -- `importMode: 'tree'` skips version check, threads tree-import through all layers

- **Server (POST /api/visualiser/streams).** Accepts importMode: 'tree' in the request body; dispatcher bypasses getLatestVersionId (which returns null for parent/container models with no committed versions of their own) and forwards importMode + modelName via the agent protocol.
- **Shared contracts (gent-protocol.ts/.json/AgentProtocol.cs).** StartVisualiserPayload gains ImportMode and ModelName fields so the tree-import intent survives the WS hop server -> agent.
- **Agent (VisualiserJob.cs).** Forwards importMode and modelName as CLI args to the orchestrator process.
- **Orchestrator (RunManifest.cs, OrbitImportParams.cs, Program.cs, UnrealLauncher.cs).** RunManifest carries the new fields; OrbitImportParams exposes ImportMode; Program.cs branches on 	ree to skip per-version resolution; UnrealLauncher appends -OrbitImportMode=tree -OrbitModelName=<name> to the UE command line.
- **DB migration  009_visualiser_tree_import.** Adds import_mode and model_name columns to the visualiser-streams table.

## v0.3.37 â€” 2026-06-05 â€” Fix "Latest" template dropdown still pulls old version on existing installs

### Fixed â€” "Latest release" now correctly resolves the newest template even when an old tag is persisted in agent-config.json

**Root cause.** v0.3.36 only blanked the compile-time default of
`UnrealTemplateTag` in `AgentConfig.cs`. Existing workstations have
`"v1.0.0-ue5.7"` (or another old value) saved in `agent-config.json` on disk.
At runtime `_cfg.UnrealTemplateTag = "v1.0.0-ue5.7"` still, and the
`PullTemplate` control plane fell back to it when the UI sent an empty `tag`:

```
UI sends tag="" â†’ PullTemplate: tag=null
                â†’ startedTag = _cfg.UnrealTemplateTag = "v1.0.0-ue5.7"
                â†’ PullAsync(configuredTag="v1.0.0-ue5.7")
                â†’ ResolveReleaseAsync resolves that specific old tag âœ—
```

The connector was already `""` in config so it was unaffected, which is why
the connector resolved latest (v0.4.0) correctly but the template did not.

**Fix â€” explicit `"latest"` sentinel through the whole call chain.**

1. **`IndexHtml.cs`** â€” the "Latest release" option in the template version
   dropdown now has `value="latest"` (was `""`). The `doPull()` function sends
   `tag: "latest"` in the POST body (a non-empty string is truthy so the existing
   `if (tag) body.tag = tag` includes it). The toast label handles the sentinel:
   `(!tag || tag === 'latest') ? 'latest UE template' : 'version ' + tag`.

2. **`AgentControlPlane.PullTemplate`** â€” detects the sentinel
   (`wantsLatest = tag?.Trim() === "latest"`) and explicitly **bypasses** the
   persisted `_cfg.UnrealTemplateTag` by passing `configuredTag: ""` to
   `PullAsync` (instead of `_cfg.UnrealTemplateTag`). This means both
   `requestedTag` and `configuredTag` are blank and `ResolveReleaseAsync` calls
   `TryGetReleaseAsync(null)` â†’ `GET /releases?per_page=1` â†’ newest release. âœ“

**Call chain after the fix:**
```
UI sends tag="latest" â†’ PullTemplate: wantsLatest=true, tag=null
                      â†’ PullAsync(requestedTag=null, configuredTag="")
                      â†’ ResolveReleaseAsync: both blank â†’ TryGetReleaseAsync(null)
                      â†’ GET /releases?per_page=1 â†’ v1.0.96-ue5.7 (or newest) âœ“
```

Workstations that have a specific tag saved in config (and have NOT selected
"Latest") continue to use their saved tag as before. The sentinel only fires
when the dropdown is explicitly on "Latest release".

## v0.3.36 â€” 2026-06-05 â€” Fix "Latest" resolving wrong (old) template/connector version

### Fixed â€” "Latest" in the pull dropdown was pulling an old version

Two root causes:

1. **`AgentConfig.UnrealTemplateTag` default was `"v1.0.0-ue5.7"`** â€” the
   hardcoded default flowed as `configuredTag` into `TemplatePuller.PullAsync`,
   which tried to resolve that specific old tag before falling back to "latest".
   Since the tag still exists on GitHub the fallback never fired, so "Latest" in
   the dropdown always pulled `v1.0.0-ue5.7`. **Fix:** default changed to `""`
   (blank). Blank now means *resolve the most recently published release at pull
   time*, documented in the field comment. Workstations that have
   `UnrealTemplateTag` set to a specific value in `agent-config.json` are
   unaffected â€” the override only applies when the saved value is blank.

2. **`GET /releases/latest` skips pre-releases** â€” `TryGetReleaseAsync` (used for
   both the template "latest" path and as a fallback when a configured tag is
   missing) was calling `GET /repos/{owner}/{repo}/releases/latest`. GitHub's
   `/releases/latest` endpoint returns the most recent **non-prerelease,
   non-draft** release, so if newer releases are flagged as pre-release on GitHub
   (e.g. `v1.0.96-ue5.7`) the endpoint silently returned an older stable one.
   **Fix:** when `tag` is null, now calls
   `GET /repos/{owner}/{repo}/releases?per_page=1` (sorted by publication date
   descending) which returns the most recently published release **regardless of
   pre-release status**. The same fix is applied to `ResolveConnectorAssetAsync`
   for the connector "latest" path.

**Verification of the "Latest" call chain after the fix:**
- Operator selects "Latest" â†’ UI sends empty `tag`
- `AgentControlPlane.PullTemplate(tag=null)` â†’ `PullAsync(requestedTag=null, configuredTag="")`
- `ResolveReleaseAsync`: both tags empty â†’ `TryGetReleaseAsync(repo, tag=null)`
- `TryGetReleaseAsync(null)` â†’ `GET /releases?per_page=1` â†’ most recently published release âœ“

**Note:** `OrbitConnectorTag` already defaulted to `""` (blank) â€” no change needed.
`ListReleasesAsync` already used `/releases?per_page=50` and did not filter
pre-releases â€” already correct.

## v0.3.35 â€” 2026-06-05 â€” Connector version dropdown: releases, pre-releases, and dev branches

### Added â€” Pick any connector version (including dev branches) in the pull UI

- **Connector version picker** on the agent web UI's Visualiser card: a
  `<select>` dropdown, populated from a new
  **`GET /api/visualiser/connector/refs`** endpoint, with three groups:
  - **Releases** (all releases including **pre-releases**; labelled and
    annotated as pre-release; pre-built `OrbitConnector-UE5-plugin-*.zip` asset
    indicated; source-only releases noted separately).
  - **Branches** (all branches from the connector repo, labelled as `(branch,
    source â€” requires Compile after pull)`).
  - **Custom refâ€¦** â€” reveals a text input for any arbitrary ref (tag, branch
    name, short SHA).
  - Default: **Latest release** (empty = existing configured/default behaviour,
    preserved for ops that don't select anything). The dropdown is NOT saved to
    config; it is a per-pull override only.
- **`ListConnectorRefsAsync`** â€” fetches releases (ETag-conditional, 304 free)
  **and** branches (`GET /repos/{owner}/{repo}/branches`) for the configured
  connector repo in one combined response. Branches are prefixed with `branch:`
  in the returned `Ref` value so the pull flow distinguishes them.
- **Branch ref resolution in the pull flow** (`ResolveConnectorAssetAsync`):
  - `branch:<name>` â†’ directly downloads the source zipball for that branch
    (`GET /repos/{owner}/{repo}/zipball/{branch}`) and falls through to the
    existing `.uplugin`-scan + copy path. The C++ source is compiled by UBT as
    part of the normal `CompileProjectAsync` step (requires
    `VisualiserCompileProject = true`).
  - Any release tag that returns HTTP 404 (e.g. a branch name passed without
    the `branch:` prefix, or a short SHA) falls back to the source zipball for
    that ref, with a warning logged.
  - Source-path merges are clearly labelled in progress messages:
    *"installing connector from branch HEAD feat/foo (source, will compile)"*
    vs *"downloading connector v0.1.28â€¦"*.
- The selection is plumbed as `connectorRef` in the pull body â†’
  `AgentControlPlane.PullTemplate(connectorRef:)` â†’ `PullAsync(connectorTag:)`
  â€” **overrides** the persisted `OrbitConnectorTag` for this pull only (the
  config value is unchanged).
- Cache with ETag (same 5-min TTL as template releases; 304 revalidations are
  free against the GitHub rate limit). Authenticated with the GitHub token when
  set.

## v0.3.34 â€” 2026-06-05 â€” Install a UE Engine plugin from a URL (agent web UI)

### Added â€” Paste a link, install into Engine\Plugins

- **New "Install Engine Plugin (from URL)" section** on the agent web UI: paste
  an http(s) link to a `.zip`, click **Install**, and watch the
  download â†’ extract â†’ copy progress + the installed plug-in list inline. The UI
  notes prominently that **the file must contain a `Plugins` folder with the
  plug-in files/folders inside it**, which are copied into the UE Engine's
  `Engine\Plugins` directory.
- **`EnginePluginInstaller`** (`agent/src/PRISM.Agent/Visualiser/`): validates the
  URL (http/https only â€” no `file://`/local paths), stream-downloads to a temp
  file (20-min timeout, 4 GB cap, actionable HTTP errors), verifies it's a zip
  (`.zip` or PK magic), extracts, then **locates the single `Plugins` folder**
  (case-insensitive) at the archive root or one level down â€” erroring clearly on
  none/ambiguous. Each entry (file AND folder) inside that `Plugins` folder is
  copied into `<UnrealEngineRoot>\Engine\Plugins\`, **overwriting same-named
  plug-ins only** (the rest of `Engine\Plugins` is never touched). Reuses the
  template-pull robust copy/delete helpers (clear read-only, retry on transient
  locks) so an existing plug-in's read-only `Binaries` can be replaced; sweeps
  stale temp dirs and cleans up after itself.
- **Target** = `Path.Combine(UnrealEngineRoot, "Engine", "Plugins")`; a missing
  engine root or `Engine\Plugins` is reported with an actionable message.
- **Unreal-running guard:** engine plug-in DLLs are locked while the editor is
  open, so the install reuses the same `UnrealProcessGuard`
  detect â†’ prompt â†’ force-close flow as the template pull. If UE is running the
  install is refused with HTTP 409 + the process list; the web UI prompts
  *"Unreal is running (N) â€” force-close and continue?"*; on confirm it re-invokes
  with `forceCloseUnreal`, which kills UE, waits for handles to release, then
  copies. Default is safe (no auto-kill without confirmation).
- **Endpoint:** `POST /api/engine-plugin/install` (`{ url, force? }`); progress is
  surfaced via `AgentControlPlane.InstallEnginePlugin` (single-flight gate +
  status) on `/api/state` as `enginePluginInstall`. No secrets logged.

## v0.3.33 â€” 2026-06-04 â€” /uelogs ignore (exclude) filter

### Added â€” Hide noisy UE console lines by pattern

- The **`/uelogs`** live console page gains an **Ignore** filter alongside the
  existing Include filter. Enter one or more exclude patterns (**one per line
  and/or comma-separated**); a line is hidden if it matches **any** of them.
- **Precedence:** a line is shown only when it passes the Include filter (if
  set) **AND** matches **no** Ignore pattern â€” i.e. Ignore always wins. Both are
  case-insensitive substring matches and apply to **both** the replayed backlog
  and live-appended SSE lines.
- **Persistence:** the Include and Ignore filters are saved in
  <c>localStorage</c> (per browser), so they survive page reloads and SSE
  reconnects.
- **Quality of life:** a **âœ• ignore** clear button, and **double-click a line**
  (or select text first) to add it to the ignore list via a prompt. The line
  counter now reads **"showing X of Y"** when a filter is active so it's obvious
  filtering is on; the auto-scroll, clear, status indicator, sequence-dedup, and
  the DOM cap (counters stay consistent as capped rows are evicted) all keep
  working. Client-side only, vanilla JS, no new endpoints.

## v0.3.32 â€” 2026-06-04 â€” Live UE console-log page in the agent web UI (/uelogs)

### Added â€” Stream the Unreal Engine console to the browser, no RDP needed

- **New `/uelogs` page** (`http://<agent-host>:7421/uelogs`) â€” a live,
  auto-scrolling, monospace tail of the Unreal Engine `-game` / editor console
  output for visualiser runs on that workstation. Operators can watch UE logs in
  the browser without remoting into the box. Includes an auto-scroll
  (pin-to-bottom) toggle, a case-insensitive text filter, a clear button, a line
  counter, a timestamp/runId toggle, and a connection-status indicator with
  automatic reconnect. Linked from the Visualiser section of the main agent page.
- **`GET /api/uelogs/stream` (Server-Sent Events)** â€” replays the recent backlog
  (`?n=`, default 1000) then live-appends each new line. Tolerates many
  concurrent viewers (each gets its own bounded subscription) and cleans up on
  client disconnect / agent shutdown; a 15 s heartbeat detects half-open sockets
  and the client de-dupes by sequence number across reconnects.
- **`UeLogBroadcaster`** â€” an in-process singleton ring buffer (last
  **4,000** lines, oldest evicted) + pub/sub. `VisualiserJob` taps it on every
  orchestrator **stdout and stderr** line (the stderr stream carries the UE
  `ue-game` / `ue-editor-stream` console output), tagging each with the `runId`.
  The buffer **persists across runs** so the page shows the last run's tail even
  with no active run, and is bounded so it never grows without limit. Each
  subscriber's live queue is bounded + drop-oldest, so a slow browser can never
  block the orchestrator pump or balloon agent memory.

### Security

- No new secret exposure: the orchestrator already redacts `-OrbitToken` /
  `-RebusApiKey` before they reach its console, and the broadcaster relays
  console lines verbatim â€” it never reads agent config or the child environment.

## v0.3.31 â€” 2026-06-03 â€” Admin Workstations versions stay in sync with the agent's own UI

### Fixed â€” Installed UE template / connector version no longer goes stale on the admin Workstations page

- **Root cause (server).** The agent's local web UI reads the on-disk
  `.prism-template.json` marker *live on every request*, but the central admin
  Workstations page only learns the installed UE template / connector version
  from the `hello` message. The agent already re-sends `hello` after a template
  pull or a config mutation, but the server's WS handler dropped **every** hello
  after the first on a given socket (`duplicate hello on same socket; ignoring`).
  So the admin row stayed frozen at whatever was true at initial connect and
  only ever updated on a full reconnect â€” diverging from the agent's own UI.
- **Server.** A re-`hello` on an established connection is now treated as a
  REFRESH of the workstation's self-reported fields (nodeName, formats, slots,
  agent version, rhino version, installed template tag, installed connector
  tag) and broadcasts a workstation update so the admin SPA re-fetches. It does
  NOT create a second `agent_sessions` row, re-run the queued-job dispatch
  sweep, or touch the admin-managed role flags. (No protocol or schema change â€”
  the `installed_template_tag` / `installed_connector_tag` columns already
  exist.)
- **Agent.** The heartbeat loop now re-resolves the installed versions every
  tick and re-announces `hello` when they (or the agent version) change since
  the last announcement, so an out-of-band change (a pull that didn't go through
  the control plane, a manual template swap) converges the admin row within one
  heartbeat interval rather than waiting for a reconnect.
- Agentâ†”server protocol is unchanged (backward-compatible). Existing
  workstations self-correct on their next connect once the server is deployed;
  no manual re-pull or agent restart is required for the server-side fix.

## v0.3.30 â€” 2026-06-03 â€” Self-diagnosing compile failures (surface UBT log + C++ toolchain hint)

### Changed â€” Template-pull compile errors are now actionable instead of a bare exit code

- **Context.** On a workstation without a C++ build toolchain (e.g. a GPU/
  streaming box that only ever *ran* packaged builds), the compile-on-pull step
  fails almost instantly with `UnrealBuildTool exit 6` and
  `Platform Win64 is not a valid platform to build`. That is UBT's platform
  validation failing because there is **no MSVC v143 + Windows SDK** for it to
  build Win64 with â€” not an engine-root or project problem (Build.bat + the
  bundled DotNet ran fine and got as far as "Creating makefile").
- **Self-diagnosing failures.** `TemplatePuller.CompileProjectAsync` now:
  - detects the `is not a valid platform to build` signature and appends a
    targeted, actionable hint to the `TemplatePullException` â€” install Visual
    Studio 2022 (or Build Tools) with the **Desktop development with C++**
    workload (MSVC v143 + a Windows 10/11 SDK), then restart the agent and pull
    again; or untick **Compile project after pull** to pull without compiling;
  - appends the tail of UBT's own `Log.txt`
    (`%LOCALAPPDATA%\UnrealBuildTool\Log.txt`) â€” which carries the detailed
    platform/SDK validation lines the redirected stdout summary omits â€” so the
    failure is diagnosable from the agent UI/log alone;
  - runs a **best-effort MSVC toolchain probe** (`vswhere -requires
    Microsoft.VisualStudio.Component.VC.Tools.x86.x64`) *before* compiling and
    warns early when no toolchain is present. The probe is advisory only
    (inconclusive results never block a compile, so a working box is never
    falsely refused).
- **Escape hatch (unchanged, now documented).** Setting
  `VisualiserCompileProject = false` (the **Compile project after pull**
  checkbox in the agent web UI â€” live-applied, read at pull time) skips the
  compile entirely: the pull â†’ connector-merge â†’ install completes and the
  project is installed un-compiled. Use it when the box runs a pre-built
  engine/project or compiles elsewhere. The compile engine is the configured
  `UnrealEngineRoot` (also web-UI editable), so an operator can point the
  compile at a specific full engine install.
- No protocol or behaviour change to a working compile path â€” only failure
  diagnostics + an early advisory warning.

## v0.3.29 â€” 2026-06-03 â€” Installed UE template version is now marker-authoritative + show the merged connector version

### Fixed â€” Agent reported a stale/incorrect "installed UE template" version

- **Root cause.** The version surfaced on the admin Workstations page (and the
  agent web UI) comes from `TemplateMarker.Resolve`, which prefers the on-disk
  `.prism-template.json` marker but **fell back to the persisted
  `AgentConfig.VisualiserTemplateVersion`** whenever that marker was absent â€”
  *without checking that the configured project still exists*. The marker was
  also only written by the post-pull control-plane path
  (`AgentControlPlane.PullTemplate`), never by the installer itself, and the
  write is best-effort (failures are swallowed). So a workstation whose
  configured `VisualiserTemplateProjectPath` had no marker (legacy install, a
  repointed path, or a swallowed marker-write) reported a previously-persisted
  tag that no longer matched what was physically installed.
- **Installer now owns the marker.** `TemplatePuller.PullAsync` writes the
  `.prism-template.json` marker (resolved template tag + merged connector tag +
  repo) into the installed project root as part of the install, so **every**
  project this code deposits carries an authoritative marker regardless of
  caller. The redundant control-plane write was removed.
- **No more stale fallback.** `TemplateMarker.Resolve` now only uses the
  persisted config tags when the configured project directory still exists on
  disk; otherwise it reports `unknown` rather than a stale, incorrect version.

### Added â€” Installed OrbitConnector version on the admin Workstations page

- The admin Workstations row now shows a **`Connector <tag>`** pill next to the
  `UE <tag>` pill for visualiser-capable workstations (previously the connector
  tag was only in the tooltip). The agent already reports
  `installedConnectorTag` on `hello` (since v0.3.24) and the agent web UI
  already shows it inline â€” this surfaces it in the admin SPA too. No protocol
  or schema change (the field already exists end-to-end).

> Operator note: a workstation only refreshes its reported version after the
> agent re-sends `hello` â€” i.e. on the next agent (re)connect or the next
> successful template pull. Existing workstations that show a stale version
> should be re-pulled (or the agent restarted) once running â‰¥ v0.3.29 so the
> installer writes a fresh marker.



### Fixed â€” `Access to the path 'â€¦\Templates\<Project>' is denied` on template pull

- **Root cause.** The pull's stage-and-swap step renames the live template
  folder aside before moving the freshly-staged copy into place
  (`TemplatePuller.InstallProject` â†’ `Directory.Move(dest, backup)`). When the
  **Unreal Editor was still running** it held open handles into that project
  tree, so the move failed with `UnauthorizedAccessException` ("Access to the
  path 'â€¦' is denied"). Read-only attributes on git-sourced / UE
  `Intermediate`/`Saved` files were a secondary trigger for the recursive
  deletes.
- **Primary fix â€” detect â†’ prompt â†’ force-close.** A pull now checks for
  running Unreal processes (`UnrealEditor`, `UnrealEditor-Cmd`,
  `CrashReportClient`, `UnrealBuildTool`) **before** touching the template
  folder. If any are found and the caller did not opt into force-close, the
  pull is refused and the running instances (names + PIDs + count) are returned.
  The **agent web UI** shows a confirm prompt â€” *"Unreal Engine is running (N
  instance(s)). Pulling a new template requires closing it. Force-close and
  continue?"* â€” and on confirm re-invokes the pull with `forceCloseUnreal`,
  which kills the detected process trees (`Process.Kill(entireProcessTree:
  true)`), waits for full exit + file-handle release (poll until gone + settle
  delay), then runs the normal pull â†’ connector merge â†’ compile. Progress is
  surfaced in the existing `templatePull` status ("closing Unrealâ€¦", then the
  usual stages). The PRISM orchestrator (`prism-visualiser.exe`) is **never**
  targeted; closing a `UnrealEditor-Cmd` that belongs to a live visualiser
  session is the explicit, operator-confirmed consequence and is called out in
  the prompt.
- **Defense-in-depth â€” robust delete/swap.** `InstallProject` now sweeps stale
  `.<name>.pull-*` / `<name>.old-*` artifacts from prior aborted runs, strips
  `FileAttributes.ReadOnly` recursively before every delete/move, retries
  delete/move with bounded backoff for transient locks, and on a genuinely
  locked target throws an **actionable** `TemplatePullException` (telling the
  operator to close the Editor/Explorer or use the confirm prompt) instead of a
  raw OS error.
- **Contract + admin parity.** `PullTemplateData` gained an optional `force`
  boolean (`shared/contracts/agent-protocol.{json,ts,cs}`), threaded through the
  agent WS dispatcher â†’ `AgentControlPlane.PullTemplate(tag, forceCloseUnreal)`,
  the server `POST /:id/pull-template` route, and the admin **Workstations**
  page (its confirm dialog now warns that a running Editor is force-closed and
  sends `force: true`).

## v0.3.27 â€” 2026-06-03 â€” Re-bundle the orchestrator (visualiser v0.5.19, import-orientation fix)

This is primarily a **release-coordination bump** so workstations get the current
`prism-visualiser` orchestrator through the normal agent update flow. The agent
build publishes the orchestrator from source and bundles it under
`Visualiser/` (see `.github/workflows/agent.yml`), so tagging `v0.3.27` ships:

- **Visualiser orchestrator v0.5.19**, including the **imported-model orientation
  fix** â€” the Interchange importer (`import_orbit.py`) now yaws the model root
  **90Â° clockwise** about Z (`ORBIT_IMPORT_YAW_DEGREES = +90.0`, overridable via
  `PRISM_VISUALISER_IMPORT_YAW_DEG`). Plus the v0.5.15â€“v0.5.18 orchestrator work
  (Portal `-PortalUrl`/`-RebusApiKey`, `-Orbit*` IDs on the UE command line for
  all plugins, deterministic `.uproject` selection, local-template-in-place).
- The agent features already landed since the last workstation update:
  v0.3.22 (Portal URL + REBUS API key from the web UI), v0.3.23â€“v0.3.24
  (multi-viewer/doc reconcile), v0.3.25 (authenticated GitHub API calls +
  rate-limit errors), v0.3.26 (GitHub token from the web UI).

> **Connector-import caveat:** the orientation fix lives in the Interchange
> importer. If a workstation's session uses the connector-import path
> (`visualiserConnectorImport: true`, or auto-detect when the fixed project
> bundles `OrbitConnector`), `import_orbit.py` does not run â€” that path needs the
> `orbit-connectors` `Yaw = +90` change, or force Interchange with
> `PRISM_VISUALISER_CONNECTOR_IMPORT=0`.

## v0.3.26 â€” 2026-06-03 â€” Set the GitHub token from the agent web UI

### Added

- **`AgentConfig.GitHubToken`** â€” the GitHub PAT for the template/connector
  pull + version picker can now be set from the **agent web UI** (Visualiser/
  Template card â†’ *GitHub token* field), not just the
  `PRISM_GITHUB_TOKEN` / `GITHUB_TOKEN` environment variables. It is read at
  pull time, so fixing a rate-limit needs **no OS env var and no restart**.
- **Token precedence:** the configured `GitHubToken` wins; if blank, the agent
  falls back to `PRISM_GITHUB_TOKEN` then `GITHUB_TOKEN` (existing env behaviour
  preserved). Threaded through **every** agent GitHub call path:
  `TemplatePuller.CreateHttpClient` â†’ the pull (`PullAsync` â†’ template release
  resolve + connector resolve/merge) and the version-picker
  (`AgentWebUi` â†’ `ListReleasesAsync`).

### Security

- **`GitHubToken` is a secret, handled exactly like `RebusApiKey`:** persisted
  to `agent-config.json`, **never logged**, and **never echoed back** in
  `/api/config` state (the UI sees only a `gitHubTokenSet` boolean). The web-UI
  field is write-only â€” populated from `gitHubTokenSet` (placeholder
  "token set" / "not set"), sent only when the operator types a value, and
  cleared after save. A null/blank update **leaves the stored token unchanged**
  (so an unrelated save never wipes it); only a non-blank value replaces it.

### Changed

- The actionable rate-limit error now also points operators at the agent web
  UI's *GitHub token* field (in addition to the env var).

## v0.3.25 â€” 2026-06-03 â€” Authenticate GitHub API calls + actionable rate-limit errors

### Fixed

- **Template pull / version picker no longer fail with an opaque "GitHub API
  rate limit exceeded".** GitHub's **anonymous** limit is 60 requests/hour per
  IP; a single pull makes ~2â€“4 API calls (resolve template release + asset,
  resolve the `OrbitConnector-UE5` asset, Â±a fallback), and the version-picker
  endpoints add more, so the shared budget is exhausted quickly.
- The agent already authenticates when `PRISM_GITHUB_TOKEN` / `GITHUB_TOKEN` is
  set (`CreateHttpClient` sends `Authorization: Bearer`) â€” the root cause was
  simply that **no token was configured on the workstation**. A token lifts the
  limit to 5000/hour.

### Changed

- **Actionable rate-limit error (agent + server).** A `403`/`429` with
  `x-ratelimit-remaining: 0` is now recognised as a rate limit (not a generic
  failure) and reports how to fix it (set `PRISM_GITHUB_TOKEN`, with the
  required PAT scope) **and the reset time** from `x-ratelimit-reset` /
  `Retry-After`. (`TemplatePuller.HttpFailure`; server `GitHubRateLimitError` â†’
  HTTP 429.)
- **Cheaper release-list refreshes (agent + server).** Both `/api/visualiser/
  template/releases` (agent web UI) and `/api/workstations/template-releases`
  (server) now cache for **5 minutes** and revalidate with an **`ETag`
  (`If-None-Match`)** â€” a `304 Not Modified` does not count against the rate
  limit. `TemplatePuller.ListReleasesAsync` returns the ETag + a `NotModified`
  flag for the caller's cache.
- **Server route** authenticates with `PRISM_GITHUB_TOKEN` / `GITHUB_TOKEN`
  (already present) and is wired into `infra/.env.example` +
  `infra/docker-compose.yml` so prod actually carries the token. (Server ships
  on the rolling `main` deploy â€” no separate tag.)

### Docs

- `docs/VISUALISER_CONNECTOR_IMPORT.md`: new "GitHub API token & rate limits"
  section â€” where to set `PRISM_GITHUB_TOKEN` on the agent (workstation env var,
  restart the agent) and the server (`infra/.env`), the PAT scope, and the
  60â†’5000/hr behaviour.

## v0.3.24 â€” 2026-06-02 â€” Report the installed UE template version to operators

### Added

- **Installed UE template version is now reported end-to-end.** The agent
  records which `orbit-ue-template` release is installed at
  `VisualiserTemplateProjectPath` and surfaces it on the admin Workstations
  page and the agent web UI, so operators can see what's actually running on a
  workstation without triggering a fresh pull.
- **Durable persistence (agent):** a successful "pull latest UE template" now
  writes a `.prism-template.json` marker into the installed project root
  (`{ templateTag, connectorTag, pulledAt, repo }`) and persists the same tags
  to `AgentConfig` (`VisualiserTemplateVersion` / `VisualiserConnectorVersion`).
  On startup the agent resolves the installed version from the marker (config
  value as fallback, else "unknown") â€” independent of the transient pull status,
  so it survives agent restarts. New `Visualiser/TemplateMarker` helper.
- **Protocol (backward-compatible):** the agent `hello` payload gains optional
  `installedTemplateTag` + `installedConnectorTag` fields. Mirrored across all
  three contract sources (`shared/contracts/agent-protocol.{json,ts,cs}`). Older
  agents simply omit the fields and the server shows "unknown".
- **Server:** new `workstations.installed_template_tag` /
  `installed_connector_tag` columns (migration `0007`), populated from `hello`
  and returned by `/api/workstations`.
- **Admin SPA:** a "UE \<tag\>" badge per visualiser-capable workstation in the
  Agent column (tooltip includes the connector tag); shows "unknown" when not set.
- **Agent web UI:** the Visualiser card now shows the installed template version
  (read-only) above the pull controls.

### Notes

- "Installed version" = the template release tag installed at
  `VisualiserTemplateProjectPath`. The agent re-announces `hello` immediately
  after a successful pull so the admin row updates without waiting for a
  reconnect. Server ships as a rolling deploy (no separate server tag).

## v0.3.23 â€” 2026-06-02 â€” Reconcile VisualiserTemplateProjectPath docs with the local pull flow

### Docs

- Updated the `AgentConfig.VisualiserTemplateProjectPath` summary: it is now
  normally set by the agent's "pull latest UE template" feature (installs +
  compiles into `C:\PRISM\Templates\<ProjectName>` and repoints here), is read
  by **both** the connector-import/streaming path and the full-editor path, and
  the orchestrator opens a local project **in place**. Dropped the stale
  reference to the dead AD UNC share as the source of truth (the `MINIMAL_CUBE`
  code default is unchanged). No behaviour change.
- Companion orchestrator change ships as visualiser **v0.5.16** (open a local
  template project in place; UNC sources still mirror) â€” see
  `visualiser/CHANGELOG.md`.

## v0.3.22 â€” 2026-06-02 â€” Portal URL + REBUS API key for the Unreal plug-ins

### Added

- **Portal connection settings on the agent.** New `AgentConfig.PortalUrl`
  (default `https://app.rebus.industries`) and `AgentConfig.RebusApiKey`
  (secret, default empty). Both are settable from the agent web UI's
  *Visualiser* card â€” a "Portal URL" text input and a write-only
  "Portal API key (REBUS)" password input.
- **The agent forwards the Portal connection to the orchestrator** via two new
  env vars: `PRISM_PORTAL_URL` and `PRISM_REBUS_API_KEY` (mirroring the
  `PRISM_VISUALISER_*` style). The orchestrator then appends
  `-PortalUrl="<url>"` and `-RebusApiKey=<key>` to the Unreal command line for
  BOTH the streaming `-game` launch and the full-editor (`+ stream`) launch.
  The flags are omitted entirely when their values are unset (no empty
  `-RebusApiKey=`).

### Security

- **`RebusApiKey` is a secret and is never leaked.** It follows the exact
  `-OrbitToken=` precedent: it is passed to Unreal on the command line only and
  is NEVER written to any log (the agent and orchestrator log only a
  `set`/`unset` indicator). The web UI `/api/config` state never echoes the
  value â€” it returns a `rebusApiKeySet` boolean instead, and the UI shows a
  "key set" placeholder. Writes are accepted; reads are masked.

### Behaviour

- **Blank-key update semantics:** a `null` or blank `rebusApiKey` in a config
  POST leaves the stored key unchanged, so an unrelated settings save (which
  can't round-trip the never-returned value) never wipes the key. Only a
  non-blank value replaces it. `PortalUrl` is not secret and is applied
  verbatim. Both are read at job-launch, so changes apply on the next
  visualiser run with no agent restart.
- Orchestrator companion release: `PRISM/visualiser/CHANGELOG.md` (v0.5.15).

## v0.3.21 â€” 2026-06-02 â€” Compile the pulled project so the headless -game launch works

### Fixed

- **A freshly-pulled visualiser project now launches without opening Unreal
  manually first.** The pulled `orbit-ue-template` project and the merged
  `OrbitConnector.UE5` / `glTFRuntime` plug-ins ship C++ **source only** (no
  `Binaries`), so the orchestrator's headless `UnrealEditor-Cmd â€¦ -game`
  exited immediately â€” surfaced as
  `ue_game_crashed: UE -game exited (code=1) before registering a streamer`.
  The operator's workaround was to open the project in the editor once to let
  it compile.

### Added

- **Template pull now compiles the project as its final step.** After install
  (+ connector merge), the agent builds the project's **Editor** target with
  UnrealBuildTool:

      <UnrealEngineRoot>\Engine\Build\BatchFiles\Build.bat \
        <ProjectName>Editor Win64 Development \
        -Project="<installed>.uproject" -WaitMutex -FromMsBuild

  This is the same compile opening the editor triggers, so a subsequent
  `-game` launch has module binaries. Build output streams to the agent log
  (channel `ubt`) and UBT `[n/m]` progress is surfaced on the templatePull
  status line; a non-zero build exit fails the pull with the build-log tail in
  the error.
  - The Editor target name is read from `Source\*Editor.Target.cs` when present,
    else defaults to `<ProjectName>Editor` (which UBT also synthesises for a
    content-only project that enables a code plug-in â€” the scaffold + connector
    case).
  - The compile is skipped automatically when the project has no C++ source and
    no code plug-in (a pure Blueprint project needs no binaries).
  - The engine is located from `AgentConfig.UnrealEngineRoot`; a missing/invalid
    root fails the pull with an actionable message instead of installing a
    project that can't launch.
- New `AgentConfig.VisualiserCompileProject` (default `true`; web-UI toggle on
  the Visualiser card) to skip the build for a project known to ship prebuilt
  binaries.

## v0.3.20 â€” 2026-06-02 â€” Drop redundant template/connector tag inputs from the agent web UI

### Changed

- **Removed two now-redundant freeform inputs from the agent web UI's
  Visualiser card:** the *Template tag* (`unrealTemplateTag`) and *Connector
  tag* (`orbitConnectorTag`) text boxes. The release dropdown (default
  *Latest*) now drives which template version is pulled, and the connector
  always merges its latest build (toggle still present), so the manual tag
  boxes were duplicate surface.

### Kept (no behaviour change)

- `AgentConfig.UnrealTemplateTag` is retained: it is still the
  configured-default fallback for the pull flow (`PullAsync` `configuredTag`,
  which degrades to *latest* when the tag has no release) **and** is still
  editable from the Windows tray `SettingsForm`.
- `AgentConfig.OrbitConnectorTag` is retained: it still pins the connector
  release the pull merges when set (blank = latest).
- Both `ConfigUpdate` fields and the `/api/config` PATCH plumbing stay intact;
  the web UI simply no longer sends these two keys (ApplyAsync leaves an
  omitted field unchanged), so existing values are preserved.

## v0.3.19 â€” 2026-06-02 â€” Template pull: pick a version + merge the OrbitConnector plug-in

### Added

- **Connector merge is now part of every template pull.** After downloading the
  selected `orbit-ue-template` release, the agent also pulls the latest (or a
  pinned) `OrbitConnector.UE5` build from the connectors repo and merges every
  plug-in folder in `OrbitConnector-UE5-plugin-<tag>.zip` (the connector +
  bundled `orbit-cli.exe`, plus its `glTFRuntime` dependency) into the pulled
  project's `Plugins\`. The merge happens *before* the atomic install, so a
  connector failure aborts the whole pull cleanly rather than leaving a
  connector-less project on disk. This makes a freshly-pulled project usable by
  the orchestrator's connector-driven import path (`OrbitConnectorLocator`) with
  no manual plug-in install.
  - New `AgentConfig`: `OrbitConnectorRepo` (default
    `REBUS-ORBIT/orbit-connectors`), `OrbitConnectorTag` (blank = latest), and
    `VisualiserPullConnector` (default `true`; turn off to pull the template
    verbatim). All three are editable on the agent web UI and PATCHable via
    `/api/config`.
- **Release/version picker.** The operator can now choose *which* published
  template release to pull instead of always taking latest:
  - Agent: `TemplatePuller.ListReleasesAsync` lists the configured repo's
    releases (tag, name, published date, prerelease flag, archive availability);
    new agent endpoint `GET /api/visualiser/template/releases` (60s cache) feeds
    a dropdown on the web UI's Visualiser card. The "Pull" button now pulls the
    selected tag (default **Latest release**).
  - Server: `GET /api/workstations/template-releases` lists the template repo's
    releases (60s cache, `?repo=` override) for the admin SPA, which now shows a
    per-row **version dropdown** next to "Pull template" and forwards the chosen
    tag through the existing `pull-template` route.
- An explicitly-selected tag is authoritative end-to-end â€” the agent's
  `requestedTag` path still hard-fails on a 404 (no silent fallback to latest);
  only the *configured default* tag degrades to latest (unchanged from v0.3.18).

### Changed

- `TemplatePuller.PullAsync` now takes connector parameters and returns the
  merged connector tag + plug-in list; the web-UI / WS pull status surfaces
  `â€¦ + connector <tag>` on success.

## v0.3.18 â€” 2026-06-02 â€” Template pull falls back to latest when the pinned tag is missing

### Fixed

- **Template pull no longer hard-fails when the configured `UnrealTemplateTag`
  has no published release.** The default tag (`v1.0.0-ue5.7`, the
  yet-to-be-published artist build) 404'd against
  `orbit-ue-template`, which only ships `v0.1.0-ue5.7-scaffold`. The
  configured tag is now treated as a *preference*: if its release does not
  exist the agent falls back to the repo's `releases/latest` (with a WARN +
  web-UI status note). An **operator-typed / admin-pinned** tag still hard-fails
  on 404 (with a hint to clear it), since that is an explicit request.

## v0.3.17 â€” 2026-06-02 â€” Pull latest UE template onto a workstation

- **New "pull latest UE template" action on the agent.** Downloads the latest
  (or a pinned) `orbit-ue-template` GitHub release and installs the contained
  UE project into the workstation's template root (default
  `C:\PRISM\Templates`), then repoints `VisualiserTemplateProjectPath` at the
  pulled project so the next visualiser run uses it. Picks a `.zip` release
  asset when present, else the source `zipball`; honours `PRISM_GITHUB_TOKEN` /
  `GITHUB_TOKEN` for a private template repo.
  - New agent core: `Visualiser/TemplatePuller.cs` (resolve â†’ download â†’
    extract â†’ locate `.uproject` â†’ atomic stage-and-swap install with rollback)
    + `AgentControlPlane.PullTemplate` with a single-flight gate and a
    `TemplatePullStatus` surfaced on the web UI.
  - New `AgentConfig` fields: `UnrealTemplateRepo` (default
    `REBUS-ORBIT/orbit-ue-template`) and `VisualiserTemplateRoot` (default
    `C:\PRISM\Templates`).
- **Two trigger surfaces:**
  - Agent local web UI (`:7421`): a *Pull latest UE template* button + live
    status line in the Visualiser card, plus editable template root / repo.
  - Admin **Workstations** page: a *Pull template* button (shown for
    visualiser-capable nodes) â†’ `POST /api/workstations/:id/pull-template` â†’
    new `pullTemplate` WS command â†’ agent. Fire-and-forget, mirroring `update`
    (the agent runs the pull in the background and reports progress on its own
    web UI). Requires the matching server deploy; older agents ignore the
    unknown message.
- **Contracts:** added the `pullTemplate` message type + `PullTemplateData` to
  all three mirrors (`agent-protocol.json` / `.ts` / `AgentProtocol.cs`).

## v0.3.16 â€” 2026-06-02 â€” Visualiser debug-window / full-editor toggles + 600s start timeout

### Added

- **Visualiser debug-window toggle** and **full-editor toggle** in the agent tray Settings form and the agent web UI. Both are live-applied â€” read at visualiser job launch, so no agent restart is required. Full-editor (open the full Unreal Editor GUI on the workstation alongside the browser stream) supersedes the debug-window (visible headless UE window). Backed by `AgentControlPlane.SetVisualiserDebugWindowAsync` / `SetVisualiserFullEditorAsync` and new `ConfigUpdate` fields (`VisualiserDebugWindow`, `VisualiserFullEditor`, `VisualiserTemplateProjectPath`).

### Changed

- **`VISUALISER_START_TIMEOUT_MS` default 180000 â†’ 600000** (server `.env.example` + `infra/docker-compose.yml` + OpenAPI doc) to cover a cold full-editor first-open (Unreal Editor + shader compile + DDC build on a freshly-cached C++ template). Lean `-game` runs still connect in ~60â€“90s; this only raises the upper bound before a run is failed.

### Included from main (now tagged)

- **Multi-viewer `Visualiser/SignallingBridge.cs` per-viewer demux** (commit `0daf284`) â€” opens one local Cirrus/Wilbur WS **per browser viewer** so multiple peers per run are demuxed independently (fixes the 2nd-viewer-freezes-1st bug). Previously hot-patched on PC01 and reported as `v0.3.15`; **v0.3.16 is the first tagged agent build that carries it.** Server-train multi-viewer notes remain under **Unreleased â†’ Visualiser multi-viewer** (server ships as a rolling `main` deploy, not tagged).

## v0.3.15 â€” 2026-06-01 â€” Hardened in-app updater (locked-DLL update failures)

### Fixed

- **In-app updater** now stops every lingering `PRISM.Agent.exe` / `prism-visualiser.exe` / `UnrealEditor*` holder before extracting, then retries `Expand-Archive` with backoff (5 attempts). Previously the updater waited only for the single spawning agent PID; a second agent instance (a scheduled-task relaunch race) or a live orchestrator/UE child kept install DLLs memory-mapped, so the first locked file (e.g. `Accessibility.dll`) aborted the whole update with "Access to the path â€¦ is denied" (observed updating RB-DA2-PC01 to v0.3.14).

### Notes

- Bundles PRISM Visualiser orchestrator **v0.5.14** (deterministic `.uproject` selection).

## v0.3.14 â€” 2026-06-01 â€” Rebundle orchestrator v0.5.14 (deterministic .uproject selection)

- Agent runtime unchanged from v0.3.13; rebuilt to bundle orchestrator **v0.5.14**, which deterministically picks `<TemplateName>.uproject` â€” fixing a stale `MyProject.uproject` shadowing `REBUS_Visualiser.uproject` and causing `ue_game_start_timeout` / no PixelStreaming2.

## v0.3.13 â€” 2026-05-29 â€” Persist the imported mesh to disk (game launch couldn't find it)

> **Follow-up to v0.3.12.** v0.3.12 spawned the mesh cleanly and reached
> `PRISM_VISUALISER_READY` (assetCount=1, real bounds, framing camera
> off-origin), but the Phase F `-game` launch logged `LoadErrors: ...
> dependent package .../scene/StaticMeshes/scene ... does not exist on
> disk` â€” the level referenced a mesh package that was never flushed.

### Root cause

Interchange imports the `StaticMesh` into an in-memory package under the
commandlet; `_save_current_level()` saves only the map, not the asset, so
the game process can't load the geometry.

### Fixed

- **`import_orbit.py(.in)`** â€” `_save_imported_assets()` flushes the imported
  asset directory to disk (`save_directory(TARGET_FOLDER, only_if_is_dirty=False, recursive=True)`)
  before saving the level. See `visualiser/CHANGELOG.md` v0.5.11.

## v0.3.12 â€” 2026-05-29 â€” Headless-safe mesh spawn (object-spawn helper crashed UE)

> **Follow-up to v0.3.11.** v0.3.11's discovery worked (`discovered 1 static
> mesh asset(s)` on PC01), but spawning that mesh crashed UE with
> `EXCEPTION_ACCESS_VIOLATION reading 0x40` in EditorFramework â†’
> `RequestExitWithStatus(1, 3)` (the `exit=3` surfaced as
> `ue_import_failed`).

### Root cause

`_spawn_meshes_into_level()` used `EditorActorSubsystem.spawn_actor_from_object(mesh, â€¦)`,
whose editor selection / component-visualizer notifications deref null under
the headless `-NullRHI` PythonScript commandlet. Never hit before because
every prior run discovered zero meshes; the spawn body never executed.

### Fixed

- **`import_orbit.py(.in)`** â€” spawn a plain `StaticMeshActor` via the
  class-spawn path (the same one the lights use cleanly) and assign the mesh
  to its `StaticMeshComponent` with `set_static_mesh()`, instead of
  `spawn_actor_from_object`. See `visualiser/CHANGELOG.md` v0.5.10.

## v0.3.11 â€” 2026-05-29 â€” Spawn the imported geometry (model was missing from the lit scene)

> **Follow-up to v0.3.10.** v0.3.10 lit and framed the level and the PC01
> run confirmed it: no `NO PLAYERSTART` warning, Directional/Sky lights
> spawned, streamer reached Active. But `PRISM_VISUALISER_READY` reported
> **`assetCount: 0`** â€” the imported model never made it into the level, so
> the stream showed a lit-but-empty world instead of the geometry.

### Root cause

`InterchangeManager.import_asset(...)` on UE 5.7 returns a **results
container**, not the array of created assets, so the import driver saw zero
`StaticMesh`es and spawned no geometry â€” even though Interchange logged
`import completed` and the staged glTF carried `meshes=1`. Pre-existing
(same `assetCount: 0` in the v0.3.9 logs), only made visible once v0.3.10
lit the scene.

### Fixed

- **`import_orbit.py(.in)`** â€” after import, when the return value yields no
  meshes, force an `AssetRegistry` synchronous scan of the destination
  folder and **enumerate the `StaticMesh` assets Interchange actually
  wrote**, then spawn / bound / frame those. `assetCount` and the
  `imported bounds â€¦ meshes=N` log now reflect the real geometry. Fully
  model-agnostic; the asset-array return path is still preferred when a UE
  build provides it. See `visualiser/CHANGELOG.md` v0.5.9 for detail.

## v0.3.10 â€” 2026-05-29 â€” Light + frame the imported scene so the stream isn't black

> **Fixes the v0.3.9 PC01 symptom: Pixel Streaming reached a fully
> healthy state (streamer registered with Wilbur, browser connected,
> WebRTC offer/answer done, video+audio tracks `State=[Active]`, data
> channel live) but the admin player page showed a SOLID BLACK viewport.
> Transport was fine â€” the rendered scene was black.**

### Root cause

`import_orbit.py` built the streamed `Imported_<runId>` map with
`LevelEditorSubsystem.new_level()`, which produces a **blank** UE level:
no lights, no sky, no post-process, no PlayerStart, no camera. Meshes
were spawned at the world origin and the level saved. The `-game` launch
streams the default player camera, which spawns at world origin facing
the default direction into an unlit void â†’ every frame is black even
though the encoder + WebRTC tracks are live. UE also logged
`FindPlayerStart: PATHS NOT DEFINED or NO PLAYERSTART with positive
rating`. Both **lighting** and **camera framing** were missing.

### Fixed

- **`visualiser` â†’ `import_orbit.py(.in)`** now, after import, computes
  the imported geometry bounds, spawns a Directional Light + Sky Light +
  Sky Atmosphere (UE "Basic" daylight set), an unbound PostProcessVolume
  with auto-exposure clamped (anti-black-crush safety net), a framing
  `CameraActor` (auto-activated for player 0, so the streamed `-game`
  view uses it) positioned at an orbit distance from the bounds centre,
  and a coincident `APlayerStart` (eliminates the `NO PLAYERSTART`
  warning and frames the default pawn on the model). Framing is driven
  by the computed bounds â€” model-agnostic, nothing hardcoded. See
  `visualiser/CHANGELOG.md::v0.5.8` for the full breakdown.

Ships as visualiser-v0.5.8 (orchestrator EXE + bundled python templates).
The v0.3.9 streamer-connected fix is untouched.

## v0.3.9 â€” 2026-05-29 â€” Recognise UE 5.7 / Wilbur "streamer registered" log shapes

> **Removes the `ue_game_start_timeout` 120 s timeout the v0.3.8 PC01
> run hit at Phase F. UE successfully connected to Wilbur and the
> handshake completed within ~23 s, but the orchestrator's regex was
> still the legacy-Cirrus `Streamer connected: orbit_<id>` shape
> from PS1 â€” none of the four UE 5.7 / Wilbur registration signals
> matched it, so the watcher never observed the registration and
> failed open. v0.3.9 swaps in a multi-pattern matcher covering all
> four shapes plus the legacy fallback.**

See `visualiser/CHANGELOG.md::v0.5.7` for the full details. In short:

### Changed

- **`visualiser/src/PRISM.Visualiser.Orchestrator/PixelStreaming/SignallingSupervisor.cs`**
  â€” replaced the single `StreamerConnectedPattern` regex with
  `StreamerConnectedPatterns`, an ordered list of named regex
  patterns (`OnJoined` canonical / `OnJoined` minimal /
  `PlayerJoined` / `EndpointIdConfirm` / `EndpointId` /
  `LegacyCirrus`). `TryParseStreamerConnected` now reports both the
  captured streamer id AND the name of the pattern that fired, so
  the diagnostic log line attributes the event to a specific Wilbur
  / UE shape.
- **`visualiser/src/PRISM.Visualiser.Orchestrator/Unreal/UnrealLauncher.cs`**
  â€” `LaunchGameMode` now also copies UE -game stdout/stderr lines
  into a `Channel<string>` exposed via `UnrealGameHandle.Lines`. The
  canonical `LogPixelStreaming2EpicRtc:
  RoomSignallingContextObserver::OnJoined` event lives only on UE's
  own stdout; without this plumb-through the orchestrator was deaf
  to the canonical signal even after the regex was fixed.
- **`visualiser/src/PRISM.Visualiser.Orchestrator/Pipeline/VisualiserPipeline.cs::WaitForStreamerConnectedAsync`**
  merges Wilbur + UE line channels via a new `MergeChannelLines`
  fan-in helper and feeds the merged stream to
  `SignallingSupervisor.AwaitStreamerConnectedAsync`. Emits a
  one-line diagnostic the moment the watcher fires:
  `phase-f: streamer registered (matched <pattern-name>)
  elapsed=<X.X>s`. The `StartStreamingAsync` follow-up log carries
  both the matched pattern name and the captured id.

### Tests

- `tests/PRISM.Visualiser.Orchestrator.Tests/SignallingSupervisorTests.cs`
  â€” comprehensive theory covering all five named patterns + a
  negative-cases theory rejecting pre-handshake Wilbur noise and
  malformed UE telemetry. Two new async tests pin the front-of-list
  ordering: `OnJoined` wins when the exact PC01 v0.3.8 log replay
  fires, `EndpointId` wins when only Wilbur-side lines are
  available.

## v0.3.8 â€” 2026-05-28 â€” Auto-bootstrap PixelStreaming2 / Wilbur (UE 5.5+) on first run

> **Removes the `signalling_not_found` hard-stop the v0.3.7 PC01 run
> hit at Phase F. UE 5.5+ ships the PixelStreaming2 C++ plugin with
> every launcher install, but the Node.js + TypeScript signalling
> server ("Wilbur") is fetch-on-demand via the engine's
> `Resources\WebServers\get_ps_servers.bat` helper. Until that helper
> ran once the `SignallingWebServer\` tree was empty and the
> orchestrator surfaced a manual-remediation error. The orchestrator
> now runs the helper itself and falls through to a clean Phase F.**

See `visualiser/CHANGELOG.md::v0.5.6` for the full details. In short:

### Added

- **`visualiser/src/PRISM.Visualiser.Orchestrator/PixelStreaming/SignallingBootstrap.cs`**
  â€” new first-run installer that probes for
  `Engine\Plugins\Media\PixelStreaming2\Resources\WebServers\SignallingWebServer\dist\index.js`,
  and when absent runs `get_ps_servers.bat` (downloads the
  EpicGamesExt/PixelStreamingInfrastructure sources) followed by
  `SignallingWebServer\platform_scripts\cmd\start.bat` (downloads
  Node.js, runs `npm install` across the workspace, compiles the
  TypeScript packages, then briefly starts wilbur â€” killed by the
  bootstrap the moment it logs a listening line). All stdout / stderr
  is forwarded to Serilog under the `ps-bootstrap` channel so the
  full ~1-3 min install transcript is captured in the agent log.
- **`SignallingBootstrap`** writes a marker under
  `%LOCALAPPDATA%\PRISM.Visualiser\state\signalling_ready_<sha>.flag`
  per UE-root SHA. The canonical readiness check is still a disk
  probe of `dist\index.js`; the marker is informational.

### Changed

- **`Pipeline/VisualiserPipeline.cs::StartStreamingAsync`** â€” Phase F
  now calls `SignallingBootstrap.EnsureReadyAsync(install)` before
  `SignallingSupervisor.Resolve`. On already-built engines the
  bootstrap is a single `File.Exists` check and returns
  `AlreadyReady` immediately.
- **`PixelStreaming/SignallingSupervisor.cs`** â€” `Resolve` now
  prefers `SignallingWebServer\dist\index.js` (Wilbur, UE 5.5+) over
  the legacy top-level Cirrus candidates and surfaces the probed
  paths via `SignallingResolveResult.ProbedPaths` so a future
  `signalling_not_found` error message can name the files it
  actually looked at. The bundled Node binary resolution now prefers
  the wilbur-shipped Node under
  `SignallingWebServer\platform_scripts\cmd\node\node.exe` over the
  legacy `Engine\Binaries\ThirdParty\Node\Win64\node.exe`.
- **`PixelStreaming/SignallingSupervisor.cs::BuildStartInfo`** â€” emits
  wilbur's `commander`-style CLI shape
  (`--player_port=N --streamer_port=M --serve --console_messages
  verbose --log_config`) when the resolved script is wilbur; falls
  back to legacy Cirrus `--HttpPort=N` for pre-5.5 plugin variants.
- **`PixelStreaming/SignallingSupervisor.cs`** â€” ready-line + streamer-
  connected regexes now also match Wilbur log shapes
  (`Listening on :N`, `HTTP webserver listening on port N`,
  `Streamer registered with id orbit_xxx`).
- **`Pipeline/VisualiserPipeline.cs`** â€” allocates two distinct
  loopback TCP ports for Wilbur (player + streamer) so UE's
  `-PixelStreamingURL=ws://127.0.0.1:<streamer_port>` points at the
  right port. Legacy Cirrus still gets one port.
- **`PixelStreaming/SignallingHandle`** + **`PixelStreamingSession`**
  â€” both expose `PlayerPort` and `StreamerPort` separately. The
  player-facing port (the one surfaced as `PlayerUrl` / `SignallingUrl`
  to the agent) keeps the legacy `TcpPort` alias.
- **`Models/FailedEvent.cs`** â€” adds
  `signalling_bootstrap_failed` for the new auto-bootstrap failure
  mode (network outage, npm install failure, `get_ps_servers.bat`
  missing â€” i.e. a partially-installed PixelStreaming2 plugin).
  Existing `signalling_not_found` error message now also names the
  probed file paths so the next operator failure is debuggable
  without going back to source.

### Notes

- Closes [#25](https://github.com/REBUS-ORBIT/prism/issues/25).
- The orbit-ue-template's `.uproject` was already correctly
  declaring `"PixelStreaming2": { "Enabled": true }` (`v0.1.0-ue5.7-scaffold`),
  so no template repo bump was needed. Option B from the original
  investigation directive was a no-op.
- Bootstrap cost on a fresh PC01-class workstation: ~30 s for the
  `get_ps_servers.bat` clone (â‰ˆ12 MB), then 60-180 s for the
  `start.bat` Node.js download (â‰ˆ30 MB) + npm install (â‰ˆ150 MB) +
  TypeScript compile. Steady-state cost: one `File.Exists` probe.
  Total disk footprint after bootstrap: ~250 MB inside the UE plugin
  tree (not duplicated under `%LOCALAPPDATA%`).
- The bootstrap probes `start.bat` for the first listening line and
  kills the process tree â€” the build artefacts (`dist/`, `node/`,
  `node_modules/`) survive the kill, so subsequent Phase F runs can
  launch wilbur directly via the supervisor without going through
  start.bat again.

## v0.3.7 â€” 2026-05-28 â€” Fix orchestrator missing UE marker because of `[ts][ch]LogPython:` prefix

> **Fixes the visualiser run still reporting `ue_import_failed: UE
> exited without a ready marker (exit=0)` even though v0.3.6's UE log
> shows the import completing cleanly and Python emitting
> `PRISM_VISUALISER_READY {...}`. The orchestrator's stdout marker
> parser was column-zero anchored and missed the prefix UE puts on
> Python stdout when launched with `-stdout -FullStdOutLogOutput`.**

See `visualiser/CHANGELOG.md::v0.5.5` for the full details. In short:

### Fixed

- **`visualiser/src/PRISM.Visualiser.Orchestrator/Unreal/UnrealLauncher.cs`**
  â€” `ParseLine` and `ParseMvrLine` now use a shared `TryFindMarker`
  helper that locates the marker substring anywhere in the line via
  `IndexOf` instead of `StartsWith`. This lets the orchestrator
  recognise marker emissions even when UE prefixes them with the
  `[2026.05.28-12.13.40:178][  0]LogPython:` log header that
  `-stdout -FullStdOutLogOutput` produces under
  `PythonScriptCommandlet`. Affects all four marker prefixes
  (`PRISM_VISUALISER_READY`, `PRISM_VISUALISER_ERROR`,
  `PRISM_VISUALISER_MVR_READY`, `PRISM_VISUALISER_MVR_ERROR`).
- **`visualiser/tests/PRISM.Visualiser.Orchestrator.Tests/MvrGdtfDetectorTests.cs`**
  â€” added regression tests covering both the column-zero shape (still
  works) and the UE-prefixed shape (the v0.3.6 PC01 capture). Plus
  direct unit tests on the new `TryFindMarker` helper.

### Notes

- Closes [#23](https://github.com/REBUS-ORBIT/prism/issues/23).
- v0.3.5 fixed the commandlet flag (`-ExecutePythonScript` â†’
  `-script`); v0.3.6 fixed the Interchange API drift; v0.3.7 fixes
  the marker-parsing gap that was hiding the now-clean import behind
  a misleading "no marker" failure code. Failure-mode progression so
  far: `exit=-1` (no commandlet) â†’ `exit=3` (Interchange/Slate gap)
  â†’ `exit=0 + no marker` (parse miss) â†’ expected next is either
  `ready/v1` end-to-end or a Phase F (Pixel Streaming) bring-up
  failure now that Phase E is fully wired.
- No agent-side C# logic changes outside the version bump; the
  orchestrator DLL ships inside the agent MSI so the v0.3.7 agent
  release picks up the fix transparently.

## v0.3.6 â€” 2026-05-28 â€” Fix UE 5.7 Interchange API drift + drop Slate-bound AssetImportTask fallback

> **Fixes the visualiser run failing at the import phase with UE
> exit code 3 after v0.3.5 unblocked the commandlet. Two cascading
> bugs in `import_orbit.py.in`, both previously masked by the v0.3.5
> commandlet flag bug because the script never started.**

See `visualiser/CHANGELOG.md::v0.5.4` for the full details. In short:

### Fixed

- **`Unreal/PythonScripts/import_orbit.py.in`** â€” switched the
  Interchange singleton accessor from the pre-5.5
  `unreal.InterchangeManager.get_interchange_manager()` (removed in UE
  5.7, surfaced as `AttributeError: type object 'InterchangeManager'
  has no attribute 'get_interchange_manager'`) to the canonical 5.5+
  name `get_interchange_manager_scripted()`. The legacy name is kept
  as a best-effort fallback for older 5.x point releases.
- **`Unreal/PythonScripts/import_orbit.py.in`** â€” `import_asset` is
  now called with the correct UE 5.5+ signature
  `import_asset(content_path, source_data, import_asset_parameters)`:
  source data is built explicitly via
  `unreal.InterchangeManager.create_source_data(file_name)` and the
  destination content path is passed as the FIRST positional argument
  rather than as a non-existent field on `ImportAssetParameters`. The
  speculative `import_asset_with_params` branch is gone â€” that method
  was never present on the 5.5+ binding.
- **`Unreal/PythonScripts/import_orbit.py.in`** â€” dropped the
  `AssetImportTask` fallback path (`_import_via_asset_task`). The
  fallback was Slate-bound: `AssetImportTask` routes through the
  import-settings dialog even with `automated=True`, and Slate is
  NOT initialised when the editor runs as `PythonScriptCommandlet`
  under `-NullRHI`. Hitting the fallback crashed UE on
  `Assertion failed: CurrentApplication.IsValid()
  [SlateApplication.h:321]` and the commandlet exited with code 3.
  Any Interchange failure now bubbles up to the existing
  `_emit_error("import_failed", ...)` path, which is the correct
  surface for the orchestrator's structured `failed/v1` event.
- **`Unreal/PythonScripts/import_orbit.py`** â€” the lintable twin is
  kept in sync with the `.py.in` template so artists who lint the
  script outside the UE editor see the same body.

### Notes

- Closes [#21](https://github.com/REBUS-ORBIT/prism/issues/21).
- v0.3.5 fixed the commandlet flag (`-ExecutePythonScript` â†’
  `-script`) so the python script starts; v0.3.6 fixes the very
  next failure mode the script hits when it does. Failure-mode
  progression so far: `exit=-1` (no commandlet)
  â†’ `exit=3` (commandlet ran, hit Interchange/Slate gap)
  â†’ expected next is either `ready/v1` end-to-end or a Phase F
  bring-up failure now that import lands.
- No agent / orchestrator C# changes â€” the UE invocation,
  ready-marker contract, and Cirrus signalling supervisor are
  untouched. Server image is unchanged at the v0.3.5 build.

## v0.3.5 â€” 2026-05-28 â€” Fix `-ExecutePythonScript` rejected by UE commandlet

> **Fixes the visualiser run failing at the import phase with
> `LogEditorPythonExecuter: Error: -ExecutePythonScript cannot be used by a
> commandlet. Use -run=PythonScript instead?` and the orchestrator timing out
> at the 180 s ready-marker poll (`exit=-1 / no ready marker`).**

### Fixed

- **Visualiser orchestrator** (`Unreal/UnrealLauncher.cs`,
  `BuildStartInfoCore` + `BuildMvrStartInfoCore`): the commandlet
  invocation for the Phase E (glTF) and Phase J (MVR/GDTF) import passes
  combined `-run=PythonScript` with `-ExecutePythonScript=<path>`. UE 5.7
  enters `PythonScriptCommandlet` mode whenever `-run=PythonScript` is on
  the command line, and that commandlet only accepts `-script=<path>` â€”
  `-ExecutePythonScript` is the editor-startup (non-commandlet) form and
  the commandlet explicitly rejects it at startup with the
  `LogEditorPythonExecuter: Error:` line above. The result was that
  `import_orbit.py` (and `import_mvr.py`) never ran, the Python
  `PRISM_VISUALISER_READY` marker never emitted, and the orchestrator
  timed out and reported `failed { code: "no_marker", exit: -1 }`. Both
  call sites now emit `-run=PythonScript -script="<absolute/path>"` per
  the canonical UE 5.7 PythonScriptCommandlet docs.

### Notes

- The streaming (Phase F) launch path (`BuildGameStartInfoCore` /
  `LaunchGameMode`) was already correct â€” it never passes `-run=` or
  `-NullRHI` and uses the `-game -RenderOffScreen -PixelStreamingURL=â€¦`
  PS2 form, so the D3D12 RHI + NVENC pipeline lights up normally once
  the import phase succeeds.
- No changes to the orchestrator/agent protocol, the ready-marker
  contract, the Cirrus signalling supervisor, or the v0.3.4 ORBIT API
  fixes (`HttpOrbitApi.cs`).
- The user-visible UE log signature for v0.3.5 should be:
  `[VisualiserJob] orchestrator stderr â€¦ -run=PythonScript -script=â€¦`
  followed by `LogPython: â€¦` and (in Phase F) `LogPixelStreaming2:
  Streamer started`.

---

## v0.3.4 â€” 2026-05-28 â€” Fix `scaffold_failed: 404 on version REST endpoint`

> **Fixes `scaffold_failed: GET api/v1/projects/.../versions/... failed with HTTP 404`
> when the visualiser orchestrator tries to fetch version metadata from ORBIT.**

### Fixed

- **Visualiser orchestrator** (`OrbitApi/HttpOrbitApi.cs`): the orchestrator was
  calling `GET /api/v1/projects/{projectId}/versions/{versionId}` to resolve a
  version's root object id. This REST endpoint does not exist in the ORBIT server
  (which is GraphQL-first). The call now uses the ORBIT GraphQL endpoint
  (`POST /graphql` with `query Version { project { version { referencedObject â€¦ } } }`)
  which returns the same data correctly.
- **Orchestrator object endpoint** (`EndpointTemplates.Object`): corrected from
  `api/v1/projects/{0}/objects/{1}` to `objects/{0}/{1}/single` (the actual Speckle
  object REST API path served by the ORBIT server).
- **Orchestrator blob endpoint** (`EndpointTemplates.Blob`): corrected from
  `api/v1/projects/{0}/blobs/{1}` to `blobs/{0}/{1}` (verified against live ORBIT).

These three paths were all placeholders from the initial scaffold that were never
reconciled against the live ORBIT server API. The version endpoint fix is the
primary blocker; the object and blob path fixes prevent the next 404s in the pipeline.

- **Blob integrity check removed** (`OrbitApi/BlobDownloader.cs`): the post-download
  SHA256 hash check was comparing the ORBIT blob id (a 10-char server-assigned string)
  against the SHA256 of the downloaded bytes â€” guaranteed never to match. Since ORBIT
  blob ids are opaque server identifiers, the integrity check is removed; the server id
  is the authoritative content address and is used as the cache key directly.

---

## v0.3.3 â€” 2026-05-28 â€” Fix `scaffold_failed: versionId empty string`

> **Fixes `scaffold_failed: The value cannot be an empty string or composed entirely
> of whitespace. (Parameter 'versionId')` when starting a visualiser stream without
> supplying an explicit version id.**

### Fixed

- **Server dispatcher** (`jobs/dispatcher.ts`): when `versionId` is omitted from
  `POST /api/visualiser/streams` (the "use latest" intent documented in the
  protocol contract), the dispatcher now calls the ORBIT GraphQL API
  (`project.model.versions(limit:1)`) to resolve the latest version id before
  sending `startVisualisation` to the agent. The resolved id is also written
  back to the `visualiser_runs` row so the admin UI shows the real version.
  If the model has no versions yet, dispatch fails immediately with a
  `misconfigured` error rather than letting the orchestrator crash with an
  opaque exception. New helper: `getLatestVersionId` in `orbit/client.ts`.
- **Agent** (`VisualiserJob.cs`): added a defensive early-return when
  `data.VersionId` is null or whitespace. Rather than passing `""` to
  `--version` (which the orchestrator accepts syntactically but then fails
  deep inside `OrbitReceivePipeline.ReceiveAsync` with `ArgumentException`),
  the agent now emits a `visualisationFailed` envelope immediately with a
  clear message: "versionId is required but was not providedâ€¦". This turns an
  opaque `scaffold_failed` into a user-readable failure on older server builds.

### Root cause chain (for the record)

1. Admin UI / portal sends `POST /api/visualiser/streams` without `versionId`.
2. Server stores `versionId: null` in DB; dispatcher sends `versionId: undefined`
   in the `startVisualisation` envelope.
3. Agent's `VisualiserJob.StartAsync` builds CLI args as
   `"--version", data.VersionId ?? string.Empty` â†’ passes `""` to the orchestrator.
4. System.CommandLine accepts `--version ""` as valid (an argument was supplied).
5. Orchestrator calls `OrbitReceivePipeline.ReceiveAsync(projectId, versionId: "")`.
6. `ArgumentException.ThrowIfNullOrWhiteSpace(versionId)` throws â†’
   caught by the generic `receive+stage` handler â†’ `scaffold_failed` event.

---

## v0.3.2 â€” 2026-05-27 â€” Orchestrator UE pre-flight diagnostics + path hardening

> **Fixes the `ue_root_not_found` failure on PC01 that blocked the first
> live `startVisualisation` end-to-end test.** Root cause was a
> combination of (a) the agent reading a UTF-8 BOM at the start of the
> `unrealEngineRoot` value out of `agent-config.json` and forwarding
> the BOM-prefixed string into the orchestrator's
> `UNREAL_ENGINE_ROOT` env var, and (b) the orchestrator's
> `UnrealEnvironment.TryResolve` doing a bare `Directory.Exists(root)`
> without stripping wrapping whitespace / trailing separators / mixed
> path separators. Either condition alone is enough for the probe to
> miss a perfectly good UE install. The pre-flight error message also
> told operators nothing actionable â€” "env var is set but does not
> point at a valid UE 5.7 install" with zero detail about which probe
> ran, what value was tried, or which file was missing.

### Fixed

- **Orchestrator â€” `UnrealEnvironment.NormalizeRoot`** now strips
  leading/trailing whitespace, BOM (`\uFEFF`), zero-width
  spaces/joiners (`\u200B`/`\u200C`/`\u200D`), and trailing directory
  separators before resolving via `Path.GetFullPath`. Interior
  whitespace is preserved â€” Windows paths legitimately contain spaces
  (`C:\Program Files`), so a blanket whitespace filter would mangle
  the value. The canonical form is used for every subsequent
  `Directory.Exists` / `File.Exists` check.
- **Orchestrator â€” `UnrealEnvironment.ResolveDetailed`** is a new
  diagnostic API that returns per-probe outcomes
  (`UnrealProbeOutcome`) alongside the resolved install. Each outcome
  captures the source (EnvironmentVariable / DefaultPath / Registry),
  the raw + normalized roots, directory existence, expected editor
  path, editor existence, and a human-readable failure reason. The
  legacy `TryResolve` is preserved as a thin wrapper.
- **Orchestrator â€” `Program.RunPhaseFAsync`** now logs every probe
  outcome (Information for the match, Warning for each miss) and folds
  the diagnostics into the `failed/v1` event's message field. Operators
  reading the agent log can now see at a glance whether the directory
  was wrong, missing, or just lacked the editor binary instead of the
  opaque "env var is set but invalid" string.
- **Agent â€” `VisualiserJob`** now normalizes the `UnrealEngineRoot`
  config value (same BOM/whitespace strip as the orchestrator, minus
  the `Path.GetFullPath` step â€” the agent runs as a service and we
  don't want it resolving relative paths against
  `%ProgramFiles%\PRISM.Agent`) before assigning to the child
  process's `UNREAL_ENGINE_ROOT` env var. Logs both raw and
  normalized forms so future field reports include the exact value
  the orchestrator saw.
- **Agent â€” `AgentConfig.Load`** now reads the config file as raw
  bytes and explicitly strips a UTF-8 BOM preamble before deserializing,
  then runs every path-like property through `SanitizePathLike`. The
  System.Text.Json parser tolerates document-level BOMs but the BOM
  byte can survive inside string scalars in some edge cases, and the
  Windows Notepad / `Set-Content` round-trip is the classic way for
  one to sneak in.

### Added

- **Tests â€” `UnrealEnvironmentTests`** gained 9 new cases covering
  trailing-backslash roots, BOM-prefixed roots, forward-slash roots,
  diagnostic population on missing directory, diagnostic population
  on partial install (dir exists but editor missing), and the
  `NormalizeRoot` edge cases (empty string, whitespace-only,
  invisible-only, interior whitespace preservation).
- **Tests â€” `VisualiserJobTests`** gained `NormalizeUnrealRoot` cases
  covering BOM, zero-width space, leading/trailing whitespace, empty
  input, and the happy path that preserves the trailing separator
  (which is the orchestrator's job to strip, not the agent's).

### Operations

- New `ue_root_not_found` failed events now include the failing probe
  trace inline, e.g.:
  ```
  ue_root_not_found: UNREAL_ENGINE_ROOT is set but does not point at a
  valid UE 5.7 install. | [EnvironmentVariable] raw=C:\Wrong\Path
  normalized=C:\Wrong\Path â€” directory does not exist: C:\Wrong\Path |
  [DefaultPath] path=C:\Program Files\Epic Games\UE_5.7 â€” directory
  does not exist: C:\Program Files\Epic Games\UE_5.7 | [Registry]
  path=<unset> â€” HKLM\SOFTWARE\EpicGames\Unreal Engine\5.7\InstalledDirectory not present
  ```
- The same trace also lands in the per-run orchestrator log at
  `%LOCALAPPDATA%\PRISM.Visualiser\runs\<runId>\logs\orchestrator.log`
  with structured fields.

## v0.3.1 â€” 2026-05-27 â€” Tray menu: Visualiser role checkbox

- **Agent â€” Tray context menu** now includes a `Visualiser` role checkbox
  alongside the existing Conversion, Layering, and Receive items.  Reads its
  initial checked state from `agent-config.json` on startup, toggles
  `AgentConfig.Roles` and persists via `SetRolesAsync` (same pattern as the
  other role checkboxes), and refreshes on every `ContextMenuStrip.Opening`
  event so the menu always reflects the latest config.

## v0.3.0 â€” 2026-05-27 â€” Visualiser agent integration: agent now actually spawns the orchestrator

> **The fix for the missing agent â†” orchestrator glue.** Through the
> v0.2.x line, the agent's `startVisualisation` WS handler was still the
> Phase A scaffold stub from v0.1.37 â€” it logged a warning and acked
> `accepted: false` with reason `"visualiser orchestrator not yet
> implemented"`. The Phase B/C/E/F/J orchestrator builds shipped as a
> standalone `PRISM.Visualiser.Orchestrator.exe` release artefact
> (`REBUS-ORBIT/prism-visualiser`), but no one ever wrote the
> agent-side `VisualiserJob` that spawns it. v0.3.0 ships that
> integration, bundles the orchestrator into the agent installer as a
> sidecar, and ends the "phase A scaffold" stub.

### Added

- **Agent â€” `VisualiserJob`** (`agent/src/PRISM.Agent/Pipeline/VisualiserJob.cs`,
  new): owns the lifecycle of a single `prism-visualiser.exe` child
  process (the orchestrator csproj's `<AssemblyName>` is
  `prism-visualiser`, not its project filename) spawned in response
  to a `startVisualisation` envelope. Resolves the orchestrator EXE on
  disk (env-var override â†’ agent-config override â†’ `{InstallDir}\Visualiser\
  prism-visualiser.exe` â†’ legacy `PRISM.Visualiser.Orchestrator.exe`
  fallback â†’ conventional Program Files), derives the orchestrator's
  `--server prod|dev` selector
  from the `orbitServerUrl` host (anything matching `orbit-dev` â†’ dev,
  else prod), and forwards the `orbitToken` to the child as the
  matching `ORBIT_PAT_PROD` / `ORBIT_PAT_DEV` env var. Spawns the
  orchestrator with `stream --project <id> --model <id> --version
  <id> --run-id <uuid> --signalling-port-hint <int> --json` and pumps
  stdout line-by-line. For each `prism-visualiser/ready/v1` line with
  `status=ready` it (1) registers the orchestrator's local Cirrus URL
  with `SignallingBridgeRegistry` so subsequent `signallingFrame`
  envelopes from the server land on the right socket, and
  (2) forwards a `visualisationReady` envelope upstream carrying the
  local `signallingUrl` + `streamerId`. For each
  `prism-visualiser/failed/v1` line (or a `ready/v1` with
  `status=failed`) it forwards a `visualisationFailed` envelope.
  Process exit drops the signalling bridge and emits a terminal
  envelope: `visualisationEnded` after a successful ready, or
  `visualisationFailed` if the orchestrator died before reporting
  ready. `RequestCancel` kills the process tree (`Kill(entireProcessTree:
  true)` propagates to UE + Cirrus via the orchestrator's own
  `JobObject`). The stderr pump is wired straight into the agent's
  Serilog channel so UE / Python / Cirrus errors surface in the
  agent log without separate plumbing.
- **Agent â€” `VisualiserRunRegistry`** (`agent/src/PRISM.Agent/Visualiser/VisualiserRunRegistry.cs`,
  new): per-process map of active `VisualiserJob` instances keyed by
  `runId`. `TryStart` reserves a slot atomically (refuses duplicates
  + enforces `VisualiserMaxConcurrent` as a defensive in-agent cap
  on top of the server-side dispatch gate). `TryCancel` finds the
  active job by `runId` and calls `RequestCancel`. `DisposeAsync`
  fires `RequestCancel` for every active run on agent shutdown so a
  `taskkill /IM PRISM.Agent.exe` doesn't leave orphaned UE / Cirrus
  processes behind.
- **Agent â€” `AgentConfig.VisualiserOrchestratorPath`**
  (`agent/src/PRISM.Agent/Config/AgentConfig.cs`): optional absolute
  path to the orchestrator EXE. Takes precedence over the on-disk
  probe order. Intended for dev / smoke-test workflows where the
  agent is running from a build folder and the orchestrator lives
  somewhere else; the production installer leaves this null and the
  bundled-sidecar path resolves.
- **CI â€” `agent.yml` bundles the orchestrator into the installer
  payload** (`.github/workflows/agent.yml`): new
  `Restore + publish Visualiser orchestrator` step runs
  `dotnet publish` against `visualiser/PRISM.Visualiser.sln` with
  `--self-contained true` (so the agent installer no longer requires
  a system-wide .NET 8 install on the workstation) and the
  staging step copies the publish dir to `stage/Visualiser/` before
  the Inno Setup wizard packages everything. Inno Setup already used
  `recursesubdirs` for the payload glob, so the bundled orchestrator
  installs to `{app}\Visualiser\PRISM.Visualiser.Orchestrator.exe`
  automatically. The stage step now hard-fails the build if the
  orchestrator EXE is missing from the payload â€” releases without
  the sidecar are no longer possible. Adds ~70 MB to the agent
  installer.

### Changed

- **Agent â€” `AgentMessageDispatcher.HandleStartVisualisation` is no
  longer a stub** (`agent/src/PRISM.Agent/Ws/AgentMessageDispatcher.cs`).
  The handler now resolves a `VisualiserJob` from DI via
  `VisualiserRunRegistry.TryStart`, acks `accepted: true`, and
  spawns the orchestrator in the background. Duplicate runIds and
  cap-exhausted requests still ack-reject (`accepted: false` with
  reason `"visualiser slot unavailable"`).
- **Agent â€” `HandleCancelVisualisation` actually cancels** the
  registered run by looking it up in `VisualiserRunRegistry` and
  calling `RequestCancel`. Unknown runIds (e.g. a
  `cancelVisualisation` from the server's `start_timeout` path that
  arrives after the orchestrator already exited) ack `accepted: true`
  with reason `"no active run for this runId"` so the server's WS
  handler doesn't flag the agent as misbehaving.

### Operational notes

- The orchestrator's existing standalone release pipeline
  (`visualiser-msi.yml` â†’ `REBUS-ORBIT/prism-visualiser`) is
  unchanged. The standalone artefact remains framework-dependent
  (`--self-contained false`) and is the right binary for out-of-band
  installs on workstations that already have .NET 8 installed
  system-wide. The agent-bundled copy is self-contained for
  workstations that don't.
- After installing the v0.3.0 agent, a successful
  `startVisualisation` produces the following log sequence in
  `C:\ProgramData\PRISM.Agent\logs\agent.log` (and via the admin UI
  log forward):

      INF [AgentMessageDispatcher] startVisualisation accepted for runId=<uuid> ... â€” spawning orchestrator
      INF [VisualiserJob] spawned orchestrator pid=<pid> runId=<uuid> server=prod ...
      INF [VisualiserJob] orchestrator reports ready runId=<uuid> signallingUrl=ws://127.0.0.1:<port>/ ...

  When UE5 isn't installed or isn't on the expected path, the
  orchestrator emits `prism-visualiser/failed/v1` with code
  `ue_root_not_found`; the agent forwards a `visualisationFailed`
  envelope with the matching message so the admin UI can surface a
  precise error instead of `start_timeout`.

### Bumped

- `agent/src/PRISM.Agent/PRISM.Agent.csproj` â†’ `0.3.0`
- `server/package.json` + `server/package-lock.json` â†’ `0.3.0`
  (no functional server changes â€” bumped in lock-step with the agent
  so the milestone tag publishes a matching `prism-server:v0.3.0`
  image)
- `visualiser/Directory.Build.props` â€” unchanged at `0.5.1`; the
  bundled orchestrator binary is built from the same source as
  `visualiser-v0.5.0` and reuses that release's binary surface.

---

## Unreleased

### Added â€” Visualiser multi-viewer (shareable links + control tiers)

> Shipped to prod as a rolling `main` deploy at commit `0daf284`
> (`ghcr.io/rebus-orbit/prism-server:sha-0daf284` on VM 211); not yet cut as
> a tagged version. The PC01 agent was hot-patched with the matching
> `SignallingBridge` change (still reporting `v0.3.15`).

- **Multiple concurrent browser viewers per visualiser run** (~5), with
  view-only / control permission tiers, a single-controller lock, and
  shareable links. Opening a 2nd viewer no longer freezes the 1st (the
  original single-WS demux bug).
- **`server/src/ws/signallingProxyRegistry.ts`** â€” rewritten for per-viewer
  routing, the controller lock, and control-channel subscriptions.
- **`agent/src/PRISM.Agent/Visualiser/SignallingBridge.cs`** â€” refactored to
  open one local Cirrus/Wilbur WS **per viewer** so each browser peer is
  demuxed independently (fixes the freeze/disconnect when a second viewer
  joined).
- **New migration `0006_visualiser_share_links.sql`** â€” `visualiser_share_links`
  table (`run_id` FK cascade, `token_hash` unique, `tier` default `view`,
  `created_by`, `expires_at`, `revoked_at`).
- **New `/viewer/` page + share-link endpoints** for minting/redeeming view
  and control links.
- Integration contract documented in `visualiser/PRISM-INTEGRATION.md`.

### Verified â€” TURN / coturn for off-LAN viewers

- `coturn/coturn:4.6` on VM 211 (`/home/rebus/coturn/`, `network_mode=host`,
  UDP+TCP `:3478` + TLS `:5349`, relay `52000â€“56999`) confirmed healthy with a
  `static-auth-secret` byte-identical to `prism-server`'s `TURN_SECRET`.
  `generateTurnCredential` (`server/src/visualiser/turnCredentials.ts`) returns
  `turn:visualiser.rebus.industries:3478` + `turns:â€¦:5349`, username
  `<exp>:<runid-seg>`, `base64(HMAC-SHA1(secret, username))`, `ttl 86400`.
  `:3478` is internet-reachable; UniFi DNAT for the relay UDP range + `5349/TLS`
  is the one item still to confirm.

### Changed

- **Workstations admin + pipeline "Open Web UI" links now use the
  agent's connected IP** (from `agent_sessions.remote_addr`) instead of
  `nodeName.dnsSuffix`. Chrome's HTTPS-First Mode (and any HSTS
  `includeSubDomains` policy on `rebus.industries`) silently upgrades
  `http://<name>.rebus.industries:7421/` to `https://`, which the
  agent's plain-HTTP listener doesn't serve, so every click hit an SSL
  error. Bare IPs are exempt from Chrome's HTTPS-upgrade logic, so
  switching to the agent's live IP fixes the link immediately and also
  makes the feature work on flat LANs that don't have AD DNS to
  resolve the suffix. Falls back to the legacy `nodeName.dnsSuffix`
  URL when the agent is offline (no live IP to surface).

### Added

- **Server â€” Fastify `trustProxy: true`** (`server/src/main.ts`): without
  this, `req.ip` returns the immediate TCP peer (the external Caddy LXC,
  `10.0.200.251`) instead of honouring `X-Forwarded-For`, so every
  `agent_sessions.remote_addr` row landed pointing at the proxy. Safe
  to enable unconditionally â€” prism-server is only reachable from the
  proxy pair or other hosts on the private `10.0.200.0/24` VLAN.
- **Server â€” `host` field on `/api/workstations`** (`server/src/api/workstations.ts`):
  list + get responses now include `host`, populated from the most
  recently active `agent_sessions.remote_addr` for that workstation
  (preferring the row with the freshest heartbeat). Returns `null`
  when no agent session exists.
- **Server â€” IP normalisation on WS hello**
  (`server/src/ws/agentProtocol.ts`): the captured peer address is now
  stripped of any `::ffff:` IPv4-mapped IPv6 prefix before being
  persisted into `agent_sessions.remote_addr`, so dual-stack listeners
  produce the bare IPv4 form everyone expects (`10.0.10.202`, not
  `::ffff:10.0.10.202`).
- **Web â€” `Workstation.host` typed client field** (`web/src/shared/api.ts`):
  surfaces the new server field to all consumers.
- **Web â€” `workstationWebUiHost` / `workstationWebUiUrl` accept an
  optional `host` parameter** (`web/src/shared/workstationUrl.ts`).
  New precedence: live IP > `nodeName.dnsSuffix` > bare `nodeName`.
  Both call sites (`Workstations.vue` and `FlowEditor.vue`) thread
  `Workstation.host` through; FlowEditor's live-data path
  (`applyLiveData`) also pushes `host` / `webUiUrl` into Vue Flow node
  data so the link updates when an agent reconnects from a new IP.

### Notes

- No DB schema changes â€” `agent_sessions.remote_addr` already existed
  on the schema; we now just normalise it on insert and surface it on
  the API.
- `agent_sessions` rows are deleted on socket close, so an offline
  workstation has no historical IP to fall back to and the SPA
  reverts to the `nodeName.dnsSuffix` legacy path. Once the agent
  reconnects after this server deploy, the live IP populates within
  one `hello` round-trip.

---

## v0.2.2 â€” 2026-05-27 â€” Fix drizzle migration journal drift

> Coordinated patch release that fixes the bootstrap crash blocking every
> fresh build of `prism-server` off `main` since the Phase G migration was
> regenerated. **No functional code changes** â€” only a duplicate migration
> file (byte-identical to its sibling) plus version metadata.

### Fixed

- **`server/src/db/migrations/0004_closed_edwin_jarvis.sql` added as a
  byte-identical duplicate of `0004_visualiser_phase_g.sql`.** The Phase G
  regeneration left `server/src/db/migrations/meta/_journal.json` `idx=4`
  with `"tag": "0004_closed_edwin_jarvis"`, but the committed SQL file
  was renamed to `0004_visualiser_phase_g.sql`. Drizzle's
  `readMigrationFiles` reads filenames from the journal's `tag` field,
  so every clean `prism-server` image build crashed at bootstrap with:

      Error: No file /prism/migrations/0004_closed_edwin_jarvis.sql found
      in /prism/migrations folder

  VM 211 had been running `ghcr.io/rebus-orbit/prism-server:hotfix-20260527`,
  which carried a manual `docker cp`-installed duplicate that was never
  committed to git. This release ships the duplicate so the next clean
  build deploys without intervention. Both files have SHA-256
  `307F07FD8F1FACF972BA003A9EC13CB5A2CEDC33571E483B22424CC8AC061B37`.

### Bumped (version metadata only)

- `agent/src/PRISM.Agent/PRISM.Agent.csproj` â†’ `0.2.2`
- `server/package.json` + `server/package-lock.json` â†’ `0.2.2`

### Operational notes

- `:hotfix-20260527` (the manual VM-211 stand-in image) can be retired
  once `:v0.2.2` is verified live on VM 211.
- All earlier release tags (`v0.2.0`, `v0.2.1`,
  `visualiser-v0.2.0`, `visualiser-v0.5.0`) are preserved unchanged
  (additive-only releases).

---

## v0.2.1 â€” 2026-05-27 â€” Release-hygiene hotfix for the v0.2.0 milestone

> Coordinated patch release that fixes the two regressions surfaced by the
> v0.2.0 tag push. **No functional code changes** â€” only version metadata
> and a regenerated server lockfile.

### Fixed

- **`agent/src/PRISM.Agent/PRISM.Agent.csproj` AssemblyVersion bumped to
  `0.2.1`.** Under v0.2.0, `<Version>` / `<AssemblyVersion>` /
  `<FileVersion>` / `<InformationalVersion>` were still pinned to
  `0.1.41` (the per-PR working version last touched by the Phase J
  server PR #8 merge), so the installer published as
  `PRISM.Agent-Setup-v0.2.0.exe` reported its baked-in file version as
  `0.1.41.0` to Explorer / Apps & Features / the Updater's
  `current version` comparison. The installer file name and the
  GitHub Release tag were correct; only the in-EXE manifest was stale.
- **`server/package-lock.json` regenerated from `package.json`.** The
  Phase K rebase (PR #12) used `git checkout --theirs server/package-lock.json`
  to resolve the merge conflict, which reverted the lockfile past the
  Phase J server PR #8 addition of `form-data@4.0.5` (plus the
  `asynckit` / `combined-stream` / `mime-types` transitive chain).
  `npm ci` in `server/Dockerfile` therefore failed during the v0.2.0
  `server-image` workflow run and `ghcr.io/rebus-orbit/prism-server:v0.2.0`
  was never published. Re-running `npm install` here puts the
  required entries back into the lockfile.

### Bumped (version metadata only)

- `agent/src/PRISM.Agent/PRISM.Agent.csproj` â†’ `0.2.1`
- `server/package.json` â†’ `0.2.1`
- `visualiser/Directory.Build.props` â†’ `VisualiserVersion = 0.5.1`
  (separately-tracked semver stream, per
  [`docs/RELEASE_STRATEGY.md`](docs/RELEASE_STRATEGY.md); no
  `visualiser-v*` tag is cut for this release â€” the orchestrator's
  shipped binary is unchanged from `visualiser-v0.5.0` /
  `visualiser-v0.2.0`).

### Operational notes

- `v0.2.0` and `visualiser-v0.2.0` / `visualiser-v0.5.0` tags are
  preserved unchanged (additive-only releases).
- `:hotfix-20260527` (the manual VM-211 stand-in image cut while
  `:v0.2.0` was missing) can be retired once `:v0.2.1` is verified live
  on VM 211.

---

## v0.1.42 â€” 2026-05-27 â€” Visualiser Phase K: portal contract finalisation, hardening, v0.2.0 milestone prep

> **Phase K of the Visualiser feature - the final phase before the v0.2.0
> milestone tag.** Ships the complete portal contract surface in the
> public OpenAPI spec, a narrative integrator guide, GPU pre-flight
> hardening for the orchestrator, antivirus exclusion docs for fleet
> operators, scheduled-task resilience documentation, and the merge
> order + release strategy runbooks. **No runtime behaviour changes
> in the existing surfaces** - all additions are net-new docs +
> hardening files + OpenAPI extensions.

### Added

- **Server - complete Visualiser portal contract in the OpenAPI spec**
  (`server/src/docs/openapi.ts`): adds `Visualiser` and `Project
  Attachments` tags, ten new schemas (`VisualiserStatus`,
  `VisualiserTurnBundle`, `VisualiserStartRequest`,
  `VisualiserReadyResponse`, `VisualiserFailedResponse`, `VisualiserRun`,
  `VisualiserSignallingToken`, `VisualiserWorkstation`,
  `ProjectAttachment`, `ProjectAttachmentList`), and six new paths
  (`POST` + `GET /api/visualiser/streams`, `GET` + `DELETE
  /api/visualiser/streams/{runId}`, `POST
  /api/visualiser/streams/{runId}/signalling-token`, `GET
  /api/visualiser/workstations`, `POST` + `GET
  /api/projects/{projectId}/attachments`, `GET` + `DELETE
  /api/projects/{projectId}/attachments/{id}`). Every path documents
  the timing budget (~2-3s warm / ~60-90s cold), idempotency
  expectation (not yet implemented in Phase G - TODO for v0.3), and
  the full 400/401/403/413/415/429/500/502/503/504 error matrix.
  Adds `PayloadTooLarge` and `UnsupportedMediaType` shared responses
  for the attachments surface, and documents the
  `visualiser:create_stream` and `visualiser:attach_project_files`
  scopes in the `apiKey` securityScheme. The new
  `gpu_preflight_failed` code is enumerated in
  `VisualiserFailedResponse.code`.
- **Server - `/docs/portal-integration` route**
  (`server/src/docs/plugin.ts`): renders the narrative
  `docs/PORTAL_INTEGRATION.md` to HTML on-the-fly via `markdown-it`,
  with a dark-/light-mode-aware theme that matches the existing
  Redoc page. Also serves `/docs/portal-integration.md` (raw with
  the `text/markdown` content-type) for portal devs who want to
  pipe the content into their own renderer. Markdown is read once
  per process start from `${DOCS_DIR}/PORTAL_INTEGRATION.md` (env
  default `/prism/docs` in production, `./docs` in local dev).
- **Server - `markdown-it` dependency** for the new docs route.
  `@types/markdown-it` lives in `devDependencies`.
- **Server - Dockerfile `COPY docs/`** so the production image ships
  the narrative docs alongside the OpenAPI spec. Sets
  `ENV DOCS_DIR=/prism/docs` so the docs plugin finds them at
  request time.
- **docs/PORTAL_INTEGRATION.md** (new, ~600 lines): the narrative
  third-party integrator guide. Covers the 5-step flow,
  authentication + scope semantics, the start/poll/stop endpoints,
  timing budget + idempotency caveat, embedding Epic's
  `lib-pixelstreamingfrontend-ue5.5` (React + Vue + vanilla JS
  examples), JWT signalling-token mint flow, TURN credential
  lifecycle, error + retry matrix, MVR/GDTF project attachments,
  and explicit out-of-scope-for-v1 list.
- **docs/ANTIVIRUS_EXCLUSIONS.md** (new): per-folder + per-process
  Windows Defender exclusions for Visualiser workstations, with
  observed cold-start impact (~6 min -> ~2-3 min). PowerShell +
  Group Policy + ESET/Sophos/Trend Micro/CrowdStrike syntax. Audit
  rationale + security-policy fallback section.
- **agent/install/Set-VisualiserAvExclusions.ps1** (new): one-shot
  helper that idempotently applies the recommended Defender
  exclusion set. Bundled with the agent install kit but opt-in
  (operators run it manually). Detects when Defender isn't the
  active AV and skips with a warning.
- **docs/SCHEDULED_TASK_RESILIENCE.md** (new): documents the
  agent's existing Task Scheduler resilience configuration
  (`AtLogOn` + `AtStartup` triggers, `RestartCount=3` /
  `RestartInterval=1m`, `MultipleInstances=IgnoreNew`). Confirms
  the `<RestartOnFailure>` XML element is already emitted by the
  install.ps1's `New-ScheduledTaskSettingsSet` cmdlet call - no
  gaps to patch. Explains why this matters for the Visualiser
  role (a wedged UE process + Job Object cleanup + bounded
  recovery time).
- **docs/RELEASE_STRATEGY.md** (new): codifies the v0.2.0 milestone
  tag strategy across the three independently-versioned artifacts
  (agent, server image, orchestrator). Documents the
  orchestrator's version-continuity decision (ship
  `visualiser-v0.5.0` aliased as `visualiser-v0.2.0` on the same
  commit), the maintenance-release flow, and the UE template
  gating (the artist-populated `v1.0.0-ue5.7` lands as a v0.2.1
  hotfix).
- **docs/VISUALISER_MERGE_ORDER.md** (new): actionable runbook for
  whoever merges the 12-PR stack. Strict ordering, expected
  conflicts per file, pre-merge checklist, operator runbook for
  cutting the `v0.2.0` tag at the end.
- **visualiser/src/PRISM.Visualiser.Orchestrator/Unreal/GpuPreflight.cs**
  (new): pre-flight check the pipeline runs before `ImportAsync`.
  Calls `nvidia-smi --query-gpu=memory.free` and refuses to start
  when (a) the workstation has < 4 GB free VRAM or (b) a stale
  `UnrealEditor*.exe` is already running (would clash for the
  NVENC encoder). Soft-warns when `nvidia-smi` is missing unless
  the CLI passes `--strict-gpu`. Exits 10 on rejection; the agent
  maps that to a `prism-visualiser/failed/v1` envelope with
  `code: "gpu_preflight_failed"`. Self-contained, testable via
  the injected `IGpuProbe` interface.
- **visualiser/tests/PRISM.Visualiser.Orchestrator.Tests/GpuPreflightTests.cs**
  (new): nine xunit tests covering the parser, the VRAM threshold,
  stale-editor detection, soft/strict modes, and the
  `FailureCode`/`ExitCode` stability locks.
- **visualiser/README.md** (new): brings the visualiser subtree
  from "scaffold not functional" to a full production-ready
  README covering build, test, publish, CLI flags, exit codes,
  hardening (Phase K), and versioning strategy.
- **PRISM/README.md - top-level Visualiser section**: adds the
  elevator pitch, ASCII architecture diagram, and links into the
  new `docs/` folder. Also bumps the Status table to phase 9
  "Visualiser (done, v0.2.0)" and the Layout list to mention the
  new `visualiser/` and `docs/` directories.

### Notes

- **No prior-phase code was modified.** Phase K is purely additive
  to keep its merge clean. It branches from `main`, not from any
  feature branch. When Phase G's `openapi.ts` additions land
  upstream, the rebase will conflict in the visualiser sections -
  resolve by taking the Phase K superset (it already includes
  everything Phase G adds, with Phase K's expansions on top).
  Same pattern for the `CHANGELOG.md` entries: Phase K v0.1.42
  sits at the top of the list; prior phase entries land below it
  in version order.
- **GpuPreflight wiring is documented, not done.** The
  `VisualiserPipeline` file lives on the Phase F branch
  (`feat/visualiser-phase-f`) and isn't present on `main` at the
  time of this PR. The `GpuPreflight.cs` docstring shows the
  exact call-site snippet for when the Phase F orchestrator stack
  merges; Phase K does not modify the pipeline directly. The
  default orchestrator csproj uses default-glob compilation
  (`**/*.cs`), so the file slots in automatically when both
  branches land on `main`.
- **`v0.1.42` is the agent + server version for this PR.** The
  `v0.2.0` milestone tag is a separate, later action - cut at the
  HEAD of `main` after every preceding PR has merged in the
  documented order. See
  [`docs/RELEASE_STRATEGY.md`](docs/RELEASE_STRATEGY.md) for the
  full sequence.
- **Verification.** Server `npx tsc --noEmit` clean; the OpenAPI
  spec bundles cleanly under `@apidevtools/swagger-parser` and
  exposes all 6 new visualiser paths + 10 new schemas. Fastify
  inject() smoke test confirms `/docs/portal-integration` (HTML),
  `/docs/portal-integration.md` (raw), `/docs` (Redoc), and
  `/api/openapi.json` (now including the visualiser surface) all
  return 200 with the expected content. `dotnet build` of the
  orchestrator + the new `GpuPreflightTests` is end-state coverage
  gated on the Phase F+ orchestrator stack reaching `main`.

---

## v0.1.41 â€” 2026-05-27 â€” Visualiser Phase J server: project attachments + MVR forwarding

> **Phase J of the Visualiser feature (server + web half).** Adds the
> portal-uploaded project-attachments surface and wires it through to the
> visualiser dispatcher so the orchestrator can stage MVR / GDTF
> lighting-design files alongside the converted glTF. The matching
> orchestrator-side detector + `import_mvr.py` ships in
> `feat/visualiser-phase-j-orchestrator` (visualiser v0.5.0); the two
> stacks are deliberately independent â€” neither side requires the other
> to compile.

### Added

- **Shared contracts** (`AgentProtocol.cs`, `agent-protocol.ts`,
  `agent-protocol.json`): new `ProjectAttachmentRef` type
  (`id`, `filename`, `contentType?`, `sizeBytes`, `downloadUrl`) plus a
  new optional `attachments?: ProjectAttachmentRef[]` field on
  `StartVisualisation`. Older orchestrators ignore the field; the
  visualiser dispatcher omits it entirely when the project has no live
  attachments to keep the wire envelope identical to Phase G.
- **Server â€” `project_attachments` table + migration
  `0005_project_attachments.sql`** (`server/src/db/schema.ts`,
  `server/src/db/migrations/`): id (uuid), projectId, filename,
  contentType, sizeBytes, storagePath, uploadedByApiKeyId FK to
  `api_keys` (ON DELETE SET NULL), uploadedAt, soft-delete `deletedAt`,
  and a `project_attachments_project_idx` btree to keep the per-project
  list query cheap.
- **Server â€” REST surface `/api/projects/:projectId/attachments`**
  (`server/src/api/projectAttachments.ts`):
  - `POST   /:projectId/attachments` â€” multipart upload, 50 MB cap,
    mime/extension whitelist (`.mvr`, `.gdtf`, `.zip` /
    `application/mvr|gdtf|zip|octet-stream`). 201 â†’ public attachment
    row; 415 on banned type; 413 on overflow.
  - `GET    /:projectId/attachments` â€” newest-first list of live rows.
  - `GET    /:projectId/attachments/:id` â€” streams the body with the
    recorded content-type.
  - `DELETE /:projectId/attachments/:id` â€” soft-deletes the row and
    unlinks the on-disk body.
  Bodies live under
  `${PRISM_DATA_DIR ?? '/data/prism'}/project-attachments/<projectId>/<id>-<filename>`.
- **Server â€” `visualiser:attach_project_files` API-key scope**
  (`server/src/api/keys.ts`): split off from `visualiser:create_stream`
  so a read-only "start a stream" key can't silently upload assets,
  and the portal can mint two keys with different lifetimes. Admin
  sessions and ORBIT bearers bypass scope checks as before.
- **Server â€” visualiser dispatcher forwards attachments**
  (`server/src/jobs/dispatcher.ts`): exported `loadAttachmentRefs()`
  helper builds the `ProjectAttachmentRef[]` for the run's project
  (newest-first, soft-deletes excluded, `downloadUrl` derived from
  `PUBLIC_BASE_URL`); `tryDispatchVisualisation()` attaches the array
  to the outgoing `startVisualisation` envelope when non-empty.
- **Web â€” `projectAttachmentsApi` client** (`web/src/shared/api.ts`):
  `list`, `upload`, `downloadUrl`, `remove`. **Append-only** to keep
  the file mergeable with the Phase I worker that's also extending it.
- **Web â€” admin `ProjectAttachments.vue` page**
  (`web/src/admin/pages/ProjectAttachments.vue`, routed at
  `#/visualiser/attachments`, linked under "Visualiser" in the sidebar
  as a sub-nav row): per-project drag-drop upload, live list with
  size / content-type / uploader, download + delete actions. Reuses
  `<OrbitPicker>` for the project picker.

### Tests

- `server/tests/api.projectAttachments.test.ts` (13 cases): full HTTP
  surface â€” happy-path upload, 401 without auth, 403 without scope,
  415 on banned mime / extension, 413 on >50 MB upload, 400 on empty,
  list newest-first (filters by projectId + excludes soft-deletes),
  GET streams body, DELETE soft-deletes + unlinks body + drops from
  list.
- `server/tests/visualiser.dispatcher.test.ts` (+3 cases, 13 total):
  attachments forwarded as `ProjectAttachmentRef[]` on
  `startVisualisation`, omitted when empty (back-compat), and the
  `loadAttachmentRefs()` helper builds correctly-shaped rows with
  deterministic download URLs.

### Notes / deviations

- API-key scope choice: introduced `visualiser:attach_project_files`
  as a sibling to `visualiser:create_stream` rather than reusing
  `create_stream` outright. Trade-off: portal admins now mint two
  scopes for "full visualiser ops" but read-only stream keys can't
  unilaterally inject assets into projects.
- Storage is intentionally local-FS (under `PRISM_DATA_DIR`) rather
  than ORBIT's MinIO â€” these blobs are PRISM-internal staging inputs
  for the visualiser orchestrator, not first-class project artefacts.

---

## v0.1.40 â€” 2026-05-27 â€” Visualiser Phase I: Pixel Streaming player + agent signalling bridge

> **Phase I of the Visualiser feature.** Replaces Phase G's `<iframe>`
> placeholder in the admin debug viewer with a real Pixel Streaming
> embed driven by Epic's official `@epicgames-ps/lib-pixelstreamingfrontend-ue5.5`
> NPM package (locked to `1.2.5`, the latest stable on npm). End-to-end
> the loop now closes: an admin clicking **Open debug viewer** on
> `/admin/visualiser/:runId` connects to PRISM's WS signalling proxy
> with a short-lived JWT, frames flow across the agent WS to a new
> per-runId `SignallingBridge` that forwards verbatim onto the
> orchestrator's local Cirrus, and the workstation's UE viewport
> appears in the browser with keyboard + mouse input forwarded back.

### Added

- **Web â€” `PixelStreamingPlayer.vue`** (new, `web/src/admin/components/`):
  thin Vue wrapper around the PS frontend lib. Builds a fresh signalling
  URL on each (re)connect by fetching a new JWT via
  `POST /api/visualiser/streams/:runId/signalling-token`, mounts the
  lib's video element into a flex container with our design tokens,
  and monkey-patches `WebRtcPlayerController.handleOnConfigMessage` to
  inject the PRISM-minted TURN bundle into `peerConnectionOptions.iceServers`
  before the RTCPeerConnection is created. Surfaces `connecting` /
  `streaming` / `failed` state with the disconnect reason string when
  available.
- **Web â€” `VisualiserViewer.vue` rewrite**: drops the iframe shim;
  embeds `<PixelStreamingPlayer>` instead. Status pill + TURN-unset
  hint + stop button preserved. Metadata poll dropped from 5s to 10s
  now that the WebRTC stream owns its own connection.
- **Web â€” `VisualiserRun.turn` typed field** (`web/src/shared/api.ts`):
  surfaces the optional TURN bundle the server now attaches to the
  single-row GET response. The bundle is fresh per request (24h coturn
  TTL handles renewal naturally).
- **Server â€” `GET /api/visualiser/streams/:runId` includes a fresh
  TURN credential** (`server/src/api/visualiser.ts`): only when the
  run is `streaming`; the list endpoint stays unchanged so the bundle
  doesn't leak into admin polling caches. The credential is
  HMAC-derived per call from `TURN_SECRET`, no persistence required.
- **Agent â€” `SignallingBridge.cs`** (new,
  `agent/src/PRISM.Agent/Visualiser/`): per-runId bidirectional
  WebSocket bridge that splices the PRISM server uplink to the
  orchestrator's local Cirrus signalling endpoint. Forwards
  serverâ†’agent text + binary frames verbatim onto the local socket,
  and pumps the reverse channel into `signallingFrame` envelopes back
  upstream. Reassembles fragmented messages, propagates close events,
  and disposes cleanly even when the peer is slow.
- **Agent â€” `SignallingBridgeRegistry.cs`** (new, same folder): owns
  the lifecycle of every active bridge on this agent. Lazy-creates a
  bridge against the default local Cirrus URL
  (`ws://127.0.0.1:8888/`, overridable via `PRISM_VISUALISER_CIRRUS_URL`)
  when the upcoming orchestrator hasn't yet registered the actual URL,
  and provides `RegisterLocalCirrus(runId, url)` for the orchestrator
  to call from its `ready/v1` emit once Phase E/F merge.
- **Agent â€” `AgentMessageDispatcher.HandleSignallingFrame` real impl**
  (`agent/src/PRISM.Agent/Ws/AgentMessageDispatcher.cs`): replaces
  the Phase G log-and-drop stub. Decodes the envelope, fetches the
  bridge from the registry, and forwards on a background task so the
  WS pump thread is never blocked.
- **Agent â€” DI registration of `SignallingBridgeRegistry`** as a
  singleton in `Program.cs`.
- **Agent â€” `PRISM.Agent.Tests` xunit project** (new, `agent/tests/`):
  six tests over `SignallingBridge` against an in-process WebSocket
  echo server (round-trips text + binary frames, preserves ordering,
  disposes cleanly, no-ops when closed, surfaces failure on
  unreachable Cirrus). Wired into the agent solution and runs under
  `dotnet test`.

### Changed

- **Web â€” `web/package.json`**: adds the
  `@epicgames-ps/lib-pixelstreamingfrontend-ue5.5@1.2.5` dependency
  (Epic's officially-published frontend; API-compatible with UE 5.7
  streamers per Epic's release notes). Lockfile updated.

### Notes

- **End-to-end gates.** The admin can now click "Open debug viewer"
  and the player wiring goes all the way through to the agent's WS
  inbox. Real video gates on Phase D's `v1.0.0-ue5.7` artist template
  + a workstation with UE 5.7 + GPU + NVENC + Phase H's coturn
  reachable from both the browser and the workstation â€” all of which
  are out of scope for Phase I's automated coverage. Unit tests
  (`SignallingBridgeTests` + Phase G's existing server suite) are the
  in-tree coverage.
- **Frontend lib choice.** Epic publishes
  `lib-pixelstreamingfrontend-ue5.5` (latest stable; supports 5.5 â†’
  5.7 streamers) and a separate `lib-pixelstreamingfrontend-ui-ue5.5`
  UI helper. We use only the core library and render our own
  status chrome; the UI lib's `Application` class would add ~80 KB
  of widget code we don't need.
- **TURN injection.** The PS frontend lib reads ICE servers from
  Cirrus's `config` message. We monkey-patch
  `WebRtcPlayerController.handleOnConfigMessage` to merge our
  PRISM-minted bundle into that list before the RTCPeerConnection is
  created â€” using the public lib surface (the `webRtcController`
  property is exposed on `PixelStreaming`). If Epic ever changes the
  handler name in a major release, the fallback is to vendor the lib
  from `EpicGamesExt/PixelStreamingInfrastructure` UE5.7 branch and
  edit the patch site directly.

---

## v0.1.39 â€” 2026-05-27 â€” Visualiser Phase H: coturn TURN server + env wiring

> **Phase H of the Visualiser feature.** Stands up the WebRTC media
> relay (`coturn` on VM 211, public DNS
> `visualiser.rebus.industries`) and wires the real `TURN_SECRET` +
> `JWT_SIGNALLING_SECRET` + `VISUALISER_START_TIMEOUT_MS` through PRISM
> server's env. With this in place the Phase G "turn: null" sentinel
> is replaced by real RFC 7635 credentials and a browser anywhere on
> the public internet can connect to a Pixel Streaming player URL
> backed by a workstation behind PRISM.
>
> Co-released with `v0.1.39` of the agent. The agent has **no code
> change** in this release â€” it ships only the csproj version bump so
> the agent + server release tags stay in lockstep.

### Added

- **TURN deployment artifacts** (outside the PRISM repo, under
  `D:\Documents\Claude\REBUS System\TURN\`):
    - `docker-compose.yml` â€” `coturn/coturn:4.6`, `network_mode: host`
      (required for the wide UDP relay range â€” initially `49152-65535`,
      narrowed to `52000-56999` post-merge to avoid the WireGuard
      `51820/udp` listener; see "Updated" section below), volume-mounts
      for `turnserver.conf` and `/etc/letsencrypt`.
    - `turnserver.conf` â€” `use-auth-secret` (RFC 7635), realm
      `visualiser.rebus.industries`, `external-ip=185.48.165.165/10.0.200.211`,
      relay range `52000-56999/udp` (was `49152-65535/udp` at initial
      Phase H merge â€” see "Updated" section below for the WireGuard
      collision rationale), denied-peer-ip ranges for every
      RFC-1918 / loopback / link-local / documentation block with
      narrow `allowed-peer-ip` exceptions for the REBUS workstation
      VLANs (`10.0.10.200-250`, `10.0.200.200-250`). The
      `static-auth-secret` line carries a `<TURN_SECRET_PLACEHOLDER>`
      string that the operator sed-replaces at deploy time. **No real
      secret is committed**; secret generation is gated on operator
      action.
    - `SETUP_NOTES.md` â€” ten-step deploy runbook covering secret
      generation, SCP to VM 211, sed-replace, PRISM `.env` update,
      `docker compose up -d`, public + internal DNS, certbot for the
      `turns://` TLS cert on port 5349, certbot deploy-hook to
      `docker restart coturn` on renewal, and smoke tests against the
      WebRTC Trickle ICE sample page.
    - `UNIFI_RULES.md` â€” copy-pasteable port-forward table for the
      UniFi gateway: `coturn-stun-udp` 3478/udp, `coturn-stun-tcp`
      3478/tcp, `coturn-tls` 5349/tcp, `coturn-relay-udp`
      52000-56999/udp (narrowed from `49152-65535/udp` post-merge â€”
      see "Updated" section below), all targeting `10.0.200.211`.
      Includes the "until these rules are applied" symptom matrix for
      diagnosing no-relay-candidates failures.

- **Caddy proxy block for `visualiser.rebus.industries`**
  (`D:\Documents\Claude\REBUS System\proxy\Caddyfile`). Caddy serves
  only the ACME HTTP-01 challenge + a friendly `200` health response;
  TURN traffic is **not** proxied (TURN is not HTTP and `turns://`
  TLS must be terminated by coturn itself on VM 211:5349). Documented
  in `proxy/SETUP_NOTES.md` so the next operator does not assume the
  TURN traffic actually flows through the proxy pair.

- **PRISM server env passthrough** (`infra/docker-compose.yml` +
  `infra/.env.example`):
    - `TURN_SECRET` â€” shared with coturn's `static-auth-secret`.
      Empty â†’ `turn: null` sentinel (Phase G behaviour); set â†’
      `turnCredentials.ts` mints real RFC 7635 credentials.
    - `TURN_REALM` â€” default `visualiser.rebus.industries`.
    - `JWT_SIGNALLING_SECRET` â€” HS256 signing key for the 5-minute
      WS-signalling tokens. Independent of `TURN_SECRET`.
    - `VISUALISER_START_TIMEOUT_MS` â€” default `180000` (180s),
      matches the measured first-cold-start envelope.
  No code change in the server itself â€” `turnCredentials.ts` already
  read these vars in Phase G; this PR just wires them through the
  container env in production.

- **`infra/SETUP_NOTES.md`** (new) â€” companion to `DEPLOY.md`
  documenting the adjacent infra dependencies PRISM relies on but
  does not own (coturn, Caddy, UniFi). Includes the full
  `infra/.env.example â†’ /opt/prism/.env â†’ compose â†’ process.env â†’
  turnCredentials.ts` wiring diagram and the recommended deploy
  ordering for first-time stand-up.

### Notes

- **No code change on the server.** Phase G's `turnCredentials.ts`,
  `signallingToken.ts`, `dispatcher.ts`, `signallingProxy.ts`, etc.
  already implement the full credential + signalling surface â€” Phase
  H is purely the operational config that lets that surface produce
  real (rather than sentinel) values in production.
- **No code change on the agent** beyond the version bump. The agent
  release tag is held in lockstep with the server image tag, so a
  Phase H deploy produces a `prism-agent-v0.1.39` MSI that is a
  byte-identical mirror of `v0.1.38` apart from
  `AssemblyInformationalVersion`. Acceptable trade â€” keeps the
  release matrix simple.
- The TURN secret itself is intentionally **not** generated by the
  Phase H PR. Secret generation is gated on operator authorization
  per the workspace's deploy convention. The runbook in
  `TURN/SETUP_NOTES.md` is the deploy artifact.

### Pending follow-ups

- **Phase I** lands the real Pixel Streaming embed in
  `VisualiserViewer.vue` and the agent-side bridge that forwards
  `signallingFrame` envelopes to the orchestrator's local Cirrus.
- **Phase J** adds MVR/GDTF detection + the project attachments
  endpoint.
- **Phase K** wires the bandwidth-monitor / `max_active_streams`
  admin control mentioned as a v1 risk in the plan.

### Operator runbook (post-merge)

1. Generate `TURN_SECRET` and `JWT_SIGNALLING_SECRET`
   (`openssl rand -hex 32` â€” two independent values).
2. Stage `D:\Documents\Claude\REBUS System\TURN\{docker-compose.yml,turnserver.conf}`
   onto VM 211 at `~rebus/coturn/`. Sed-replace the placeholder.
3. Edit `/opt/prism/.env`: add `TURN_SECRET`, `TURN_REALM`,
   `JWT_SIGNALLING_SECRET`, `VISUALISER_START_TIMEOUT_MS`.
4. `cd ~/coturn && docker compose up -d`. Verify
   `IPv4. Listener opened on : 0.0.0.0:3478` in logs.
5. `cd /opt/prism && docker compose restart prism-server`.
6. Apply UniFi rules per `TURN/UNIFI_RULES.md`.
7. Add public A record `visualiser.rebus.industries â†’
   185.48.165.165` at the registrar (âœ… live as of 2026-05-27) and
   an internal A record `visualiser.rebus.industries â†’ 10.0.200.211`
   on DC1.
8. Issue the TLS cert via `certbot certonly --standalone` on VM 211.
   Uncomment the `cert=` / `pkey=` lines in `turnserver.conf` and
   restart coturn.
9. Smoke-test using the WebRTC Trickle ICE page from a cellular
   connection â€” expect `relay` candidates from `185.48.165.165` to
   appear within ~2 s.

### Updated post-merge (2026-05-27)

- **Public DNS A record `visualiser.rebus.industries â†’
  185.48.165.165` is âœ… live as of 2026-05-27.** Step 7 of the
  operator runbook is therefore complete on the public-DNS side; the
  internal AD DNS record (DC1) and the certbot/TLS step still need
  operator attention.
- **coturn relay range narrowed from `49152-65535/udp` to
  `52000-56999/udp`** in
  `D:\Documents\Claude\REBUS System\TURN\turnserver.conf` and
  `D:\Documents\Claude\REBUS System\TURN\UNIFI_RULES.md` (and the
  matching comments in `docker-compose.yml` and `SETUP_NOTES.md`).
  Rationale: the original IANA-default range `49152-65535` straddles
  WireGuard's `51820/udp`, which is forwarded elsewhere on the
  REBUS network. The new `52000-56999` window is well above
  `51820`, well inside the IANA Dynamic / Ephemeral block, and
  5000 ports is far more than the realistic concurrency ceiling
  (~20 simultaneous Pixel Streaming sessions, since each one needs
  a GPU on the workstation side). **Operator action**: on VM 211,
  re-SCP the updated `turnserver.conf`, then
  `cd ~/coturn && docker compose up -d coturn --force-recreate`,
  and re-apply the updated UniFi rule for `coturn-relay-udp`.

---

## v0.1.38 â€” 2026-05-27 â€” Visualiser Phase G: server API + WS signalling proxy + admin UI

> **Phase G of the Visualiser feature.** Wires up the portal-facing
> `/api/visualiser/streams` REST surface, the bidirectional WS signalling
> proxy that fronts the orchestrator's local Cirrus, the admin UI
> start/stop pages, and the API-key scope guard. The end state per the
> plan: PRISM admin UI (or `curl`) can start a stream, get a signalling
> URL, and a co-located browser can connect.
>
> Co-released with `v0.1.38` of the agent â€” the only agent-side change
> in Phase G is a new `signallingFrame` WS handler stub so the server's
> outbound envelopes have a place to land. The local-Cirrus hop on the
> agent side wires up when the orchestrator branch (Phases B-F) merges
> in; until then the agent debug-logs and drops inbound frames.

### Added

- **Shared contracts** (`AgentProtocol.cs`, `agent-protocol.ts`,
  `agent-protocol.json`): two new envelopes â€” `VisualisationEnded`
  (agent â†’ server, terminal cleanup after TTL expiry / UE exit /
  browser disconnect) and `SignallingFrame` (bidirectional, either
  `payload` text or `payloadB64` base64-encoded binary). Verified by
  `npm run validate:contracts` (21 message types across all three
  representations).
- **Server REST API** â€” new file `server/src/api/visualiser.ts`
  registering five routes under `/api/visualiser`:
    - `POST /streams` (requires `visualiser:create_stream` scope or
      admin session) â€” synchronous start. Validates the body, inserts a
      `queued` row, dispatches `startVisualisation` to the least-loaded
      eligible workstation via `tryDispatchVisualisation`, awaits the
      agent's `visualisationReady` / `visualisationFailed` reply through
      a per-runId Promise registry (timeout configurable via
      `VISUALISER_START_TIMEOUT_MS`, default 180s). Returns the plan's
      `prism-visualiser/ready/v1` shape â€” `runId`, `signallingUrl`,
      `playerUrl`, `streamerId`, `turn: { urls, username, credential,
      ttl } | null` â€” on success; the `failed/v1` shape with a
      machine-readable `code` (`start_timeout`, `agent_failed`,
      `no_workstation_available`, `all_workstations_busy`,
      `misconfigured`, `agent_send_failed`) on failure.
    - `GET  /streams` and `GET /streams/:runId` for polling (admin
      auth).
    - `DELETE /streams/:runId` (caller must be the API key that
      started the run, or admin) â€” sends best-effort
      `cancelVisualisation`, transitions row to `ended`, releases the
      workstation slot.
    - `POST /streams/:runId/signalling-token` â€” mints a 5-minute HS256
      JWT scoped to one runId. Returns 503 with a clear error when
      `JWT_SIGNALLING_SECRET` is unset rather than minting an unverifiable
      token.
    - `GET  /workstations` (admin only) â€” list of eligible visualiser
      workstations + their current load, for the start-stream
      dropdown.
- **Server WS signalling proxy** â€”
  `server/src/ws/signallingProxy.ts` mounts a websocket route at
  `/ws/visualiser/:runId/signalling?token=<jwt>`. Verifies the JWT
  against `expectedRunId`, refuses non-`streaming` runs (4409),
  refuses runs with no agent session (4503), then registers the
  browser socket in an in-process registry and forwards every frame
  to the agent via `sendSignallingFrameToAgent`. Inbound
  `signallingFrame`s from the agent fan out to every browser socket
  for that runId. Binary frames are base64-wrapped into
  `payloadB64`; text frames go through as `payload`. PRISM does not
  parse the Pixel Streaming sub-protocol â€” the wrappers are opaque
  envelopes. The registry is extracted into
  `signallingProxyRegistry.ts` to break the import cycle with
  `agentProtocol.ts`.
- **Server WS inbound handlers** (`server/src/ws/agentProtocol.ts`):
  Phase A's stub `visualisationReady` / `visualisationFailed`
  handlers now actually update the `visualiser_runs` row, fire the
  Promise waiter in `visualiserRunRegistry`, decrement the
  workstation's visualiser-load counter via `releaseVisualiserSlot`,
  close any browser proxy connections for the run, and broadcast a
  `workstation_updated` event to admin SSE. A new
  `visualisationEnded` handler runs the same cleanup path (terminal
  state, no waiter to fire). The `signallingFrame` handler dispatches
  to `signallingProxyRegistry.forwardAgentToBrowser`.
- **Server TURN credential generator** â€”
  `server/src/visualiser/turnCredentials.ts` implements RFC 7635 Â§3
  long-term credentials (`base64(HMAC-SHA1(TURN_SECRET, "<exp>:<tag>"))`
  with `exp = now + ttlSeconds`). Returns `null` sentinel when
  `TURN_SECRET` is unset so the portal can still receive the rest of
  the ready response â€” Phase H wires the real coturn deploy. Honours
  `TURN_REALM` (default `visualiser.rebus.industries`) and
  `TURN_URLS_OVERRIDE` for staging.
- **Server signalling token issuer** â€”
  `server/src/visualiser/signallingToken.ts` implements hand-rolled
  HS256 JWT issue/verify against `JWT_SIGNALLING_SECRET`. Each token
  carries `runId` + 5-minute `exp`; verify enforces signature,
  expiry, and an `expectedRunId` match so a leaked token can't be
  replayed against a different run.
- **Server run registry** â€” `server/src/visualiser/runRegistry.ts`,
  the per-runId Promise map that bridges the synchronous POST
  request to the agent's async WS reply. Supports timeout, supersede,
  and abandon.
- **Server dispatcher hardening** (`server/src/jobs/dispatcher.ts`):
  `tryDispatchVisualisation` now returns a discriminated outcome
  (`no_workstation_available` / `all_workstations_busy` /
  `agent_send_failed` / `misconfigured` / `invalid_state` / success),
  picks the least-loaded `can_visualise = true` workstation, and
  reserves a slot atomically via `UPDATE workstations SET
  current_visualiser_load = current_visualiser_load + 1 WHERE id = ?
  AND current_visualiser_load < slots RETURNING â€¦`. The
  optimistic-update pattern means concurrent dispatchers race
  cleanly: the loser sees zero rows and tries the next candidate.
  Rollback on agent ws send failure clamps the counter at zero via
  `GREATEST(current_visualiser_load - 1, 0)`. New
  `releaseVisualiserSlot(workstationId)` is called from every
  terminal-state agent envelope and from the DELETE endpoint.
- **Database** (`schema.ts` â†’ `0004_visualiser_phase_g.sql`):
  `workstations.current_visualiser_load int NOT NULL DEFAULT 0`,
  `visualiser_runs.player_url text`,
  `visualiser_runs.failure_reason varchar(64)`, and
  `visualiser_runs.requested_by_api_key_id uuid` with `FK â†’ api_keys.id
  ON DELETE SET NULL`.
- **OpenAPI** (`server/src/docs/openapi.ts`): documents all five
  `/api/visualiser/*` paths with request / response schemas, the
  `X-API-Key` scope requirement, and request + response examples for
  the start-stream happy path. Adds a second `servers[]` entry so the
  rendered spec correctly resolves `/api/visualiser/*` paths against
  the deployment root rather than under `/v1`. Phase K writes the
  narrative companion docs.
- **Web admin UI**:
    - `web/src/admin/pages/Visualiser.vue` â€” table of recent runs,
      live duration ticker on streaming rows, ORBIT project-name
      resolution (cached client-side), per-row Stop + Open viewer
      action buttons, and a Start-stream modal that reuses
      `OrbitPicker` for project/model selection and calls
      `GET /api/visualiser/workstations` for the (optional)
      workstation dropdown. Polls every 5s while any non-terminal
      run exists; stops automatically when everything settles.
    - `web/src/admin/pages/VisualiserViewer.vue` â€” minimal `<iframe>`
      shim pointing at the orchestrator's `playerUrl` with a Loadingâ€¦
      overlay and per-status placeholder copy. Phase I replaces this
      with a real Pixel Streaming embed driven by the new signalling
      WS proxy.
    - `web/src/shared/api.ts` â€” new `visualiserApi` client with
      `listStreams` / `getStream` / `startStream` / `stopStream` /
      `listWorkstations` / `signallingToken`, plus typed
      `VisualiserRun`, `VisualiserReadyEvent`, `VisualiserTurnBundle`,
      `VisualiserWorkstation`, `VisualiserStartBody`,
      `VisualiserStatus` interfaces.
    - `web/src/admin/App.vue` + `web/src/admin/main.ts` â€” new
      "Visualiser" sidebar entry (between Pipeline and API keys) and
      routes `/visualiser` + `/visualiser/:runId`.

### Agent (v0.1.38)

- **AgentMessageDispatcher**: new `MessageType.SignallingFrame`
  branch wired up. The handler is a Phase G stub â€” the orchestrator-
  side bridge that forwards to local Cirrus lands when the
  orchestrator branch merges in. Until then the agent logs at debug
  and drops the frame, so the server-side proxy stays connected for
  the browser's lifetime without raising.

### Server: testing

Server gains its first test files (4 suites, 35 passing): unit tests
for the TURN credential generator (RFC 7635 format, TTL handling,
sentinel behaviour, realm + URL override env vars), the HS256
signalling token (issue / verify round-trip, replay protection on
mismatched `expectedRunId`, expired-token rejection, signature
forgery rejection), the in-memory run registry (resolve / reject /
timeout / supersede / abandon), and the visualiser dispatcher
(selection logic, race-loss roll-forward, atomic reservation
rollback on agent send failure, misconfiguration rollback). The
dispatcher suite mocks the `db` client at module boundary so it
runs in-process with no Postgres dependency.

### Deviations from spec

- The signalling-token route returns 503 (rather than 500) when
  `JWT_SIGNALLING_SECRET` is unset so operators see a clear
  "misconfigured, can't mint a token" signal rather than a generic
  server error â€” same shape as the TURN sentinel.
- The admin Visualiser nav entry sits between Pipeline and API keys
  rather than between Pipeline and Workstations as the spec
  suggested â€” that placement keeps the role-management surfaces
  (Workstations, API keys) adjacent in the sidebar and matches the
  current "Workstations â†’ role pills â†’ Visualiser stream consumer"
  reading order.
- The `signallingFrame` envelope carries either `payload` (string)
  or `payloadB64` (base64-encoded binary), with exactly one set per
  frame. This is slightly more explicit than the spec's `raw
  binary/text payload` phrasing â€” Newtonsoft.Json round-trips a
  byte[] field through base64 by default but the explicit field
  split lets the JSON Schema validator catch malformed envelopes.
- The full `POST /api/visualiser/streams` integration test (Fastify
  inject + mocked WS gateway) was deferred â€” the suite would need a
  full Postgres fixture which the server doesn't yet have any
  integration-test infrastructure for. The dispatcher unit tests
  cover the same selection / reservation surface; the API route's
  thin wrapping over them is exercised by `tsc --noEmit` and the
  contract validator.

### Pending follow-ups

- **Phase H** wires `TURN_SECRET` + matching coturn deployment. The
  sentinel `turn: null` already round-trips through the API and the
  admin SPA.
- **Phase I** replaces `VisualiserViewer.vue`'s iframe with a real
  Pixel Streaming embed and lands the orchestrator-side bridge in
  the agent's `signallingFrame` handler.
- **Phase K** writes the narrative portal docs against the
  machine-readable OpenAPI spec wired up here.

---

## v0.1.37 â€” 2026-05-27 â€” Visualiser role plumbing (no orchestrator yet)

> **Phase A of the Visualiser feature.** This release lands the *plumbing* â€”
> role flag, settings storage, contracts, DB schema, dispatcher branch,
> and admin/agent UI â€” but **no orchestrator binary, no Unreal Engine
> integration, and no signalling proxy**. The agent's `startVisualisation`
> WS handler intentionally acks `accepted: false` with reason
> `"visualiser orchestrator not yet implemented"`. Wiring to a real
> `VisualiserSession` lands in Phase F/G.

### Added

- **Shared contracts** (`shared/contracts/AgentProtocol.cs`,
  `agent-protocol.ts`, `agent-protocol.json`): `Visualiser` added to the
  `AgentRole` enum. Four new `MessageType`s â€” `startVisualisation`,
  `cancelVisualisation` (server â†’ agent), `visualisationReady`,
  `visualisationFailed` (agent â†’ server) â€” with matching `*Data`
  payload records covering `runId`, ORBIT credentials, project / model /
  version ids, template tag, signalling URL, stream id, expiry, and
  error fields. Verified by `npm run validate:contracts` (19 message
  types across all three representations).
- **Database schema** (`server/src/db/schema.ts` â†’
  `0003_visualiser.sql`): `workstations.can_visualise boolean DEFAULT
  false`, `api_keys.scopes jsonb DEFAULT '[]'::jsonb`, and a new
  `visualiser_runs` table keyed by `status varchar(16)` enum (`queued |
  importing | streaming | failed | ended`) with FK back to
  `workstations`. Indexes on `status`, `created_at`, and `project_id`.
- **Server â€” `tryDispatchVisualisation(runId, log)`**
  (`server/src/jobs/dispatcher.ts`): new exported function that picks
  an eligible agent purely by `workstation.is_enabled +
  workstation.can_visualise + slots_busy < slots` (no
  `supportedFormats` check â€” the visualiser stream is format-agnostic
  at this layer), sends the `startVisualisation` envelope over the
  existing agent WS session, and transitions the row to `importing`.
  No API caller wired yet â€” that's Phase G.
- **Agent config** (`agent/src/PRISM.Agent/Config/AgentConfig.cs`): four
  new fields persisted via the existing JSON write path â€”
  `UnrealEngineRoot` (default `C:\Program Files\Epic Games\UE_5.7\`),
  `UnrealTemplateTag` (default `v1.0.0-ue5.7`), `VisualiserMaxConcurrent`
  (default `1`), `VisualiserGpuCheck` (default `true`). `AgentControlPlane`
  applies them live (no agent restart required).
- **Agent web UI** (`agent/src/PRISM.Agent/WebUi/IndexHtml.cs`): new
  *Visualiser* card on the settings page rendered only when the
  `visualiser` role checkbox is on; binds to the four new config fields
  via `POST /api/config`. Matches the existing card styling and respects
  the light/dark CSS variables.
- **Tray SettingsForm** (`agent/src/PRISM.Agent/Tray/SettingsForm.cs`):
  matching *Visualiser* group box with the same four controls. Form
  border style raised to `Sizable` so the operator can resize past the
  default footprint when the role expands.
- **Agent WS dispatcher** (`agent/src/PRISM.Agent/Ws/AgentMessageDispatcher.cs`):
  `startVisualisation` and `cancelVisualisation` cases land, log a
  clear `WARN`, and ack with `Accepted = false, Reason = "visualiser
  orchestrator not yet implemented"`. These intentionally do nothing
  with the payload beyond logging â€” Phase F/G will replace this stub
  with a real `VisualiserSession` handoff and the reverse-channel
  `visualisationReady` / `visualisationFailed` envelopes.
- **Agent startup validation** (`agent/src/PRISM.Agent/AgentService.cs`):
  when `Visualiser` is in `Config.Roles`, the service now checks
  `Directory.Exists(Config.UnrealEngineRoot)` on startup and emits a
  loud `Log.Warning` (`Visualiser role enabled but UE root not found:
  ...`) if it's missing. The agent continues running so the other
  roles still work â€” the dispatcher filters this box out via
  `can_visualise` until the admin corrects the config.
- **Admin UI â€” `can_visualise` role pill**
  (`web/src/admin/pages/Workstations.vue`,
  `web/src/shared/api.ts`,
  `server/src/api/workstations.ts`): new toggle alongside
  `convert / layer / receive`, hits `PATCH /api/workstations/:id`
  with `canVisualise: boolean`. The pill uses the ORBIT primary
  fade token to stay visually distinct.
- **API key scopes**
  (`server/src/db/schema.ts`,
  `server/src/auth/{apiKey,principal,middleware}.ts`,
  `server/src/api/keys.ts`,
  `web/src/admin/pages/ApiKeys.vue`,
  `web/src/shared/api.ts`): `api_keys.scopes jsonb` is read into the
  request principal at auth time; new `requireScope(scope)` Fastify
  guard returns 403 unless the principal is an admin/ORBIT bearer or
  an API key with the scope present. `GET /api/keys/scopes` returns
  the canonical scope catalog (`visualiser:create_stream` for Phase
  A). The admin UI renders these as checkboxes on the create form
  plus an *Edit scopes* modal per row. Pre-Phase-A keys keep an empty
  list and explicitly do *not* inherit new scopes.

### Notes

- WS handlers return `accepted: false` until the orchestrator binary
  lands in Phase F. The whole release is *plumbing only* â€” admins can
  toggle workstations into the visualiser pool and configure UE
  settings on each agent, but the next dispatcher hop will hit the
  stub above and refuse the run cleanly.

---

## v0.1.36 â€” 2026-05-27 â€” Updater hotfix

> **Recovery note for v0.1.34 / v0.1.35 users:** the existing in-app
> updater **cannot** install v0.1.36 because of the same
> `ExtractToDirectory` bug it is meant to fix. You must **manually
> download** `PRISM.Agent-Setup-v0.1.36.exe` from
> [GitHub Releases](https://github.com/REBUS-ORBIT/prism-agent/releases/tag/v0.1.36)
> and run it. The installer cleanly replaces the running agent. After
> v0.1.36 is installed, all future in-app updates (tray "Check for
> Updates" and remote WS `update` requests) will work.

### Fixed

- **Critical: PowerShell extract call crashed on Windows PowerShell 5.1.**
  The updater script embedded in `agent/src/PRISM.Agent/Tray/Updater.cs`
  called
  `[IO.Compression.ZipFile]::ExtractToDirectory($zip, $installDir, $true)`,
  intending `$true` as the `overwriteFiles` argument. That 3-arg
  `(string, string, bool)` overload only exists on .NET Core 3.0+. The
  default `powershell.exe` (Windows PowerShell 5.1 / .NET Framework 4.x)
  loads the older `System.IO.Compression.FileSystem.dll`, which only
  has `(string, string, Encoding)`. PowerShell's method binder tried to
  coerce `$true` â†’ `System.Text.Encoding` and threw immediately
  (`Cannot convert value "True" to type "System.Text.Encoding"`). The
  agent then quietly relaunched the OLD binary, which on every "Update"
  click landed back in the same broken updater. **No v0.1.34 or v0.1.35
  in-app update has ever actually extracted anything.**
  Replaced with `Expand-Archive -LiteralPath $zip -DestinationPath
  $installDir -Force -ErrorAction Stop`, which has been overwrite-aware
  since PowerShell 5.0 and ships with every supported Windows.
- **Post-extract verification before relaunch.** The PS helper now
  `Test-Path`s `PRISM.Agent.exe` after extraction and reads its
  `ProductVersion` into the log so the operator can see the new version
  stamp before the relaunch line. If the EXE is missing, the script
  marks `$fatal = $true` and pauses the visible window so the user gets
  a real error message instead of having the old agent silently
  relaunched (and the next "Update" click landing in the same loop).

### Added

- **Concurrent-update guard** (`Updater.cs`): process-wide
  `SemaphoreSlim _updateGate = new(1, 1)` wraps the body of
  `DownloadAndInstallAsync`. `WaitAsync(0)` fails fast with
  `InvalidOperationException("Another update is already in progress on
  this agent.")` instead of queueing. Stops a remote (WS) and a local
  (tray "Check for Updates") update from racing on the same temp zip
  and install dir â€” a scenario that may have contributed to the
  "file is being used by another process" report on top of the primary
  `ExtractToDirectory` crash.
- **`Updater.IsUpdateInProgress`** public read-only probe so the tray
  menu and the WS dispatcher can short-circuit BEFORE touching GitHub
  Releases when an update is already running.
- **`UpdateOutcome.AlreadyRunning`** flag on
  `AgentControlPlane.CheckAndApplyUpdateAsync`. The agent's local
  HTTP listener (`AgentWebUi`) now returns **HTTP 409 Conflict** with
  `{ ok: false, alreadyRunning: true }` instead of the generic 502, so
  the server / admin UI can surface a "wait, then retry" message.
- **WS dispatcher** (`AgentMessageDispatcher.HandleUpdate`) now
  inspects the `UpdateOutcome` and logs `WARN` (not `ERROR`) on
  `alreadyRunning`, so a benign collision doesn't look like a real
  update failure in the agent log pipeline.
- **Tray UI** (`PrismTrayContext`): the "Check for Updates" menu
  short-circuits early when `Updater.IsUpdateInProgress` is true and
  shows a friendly "An update is already in progress" info dialog
  instead of racing into the GitHub fetch. `InstallUpdateAsync` also
  catches `InvalidOperationException` separately so a collision
  surfaces as an info dialog, not as the red `Update Error` box.

### Defensive

- **Stale-zip cleanup** at the top of `DownloadAndInstallCoreAsync`:
  any leftover `%TEMP%\PRISM.Agent.Update.zip` from a previous
  interrupted attempt is `File.Delete`d before the new download
  opens its FileStream. Removes one cause of "file is being used by
  another process" errors when antivirus or a partial-download
  handle was still pinning the stale file.
- **`FileShare.Read` on the writing FileStream**
  (`new FileStream(tempZip, FileMode.Create, FileAccess.Write,
  FileShare.Read)`): antivirus / Defender can stream-scan the partial
  zip without producing a sharing-violation against our write.
- **Tighter `await using` scope** around the network + filesystem
  handles so they're disposed immediately after the download loop
  ends rather than at method exit, well before the PowerShell helper
  is spawned. Eliminates one race-condition surface from the FATAL
  post-mortem flow.

### Files touched

- `agent/src/PRISM.Agent/Tray/Updater.cs` â€” the PowerShell here-string
  (extract + verification), `SemaphoreSlim` gate, stale-zip delete,
  `FileShare.Read`, scoped streams.
- `agent/src/PRISM.Agent/AgentControlPlane.cs` â€” `UpdateOutcome` record
  gains `AlreadyRunning`; `CheckAndApplyUpdateAsync` short-circuits on
  `Updater.IsUpdateInProgress` and catches `InvalidOperationException`
  from the background `Task.Run`.
- `agent/src/PRISM.Agent/Ws/AgentMessageDispatcher.cs` â€” `HandleUpdate`
  inspects the outcome and logs WARN for benign already-running races.
- `agent/src/PRISM.Agent/Tray/PrismTrayContext.cs` â€” `OnCheckUpdate`
  early-return + `InstallUpdateAsync` `InvalidOperationException`
  branch.
- `agent/src/PRISM.Agent/WebUi/AgentWebUi.cs` â€” `POST /api/agent/update`
  returns 409 with `alreadyRunning: true` when a download is in flight.
- `agent/src/PRISM.Agent/PRISM.Agent.csproj` â€” version bumped
  `0.1.35` â†’ `0.1.36` (all four fields).

---

## v0.1.35 â€” 2026-05-27

PRISM logo branding across every agent surface a user sees: Windows
Explorer / Task Manager / taskbar entry, Alt-Tab thumbnail, system-tray
icon, the local web UI header, and the Start Menu + Desktop shortcuts
created by the wizard installer. No behavioural changes â€” the WS
protocol, scheduled task, updater, and Rhino pipeline are byte-for-byte
identical to v0.1.34.

### Added

- **Multi-resolution `PRISM.Agent.ico`**
  (`agent/src/PRISM.Agent/Assets/PRISM.Agent.ico`): brand-new asset
  generated from `PRISM/prism-logo.png` via `tools/make-ico.ps1`.
  Six PNG-compressed frames baked in at 16/32/48/64/128/256 px so
  every Windows shell consumer (16 px tray, 32 px window title bar,
  48 px Explorer "Large icons", 256 px "Extra large" + "Tile") picks
  up a crisp render without bilinear-stretching a single-size icon.
  Total file 78,672 bytes. Generator is pure PowerShell + `System.Drawing`
  so it runs on any Windows dev box without ImageMagick/Chocolatey.
- **Agent EXE carries the brand icon**
  (`agent/src/PRISM.Agent/PRISM.Agent.csproj`):
  `<ApplicationIcon>Assets\PRISM.Agent.ico</ApplicationIcon>` bakes the
  multi-res `.ico` into the PE resource table. Explorer, Task Manager,
  Alt-Tab, the Windows 11 taskbar, and the Inno Setup uninstall entry
  (`UninstallDisplayIcon={app}\PRISM.Agent.exe`) all auto-pick it up
  from the executable's own resources.
- **Side-by-side `Assets/` content** (csproj `<Content Include>` items
  with `CopyToOutputDirectory=PreserveNewest`): both `PRISM.Agent.ico`
  and `prism-logo.png` ship next to `PRISM.Agent.exe` in the publish
  output so the tray-icon loader, the web UI's data-URL substitution,
  and the installer's shortcut `IconFilename:` parameter can all read
  from disk at runtime.
- **PRISM logo in the agent web UI header**
  (`agent/src/PRISM.Agent/WebUi/IndexHtml.cs` +
  `WebUi/AgentWebUi.cs`): the header now opens with an `<img>` tag
  whose `src` is a `data:image/png;base64,â€¦` URL. `AgentWebUi` reads
  `Assets/prism-logo.png` once on first request, base64-encodes it,
  and caches the rendered HTML for the process lifetime via a
  `Lazy<string>`. The 91 KB PNG becomes ~122 KB inline â€” still a
  rounding error on the agent's localhost loopback. Falls back to an
  empty `src` if the asset is missing, in which case the page hides
  the broken-image glyph via `img[src=""] { display: none; }`.
- **Inno Setup `IconFilename:` on every shortcut**
  (`agent/install/PRISM.Agent.iss`): Start Menu "PRISM Agent",
  Start Menu "PRISM Agent Web UI", and the optional desktop shortcut
  all explicitly target `{app}\Assets\PRISM.Agent.ico`. Crucial for
  the Web UI shortcut, whose `Filename:` is `http://localhost:7421/`
  â€” Windows would otherwise render the default browser icon and the
  shortcut would be visually indistinguishable from any other
  bookmark. The Start Menu group as a whole now reads as a coherent
  PRISM-branded entry.
- **Inno Setup `SetupIconFile=...PRISM.Agent.ico`**
  (`agent/install/PRISM.Agent.iss`): the wizard executable
  (`PRISM.Agent-Setup-v0.1.35.exe`) and the wizard window's
  title-bar icon now both show the PRISM logo. Path is relative to
  the `.iss` file, so CI's `ISCC.exe` resolves it against
  `agent/install/`.
- **`tools/make-ico.ps1`** (new): repeatable, ImageMagick-free ICO
  generator used to produce `Assets/PRISM.Agent.ico`. Loads the
  source PNG via `System.Drawing.Image.FromFile`, rasterises each
  requested size with `HighQualityBicubic` interpolation, encodes
  each frame as PNG, and writes a hand-rolled `ICONDIR` + N Ã—
  `ICONDIRENTRY` + payload container so the .ico stays compact
  (~80 KB instead of >250 KB the all-BMP fallback would produce).
  Re-run when the upstream `PRISM/prism-logo.png` changes.

### Changed

- **Tray icon now shows the PRISM logo at every state**
  (`agent/src/PRISM.Agent/Tray/PrismTrayContext.cs`): the v0.1.34 and
  earlier amber/green/grey coloured-circle state machine has been
  retired. The tray icon loads `Assets/PRISM.Agent.ico` from
  `AppContext.BaseDirectory` and uses it unchanged for the
  Connected, Connecting, and Stopped states. Connection state stays
  discoverable through the existing tooltip ("PRISM Agent â€”
  Connected / Connectingâ€¦ / Stopped") and the disabled
  `Status: â€¦` menu item; both already update on every WS reconnect /
  disconnect event. The amber-circle fallback is preserved as
  `LoadLogoIcon()`'s exception/missing-file branch so the tray never
  starts without an icon. Honours the v0.1.34 `SessionId == 0`
  headless guard â€” `PrismTrayContext` is only constructed in
  interactive sessions, and `LoadLogoIcon()` is invoked from the
  type initialiser as part of that construction.

### Notes

- **Existing v0.1.34 agents need exactly one update cycle to migrate.**
  The new `Assets/` folder, the updated tray icon, and the inline
  web-UI logo all live in the v0.1.35 publish payload â€” the in-app
  updater (`Updater.DownloadAndInstallAsync`) extracts the zip on
  top of the install dir, so the assets land in
  `C:\Program Files\PRISM.Agent\Assets\` automatically after the
  next successful update. No manual reinstall needed.
- **The new tray icon will not appear on an already-running v0.1.35
  agent until it restarts.** Static-readonly icon fields are bound
  at JIT-init of `PrismTrayContext`; the only way to refresh
  `NotifyIcon.Icon` on a live process is a process restart. The
  built-in `Restart` button on the web UI and the scheduled-task
  auto-relaunch both handle this.
- **No code-signing** still â€” same posture as v0.1.34 (parked).
- **No DB schema changes, no protocol changes, no server changes.**
  The server image is rebuilt by `server-image` CI because the
  workflow's path filter includes `agent/install/**`, but the
  rebuilt image is byte-equivalent to the v0.1.34 server image in
  every behaviour.

---

## v0.1.34 â€” 2026-05-27

UX + resilience pass on the in-app updater. Triggered by a v0.1.32
field report from RB-DA2-PC02 ("agent closes but there is no install
window pop up") that the diagnostic subagent traced to the v0.1.32
silent-by-design PowerShell helper â€” not to Windows Defender. **No
code-signing in this release**: Defender was conclusively ruled out
(zero quarantine/block events for `PRISM.Agent.exe` or the update
zip across the entire log history on PC02), so AD CS signing is
parked for a future cycle.

### Added

- **Agent â€” visible "Update available" dialog**
  (`agent/.../Tray/UpdateAvailableDialog.cs`): replaces the v0.1.32
  bare-`MessageBox` Yes/No prompt with a proper WinForms dialog that
  shows the new tag, current version, download size (parsed from
  `assets[].size` on the GitHub release JSON), and a scrollable
  preview of the release `body` (release notes). Buttons are
  `Update now` / `Cancel`; `Esc` and the X both cancel safely.
- **Agent â€” visible "Updatingâ€¦" progress form**
  (`agent/.../Tray/UpdateProgressForm.cs`): non-modal progress dialog
  shown while `Updater.DownloadAndInstallAsync` runs.  Wired to the
  existing `IProgress<int>` so the bar tracks real download bytes
  (not just a marquee); flips to indeterminate marquee right before
  `Application.Exit()` so the user sees the handoff to the
  PowerShell helper instead of a dead-looking window.
- **Agent â€” visible PowerShell helper window**
  (`Tray/Updater.cs`): the post-`Application.Exit` extract/relaunch
  PowerShell child now runs with `CreateNoWindow=false` /
  `WindowStyle=Normal` and mirrors every step line to `Write-Host`
  (in addition to the durable `%TEMP%\PRISM.Agent.Update.log` file
  the diagnostic-on-next-startup hook already inspected). The user
  sees `update script started â†’ waiting for agent pid N to exit â†’
  agent exited â†’ extracting â€¦ â†’ extraction complete â†’ launching new
  agent â†’ launched` while it happens. On any `FATAL` line the
  console pauses with `Read-Host 'Press Enter to close'` so the
  operator can copy the diagnostic instead of watching the window
  vanish. On the happy path it auto-closes a couple of seconds
  after `launched`. Pre-v0.1.34 used `CreateNoWindow=true` /
  `-WindowStyle Hidden`, which was the proximate cause of the
  RB-DA2-PC02 user report.
- **Agent â€” post-update tray balloon**
  (`Tray/PrismTrayContext.cs` + `Tray/Updater.cs`): on startup the
  tray now checks `Updater.ConsumeLastUpdateSuccess()` and, when the
  marker file matches the running assembly version, fires
  `NotifyIcon.ShowBalloonTip(8000, "PRISM Agent updated", "Now
  running v{currentVersion} ({tag}).", ToolTipIcon.Info)` ~2.5 s
  after the icon is realised. The marker is read-and-delete so the
  balloon fires exactly once per actual upgrade.
- **Agent â€” `Updater.ConsumeLastUpdateSuccess()` + NewVersion
  marker** (`Tray/Updater.cs`): `DownloadAndInstallAsync` now stashes
  the target tag in `%TEMP%\PRISM.Agent.Update.NewVersion` BEFORE
  calling `Application.Exit()`, so the relaunched agent can show the
  post-update balloon without grep-ing the diagnostic log. Stale
  markers (older than 10 min) or markers whose recorded version
  doesn't match the running assembly are deleted silently.
- **Agent â€” scheduled-task `AtStartup` trigger**
  (`agent/install/install.ps1`): the `PRISM.Agent` task now carries
  two triggers â€” the existing `AtLogOn -User <currentUser>` plus a
  new `AtStartup`. Combined with the pre-existing `RestartCount=3` /
  `RestartInterval=1m` settings, this means a botched updater that
  exits without successfully relaunching the new agent gets up to
  three additional restart attempts at 1-minute intervals from
  Task Scheduler, AND another shot at boot. Run level remains
  `Highest`; logon type remains `Interactive` (preserving the
  existing principal â€” no LogonType change required).
- **Agent â€” session 0 guard** (`Program.cs`): if the agent is ever
  launched in session 0 (no interactive desktop â€” for example when
  the `AtStartup` trigger is reconfigured to fire pre-logon via
  `S4U` / `Password` logon type), the process forces headless mode
  so the WS + HTTP services still come up cleanly without
  attempting to create a tray icon or message boxes that would
  throw on session 0. Defensive insurance â€” the shipped principal
  is still `Interactive`, so the guard is a no-op on standard
  installs.

### Changed

- **Agent â€” `Updater.UpdateInfo` carries SizeBytes + Notes**
  (`Tray/Updater.cs`): `CheckForUpdateAsync` now also parses the zip
  asset's `size` field and the release `body` field so the
  "Update available" dialog can render real numbers and the GitHub
  release notes without making a second API call. Both fields are
  optional and `null` when the release JSON omits them.

### Notes

- **First update from v0.1.32 / v0.1.33 â†’ v0.1.34 still uses the
  OLD silent updater.** The visible-window + tray-balloon + richer
  prompt only applies to updates from v0.1.34 onwards, because the
  updater that runs is whichever one is baked into the currently
  installed agent. Existing workstations will get the "click and
  hope" experience exactly once more (one final silent update) and
  every subsequent update will show the new UI. There is no way
  around this without manually reinstalling v0.1.34 via the wizard
  installer (`PRISM.Agent-Setup-v0.1.34.exe`).
- **No code-signing** in this release. The PC02 diagnostic
  (`agent-transcripts/.../5ecfd18c-...`) showed no Windows Defender
  involvement in the original "no install window" report â€” the
  fix is squarely a UX / visibility one. AD CS signing remains
  parked for a future release where there's a real Authenticode-
  related symptom to address.
- The new visible PowerShell window is unsigned (everything that
  the agent already runs is unsigned). On workstations where IT
  policy blocks unsigned scripts, the helper is still invoked with
  `-ExecutionPolicy Bypass` from the parent process, matching the
  v0.1.32â€“v0.1.33 behaviour.

---

## v0.1.33 â€” 2026-05-27

Adds **remote restart** and **remote update** controls. Admins no longer
have to RDP into a workstation to kick the agent or to make it pull the
latest GitHub release â€” both actions are reachable from the PRISM admin
Workstations page and from the agent's own web UI.

### Added

- **Agent protocol** (`shared/contracts/agent-protocol.{json,ts}` +
  `shared/contracts/AgentProtocol.cs`): two new server -> agent message
  types â€” `restart` (optional `reason`) and `update` (optional `tag`
  to pin a release). Older agents (pre-v0.1.33) silently ignore them.

- **Agent â€” local web UI** (`PRISM/agent/.../WebUi/`): new
  `POST /api/agent/restart` and `POST /api/agent/update` endpoints,
  surfaced as **Check for updates** + **Restart agent** buttons in a
  new "Agent lifecycle" card at the bottom of `http://<host>:7421/`.
  The update endpoint returns either `{ok, downloading: false,
  version}` when already on the latest tag, or `{ok, downloading:
  true, tag}` while it pulls the new zip in the background.

- **Agent â€” WS handler** (`PRISM/agent/.../Ws/AgentMessageDispatcher.cs`):
  inbound `restart` / `update` envelopes are routed to
  `AgentControlPlane.RestartAsync` / `CheckAndApplyUpdateAsync`. The
  same methods back both the local HTTP endpoints and the admin-driven
  WS commands, so there is exactly one code path per action.

- **Agent â€” `AgentControlPlane`**: `RestartAsync` schedules a tiny
  hidden PowerShell helper that waits for the agent's PID to exit and
  then relaunches `PRISM.Agent.exe` (same pattern as the in-app
  updater), then exits with code 2 so the Scheduled Task's
  `RestartCount=3` also fires as a belt-and-braces fallback.
  `CheckAndApplyUpdateAsync` reuses
  `Updater.CheckForUpdateAsync` + `DownloadAndInstallAsync` exactly as
  the tray menu does â€” including the v0.1.32 `IsInstallDirWritable`
  pre-flight and `%TEMP%\PRISM.Agent.Update.log` diagnostic trail.

- **Server â€” admin API** (`PRISM/server/src/api/workstations.ts`):
  `POST /api/workstations/:id/restart` and
  `POST /api/workstations/:id/update` (admin session required).
  Look the workstation up by id, find the live agent in
  `sessionRegistry` by machineId, dispatch the WS envelope, and
  return `{queued: true}`. 404 if the workstation row is unknown,
  503 if no agent is currently connected. The update endpoint
  optionally accepts `{tag: "v0.1.33"}` to pin a release.

- **Server â€” outbound dispatchers**
  (`PRISM/server/src/ws/agentProtocol.ts`): new `sendRestartToAgent` /
  `sendUpdateToAgent` helpers wrap the `sessionRegistry` lookup +
  `socket.send(JSON.stringify(envelope(...)))` pattern that the job
  dispatcher uses, so the admin routes don't reach into WS plumbing
  directly.

- **Web â€” typed client** (`web/src/shared/api.ts`):
  `workstationsApi.restart(id, reason?)` and
  `workstationsApi.updateAgent(id, tag?)` helpers. The admin
  Workstations page wires per-row buttons in a follow-up commit.

### Notes

- Existing **v0.1.32 agents** stay connected after this server deploy
  but won't act on `restart` / `update` envelopes (unknown message
  types are silently ignored). The admin buttons will still return
  `{queued: true}` against them; nothing happens on the workstation
  until that agent is upgraded to v0.1.33 (one-time, via the in-app
  updater or the GitHub release wizard installer). Same pattern as
  the v0.1.32 update-installer rollout documented above.

- The agent's own web UI works against any agent v0.1.33+ regardless
  of server version â€” the buttons hit the local HTTP listener directly.

---

## v0.1.32 â€” 2026-05-26

Fix the in-app updater silently failing on workstations whose interactive
user is not a local administrator. Symptom: clicking **Check for updates â†’
Yes** flashed a CMD/PowerShell window for ~1 s and then nothing happened
(version unchanged, tray came back at the old version after the scheduled
task auto-restarted).

### Fixed

- **Auto-update silently fails on Program Files (ACL)**: the elevated
  PowerShell child process spawned by `Updater.cs` couldn't write to
  `C:\Program Files\PRISM.Agent` because the interactive user wasn't a
  local administrator (the scheduled task's `RunLevel=Highest` only
  promotes admin users; standard users stay standard). Two-pronged fix:
  - **Pre-grant `BUILTIN\Users:(OI)(CI)M` on `$InstallDir`** in
    `install.ps1` via `icacls /grant *S-1-5-32-545:(OI)(CI)M /T`. After
    install (or re-running the wizard once), the agent's PowerShell
    child can extract the new zip on top of Program Files without
    elevation.
  - **`Updater.IsInstallDirWritable()` pre-flight check** before
    downloading: if the install dir is read-only the updater throws a
    clear `UnauthorizedAccessException` ("Please re-run
    PRISM.Agent-Setup.exe (run as administrator) once...") that the
    tray surfaces via `MessageBox`. No more silent CMD-flash mystery.
- **Brief CMD/console flash before update**: the spawned PowerShell
  used `-WindowStyle Hidden`, which only hides the window *after* it's
  created â€” there was always a 0.5â€“1 s flash. Switched to
  `ProcessStartInfo.CreateNoWindow = true`, which the kernel applies
  before any console host appears. Update now runs fully silently.
- **Updater script logs to `%TEMP%\PRISM.Agent.Update.log`**: the
  PowerShell update script now wraps every step in `try/catch` and
  appends timestamped status lines (`update script started`, `waiting
  for agent pid N to exit`, `extracting ...`, `extraction complete`,
  `launched`, plus `FATAL: <message>` on any error). The next agent
  startup checks this log and, if it contains a fatal/error and is
  less than 10 minutes old, surfaces it via the agent's structured
  logger so the failure shows up in the tray Logs window and
  `prism-agent.log`.

### Notes

- For workstations already on v0.1.31 with a non-admin login user, the
  in-app update to v0.1.32 will fail with the new clear error message.
  Re-run **PRISM.Agent-Setup-v0.1.32.exe** (right-click â†’ Run as
  administrator) once to apply the ACL grant. From v0.1.32 onward,
  every future update goes through cleanly without elevation.

---

## v0.1.31 â€” 2026-05-26

Web UI hardening: fixes the Save â†’ 500 ACL crash, makes LAN access work
out of the box, restyles the page to match the PRISM admin UI, and adds
proper Start Menu shortcuts.

### Fixed

- **agent-config save 500 (`Access to the path '...agent-config.json' is
  denied`)**: the scheduled task runs as the interactive workstation
  user, which on most Rhino boxes is *not* a local administrator and
  therefore cannot write to `C:\Program Files\PRISM.Agent\`. The
  config now lives at `C:\ProgramData\PRISM.Agent\agent-config.json`
  (user-writable). `Load()` checks ProgramData first and falls back to
  the legacy Program Files path; `Save()` always targets ProgramData
  and best-effort deletes a stale legacy file. A
  `UnauthorizedAccessException` on save falls through to
  `%LOCALAPPDATA%\PRISM.Agent\agent-config.json` so the agent never
  silently drops an operator's edit on locked-down boxes.

- **install.ps1**: writes the initial `agent-config.json` to ProgramData
  instead of Program Files; auto-migrates an existing legacy config on
  upgrade; runs `icacls` to ensure Authenticated Users have Modify on
  `C:\ProgramData\PRISM.Agent\`.

### Changed

- **LAN access default** (`webUiBindAll: true`): the agent now binds the
  web UI to `http://+:7421/` out of the box so operators can configure
  any workstation from a browser tab on a different machine.
  `install.ps1` pre-registers a URL ACL
  (`netsh http add urlacl url=http://+:7421/ user="NT AUTHORITY\Authenticated Users"`)
  and a `New-NetFirewallRule` so the (non-elevated) agent can bind and
  the LAN can reach it. Pass `-WebUiLocalhostOnly` to skip both for
  hardened deploys; `uninstall.ps1` reverses both.

- **web UI styling**: rebuilt the embedded HTML/CSS to mirror
  `web/src/shared/designSystem.css` exactly -- ORBIT primary `#e06238`
  on neutral foundation greys, light + dark themes via
  `[data-theme="dark"]` on `<html>`, theme choice persisted under the
  same `prism.theme` localStorage key the SPA uses, header logo +
  status pill, card layout, monospaced format chips. The page now
  visually belongs in the same family as the admin pages at
  `prism.rebus.industries`.

- **Inno installer (`PRISM.Agent.iss`)**: adds proper Start Menu
  shortcuts (`PRISM Agent` â†’ launches the tray app, `Web UI` â†’ opens
  the browser page, `Uninstall PRISM Agent`) and an optional Desktop
  shortcut behind a `[Tasks]` checkbox (default off). `AllowNoIcons=no`
  guarantees the Start Menu group is created.

### Added

- **install.ps1**: `-WebUiPort` and `-WebUiLocalhostOnly` parameters so
  unattended deploys can pick the bind port and disable LAN access in
  one shot.

---

## v0.1.30 â€” 2026-05-26

Adds a real Windows wizard installer (`PRISM.Agent-Setup-vX.Y.Z.exe`,
built with Inno Setup) so workstation install no longer requires
"download zip â†’ unblock â†’ expand â†’ invoke install.ps1" plumbing.

### Added

- **wizard installer** (`PRISM/agent/install/PRISM.Agent.iss`): Inno
  Setup script that wraps the multi-file publish payload + `install.ps1`
  + `uninstall.ps1` into a single signed .exe. Wizard pages: install
  dir picker, **PRISM connection settings** (server URL / node name /
  slots, with sensible defaults and validation), and a finish page with
  optional "open web UI" / "launch agent" checkboxes. Upgrades preserve
  the existing `agent-config.json`. AppId is fixed
  (`{8F3D9A12-7E5C-4B11-A0F2-9D1E3C7B5142}`) so reinstalls and version
  bumps perform in-place upgrades. The wizard runs
  `install.ps1 -LaunchNow` under the hood, so post-install state matches
  the legacy zip flow exactly (same scheduled task, same config file
  shape, same `webUiPort`/`webUiBindAll` defaults).

### Changed

- **CI** (`.github/workflows/agent.yml`): `windows-latest` runner now
  also compiles the .iss script (Inno Setup is pre-installed there;
  Chocolatey fallback in case it isn't) and attaches the resulting
  `PRISM.Agent-Setup-v*.exe` to the GH release alongside the zip. The
  zip is uploaded **first** so it lands as `assets[0]` for older agents
  whose Updater blindly grabs `assets[0]`. New `Sign installer` step
  signs the wrapper .exe when `CODE_SIGN_CERT` / `CODE_SIGN_PASSWORD`
  secrets are configured.

- **install.ps1**: now idempotent for the in-place case (skips the
  payload copy when invoked from inside the install dir, which is what
  the Inno wizard does). On upgrade, preserves `agent-config.json`
  unless `-ForceConfig` is passed. Default config now writes the new
  `webUiPort` / `webUiBindAll` keys and the full `roles` array.

- **uninstall.ps1**: new `-NoFileCleanup` switch lets the host
  uninstaller (Inno's `[UninstallDelete]`) own the on-disk wipe so the
  script cannot self-delete its own parent directory mid-run.

### Fixed

- **Updater**: `CheckForUpdateAsync` now picks the `.zip` asset by
  filename instead of blindly grabbing `assets[0]`, so a release that
  carries both `PRISM.Agent-v*.zip` and `PRISM.Agent-Setup-v*.exe` no
  longer breaks in-app self-update if the upload order changes.

---

## v0.1.29 â€” 2026-05-26

Gives the agent a local **web UI** so operators can configure all
settings and pause/resume the watcher from a browser instead of
RDP-ing into each workstation to use the WinForms tray. Also fixes
the heartbeat that has been reporting `slotsBusy=0` since phase 3.

### Added

- **agent web UI** (`PRISM/agent/.../WebUi/`): the agent now serves a
  single-page configuration site on `http://localhost:7421/` (right-click
  the tray icon â†’ **ðŸŒ Open Web UI**). Backed by a tiny `HttpListener`
  hosted service plus an `AgentControlPlane` singleton that the tray + the
  web UI both mutate, so `nodeName`, `slots`, `roles`, watcher pause/resume,
  Rhino version, log dir, and the web UI's own `webUiPort` /
  `webUiBindAll` flags can all be edited live. Routes:
  `GET /api/state`, `POST /api/config`, `POST /api/watcher/pause|resume`,
  `GET /api/logs?n=N`. Live-applied (no restart): `nodeName`, `slots`,
  `roles`, `logDir`. Restart-required: `prismUrl`, `rhinoVersion`,
  `webUiPort`, `webUiBindAll`. Defaults to `localhost`-only binding;
  flip `webUiBindAll: true` to expose on the LAN (no auth).

### Fixed

- **agent heartbeat**: `HeartbeatData.slotsBusy` now reports the real
  `WorkerSlotPool.BusyCount` instead of the hard-coded `0` placeholder
  left in since the phase 3 scaffold, so the admin dashboard's
  concurrency stat finally matches reality.

- **install docs**: `AGENT_INSTALL.md` download link now points at
  `REBUS-ORBIT/prism-agent/releases/latest` (matches the in-app
  Updater's poll URL).

---

## v0.1.28 â€” 2026-05-26

Adds the `prism-assimp` pre-conversion sidecar so uploads in the
glTF/Collada/Blender/USDZ/DirectX/PLY/STL family no longer get rejected
at the validation gate. The sidecar lives next to `prism-server` in the
compose stack, accepts the source file over HTTP, and returns an
OBJ+MTL+textures zip that the existing Rhino agent path already knows
how to ingest.

### Added

- **assimp service** (`PRISM/assimp/`): new FastAPI app shipped as
  `ghcr.io/rebus-orbit/prism-assimp:latest`, multi-stage Docker image
  built on Debian bookworm + libassimp 5.4.3 from source +
  Python 3.11 + pyassimp 4.1.4. Exposes `GET /health`,
  `GET /v1/formats`, and `POST /v1/preconvert` (multipart with
  `file`, `target_unit`, optional `bundle.zip`, `return_mode=stream|json`).
- **server (api / conversion)**: `PRISM/server/src/conversion/preconvert.ts`
  is a small dispatcher that recognises Assimp-eligible extensions
  (`.gltf .glb .dae .blend .x .usdz .ply .stl`), POSTs the upload to
  `${ASSIMP_SERVICE_URL}/v1/preconvert` (with `return_mode=stream`),
  saves the resulting zip into `UPLOAD_DIR`, unlinks the original, and
  returns a `preconvertMeta` summary that gets stored under
  `jobs.options.preconvert` so the admin UI can still show "you uploaded
  a .glb" while the agent works against the .zip on the job row.
  `PRISM/server/src/api/convert.ts` extends `SUPPORTED_EXTS` and runs
  this between the upload and the BullMQ enqueue. The `preconvert`
  stage also lights up in the static pipeline topology so the admin
  Pipeline view renders it.
- **infra**: `infra/docker-compose.yml` adds a `prism-assimp` service
  (image `ghcr.io/rebus-orbit/prism-assimp:${PRISM_ASSIMP_TAG:-latest}`,
  curl-based healthcheck on `:8088/health`, `prism-assimp-work` named
  volume on `/work`). `prism-server` now defaults `ASSIMP_SERVICE_URL`
  to the in-network compose URL (`http://prism-assimp:8088`); leaving
  the env var explicitly empty disables the pre-conversion path
  entirely and falls back to the previous "validation rejects this
  extension" behaviour.
- **CI**: `.github/workflows/assimp.yml` builds + pushes the sidecar
  image to GHCR on changes under `assimp/**`, then deploys via the
  LAN-local self-hosted runner (`[self-hosted, prism-deploy]`) using
  the same `ssh prism-prod` alias as `server.yml`. Both `server.yml`
  and `assimp.yml` deploy steps now also `scp infra/docker-compose.yml`
  to `/opt/prism/` (which is not a git checkout on the VM) so future
  service-list changes actually apply.

### Fixed

- **assimp service**: cold-start crashed five different ways before
  reaching steady state -- captured here so the next
  Python-FastAPI-pyassimp service can skip ahead:
  `LOG_LEVEL=info` (lowercase, from the orchestrator default) crashes
  `logging.basicConfig` (case-sensitive), so it's `.upper()`-d on
  startup; FastAPI rejects the `JSONResponse | FileResponse` union
  return on `/v1/preconvert` so the route declares
  `response_model=None`; pyassimp 4.1.4 imports stdlib `distutils`
  which Python 3.12 removed (PEP 632), so the runtime stage pins
  `python:3.11-slim-bookworm`; pyassimp's `Scene` is not a context
  manager, so the converter uses the documented `try/finally +
  pyassimp.release(scene)` pattern; pyassimp 4.1.4's
  `node.transformation` numpy view of `aiMatrix4x4` is shifted in
  memory and even identity matrices come back corrupt, so the
  converter asks Assimp to bake every node's world transform into
  the mesh vertices themselves
  (`aiProcess_PreTransformVertices`) and uses identity for all
  per-leaf transforms. Trade-off: layer hierarchy degrades to "one
  OBJ group per scene mesh" until pyassimp's matrix decode is fixed.
- **assimp service â€” Collada validator + error reporting**:
  `aiProcess_ValidateDataStructure` was rejecting valid
  Rhino-exported Collada files (e.g. duplicate camera names from
  `View-Front`/`View-Top`/`View-Right`/`View-Front` duplicates),
  surfacing as a generic `pyassimp.AssimpError("Could not import
  file!")`. Dropped the validator from the default flag set and
  added an `_assimp_last_error()` helper that calls
  `aiGetErrorString` over ctypes so the orchestrator now sees the
  real `libassimp` reason in the exception message.
- **assimp service â€” Collada layer names**: Rhino exports its
  layer names on `<node name="Brep">`-style attributes, but
  Assimp's Collada loader puts the synthetic `<node id="...">`
  GUID in `aiNode.mName` and pyassimp 4.1.4 then truncates that
  by 4-8 characters on top, so the layer picker rendered six
  UUID-looking strings per upload. Two-part fix: `layers.py` now
  parses the Collada XML directly with stdlib
  `xml.etree.ElementTree`, walking *every* `<node>` (including
  those parked under `<library_nodes>` for block / instance
  definitions) to build a `geometry-id -> human node-name` map,
  and `walk_leaves` does suffix-match lookup against that map to
  paper over pyassimp's truncation bug. Result for the standard
  Rhino test export: layer picker shows `Default / Brep /
  Extrusion / Brep_1 / Extrusion_1 / Brep_2` instead of the
  previous UUID soup. Other formats fall back to the corrected
  `decode_aistring()` helper that reads the C `aiString` layout
  properly via raw `ctypes.addressof`.

---

## v0.1.27 â€” 2026-05-26

Consolidation release. Bakes in every hotpatch carried by VM 211 and PC02
since v0.1.26 so we have a clean rollback target.

### Fixed

- **server (ws)**: `progress` handler no longer downgrades a job that has
  already reached a terminal state. Previously a fire-and-forget
  `progress?.Report(("Done", 100))` from the Rhino connector could land
  *after* the `Complete` message and clobber `jobs.status` from `complete`
  back to `processing`, leaving the UI spinning forever on jobs that
  actually succeeded. `PRISM/server/src/ws/agentProtocol.ts` now adds
  `notInArray(jobs.status, ['complete','failed','cancelled'])` to the
  progress UPDATE and bails out (with a debug log) when 0 rows match.
- **server (api)**: `swapYZ`, `selectLayers`, and `includeLayerDescendants`
  now parse correctly. `z.coerce.boolean()` was treating the string
  `"false"` posted by the form as truthy (any non-empty string coerces to
  `true`), so unchecking the Y/Z swap checkbox in the convert UI silently
  re-enabled the rotation. Replaced with a `formBool()` preprocess that
  string-compares case-insensitively to `"true"` before coercion in both
  `PRISM/server/src/api/convert.ts` and `PRISM/server/src/v1/routes.ts`.
- **agent (connector / vendor SDK)**: zero-valued numeric properties on
  geometry DTOs (e.g. `Point.Y = 0.0`) were being dropped on the wire by
  `DefaultValueHandling.Ignore`. For DWG geometry on the XZ-plane after
  the Y/Z swap that meant every `Line.start/.end` arrived without a `y`
  key, which the viewer rendered as `NaN` (i.e. invisible). Flipped
  `OrbitJsonSettings.Default` to `DefaultValueHandling.Include`.
- **agent (connector / vendor SDK)**: 16 geometry / primitive / proxy
  DTOs were inheriting the generic `OrbitBase.OrbitType`, so they
  serialised with `speckle_type = "Objects.Base"` and the viewer fell
  back to its dumb-renderer path. Added explicit `OrbitType` overrides
  on `Line`, `Polyline`, `Arc`, `Circle`, `NurbsCurve`, `PolyCurve`,
  `Plane`, `Surface`, `PointCloud`, `Interval`, `Vector3d`, `Transform`,
  `DefinitionProxy`, `RenderMaterialProxy`, `GroupProxy`, `ColorProxy`.

### Changed

- **agent (connector)**: deduplication phase rewritten to run the HEAD
  probes in parallel chunks of 16 with continuous progress reporting.
  A representative DWG with 6 137 objects went from ~8 minutes of silent
  "checking serverâ€¦" (sequential HEAD requests over ~80 ms RTT) down to
  ~30 seconds with a visible `Checking serverâ€¦ N/M (K new)` ticker.
  Also dropped the redundant `progress?.Report(("Done", 100))` at the
  end of `SendAsync` that was racing the `Complete` message.

### Added

- **agent (Rhino)**: `SiblingTextureHydrator`. When `FileFbx.Read` returns
  a doc with `Materials.Count == 0` but textures are sitting next to the
  FBX inside the extracted .zip bundle (common pattern for "FBX + textures
  in a folder" exports out of DCC tools), the agent now synthesises a PBR
  material from sibling files matching `*baseColor*`, `*albedo*`,
  `*diffuse*`, `*normal*`, `*roughness*`, `*metallic*` etc. and assigns
  it to every imported object. Wired in from `RhinoFileOpener` after a
  successful read.
- **web (admin)**: dedicated `/admin/logs` page with API-call log
  streaming. Replaces the earlier floating-panel prototype. Admin-only,
  shows last N requests with status, duration, and principal.

### Submodule

- `vendor/orbit-monorepo` â†’ `e942678` on `prism-connector-fixes`.
  Carries the three connector / SDK fixes above (parallel dedup +
  late-progress drop + `DefaultValueHandling.Include` + `OrbitType`
  overrides).

### Notes

This release replaces the hotpatched DLLs on PC02 and the manually-built
`prism-server:local` image on VM 211. After deploying `v0.1.27`:

- `ghcr.io/rebus-orbit/prism-server:v0.1.27` is the canonical server image.
- `PRISM.Agent-v0.1.27.zip` (from the `REBUS-ORBIT/prism-agent` release)
  is the canonical agent installer; re-run `install.ps1` on PC02.

---

## v0.1.26 â€” 2026-05-25

### Fixed

- **agent**: `swap_yz` matrix flipped from `Rx(-90Â°)` to `Rx(+90Â°)`
  (`PRISM/agent/src/PRISM.Agent/Pipeline/RhinoAxisSwap.cs`). With our standard
  Y-up OBJ test bundle, `Rx(-90Â°)` from v0.1.25 landed the model upside-down.
  `Rx(+90Â°)` produces `(x, y, z) â†’ (x, -z, y)`; determinant is still `+1`, so
  triangle winding, normals, and UVs stay consistent.

### Matrix history (for the curious)

| Version  | Matrix                            | Det | Result on Y-up OBJ test bundle      |
|----------|-----------------------------------|-----|-------------------------------------|
| v0.1.24  | reflection `(x,y,z) â†’ (x,z,y)`   | -1  | mirrored â€” front faced *away*       |
| v0.1.25  | `Rx(-90Â°)`  `(x,y,z) â†’ (x,z,-y)` | +1  | rotated, but upside-down            |
| v0.1.26  | `Rx(+90Â°)`  `(x,y,z) â†’ (x,-z,y)` | +1  | **right-side-up, front-facing**     |

**Note**: tag `v0.1.25` and `v0.1.26` both point at commit `2355ddb`. The
commit subject line was written before the `Rx(-90Â°) â†’ Rx(+90Â°)` flip and
still reads "now applies -90 degree X rotation". The code in that SHA is
v0.1.26 (`Rx(+90Â°)`). Verified visually against the test bundle at
`https://orbit.rebus.industries/projects/932088aa79/models/683af13566`
(screenshots in [`docs/swap-yz-v0.1.26/`](docs/swap-yz-v0.1.26/)).

---

## v0.1.25 â€” 2026-05-25

### Changed

- **agent**: `swap_yz` matrix replaced reflection with `Rx(-90Â°)` rotation
  to preserve handedness. Superseded by v0.1.26 â€” see matrix history above.

---

## v0.1.24 â€” 2026-05-25

### Fixed

- **agent**: `swap_yz` is now actually applied. The flag was UI-wired and
  threaded through the server/agent contract, but the agent dropped it on the
  floor. New `RhinoAxisSwap.ApplyYZSwap(RhinoDoc)` runs between
  `RhinoFileOpener.OpenInto` and `RhinoSendPipeline.SendAsync`, gated on
  `AssignData.Options?.SwapYZ == true`. Single doc-table transform
  (`doc.Objects.Transform(id, swap, deleteOriginal: true)`) so block instance
  placements ride along. The shipped matrix in this version was a reflection
  (det = -1); the resulting handedness flip caused front-facing geometry to
  render as if seen from behind. Replaced in v0.1.25.

---

## v0.1.23 â€” 2026-05-24

### Added

- **agent**: `.zip` bundle uploads for OBJ + MTL + textures (and any sidecar
  bundle).  New `PRISM.Agent.Rhino.ZipBundleExtractor` expands archives next
  to the downloaded source, picks the primary geometry file by extension
  priority, and feeds Rhino's importer with the on-disk siblings intact so
  `map_Kd` paths in `.mtl` resolve. Safety caps: **2 GiB cumulative**,
  **1 GiB per entry**, zip-slip protection on every extracted path.
- **server**: `SUPPORTED_EXTS` accepts `.zip`.
- **web**: file picker `accept=` includes `.zip`.
- **contract**: `Hello.SupportedFormats` advertises `.zip` to dispatchers.

### Known limitations

- MTL and `map_Kd` paths inside the archive **must** be relative to the OBJ's
  directory inside the zip. The agent does not rewrite paths.

### Submodule

- `vendor/orbit-monorepo` â†’ `0e76a3b` on `prism-connector-fixes`. Brings in
  the connector texture / UV fixes (basecolor classifier, opaque-white
  diffuse promotion, missing-texture warnings, render-mesh merging across
  the OBJ+MTL+texture path).

---

## server hotpatch `92d1c8c` â€” 2026-05-24

### Fixed

- **server (ws)**: `pollLayers` no longer gets stuck on `"walking layer
  table"`. `PRISM/server/src/ws/agentProtocol.ts` had a fire-and-forget
  `socket.on('message', â€¦)` that allowed Progress and Layers DB writes to
  race; whichever landed second won, often clobbering the Layers result back
  to `extracting-layers` / `"walking layer table"`. Fix serialises
  per-connection handlers via a `pendingHandler` promise chain so
  WS-receive order equals DB-write order.

Hotpatched onto VM 211 immediately, then deployed via the `server-image`
workflow.

---

## Older

See `git log` / `git tag -n` for v0.1.22 and earlier (multi-file publish for
hotpatch, `.3dm` open-typed API, headless RhinoCore template, etc.).
