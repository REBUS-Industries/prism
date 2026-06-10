/**
 * Typed REST client. Wraps fetch + tiny error normalisation; all PRISM
 * SPAs use it so we don't sprinkle ad-hoc URL strings everywhere.
 */

export interface ApiError {
  status: number;
  message: string;
  body?: unknown;
}

// ---------------------------------------------------------------------------
// API call logging — records every fetch through ApiClient so the admin SPA
// can render a live log panel. Lightweight in-memory ring buffer + simple
// pub/sub. Bodies are JSON-stringified (truncated) for display; FormData
// requests log just the field names + file sizes.
// ---------------------------------------------------------------------------

export interface ApiLogEntry {
  id: number;
  startedAt: number;          // epoch ms
  durationMs: number;
  method: string;
  url: string;
  status: number;             // 0 if network failure
  ok: boolean;
  requestBody?: string;
  responseBody?: string;
  errorMessage?: string;
}

const MAX_LOG_ENTRIES = 250;
const MAX_BODY_PREVIEW = 4000;
let nextLogId = 1;

class ApiLog {
  private entries: ApiLogEntry[] = [];
  private listeners = new Set<(entries: ApiLogEntry[]) => void>();

  list(): ApiLogEntry[] { return this.entries; }

  push(entry: ApiLogEntry): void {
    this.entries = [entry, ...this.entries].slice(0, MAX_LOG_ENTRIES);
    for (const fn of this.listeners) fn(this.entries);
  }

  clear(): void {
    this.entries = [];
    for (const fn of this.listeners) fn(this.entries);
  }

  subscribe(fn: (entries: ApiLogEntry[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.entries);
    return () => this.listeners.delete(fn);
  }
}

export const apiLog = new ApiLog();

function previewBody(body: BodyInit | null | undefined): string | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return truncate(body);
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const parts: string[] = [];
    body.forEach((v, k) => {
      if (typeof File !== 'undefined' && v instanceof File) {
        parts.push(`${k}=<file ${v.name} ${v.size}B ${v.type || '?'}>`);
      } else {
        parts.push(`${k}=${truncate(String(v), 200)}`);
      }
    });
    return `FormData { ${parts.join(', ')} }`;
  }
  try { return truncate(JSON.stringify(body)); } catch { return '<unserialisable>'; }
}

function truncate(s: string, max = MAX_BODY_PREVIEW): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + ` …(+${s.length - max} bytes)`;
}

export type JobStatus =
  | 'queued'
  | 'dispatched'
  | 'awaiting_selection'
  | 'processing'
  | 'uploading'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface LayerNode {
  name: string;
  fullPath?: string;
  color?: string;
  visible?: boolean;
  children?: LayerNode[];
}

export interface JobSummary {
  id: string;
  status: JobStatus;
  jobType?: 'convert' | 'receive';
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  fileName: string;
  fileSize: number;
  format: string;
  orbitTarget: 'prod' | 'dev';
  projectId: string;
  modelId: string;
  modelName?: string | null;
  nodeName?: string | null;
  currentStage?: string | null;
  progressPercent?: number | null;
  lastMessage?: string | null;
  resultUrl?: string | null;
  rootObjectId?: string | null;
  versionId?: string | null;
  outputFormats?: string[] | null;
  outputs?: Record<string, string> | null;
  receiveVersionId?: string | null;
  error?: string | null;
  // Two-phase layer-selection flow:
  selectLayers?: boolean;
  includedLayers?: string[];
  includeLayerDescendants?: boolean;
  hasLayers?: boolean;
}

export interface Workstation {
  id: string;
  machineId: string;
  nodeName: string;
  canConvert: boolean;
  canLayer: boolean;
  canReceive: boolean;
  /** Visualiser role: agent can host an Unreal + Pixel Streaming session
   *  for ORBIT versions. Phase A scaffold — toggling this on advertises
   *  the role to the dispatcher but the agent's WS handler currently
   *  acks `accepted: false` until the orchestrator binary lands in Phase F/G. */
  canVisualise: boolean;
  supportedFormats: string[];
  slotsTotal: number;
  agentVersion?: string | null;
  rhinoVersion?: string | null;
  /** Release tag of the orbit-ue-template build the agent reports as installed
   *  at its VisualiserTemplateProjectPath. Null/undefined when the agent never
   *  reported it (older build, or no template pulled yet). */
  installedTemplateTag?: string | null;
  /** Release tag of the OrbitConnector.UE5 plug-in merged into the installed
   *  template project (companion to `installedTemplateTag`). */
  installedConnectorTag?: string | null;
  isEnabled: boolean;
  notes?: string | null;
  createdAt: string;
  lastSeenAt?: string | null;
  online?: boolean;
  slotsBusy?: number;
  sessions?: number;
  /** Connected agent IP, sourced from the live `agent_sessions.remote_addr`.
   *  Null when no agent session exists (workstation offline). Preferred over
   *  `nodeName.dnsSuffix` for the admin "Open Web UI" links — bare IPs
   *  sidestep Chrome's HTTPS-First-Mode upgrade for hostnames under any
   *  HSTS-`includeSubDomains` policy. See `web/src/shared/workstationUrl.ts`. */
  host?: string | null;
}

/** One published UE-template release, for the admin version picker. */
export interface TemplateRelease {
  tag: string;
  name: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  hasArchive: boolean;
}

export interface ApiKey {
  id: string;
  name: string;
  isActive: boolean;
  rateLimitPerMin?: number | null;
  monthlyQuota?: number | null;
  /** Granular permission strings, e.g. `visualiser:create_stream`. Empty
   *  for legacy keys (pre-Phase A); new scopes must be granted explicitly. */
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string | null;
}

class ApiClient {
  constructor(private base: string = '') {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const startedAt = Date.now();
    const method = (init.method ?? 'GET').toUpperCase();
    const url = this.base + path;
    const requestBody = previewBody(init.body);

    let res: Response;
    try {
      res = await fetch(url, {
        credentials: 'include',
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
        ...init,
      });
    } catch (netErr) {
      const message = netErr instanceof Error ? netErr.message : String(netErr);
      apiLog.push({
        id: nextLogId++, startedAt, durationMs: Date.now() - startedAt,
        method, url, status: 0, ok: false, requestBody, errorMessage: message,
      });
      throw { status: 0, message, body: undefined } satisfies ApiError;
    }

    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { body = await res.text().catch(() => ''); }
      const err: ApiError = { status: res.status, message: extractMessage(body) ?? res.statusText, body };
      apiLog.push({
        id: nextLogId++, startedAt, durationMs: Date.now() - startedAt,
        method, url, status: res.status, ok: false, requestBody,
        responseBody: previewBody(typeof body === 'string' ? body : safeJson(body)),
        errorMessage: err.message,
      });
      throw err;
    }

    const isJson = ct.includes('application/json');
    const parsed = (isJson ? await res.json() : await res.text()) as unknown;
    apiLog.push({
      id: nextLogId++, startedAt, durationMs: Date.now() - startedAt,
      method, url, status: res.status, ok: true, requestBody,
      responseBody: previewBody(isJson ? safeJson(parsed) : (parsed as string)),
    });
    return parsed as T;
  }

  get<T>(path: string)  { return this.req<T>(path, { method: 'GET' }); }
  delete<T>(path: string) { return this.req<T>(path, { method: 'DELETE' }); }
  put<T>(path: string, body: unknown) {
    return this.req<T>(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  patch<T>(path: string, body: unknown) {
    return this.req<T>(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  post<T>(path: string, body: unknown) {
    return this.req<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  postForm<T>(path: string, form: FormData) {
    return this.req<T>(path, { method: 'POST', body: form });
  }

  /**
   * Multipart POST with upload-progress reporting. `fetch()` cannot surface
   * request-body upload progress, so this path uses XHR — but it still
   * records an `apiLog` entry and rejects with the same {@link ApiError}
   * shape as {@link req} so callers handle success / failure identically.
   * Used by the materials ZIP import, whose bodies can run to hundreds of MB.
   */
  postFormWithProgress<T>(path: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
    const startedAt = Date.now();
    const method = 'POST';
    const url = this.base + path;
    const requestBody = previewBody(form);
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('accept', 'application/json');
      if (onProgress) {
        xhr.upload.addEventListener('progress', (ev) => {
          if (ev.lengthComputable) onProgress(ev.total ? ev.loaded / ev.total : 0);
        });
      }
      xhr.addEventListener('load', () => {
        const status = xhr.status;
        const ct = xhr.getResponseHeader('content-type') ?? '';
        const isJson = ct.includes('application/json');
        let parsed: unknown;
        try { parsed = isJson ? JSON.parse(xhr.responseText) : xhr.responseText; }
        catch { parsed = xhr.responseText; }
        const responseBody = previewBody(isJson ? safeJson(parsed) : (parsed as string));
        if (status >= 200 && status < 300) {
          apiLog.push({
            id: nextLogId++, startedAt, durationMs: Date.now() - startedAt,
            method, url, status, ok: true, requestBody, responseBody,
          });
          resolvePromise(parsed as T);
        } else {
          const err: ApiError = { status, message: extractMessage(parsed) ?? xhr.statusText, body: parsed };
          apiLog.push({
            id: nextLogId++, startedAt, durationMs: Date.now() - startedAt,
            method, url, status, ok: false, requestBody, responseBody, errorMessage: err.message,
          });
          rejectPromise(err);
        }
      });
      xhr.addEventListener('error', () => {
        const message = 'network error';
        apiLog.push({
          id: nextLogId++, startedAt, durationMs: Date.now() - startedAt,
          method, url, status: 0, ok: false, requestBody, errorMessage: message,
        });
        rejectPromise({ status: 0, message, body: undefined } satisfies ApiError);
      });
      xhr.send(form);
    });
  }
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function extractMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body || undefined;
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (typeof o['error'] === 'string') return o['error'];
    if (typeof o['message'] === 'string') return o['message'];
  }
  return undefined;
}

export const api = new ApiClient('');

export interface LayersResponse {
  jobId: string;
  status: JobStatus;
  layers: LayerNode[];
  includedLayers: string[];
  includeLayerDescendants: boolean;
}

/**
 * One streaming log line attached to a job.  The backend writes these
 * via {@link jobLogs} from both the server itself (lifecycle events,
 * dispatcher decisions) and from agents over WebSocket (per-stage
 * progress, IronPython output).  Returned by `GET /api/jobs/:id/logs`.
 */
export interface JobLogLine {
  id: number;
  jobId: string;
  ts: string;            // ISO timestamp from Postgres (drizzle serialises Date -> string here)
  level: string;         // 'debug' | 'info' | 'warn' | 'error' (free-form 8 chars)
  source: 'server' | 'agent' | string;
  message: string;
}

// Sugar for the common endpoints — typed responses
export const jobsApi = {
  list:   (params?: { status?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.limit !== undefined)  qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    return api.get<{ jobs: JobSummary[]; limit: number; offset: number }>(`/api/jobs?${qs}`);
  },
  get:    (id: string) => api.get<JobSummary>(`/api/jobs/${id}`),
  remove: (id: string) => api.delete<{ deleted: string }>(`/api/jobs/${id}`),
  // Two-phase layer-selection flow:
  getLayers:    (id: string) => api.get<LayersResponse>(`/api/jobs/${id}/layers`),
  submitLayers: (id: string, body: { includedLayers: string[]; includeLayerDescendants: boolean }) =>
    api.post<{ jobId: string; status: JobStatus; includedLayers: string[]; includeLayerDescendants: boolean }>(
      `/api/jobs/${id}/layers`,
      body,
    ),
  // Per-job server + agent log lines (drives JobLogsModal in the admin UI).
  getLogs: (id: string) => api.get<{ logs: JobLogLine[] }>(`/api/jobs/${id}/logs`),
};

export const workstationsApi = {
  list:   () => api.get<{ workstations: Workstation[] }>('/api/workstations'),
  get:    (id: string) => api.get<Workstation>(`/api/workstations/${id}`),
  update: (id: string, body: Partial<Workstation>) => api.patch<Workstation>(`/api/workstations/${id}`, body),
  remove: (id: string) => api.delete<{ deleted: string }>(`/api/workstations/${id}`),

  /**
   * Ask the agent on this workstation to cleanly exit. The Windows
   * Scheduled Task + a self-spawned PowerShell helper script bring it
   * back online within ~1 minute. Returns `{queued: true}` immediately;
   * the agent acks by disconnecting. 404 if the workstation row is
   * unknown, 503 if no agent session is currently connected.
   *
   * Available on agent v0.1.33+; older agents stay connected but
   * silently ignore the `restart` message.
   */
  restart: (id: string, reason?: string) =>
    api.post<{ queued: true }>(`/api/workstations/${id}/restart`, reason ? { reason } : {}),

  /**
   * Ask the agent on this workstation to check GitHub Releases and
   * apply a newer build if one is available. `tag` optionally pins a
   * specific release (e.g. `'v0.1.33'`); when omitted the agent picks
   * the latest. Same 404 / 503 semantics as `restart`.
   *
   * Available on agent v0.1.33+; older agents silently ignore the
   * `update` message (they still expose "Check for updates" in the
   * tray menu).
   */
  updateAgent: (id: string, tag?: string) =>
    api.post<{ queued: true }>(`/api/workstations/${id}/update`, tag ? { tag } : {}),

  /**
   * Ask the agent on this workstation to download the latest (or a pinned)
   * `orbit-ue-template` GitHub release and install it into its visualiser
   * template root (default `C:\PRISM\Templates`). `tag` optionally pins a
   * specific template release; when omitted the agent uses its configured
   * tag / the repo's latest. Fire-and-forget — returns `{queued: true}`;
   * progress is visible on the agent's local web UI. Same 404 / 503
   * semantics as `restart`. Older agents silently ignore the message.
   */
  pullTemplate: (id: string, tag?: string, force?: boolean) =>
    api.post<{ queued: true }>(`/api/workstations/${id}/pull-template`, {
      ...(tag ? { tag } : {}),
      ...(force ? { force: true } : {}),
    }),

  /**
   * List the published versions of the UE template repo so the admin can
   * pick which release to pull onto a workstation. `repo` optionally
   * overrides the server default (`owner/repo`). Cached 60s server-side.
   */
  templateReleases: (repo?: string) =>
    api.get<{ repo: string; releases: TemplateRelease[] }>(
      `/api/workstations/template-releases${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`,
    ),

  // ---------------------------------------------- node provisioning downloads
  // Since agent v0.1.30 ships a wizard installer (`.exe`) that embeds the
  // PowerShell install scripts and prompts for prismUrl/nodeName/slots,
  // the server only needs to expose the latest installer; the older
  // /install-script and /agent-config endpoints are gone.
  agentInfo: () => api.get<AgentBuildInfo>('/api/admin/workstations/downloads/agent'),
  agentDownloadUrl: () => '/api/admin/workstations/downloads/agent/download',
  /** Hard-coded GitHub releases page for the agent — used as the
   *  "View on GitHub" link next to the download button. */
  releasesPageUrl: 'https://github.com/REBUS-ORBIT/prism-agent/releases/latest',
};

export interface AgentBuildInfo {
  downloadUrl: string | null;
  version: string | null;
  wsUrl: string;
  available: boolean;
  buildSource: {
    workflow: string;
    artifact: string;
    howTo: string;
  };
}

export const keysApi = {
  list:   () => api.get<{ keys: ApiKey[] }>('/api/keys'),
  scopes: () => api.get<{ scopes: string[] }>('/api/keys/scopes'),
  create: (body: { name: string; rateLimitPerMin?: number; monthlyQuota?: number; scopes?: string[] }) =>
            api.post<{ plaintext: string; key: ApiKey }>('/api/keys', body),
  patch:  (id: string, body: { isActive?: boolean; scopes?: string[] }) =>
            api.patch<{ ok: true }>(`/api/keys/${id}`, body),
  remove: (id: string) => api.delete<{ deleted: string }>(`/api/keys/${id}`),
};

export const settingsApi = {
  list: () => api.get<{ settings: Record<string, string> }>('/api/settings'),
  set:  (key: string, value: string) => api.put<{ ok: true }>(`/api/settings/${encodeURIComponent(key)}`, { value }),
};

export interface ServerHealth {
  status: string;
  service: string;
  version: string;
  phase: number;
}

export const healthApi = {
  get: () => api.get<ServerHealth>('/health'),
};

// ---------------------------------------------------------------- Server API log
//
// Server-side ring buffer of every inbound API request the server answered.
// Backs the admin Logs page alongside the client-side `apiLog`. Contains only
// safe metadata — never headers, cookies, or bodies (see server
// observability/apiLog.ts).

export type ServerApiLogCategory = 'external' | 'admin' | 'orbit' | 'internal' | 'system';
export type ServerApiLogLevel = 'info' | 'warn' | 'error';

export interface ServerApiLogEntry {
  id: number;
  ts: number;             // request start, epoch ms
  durationMs: number;
  method: string;
  path: string;
  status: number;
  originKind: VisualiserOriginKind;
  originPrincipal: string | null;
  clientIp: string | null;
  category: ServerApiLogCategory;
  level: ServerApiLogLevel;
}

export const serverLogsApi = {
  list: (since?: number, limit?: number) => {
    const qs = new URLSearchParams();
    if (since) qs.set('since', String(since));
    if (limit) qs.set('limit', String(limit));
    const tail = qs.toString();
    return api.get<{ entries: ServerApiLogEntry[]; bufferSize: number }>(
      `/api/admin/logs${tail ? `?${tail}` : ''}`,
    );
  },
};

export const adminApi = {
  me:     () => api.get<{ kind: string; principal: { username?: string } }>('/api/admin/me'),
  login:  (username: string, password: string) => api.post<{ ok: true; username: string }>('/api/admin/login', { username, password }),
  logout: () => api.post<{ ok: true }>('/api/admin/logout', {}),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ ok: true }>('/api/admin/change-password', { currentPassword, newPassword }),
  cancelJob: (id: string) => api.post<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`, {}),
};

export interface PipelineNode {
  id: string;
  kind: string;
  label: string;
  description: string;
  optional?: boolean;
}
export interface PipelineEdge { from: string; to: string; label?: string; }
export interface PipelineTopology { nodes: PipelineNode[]; edges: PipelineEdge[]; }

export const pipelinesApi = {
  list: () => api.get<{ pipelines: Record<string, PipelineTopology> }>('/api/pipelines'),
  get:  (id: string) => api.get<PipelineTopology>(`/api/pipelines/${id}`),
};

export const convertApi = {
  submit: (file: File, opts: {
    projectId: string;
    modelId: string;
    modelName?: string;
    orbitTarget?: 'prod' | 'dev';
    swapYZ?: boolean;
    quality?: 'sensible' | 'extreme';
    callbackUrl?: string;
    includedLayers?: string[];
    includeLayerDescendants?: boolean;
    /** Two-phase flow: ask agent for layer tree before conversion. */
    selectLayers?: boolean;
  }) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('projectId', opts.projectId);
    fd.append('modelId',   opts.modelId);
    if (opts.modelName)   fd.append('modelName',   opts.modelName);
    if (opts.orbitTarget) fd.append('orbitTarget', opts.orbitTarget);
    if (opts.swapYZ !== undefined)   fd.append('swapYZ', String(opts.swapYZ));
    if (opts.quality)                fd.append('quality', opts.quality);
    if (opts.callbackUrl)            fd.append('callbackUrl', opts.callbackUrl);
    if (opts.includedLayers?.length) fd.append('includedLayers', opts.includedLayers.join(','));
    if (opts.includeLayerDescendants !== undefined) fd.append('includeLayerDescendants', String(opts.includeLayerDescendants));
    if (opts.selectLayers !== undefined) fd.append('selectLayers', String(opts.selectLayers));
    return api.postForm<{ jobId: string; status: string }>('/api/convert/async', fd);
  },
};

export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
  secret?: string;       // only present in the create response
}

export const webhooksApi = {
  list:   () => api.get<{ webhooks: Webhook[] }>('/api/webhooks'),
  create: (body: { name: string; url: string; events?: string[] }) => api.post<Webhook>('/api/webhooks', body),
  patch:  (id: string, body: Partial<Pick<Webhook, 'name'|'url'|'events'|'isActive'>> & { regenerateSecret?: boolean }) =>
            api.patch<Webhook>(`/api/webhooks/${id}`, body),
  remove: (id: string) => api.delete<{ deleted: string }>(`/api/webhooks/${id}`),
};

export const receiveApi = {
  submit: (body: {
    projectId: string;
    modelId: string;
    versionId: string;
    modelName?: string;
    orbitTarget?: 'prod' | 'dev';
    outputFormat?: '3dm' | 'step';
    callbackUrl?: string;
  }) => api.post<{ jobId: string; status: string }>('/api/receive/async', body),
};

// ---------------------------------------------------------------- ORBIT lookups
export interface OrbitServerInfo { name: string; version: string; company?: string | null; }
export interface OrbitUser       { id: string; name: string; email?: string | null; role?: string | null; }
export interface OrbitProject {
  id: string;
  name: string;
  description?: string | null;
  role?: string | null;
  visibility?: string | null;
  updatedAt?: string | null;
}
export interface OrbitModel {
  id: string;
  name: string;
  displayName?: string | null;
  description?: string | null;
  previewUrl?: string | null;
  updatedAt?: string | null;
}

export interface OrbitTestOk   { ok: true;  target: 'prod' | 'dev'; user: OrbitUser; serverInfo: OrbitServerInfo; }
export interface OrbitTestFail { ok: false; target: 'prod' | 'dev'; reason: 'no-creds' | 'no-user'; error: string; serverInfo?: OrbitServerInfo; }

// ---------------------------------------------------------------- Visualiser
//
// Portal-facing Pixel Streaming surface. The admin SPA reuses the same client
// (cookie-auth path) — the server's `/api/visualiser/*` endpoints accept
// either an `X-API-Key` header with the `visualiser:create_stream` scope or
// an admin session, see server/src/api/visualiser.ts.

export type VisualiserStatus =
  | 'queued'
  | 'importing'
  | 'streaming'
  | 'failed'
  | 'ended';

/** Where a visualiser run was started from (admin UI vs external API etc.). */
export type VisualiserOriginKind = 'admin' | 'api' | 'orbit' | 'internal' | 'anonymous';

/** One per-run lifecycle log line from `GET /api/visualiser/streams/:id/logs`. */
export interface VisualiserRunLogLine {
  id: number;
  runId: string;
  ts: string;
  level: string;       // 'debug' | 'info' | 'warn' | 'error'
  source: 'server' | 'agent' | string;
  message: string;
}

export interface VisualiserRun {
  id: string;
  status: VisualiserStatus;
  orbitTarget: 'prod' | 'dev';
  projectId: string;
  modelId: string;
  versionId?: string | null;
  templateTag?: string | null;
  workstationId?: string | null;
  workstationName?: string | null;
  agentSessionId?: string | null;
  signallingUrl?: string | null;
  playerUrl?: string | null;
  streamerId?: string | null;
  failureReason?: string | null;
  error?: string | null;
  ttlSeconds?: number | null;
  submittedBy?: string | null;
  requestedByApiKeyId?: string | null;
  /** Request provenance, stamped at start (see server auth/provenance.ts). */
  originKind?: VisualiserOriginKind | null;
  originAddress?: string | null;
  originPrincipal?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  dispatchedAt?: string | null;
  readyAt?: string | null;
  endedAt?: string | null;
  /** Fresh TURN bundle minted on each GET (Phase I). Null when
   *  `TURN_SECRET` is unset server-side — the player falls back to
   *  STUN-only / same-LAN WebRTC, which works in dev but not in prod. */
  turn?: VisualiserTurnBundle | null;
}

export interface VisualiserTurnBundle {
  urls: string[];
  username: string;
  credential: string;
  ttl: number;
}

/** Response shape from `POST /api/visualiser/streams` happy path. */
export interface VisualiserReadyEvent {
  schema: 'prism-visualiser/ready/v1';
  runId: string;
  status: 'streaming';
  signallingUrl: string;
  playerUrl: string;
  streamerId: string | null;
  /** Null sentinel while `TURN_SECRET` is unset — see Phase H. */
  turn: VisualiserTurnBundle | null;
}

/** Eligible-workstation row for the admin dropdown. */
export interface VisualiserWorkstation {
  id: string;
  nodeName: string;
  machineId: string;
  canVisualise: boolean;
  currentVisualiserLoad: number;
  slotsTotal: number;
  agentVersion?: string | null;
  online: boolean;
}

export interface VisualiserStartBody {
  projectId: string;
  modelId: string;
  versionId?: string;
  orbitTarget?: 'prod' | 'dev';
  preferredWorkstationId?: string;
  templateTag?: string;
  callbackUrl?: string;
  ttlSeconds?: number;
}

export const visualiserApi = {
  listStreams: (filter?: { status?: VisualiserStatus[]; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (filter?.status?.length) qs.set('status', filter.status.join(','));
    if (filter?.limit  !== undefined) qs.set('limit',  String(filter.limit));
    if (filter?.offset !== undefined) qs.set('offset', String(filter.offset));
    const tail = qs.toString();
    return api.get<{ runs: VisualiserRun[]; limit: number; offset: number }>(
      `/api/visualiser/streams${tail ? `?${tail}` : ''}`,
    );
  },
  getStream: (runId: string) =>
    api.get<VisualiserRun>(`/api/visualiser/streams/${runId}`),
  getStreamLogs: (runId: string, since?: number) =>
    api.get<{ logs: VisualiserRunLogLine[] }>(
      `/api/visualiser/streams/${runId}/logs${since ? `?since=${since}` : ''}`,
    ),
  startStream: (body: VisualiserStartBody) =>
    api.post<VisualiserReadyEvent>('/api/visualiser/streams', body),
  stopStream: (runId: string) =>
    api.delete<{ ok: true; status: VisualiserStatus }>(`/api/visualiser/streams/${runId}`),
  listWorkstations: () =>
    api.get<{ workstations: VisualiserWorkstation[] }>('/api/visualiser/workstations'),
  signallingToken: (runId: string, viewerId?: string) =>
    api.post<VisualiserSignallingToken>(`/api/visualiser/streams/${runId}/signalling-token`, viewerId ? { viewerId } : {}),
  /** Mint a share link (creator/admin). Returns the share URL + one-time token. */
  createShare: (runId: string, body: { tier: VisualiserShareTier; expiresInSeconds?: number }) =>
    api.post<VisualiserShareLink>(`/api/visualiser/streams/${runId}/shares`, body),
  listShares: (runId: string) =>
    api.get<{ shares: VisualiserShareLink[] }>(`/api/visualiser/streams/${runId}/shares`),
  revokeShare: (runId: string, id: string) =>
    api.delete<{ revoked: string }>(`/api/visualiser/streams/${runId}/shares/${id}`),
  /** Public — exchange an opaque share token for a signalling JWT. */
  exchangeShare: (runId: string, shareToken: string, viewerId?: string) =>
    api.post<VisualiserExchangeResult>(`/api/visualiser/streams/${runId}/shares/exchange`, { shareToken, viewerId }),
};

export type VisualiserShareTier = 'view' | 'control';

export interface VisualiserSignallingToken {
  token: string;
  exp: number;
  viewerId: string;
  tier: VisualiserShareTier;
}

export interface VisualiserShareLink {
  id: string;
  tier: VisualiserShareTier;
  /** Only present in the mint response. */
  url?: string;
  /** Only present in the mint response (shown once). */
  shareToken?: string;
  createdBy?: string | null;
  createdAt: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

export interface VisualiserExchangeResult {
  token: string;
  exp: number;
  viewerId: string;
  tier: VisualiserShareTier;
  runId: string;
  signallingUrl: string;
  turn: VisualiserTurnBundle | null;
}

export const orbitApi = {
  /** Test stored credentials for a target. Returns either `{ ok: true, user, serverInfo }` or `{ ok: false, reason, error }`. */
  test: async (target: 'prod' | 'dev'): Promise<OrbitTestOk | OrbitTestFail> => {
    try {
      return await api.get<OrbitTestOk>(`/api/orbit/test?target=${target}`);
    } catch (err) {
      const e = err as ApiError;
      const body = (e.body as Partial<OrbitTestFail>) ?? {};
      return {
        ok: false,
        target,
        reason: body.reason ?? 'no-user',
        error: body.error ?? e.message,
        serverInfo: body.serverInfo,
      };
    }
  },
  projects: (target: 'prod' | 'dev', limit = 100) =>
    api.get<{ target: string; totalCount: number; cursor: string | null; items: OrbitProject[] }>(
      `/api/orbit/projects?target=${target}&limit=${limit}`,
    ),
  models: (target: 'prod' | 'dev', projectId: string, limit = 200) =>
    api.get<{ target: string; projectId: string; projectName: string; totalCount: number; cursor: string | null; items: OrbitModel[] }>(
      `/api/orbit/projects/${encodeURIComponent(projectId)}/models?target=${target}&limit=${limit}`,
    ),
  createProject: (target: 'prod' | 'dev', name: string) =>
    api.post<{ target: string; project: OrbitProject }>('/api/orbit/projects', { target, name }),
  createModel: (target: 'prod' | 'dev', projectId: string, name: string) =>
    api.post<{ target: string; projectId: string; model: OrbitModel }>(
      `/api/orbit/projects/${encodeURIComponent(projectId)}/models`,
      { target, name },
    ),
};

// ---------------------------------------------------------------- Project attachments
//
// Phase J — portal-uploaded MVR/GDTF lighting files attached to an ORBIT
// project. The visualiser dispatcher forwards these as
// `ProjectAttachmentRef[]` on the StartVisualisation envelope so the
// orchestrator can stage them under `stage/{runId}/attachments/` for the
// MvrGdtfDetector. The server's REST surface lives under
// `/api/projects/:projectId/attachments` — the admin SPA hits these with
// its existing cookie auth; portal API keys need the
// `visualiser:attach_project_files` scope (split off from
// `visualiser:create_stream`).

export interface ProjectAttachment {
  id: string;
  projectId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedByApiKeyId: string | null;
}

export const projectAttachmentsApi = {
  list: (projectId: string) =>
    api.get<{ attachments: ProjectAttachment[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/attachments`,
    ),
  upload: (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.postForm<ProjectAttachment>(
      `/api/projects/${encodeURIComponent(projectId)}/attachments`,
      fd,
    );
  },
  /**
   * Resolves an absolute URL the browser can drop into a `<a download>`
   * or `window.open()` call — the GET endpoint streams the body with the
   * recorded content-type.
   */
  downloadUrl: (projectId: string, attachmentId: string): string =>
    `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}`,
  remove: (projectId: string, attachmentId: string) =>
    api.delete<void>(
      `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}`,
    ),
};

// ---------------------------------------------------------------- Materials store
//
// PRISM Materials Store — a shared texture library plus PBR materials that
// reference those textures by slot. Backed by `/api/textures` +
// `/api/materials` (see server/src/api/{textures,materials}.ts). The admin
// SPA hits these with its existing cookie auth; portal API keys would need
// the `materials:read` / `materials:write` / `materials:delete` scopes.
// Texture image bodies stream from `/api/textures/:id/download` — use that
// URL directly as an <img> src or a three.js TextureLoader URL.

/** The eight PBR slots a material can carry, in canonical (priority) order.
 *  Mirrors server/src/materials/slots.ts ALLOWED_SLOTS. */
export const MATERIAL_SLOTS = [
  'albedo', 'normal', 'roughness', 'metallic', 'ao', 'emissive', 'opacity', 'displacement',
] as const;

export type MaterialSlot = typeof MATERIAL_SLOTS[number];

/** Human-friendly labels for each slot — shared by the node graph + editor. */
export const SLOT_LABELS: Record<MaterialSlot, string> = {
  albedo:       'Albedo / Base Color',
  normal:       'Normal Map',
  roughness:    'Roughness',
  metallic:     'Metallic',
  ao:           'Ambient Occlusion',
  emissive:     'Emissive',
  opacity:      'Opacity',
  displacement: 'Displacement',
};

export interface Texture {
  id: string;
  originalFilename: string;
  displayName: string;
  contentType: string;
  sizeBytes: number;
  tags: string[];
  uploadedByAdminId: string | null;
  uploadedByApiKeyId: string | null;
  createdAt: string;
  referenceCount: number;
}

export interface TextureListResponse {
  textures: Texture[];
  limit: number;
  cursor: string;
  nextCursor: string | null;
}

export interface TextureListParams {
  q?: string;
  tags?: string[];
  limit?: number;
  /** Numeric offset (as returned in `nextCursor`) for "load more". */
  cursor?: string | number | null;
}

export const texturesApi = {
  list: (params: TextureListParams = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.tags?.length) qs.set('tags', params.tags.join(','));
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.cursor !== undefined && params.cursor !== null && params.cursor !== '') {
      qs.set('cursor', String(params.cursor));
    }
    const tail = qs.toString();
    return api.get<TextureListResponse>(`/api/textures${tail ? `?${tail}` : ''}`);
  },
  get: (id: string) => api.get<Texture>(`/api/textures/${id}`),
  /**
   * Multipart upload. IMPORTANT: the text fields (`displayName`, `tags`)
   * are appended to the FormData BEFORE the file part — the server only
   * captures multipart fields that precede the file when `req.file()`
   * resolves (see server/src/api/textures.ts).
   */
  upload: (file: File, opts: { displayName?: string; tags?: string[] } = {}) => {
    const fd = new FormData();
    if (opts.displayName) fd.append('displayName', opts.displayName);
    if (opts.tags?.length) fd.append('tags', opts.tags.join(','));
    fd.append('file', file);
    return api.postForm<Texture>('/api/textures', fd);
  },
  update: (id: string, body: { displayName?: string; tags?: string[] }) =>
    api.put<Texture>(`/api/textures/${id}`, body),
  /** Soft delete. On 409 the {@link ApiError} body carries
   *  `{ error, referencingMaterials: [{ id, name }] }`. */
  remove: (id: string) => api.delete<void>(`/api/textures/${id}`),
  /** Absolute path usable directly as an <img> src or three.js texture URL. */
  downloadUrl: (id: string): string => `/api/textures/${id}/download`,
};

/** Shape of the 409 body returned when deleting an in-use texture. */
export interface TextureInUseError {
  error: string;
  referencingMaterials: Array<{ id: string; name: string }>;
}

export interface MaterialListItem {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  thumbnailTextureId: string | null;
  slotsFilled: number;
  slotsTotal: number;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialListResponse {
  materials: MaterialListItem[];
  limit: number;
  cursor: string;
  nextCursor: string | null;
}

export interface MaterialSlotTexture {
  id: string;
  displayName: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
}

export interface MaterialSlotAssignment {
  slot: MaterialSlot;
  textureId: string;
  assignedAt: string;
  texture: MaterialSlotTexture;
}

/**
 * Per-material PBR parameters — scalar/colour values that exist independently
 * of whether a texture is assigned to a slot. They map onto a three.js
 * `MeshStandardMaterial` (GlbViewer applies them live) and persist per material
 * as a partial JSON object server-side. Mirrors
 * server/src/materials/parameters.ts; keep the two in sync.
 */
export interface MaterialParameters {
  /** material.color — also tints the albedo map when one is assigned. */
  baseColor: string;
  /** material.roughness — multiplies the roughnessMap when present. */
  roughness: number;
  /** material.metalness — multiplies the metalnessMap when present. */
  metallic: number;
  /** material.emissive. */
  emissiveColor: string;
  /** material.emissiveIntensity. */
  emissiveIntensity: number;
  /** material.opacity (+ transparent when < 1 or an alphaMap is present). */
  opacity: number;
  /** material.normalScale (x = y, then y negated when flipNormalY). */
  normalScale: number;
  /** material.aoMapIntensity. */
  aoIntensity: number;
  /** material.displacementScale. */
  displacementScale: number;
  /** material.displacementBias. */
  displacementBias: number;
  /** every assigned map's repeat.x. */
  tilingX: number;
  /** every assigned map's repeat.y. */
  tilingY: number;
  /** every assigned map's offset.x. */
  offsetX: number;
  /** every assigned map's offset.y. */
  offsetY: number;
  /** material.side — DoubleSide when true, FrontSide otherwise. */
  doubleSided: boolean;
  /** negate material.normalScale.y. */
  flipNormalY: boolean;
}

/** Canonical defaults — mirror server DEFAULT_MATERIAL_PARAMETERS. Merged over
 *  whatever partial the API returns so the editor always has a complete set. */
export const DEFAULT_MATERIAL_PARAMETERS: MaterialParameters = {
  baseColor: '#ffffff',
  roughness: 1.0,
  metallic: 0.0,
  emissiveColor: '#000000',
  emissiveIntensity: 1.0,
  opacity: 1.0,
  normalScale: 1.0,
  aoIntensity: 1.0,
  displacementScale: 0.05,
  displacementBias: 0.0,
  tilingX: 1.0,
  tilingY: 1.0,
  offsetX: 0.0,
  offsetY: 0.0,
  doubleSided: false,
  flipNormalY: false,
};

export interface MaterialDetail {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  thumbnailTextureId: string | null;
  createdByAdminId: string | null;
  createdByApiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Complete PBR parameter set (server merges stored partial over defaults). */
  parameters: MaterialParameters;
  slotsTotal: number;
  slotsFilled: number;
  slots: MaterialSlotAssignment[];
}

export interface MaterialImportResult extends MaterialDetail {
  /** Filenames in the ZIP that were not imported (non-image, unmatched, or
   *  a duplicate slot). */
  skipped: string[];
}

export interface MaterialListParams {
  q?: string;
  tags?: string[];
  limit?: number;
  cursor?: string | number | null;
}

export const materialsApi = {
  list: (params: MaterialListParams = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.tags?.length) qs.set('tags', params.tags.join(','));
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.cursor !== undefined && params.cursor !== null && params.cursor !== '') {
      qs.set('cursor', String(params.cursor));
    }
    const tail = qs.toString();
    return api.get<MaterialListResponse>(`/api/materials${tail ? `?${tail}` : ''}`);
  },
  get: (id: string) => api.get<MaterialDetail>(`/api/materials/${id}`),
  create: (body: { name: string; description?: string; tags?: string[] }) =>
    api.post<MaterialDetail>('/api/materials', body),
  update: (id: string, body: { name?: string; description?: string | null; tags?: string[] }) =>
    api.put<MaterialDetail>(`/api/materials/${id}`, body),
  /**
   * Merge a PARTIAL PBR parameters patch (e.g. `{ roughness: 0.4 }`). The
   * server shallow-merges it into the stored jsonb without touching
   * name/description/tags and returns the refreshed full detail. Used by the
   * editor for live (debounced) slider/colour edits.
   */
  updateParameters: (id: string, partial: Partial<MaterialParameters>) =>
    api.put<MaterialDetail>(`/api/materials/${id}/parameters`, partial),
  remove: (id: string) => api.delete<void>(`/api/materials/${id}`),
  /** Assign an existing texture to a slot; returns the refreshed detail. */
  assignSlot: (id: string, slot: MaterialSlot, textureId: string) =>
    api.put<MaterialDetail>(`/api/materials/${id}/slots/${slot}`, { textureId }),
  /** Clear a slot (the texture file is NOT deleted); returns refreshed detail. */
  unassignSlot: (id: string, slot: MaterialSlot) =>
    api.delete<MaterialDetail>(`/api/materials/${id}/slots/${slot}`),
  /** Absolute URL for the export ZIP — trigger via <a download> / window.open. */
  downloadUrl: (id: string): string => `/api/materials/${id}/download`,
  /**
   * Import a Megascans-style ZIP into a new material. The optional `name`
   * field is appended BEFORE the file part. Reports upload progress (0..1)
   * via the optional callback. Returns the full detail plus `skipped[]`.
   */
  import: (file: File, name?: string, onProgress?: (fraction: number) => void) => {
    const fd = new FormData();
    if (name) fd.append('name', name);
    fd.append('file', file);
    return api.postFormWithProgress<MaterialImportResult>('/api/materials/import', fd, onProgress);
  },
};

// ---------------------------------------------------------------------------
// Fixtures library (prism-fixtures-service)
// ---------------------------------------------------------------------------

export type FixturePartTag =
  | 'ORIGIN' | 'CLAMP' | 'BASE' | 'YOKE' | 'HEAD' | 'LENS' | 'CELL' | 'BEAM';

export interface Vec3 { x: number; y: number; z: number }

export interface Transform4x4 {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  matrix4x4: number[];
}

export interface FixturePatch {
  protocol: string;
  universe: number;
  address: number;
  absoluteAddress: number;
  break: number;
  footprint: number;
  channelRange: string;
  status: string;
}

export interface DmxModeRef {
  modeId: string;
  name: string;
  footprint: number;
}

export interface FixturePart {
  partId: string;
  sourceGdtfGeometryId?: string;
  name: string;
  tag: FixturePartTag;
  parentPartId?: string | null;
  childPartIds: string[];
  modelId?: string | null;
  materialId?: string | null;
  localTransform: Transform4x4;
  pivot?: Vec3;
  motionAxisId?: string | null;
  metadata: Record<string, unknown>;
}

export interface FixtureBeam {
  beamId: string;
  parentPartId?: string;
  beamType?: string;
  beamAngle?: number;
  fieldAngle?: number;
  luminousFlux?: number;
  colourTemperature?: number;
  iesAssetId?: string | null;
  metadata: Record<string, unknown>;
}

export interface MotionAxis {
  motionAxisId: string;
  sourceGdtfGeometryId?: string;
  parentPartId?: string;
  controlledPartId?: string;
  axisType: 'PAN' | 'TILT' | 'ROLL' | 'SPIN' | 'OTHER';
  axisVector: Vec3;
  pivot: Vec3;
  minValue: number;
  maxValue: number;
  defaultValue: number;
  dmxLinks?: string[];
}

export interface WheelSlot {
  slotId: string;
  slotIndex: number;
  slotName: string;
  mediaType: string;
  imageAssetId?: string | null;
  dmxFrom?: number;
  dmxTo?: number;
}

export interface FixtureWheel {
  wheelId: string;
  wheelName: string;
  wheelType: string;
  slots: WheelSlot[];
  dmxLinks: string[];
}

export interface FixtureModel {
  modelId: string;
  sourceGdtfModel?: string;
  sourceFile?: string;
  partTag: FixturePartTag;
  assignedPartIds: string[];
  metadata: Record<string, unknown>;
}

export interface FixtureDefinition {
  fixtureInformation: {
    manufacturer: string;
    fixtureName: string;
    revision?: string;
    fixtureTypeId?: string;
    longName?: string;
    description?: string;
  };
  parts: FixturePart[];
  models: FixtureModel[];
  beams: FixtureBeam[];
  motionRig: MotionAxis[];
  wheels: FixtureWheel[];
  dmxMapping: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export type FixtureImportSource = 'upload' | 'gdtf-share' | 'mvr-embedded';

export interface FixtureVersionSummary {
  id: string;
  fixtureTypeId: string;
  gdtfShareRid: number | null;
  gdtfShareUuid: string | null;
  gdtfVersion: string | null;
  revision: string | null;
  gdtfHash: string;
  originalMediaId: string | null;
  previewModelId: string | null;
  downloadedAt: string;
  isActive: boolean;
}

export interface FixtureUpdateCheck {
  updateAvailable: boolean;
  activeRid: number | null;
  latestRid: number | null;
  latestRevision: string | null;
  latestVersion: string | null;
  latestLastModified: string | null;
}

export interface FixtureEditCarryReport {
  applied: string[];
  unmapped: string[];
}

export interface FixtureListItem {
  id: string;
  name: string;
  manufacturer: string;
  fixtureName: string;
  revision: string | null;
  tags: string[];
  sourceGdtfHash: string | null;
  gdtfShareUuid: string | null;
  importSource: FixtureImportSource;
  activeVersionId: string | null;
  status: string;
  hasPreview: boolean;
  updateAvailable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FixtureDetail extends FixtureListItem {
  definition: FixtureDefinition;
  previewModelId: string | null;
  sourceGdtfId: string | null;
  activeVersion?: FixtureVersionSummary | null;
  versions?: FixtureVersionSummary[];
}

export interface GdtfShareMode {
  name: string;
  dmxfootprint: number;
}

export interface GdtfShareRevision {
  rid: number;
  revision?: string;
  version?: string;
  creationDate?: string;
  lastModified?: string;
  uploader?: string;
  rating?: number;
  creator?: string;
  filesize?: number;
}

export interface GdtfShareResult extends GdtfShareRevision {
  manufacturer: string;
  fixture: string;
  uuid?: string;
  modes?: GdtfShareMode[];
}

export interface GdtfShareCatalogEntry {
  uuid: string;
  manufacturer: string;
  fixture: string;
  versions: GdtfShareRevision[];
  modes?: GdtfShareMode[];
  creator?: string;
  uploader?: string;
  rating?: number;
  lastModified?: string;
}

export interface GdtfShareManufacturer {
  name: string;
  count: number;
}

export interface MvrUnresolvedFixture {
  key: string;
  manufacturer: string;
  fixtureName: string;
  gdtfFilename: string;
  gdtfRef: string;
  embeddedName?: string;
  instanceCount: number;
}

export interface MvrImportInstance {
  id: string;
  tempId: string;
  instanceName: string;
  gdtfRef: string;
  gdtfMode: string;
  fixtureTypeId: string | null;
  status: 'ok' | 'missing' | 'warning';
  warnings: string[];
  patch?: FixturePatch;
}

export interface MvrImportResult {
  runId: string;
  instanceCount?: number;
  instances: MvrImportInstance[];
  unresolvedFixtures: MvrUnresolvedFixture[];
  patchConflicts: string[];
  embeddedGdtfCount?: number;
  autoResolved?: boolean;
}

export interface MvrResolveResult {
  runId: string;
  instances: MvrImportInstance[];
  unresolvedFixtures: MvrUnresolvedFixture[];
  imported: Array<{ key: string; fixtureTypeId: string; source: string }>;
  errors: Array<{ key: string; message: string }>;
  persisted: Array<{ tempId: string; dbId: string; fixtureTypeId: string }>;
  fixtureUpdates?: Record<string, FixtureUpdateCheck>;
}

export interface MvrOrbitUploadResult {
  rootObjectId: string;
  versionId: string;
  objectCount: number;
}

export const fixturesApi = {
  list: (params: { q?: string; tags?: string[]; limit?: number; cursor?: string | null } = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.tags?.length) qs.set('tags', params.tags.join(','));
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    const tail = qs.toString();
    return api.get<{ fixtures: FixtureListItem[]; nextCursor: string | null }>(
      `/api/fixtures${tail ? `?${tail}` : ''}`,
    );
  },
  get: (id: string) => api.get<{ fixture: FixtureDetail }>(`/api/fixtures/${id}`),
  create: (body: { name: string; manufacturer?: string; fixtureName?: string; tags?: string[] }) =>
    api.post<{ fixture: FixtureListItem }>('/api/fixtures', body),
  update: (id: string, body: { name?: string; tags?: string[]; status?: string; definition?: FixtureDefinition }) =>
    api.put<{ fixture: FixtureDetail }>(`/api/fixtures/${id}`, body),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/api/fixtures/${id}`),
  previewUrl: (id: string) => `/api/fixtures/${id}/preview.glb`,
  importGdtf: (file: File, name?: string) => {
    const fd = new FormData();
    if (name) fd.append('name', name);
    fd.append('file', file);
    return api.postForm<{ fixture: FixtureListItem }>('/api/fixtures/import/gdtf', fd);
  },
  importGdtfShare: (rid: number, name?: string) =>
    api.post<{ fixture: FixtureListItem }>('/api/fixtures/import/gdtf-share', { rid, name }),
  listVersions: (id: string) =>
    api.get<{ versions: FixtureVersionSummary[] }>(`/api/fixtures/${id}/versions`),
  checkUpdates: (id: string) =>
    api.get<{ check: FixtureUpdateCheck }>(`/api/fixtures/${id}/check-updates`),
  bulkCheckUpdates: (ids: string[]) =>
    api.post<{ updates: Record<string, boolean> }>('/api/fixtures/check-updates', { ids }),
  downloadVersion: (id: string, rid: number, carryEdits = true) =>
    api.post<{ fixture: FixtureListItem; version: FixtureVersionSummary; report: FixtureEditCarryReport }>(
      `/api/fixtures/${id}/versions`,
      { rid, carryEdits },
    ),
  switchActiveVersion: (id: string, versionId: string) =>
    api.post<{ fixture: FixtureDetail; report: FixtureEditCarryReport }>(
      `/api/fixtures/${id}/active-version`,
      { versionId },
    ),
  catalogGdtfShare: (params: { q?: string; manufacturer?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    const q = params.q?.trim();
    if (q) qs.set('q', q);
    if (params.manufacturer) qs.set('manufacturer', params.manufacturer);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.offset !== undefined) qs.set('offset', String(params.offset));
    const tail = qs.toString();
    return api.get<{
      manufacturers: GdtfShareManufacturer[];
      entries: GdtfShareCatalogEntry[];
      total: number;
    }>(`/api/gdtf-share/catalog${tail ? `?${tail}` : ''}`);
  },
  versionsGdtfShare: (uuid: string) =>
    api.get<{ entry: GdtfShareCatalogEntry }>(`/api/gdtf-share/versions?uuid=${encodeURIComponent(uuid)}`),
  uploadIes: (id: string, beamId: string, file: File) => {
    const fd = new FormData();
    fd.append('beamId', beamId);
    fd.append('file', file);
    return api.postForm<{ mediaId: string; beamId: string }>(`/api/fixtures/${id}/ies`, fd);
  },
  searchGdtfShare: (q: string, limit = 25) =>
    api.get<{ results: GdtfShareResult[] }>(`/api/gdtf-share/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  importMvr: (file: File, autoResolve = false) => {
    const fd = new FormData();
    fd.append('file', file);
    const qs = autoResolve ? '?autoResolve=true' : '';
    return api.postForm<MvrImportResult>(`/api/mvr-import${qs}`, fd);
  },
  resolveMvr: (body: {
    runId: string;
    mappings?: Array<{ gdtfRefKey: string; fixtureTypeId: string }>;
    autoImportMissing?: boolean;
  }) => api.post<MvrResolveResult>('/api/mvr-import/resolve', body),
  uploadMvrToOrbit: (body: {
    runId: string;
    projectId: string;
    modelId: string;
    orbitTarget?: 'prod' | 'dev';
    instanceIds?: string[];
    autoUpdate?: boolean;
  }) => {
    const qs = body.autoUpdate ? '?autoUpdate=true' : '';
    const { autoUpdate: _auto, ...payload } = body;
    return api.post<MvrOrbitUploadResult>(`/api/mvr-import/upload-orbit${qs}`, payload);
  },
};
