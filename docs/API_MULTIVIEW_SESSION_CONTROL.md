# PRISM Visualiser — Multi-viewer & Session-control API

**Audience:** developers driving a PRISM Visualiser session programmatically —
portal integrators who need more than the single-viewer happy path, and PRISM
contributors working on the server/agent control plane.
**Companion docs:** [`PORTAL_INTEGRATION.md`](PORTAL_INTEGRATION.md) (the
single-viewer embed quickstart) and the machine-readable
[OpenAPI contract](https://prism.rebus.industries/docs) (Redoc-rendered, served
at `GET /api/openapi.json`).
**Source of truth:** verified against `server/src/api/visualiser.ts`,
`server/src/ws/{signallingProxy,visualiserControl,signallingProxyRegistry,agentProtocol}.ts`,
`server/src/jobs/dispatcher.ts`, and `shared/contracts/agent-protocol.ts`.

> This doc covers two things the portal quickstart does not: the **session
> lifecycle / control surface** (start, poll, stop, the WS protocol that
> drives a run) and the **multi-viewer model** (several browsers on one
> streamed session, share links, view/control tiers, and the single-controller
> lock).

---

## 1. Concepts & vocabulary

| Term | Meaning |
| --- | --- |
| **Run / session** | One Pixel Streaming session of one ORBIT version. Persisted as a `visualiser_runs` row, identified by **`runId`** (UUID). One run occupies one workstation slot. |
| **Workstation / agent** | A REBUS render box running `PRISM.Agent` with the `visualiser` role + Unreal Engine 5.7. The server dispatches a run to exactly one. |
| **Streamer** | The UE-side Pixel Streaming producer for a run, id `orbit_<runIdShort>` (`streamerId`). One streamer per run. |
| **Viewer** | One browser connected to a run. A run serves **several viewers at once** (≈5, non-SFU). Each viewer is an independent Pixel Streaming *player*. |
| **`viewerId`** | Stable per-viewer demux key, carried in the signalling JWT. The agent opens **one local Wilbur player WS per `(runId, viewerId)`** so per-player SDP/ICE never collide. |
| **Tier** | A viewer is `view` (watch only) or `control` (may drive the camera/input). Carried in the JWT. |
| **Controller** | The single viewer per run that currently holds the input lock. Exactly one (or none) at a time. |

Two planes, same as `PORTAL_INTEGRATION.md`:

- **Control plane** (HTTP + WebSocket): browser ↔ PRISM server ↔ agent ↔
  orchestrator. Carries session lifecycle, signalling relay, and the control
  lock.
- **Media plane** (WebRTC + TURN): browser ↔ coturn ↔ workstation UE. Carries
  video + the input data channel **peer-to-peer** — it does **not** traverse
  PRISM.

---

## 2. Surface map

### REST — `/api/visualiser/*` (`server/src/api/visualiser.ts`)

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/visualiser/streams` | API key w/ `visualiser:create_stream`, or admin session | **Start** a run. Synchronous — blocks until `streaming`/failed/timeout. |
| `GET /api/visualiser/streams` | any auth (`requireAuth`) | List recent runs (newest first). |
| `GET /api/visualiser/streams/:runId` | any auth | Poll one run; attaches a fresh `turn` bundle while `streaming`. |
| `DELETE /api/visualiser/streams/:runId` | run owner (matching API key) or admin | **Stop** a run. Sends `cancelVisualisation`, marks the row `ended`. |
| `POST /api/visualiser/streams/:runId/signalling-token` | run owner or admin | Mint a short-lived **control-tier** signalling JWT for a viewer seat. |
| `POST /api/visualiser/streams/:runId/shares` | owner/admin, or key w/ `visualiser:join_stream` | Mint a **share link** (`view` or `control` tier, optional TTL ≤ 24 h). |
| `POST /api/visualiser/streams/:runId/shares/exchange` | **public** (no auth) | Redeem a share token → tier-scoped signalling JWT + `signallingUrl` + `turn`. |
| `GET /api/visualiser/streams/:runId/shares` | owner/admin | List share links for a run. |
| `DELETE /api/visualiser/streams/:runId/shares/:id` | owner/admin | Revoke a share link. |
| `GET /api/visualiser/workstations` | admin only | List `can_visualise` workstations (admin "Start stream" dropdown). |

### WebSocket — `/ws/visualiser/:runId/*` (browser ↔ server)

| Path | Auth | Purpose |
| --- | --- | --- |
| `GET /ws/visualiser/:runId/signalling?token=<jwt>` | signalling JWT | Opaque Pixel Streaming signalling relay (browser ⇄ agent ⇄ Wilbur ⇄ UE). One socket = one viewer seat. |
| `GET /ws/visualiser/:runId/control?token=<jwt>` | signalling JWT | PRISM control channel: controller-lock state + `take`/`release`. |

Both WS channels require `status === 'streaming'` and close immediately
otherwise (`4409 run is <status>`). Auth failures close with `4401`.

### WebSocket — agent protocol (server ↔ agent, internal)

Not portal-facing — this is how the server drives the workstation. Defined in
`shared/contracts/agent-protocol.{json,ts,cs}` (protocol `v: 1`). See §5.

---

## 3. Session lifecycle

### 3.1 State machine

A run row (`visualiser_runs.status`, enum in `server/src/db/schema.ts` +
OpenAPI `VisualiserStatus`):

```
                                   ┌───────────── failed ─────────────┐  (terminal)
                                   │  (dispatch error, agent_failed,   │
                                   │   start_timeout, gpu_preflight…)  │
   POST /streams                   │                                   │
   inserts row                     │                                   │
        │                          │                                   │
        ▼          dispatch        ▼          agent: visualisationReady │
     queued ───────────────► importing ───────────────────────► streaming
   (row created)        (slot reserved,                        (signallingUrl live,
                         startVisualisation                     viewers may join)
                         sent to agent)                              │
                                                                     │ DELETE /streams,
                                                                     │ TTL expiry, UE exit,
                                                                     │ or agent: visualisationEnded
                                                                     ▼
                                                                   ended  (terminal)
```

| Status | Set by | Meaning |
| --- | --- | --- |
| `queued` | `POST /streams` insert | Row created; dispatcher has not yet reserved a workstation. Sub-second. |
| `importing` | `tryDispatchVisualisation` (`dispatcher.ts`) | Slot reserved (`current_visualiser_load += 1`), `startVisualisation` sent; agent is materialising the ORBIT version into UE. Lasts the cold-start window. |
| `streaming` | `POST /streams` happy path on `visualisationReady` | `signallingUrl`/`streamerId` persisted; viewers can connect. |
| `failed` | dispatch failure, `visualisationFailed`, or `start_timeout` | Terminal. `failureReason` (code) + `error` (message) set. |
| `ended` | `DELETE`, `visualisationEnded`, TTL, browser disconnect | Terminal. Slot released (`current_visualiser_load -= 1`). |

> **The synchronous POST hides `queued`/`importing` from the caller** — it
> blocks and returns either the `streaming` ready envelope or a terminal error.
> The intermediate states are only visible to a *second* observer polling
> `GET /streams/:runId` (e.g. an admin dashboard) while the POST is in flight.

### 3.2 Start — `POST /api/visualiser/streams`

Synchronous. Blocks until the agent reports ready, a terminal failure, or the
`VISUALISER_START_TIMEOUT_MS` deadline (**code default 600 000 ms = 600 s**;
`server/src/api/visualiser.ts`). Set your HTTP client timeout above that.

Request (`startBody` zod schema):

```jsonc
{
  "projectId": "cf900606f5",   // required — ORBIT project id
  "modelId":   "be45d33eb1",   // required — ORBIT model id
  "versionId": "v_2026_05_12_001", // optional — omit for the model's latest
  "orbitTarget": "prod",       // optional — 'prod' (default) | 'dev'
  "templateTag": "v1.0.0-ue5.7", // optional — pin the UE template tag
  "ttlSeconds": 3600,          // optional — hard tear-down deadline
  "preferredWorkstationId": "…", // optional — RESERVED (dispatcher ignores; least-loaded wins)
  "callbackUrl": "https://…"   // optional — RESERVED (accepted, NOT yet POSTed)
}
```

Response `200` — `prism-visualiser/ready/v1`:

```jsonc
{
  "schema": "prism-visualiser/ready/v1",
  "runId": "5b9c1d4f-9d72-4a8c-8e64-7e22b5f2f01b",
  "status": "streaming",
  "signallingUrl": "wss://prism.rebus.industries/ws/visualiser/<runId>/signalling",
  "playerUrl": "https://prism.rebus.industries/admin/#/visualiser/<runId>",
  "streamerId": "orbit_5b9c1d4f",
  "turn": { "urls": ["turn:…:3478","turns:…:5349"], "username": "…", "credential": "…", "ttl": 86400 }
}
```

Terminal failures return `prism-visualiser/failed/v1` with a stable `code`
(`no_workstation_available`, `all_workstations_busy`, `version_unavailable`,
`misconfigured`, `agent_failed`, `start_timeout`, `gpu_preflight_failed`).
HTTP status mapping: `503` (no/all-busy workstations), `500` (misconfigured),
`422` (version_unavailable), `504` (start_timeout), `502` (agent_failed). See
`PORTAL_INTEGRATION.md` §"Error codes" for the per-code retry policy.

### 3.3 Poll — `GET /api/visualiser/streams/:runId`

Returns the full `VisualiserRun` row. While `status === 'streaming'` it also
mints and attaches a fresh `turn` bundle (the list endpoint omits it). Poll
every ~5 s while `importing`, ~30 s while `streaming`; never poll terminal
states.

### 3.4 Stop — `DELETE /api/visualiser/streams/:runId`

Best-effort `cancelVisualisation` to the agent + marks the row `ended`
immediately (so the UI reflects the click even if the agent is offline). The
agent later emits `visualisationEnded` when the orchestrator actually exits.
`403` if the caller neither owns the run (`requested_by_api_key_id` match) nor
is an admin; `409` if the run is already `ended`/`failed`.

---

## 4. Multi-viewer model

A single run serves **multiple concurrent browser viewers (≈5, no SFU)**. Each
viewer is an independent Pixel Streaming player.

### 4.1 Per-viewer demux

- Every viewer has a stable **`viewerId`** carried in its signalling JWT.
- The browser's signalling socket registers in
  `signallingProxyRegistry` keyed `(runId, viewerId)`.
- The agent opens **one local Wilbur player WS per `(runId, viewerId)`**, so
  the streamer issues a distinct per-player SDP/ICE offer to each viewer.
- Inbound agent→browser `signallingFrame`s are routed to the **single matching
  `viewerId`**, never broadcast. (Frames with no `viewerId` — legacy agents —
  fall back to broadcast for a single-viewer run.)

This 1:1 player-WS-per-viewer is the fix that stopped a second viewer from
freezing the first.

### 4.2 Tiers & the single-controller lock

- Each signalling JWT carries a `tier`: **`view`** (watch only) or
  **`control`** (may drive input).
- Exactly one viewer per run may hold **control** at a time. The lock lives
  in-memory in `signallingProxyRegistry` (the run is ephemeral — no DB).
- The **first `control`-tier viewer** to connect is auto-granted the lock
  (`autoGrantIfVacant`).
- `view`-tier viewers can never take control (a `take` is rejected
  server-side — the lock is authoritative on the server, not the client).

### 4.3 Control channel — `/ws/visualiser/:runId/control?token=<jwt>`

A dedicated WS, separate from signalling so PRISM control messages never
pollute the opaque Pixel Streaming sub-protocol.

**Server → client** (pushed on connect and on every lock change):

```jsonc
{
  "type": "controller",
  "controllerViewerId": "ab12…",   // who holds the lock (null = nobody)
  "you": "cd34…",                  // this socket's viewerId
  "youAreController": false,        // controllerViewerId === you
  "canControl": true                // this viewer's tier === 'control'
}
```

**Client → server:**

```jsonc
{ "type": "take" }      // request the lock (control-tier only)
{ "type": "release" }   // give up the lock
```

A rejected `take` returns `{ "type": "controlError", "reason": "view-only viewer cannot take control" }`.

### 4.4 Input gate (defence-in-depth)

When the lock changes, the server tells the agent via `setViewerControl`
(`{ runId, viewerId, canControl }`) for both the demoted and promoted viewer.
The agent's per-viewer `SignallingBridge` sets `AllowInput` accordingly and
drops Pixel Streaming input/command frames (`mousemove`, `keydown`,
`emitUIInteraction`, `command`, gamepad, touch…) for non-controllers.
WebRTC negotiation (offer/answer/ICE), streamer discovery and keepalives
always pass.

> **Hard-guarantee caveat:** Pixel Streaming input rides the peer-to-peer
> WebRTC data channel, which does **not** traverse PRISM. View-only is
> enforced by (a) client UI suppression and (b) the agent's signalling-frame
> gate. For a hard guarantee against a modified client the UE template must set
> `PixelStreaming2.InputController=Host`.

### 4.5 Share links

`visualiser_share_links` table (migration `0006`; `run_id` FK cascade,
`token_hash` unique, `tier` default `view`, `created_by`, `expires_at`,
`revoked_at`).

- A run owner/admin (or a key with `visualiser:join_stream`) mints a link with
  `POST …/shares` (`{ tier, expiresInSeconds? }`, TTL capped at 24 h).
- The **plaintext token is returned once** inside the share URL
  (`https://prism.rebus.industries/viewer/#/<runId>?st=<token>`); only its
  SHA-256 hash is stored.
- A shared viewer (no portal account) calls the **public**
  `POST …/shares/exchange` (`{ shareToken, viewerId? }`) and receives a
  tier-scoped signalling JWT + `signallingUrl` + `turn`.
- Links auto-die with the run: exchange refuses any run not `streaming`, and a
  revoked/expired link returns `410`.

### 4.6 Limits

- **≈5 viewers per run** (non-SFU; each viewer is a full PS player on the
  workstation GPU/encoder).
- **One run per workstation** in v1 (single-tenant). The dispatcher reserves a
  slot only while `current_visualiser_load < slots`; the agent's
  `VisualiserMaxConcurrent` (default 1, GPU-bound) is the per-box cap. A second
  run goes to a different workstation or fails with `all_workstations_busy`.

---

## 5. Agent WS protocol (server ↔ agent)

Internal control plane — a portal never sees these. Each message is an
envelope `{ v: 1, type, id?, ts?, data }` (`shared/contracts/agent-protocol.ts`,
`envelope()` helper). Relevant types for session control + multi-viewer:

| Type | Direction | `data` (key fields) | Role |
| --- | --- | --- | --- |
| `startVisualisation` | server → agent | `runId, slot, orbitServerUrl, orbitToken, projectId, modelId, versionId?, templateTag?, signallingUrl?, ttlSeconds?, attachments?` | Spin up a session. Sent by `tryDispatchVisualisation`. |
| `cancelVisualisation` | server → agent | `runId, reason?` | Tear a run down (DELETE / start_timeout). |
| `visualisationReady` | agent → server | `runId, signallingUrl, streamerId?, expiresAt?` | Resolves the `POST /streams` waiter → `streaming`. |
| `visualisationFailed` | agent → server | `runId, error, stack?` | Rejects the waiter → `failed` (`code: agent_failed`). |
| `visualisationEnded` | agent → server | `runId, reason?` | Run ended after streaming → `ended`; releases the slot. |
| `signallingFrame` | both ways | `runId, viewerId?, payload? \| payloadB64?` | Opaque PS signalling relay. Exactly one of `payload` (text) / `payloadB64` (binary) per frame. |
| `signallingViewerClose` | server → agent | `runId, viewerId` | A browser viewer's socket closed; agent drops that viewer's Wilbur player. |
| `setViewerControl` | server → agent | `runId, viewerId, canControl` | Authoritative input-gate state for one viewer. |

Dispatch (`server/src/jobs/dispatcher.ts → tryDispatchVisualisation`): selects
the least-loaded online `can_visualise` workstation, atomically reserves a slot
(`current_visualiser_load += 1` guarded by `< slots`), sets the run
`importing` + `dispatchedAt` + `workstationId` + `agentSessionId`, and sends
`startVisualisation`. The `POST /streams` handler registers a promise waiter
(`visualiser/runRegistry.ts`) that the inbound `visualisationReady` /
`visualisationFailed` handler (`server/src/ws/agentProtocol.ts`) resolves or
rejects.

---

## 6. End-to-end examples

### 6.1 Start a session and connect the owner viewer

```bash
PRISM=https://prism.rebus.industries
KEY=prism_xyz   # key carries visualiser:create_stream

# 1. Start (blocks ~2-3 s warm, ~60-90 s cold; set client timeout > 600 s)
READY=$(curl -sS -X POST "$PRISM/api/visualiser/streams" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" --max-time 620 \
  -d '{"projectId":"cf900606f5","modelId":"be45d33eb1"}')
RUN=$(echo "$READY" | jq -r .runId)

# 2. Mint a (control-tier) signalling token for this viewer seat
TOK=$(curl -sS -X POST "$PRISM/api/visualiser/streams/$RUN/signalling-token" \
  -H "X-API-Key: $KEY" | jq -r .token)

# 3. Open the signalling WS (browser): wss://…/ws/visualiser/$RUN/signalling?token=$TOK
#    + (optional) the control WS:      wss://…/ws/visualiser/$RUN/control?token=$TOK
```

The browser embeds Epic's `lib-pixelstreamingfrontend` against the signalling
URL and injects the `turn` bundle into `iceServers` — see
`PORTAL_INTEGRATION.md` §"Embedding the player".

### 6.2 Invite a second, view-only viewer

```bash
# Owner mints a VIEW-tier share link (expires in 1 h)
SHARE=$(curl -sS -X POST "$PRISM/api/visualiser/streams/$RUN/shares" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"tier":"view","expiresInSeconds":3600}')
echo "$SHARE" | jq -r .url
# -> https://prism.rebus.industries/viewer/#/<runId>?st=<token>   (send this to the guest)
```

The guest's browser (no PRISM key) redeems the token:

```bash
curl -sS -X POST "$PRISM/api/visualiser/streams/$RUN/shares/exchange" \
  -H "Content-Type: application/json" \
  -d '{"shareToken":"<token-from-url>","viewerId":"guest-tab-1"}'
# -> { token, exp, viewerId, tier:"view", runId, signallingUrl, turn }
```

The guest opens `signallingUrl?token=<token>`. Because the link is `view`-tier,
the guest sees the stream but cannot drive it.

### 6.3 Hand over control

Both viewers open the control WS. The owner (auto-granted controller) sees
`{ youAreController:true }`. A `control`-tier viewer that wants to drive sends
`{ "type":"take" }`; the server flips the lock, pushes a fresh `controller`
snapshot to every control subscriber, and sends `setViewerControl` to the agent
for both the demoted owner (`canControl:false`) and the new controller
(`canControl:true`). `{ "type":"release" }` clears the lock.

### 6.4 Stop

```bash
curl -sS -X DELETE "$PRISM/api/visualiser/streams/$RUN" -H "X-API-Key: $KEY"
# -> { "ok": true }   (run → ended, workstation slot freed)
```

---

## 7. Authorization notes & not-yet-implemented

**Reserved / aspirational (accepted by the API but not acted on):**

- `callbackUrl` on `POST /streams` — accepted, **not** dispatched. Poll
  `GET /streams/:runId` instead (webhook callbacks tracked for v0.3).
- `preferredWorkstationId` — accepted, ignored; the dispatcher always picks the
  least-loaded eligible workstation.
- **Idempotency** — concurrent POSTs for the same `(projectId, modelId,
  versionId)` each create a fresh run and race for a slot. Serialise at your
  layer until the v0.3 dedup follow-up.
- **Standalone player page** — `playerUrl` deep-links the admin SPA; the
  first-class `/visualiser/<runId>/player` page is a Phase I follow-up. Portals
  embed the PS frontend lib directly.
- **LAN-only mode** — every viewer relays through coturn; no LAN short-circuit
  in v1.

**Behaviour worth calling out (verified in code):**

- `signalling-token` mints a **`control`-tier** seat for any owner/admin caller.
  There is no way to mint a *view*-tier seat through this endpoint — view-only
  seats come only from `view`-tier **share links**. A portal that wants a
  read-only embed must use a share link, not `signalling-token`.
- `GET /streams` and `GET /streams/:runId` are gated by `requireAuth` only —
  **any** valid API key/admin/ORBIT bearer can read **any** run (including
  `submittedBy`, `signallingUrl`, `streamerId`), not just runs it created.
  Ownership is enforced only on `DELETE`, `signalling-token`, and the share
  endpoints. Treat run metadata as readable by any authenticated caller.
- The control WS requires a `viewerId` in the token (`4400` otherwise); the
  signalling WS tolerates a missing `viewerId` by minting a random one. Keep a
  stable `viewerId` across token refreshes (pass it to `shares/exchange` /
  reuse the minted one) so a viewer's Wilbur player + controller seat survive a
  refresh.

---

## 8. See also

- [`PORTAL_INTEGRATION.md`](PORTAL_INTEGRATION.md) — single-viewer embed
  quickstart, player code samples, TURN handling, retry policy.
- [OpenAPI / Redoc](https://prism.rebus.industries/docs) — field-by-field REST
  reference (`GET /api/openapi.json`).
- [`VISUALISER_CONNECTOR_IMPORT.md`](VISUALISER_CONNECTOR_IMPORT.md) — how a run
  imports the ORBIT model inside UE.
- [`VISUALISER_WORKSTATION_SESSION.md`](VISUALISER_WORKSTATION_SESSION.md) — the
  RDP "disconnect, never log off" GPU-session rule on the workstation.
- `../visualiser/HANDOFF.md` §2 (data flow) and §4 (multi-viewer model) — the
  engineering deep-dive behind this contract.
- Source: `server/src/api/visualiser.ts`,
  `server/src/ws/{signallingProxy,visualiserControl,signallingProxyRegistry}.ts`,
  `shared/contracts/agent-protocol.ts`.
