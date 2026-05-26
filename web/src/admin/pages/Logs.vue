<script setup lang="ts">
/**
 * Live API call log. Subscribes to the shared `apiLog` ring buffer in
 * `shared/api.ts` so every fetch through `ApiClient` is captured here
 * automatically — no per-page wiring needed.
 */
import { computed, onUnmounted, ref } from 'vue';
import { apiLog, type ApiLogEntry } from '../../shared/api';

const entries = ref<ApiLogEntry[]>(apiLog.list());
const paused = ref(false);
const expandedId = ref<number | null>(null);
const filter = ref<'all' | 'errors'>('all');
const search = ref('');

const unsub = apiLog.subscribe((next) => {
  if (paused.value) return;
  entries.value = next;
});
onUnmounted(unsub);

const visible = computed(() => {
  let rows = entries.value;
  if (filter.value === 'errors') rows = rows.filter((e) => !e.ok);
  const q = search.value.trim().toLowerCase();
  if (q) {
    rows = rows.filter((e) =>
      e.url.toLowerCase().includes(q) ||
      e.method.toLowerCase().includes(q) ||
      String(e.status).includes(q),
    );
  }
  return rows;
});

const counts = computed(() => {
  let ok = 0, err = 0;
  for (const e of entries.value) (e.ok ? ok++ : err++);
  return { total: entries.value.length, ok, err };
});

function pause()    { paused.value = !paused.value; }
function clearAll() { apiLog.clear(); expandedId.value = null; }
function pickRow(id: number) { expandedId.value = expandedId.value === id ? null : id; }

function timeOf(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false }) +
    '.' + String(d.getMilliseconds()).padStart(3, '0');
}
function shortPath(url: string): string {
  try { const u = new URL(url, location.origin); return u.pathname + (u.search || ''); }
  catch { return url; }
}
function statusClass(e: ApiLogEntry): string {
  if (!e.ok && e.status === 0) return 'sx-net';
  if (e.status >= 500) return 'sx-5xx';
  if (e.status >= 400) return 'sx-4xx';
  if (e.status >= 300) return 'sx-3xx';
  return 'sx-2xx';
}

function downloadJson(): void {
  const blob = new Blob([JSON.stringify(entries.value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `prism-api-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <div class="logs-page">
    <header class="page-head">
      <div>
        <h1>Logs</h1>
        <p class="muted">
          Live capture of every REST call from this admin session.
          Most recent first. Buffer holds the last 250 calls.
        </p>
      </div>
    </header>

    <div class="toolbar">
      <div class="counts">
        <span class="badge total">{{ counts.total }} total</span>
        <span class="badge ok">{{ counts.ok }} ok</span>
        <span class="badge err" :class="{ zero: !counts.err }">{{ counts.err }} errors</span>
      </div>

      <div class="filters">
        <input
          v-model="search"
          type="search"
          placeholder="Filter by path, method, or status…"
          class="filter-input"
        />
        <div class="seg">
          <button type="button" :class="{ active: filter === 'all' }"    @click="filter = 'all'">All</button>
          <button type="button" :class="{ active: filter === 'errors' }" @click="filter = 'errors'">Errors</button>
        </div>
      </div>

      <div class="actions">
        <button type="button" :class="{ active: paused }" @click="pause">
          {{ paused ? 'Resume' : 'Pause' }}
        </button>
        <button type="button" @click="downloadJson" :disabled="!entries.length">Download JSON</button>
        <button type="button" class="danger" @click="clearAll" :disabled="!entries.length">Clear</button>
      </div>
    </div>

    <div v-if="!visible.length" class="empty">
      <template v-if="!entries.length">
        No API calls captured yet — navigate around the admin app and they'll appear here.
      </template>
      <template v-else>
        No calls match the current filter.
      </template>
    </div>

    <div v-else class="rows">
      <template v-for="e in visible" :key="e.id">
        <div class="row" :class="statusClass(e)" @click="pickRow(e.id)">
          <span class="time">{{ timeOf(e.startedAt) }}</span>
          <span class="method">{{ e.method }}</span>
          <span class="status">{{ e.status || 'NET' }}</span>
          <span class="path" :title="e.url">{{ shortPath(e.url) }}</span>
          <span class="dur">{{ e.durationMs }}ms</span>
        </div>
        <div v-if="expandedId === e.id" class="detail">
          <div class="kv">
            <span class="k">URL</span>
            <code class="v plain">{{ e.url }}</code>
          </div>
          <div v-if="e.errorMessage" class="kv">
            <span class="k">error</span>
            <pre class="v error">{{ e.errorMessage }}</pre>
          </div>
          <div v-if="e.requestBody" class="kv">
            <span class="k">request</span>
            <pre class="v">{{ e.requestBody }}</pre>
          </div>
          <div v-if="e.responseBody" class="kv">
            <span class="k">response</span>
            <pre class="v">{{ e.responseBody }}</pre>
          </div>
          <div v-if="!e.requestBody && !e.responseBody && !e.errorMessage" class="muted small">
            (no body)
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.logs-page { display: flex; flex-direction: column; gap: 16px; }
.page-head h1 { margin: 0 0 4px; font-size: 22px; }
.page-head p  { margin: 0; font-size: 13px; }
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
.badge.ok  { background: var(--color-success-bg); color: var(--color-success); border-color: transparent; }
.badge.err { background: var(--color-error-bg);   color: var(--color-error);   border-color: transparent; }
.badge.err.zero { background: var(--color-bg); color: var(--color-text-muted); }

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
.seg {
  display: inline-flex; border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  overflow: hidden;
}
.seg button {
  background: var(--color-bg-input); color: var(--color-text-muted);
  border: 0; padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer;
}
.seg button + button { border-left: 1px solid var(--color-border); }
.seg button:hover  { background: var(--color-bg-hover); color: var(--color-text); }
.seg button.active { background: var(--orbit-primary-fade); color: var(--orbit-primary); font-weight: 600; }

.actions { display: flex; gap: 6px; margin-left: auto; }
.actions button {
  font: inherit; font-size: 12px; padding: 6px 12px;
  background: var(--color-bg-input);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  color: var(--color-text); cursor: pointer;
}
.actions button:hover:not(:disabled) { background: var(--color-bg-hover); }
.actions button.active { background: var(--orbit-primary-fade); border-color: var(--orbit-primary); color: var(--orbit-primary); }
.actions button.danger:hover:not(:disabled) { background: var(--color-error-bg); color: var(--color-error); border-color: var(--color-error); }
.actions button:disabled { opacity: 0.5; cursor: not-allowed; }

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
  grid-template-columns: 110px 70px 60px 1fr 70px;
  gap: 12px;
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
.method { font-weight: 600; }
.status { font-weight: 700; text-align: right; }
.path   { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
