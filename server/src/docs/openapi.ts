/**
 * OpenAPI 3.1 spec for PRISM's external API.
 *
 * Scope: public `/v1/*` namespace plus portal-facing `/api/*` surfaces
 * (visualiser, libraries, access). Internal admin-only routes are omitted
 * or marked cookie-auth where included for completeness.
 *
 * Served at GET /api/openapi.json (public, no auth required so external
 * developers can read it without provisioning a key).
 */

/**
 * Build the OpenAPI document. We accept a runtime `publicBaseUrl` so the
 * generated `servers[].url` can be overridden per deployment (prod / dev).
 */
export function buildOpenApi(publicBaseUrl: string): unknown {
  const BASE = (publicBaseUrl || '').replace(/\/+$/, '');
  const SERVER_URL = BASE + '/v1';
  // Phase K - Visualiser + Project Attachments surfaces live at
  // `/api/*`, not `/v1/*`, because they are the portal-contract APIs
  // rather than the conversion APIs. We describe them inside the same
  // OpenAPI doc so a single spec covers both, and we add a second
  // `servers[]` entry so Redoc renders the absolute path correctly.
  // The narrative companion is `docs/PORTAL_INTEGRATION.md` (also
  // served at `${BASE}/docs/portal-integration`).
  const API_BASE = BASE;

  return {
    openapi: '3.1.0',
    info: {
      title: 'PRISM API',
      version: '1.0.0',
      summary: 'CAD / mesh conversion + ORBIT object delivery as a service.',
      description: [
        'PRISM accepts CAD, mesh, and IFC files via HTTP, dispatches the conversion work',
        'to a pool of Rhino workstation agents, and uploads the resulting ORBIT objects',
        'to your configured ORBIT server — preserving native B-rep / SubD / Extrusion',
        'geometry through `RhinoDataObject.rawEncoding`.',
        '',
        'This page is the canonical integration reference.  See the table of contents on',
        'the right for endpoint-by-endpoint details.  The narrative sections below cover',
        '(in order) the supported formats, a copy-pasteable quickstart, authentication,',
        'rate limits, error shape, the two-phase layer-selection flow, additional output',
        'formats, and webhook delivery.',
        '',
        '## Supported file formats',
        '',
        'Uploads take one of two routes through the system.  Files Rhino can open',
        'directly are dispatched straight to a workstation agent.  Modern',
        'web/3D-DCC formats (`.gltf` / `.glb` / `.dae` / `.blend` / `.x` / `.usdz`)',
        'are first sent to the `prism-assimp` sidecar, which expands them into an',
        'OBJ + MTL + textures bundle that the agent then ingests as a normal',
        '`.zip` upload.  Either way the user-visible job row keeps the original',
        'filename and extension.',
        '',
        '| Format            | Status                            | Layer Selection                                       | Layer Colouring         | Texture Support                          | Bitmap Textures                                                                |',
        '| ----------------- | --------------------------------- | ----------------------------------------------------- | ----------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |',
        '| **3DM**           | Confirmed working                 | Supported                                             | **Supported**           | Supported                                | Supported                                                                      |',
        '| **DWG**           | Confirmed working                 | Supported                                             | **Supported**           | Partial — depends on origin software     | Supported if externally referenced                                             |',
        '| **DXF**           | Confirmed working                 | Supported                                             | **Supported**           | Partial — depends on origin software     | Supported if externally referenced                                             |',
        '| **FBX**           | Confirmed working                 | Supported                                             | Not supported           | Supported via `.zip` with textures       | Supported                                                                      |',
        '| **OBJ**           | Confirmed working                 | Partial — if layers are exported as OBJ groups        | Not supported           | Supported via `.zip` with textures       | Supported                                                                      |',
        '| **SKP**           | Confirmed working                 | Supported                                             | Not supported           | Partial support                          | Not supported                                                                  |',
        '| **STL**           | Confirmed working                 | Not supported                                         | Not supported           | Not supported                            | Not supported                                                                  |',
        '| **STEP** / **STP**| Confirmed working                 | Supported                                             | Not supported           | Layer colours imported as textures       | Not supported                                                                  |',
        '| **DAE**           | Confirmed working (Assimp)        | Supported — derived from COLLADA `<node name>`        | Not supported           | Supported via `.zip` with textures       | Supported                                                                      |',
        '| **GLB** / **GLTF**| Pre-convert via Assimp (untested) | Expected: supported (one OBJ group per glTF mesh)     | Not supported           | Supported via `.zip` with textures (PBR) | Supported (embedded in `.glb`, sibling files in `.gltf`)                       |',
        '| **3MF**           | Native Rhino import (untested)    | Expected: supported                                   | Unknown                 | Unknown                                  | Unknown                                                                        |',
        '| **IGES** / **IGS**| Native Rhino import (untested)    | Not supported (format has no layer concept)           | Object colours only     | Not supported                            | Not supported                                                                  |',
        '| **PLY**           | Native Rhino import (untested)    | Not supported                                         | Vertex colours only     | Not supported                            | Not supported                                                                  |',
        '| **BLEND**         | Pre-convert via Assimp (untested) | Expected: supported                                   | Not supported           | Supported via `.zip` with textures       | Supported                                                                      |',
        '| **X** (DirectX)   | Pre-convert via Assimp (untested) | Expected: supported                                   | Not supported           | Supported via `.zip` with textures       | Supported                                                                      |',
        '| **USDZ**          | Pre-convert via Assimp (untested) | Expected: supported                                   | Not supported           | Supported via `.zip` with textures       | Supported (embedded)                                                           |',
        '| **ZIP**           | Bundle wrapper                    | Inherited from primary file                           | Inherited               | Inherited                                | Inherited                                                                      |',
        '',
        '> Submit a `.zip` containing the primary geometry file plus any sibling',
        '> assets (textures, FBX media, glTF buffers) and the agent\'s',
        '> `ZipBundleExtractor` will pick the primary geometry automatically and',
        '> point Rhino\'s importer at the extracted directory so referenced',
        '> assets resolve.',
        '',
        '## Quickstart',
        '',
        'A round-trip from "I have a `.3dm` on disk" to "I have an ORBIT version URL"',
        'is three calls: submit, poll, done.',
        '',
        '### Single-shot convert (no layer picker)',
        '',
        '```bash',
        '# 1. Submit the file',
        'curl -sS -X POST https://prism.rebus.industries/v1/convert/async \\',
        '     -H "X-API-Key: $PRISM_KEY" \\',
        '     -F "file=@/path/to/model.3dm" \\',
        '     -F "projectId=$ORBIT_PROJECT_ID" \\',
        '     -F "modelId=$ORBIT_MODEL_ID"',
        '# -> {"jobId":"a1b2c3...","status":"queued"}',
        '',
        '# 2. Poll until terminal',
        'curl -sS https://prism.rebus.industries/v1/jobs/a1b2c3... \\',
        '     -H "X-API-Key: $PRISM_KEY"',
        '# -> {"status":"processing","progressPercent":42,...}',
        '# (later)',
        '# -> {"status":"complete","resultUrl":"https://orbit.rebus.industries/projects/.../models/...@..."}',
        '```',
        '',
        '### Same flow in TypeScript / Node',
        '',
        '```ts',
        'const PRISM = "https://prism.rebus.industries/v1";',
        'const KEY   = process.env.PRISM_KEY!;',
        '',
        'const fd = new FormData();',
        'fd.set("file",       new Blob([await readFile("model.3dm")]), "model.3dm");',
        'fd.set("projectId",  ORBIT_PROJECT_ID);',
        'fd.set("modelId",    ORBIT_MODEL_ID);',
        '',
        'const submit = await fetch(`${PRISM}/convert/async`, {',
        '  method:  "POST",',
        '  headers: { "X-API-Key": KEY },',
        '  body:    fd,',
        '});',
        'if (!submit.ok) throw new Error(`submit failed: ${submit.status} ${await submit.text()}`);',
        'const { jobId } = await submit.json();',
        '',
        '// Poll once a second until terminal',
        'while (true) {',
        '  const r = await fetch(`${PRISM}/jobs/${jobId}`, { headers: { "X-API-Key": KEY } });',
        '  const job = await r.json();',
        '  if (job.status === "complete") { console.log("ORBIT version:", job.resultUrl); break; }',
        '  if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error);',
        '  await new Promise(r => setTimeout(r, 1000));',
        '}',
        '```',
        '',
        'Live progress can also be streamed over Server-Sent Events at',
        '`GET /jobs/{id}/stream` — see [Polling vs SSE](#section/Polling-vs-SSE) below.',
        '',
        '## Authentication',
        '',
        'All `/v1/*` endpoints require an API key supplied in the `X-API-Key` header.',
        'Mint keys in the admin UI under **API keys** (an admin must do this for you;',
        'we do not yet self-serve key issuance). Keep keys secret — they grant the',
        'ability to spend your monthly conversion quota.',
        '',
        '## Rate limits',
        '',
        'Every request is metered against the issuing key. Two policies apply:',
        '',
        '* **Per-minute rate limit** — short-burst protection (default 60/min, configurable per key).',
        '* **Monthly quota** — total conversion + receive jobs per calendar month.',
        '',
        'Both budgets are reported via response headers:',
        '',
        '* `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`',
        '* `X-Quota-Limit`, `X-Quota-Remaining`, `X-Quota-Reset`',
        '',
        'When exceeded, the API returns `429 Too Many Requests`.',
        '',
        '## Errors',
        '',
        'All errors return JSON of shape `{ "error": "<message>" }`. Validation errors',
        'additionally include `issues` (zod-formatted). HTTP status codes follow the',
        'usual semantics: `400` bad request, `401` missing/invalid key, `403` ownership',
        'mismatch, `404` not found, `415` unsupported media type, `429` rate-limited.',
        '',
        '## Two-phase layer selection',
        '',
        'Most user-facing portals want to let the user pick which Rhino layers to',
        'send to ORBIT.  PRISM supports this without uploading the file twice:',
        'add `selectLayers=true` to the original `POST /convert/async` and the',
        'job will pause in `awaiting_selection` after the agent reports the',
        'layer tree.  Submit the chosen layers on `POST /jobs/{id}/layers` to',
        'resume normal convert dispatch.',
        '',
        'Layer extraction quality is format-dependent — see the [Supported file',
        'formats](#section/Supported-file-formats) table\'s **Layer Selection**',
        'column.  Formats marked "Not supported" (STL, IGES, PLY) will return a',
        'single root layer; calling `selectLayers=true` on those is harmless but',
        'pointless.',
        '',
        '### Job lifecycle',
        '',
        '```',
        '  caller       PRISM server          layering agent       convert agent',
        '    │   POST /convert/async   │',
        '    │  (selectLayers=true)    │',
        '    │ ───────────────────────▶│ → queued',
        '    │                         │  pollLayers ──▶ ┌──────────────┐',
        '    │  202 { jobId }          │                 │ open file    │',
        '    │ ◀───────────────────────│                 │ walk layers  │',
        '    │                         │ ◀───── layers   └──────────────┘',
        '    │                         │ → awaiting_selection',
        '    │  GET /jobs/{id}/layers  │',
        '    │ ───────────────────────▶│',
        '    │  200 { layers: […] }    │',
        '    │ ◀───────────────────────│',
        '    │  POST /jobs/{id}/layers │',
        '    │   { includedLayers… }   │',
        '    │ ───────────────────────▶│ → queued',
        '    │                         │  assign ─────────────────▶ ┌──────────────┐',
        '    │                         │                            │ convert      │',
        '    │                         │ ◀────── progress (×n) ───  │ upload       │',
        '    │                         │ ◀────── complete ────────  └──────────────┘',
        '    │                         │ → complete',
        '```',
        '',
        '### End-to-end TypeScript example',
        '',
        '```ts',
        'const PRISM = "https://prism.rebus.industries/v1";',
        'const KEY   = process.env.PRISM_KEY!;',
        '',
        '// 1. Submit with selectLayers=true',
        'const fd = new FormData();',
        'fd.set("file",          new Blob([await readFile("model.3dm")]), "model.3dm");',
        'fd.set("projectId",     ORBIT_PROJECT_ID);',
        'fd.set("modelId",       ORBIT_MODEL_ID);',
        'fd.set("selectLayers",  "true");',
        '',
        'const submit = await fetch(`${PRISM}/convert/async`, {',
        '  method:  "POST",',
        '  headers: { "X-API-Key": KEY },',
        '  body:    fd,',
        '});',
        'const { jobId } = await submit.json();',
        '',
        '// 2. Wait for the layer tree.  The agent returns it within a few seconds for',
        '//    most files.  Poll /layers (the simplest option) or subscribe to /stream',
        '//    if you want to render progress while waiting.',
        'let layers;',
        'while (true) {',
        '  const r = await fetch(`${PRISM}/jobs/${jobId}/layers`, { headers: { "X-API-Key": KEY } });',
        '  if (r.ok) { ({ layers } = await r.json()); break; }',
        '  if (r.status !== 404) throw new Error(`layers fetch failed: ${r.status}`);',
        '  await new Promise(r => setTimeout(r, 750));',
        '}',
        '',
        '// 3. Show `layers` (a recursive tree of {name, fullPath, color, visible, children})',
        '//    in your UI.  When the user clicks "Convert", POST their picks back.',
        'const chosen = ["Default", "Walls", "Walls::Internal"];',
        'await fetch(`${PRISM}/jobs/${jobId}/layers`, {',
        '  method:  "POST",',
        '  headers: { "X-API-Key": KEY, "Content-Type": "application/json" },',
        '  body:    JSON.stringify({',
        '    includedLayers:          chosen,',
        '    includeLayerDescendants: true,   // optional: also include sub-layers',
        '  }),',
        '});',
        '',
        '// 4. Resume polling /jobs/{id} as in the quickstart until status === "complete".',
        '```',
        '',
        '### Layer tree shape',
        '',
        'The `GET /jobs/{id}/layers` response and the `layers` field of the SSE',
        '`update` frame both use the same recursive `LayerNode` schema:',
        '',
        '```jsonc',
        '{',
        '  "jobId":  "a1b2c3...",',
        '  "status": "awaiting_selection",',
        '  "layers": [',
        '    {',
        '      "name":     "Walls",',
        '      "fullPath": "Walls",        // top-level layers have name == fullPath',
        '      "color":    "#ff8800",',
        '      "visible":  true,',
        '      "children": [',
        '        { "name": "Internal", "fullPath": "Walls::Internal", "color": "#aa6600", "visible": true, "children": [] },',
        '        { "name": "External", "fullPath": "Walls::External", "color": "#882200", "visible": false, "children": [] }',
        '      ]',
        '    }',
        '  ],',
        '  "includedLayers":          [],',
        '  "includeLayerDescendants": false',
        '}',
        '```',
        '',
        'Send the **`fullPath`** strings (Rhino layer paths joined with `" :: "`)',
        'when posting your selection, not the `name` strings — names can collide',
        'across different parents.  Set `includeLayerDescendants=true` when the',
        'user picks a parent and you want every sub-layer included automatically.',
        '',
        '### Skipping the picker entirely',
        '',
        'If the caller already knows which layer paths it wants (e.g. an automation',
        'that always sends "Architecture::Walls" + "Architecture::Slabs"), pass',
        '`includedLayers` (CSV) on the original `/convert/async` call and *leave',
        '`selectLayers` unset*.  The job dispatches straight to convert without the',
        'layering hop.',
        '',
        '```bash',
        'curl -X POST https://prism.rebus.industries/v1/convert/async \\',
        '     -H "X-API-Key: $PRISM_KEY" \\',
        '     -F "file=@/path/to/model.3dm" \\',
        '     -F "projectId=$ORBIT_PROJECT_ID" \\',
        '     -F "modelId=$ORBIT_MODEL_ID" \\',
        '     -F "includedLayers=Architecture::Walls,Architecture::Slabs" \\',
        '     -F "includeLayerDescendants=true"',
        '```',
        '',
        '## Polling vs SSE',
        '',
        'Two ways to track a job after submission:',
        '',
        '* **Poll `GET /jobs/{id}` every 1-2 s** — simplest, works through any',
        '  proxy, no special headers required.  Stop when `status` is one of',
        '  `complete`, `failed`, `cancelled`.',
        '* **Subscribe to `GET /jobs/{id}/stream`** — Server-Sent Events.',
        '  First frame is `event: state` (the full job record); every subsequent',
        '  agent update arrives as `event: update`.  Lower latency, lower load on',
        '  PRISM, and the `awaiting_selection` frame includes the `layers` tree',
        '  inline so you can skip the explicit `GET /jobs/{id}/layers` round-trip.',
        '  Close the connection when you observe a terminal status.',
        '',
        '```ts',
        '// Browser-style SSE example.',
        'const es = new EventSource(`${PRISM}/jobs/${jobId}/stream`, { withCredentials: false });',
        'es.addEventListener("state",  e => console.log("init:",   JSON.parse((e as MessageEvent).data)));',
        'es.addEventListener("update", e => {',
        '  const job = JSON.parse((e as MessageEvent).data);',
        '  if (job.status === "awaiting_selection") {',
        '    showLayerPicker(job.layers);  // delivered inline — no extra fetch needed',
        '  } else if (["complete", "failed", "cancelled"].includes(job.status)) {',
        '    es.close();',
        '  }',
        '});',
        '```',
        '',
        '> Note: `EventSource` cannot send `X-API-Key` headers.  In a server-side',
        '> integration use `fetch` with `Accept: text/event-stream` and parse the',
        '> stream manually; in a browser context proxy the request through your',
        '> own backend so the key never leaves your servers.',
        '',
        '## Additional output formats',
        '',
        'A convert job always uploads its result to ORBIT (you get back',
        '`resultUrl` + `versionId` on completion).  Pass `outputFormats` (CSV) on',
        '`POST /convert/async` to *also* render the model into one or more flat',
        'files that PRISM stores for download:',
        '',
        '| Code   | Description                                              |',
        '| ------ | -------------------------------------------------------- |',
        '| `3dm`  | Native Rhino document — round-trips B-rep / SubD losslessly. |',
        '| `step` | ISO 10303-21 STEP — interoperable B-rep for downstream CAD.  |',
        '| `glb`  | Binary glTF 2.0 — for web viewers / WebGL preview.       |',
        '| `ifc`  | Industry Foundation Classes — building-data exchange.    |',
        '',
        'When the job completes, the URLs land on `job.outputs.<format>` and are',
        'separately downloadable via `GET /jobs/{id}/outputs/{format}`.  The',
        'binary stream is `application/octet-stream`; pick a filename based on the',
        'job\'s original `fileName` + the format extension.',
        '',
        '```bash',
        'curl -X POST https://prism.rebus.industries/v1/convert/async \\',
        '     -H "X-API-Key: $PRISM_KEY" \\',
        '     -F "file=@/path/to/model.3dm" \\',
        '     -F "projectId=$ORBIT_PROJECT_ID" \\',
        '     -F "modelId=$ORBIT_MODEL_ID" \\',
        '     -F "outputFormats=glb,step"',
        '# later, after status=complete:',
        'curl -OJ https://prism.rebus.industries/v1/jobs/a1b2c3.../outputs/glb \\',
        '     -H "X-API-Key: $PRISM_KEY"',
        '```',
        '',
        '## Library APIs (fixtures, models, materials)',
        '',
        'Portal-facing asset libraries are served under `/api/fixtures`, `/api/models`,',
        'and `/api/materials`. Narrative companion:',
        '[`/docs/library-integration`](' + BASE + '/docs/library-integration).',
        '',
        '**Meshy generate → Model Library:** connectors and third-party portals can',
        'call `/api/meshy/*` with an `X-API-Key` (`models:read` / `models:write`).',
        'The Meshy API key lives in **Admin → Settings → Meshy** and never leaves',
        'the PRISM server. After a task succeeds, download the GLB via',
        '`GET /api/meshy/download` and `POST /api/model-import` (`models:import`)',
        'to run the convert pipeline into the Orbit Model Library. Full flow:',
        '[Generate with Meshy](' + BASE + '/docs/library-integration#generate-with-meshy-connectors--portals).',
        '',
        '**List and detail JSON** for fixtures and models includes portal-card fields',
        'so you can render a library grid without N+1 detail fetches:',
        '',
        '| Field | Fixtures | Models |',
        '| ----- | -------- | ------ |',
        '| `previewUrl` | Relative path to the active preview GLB (`/api/fixtures/{id}/preview.glb` or `/media/{mediaId}`) | Same under `/api/models/…` |',
        '| `orbitUrl` | Orbit viewer link when published (`definition.metadata.orbitFixtureRef`) | Orbit Model Library link (`definition.metadata.orbit`) |',
        '| `versions[]` | Stored GDTF revisions — each row has `downloadedAt`, `previewUrl`, `isActive` | Import history — each row has `createdAt`, `previewUrl`, `orbitUrl`, `isActive` |',
        '',
        'Materials and textures use the same `previewUrl` pattern for **2D thumbnails**',
        '(`GET /api/textures/{id}/preview`). Fixture/model previews are **GLB meshes** —',
        'stream the path from `previewUrl` with your `X-API-Key` (proxy through your',
        'portal backend for browser embeds; `<img>` cannot send custom headers).',
        '',
        '## Permissions & portal-brokered access',
        '',
        'PRISM brokers REBUS-portal identity into a scoped ORBIT token plus a',
        'per-project connector-permission manifest. Portals adding "Sign in with',
        'REBUS" and rendering a permissions node use the `/api/access/*` endpoints',
        '(**Access** tag); the function-policy graph that backs the manifest is',
        'under the **Permissions** tag, and Google Workspace / user provisioning',
        'under **Workspace**. These are served by the `prism-permissions-service`',
        'and routed under this origin by the split-stack nginx router. Effective',
        'permissions = portal project grant ∩ function-policy graph. Narrative',
        'companion: `docs/PORTAL_CONTRACT.md`.',
        '',
        '## Webhooks',
        '',
        'You can register a webhook URL in the admin UI and PRISM will POST',
        '`job.complete` and `job.failed` events to it. The body is signed with',
        'HMAC-SHA256 over the raw request bytes — see `GET /webhooks/signature-spec`',
        'for the canonical signing details.',
      ].join('\n'),
      contact: {
        name: 'REBUS-ORBIT',
        url: 'https://github.com/REBUS-ORBIT/prism',
      },
      license: { name: 'Proprietary — Rebus Industries' },
    },
    servers: [
      { url: SERVER_URL, description: 'Production - /v1 conversion + receive surface' },
      { url: API_BASE,   description: 'Production root - /api/visualiser/* portal surface, project attachments, and library APIs (/api/fixtures, /api/models, /api/materials, /api/files)' },
    ],

    tags: [
      { name: 'Meta',               description: 'Health and metadata.' },
      { name: 'Convert',            description: 'Submit a file for conversion to ORBIT.' },
      { name: 'Receive',            description: 'Materialise an ORBIT version into a downloadable file (.3dm or .step).' },
      { name: 'Jobs',               description: 'Poll job status and download outputs.' },
      { name: 'Visualiser',         description: 'Start, poll, and stop Pixel Streaming sessions of ORBIT versions, plus multi-viewer share links. Portal-facing - `POST`/`DELETE` require the `visualiser:create_stream` scope. The live signalling + control WebSocket channels (`/ws/visualiser/{runId}/signalling` and `/ws/visualiser/{runId}/control`) and the multi-viewer model cannot be modelled in OpenAPI - see [API_MULTIVIEW_SESSION_CONTROL.md](https://github.com/REBUS-ORBIT/prism/blob/main/docs/API_MULTIVIEW_SESSION_CONTROL.md) and [PORTAL_INTEGRATION.md](https://github.com/REBUS-ORBIT/prism/blob/main/docs/PORTAL_INTEGRATION.md).' },
      { name: 'Project Attachments',description: 'Upload MVR/GDTF lighting files to an ORBIT project before starting a visualiser stream. Optional second-pass import via `import_mvr.py`.' },
      { name: 'Fixture library', description: 'GDTF/MVR fixture types — list, edit, import, and connector export. JSON list/detail rows include `previewUrl`, `orbitUrl`, and `versions[]` (each version has `downloadedAt` + `previewUrl`). Assembly, pan/tilt motion, and scene-graph rules: `/docs/fixture-assembly-and-motion`. ORBIT fixture groups & position presets metadata: `/docs/fixture-groups-positions-metadata`. Portal-facing; requires `fixtures:*` scopes on `X-API-Key`. Narrative: `/docs/library-integration`.' },
      { name: 'Model library', description: 'Generic 3D model assets — list, edit, and async import via the convert pipeline. JSON list/detail rows include `previewUrl`, `orbitUrl`, and `versions[]` (each version has `createdAt` + `previewUrl`). Portal-facing; requires `models:*` scopes. Narrative: `/docs/library-integration`. Generate meshes with the **Meshy** tag, then import.' },
      { name: 'Meshy', description: 'Server-proxied Meshy.ai text/image-to-3D for connectors and portals. Credentials: Admin → Settings → Meshy (`meshy_api_key`). Scopes: `models:read` (status/poll/download), `models:write` (create tasks). After SUCCEEDED, transfer into the library with `POST /api/model-import` (`models:import`). Narrative: `/docs/library-integration#generate-with-meshy-connectors--portals`.' },
      { name: 'Materials library', description: 'Shared PBR materials + texture slots. JSON list/detail responses include `previewUrl` for material thumbnails and texture rows; stream images via `GET /api/textures/{id}/preview`. Portal-facing; requires `materials:*` scopes. Narrative: `/docs/library-integration`.' },
      { name: 'File library', description: 'Native CAD/DCC source archives (.3dm, .vwx, …) — **not** Orbit geometry. Same filename stacks as immutable versions with `uploadedBy` + `createdAt`. Storage root from Settings `file_library_root`; each Orbit project needs a relative folder under that root (Admin → Settings → File Library). Uploads require `projectId` with a configured folder. Portal/connector-facing; requires `files:*` scopes. Narrative: `/docs/library-integration#file-library`. Connector handoff: `docs/handoffs/FILE_LIBRARY_CONNECTORS.md`.' },
      { name: 'Webhooks',           description: 'Inspect webhook signature contract.' },
      { name: 'Access', description: [
        'Portal-brokered identity + connector authorisation, served by the',
        '`prism-permissions-service` and routed under this origin at `/api/access/*`.',
        '',
        '**Flow (portal → connector):**',
        '1. Open `GET /api/access/login?redirect_uri=…` (or the dev `mock-login`); the',
        '   user signs in with the REBUS portal (Google) and the browser is redirected',
        '   back to the connector loopback with an OAuth `code`.',
        '2. Exchange the `code` at `POST /api/access/session` → a `ConnectorManifest`:',
        '   a scoped ORBIT bearer token plus the per-project allowed-function map.',
        '   **Effective permissions = portal project grant ∩ function-policy graph**',
        '   (see the **Permissions** tag).',
        '3. Use `manifest.orbitToken` for ORBIT calls and gate UI/actions on',
        '   `projects[].allowedFunctions` / `globalAllowedFunctions`. Refresh via',
        '   `GET /api/access/manifest?sessionId=…` before `expiresAt`.',
        '',
        'These endpoints are **public** — the portal OAuth `code` / opaque `sessionId`',
        'is the credential (no `X-API-Key`). Narrative companion: `docs/PORTAL_CONTRACT.md`.',
      ].join('\n') },
      { name: 'Permissions', description: [
        'The function-policy graph — the node-based "permissions node" the admin',
        'Permissions page edits and a portal can render. Node types are `role` /',
        '`user` / `project` / `function`; an edge from a principal (role/user) to a',
        '`function` node grants that `ConnectorFunction` (optionally on a `project`).',
        'The graph is intersected with each user\'s portal project grants to produce',
        'the manifest `allowedFunctions`.',
        '',
        '**Auth:** admin session cookie (`prism_admin`) — these are management',
        'endpoints, not portal-facing.',
      ].join('\n') },
      { name: 'Workspace', description: 'Google Workspace linking + pre-provisioned users (admin session cookie). Provisioned users can be granted PRISM admin access and pre-assigned ORBIT project permissions + role refs before their first sign-in.' },
    ],

    security: [{ apiKey: [] }],

    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: [
            'Plaintext API key minted in the PRISM admin UI. Format: `prism_<base64url>`.',
            '',
            '## Scopes',
            '',
            'Scopes are a column on the `api_keys` table; keys minted without',
            'a scope set get the full surface (legacy keys, admin-issued).',
            'Portal-issued keys SHOULD carry the minimum scope set:',
            '',
            '- `visualiser:create_stream` - required for `POST /api/visualiser/streams`',
            '  and `DELETE /api/visualiser/streams/{runId}`.',
            '- `visualiser:attach_project_files` - required for',
            '  `POST /api/projects/{projectId}/attachments` and',
            '  `DELETE /api/projects/{projectId}/attachments/{id}`.',
            '',
            '**Library scopes** (fixtures / models / materials / files — see',
            '`/docs/library-integration`):',
            '',
            '- `fixtures:read|write|delete|import` — `/api/fixtures/*`',
            '- `models:read|write|delete|import` — `/api/models/*`, `/api/model-import`, `/api/meshy/*` (generate + download; import still uses `models:import`)',
            '- `materials:read|write|delete` — `/api/materials/*`, `/api/textures/*`',
            '- `files:read|write|delete` — `/api/files/*` (native CAD/DCC source archive)',
            '',
            'Library routes enforce scopes on **every** method (including GET).',
            'Visualiser read-only GETs accept any valid key; library GETs require',
            'the matching `:read` scope.',
          ].join('\n'),
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'prism_admin',
          description: [
            'PRISM admin session cookie, set by the admin SPA login. Gates the',
            '`/api/permissions/*` management endpoints (function-policy graph +',
            'Google Workspace provisioning). Not used by the portal-facing',
            '`/api/access/*` endpoints, which authenticate with a portal OAuth',
            'code / opaque session id instead.',
          ].join('\n'),
        },
      },
      headers: {
        'X-RateLimit-Limit':     { description: 'Per-minute request budget for the key.',     schema: { type: 'integer' } },
        'X-RateLimit-Remaining': { description: 'Requests remaining in the current minute.',  schema: { type: 'integer' } },
        'X-RateLimit-Reset':     { description: 'Unix epoch seconds when the bucket resets.', schema: { type: 'integer' } },
        'X-Quota-Limit':         { description: 'Monthly job-submission quota for the key.',  schema: { type: 'integer' } },
        'X-Quota-Remaining':     { description: 'Quota remaining for this calendar month.',   schema: { type: 'integer' } },
        'X-Quota-Reset':         { description: 'Unix epoch seconds when the quota resets.',  schema: { type: 'integer' } },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error:  { type: 'string', example: 'unsupported format: .xyz' },
            issues: { type: 'array', items: { type: 'object' }, description: 'Optional zod validation issues.' },
          },
        },
        JobStatus: {
          type: 'string',
          enum: ['queued', 'dispatched', 'awaiting_selection', 'processing', 'uploading', 'complete', 'failed', 'cancelled'],
          description: [
            'Job lifecycle:',
            '* `queued` — job persisted, awaiting dispatch.',
            '* `dispatched` — sent to an agent (convert OR pollLayers — see `currentStage`).',
            '* `awaiting_selection` — two-phase flow only: agent returned the layer tree;',
            '  POST `/jobs/{id}/layers` with your selection to resume.',
            '* `processing` — agent is converting.',
            '* `uploading` — agent is uploading to ORBIT / non-ORBIT outputs.',
            '* `complete` / `failed` / `cancelled` — terminal.',
          ].join('\n'),
        },
        LayerNode: {
          type: 'object',
          required: ['name'],
          properties: {
            name:     { type: 'string', description: 'Layer display name.' },
            fullPath: { type: 'string', description: 'Rhino layer full path (parents joined with " :: ").' },
            color:    { type: 'string', description: 'Layer display colour as #rrggbb hex.' },
            visible:  { type: 'boolean', description: 'True when the layer is visible AND unlocked.' },
            children: { type: 'array', items: { $ref: '#/components/schemas/LayerNode' } },
          },
        },
        LayersResponse: {
          type: 'object',
          required: ['jobId', 'status', 'layers'],
          properties: {
            jobId:                   { type: 'string', format: 'uuid' },
            status:                  { $ref: '#/components/schemas/JobStatus' },
            layers:                  { type: 'array', items: { $ref: '#/components/schemas/LayerNode' } },
            includedLayers:          { type: 'array', items: { type: 'string' } },
            includeLayerDescendants: { type: 'boolean' },
          },
        },
        LayerSelection: {
          type: 'object',
          required: ['includedLayers'],
          properties: {
            includedLayers:          { type: 'array', items: { type: 'string' }, description: 'List of layer `fullPath` strings to include.' },
            includeLayerDescendants: { type: 'boolean', default: false, description: 'Auto-include every descendant of each selected layer.' },
          },
        },
        JobKind: {
          type: 'string',
          enum: ['convert', 'receive'],
        },
        Job: {
          type: 'object',
          properties: {
            id:               { type: 'string', format: 'uuid' },
            status:           { $ref: '#/components/schemas/JobStatus' },
            jobType:          { $ref: '#/components/schemas/JobKind' },
            createdAt:        { type: 'string', format: 'date-time' },
            updatedAt:        { type: 'string', format: 'date-time' },
            completedAt:      { type: 'string', format: 'date-time', nullable: true },
            fileName:         { type: 'string' },
            fileSize:         { type: 'integer' },
            format:           { type: 'string', example: '.3dm' },
            orbitTarget:      { type: 'string', enum: ['prod', 'dev'] },
            projectId:        { type: 'string' },
            modelId:          { type: 'string' },
            modelName:        { type: 'string', nullable: true },
            currentStage:     { type: 'string', nullable: true,
                                example: 'meshing',
                                description: 'Current agent-side pipeline node.' },
            progressPercent:  { type: 'integer', nullable: true, minimum: 0, maximum: 100 },
            lastMessage:      { type: 'string', nullable: true },
            resultUrl:        { type: 'string', nullable: true, description: 'Deep link to the resulting ORBIT version (for convert jobs).' },
            versionId:        { type: 'string', nullable: true, description: 'ORBIT version id produced by a convert job.' },
            rootObjectId:     { type: 'string', nullable: true },
            outputs:          { type: 'object',
                                additionalProperties: { type: 'string', format: 'uri' },
                                nullable: true,
                                description: 'For convert jobs that requested extra outputs (3dm, step, glb, ifc) this maps format -> downloadable URL.' },
            receiveVersionId: { type: 'string', nullable: true, description: 'For receive jobs: the ORBIT version that was materialised.' },
            error:            { type: 'string', nullable: true },
          },
        },
        JobAccepted: {
          type: 'object',
          required: ['jobId', 'status'],
          properties: {
            jobId:  { type: 'string', format: 'uuid' },
            status: { type: 'string', example: 'queued' },
          },
        },
        WebhookSignatureSpec: {
          type: 'object',
          properties: {
            header:    { type: 'string', example: 'x-prism-signature' },
            algorithm: { type: 'string', example: 'HMAC-SHA256' },
            encoding:  { type: 'string', example: 'sha256=<hex>' },
            payload:   { type: 'string', example: 'raw request body bytes' },
          },
        },

        // ============================================================
        // Phase K - Visualiser + Project Attachments
        // ============================================================
        VisualiserStatus: {
          type: 'string',
          enum: ['queued', 'importing', 'streaming', 'failed', 'ended'],
          description: [
            'Lifecycle of a single visualiser run:',
            '* `queued`    - row created; dispatcher not yet picked a workstation.',
            '* `importing` - dispatched; agent is materialising the ORBIT version into UE.',
            '* `streaming` - orchestrator handed back a ready event; signallingUrl is live.',
            '* `failed`    - terminal (agent failed, start_timeout, no workstation, etc).',
            '* `ended`     - terminal (admin cancel, TTL expired, UE exited, browser disconnect).',
          ].join('\n'),
        },
        VisualiserTurnBundle: {
          type: 'object',
          description: [
            'RFC 7635 long-term TURN credential bundle for coturn at',
            '`visualiser.rebus.industries`. `null` when the server has not been',
            'configured with `TURN_SECRET` yet (Phase H wires it).',
            '',
            'The credential is HMAC-derived from a long-lived shared secret with',
            'a 24h TTL; the same bundle is valid for the lifetime of the stream',
            'so the portal does not need to refresh mid-session.',
          ].join('\n'),
          nullable: true,
          required: ['urls', 'username', 'credential', 'ttl'],
          properties: {
            urls:       {
              type: 'array',
              items: { type: 'string', example: 'turn:visualiser.rebus.industries:3478' },
              description: 'TURN URIs in priority order. Includes a `turns:` (TLS) entry for restrictive networks.',
            },
            username:   { type: 'string', example: '1748284800:5b9c1d4f' },
            credential: { type: 'string', example: 'gHrjK0iA0sM...' },
            ttl:        { type: 'integer', example: 86400, description: 'Lifetime of the credential in seconds.' },
          },
        },
        VisualiserStartRequest: {
          type: 'object',
          required: ['projectId', 'modelId'],
          properties: {
            projectId:              { type: 'string', description: 'ORBIT project id.', example: 'cf900606f5' },
            modelId:                { type: 'string', description: 'ORBIT model id.',   example: 'be45d33eb1' },
            versionId:              { type: 'string', description: 'ORBIT version id. Omit to materialise the model\'s latest version.', example: 'v_2026_05_12_001' },
            orbitTarget:            { type: 'string', enum: ['prod', 'dev'], default: 'prod' },
            preferredWorkstationId: { type: 'string', format: 'uuid', description: 'Reserved - the dispatcher currently picks the least-loaded eligible workstation.' },
            callbackUrl:            { type: 'string', format: 'uri',  description: 'Reserved - the server accepts this field today but does not yet POST status updates to it.' },
            templateTag:            { type: 'string', description: 'Pin the UE template tag the agent runs against (e.g. `v1.0.0-ue5.7`).' },
            ttlSeconds:             { type: 'integer', minimum: 1, description: 'Hard tear-down deadline enforced by the orchestrator.' },
          },
        },
        VisualiserReadyResponse: {
          type: 'object',
          description: 'Returned synchronously from `POST /api/visualiser/streams` when the agent successfully imports + brings up the stream. Schema version `prism-visualiser/ready/v1`.',
          required: ['schema', 'runId', 'status', 'signallingUrl', 'playerUrl'],
          properties: {
            schema:        { type: 'string', example: 'prism-visualiser/ready/v1' },
            runId:         { type: 'string', format: 'uuid' },
            status:        { type: 'string', enum: ['streaming'] },
            signallingUrl: { type: 'string', example: 'wss://prism.rebus.industries/ws/visualiser/<runId>/signalling',
                             description: 'Append the short-lived JWT minted by `POST /api/visualiser/streams/{runId}/signalling-token` as `?token=...` before opening this WS.' },
            playerUrl:     { type: 'string', example: 'https://prism.rebus.industries/admin/#/visualiser/<runId>',
                             description: 'PRISM-hosted debug player. Third-party portals embed Epic\'s `lib-pixelstreamingfrontend` directly and DO NOT need to load this URL.' },
            streamerId:    { type: 'string', example: 'orbit_5b9c1d4f',
                             description: 'Pixel Streaming streamer id (`orbit_<runIdShort>`). Pass to the PS frontend lib if you want explicit streamer selection.' },
            turn:          { $ref: '#/components/schemas/VisualiserTurnBundle' },
          },
        },
        VisualiserFailedResponse: {
          type: 'object',
          description: 'Returned by `POST /api/visualiser/streams` (or surfaced via the WS event) on any terminal failure during the start round-trip. Schema version `prism-visualiser/failed/v1`.',
          required: ['schema', 'runId', 'error', 'code', 'message'],
          properties: {
            schema:  { type: 'string', example: 'prism-visualiser/failed/v1' },
            runId:   { type: 'string', format: 'uuid' },
            error:   { type: 'string', example: 'visualisation_failed' },
            code:    {
              type: 'string',
              example: 'start_timeout',
              description: [
                'Machine-readable failure code. Stable across releases:',
                '* `no_workstation_available` - no workstation with `can_visualise` is online.',
                '* `all_workstations_busy`    - every eligible workstation is at its visualiser slot cap.',
                '* `agent_failed`             - the agent reported a `prism-visualiser/failed/v1` envelope.',
                '* `start_timeout`            - agent did not reply within `VISUALISER_START_TIMEOUT_MS`.',
                '* `misconfigured`            - server-side config is incomplete (missing ORBIT URL/token for the target, rejected ORBIT credentials, TURN/JWT secret). Admin must fix; do not retry.',
                '* `version_unavailable`      - the requested project/model/version cannot be resolved on ORBIT (bad id, wrong `orbitTarget`, project not shared with PRISM\'s token, or no committed version). Caller-data error (HTTP 422) - fix the ids; do not retry as-is.',
                '* `agent_send_failed`        - server-to-agent WS send threw.',
                '* `gpu_preflight_failed`     - workstation failed the GPU pre-flight (Phase K hardening; orchestrator exit code 10).',
              ].join('\n'),
            },
            message: { type: 'string', example: 'start exceeded 180000ms' },
          },
        },
        VisualiserRun: {
          type: 'object',
          required: ['id', 'status', 'projectId', 'modelId', 'createdAt'],
          properties: {
            id:                  { type: 'string', format: 'uuid' },
            status:              { $ref: '#/components/schemas/VisualiserStatus' },
            orbitTarget:         { type: 'string', enum: ['prod', 'dev'] },
            projectId:           { type: 'string' },
            modelId:             { type: 'string' },
            versionId:           { type: 'string', nullable: true },
            templateTag:         { type: 'string', nullable: true },
            workstationId:       { type: 'string', format: 'uuid', nullable: true },
            agentSessionId:      { type: 'string', format: 'uuid', nullable: true },
            signallingUrl:       { type: 'string', nullable: true },
            playerUrl:           { type: 'string', nullable: true },
            streamerId:          { type: 'string', nullable: true },
            failureReason:       { type: 'string', nullable: true },
            error:               { type: 'string', nullable: true },
            ttlSeconds:          { type: 'integer', nullable: true },
            submittedBy:         { type: 'string', nullable: true, description: 'Opaque principal string. Format: `apiKey:<id>` / `admin:<username>` / `orbit:<userId>`.' },
            requestedByApiKeyId: { type: 'string', format: 'uuid', nullable: true },
            createdAt:           { type: 'string', format: 'date-time' },
            updatedAt:           { type: 'string', format: 'date-time' },
            dispatchedAt:        { type: 'string', format: 'date-time', nullable: true },
            readyAt:             { type: 'string', format: 'date-time', nullable: true },
            endedAt:             { type: 'string', format: 'date-time', nullable: true },
            turn:                { $ref: '#/components/schemas/VisualiserTurnBundle', description: 'Fresh TURN credential. Only attached to single-row GETs while the run is `streaming`.' },
          },
        },
        VisualiserSignallingToken: {
          type: 'object',
          required: ['token', 'exp'],
          properties: {
            token:    { type: 'string', description: 'HS256 JWT. Append as `?token=...` to the signalling WS URL.' },
            exp:      { type: 'integer', description: 'Token expiry, Unix epoch seconds. Default TTL 1 hour (JWT_SIGNALLING_TTL_SEC).' },
            viewerId: { type: 'string', description: 'Stable per-viewer demux key embedded in the token. Reuse it across token refreshes so the viewer\'s Wilbur player + controller seat survive a reconnect.' },
            tier:     { type: 'string', enum: ['view', 'control'], description: 'Viewer tier carried by the token. `signalling-token` always mints `control`; `view`-tier seats come from share links.' },
          },
        },
        VisualiserShareCreateRequest: {
          type: 'object',
          description: 'Body for `POST /api/visualiser/streams/{runId}/shares`.',
          properties: {
            tier:             { type: 'string', enum: ['view', 'control'], default: 'view', description: 'Tier granted to anyone who redeems the link.' },
            expiresInSeconds: { type: 'integer', minimum: 1, maximum: 86_400, description: 'Optional TTL on top of the run-lifetime auto-expiry. Capped at 24h.' },
          },
        },
        VisualiserShareLink: {
          type: 'object',
          description: 'A share link. The plaintext `shareToken` + `url` are returned ONLY from the mint response (shown once); list/GET omit them — only the SHA-256 hash is stored.',
          required: ['id', 'tier', 'createdAt'],
          properties: {
            id:         { type: 'string', format: 'uuid' },
            tier:       { type: 'string', enum: ['view', 'control'] },
            url:        { type: 'string', format: 'uri', description: 'Mint response only. Public viewer URL embedding the token: `…/viewer/#/<runId>?st=<token>`.' },
            shareToken: { type: 'string', description: 'Mint response only — the opaque plaintext token, shown once.' },
            createdBy:  { type: 'string', nullable: true },
            createdAt:  { type: 'string', format: 'date-time' },
            expiresAt:  { type: 'string', format: 'date-time', nullable: true },
            revokedAt:  { type: 'string', format: 'date-time', nullable: true },
          },
        },
        VisualiserShareExchangeRequest: {
          type: 'object',
          required: ['shareToken'],
          properties: {
            shareToken: { type: 'string', description: 'The opaque token from the share URL\'s `?st=` parameter.' },
            viewerId:   { type: 'string', minLength: 1, maxLength: 64, description: 'Optional stable per-session viewer id so identity survives JWT refreshes. A random one is minted when absent.' },
          },
        },
        VisualiserShareExchangeResponse: {
          type: 'object',
          description: 'Returned from the public `POST /api/visualiser/streams/{runId}/shares/exchange`. Carries a tier-scoped signalling JWT plus everything needed to open the stream.',
          required: ['token', 'exp', 'viewerId', 'tier', 'runId', 'signallingUrl'],
          properties: {
            token:         { type: 'string', description: 'HS256 signalling JWT carrying the link\'s tier + viewerId.' },
            exp:           { type: 'integer', description: 'Token expiry, Unix epoch seconds.' },
            viewerId:      { type: 'string' },
            tier:          { type: 'string', enum: ['view', 'control'] },
            runId:         { type: 'string', format: 'uuid' },
            signallingUrl: { type: 'string', description: 'Append `?token=...` and open as a WebSocket.' },
            turn:          { $ref: '#/components/schemas/VisualiserTurnBundle' },
          },
        },
        VisualiserWorkstation: {
          type: 'object',
          description: 'Eligible workstation entry returned by `GET /api/visualiser/workstations`.',
          required: ['id', 'nodeName', 'machineId', 'canVisualise', 'currentVisualiserLoad', 'slotsTotal', 'online'],
          properties: {
            id:                    { type: 'string', format: 'uuid' },
            nodeName:              { type: 'string', example: 'RB-DA2-PC01' },
            machineId:             { type: 'string', example: 'auto:7a2...' },
            canVisualise:          { type: 'boolean' },
            currentVisualiserLoad: { type: 'integer', description: 'Visualiser runs currently active on this workstation. Single-tenant in v1; expect 0 or 1.' },
            slotsTotal:            { type: 'integer', description: 'Total agent slots on this workstation (shared across roles).' },
            agentVersion:          { type: 'string', nullable: true, example: '0.2.0' },
            online:                { type: 'boolean' },
          },
        },
        ProjectAttachment: {
          type: 'object',
          required: ['id', 'projectId', 'filename', 'contentType', 'sizeBytes', 'uploadedAt'],
          properties: {
            id:                  { type: 'string', format: 'uuid' },
            projectId:           { type: 'string', description: 'ORBIT project id.' },
            filename:            { type: 'string', description: 'Original filename as uploaded.', example: 'show_2026.mvr' },
            contentType:         { type: 'string', example: 'application/mvr' },
            sizeBytes:           { type: 'integer', description: 'Body size in bytes. Hard cap 50 MB.' },
            uploadedAt:          { type: 'string', format: 'date-time' },
            uploadedByApiKeyId:  { type: 'string', format: 'uuid', nullable: true },
          },
        },
        ProjectAttachmentList: {
          type: 'object',
          required: ['attachments'],
          properties: {
            attachments: { type: 'array', items: { $ref: '#/components/schemas/ProjectAttachment' } },
          },
        },

        // ============================================================
        // Permissions & portal-brokered access (prism-permissions-service)
        // ============================================================
        ConnectorFunction: {
          type: 'string',
          enum: ['send', 'receive', 'list_projects', 'list_models', 'list_versions', 'create_model', 'create_version', 'use_library', 'use_infile'],
          description: 'A connector operation the function-policy graph can grant or deny (per project). `use_library` / `use_infile` gate the Library and In File panel surfaces.',
        },
        PortalProjectLevel: {
          type: 'string',
          enum: ['viewer', 'contributor', 'owner', 'admin'],
          description: 'Project access level reported by the REBUS portal.',
        },
        PortalUser: {
          type: 'object',
          required: ['userId', 'email'],
          properties: {
            userId:      { type: 'string' },
            email:       { type: 'string', format: 'email' },
            googleSub:   { type: 'string', nullable: true },
            displayName: { type: 'string', nullable: true },
            roleId:      { type: 'string', nullable: true, description: 'Primary role id. Must match a `PortalRole.id` and the tool-grant keys (case-sensitive). super-admin gets all tools.' },
            roleIds:     { type: 'array', items: { type: 'string' }, nullable: true, description: 'All role ids the user holds; unioned for grant resolution.' },
            role:        { type: 'string', nullable: true, description: 'Deprecated legacy system role name; superseded by roleId.' },
            customRoleId:{ type: 'string', nullable: true, description: 'Deprecated legacy custom role id; superseded by roleId/roleIds.' },
          },
        },
        PortalRole: {
          type: 'object',
          required: ['id'],
          properties: {
            id:     { type: 'string', description: 'Canonical role id matched against PortalUser.role/customRoleId and tool-grant keys.' },
            name:   { type: 'string', nullable: true, description: 'Human-readable label (defaults to id).' },
            system: { type: 'boolean', description: 'True for built-in portal system roles.' },
          },
        },
        PortalRolesResponse: {
          type: 'object',
          required: ['roles', 'supported', 'fetchedAt'],
          properties: {
            roles:     { type: 'array', items: { $ref: '#/components/schemas/PortalRole' } },
            supported: { type: 'boolean', description: 'False when the portal has not implemented GET /portal/roles yet (PRISM then falls back to grant-derived roles).' },
            fetchedAt: { type: 'string', format: 'date-time' },
          },
        },
        PortalProjectPermission: {
          type: 'object',
          required: ['orbitProjectId', 'level'],
          properties: {
            orbitProjectId: { type: 'string', description: 'ORBIT project id.' },
            level:          { $ref: '#/components/schemas/PortalProjectLevel' },
            projectName:    { type: 'string', nullable: true },
          },
        },
        AccessSessionRequest: {
          type: 'object',
          required: ['portalAuthCode'],
          properties: {
            portalAuthCode: { type: 'string', description: 'OAuth-style code from the portal callback. The mock adapter accepts `mock:<persona>` (e.g. `mock:alice`).' },
            orbitTarget:    { type: 'string', enum: ['prod', 'dev'], default: 'prod', description: 'Which ORBIT server to mint the scoped token against.' },
            redirectUri:    { type: 'string', format: 'uri', description: 'Redirect URI used in the portal OAuth round-trip; must match what was registered.' },
          },
        },
        ConnectorManifestProject: {
          type: 'object',
          required: ['orbitProjectId', 'level', 'allowedFunctions'],
          properties: {
            orbitProjectId:   { type: 'string' },
            projectName:      { type: 'string', nullable: true },
            level:            { $ref: '#/components/schemas/PortalProjectLevel' },
            allowedFunctions: { type: 'array', items: { $ref: '#/components/schemas/ConnectorFunction' }, description: 'Effective functions for this project = portal grant ∩ function-policy graph.' },
          },
        },
        ConnectorManifest: {
          type: 'object',
          description: 'Returned to a connector (or portal) after portal-brokered login. Schema id `rebus/connector-manifest/v1`. Carries the scoped ORBIT token plus the per-project allowed-function map a portal can render as a permissions node.',
          required: ['schema', 'userId', 'email', 'orbitTarget', 'orbitServerUrl', 'orbitToken', 'expiresAt', 'sessionId', 'projects', 'globalAllowedFunctions'],
          properties: {
            schema:                 { type: 'string', example: 'rebus/connector-manifest/v1' },
            userId:                 { type: 'string' },
            email:                  { type: 'string', format: 'email' },
            displayName:            { type: 'string', nullable: true },
            orbitTarget:            { type: 'string', enum: ['prod', 'dev'] },
            orbitServerUrl:         { type: 'string', format: 'uri' },
            orbitToken:             { type: 'string', description: 'Scoped ORBIT bearer token — use for all ORBIT API calls. Treat as a secret.' },
            expiresAt:              { type: 'string', format: 'date-time', description: 'Token expiry (ISO). Refresh via GET /api/access/manifest before this.' },
            sessionId:              { type: 'string', description: 'Opaque session id for manifest refresh.' },
            projects:               { type: 'array', items: { $ref: '#/components/schemas/ConnectorManifestProject' } },
            globalAllowedFunctions: { type: 'array', items: { $ref: '#/components/schemas/ConnectorFunction' }, description: 'Default allowed functions when a project is not in `projects`.' },
          },
        },
        AccessSessionResponse: {
          type: 'object',
          required: ['manifest'],
          properties: { manifest: { $ref: '#/components/schemas/ConnectorManifest' } },
        },
        ProvisionedAdminCheck: {
          type: 'object',
          required: ['allowed', 'email'],
          properties: {
            allowed:            { type: 'boolean', description: 'True when the email is a provisioned PRISM admin allowed to sign into the admin SPA.' },
            prismAdminUsername: { type: 'string', nullable: true, description: 'Local admin username the portal identity binds to.' },
            email:              { type: 'string', format: 'email' },
          },
        },
        PolicyNodeType: {
          type: 'string',
          enum: ['role', 'user', 'project', 'function'],
        },
        PolicyNode: {
          type: 'object',
          required: ['id', 'type', 'label', 'position'],
          properties: {
            id:       { type: 'string' },
            type:     { $ref: '#/components/schemas/PolicyNodeType' },
            label:    { type: 'string' },
            ref:      { type: 'string', nullable: true, description: 'Role name, user email, ORBIT project id, or function id depending on `type`.' },
            position: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
            data:     { type: 'object', additionalProperties: true, nullable: true },
          },
        },
        PolicyEdge: {
          type: 'object',
          required: ['id', 'source', 'target'],
          properties: {
            id:     { type: 'string' },
            source: { type: 'string', description: 'Source node id (principal: role/user).' },
            target: { type: 'string', description: 'Target node id (function, optionally on a project).' },
            grant:  { type: 'boolean', default: true, description: 'When true (default) the edge grants the target function to the source principal.' },
          },
        },
        FunctionPolicyGraph: {
          type: 'object',
          required: ['nodes', 'edges'],
          properties: {
            nodes:     { type: 'array', items: { $ref: '#/components/schemas/PolicyNode' } },
            edges:     { type: 'array', items: { $ref: '#/components/schemas/PolicyEdge' } },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        PermissionsPolicyResponse: {
          type: 'object',
          required: ['graph', 'defaultFunctions'],
          properties: {
            graph:            { $ref: '#/components/schemas/FunctionPolicyGraph' },
            defaultFunctions: { type: 'array', items: { $ref: '#/components/schemas/ConnectorFunction' }, description: 'Functions granted when the graph yields nothing for a principal.' },
          },
        },
        GoogleWorkspaceLink: {
          type: 'object',
          required: ['id', 'domain', 'status', 'adapter', 'userCount'],
          properties: {
            id:          { type: 'string' },
            domain:      { type: 'string', example: 'rebus.industries' },
            displayName: { type: 'string', nullable: true },
            status:      { type: 'string', enum: ['disconnected', 'linked', 'syncing'] },
            adapter:     { type: 'string', example: 'mock', description: '`mock` or `google_admin_sdk`.' },
            linkedAt:    { type: 'string', format: 'date-time', nullable: true },
            lastSyncAt:  { type: 'string', format: 'date-time', nullable: true },
            userCount:   { type: 'integer' },
          },
        },
        ProvisionedUser: {
          type: 'object',
          required: ['id', 'email', 'status', 'source', 'isPrismAdmin', 'projectPermissions', 'roleRefs', 'createdAt', 'updatedAt'],
          properties: {
            id:                 { type: 'string', format: 'uuid' },
            email:              { type: 'string', format: 'email' },
            displayName:        { type: 'string', nullable: true },
            googleSub:          { type: 'string', nullable: true },
            status:             { type: 'string', enum: ['pending', 'active', 'suspended'] },
            source:             { type: 'string', enum: ['manual', 'workspace_sync'] },
            isPrismAdmin:       { type: 'boolean', description: 'Grant PRISM admin SPA access on Google sign-in.' },
            prismAdminUsername: { type: 'string', nullable: true },
            projectPermissions: { type: 'array', items: { $ref: '#/components/schemas/PortalProjectPermission' }, description: 'Pre-defined ORBIT project access applied before first login.' },
            roleRefs:           { type: 'array', items: { type: 'string' }, description: 'Role refs matched against `role` nodes in the function-policy graph.' },
            lastLoginAt:        { type: 'string', format: 'date-time', nullable: true },
            createdAt:          { type: 'string', format: 'date-time' },
            updatedAt:          { type: 'string', format: 'date-time' },
          },
        },
        ProvisionedUserInput: {
          type: 'object',
          required: ['email'],
          properties: {
            email:              { type: 'string', format: 'email' },
            displayName:        { type: 'string', nullable: true },
            isPrismAdmin:       { type: 'boolean', default: false },
            prismAdminUsername: { type: 'string', nullable: true },
            projectPermissions: { type: 'array', items: { $ref: '#/components/schemas/PortalProjectPermission' } },
            roleRefs:           { type: 'array', items: { type: 'string' } },
            status:             { type: 'string', enum: ['pending', 'active', 'suspended'] },
          },
        },
        WorkspaceSyncResult: {
          type: 'object',
          required: ['linked', 'imported', 'updated', 'unchanged'],
          properties: {
            linked:    { $ref: '#/components/schemas/GoogleWorkspaceLink' },
            imported:  { type: 'integer' },
            updated:   { type: 'integer' },
            unchanged: { type: 'integer' },
          },
        },
        WorkspaceOverview: {
          type: 'object',
          required: ['workspace', 'users'],
          properties: {
            workspace: { $ref: '#/components/schemas/GoogleWorkspaceLink', nullable: true, description: 'null when no domain is linked.' },
            users:     { type: 'array', items: { $ref: '#/components/schemas/ProvisionedUser' } },
          },
        },

        // ============================================================
        // Library APIs — fixtures, models (portal-facing)
        // Narrative: /docs/library-integration
        // ============================================================
        FixtureVersionSummary: {
          type: 'object',
          required: ['id', 'fixtureTypeId', 'gdtfHash', 'downloadedAt', 'isActive', 'previewUrl'],
          properties: {
            id:              { type: 'string', format: 'uuid' },
            fixtureTypeId:   { type: 'string', format: 'uuid' },
            gdtfShareRid:     { type: 'integer', nullable: true },
            gdtfShareUuid:    { type: 'string', nullable: true },
            gdtfVersion:      { type: 'string', nullable: true },
            revision:         { type: 'string', nullable: true, description: 'GDTF revision label.' },
            gdtfHash:         { type: 'string' },
            originalMediaId:  { type: 'string', format: 'uuid', nullable: true },
            previewModelId:   { type: 'string', format: 'uuid', nullable: true, description: 'Internal media id — use `previewUrl` for portal embeds.' },
            downloadedAt:     { type: 'string', format: 'date-time', description: 'When PRISM stored this revision.' },
            isActive:         { type: 'boolean' },
            previewUrl:       {
              type: 'string',
              nullable: true,
              example: '/api/fixtures/65906ae4-284e-4cb3-9c88-3a02b95163a8/preview.glb',
              description: 'Relative preview path. Active version → `/preview.glb`; other revisions → `/media/{previewModelId}`.',
            },
          },
        },
        FixtureListItem: {
          type: 'object',
          required: ['id', 'name', 'manufacturer', 'fixtureName', 'tags', 'importSource', 'origin', 'status', 'hasPreview', 'previewUrl', 'orbitUrl', 'versions', 'createdAt', 'updatedAt'],
          properties: {
            id:               { type: 'string', format: 'uuid' },
            name:             { type: 'string' },
            manufacturer:     { type: 'string' },
            fixtureName:      { type: 'string' },
            revision:         { type: 'string', nullable: true },
            tags:             { type: 'array', items: { type: 'string' } },
            sourceGdtfHash:   { type: 'string', nullable: true },
            gdtfShareUuid:    { type: 'string', nullable: true },
            importSource:     { type: 'string', enum: ['upload', 'gdtf-share', 'mvr-embedded'] },
            origin:           { type: 'string', enum: ['gdtf-share', 'upload', 'mvr', 'manual'] },
            activeVersionId:  { type: 'string', format: 'uuid', nullable: true },
            status:           { type: 'string', example: 'published' },
            hasPreview:       { type: 'boolean' },
            updateAvailable:  { type: 'boolean' },
            previewUrl:       {
              type: 'string',
              nullable: true,
              description: 'Relative path to the active version preview GLB.',
            },
            orbitUrl:         {
              type: 'string',
              nullable: true,
              format: 'uri',
              description: 'Orbit viewer URL when the fixture type was published to Orbit.',
            },
            versions:         {
              type: 'array',
              items: { $ref: '#/components/schemas/FixtureVersionSummary' },
              description: 'Stored GDTF revision history.',
            },
            createdAt:        { type: 'string', format: 'date-time' },
            updatedAt:        { type: 'string', format: 'date-time' },
          },
        },
        FixtureDetail: {
          allOf: [
            { $ref: '#/components/schemas/FixtureListItem' },
            {
              type: 'object',
              required: ['definition', 'previewModelId'],
              properties: {
                definition:      { type: 'object', additionalProperties: true, description: 'Full GDTF-derived definition (parts, DMX, beams, wheels, metadata.orbitFixtureRef).' },
                previewModelId:  { type: 'string', format: 'uuid', nullable: true },
                sourceGdtfId:    { type: 'string', nullable: true },
                activeVersion:   { $ref: '#/components/schemas/FixtureVersionSummary', nullable: true },
              },
            },
          ],
        },
        FixtureListResponse: {
          type: 'object',
          required: ['fixtures', 'nextCursor'],
          properties: {
            fixtures:   { type: 'array', items: { $ref: '#/components/schemas/FixtureListItem' } },
            nextCursor: { type: 'string', nullable: true },
          },
        },
        FixtureDetailResponse: {
          type: 'object',
          required: ['fixture'],
          properties: {
            fixture: { $ref: '#/components/schemas/FixtureDetail' },
          },
        },
        ModelVersionSummary: {
          type: 'object',
          required: ['id', 'createdAt', 'isActive', 'previewUrl', 'orbitUrl'],
          properties: {
            id:          { type: 'string', format: 'uuid' },
            sourceHash:  { type: 'string', nullable: true },
            createdAt:   { type: 'string', format: 'date-time', description: 'When the import/version row was created.' },
            isActive:    { type: 'boolean' },
            previewUrl:  { type: 'string', nullable: true, description: 'Relative preview GLB path for this version.' },
            orbitUrl:    { type: 'string', nullable: true, format: 'uri', description: 'Orbit viewer URL when this version carries an Orbit ref.' },
          },
        },
        ModelListItem: {
          type: 'object',
          required: ['id', 'name', 'tags', 'status', 'origin', 'hasPreview', 'previewUrl', 'orbitUrl', 'versions', 'createdAt', 'updatedAt'],
          properties: {
            id:               { type: 'string', format: 'uuid' },
            name:             { type: 'string' },
            category:         { type: 'string', nullable: true },
            tags:             { type: 'array', items: { type: 'string' } },
            status:           { type: 'string', enum: ['draft', 'published'] },
            origin:           { type: 'string', enum: ['upload', 'import', 'manual'] },
            description:      { type: 'string', nullable: true },
            activeVersionId:  { type: 'string', format: 'uuid', nullable: true },
            hasPreview:       { type: 'boolean' },
            importStatus:     { type: 'string', enum: ['converting', 'complete', 'failed'], nullable: true },
            importJobId:      { type: 'string', nullable: true },
            previewUrl:       { type: 'string', nullable: true },
            orbitUrl:         { type: 'string', nullable: true, format: 'uri' },
            versions:         { type: 'array', items: { $ref: '#/components/schemas/ModelVersionSummary' } },
            createdAt:        { type: 'string', format: 'date-time' },
            updatedAt:        { type: 'string', format: 'date-time' },
          },
        },
        ModelDetail: {
          allOf: [
            { $ref: '#/components/schemas/ModelListItem' },
            {
              type: 'object',
              required: ['definition'],
              properties: {
                definition:   { type: 'object', additionalProperties: true, description: 'Meshes, material slots, bounding box, metadata.orbit.' },
                dimensions:   { type: 'object', nullable: true, properties: { length: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } },
                boundingBox:  { type: 'object', nullable: true, additionalProperties: true },
              },
            },
          ],
        },
        ModelListResponse: {
          type: 'object',
          required: ['models', 'nextCursor'],
          properties: {
            models:     { type: 'array', items: { $ref: '#/components/schemas/ModelListItem' } },
            nextCursor: { type: 'string', nullable: true },
          },
        },
        ModelDetailResponse: {
          type: 'object',
          required: ['model'],
          properties: {
            model: { $ref: '#/components/schemas/ModelDetail' },
          },
        },
        MeshyTask: {
          type: 'object',
          description: 'Meshy generation task (proxied). On SUCCEEDED, use model_urls.glb with GET /api/meshy/download.',
          properties: {
            id: { type: 'string' },
            status: {
              type: 'string',
              enum: ['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED'],
            },
            progress: { type: 'number' },
            model_urls: {
              type: 'object',
              additionalProperties: { type: 'string', format: 'uri' },
              properties: {
                glb: { type: 'string', format: 'uri' },
                fbx: { type: 'string', format: 'uri' },
              },
            },
            thumbnail_url: { type: 'string', format: 'uri', nullable: true },
            prompt: { type: 'string' },
            task_error: {
              type: 'object',
              nullable: true,
              properties: { message: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: 'Missing or invalid API key.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        Forbidden: {
          description: 'The job belongs to a different API key, or the key is missing a required scope.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        NotFound: {
          description: 'Resource not found.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        RateLimited: {
          description: 'Rate limit or monthly quota exceeded.',
          headers: {
            'X-RateLimit-Reset': { $ref: '#/components/headers/X-RateLimit-Reset' },
            'X-Quota-Reset':     { $ref: '#/components/headers/X-Quota-Reset' },
          },
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        PayloadTooLarge: {
          description: 'Upload exceeds the per-endpoint size cap (50 MB for project attachments).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        UnsupportedMediaType: {
          description: 'Request body has an unsupported content type or file extension.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },

    paths: {
      '/health': {
        get: {
          tags: ['Meta'],
          summary: 'Liveness probe',
          description: 'Returns 200 if the API surface is reachable with a valid key.',
          security: [{ apiKey: [] }],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { type: 'string', example: 'ok' }, api: { type: 'string', example: 'v1' } },
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '429': { $ref: '#/components/responses/RateLimited' },
          },
        },
      },

      '/convert/async': {
        post: {
          tags: ['Convert'],
          summary: 'Submit a file for conversion -> ORBIT',
          description: [
            'Upload a CAD / mesh / IFC file.  The full list of accepted',
            'extensions and which capabilities each format supports lives in',
            '[Supported file formats](#section/Supported-file-formats).  In',
            'short: every Rhino-native format (3dm, dwg, dxf, fbx, obj, stl,',
            'ply, 3mf, skp, step/stp, iges/igs) plus the Assimp-bridged',
            'web/3D-DCC family (gltf, glb, dae, blend, x, usdz), with `.zip`',
            'as the bundle wrapper for files that reference external assets',
            '(textures, MTL, glTF buffers).',
            '',
            'The response contains a `jobId` you can poll via `GET /jobs/{jobId}`',
            'or stream over Server-Sent Events at `GET /jobs/{jobId}/stream` —',
            'see [Polling vs SSE](#section/Polling-vs-SSE).',
            '',
            'On success the job\'s `status` advances to `complete` and `resultUrl`',
            'points at the resulting ORBIT version.  Set `outputFormats=glb,step`',
            'to additionally render those formats — see [Additional output',
            'formats](#section/Additional-output-formats).',
            '',
            'For a layer-picker UX, set `selectLayers=true` and follow the',
            '[Two-phase layer selection](#section/Two-phase-layer-selection)',
            'flow.  Callers that already know the layer paths can submit them',
            'directly via `includedLayers` and skip the picker entirely.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file', 'projectId', 'modelId'],
                  properties: {
                    file:       { type: 'string', format: 'binary', description: 'The source file. <=2 GB.' },
                    projectId:  { type: 'string', description: 'ORBIT project id.' },
                    modelId:    { type: 'string', description: 'ORBIT model id.' },
                    modelName:  { type: 'string' },
                    orbitTarget:{ type: 'string', enum: ['prod', 'dev'], default: 'prod' },
                    swapYZ:     { type: 'boolean', default: false, description: 'Swap Y and Z axes during import (CAD ↔ DCC handedness).' },
                    quality:    { type: 'string', enum: ['sensible', 'extreme'], default: 'sensible' },
                    callbackUrl:{ type: 'string', format: 'uri', description: 'Optional webhook URL to POST a `job.complete` / `job.failed` event to (in addition to globally configured webhooks).' },
                    outputFormats: { type: 'string', description: 'Comma-separated list of additional output formats (`3dm, step, glb, ifc`). Each format is rendered and uploaded; downloadable via `GET /jobs/{id}/outputs/{format}`.' },
                    includedLayers: { type: 'string', description: 'Comma-separated layer `fullPath` strings to include (others are skipped). Use the two-phase flow (`selectLayers=true`) if you don\'t know the layer paths up front.' },
                    includeLayerDescendants: { type: 'boolean', default: false, description: 'When `includedLayers` is set, also include every descendant of each listed layer.' },
                    selectLayers: { type: 'boolean', default: false, description: 'Two-phase flow: when true, PRISM first dispatches a `pollLayers` job to a layering-capable agent which returns the file\'s layer tree. The job lands in `awaiting_selection`; poll `GET /jobs/{id}/layers` for the tree, then `POST /jobs/{id}/layers` with your selection to resume normal convert dispatch.' },
                  },
                },
              },
            },
          },
          responses: {
            '202': {
              description: 'Job accepted and queued.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/JobAccepted' } } },
            },
            '400': { description: 'Validation failed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '415': { description: 'Unsupported file extension.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '429': { $ref: '#/components/responses/RateLimited' },
          },
        },
      },

      '/receive/async': {
        post: {
          tags: ['Receive'],
          summary: 'Materialise an ORBIT version into a downloadable file',
          description: [
            'Asks an agent to download an existing ORBIT version into a Rhino doc',
            'and re-export it as a single file (`3dm` or `step`). Useful when an',
            'external system needs a flat file copy of an ORBIT model snapshot.',
            '',
            'Poll `GET /jobs/{jobId}` until `status=complete`, then download via',
            '`GET /jobs/{jobId}/outputs/{format}`.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['projectId', 'modelId', 'versionId'],
                  properties: {
                    projectId:  { type: 'string' },
                    modelId:    { type: 'string' },
                    versionId:  { type: 'string' },
                    modelName:  { type: 'string' },
                    orbitTarget:{ type: 'string', enum: ['prod', 'dev'], default: 'prod' },
                    outputFormat:{ type: 'string', enum: ['3dm', 'step'], default: '3dm' },
                    callbackUrl:{ type: 'string', format: 'uri' },
                  },
                },
              },
            },
          },
          responses: {
            '202': {
              description: 'Job accepted and queued.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/JobAccepted' } } },
            },
            '400': { description: 'Validation failed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '429': { $ref: '#/components/responses/RateLimited' },
          },
        },
      },

      '/jobs/{id}': {
        get: {
          tags: ['Jobs'],
          summary: 'Poll job status',
          description: 'Returns the full job record. The `status` field is the primary signal; treat `complete`, `failed`, and `cancelled` as terminal.',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Current job state.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
            '429': { $ref: '#/components/responses/RateLimited' },
          },
        },
      },

      '/jobs/{id}/stream': {
        get: {
          tags: ['Jobs'],
          summary: 'Stream live job progress via Server-Sent Events',
          description: [
            'Returns an `text/event-stream` connection. Each frame is one of:',
            '',
            '* `event: state` — initial snapshot of the job record (single frame at connect time).',
            '* `event: update` — subsequent partial updates (progress %, stage, message, status transitions).',
            '',
            'Close the connection once you see a terminal status (`complete`, `failed`, `cancelled`).',
          ].join('\n'),
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': {
              description: 'SSE stream opened.',
              content: { 'text/event-stream': { schema: { type: 'string', example: 'event: update\ndata: {"progressPercent":42,"currentStage":"meshing"}\n\n' } } },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/jobs/{id}/layers': {
        get: {
          tags: ['Jobs'],
          summary: 'Read the layer tree (two-phase flow)',
          description: [
            'For jobs submitted with `selectLayers=true`, this returns the layer tree',
            'the agent extracted from the uploaded file. The job sits in',
            '`awaiting_selection` until you POST the chosen layers back.',
            '',
            'Returns `404` (with `status` and `selectLayers` in the body) until the',
            'agent has replied with the tree. Poll this endpoint, or — preferred —',
            'subscribe to `/jobs/{id}/stream` and listen for the SSE `update`',
            'frame that delivers `status: awaiting_selection` with `layers` inline.',
          ].join('\n'),
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Layer tree available.',
                     content: { 'application/json': { schema: { $ref: '#/components/schemas/LayersResponse' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { description: 'Job not found OR layers not available yet (still polling agent).',
                     content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
        post: {
          tags: ['Jobs'],
          summary: 'Submit layer selection (two-phase flow)',
          description: [
            'Re-queues a job from `awaiting_selection` back to `queued` so it gets',
            'dispatched as a regular convert with your chosen layers. Returns `409`',
            'if the job is in any other state.',
            '',
            'After this call, watch the existing `/jobs/{id}/stream` SSE channel',
            'for the normal `dispatched → processing → complete` progression.',
          ].join('\n'),
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LayerSelection' } } },
          },
          responses: {
            '200': {
              description: 'Selection persisted; job re-queued.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      jobId: { type: 'string', format: 'uuid' },
                      status: { $ref: '#/components/schemas/JobStatus' },
                      includedLayers: { type: 'array', items: { type: 'string' } },
                      includeLayerDescendants: { type: 'boolean' },
                    },
                  },
                },
              },
            },
            '400': { description: 'Invalid body.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
            '409': { description: 'Job is not in `awaiting_selection` state.',
                     content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/jobs/{id}/outputs/{format}': {
        get: {
          tags: ['Jobs'],
          summary: 'Download a generated output file',
          description: 'For convert jobs that requested `outputFormats`, this streams the rendered file as `application/octet-stream`.',
          parameters: [
            { in: 'path', name: 'id',     required: true, schema: { type: 'string', format: 'uuid' } },
            { in: 'path', name: 'format', required: true, schema: { type: 'string', enum: ['3dm', 'step', 'ifc', 'glb'] } },
          ],
          responses: {
            '200': { description: 'Binary file.',
                     content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
            '400': { description: 'Unknown format.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { description: 'Job not found, or output for this format has not been produced.',
                     content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/webhooks/signature-spec': {
        get: {
          tags: ['Webhooks'],
          summary: 'Inspect the webhook signature contract',
          description: 'Returns the header name, algorithm, encoding, and payload definition that PRISM uses when signing webhook POST bodies. Use this to implement signature verification on your receiver.',
          responses: {
            '200': {
              description: 'Signing spec.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookSignatureSpec' } } },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },

      // ================================================================
      // Phase K - Visualiser portal contract
      //
      // Portal-facing Pixel Streaming surface. Unlike the rest of this
      // spec these endpoints live at `/api/visualiser/*` rather than
      // `/v1/*` - see the second `servers[]` entry. POST requires the
      // `visualiser:create_stream` scope; admin sessions and ORBIT
      // bearers bypass scope checks via `requireScope`.
      //
      // Timing budget:
      //   * Warm (UE editor cached on workstation): ~2-3 s round-trip
      //   * Cold (first run on workstation, shader compile + import):
      //     ~60-90 s. Tunable via `VISUALISER_START_TIMEOUT_MS` env
      //     (code default 600 000 ms = 600 s); requests that exceed the
      //     deadline return `504` with `code: start_timeout`.
      //
      // Idempotency expectation:
      //   The Phase G implementation inserts a NEW `visualiser_runs` row
      //   on every POST. Two concurrent POSTs with the same
      //   `(projectId, modelId, versionId)` triple WILL each get their
      //   own runId and will race for the same workstation slot. A
      //   future revision should deduplicate by inserting a uniqueness
      //   constraint on `(project_id, model_id, version_id) WHERE
      //   status IN ('queued', 'importing', 'streaming')` and returning
      //   the existing run instead of creating a duplicate. Tracked as
      //   a v0.3 follow-up; portals SHOULD NOT rely on idempotency yet.
      // ================================================================

      '/api/visualiser/streams': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Visualiser'],
          summary: 'Start a Pixel Streaming session',
          description: [
            'Synchronous. Blocks until the agent either reports the run is',
            'streaming (`prism-visualiser/ready/v1`), a terminal failure',
            '(`prism-visualiser/failed/v1`), or the deadline configured by',
            '`VISUALISER_START_TIMEOUT_MS` fires (default 600s).',
            '',
            '**Auth:** `X-API-Key` with the `visualiser:create_stream` scope,',
            'or an authenticated admin session.',
            '',
            '**Timing:** warm round-trip is typically ~2-3 s; cold start (UE',
            'editor warm-up + import + shader compile) is ~60-90 s. The first',
            'invocation against a brand-new model is always cold; the per-run',
            'workspace and DDC are cached on the workstation for subsequent',
            'requests against the same `(projectId, modelId)`.',
            '',
            '**Idempotency:** the Phase G implementation does NOT yet',
            'deduplicate concurrent requests for the same',
            '`(projectId, modelId, versionId)` triple - two in-flight POSTs',
            'each create a fresh `visualiser_runs` row. Portals SHOULD',
            'serialise per-(project, model, version) at their own layer until',
            'the v0.3 idempotency follow-up lands.',
          ].join('\n'),
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VisualiserStartRequest' },
                examples: {
                  latestVersion: {
                    summary: 'Start a stream against the latest version',
                    value: { projectId: 'cf900606f5', modelId: 'be45d33eb1' },
                  },
                  pinnedVersion: {
                    summary: 'Pin to a specific ORBIT version + UE template',
                    value: {
                      projectId: 'cf900606f5',
                      modelId: 'be45d33eb1',
                      versionId: 'v_2026_05_12_001',
                      templateTag: 'v1.0.0-ue5.7',
                      ttlSeconds: 3600,
                    },
                  },
                  withCallback: {
                    summary: 'Request status callbacks (reserved - Phase G accepts but does not POST yet)',
                    value: {
                      projectId: 'cf900606f5',
                      modelId: 'be45d33eb1',
                      callbackUrl: 'https://portal.example.com/prism/visualiser-events',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Ready - the signallingUrl is live and the browser can connect.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/VisualiserReadyResponse' },
                  example: {
                    schema: 'prism-visualiser/ready/v1',
                    runId: '5b9c1d4f-9d72-4a8c-8e64-7e22b5f2f01b',
                    status: 'streaming',
                    signallingUrl: 'wss://prism.rebus.industries/ws/visualiser/5b9c1d4f-9d72-4a8c-8e64-7e22b5f2f01b/signalling',
                    playerUrl:     'https://prism.rebus.industries/admin/#/visualiser/5b9c1d4f-9d72-4a8c-8e64-7e22b5f2f01b',
                    streamerId:    'orbit_5b9c1d4f',
                    turn: {
                      urls: ['turn:visualiser.rebus.industries:3478', 'turns:visualiser.rebus.industries:5349'],
                      username: '1748284800:5b9c1d4f',
                      credential: 'gHrjK0iA0sM...',
                      ttl: 86400,
                    },
                  },
                },
              },
            },
            '400': { description: 'Validation failed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { description: 'Missing `visualiser:create_stream` scope on the API key.',
                     content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '413': { $ref: '#/components/responses/PayloadTooLarge' },
            '415': { $ref: '#/components/responses/UnsupportedMediaType' },
            '422': { description: '`version_unavailable` - the requested project/model/version cannot be resolved on ORBIT (bad id, wrong `orbitTarget`, project not shared with PRISM\'s token, or no committed version). Fix the ids; not a server fault.',
                     content: { 'application/json': { schema: { $ref: '#/components/schemas/VisualiserFailedResponse' } } } },
            '429': { $ref: '#/components/responses/RateLimited' },
            '500': { description: 'Server is misconfigured (no ORBIT URL/token, rejected ORBIT credentials, TURN/JWT secret).',
                     content: { 'application/json': { schema: { $ref: '#/components/schemas/VisualiserFailedResponse' } } } },
            '502': { description: 'Agent reported `visualisationFailed` during the start round-trip.',
                     content: { 'application/json': { schema: { $ref: '#/components/schemas/VisualiserFailedResponse' } } } },
            '503': { description: 'No workstation is online with `can_visualise`, or all are at capacity.',
                     content: { 'application/json': { schema: { $ref: '#/components/schemas/VisualiserFailedResponse' } } } },
            '504': { description: 'The agent did not reply within `VISUALISER_START_TIMEOUT_MS`.',
                     content: { 'application/json': { schema: { $ref: '#/components/schemas/VisualiserFailedResponse' } } } },
          },
        },
        get: {
          tags: ['Visualiser'],
          summary: 'List visualiser runs',
          description: 'Returns recent runs (newest first). Admin SPA polls this for the Visualiser page; portals can use it to recover from a lost runId.',
          parameters: [
            { in: 'query', name: 'status', schema: { type: 'string' }, description: 'CSV of statuses to include (e.g. `streaming,importing,queued`).' },
            { in: 'query', name: 'limit',  schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 } },
            { in: 'query', name: 'offset', schema: { type: 'integer', minimum: 0, default: 0 } },
          ],
          responses: {
            '200': {
              description: 'Page of runs.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      runs:   { type: 'array', items: { $ref: '#/components/schemas/VisualiserRun' } },
                      limit:  { type: 'integer' },
                      offset: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '429': { $ref: '#/components/responses/RateLimited' },
          },
        },
      },

      '/api/visualiser/streams/{runId}': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Visualiser'],
          summary: 'Poll a visualiser run',
          description: 'Returns the latest persisted state. While `status` is `streaming`, the response includes a fresh `turn` credential bundle (HMAC-derived, 24h TTL - see `VisualiserTurnBundle`). The list endpoint omits the bundle to keep admin polling caches small.',
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Current run state.', content: { 'application/json': { schema: { $ref: '#/components/schemas/VisualiserRun' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
            '429': { $ref: '#/components/responses/RateLimited' },
          },
        },
        delete: {
          tags: ['Visualiser'],
          summary: 'Stop a visualiser run',
          description: 'Sends `cancelVisualisation` to the agent (best-effort) and marks the row `ended`. The caller must be either the API key that started the run (matched by `requested_by_api_key_id`) or an admin session.',
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Cancelled.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { description: 'Caller does not own the run.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '404': { $ref: '#/components/responses/NotFound' },
            '409': { description: 'Run is already terminal.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '429': { $ref: '#/components/responses/RateLimited' },
          },
        },
      },

      '/api/visualiser/streams/{runId}/signalling-token': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Visualiser'],
          summary: 'Mint a signalling WS token',
          description: [
            'Returns an HS256 JWT (default TTL 1 hour, JWT_SIGNALLING_TTL_SEC) the browser',
            'appends as `?token=...` to the signalling WS URL. The same ownership',
            'check as DELETE applies.',
            '',
            'The browser SHOULD refresh the token before opening a fresh',
            'signalling connection; tokens are bound to the runId, not to a',
            'specific socket, so a single token is enough for the whole',
            'session as long as the browser does not reconnect after 5 min.',
          ].join('\n'),
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Token minted.', content: { 'application/json': { schema: { $ref: '#/components/schemas/VisualiserSignallingToken' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { description: 'Caller does not own the run.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '404': { $ref: '#/components/responses/NotFound' },
            '409': { description: 'Run is not in `streaming` / `importing` state.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '503': { description: '`JWT_SIGNALLING_SECRET` is not configured.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/visualiser/streams/{runId}/shares': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Visualiser'],
          summary: 'Mint a share link',
          description: [
            'Mint a shareable viewer link for a `streaming` run so a viewer with',
            'no PRISM account can join. The plaintext token + URL are returned',
            '**once** (only the SHA-256 hash is stored). The link auto-dies with',
            'the run and can be revoked early.',
            '',
            '**Auth:** the run creator (matching API key) or an admin session, OR',
            'an API key with the `visualiser:join_stream` scope.',
            '',
            'See [API_MULTIVIEW_SESSION_CONTROL.md](https://github.com/REBUS-ORBIT/prism/blob/main/docs/API_MULTIVIEW_SESSION_CONTROL.md) §4.5.',
          ].join('\n'),
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: false,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/VisualiserShareCreateRequest' } } },
          },
          responses: {
            '201': { description: 'Share link minted (token shown once).', content: { 'application/json': { schema: { $ref: '#/components/schemas/VisualiserShareLink' } } } },
            '400': { description: 'Invalid body.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { description: 'Caller cannot mint links for this run.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '404': { $ref: '#/components/responses/NotFound' },
            '409': { description: 'Run is not `streaming`.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
        get: {
          tags: ['Visualiser'],
          summary: 'List share links for a run',
          description: 'Returns the run\'s share links (newest first), without the plaintext token (irretrievable by design). Owner/admin only.',
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': {
              description: 'Share links.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['shares'],
                    properties: { shares: { type: 'array', items: { $ref: '#/components/schemas/VisualiserShareLink' } } },
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { description: 'Caller does not own the run.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/api/visualiser/streams/{runId}/shares/exchange': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Visualiser'],
          summary: 'Redeem a share token (public)',
          description: [
            'PUBLIC - no API key. A shared viewer posts the opaque token from the',
            'share URL and receives a tier-scoped signalling JWT plus the',
            '`signallingUrl` + `turn` bundle needed to open the stream. Refuses',
            'revoked (`410`), expired (`410`), or non-`streaming` (`409`) links.',
          ].join('\n'),
          security: [],
          parameters: [{ in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/VisualiserShareExchangeRequest' } } },
          },
          responses: {
            '200': { description: 'Token redeemed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/VisualiserShareExchangeResponse' } } } },
            '400': { description: 'Invalid body.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '404': { description: 'Unknown share token for this run.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '409': { description: 'Stream is not active.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '410': { description: 'Share link revoked or expired.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '503': { description: '`JWT_SIGNALLING_SECRET` not configured.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/visualiser/streams/{runId}/shares/{id}': {
        servers: [{ url: API_BASE }],
        delete: {
          tags: ['Visualiser'],
          summary: 'Revoke a share link',
          description: 'Stamps `revokedAt`; subsequent exchanges of that token return `410`. Owner/admin only.',
          parameters: [
            { in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid' } },
            { in: 'path', name: 'id',    required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Revoked.', content: { 'application/json': { schema: { type: 'object', properties: { revoked: { type: 'string', format: 'uuid' } } } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { description: 'Caller does not own the run.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '404': { description: 'Not found or already revoked.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/visualiser/workstations': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Visualiser'],
          summary: 'List visualiser-capable workstations',
          description: 'Drives the admin UI "Start new stream" dropdown. Admin-only - portals do not need this surface.',
          responses: {
            '200': {
              description: 'OK.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      workstations: { type: 'array', items: { $ref: '#/components/schemas/VisualiserWorkstation' } },
                    },
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { description: 'Caller is not an admin session.',
                     content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      // ================================================================
      // Phase K - Project attachments (MVR / GDTF for visualiser)
      // ================================================================

      '/api/projects/{projectId}/attachments': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Project Attachments'],
          summary: 'Upload an MVR / GDTF attachment',
          description: [
            'Multipart upload (single `file` part). Allowed file types are',
            'gated to `.mvr`, `.gdtf`, and `.zip` bundles containing one or',
            'more of those. 50 MB hard cap on the body.',
            '',
            '**Auth:** `X-API-Key` with the `visualiser:attach_project_files`',
            'scope, or an authenticated admin session.',
            '',
            'Attachments are staged into `${DATA_DIR}/project-attachments/<projectId>/`',
            'and are forwarded to the workstation alongside the glTF stage via',
            'the `StartVisualisation` envelope. The orchestrator\'s',
            '`MvrGdtfDetector` runs `import_mvr.py` as a second pass after',
            '`import_orbit.py` when at least one MVR or GDTF attachment is',
            'present (Phase J).',
          ].join('\n'),
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'projectId', required: true, schema: { type: 'string', minLength: 1, maxLength: 128 } }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    file: { type: 'string', format: 'binary', description: 'The MVR / GDTF body. Required.' },
                  },
                  required: ['file'],
                },
              },
            },
          },
          responses: {
            '201': { description: 'Attachment stored.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectAttachment' } } } },
            '400': { description: 'Invalid projectId, missing file part, or empty body.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { description: 'Missing `visualiser:attach_project_files` scope.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '413': { $ref: '#/components/responses/PayloadTooLarge' },
            '415': { $ref: '#/components/responses/UnsupportedMediaType' },
            '429': { $ref: '#/components/responses/RateLimited' },
          },
        },
        get: {
          tags: ['Project Attachments'],
          summary: 'List attachments for a project',
          description: 'Returns non-deleted attachments in newest-first order. Soft-deleted rows are excluded.',
          parameters: [{ in: 'path', name: 'projectId', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'OK.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProjectAttachmentList' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '429': { $ref: '#/components/responses/RateLimited' },
          },
        },
      },

      '/api/projects/{projectId}/attachments/{id}': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Project Attachments'],
          summary: 'Download an attachment body',
          description: 'Streams the body with the recorded content-type. Returns 404 if soft-deleted.',
          parameters: [
            { in: 'path', name: 'projectId', required: true, schema: { type: 'string' } },
            { in: 'path', name: 'id',        required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': {
              description: 'Binary body.',
              content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
        delete: {
          tags: ['Project Attachments'],
          summary: 'Soft-delete an attachment',
          description: 'Stamps `deletedAt` and unlinks the on-disk body. Once soft-deleted the row is excluded from the LIST/GET surface and from the StartVisualisation envelope.',
          security: [{ apiKey: [] }],
          parameters: [
            { in: 'path', name: 'projectId', required: true, schema: { type: 'string' } },
            { in: 'path', name: 'id',        required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Deleted.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { description: 'Missing `visualiser:attach_project_files` scope.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      // ================================================================
      // Library APIs — fixtures, models, materials (portal-facing)
      //
      // Narrative companion: docs/LIBRARY_INTEGRATION.md
      // (/docs/library-integration). All routes require X-API-Key with the
      // matching fixtures:* / models:* / materials:* scope.
      // ================================================================

      '/api/fixtures': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Fixture library'],
          summary: 'List fixture types',
          description: 'Paginated catalogue of PRISM-owned fixture types. Each row includes `previewUrl`, `orbitUrl`, and `versions[]` with per-version `downloadedAt` and `previewUrl`. **Scope:** `fixtures:read`.',
          security: [{ apiKey: [] }],
          parameters: [
            { in: 'query', name: 'q', schema: { type: 'string' } },
            { in: 'query', name: 'tags', schema: { type: 'string' }, description: 'Comma-separated tags.' },
            { in: 'query', name: 'limit', schema: { type: 'integer', default: 50 } },
            { in: 'query', name: 'cursor', schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Fixture list.', content: { 'application/json': { schema: { $ref: '#/components/schemas/FixtureListResponse' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
        post: {
          tags: ['Fixture library'],
          summary: 'Create a blank fixture type',
          description: '**Scope:** `fixtures:write`.',
          security: [{ apiKey: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, manufacturer: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } } } },
          responses: {
            '201': { description: 'Created.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/fixtures/{id}': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Fixture library'],
          summary: 'Get fixture detail',
          description: 'Full definition (parts, DMX modes, beams) plus `previewUrl`, `orbitUrl`, and enriched `versions[]`. **Scope:** `fixtures:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Fixture detail.', content: { 'application/json': { schema: { $ref: '#/components/schemas/FixtureDetailResponse' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
        put: {
          tags: ['Fixture library'],
          summary: 'Update fixture metadata / definition',
          description: '**Scope:** `fixtures:write`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: {
            '200': { description: 'Updated.', content: { 'application/json': { schema: { $ref: '#/components/schemas/FixtureDetailResponse' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
        delete: {
          tags: ['Fixture library'],
          summary: 'Soft-delete a fixture type',
          description: '**Scope:** `fixtures:delete`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Deleted.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/api/fixtures/{id}/preview.glb': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Fixture library'],
          summary: 'Stream active preview GLB',
          description: [
            'Binary glTF preview mesh for the **active** stored version.',
            'The same path appears on list/detail rows as `previewUrl` when `hasPreview` is true.',
            '**Scope:** `fixtures:read`.',
          ].join(' '),
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Preview GLB.', content: { 'model/gltf-binary': { schema: { type: 'string', format: 'binary' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/api/fixtures/export': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Fixture library'],
          summary: 'List connector-exportable fixtures',
          description: 'Published fixtures only — the connector/ORBIT pull surface. **Scope:** `fixtures:read`.',
          security: [{ apiKey: [] }],
          responses: {
            '200': { description: 'Export summaries.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/fixtures/export/{id}': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Fixture library'],
          summary: 'Get connector export payload',
          description: 'Self-contained JSON (definition + asset URLs) for ORBIT connectors. **Scope:** `fixtures:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Export payload.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/api/models': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Model library'],
          summary: 'List models',
          description: 'Paginated model list. Each row includes `previewUrl`, `orbitUrl`, and `versions[]` with per-version `createdAt` and `previewUrl`. **Scope:** `models:read`.',
          security: [{ apiKey: [] }],
          parameters: [
            { in: 'query', name: 'q', schema: { type: 'string' } },
            { in: 'query', name: 'category', schema: { type: 'string' } },
            { in: 'query', name: 'limit', schema: { type: 'integer', default: 50 } },
            { in: 'query', name: 'cursor', schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Model list.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ModelListResponse' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
        post: {
          tags: ['Model library'],
          summary: 'Create a blank model',
          description: '**Scope:** `models:write`.',
          security: [{ apiKey: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, category: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } } } },
          responses: {
            '201': { description: 'Created.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/models/{id}': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Model library'],
          summary: 'Get model detail',
          description: 'Metadata, definition, `previewUrl`, `orbitUrl`, and enriched `versions[]`. **Scope:** `models:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Model detail.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ModelDetailResponse' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
        put: {
          tags: ['Model library'],
          summary: 'Update model metadata',
          description: '**Scope:** `models:write`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: {
            '200': { description: 'Updated.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ModelDetailResponse' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
        delete: {
          tags: ['Model library'],
          summary: 'Soft-delete a model',
          description: '**Scope:** `models:delete`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Deleted.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/api/models/{id}/preview.glb': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Model library'],
          summary: 'Stream active preview GLB',
          description: [
            'Cached preview mesh after import completes.',
            'The same path appears on list/detail rows as `previewUrl` when `hasPreview` is true.',
            '**Scope:** `models:read`.',
          ].join(' '),
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Preview GLB.', content: { 'model/gltf-binary': { schema: { type: 'string', format: 'binary' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/api/model-import': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Model library'],
          summary: 'Import a model file',
          description: 'Multipart upload; runs the async convert pipeline and creates an Orbit version. Also used to **transfer a Meshy-generated GLB** into the library after `GET /api/meshy/download`. **Scope:** `models:import`.',
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    name: { type: 'string' },
                    category: { type: 'string' },
                    tags: { type: 'string', description: 'Comma-separated tags' },
                    sourceUnits: { type: 'string', description: 'Mesh units (e.g. m, mm, cm)' },
                  },
                  required: ['file'],
                },
              },
            },
          },
          responses: {
            '202': { description: 'Import accepted.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/meshy/status': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Meshy'],
          summary: 'Meshy credential status',
          description: 'Returns whether Admin → Settings → Meshy has an API key configured. Does not expose the key. **Scope:** `models:read`.',
          security: [{ apiKey: [] }],
          responses: {
            '200': {
              description: 'Status.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { configured: { type: 'boolean' } },
                    required: ['configured'],
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/meshy/test': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Meshy'],
          summary: 'Test Meshy API credentials',
          description: 'Probes Meshy with the stored key (balance endpoint when available). **Scope:** `models:read`. Returns `412` if no key is configured.',
          security: [{ apiKey: [] }],
          responses: {
            '200': { description: 'Key accepted.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, balance: {} } } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '412': { description: 'Meshy API key not configured in Settings.' },
          },
        },
      },

      '/api/meshy/text-to-3d': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Meshy'],
          summary: 'Create a Text-to-3D task',
          description: [
            'Proxies `POST https://api.meshy.ai/openapi/v2/text-to-3d`.',
            'Use `mode: "preview"` with a `prompt`, then optionally `mode: "refine"` with `preview_task_id`.',
            'Poll `GET /api/meshy/text-to-3d/{id}` until `status` is `SUCCEEDED`.',
            '**Scope:** `models:write`. Upstream: https://docs.meshy.ai/en/api/text-to-3d',
          ].join(' '),
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      required: ['mode', 'prompt'],
                      properties: {
                        mode: { type: 'string', enum: ['preview'] },
                        prompt: { type: 'string', maxLength: 600 },
                        should_remesh: { type: 'boolean' },
                        ai_model: { type: 'string' },
                      },
                    },
                    {
                      type: 'object',
                      required: ['mode', 'preview_task_id'],
                      properties: {
                        mode: { type: 'string', enum: ['refine'] },
                        preview_task_id: { type: 'string' },
                        enable_pbr: { type: 'boolean' },
                        texture_prompt: { type: 'string', maxLength: 600 },
                      },
                    },
                  ],
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Task created.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { result: { type: 'string', description: 'Meshy task id' } },
                    required: ['result'],
                  },
                },
              },
            },
            '400': { description: 'Invalid body.' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '412': { description: 'Meshy API key not configured.' },
          },
        },
      },

      '/api/meshy/text-to-3d/{id}': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Meshy'],
          summary: 'Get Text-to-3D task status',
          description: 'Proxies Meshy task status. On `SUCCEEDED`, read `model_urls.glb` and download via `/api/meshy/download`. **Scope:** `models:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Meshy task object.', content: { 'application/json': { schema: { $ref: '#/components/schemas/MeshyTask' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/meshy/image-to-3d': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Meshy'],
          summary: 'Create an Image-to-3D task',
          description: [
            'Proxies `POST https://api.meshy.ai/openapi/v1/image-to-3d`.',
            '`image_url` may be a public HTTPS URL or a `data:image/…;base64,…` data URI.',
            '**Scope:** `models:write`. Upstream: https://docs.meshy.ai/en/api/image-to-3d',
          ].join(' '),
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['image_url'],
                  properties: {
                    image_url: { type: 'string' },
                    should_texture: { type: 'boolean' },
                    enable_pbr: { type: 'boolean' },
                    ai_model: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Task created.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { result: { type: 'string' } },
                    required: ['result'],
                  },
                },
              },
            },
            '400': { description: 'Invalid body.' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '412': { description: 'Meshy API key not configured.' },
          },
        },
      },

      '/api/meshy/image-to-3d/{id}': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Meshy'],
          summary: 'Get Image-to-3D task status',
          description: '**Scope:** `models:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Meshy task object.', content: { 'application/json': { schema: { $ref: '#/components/schemas/MeshyTask' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/meshy/retexture': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Meshy'],
          summary: 'Create a Retexture task',
          description: [
            'Proxies `POST https://api.meshy.ai/openapi/v1/retexture`.',
            'Pass `input_task_id` (preferred) or `model_url`, plus `text_style_prompt` or `image_style_url`.',
            '**Scope:** `models:write`. Upstream: https://docs.meshy.ai/en/api/retexture',
          ].join(' '),
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    input_task_id: { type: 'string' },
                    model_url: { type: 'string' },
                    text_style_prompt: { type: 'string', maxLength: 600 },
                    image_style_url: { type: 'string' },
                    enable_pbr: { type: 'boolean' },
                    enable_original_uv: { type: 'boolean' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Task created.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { result: { type: 'string' } },
                    required: ['result'],
                  },
                },
              },
            },
            '400': { description: 'Invalid body.' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '412': { description: 'Meshy API key not configured.' },
          },
        },
      },

      '/api/meshy/retexture/{id}': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Meshy'],
          summary: 'Get Retexture task status',
          description: '**Scope:** `models:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Meshy task object.', content: { 'application/json': { schema: { $ref: '#/components/schemas/MeshyTask' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/meshy/remesh': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Meshy'],
          summary: 'Create a Remesh task',
          description: [
            'Proxies `POST https://api.meshy.ai/openapi/v1/remesh`.',
            'Pass `input_task_id` (preferred) or `model_url`, optional `topology` / `target_polycount`.',
            '**Scope:** `models:write`. Upstream: https://docs.meshy.ai/en/api/remesh',
          ].join(' '),
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    input_task_id: { type: 'string' },
                    model_url: { type: 'string' },
                    topology: { type: 'string', enum: ['quad', 'triangle'] },
                    target_polycount: { type: 'integer' },
                    target_formats: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Task created.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { result: { type: 'string' } },
                    required: ['result'],
                  },
                },
              },
            },
            '400': { description: 'Invalid body.' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '412': { description: 'Meshy API key not configured.' },
          },
        },
      },

      '/api/meshy/remesh/{id}': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Meshy'],
          summary: 'Get Remesh task status',
          description: '**Scope:** `models:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Meshy task object.', content: { 'application/json': { schema: { $ref: '#/components/schemas/MeshyTask' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/meshy/download': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Meshy'],
          summary: 'Download a Meshy asset URL',
          description: [
            'Server-side proxy for signed Meshy asset URLs (`model_urls.glb`, etc.).',
            'Allowlists `*.meshy.ai` hosts. Use this instead of fetching the signed URL',
            'from the browser (CORS). Then `POST /api/model-import` with the bytes.',
            '**Scope:** `models:read`.',
          ].join(' '),
          security: [{ apiKey: [] }],
          parameters: [
            {
              in: 'query',
              name: 'url',
              required: true,
              schema: { type: 'string', format: 'uri' },
              description: 'Signed Meshy asset URL from `model_urls.*`',
            },
          ],
          responses: {
            '200': {
              description: 'Asset bytes.',
              content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
            },
            '400': { description: 'Missing url or host not allowlisted.' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/materials': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Materials library'],
          summary: 'List materials',
          description: 'Paginated material list. Each row includes `previewUrl` when `thumbnailTextureId` is set (card thumbnail). **Scope:** `materials:read`.',
          security: [{ apiKey: [] }],
          parameters: [
            { in: 'query', name: 'q', schema: { type: 'string' } },
            { in: 'query', name: 'tags', schema: { type: 'string' } },
            { in: 'query', name: 'limit', schema: { type: 'integer', default: 50 } },
            { in: 'query', name: 'cursor', schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Material list.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
        post: {
          tags: ['Materials library'],
          summary: 'Create a blank material',
          description: '**Scope:** `materials:write`.',
          security: [{ apiKey: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } } } },
          responses: {
            '201': { description: 'Created.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/materials/{id}': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Materials library'],
          summary: 'Get material detail',
          description: 'Slots, textures, PBR parameters. Material and each `slots[].texture` include `previewUrl` for inline image fetch. **Scope:** `materials:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Material detail.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
        put: {
          tags: ['Materials library'],
          summary: 'Update material metadata / parameters',
          description: '**Scope:** `materials:write`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: {
            '200': { description: 'Updated.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
        delete: {
          tags: ['Materials library'],
          summary: 'Soft-delete a material',
          description: '**Scope:** `materials:delete`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Deleted.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/api/materials/{id}/download': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Materials library'],
          summary: 'Download material ZIP',
          description: 'Streams textures + manifest. **Scope:** `materials:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'ZIP archive.', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/api/materials/import': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Materials library'],
          summary: 'Import a material ZIP',
          description: 'Megascans-style or packaged glTF/GLB. **Scope:** `materials:write`.',
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    name: { type: 'string' },
                  },
                  required: ['file'],
                },
              },
            },
          },
          responses: {
            '201': { description: 'Imported.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/textures': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Materials library'],
          summary: 'List textures',
          description: 'Shared texture library backing material slots. Each texture row includes `previewUrl` (`GET /api/textures/{id}/preview`). **Scope:** `materials:read`.',
          security: [{ apiKey: [] }],
          responses: {
            '200': { description: 'Texture list.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
        post: {
          tags: ['Materials library'],
          summary: 'Upload a texture',
          description: '**Scope:** `materials:write`.',
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: { file: { type: 'string', format: 'binary' } },
                  required: ['file'],
                },
              },
            },
          },
          responses: {
            '201': { description: 'Created.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/textures/{id}/preview': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Materials library'],
          summary: 'Texture inline preview',
          description: 'Streams the texture body for portal thumbnails and `<img>` embeds. Same bytes as `/download`; adds `Cache-Control`. Requires `X-API-Key` with `materials:read` — proxy server-side for browser UI. **Scope:** `materials:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Image body.', content: { 'image/*': { schema: { type: 'string', format: 'binary' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/api/textures/{id}/download': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Materials library'],
          summary: 'Download texture body',
          description: 'Streams the texture file (`Content-Disposition: inline`). Same bytes as `/preview`. **Scope:** `materials:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Image body.', content: { 'image/*': { schema: { type: 'string', format: 'binary' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/api/textures/{id}': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Materials library'],
          summary: 'Get texture metadata',
          description: 'Texture row including `previewUrl`. **Scope:** `materials:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Texture metadata.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      // ================================================================
      // File library — native CAD/DCC source archives (prism-server MVP)
      // ================================================================

      '/api/files/status': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['File library'],
          summary: 'File library storage status',
          description: 'Resolved storage root, writability, max bytes, and allowed extensions. Connectors should call this before upload. **Scope:** `files:read`.',
          security: [{ apiKey: [] }],
          responses: {
            '200': {
              description: 'Status.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      configured: { type: 'boolean' },
                      root: { type: 'string' },
                      writable: { type: 'boolean' },
                      usingSettingsPath: { type: 'boolean' },
                      maxBytes: { type: 'integer' },
                      allowedExts: { type: 'array', items: { type: 'string' } },
                      projectFolderCount: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/files/browse': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['File library'],
          summary: 'Browse directories under the library root',
          description: 'Directory listing for the Admin folder picker. Paths are relative to `file_library_root`; `..` and absolute escapes are rejected. **Scope:** `files:read`.',
          security: [{ apiKey: [] }],
          parameters: [
            { in: 'query', name: 'path', schema: { type: 'string' }, description: 'Relative directory under the share root (empty = root)' },
          ],
          responses: {
            '200': { description: 'Directory listing.', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid path.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '404': { $ref: '#/components/responses/NotFound' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/files/project-folders': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['File library'],
          summary: 'List per-project folder mappings',
          description: 'Orbit project id → relative path under the share root. Uploads for a project fail until a folder is set. **Scope:** `files:read`.',
          security: [{ apiKey: [] }],
          responses: {
            '200': { description: 'Folder mappings.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/files/project-folders/{projectId}': {
        servers: [{ url: API_BASE }],
        put: {
          tags: ['File library'],
          summary: 'Set the File Library folder for an Orbit project',
          description: 'Relative path must exist under `file_library_root` and must not be the share root itself. **Scope:** `files:write`.',
          security: [{ apiKey: [] }],
          parameters: [
            { in: 'path', name: 'projectId', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['relativePath'],
                  properties: {
                    relativePath: { type: 'string', example: '01 CLIENTS - EXTERNAL/LN26_LIVE NATION/…/PRISM FILES' },
                    projectName: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Saved mapping.', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid or missing path.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
        delete: {
          tags: ['File library'],
          summary: 'Clear the File Library folder for an Orbit project',
          description: 'Subsequent uploads for that `projectId` return `400` with `code: project_folder_required`. **Scope:** `files:write`.',
          security: [{ apiKey: [] }],
          parameters: [
            { in: 'path', name: 'projectId', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '204': { description: 'Cleared.' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/files': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['File library'],
          summary: 'List file documents',
          description: 'One row per normalised filename within a project. Each row includes `latestVersion` with `uploadedBy` + `createdAt`. **Scope:** `files:read`.',
          security: [{ apiKey: [] }],
          parameters: [
            { in: 'query', name: 'q', schema: { type: 'string' }, description: 'Filename search' },
            { in: 'query', name: 'ext', schema: { type: 'string' }, description: 'Extension filter, e.g. `.3dm`' },
            { in: 'query', name: 'projectId', schema: { type: 'string' } },
            { in: 'query', name: 'limit', schema: { type: 'integer', default: 50 } },
            { in: 'query', name: 'cursor', schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Document list.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
        post: {
          tags: ['File library'],
          summary: 'Upload a file (new document or new version)',
          description: [
            'Multipart upload. Same basename (case-insensitive) within a `projectId` appends an immutable version.',
            '',
            '**Form fields:** `file` (required), `projectId` (required — Orbit project with a configured File Library folder),',
            'optional `name`, `notes` (version notes, also written as a `.txt` sidecar next to the CAD file),',
            '`tags` (comma list), `uploadedBy` (display label — prefer OS/Rhino user),',
            '`sourceApp` (`rhino` / `vectorworks` / `admin`).',
            '',
            'Put text fields **before** the `file` part so multipart parsers see them.',
            '',
            'Returns `400` with `code: project_folder_required` when the project has no folder mapping.',
            '',
            '**Scope:** `files:write`.',
          ].join('\n'),
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file', 'projectId'],
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    name: { type: 'string' },
                    projectId: { type: 'string' },
                    notes: { type: 'string', description: 'Version notes (max 8000 chars); stored on the version and as `{stem}.txt` beside the file.' },
                    tags: { type: 'string' },
                    uploadedBy: { type: 'string' },
                    sourceApp: { type: 'string', example: 'rhino' },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Created document + version.', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Missing project/folder, extension not allowed, or empty file.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '413': { description: 'File exceeds max size.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
          },
        },
      },

      '/api/files/{id}': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['File library'],
          summary: 'Get document + all versions',
          description: 'Full version history (newest first) with `uploadedBy` and `createdAt` on each version. **Scope:** `files:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Document detail.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
        patch: {
          tags: ['File library'],
          summary: 'Update document metadata',
          description: '**Scope:** `files:write`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                    projectId: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Updated document.', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
        delete: {
          tags: ['File library'],
          summary: 'Soft-delete document (all versions)',
          description: '**Scope:** `files:delete`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '204': { description: 'Deleted.' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/api/files/{id}/download': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['File library'],
          summary: 'Download latest version',
          description: '**Scope:** `files:read`.',
          security: [{ apiKey: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'File body.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/api/files/{id}/versions/{versionId}/download': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['File library'],
          summary: 'Download a specific version',
          description: '**Scope:** `files:read`.',
          security: [{ apiKey: [] }],
          parameters: [
            { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
            { in: 'path', name: 'versionId', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'File body.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      '/api/files/{id}/versions/{versionId}': {
        servers: [{ url: API_BASE }],
        delete: {
          tags: ['File library'],
          summary: 'Soft-delete one version',
          description: 'Removes version bytes from disk and updates the document tip. Soft-deletes the document when no versions remain. **Scope:** `files:delete`.',
          security: [{ apiKey: [] }],
          parameters: [
            { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
            { in: 'path', name: 'versionId', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '204': { description: 'Deleted.' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '403': { $ref: '#/components/responses/Forbidden' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },

      // ================================================================
      // Permissions & portal-brokered access
      //
      // Served by the `prism-permissions-service` microservice (port
      // 8771) and routed under this origin by the split-stack nginx
      // router (`/api/access/*`, `/api/permissions/*`). These power
      // "Sign in with REBUS" for connectors/portals and the admin
      // Permissions page's function-policy graph (the "permissions node").
      //
      // Auth models differ from the rest of this spec:
      //   * /api/access/*       PUBLIC. No X-API-Key — the portal OAuth
      //                         `code` / opaque `sessionId` is the credential.
      //   * /api/permissions/*  Admin session cookie (`prism_admin`) — the
      //                         PRISM admin SPA. Not portal-facing.
      // ================================================================

      '/api/access/login': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Access'],
          summary: 'Begin portal-brokered sign-in (redirect)',
          description: 'Connector/portal "Sign in with REBUS" entry point. 302-redirects the browser to the configured portal/Google OAuth (or the dev mock-login) carrying the connector loopback `redirect_uri`. After consent the browser is redirected back with a `?code=...` to exchange via `POST /api/access/session`.',
          security: [],
          parameters: [{ in: 'query', name: 'redirect_uri', required: true, schema: { type: 'string', format: 'uri' }, description: 'Connector loopback URI, e.g. `http://localhost:29364/`.' }],
          responses: {
            '302': { description: 'Redirect to the portal/Google OAuth authorize URL.' },
            '400': { description: '`redirect_uri` missing.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '503': { description: 'OAuth not configured (missing Google client id / portal authorize URL).', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/access/mock-login': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Access'],
          summary: 'Dev mock portal redirect (mock adapter only)',
          description: 'Development helper available only when `portal_adapter=mock`. 302-redirects to `redirect_uri` with `?code=mock:<persona>` so the session / portal-user flow can be exercised without a live portal. Returns 404 in production unless the mock adapter is active.',
          security: [],
          parameters: [
            { in: 'query', name: 'redirect_uri', required: true, schema: { type: 'string', format: 'uri' } },
            { in: 'query', name: 'persona', schema: { type: 'string', default: 'alice', example: 'alice' }, description: 'Mock persona (`alice` = contributor, `bob` = viewer).' },
          ],
          responses: {
            '302': { description: 'Redirect carrying `?code=mock:<persona>`.' },
            '400': { description: '`redirect_uri` missing.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '404': { description: 'Mock adapter not active.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/access/session': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Access'],
          summary: 'Exchange a portal auth code for a connector manifest',
          description: [
            'The core portal-brokered login call. Exchanges the OAuth `code` from the',
            'portal callback for a `ConnectorManifest` — a scoped ORBIT token plus the',
            'per-project allowed-function map (effective = portal grant ∩ function-policy',
            'graph).',
            '',
            'The returned `manifest.sessionId` can later be passed to',
            '`GET /api/access/manifest` to refresh without re-authenticating.',
            '',
            '**Auth:** PUBLIC — the portal `code` is the credential; no `X-API-Key`.',
          ].join('\n'),
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AccessSessionRequest' },
                examples: {
                  mock:   { summary: 'Mock adapter (dev)', value: { portalAuthCode: 'mock:alice', orbitTarget: 'dev' } },
                  portal: { summary: 'Real portal code', value: { portalAuthCode: '4/0Ad...', orbitTarget: 'prod', redirectUri: 'http://localhost:29364/' } },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Session established.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccessSessionResponse' } } } },
            '400': { description: '`portalAuthCode` missing.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { description: 'Portal rejected the code.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '403': { description: 'User has no provisioned access.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '500': { description: 'Exchange failed (e.g. ORBIT token mint error).', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/access/manifest': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Access'],
          summary: 'Refresh a connector manifest',
          description: 'Returns the current `ConnectorManifest` for an existing session — use this to pick up policy/permission changes (or a refreshed ORBIT token) without a full re-login. **Auth:** PUBLIC — the opaque `sessionId` is the credential.',
          security: [],
          parameters: [{ in: 'query', name: 'sessionId', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Manifest.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccessSessionResponse' } } } },
            '400': { description: '`sessionId` missing.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { description: 'Session unknown, expired, or revoked.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '500': { description: 'Failed to load manifest.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/access/revoke': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Access'],
          summary: 'Revoke a session',
          description: 'Invalidates a session so its `sessionId` can no longer refresh a manifest. Call on connector sign-out. **Auth:** PUBLIC.',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } } } },
          },
          responses: {
            '200': { description: 'Revoked (idempotent).', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } } } } },
            '400': { description: '`sessionId` missing.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/access/portal-user': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Access'],
          summary: 'Validate a portal code → portal user (no ORBIT mint)',
          description: 'Exchanges a portal OAuth `code` for the resolved `PortalUser` only, without minting an ORBIT token or building a manifest. Used by the PRISM admin "Sign in with Google" flow to identify the user before checking admin provisioning. **Auth:** PUBLIC.',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['portalAuthCode'], properties: { portalAuthCode: { type: 'string' }, redirectUri: { type: 'string', format: 'uri' } } } } },
          },
          responses: {
            '200': { description: 'Resolved user.', content: { 'application/json': { schema: { type: 'object', required: ['user'], properties: { user: { $ref: '#/components/schemas/PortalUser' } } } } } },
            '400': { description: '`portalAuthCode` missing.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { description: 'Portal sign-in failed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/access/provisioned-admin': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Access'],
          summary: 'Check whether an email may sign into the admin SPA',
          description: 'Allow-check used by the admin Google login: returns whether the email is a provisioned PRISM admin and the local admin username it binds to. **Auth:** PUBLIC.',
          security: [],
          parameters: [{ in: 'query', name: 'email', required: true, schema: { type: 'string', format: 'email' } }],
          responses: {
            '200': { description: 'Allow-check result.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProvisionedAdminCheck' } } } },
            '400': { description: '`email` missing.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/access/health': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Access'],
          summary: 'Permissions service liveness',
          description: 'Liveness probe for the permissions service. Reports the active portal adapter (`mock` / `google` / `real`). **Auth:** PUBLIC.',
          security: [],
          responses: {
            '200': { description: 'OK.', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' }, adapter: { type: 'string', example: 'mock' } } } } } },
          },
        },
      },

      '/api/permissions/portal-roles': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Permissions'],
          summary: 'List the portal\u2019s live role catalogue',
          description: 'Proxies the portal\u2019s current role list (`GET /portal/roles`). The admin Tool access page renders role nodes from this so deleted/renamed portal roles never linger. If the portal has not implemented the endpoint, returns `supported: false` and PRISM falls back to deriving roles from existing grants. **Auth:** admin session cookie (`prism_admin`) or `access:admin` API key.',
          security: [{ cookieAuth: [] }, { apiKey: [] }],
          responses: {
            '200': { description: 'Portal role list.', content: { 'application/json': { schema: { $ref: '#/components/schemas/PortalRolesResponse' } } } },
            '401': { description: 'Not authorized.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/permissions/policy': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Permissions'],
          summary: 'Read the function-policy graph',
          description: 'Returns the node-based permissions graph (the "permissions node" editor data) plus the default functions applied when the graph yields nothing for a principal. **Auth:** admin session cookie (`prism_admin`).',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': { description: 'Policy graph.', content: { 'application/json': { schema: { $ref: '#/components/schemas/PermissionsPolicyResponse' } } } },
            '401': { description: 'Not an admin session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
        put: {
          tags: ['Permissions'],
          summary: 'Replace the function-policy graph',
          description: 'Overwrites the policy graph (nodes + edges) and optionally the default functions. The full graph is replaced atomically. **Auth:** admin session cookie.',
          security: [{ cookieAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['graph'], properties: { graph: { $ref: '#/components/schemas/FunctionPolicyGraph' }, defaultFunctions: { type: 'array', items: { $ref: '#/components/schemas/ConnectorFunction' } } } } } },
          },
          responses: {
            '200': { description: 'Saved graph.', content: { 'application/json': { schema: { $ref: '#/components/schemas/PermissionsPolicyResponse' } } } },
            '400': { description: '`graph.nodes` / `graph.edges` missing.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { description: 'Not an admin session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/permissions/functions': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Permissions'],
          summary: 'List grantable connector functions',
          description: 'Returns the canonical list of `ConnectorFunction` values that policy `function` nodes can reference. **Auth:** admin session cookie.',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': { description: 'Function list.', content: { 'application/json': { schema: { type: 'object', required: ['functions'], properties: { functions: { type: 'array', items: { $ref: '#/components/schemas/ConnectorFunction' } } } } } } },
            '401': { description: 'Not an admin session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/permissions/workspace': {
        servers: [{ url: API_BASE }],
        get: {
          tags: ['Workspace'],
          summary: 'Get the linked Google Workspace + provisioned users',
          description: 'Returns the current Google Workspace link (or null) and the list of pre-provisioned users. **Auth:** admin session cookie.',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': { description: 'Workspace overview.', content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkspaceOverview' } } } },
            '401': { description: 'Not an admin session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/permissions/workspace/link': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Workspace'],
          summary: 'Link a Google Workspace domain',
          security: [{ cookieAuth: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['domain'], properties: { domain: { type: 'string', example: 'rebus.industries' }, displayName: { type: 'string' } } } } } },
          responses: {
            '200': { description: 'Linked.', content: { 'application/json': { schema: { type: 'object', required: ['workspace'], properties: { workspace: { $ref: '#/components/schemas/GoogleWorkspaceLink' } } } } } },
            '400': { description: 'Missing / invalid domain.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { description: 'Not an admin session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/permissions/workspace/unlink': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Workspace'],
          summary: 'Unlink the Google Workspace domain',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': { description: 'Unlinked.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } } } } },
            '401': { description: 'Not an admin session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/permissions/workspace/sync': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Workspace'],
          summary: 'Sync users from the workspace directory',
          description: 'Imports/updates provisioned users from the linked directory (Google Admin SDK or the mock directory). **Auth:** admin session cookie.',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': { description: 'Sync counts.', content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkspaceSyncResult' } } } },
            '400': { description: 'Sync failed (e.g. no domain linked).', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { description: 'Not an admin session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/permissions/workspace/users': {
        servers: [{ url: API_BASE }],
        post: {
          tags: ['Workspace'],
          summary: 'Create a provisioned user',
          security: [{ cookieAuth: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProvisionedUserInput' } } } },
          responses: {
            '200': { description: 'Created.', content: { 'application/json': { schema: { type: 'object', required: ['user'], properties: { user: { $ref: '#/components/schemas/ProvisionedUser' } } } } } },
            '400': { description: 'Missing email / create failed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '401': { description: 'Not an admin session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },

      '/api/permissions/workspace/users/{id}': {
        servers: [{ url: API_BASE }],
        patch: {
          tags: ['Workspace'],
          summary: 'Update a provisioned user',
          description: 'Body is a partial `ProvisionedUserInput` (any subset of fields). **Auth:** admin session cookie.',
          security: [{ cookieAuth: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProvisionedUserInput' } } } },
          responses: {
            '200': { description: 'Updated.', content: { 'application/json': { schema: { type: 'object', required: ['user'], properties: { user: { $ref: '#/components/schemas/ProvisionedUser' } } } } } },
            '401': { description: 'Not an admin session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '404': { description: 'User not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
        delete: {
          tags: ['Workspace'],
          summary: 'Delete a provisioned user',
          security: [{ cookieAuth: [] }],
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Deleted.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } } } } },
            '401': { description: 'Not an admin session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            '404': { description: 'User not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
    },
  };
}
