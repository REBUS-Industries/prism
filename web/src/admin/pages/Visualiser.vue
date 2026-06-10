<script setup lang="ts">
/**
 * Admin Visualiser page (Phase G — start / poll / stop).
 *
 * Renders a table of recent runs + a "Start new stream" modal. Polls
 * `/api/visualiser/streams` every 5s while any non-terminal run exists;
 * stops polling once everything settles. Same pattern as Dashboard.
 *
 * Phase I will replace the "Open viewer" link target with a real Pixel
 * Streaming player; for now it's a minimal iframe (VisualiserViewer.vue).
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import OrbitPicker from '../../shared/OrbitPicker.vue';
import Icon from '../../shared/Icon.vue';
import {
  orbitApi,
  visualiserApi,
  type ApiError,
  type VisualiserRun,
  type VisualiserRunLogLine,
  type VisualiserStatus,
  type VisualiserWorkstation,
} from '../../shared/api';

const rows = ref<VisualiserRun[]>([]);
const loading = ref(true);
const errorMsg = ref<string | null>(null);

let pollTimer: ReturnType<typeof setInterval> | null = null;

const NON_TERMINAL: VisualiserStatus[] = ['queued', 'importing', 'streaming'];
const NON_TERMINAL_SET = new Set<VisualiserStatus>(NON_TERMINAL);

function hasActiveRuns(): boolean {
  return rows.value.some((r) => NON_TERMINAL_SET.has(r.status));
}

async function refresh() {
  try {
    rows.value = (await visualiserApi.listStreams({ limit: 50 })).runs;
    errorMsg.value = null;
  } catch (err) {
    errorMsg.value = (err as ApiError).message ?? 'failed to load runs';
  } finally {
    loading.value = false;
  }
}

function startPollIfNeeded() {
  if (pollTimer || !hasActiveRuns()) return;
  pollTimer = setInterval(async () => {
    try {
      rows.value = (await visualiserApi.listStreams({ limit: 50 })).runs;
    } catch { /* keep polling */ }
    if (!hasActiveRuns()) {
      clearInterval(pollTimer!);
      pollTimer = null;
    }
  }, 5_000);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ---------------------------------------------- live duration ticker
// Tick every second so `durationLive` re-renders on the streaming rows.
// Avoids a watcher per row; the table just reads `now.value` in a computed.
const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;

function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m ${sec.toString().padStart(2, '0')}s`;
  return `${m}m ${sec.toString().padStart(2, '0')}s`;
}

function durationLive(r: VisualiserRun): string {
  if (r.endedAt) return formatDuration(new Date(r.endedAt).getTime() - new Date(r.createdAt).getTime());
  return formatDuration(now.value - new Date(r.createdAt).getTime());
}

// ---------------------------------------------- ORBIT project / model lookup cache
// Resolves projectId → name on first sighting and caches client-side. ORBIT
// has no batch endpoint so we deduplicate via Promise.all on the unique IDs
// in the current row set.
const projectNames = ref<Record<string, string>>({});
const projectLookupTarget = ref<'prod' | 'dev'>('prod');

async function refreshProjectNames() {
  // Pre-loading the full project list under the current target is much faster
  // than per-row fetches, which would also hit ORBIT rate limits with >10
  // active runs.
  try {
    const r = await orbitApi.projects(projectLookupTarget.value, 500);
    const next: Record<string, string> = {};
    for (const p of r.items) next[p.id] = p.name;
    projectNames.value = next;
  } catch {
    // Silent — column just shows the raw ID, which is what the previous PRISM
    // pages do when ORBIT isn't reachable.
  }
}

function projectNameFor(id: string): string {
  return projectNames.value[id] ?? id;
}

// ---------------------------------------------- origin display (Feature 1)
function originLabel(r: VisualiserRun): string {
  switch (r.originKind) {
    case 'admin': return 'Admin';
    case 'api':   return 'API';
    case 'orbit': return 'ORBIT';
    case 'internal': return 'Internal';
    default: return '—';
  }
}
function originDetail(r: VisualiserRun): string {
  const bits: string[] = [];
  if (r.originPrincipal) bits.push(r.originPrincipal);
  if (r.originAddress)   bits.push(r.originAddress);
  return bits.join(' · ');
}

// ---------------------------------------------- per-run logs (Feature 2)
const expandedLogsRunId = ref<string | null>(null);
const runLogs = ref<VisualiserRunLogLine[]>([]);
const runLogsLoading = ref(false);

async function toggleLogs(r: VisualiserRun) {
  if (expandedLogsRunId.value === r.id) {
    expandedLogsRunId.value = null;
    runLogs.value = [];
    return;
  }
  expandedLogsRunId.value = r.id;
  runLogs.value = [];
  runLogsLoading.value = true;
  try {
    runLogs.value = (await visualiserApi.getStreamLogs(r.id)).logs;
  } catch (err) {
    errorMsg.value = (err as ApiError).message ?? 'failed to load run logs';
  } finally {
    runLogsLoading.value = false;
  }
}

function logTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour12: false });
}

// ---------------------------------------------- actions
const stoppingIds = ref(new Set<string>());

async function stopRun(r: VisualiserRun) {
  if (stoppingIds.value.has(r.id)) return;
  if (!confirm(`Stop visualiser run for ${projectNameFor(r.projectId)} / ${r.modelId}?`)) return;
  stoppingIds.value.add(r.id);
  try {
    await visualiserApi.stopStream(r.id);
    await refresh();
    startPollIfNeeded();
  } catch (err) {
    errorMsg.value = (err as ApiError).message ?? 'stop failed';
  } finally {
    stoppingIds.value.delete(r.id);
  }
}

// ---------------------------------------------- start-stream modal
const showStart = ref(false);
const startTarget = ref<'prod' | 'dev'>('prod');
const startProjectId = ref('');
const startModelId = ref('');
const startModelName = ref('');
const startVersionId = ref('');
const startWorkstations = ref<VisualiserWorkstation[]>([]);
const startPickedWorkstation = ref<string>('');
const starting = ref(false);
const startError = ref<string | null>(null);

const canStart = computed(() =>
  !!startProjectId.value && !!startModelId.value && !starting.value,
);

async function openStartModal() {
  showStart.value = true;
  startError.value = null;
  startProjectId.value = '';
  startModelId.value = '';
  startModelName.value = '';
  startVersionId.value = '';
  startPickedWorkstation.value = '';
  try {
    startWorkstations.value = (await visualiserApi.listWorkstations()).workstations;
  } catch (err) {
    startError.value = (err as ApiError).message ?? 'failed to list workstations';
  }
}

function closeStartModal() {
  if (starting.value) return;
  showStart.value = false;
}

async function submitStart() {
  if (!canStart.value) return;
  starting.value = true;
  startError.value = null;
  try {
    const r = await visualiserApi.startStream({
      projectId: startProjectId.value,
      modelId:   startModelId.value,
      versionId: startVersionId.value || undefined,
      orbitTarget: startTarget.value,
      preferredWorkstationId: startPickedWorkstation.value || undefined,
    });
    showStart.value = false;
    await refresh();
    startPollIfNeeded();
    // If we got a runId back, sync the project name cache so the new row
    // doesn't appear as a bare GUID for a 5s polling tick.
    void refreshProjectNames();
    // Hop straight into the viewer.
    if (r.runId) {
      window.location.hash = `#/visualiser/${r.runId}`;
    }
  } catch (err) {
    const e = err as ApiError;
    const body = (e.body as { code?: string; message?: string } | undefined) ?? {};
    startError.value = body.message ?? body.code ?? e.message ?? 'start failed';
  } finally {
    starting.value = false;
  }
}

// ---------------------------------------------- lifecycle
onMounted(async () => {
  await Promise.all([refresh(), refreshProjectNames()]);
  startPollIfNeeded();
  nowTimer = setInterval(() => { now.value = Date.now(); }, 1000);
});

onUnmounted(() => {
  stopPoll();
  if (nowTimer) clearInterval(nowTimer);
});
</script>

<template>
  <section>
    <header class="page-head">
      <div>
        <h1>Visualiser</h1>
        <p class="muted">
          Pixel Streaming sessions of ORBIT versions. Streams run on
          <code>canVisualise = true</code> workstations.
        </p>
      </div>
      <button class="btn btn-primary" @click="openStartModal"><Icon name="add" :size="16" />Start new stream</button>
    </header>

    <div v-if="errorMsg" class="alert err">{{ errorMsg }}</div>

    <div v-if="loading" class="muted">Loading…</div>

    <table v-else-if="rows.length" class="table">
      <thead>
        <tr>
          <th>Run</th>
          <th>Project</th>
          <th>Model</th>
          <th>Version</th>
          <th>Origin</th>
          <th>Workstation</th>
          <th>Status</th>
          <th>Started</th>
          <th>Ready</th>
          <th>Duration</th>
          <th class="row-actions">Actions</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="r in rows" :key="r.id">
        <tr>
          <td><code class="mono">{{ r.id.slice(0, 8) }}</code></td>
          <td>{{ projectNameFor(r.projectId) }}</td>
          <td><code class="mono">{{ r.modelId.slice(0, 8) }}</code></td>
          <td>{{ r.versionId ? r.versionId.slice(0, 8) : '—' }}</td>
          <td>
            <span v-if="r.originKind" :class="['pill', `origin--${r.originKind}`]" :title="originDetail(r)">
              {{ originLabel(r) }}<template v-if="originDetail(r)"> · {{ originDetail(r) }}</template>
            </span>
            <span v-else class="muted">—</span>
          </td>
          <td>{{ r.workstationName ?? (r.workstationId ? r.workstationId.slice(0, 8) : '—') }}</td>
          <td>
            <span :class="['pill', `pill--${r.status}`]">{{ r.status }}</span>
            <span v-if="r.failureReason" class="muted" style="margin-left:6px"
                  :title="r.error ?? r.failureReason">
              ({{ r.failureReason }})
            </span>
          </td>
          <td>{{ new Date(r.createdAt).toLocaleTimeString() }}</td>
          <td>{{ r.readyAt ? new Date(r.readyAt).toLocaleTimeString() : '—' }}</td>
          <td>{{ durationLive(r) }}</td>
          <td class="row-actions">
            <button
              class="btn btn-sm"
              :class="{ active: expandedLogsRunId === r.id }"
              @click="toggleLogs(r)"
            >{{ expandedLogsRunId === r.id ? 'Hide logs' : 'Logs' }}</button>
            <RouterLink
              v-if="r.status === 'streaming'"
              :to="{ name: 'visualiser-viewer', params: { runId: r.id } }"
              class="btn btn-sm"
            >Open viewer</RouterLink>
            <button
              v-if="NON_TERMINAL.includes(r.status)"
              class="btn btn-sm btn-danger"
              :disabled="stoppingIds.has(r.id)"
              @click="stopRun(r)"
            >{{ stoppingIds.has(r.id) ? 'Stopping…' : 'Stop' }}</button>
          </td>
        </tr>
        <tr v-if="expandedLogsRunId === r.id" class="logs-row">
          <td colspan="11">
            <div class="run-logs">
              <div v-if="runLogsLoading" class="muted small">loading logs…</div>
              <div v-else-if="!runLogs.length" class="muted small">no log lines yet for this run.</div>
              <div v-else class="run-log-list">
                <div v-for="l in runLogs" :key="l.id" class="run-log-line" :class="`lvl-${l.level}`">
                  <code class="ts">{{ logTime(l.ts) }}</code>
                  <span class="lvl">{{ l.level }}</span>
                  <span class="src">{{ l.source }}</span>
                  <span class="msg">{{ l.message }}</span>
                </div>
              </div>
            </div>
          </td>
        </tr>
        </template>
      </tbody>
    </table>

    <p v-else class="muted">No visualiser runs yet. Click <strong>Start new stream</strong> to begin.</p>

    <!-- Start new stream modal -->
    <div v-if="showStart" class="modal-backdrop" @click.self="closeStartModal">
      <div class="modal">
        <header>
          <h2>Start visualiser stream</h2>
          <button class="btn-close" :disabled="starting" @click="closeStartModal" aria-label="Close"><Icon name="close" :size="20" /></button>
        </header>

        <div class="form">
          <label class="form-row">
            <span>ORBIT target</span>
            <select v-model="startTarget" :disabled="starting">
              <option value="prod">prod</option>
              <option value="dev">dev</option>
            </select>
          </label>

          <OrbitPicker
            :target="startTarget"
            :project-id="startProjectId"
            :model-id="startModelId"
            :model-name="startModelName"
            @update:projectId="startProjectId = $event"
            @update:modelId="startModelId = $event"
            @update:modelName="startModelName = $event"
          />

          <label class="form-row">
            <span>Version ID <span class="muted">(optional — latest if blank)</span></span>
            <input v-model="startVersionId" :disabled="starting" placeholder="v_2026_05_…" />
          </label>

          <label class="form-row">
            <span>Workstation <span class="muted">(optional — least-loaded if blank)</span></span>
            <select v-model="startPickedWorkstation" :disabled="starting">
              <option value="">— auto-pick least loaded —</option>
              <option
                v-for="w in startWorkstations"
                :key="w.id"
                :value="w.id"
                :disabled="!w.online || !w.canVisualise"
              >
                {{ w.nodeName }}
                <template v-if="!w.online"> · offline</template>
                <template v-else-if="!w.canVisualise"> · canVisualise=false</template>
                <template v-else> · load {{ w.currentVisualiserLoad }} / {{ w.slotsTotal }}</template>
              </option>
            </select>
          </label>

          <div v-if="startError" class="alert err">{{ startError }}</div>

          <p class="muted small">
            Synchronous: blocks ~2-3 s (warm) / ~60-90 s (cold start)
            while the orchestrator boots UE and reports ready.
          </p>
        </div>

        <footer>
          <button class="btn" :disabled="starting" @click="closeStartModal">Cancel</button>
          <button class="btn btn-primary" :disabled="!canStart" @click="submitStart">
            <Icon name="play_arrow" :size="16" />{{ starting ? 'Starting…' : 'Start stream' }}
          </button>
        </footer>
      </div>
    </div>
  </section>
</template>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.page-head p { margin: 4px 0 0; font-size: 13px; }

.muted { color: var(--color-text-muted); }
.small { font-size: 12px; }
.mono  { font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace); }

.alert.err {
  border: 1px solid var(--color-danger, #c33);
  background: var(--color-danger-fade, rgba(204,51,51,0.08));
  padding: 8px 12px; border-radius: var(--radius); margin-bottom: 12px;
}

.table { width: 100%; border-collapse: collapse; }
.table th, .table td {
  text-align: left; padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
  font-size: 13px; vertical-align: middle;
}
.row-actions { white-space: nowrap; }
.row-actions .btn + .btn { margin-left: 4px; }

.pill {
  display: inline-block; padding: 2px 8px;
  border-radius: 999px; font-size: 11px; font-weight: 600;
  background: var(--color-bg-elevated); border: 1px solid var(--color-border);
}
.pill--streaming { background: rgba(64,160,96,0.15); border-color: rgba(64,160,96,0.4); color: rgb(64,160,96); }
.pill--importing,
.pill--queued    { background: rgba(220,160,64,0.15); border-color: rgba(220,160,64,0.4); color: rgb(196,140,40); }
.pill--failed    { background: rgba(204,51,51,0.15);  border-color: rgba(204,51,51,0.4);  color: rgb(204,80,80); }
.pill--ended     { color: var(--color-text-muted); }

/* Origin pills (Feature 1) */
.origin--api      { background: rgba(80,130,220,0.15); border-color: rgba(80,130,220,0.4); color: rgb(90,140,225); }
.origin--admin    { background: rgba(120,90,210,0.15); border-color: rgba(120,90,210,0.4); color: rgb(140,110,225); }
.origin--orbit    { background: rgba(64,160,96,0.15);  border-color: rgba(64,160,96,0.4);  color: rgb(64,160,96); }
.origin--internal,
.origin--anonymous { color: var(--color-text-muted); }

/* Per-run logs (Feature 2) */
.logs-row td { padding: 0; }
.run-logs {
  background: var(--color-bg); border-top: 1px dashed var(--color-border);
  padding: 8px 12px; max-height: 240px; overflow: auto;
}
.run-log-list { display: flex; flex-direction: column; gap: 2px; }
.run-log-line {
  display: grid; grid-template-columns: 72px 48px 56px 1fr; gap: 8px;
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px;
  align-items: start; padding: 1px 0;
}
.run-log-line .ts  { color: var(--color-text-muted); white-space: nowrap; }
.run-log-line .lvl { text-transform: uppercase; font-size: 10px; font-weight: 600; align-self: center; }
.run-log-line .src { color: var(--color-text-muted); font-size: 10.5px; align-self: center; }
.run-log-line .msg { white-space: pre-wrap; word-break: break-word; }
.run-log-line.lvl-error .lvl { color: var(--color-danger, #c33); }
.run-log-line.lvl-warn  .lvl { color: rgb(196,140,40); }
.run-log-line.lvl-info  .lvl { color: var(--color-info, #5a8ce0); }
.btn.active { background: var(--orbit-primary-fade, rgba(80,130,220,0.12)); border-color: var(--orbit-primary, #5a8ce0); }

.btn {
  padding: 4px 10px; border-radius: var(--radius); cursor: pointer;
  border: 1px solid var(--color-border); background: var(--color-bg-elevated); color: var(--color-text);
  font-size: 13px;
}
.btn:hover:not(:disabled) { background: var(--color-bg); }
.btn:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-sm   { padding: 3px 8px; font-size: 12px; }
.btn-primary { background: var(--orbit-primary); color: white; border-color: var(--orbit-primary); }
.btn-primary:hover:not(:disabled) { background: var(--orbit-primary-hover, var(--orbit-primary)); }
.btn-danger  { color: var(--color-danger, #c33); }

/* Modal */
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.45);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal {
  background: var(--color-bg); border: 1px solid var(--color-border);
  border-radius: var(--radius); width: 520px; max-width: 90vw;
  display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0,0,0,0.35);
}
.modal header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--color-border);
}
.modal header h2 { font-size: 16px; margin: 0; }
.btn-close {
  background: transparent; border: none; font-size: 22px; line-height: 1; cursor: pointer;
  color: var(--color-text-muted);
}
.modal .form { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.form-row { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.form-row input, .form-row select {
  padding: 6px 8px; border-radius: var(--radius);
  border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text);
  font-size: 13px;
}
.modal footer {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 16px; border-top: 1px solid var(--color-border);
}
</style>
