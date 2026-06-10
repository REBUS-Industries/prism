<script setup lang="ts">
/**
 * Live API-call log.
 *
 * Two sources are merged here:
 *   - BROWSER (this session): the client-side `apiLog` ring buffer in
 *     shared/api.ts — every fetch this admin SPA makes, with request/response
 *     body previews. Captured automatically, no per-page wiring.
 *   - SERVER (all inbound): the server-side ring buffer exposed by
 *     `GET /api/admin/logs` — every request the server answered, including
 *     EXTERNAL API-key calls, ORBIT bearers, and internal download-token
 *     traffic that never touch this browser. Safe metadata only (method,
 *     path, status, duration, principal kind/label, client IP, category) —
 *     no headers, cookies, or bodies, so no secret can leak.
 *
 * Filter toggles let the operator turn categories, levels, and each source
 * on/off. Both ring buffers are bounded so memory stays flat.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  apiLog,
  serverLogsApi,
  type ApiLogEntry,
  type ServerApiLogEntry,
  type ServerApiLogCategory,
  type ServerApiLogLevel,
} from '../../shared/api';
import Icon from '../../shared/Icon.vue';

type RowSource = 'browser' | 'server';
type Level = ServerApiLogLevel;

interface UnifiedRow {
  key: string;
  source: RowSource;
  ts: number;
  durationMs: number;
  method: string;
  path: string;
  status: number;
  level: Level;
  category: ServerApiLogCategory | 'browser';
  originKind?: string;
  originPrincipal?: string | null;
  clientIp?: string | null;
  // browser-only extras
  requestBody?: string;
  responseBody?: string;
  errorMessage?: string;
}

const MAX_SERVER_ROWS = 1000;

const browserEntries = ref<ApiLogEntry[]>(apiLog.list());
const serverEntries = ref<ServerApiLogEntry[]>([]);
let lastServerId = 0;

const paused = ref(false);
const expandedKey = ref<string | null>(null);
const search = ref('');

// Filter toggles — sensible defaults: show everything except the noisy
// `system` category (health/static probes) and the server-side `admin`
// rows that duplicate the richer browser entries.
const showBrowser = ref(true);
const showServer = ref(true);
const cat = ref<Record<ServerApiLogCategory, boolean>>({
  external: true,
  admin: false,
  orbit: true,
  internal: true,
  system: false,
});
const lvl = ref<Record<Level, boolean>>({ info: true, warn: true, error: true });

const unsubBrowser = apiLog.subscribe((next) => {
  if (paused.value) return;
  browserEntries.value = next;
});
onUnmounted(unsubBrowser);

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function pollServer() {
  if (paused.value) return;
  try {
    const res = await serverLogsApi.list(lastServerId);
    if (res.entries.length) {
      for (const e of res.entries) if (e.id > lastServerId) lastServerId = e.id;
      const merged = [...serverEntries.value, ...res.entries];
      serverEntries.value = merged.slice(-MAX_SERVER_ROWS);
    }
  } catch {
    /* keep polling — transient errors are fine */
  }
}

function browserLevel(e: ApiLogEntry): Level {
  if (!e.ok && (e.status === 0 || e.status >= 500)) return 'error';
  if (e.status >= 400) return 'warn';
  return 'info';
}

const allRows = computed<UnifiedRow[]>(() => {
  const out: UnifiedRow[] = [];
  if (showBrowser.value) {
    for (const e of browserEntries.value) {
      out.push({
        key: `b-${e.id}`,
        source: 'browser',
        ts: e.startedAt,
        durationMs: e.durationMs,
        method: e.method,
        path: shortPath(e.url),
        status: e.status,
        level: browserLevel(e),
        category: 'browser',
        originKind: 'admin',
        requestBody: e.requestBody,
        responseBody: e.responseBody,
        errorMessage: e.errorMessage,
      });
    }
  }
  if (showServer.value) {
    for (const e of serverEntries.value) {
      out.push({
        key: `s-${e.id}`,
        source: 'server',
        ts: e.ts,
        durationMs: e.durationMs,
        method: e.method,
        path: e.path,
        status: e.status,
        level: e.level,
        category: e.category,
        originKind: e.originKind,
        originPrincipal: e.originPrincipal,
        clientIp: e.clientIp,
      });
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
});

const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return allRows.value.filter((r) => {
    if (r.source === 'server' && r.category !== 'browser' && !cat.value[r.category as ServerApiLogCategory]) return false;
    if (!lvl.value[r.level]) return false;
    if (q) {
      const hay = `${r.method} ${r.path} ${r.status} ${r.originPrincipal ?? ''} ${r.clientIp ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
});

const counts = computed(() => {
  let info = 0, warn = 0, err = 0;
  for (const r of visible.value) {
    if (r.level === 'error') err++;
    else if (r.level === 'warn') warn++;
    else info++;
  }
  return { total: visible.value.length, info, warn, err };
});

function pause() { paused.value = !paused.value; }
function clearAll() {
  apiLog.clear();
  serverEntries.value = [];
  expandedKey.value = null;
}
function pickRow(key: string) { expandedKey.value = expandedKey.value === key ? null : key; }

function timeOf(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false }) +
    '.' + String(d.getMilliseconds()).padStart(3, '0');
}
function shortPath(url: string): string {
  try { const u = new URL(url, location.origin); return u.pathname + (u.search || ''); }
  catch { return url; }
}
function statusClass(r: UnifiedRow): string {
  if (r.status === 0) return 'sx-net';
  if (r.status >= 500) return 'sx-5xx';
  if (r.status >= 400) return 'sx-4xx';
  if (r.status >= 300) return 'sx-3xx';
  return 'sx-2xx';
}
function originText(r: UnifiedRow): string {
  const label = r.originKind === 'admin' ? 'Admin'
    : r.originKind === 'api' ? 'API'
    : r.originKind === 'orbit' ? 'ORBIT'
    : r.originKind === 'internal' ? 'Internal'
    : r.originKind === 'anonymous' ? 'Anon' : '';
  const detail = [r.originPrincipal, r.clientIp].filter(Boolean).join(' · ');
  return detail ? `${label} · ${detail}` : label;
}

function downloadJson(): void {
  const blob = new Blob([JSON.stringify(visible.value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `prism-api-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

onMounted(() => {
  void pollServer();
  pollTimer = setInterval(() => { void pollServer(); }, 2_000);
});
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<template>
  <div class="logs-page">
    <header class="page-head">
      <div>
        <h1>Logs</h1>
        <p class="muted">
          Live capture of API calls — this admin session's own requests
          <strong>and</strong> every inbound call the server answered
          (external API keys, ORBIT bearers, internal traffic). Most recent
          first. Bounded ring buffers; no secrets recorded.
        </p>
      </div>
    </header>

    <div class="toolbar">
      <div class="counts">
        <span class="badge total">{{ counts.total }} shown</span>
        <span class="badge ok">{{ counts.info }} info</span>
        <span class="badge warn" :class="{ zero: !counts.warn }">{{ counts.warn }} warn</span>
        <span class="badge err" :class="{ zero: !counts.err }">{{ counts.err }} error</span>
      </div>

      <div class="filters">
        <input
          v-model="search"
          type="search"
          placeholder="Filter by path, method, status, principal, IP…"
          class="filter-input"
        />
      </div>

      <div class="actions">
        <button type="button" :class="{ active: paused }" @click="pause">
          <Icon :name="paused ? 'play_arrow' : 'pause'" :size="14" />{{ paused ? 'Resume' : 'Pause' }}
        </button>
        <button type="button" @click="downloadJson" :disabled="!visible.length"><Icon name="download" :size="14" />Download JSON</button>
        <button type="button" class="danger" @click="clearAll"><Icon name="delete_sweep" :size="14" />Clear</button>
      </div>
    </div>

    <div class="toggles">
      <div class="toggle-group">
        <span class="tg-label">Source</span>
        <label class="chip"><input type="checkbox" v-model="showBrowser" /> Browser (this session)</label>
        <label class="chip"><input type="checkbox" v-model="showServer" /> Server (all inbound)</label>
      </div>
      <div class="toggle-group">
        <span class="tg-label">Category</span>
        <label class="chip"><input type="checkbox" v-model="cat.external" /> External API</label>
        <label class="chip"><input type="checkbox" v-model="cat.admin" /> Admin</label>
        <label class="chip"><input type="checkbox" v-model="cat.orbit" /> ORBIT</label>
        <label class="chip"><input type="checkbox" v-model="cat.internal" /> Internal</label>
        <label class="chip"><input type="checkbox" v-model="cat.system" /> System</label>
      </div>
      <div class="toggle-group">
        <span class="tg-label">Level</span>
        <label class="chip"><input type="checkbox" v-model="lvl.info" /> Info</label>
        <label class="chip"><input type="checkbox" v-model="lvl.warn" /> Warn</label>
        <label class="chip"><input type="checkbox" v-model="lvl.error" /> Error</label>
      </div>
    </div>

    <div v-if="!visible.length" class="empty">
      <template v-if="!allRows.length">
        No API calls captured yet — navigate around the admin app or wait for
        inbound traffic and entries will appear here.
      </template>
      <template v-else>
        No calls match the current filters.
      </template>
    </div>

    <div v-else class="rows">
      <template v-for="r in visible" :key="r.key">
        <div class="row" :class="statusClass(r)" @click="pickRow(r.key)">
          <span class="time">{{ timeOf(r.ts) }}</span>
          <span class="src-tag" :class="`src-${r.source}`">{{ r.source === 'browser' ? 'BRW' : 'SRV' }}</span>
          <span class="method">{{ r.method }}</span>
          <span class="status">{{ r.status || 'NET' }}</span>
          <span class="path" :title="r.path">{{ r.path }}</span>
          <span class="origin" :title="originText(r)">{{ originText(r) }}</span>
          <span class="dur">{{ r.durationMs }}ms</span>
        </div>
        <div v-if="expandedKey === r.key" class="detail">
          <div class="kv">
            <span class="k">path</span>
            <code class="v plain">{{ r.path }}</code>
          </div>
          <div class="kv">
            <span class="k">meta</span>
            <code class="v plain">
              {{ r.source }} · {{ r.category }} · {{ r.level }}<template v-if="originText(r)"> · {{ originText(r) }}</template>
            </code>
          </div>
          <div v-if="r.errorMessage" class="kv">
            <span class="k">error</span>
            <pre class="v error">{{ r.errorMessage }}</pre>
          </div>
          <div v-if="r.requestBody" class="kv">
            <span class="k">request</span>
            <pre class="v">{{ r.requestBody }}</pre>
          </div>
          <div v-if="r.responseBody" class="kv">
            <span class="k">response</span>
            <pre class="v">{{ r.responseBody }}</pre>
          </div>
          <div v-if="r.source === 'server'" class="muted small">
            Server-side entry — metadata only (no body recorded).
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.logs-page { display: flex; flex-direction: column; gap: 16px; }
.page-head h1 { margin: 0 0 4px; font-size: 22px; }
.page-head p  { margin: 0; font-size: 13px; max-width: 760px; }
.muted        { color: var(--color-text-muted); }
.small        { font-size: 11px; }

.toolbar {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 10px 12px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
}
.counts { display: flex; gap: 6px; }
.badge {
  font-size: 11px; font-weight: 600;
  padding: 3px 8px; border-radius: 999px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
}
.badge.ok   { background: var(--color-success-bg); color: var(--color-success); border-color: transparent; }
.badge.warn { background: var(--color-warn-bg, rgba(196,140,40,0.15)); color: var(--color-warn, rgb(196,140,40)); border-color: transparent; }
.badge.err  { background: var(--color-error-bg);   color: var(--color-error);   border-color: transparent; }
.badge.warn.zero, .badge.err.zero { background: var(--color-bg); color: var(--color-text-muted); }

.filters { display: flex; gap: 8px; flex: 1; min-width: 240px; }
.filter-input {
  flex: 1; min-width: 0;
  padding: 6px 10px;
  background: var(--color-bg-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font: inherit; font-size: 12px;
}

.actions { display: flex; gap: 6px; margin-left: auto; }
.actions button {
  display: inline-flex; align-items: center; gap: 5px;
  font: inherit; font-size: 12px; padding: 6px 12px;
  background: var(--color-bg-input);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  color: var(--color-text); cursor: pointer;
}
.actions button:hover:not(:disabled) { background: var(--color-bg-hover); }
.actions button.active { background: var(--orbit-primary-fade); border-color: var(--orbit-primary); color: var(--orbit-primary); }
.actions button.danger:hover:not(:disabled) { background: var(--color-error-bg); color: var(--color-error); border-color: var(--color-error); }
.actions button:disabled { opacity: 0.5; cursor: not-allowed; }

.toggles {
  display: flex; flex-wrap: wrap; gap: 18px;
  padding: 8px 12px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
}
.toggle-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tg-label {
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--color-text-muted);
}
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; color: var(--color-text);
  padding: 3px 8px; border: 1px solid var(--color-border);
  border-radius: 999px; cursor: pointer; user-select: none;
  background: var(--color-bg-input);
}
.chip:hover { background: var(--color-bg-hover); }
.chip input { margin: 0; }

.empty {
  padding: 32px; text-align: center;
  color: var(--color-text-muted); font-size: 13px;
  background: var(--color-bg-elevated);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius);
}

.rows {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: hidden;
}

.row {
  display: grid;
  grid-template-columns: 104px 42px 62px 52px 1fr 220px 64px;
  gap: 10px;
  align-items: center;
  padding: 6px 14px;
  font-family: var(--font-mono);
  font-size: 12px;
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
}
.row:last-child { border-bottom: 0; }
.row:hover { background: var(--color-bg-hover); }
.time   { color: var(--color-text-muted); }
.src-tag {
  font-size: 9.5px; font-weight: 700; text-align: center;
  padding: 1px 0; border-radius: 4px; letter-spacing: 0.03em;
}
.src-tag.src-browser { background: rgba(120,90,210,0.18); color: rgb(140,110,225); }
.src-tag.src-server  { background: rgba(80,130,220,0.18); color: rgb(90,140,225); }
.method { font-weight: 600; }
.status { font-weight: 700; text-align: right; }
.path   { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.origin { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--color-text-muted); }
.dur    { text-align: right; color: var(--color-text-muted); }

.row.sx-2xx .status { color: var(--color-success); }
.row.sx-3xx .status { color: var(--color-info); }
.row.sx-4xx .status { color: var(--color-warn); }
.row.sx-5xx .status { color: var(--color-error); }
.row.sx-net .status { color: var(--color-error); }

.detail {
  padding: 10px 14px 14px;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
}
.detail:last-child { border-bottom: 0; }
.kv { display: grid; grid-template-columns: 80px 1fr; gap: 10px; margin-top: 6px; }
.kv .k { font-size: 11px; color: var(--color-text-muted); text-transform: uppercase; padding-top: 4px; }
.kv .v {
  margin: 0; padding: 6px 8px;
  background: var(--color-bg-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono); font-size: 11.5px;
  white-space: pre-wrap; word-break: break-word;
  max-height: 280px; overflow: auto;
}
.kv .v.plain { display: inline-block; max-height: none; }
.kv .v.error { color: var(--color-error); }
</style>
