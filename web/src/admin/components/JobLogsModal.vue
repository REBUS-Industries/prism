<script setup lang="ts">
/**
 * Modal that streams the per-job log from `GET /api/jobs/:id/logs`.
 *
 * The endpoint backs `job_logs` (id, ts, level, source, message), which
 * receives lines from two sources:
 *   - the server itself (lifecycle: queued, dispatched, error, completed),
 *   - the agent over WebSocket (per-stage progress, IronPython output,
 *     ORBIT push results).
 *
 * While the job is in a non-terminal status the modal polls every 2 s
 * so new lines stream in.  Once the job is complete/failed/cancelled
 * we stop polling and let the operator scroll/copy at their leisure.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { jobsApi, type JobLogLine, type JobSummary } from '../../shared/api';

const props = defineProps<{
  /** The job whose logs we should display.  Pass null to keep the modal closed. */
  job: JobSummary | null;
}>();

const emit = defineEmits<{ close: [] }>();

const lines    = ref<JobLogLine[]>([]);
const loading  = ref(false);
const error    = ref<string | null>(null);
const autoScroll = ref(true);
const filter   = ref<'all' | 'errors' | 'agent' | 'server'>('all');
const search   = ref('');
const copied   = ref(false);

const tail = ref<HTMLDivElement | null>(null);

let pollTimer: ReturnType<typeof setInterval> | null = null;

const NON_TERMINAL = new Set<string>([
  'queued', 'dispatched', 'processing', 'uploading', 'awaiting_selection',
]);

const visible = computed(() => {
  let rows = lines.value;
  if (filter.value === 'errors') {
    rows = rows.filter((l) => l.level === 'error' || l.level === 'warn');
  } else if (filter.value === 'agent' || filter.value === 'server') {
    rows = rows.filter((l) => l.source === filter.value);
  }
  const q = search.value.trim().toLowerCase();
  if (q) {
    rows = rows.filter((l) =>
      l.message.toLowerCase().includes(q) ||
      l.level.toLowerCase().includes(q) ||
      l.source.toLowerCase().includes(q),
    );
  }
  return rows;
});

const counts = computed(() => {
  let warn = 0, err = 0;
  for (const l of lines.value) {
    if (l.level === 'error') err++;
    else if (l.level === 'warn') warn++;
  }
  return { total: lines.value.length, warn, err };
});

async function fetchOnce(jobId: string) {
  try {
    const res = await jobsApi.getLogs(jobId);
    lines.value = res.logs ?? [];
    if (autoScroll.value) await nextTick(scrollToBottom);
  } catch (err) {
    error.value = (err as Error).message ?? 'failed to load logs';
  }
}

function scrollToBottom() {
  const el = tail.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function startPoll(jobId: string) {
  stopPoll();
  if (!props.job || !NON_TERMINAL.has(props.job.status)) return;
  // Modest cadence: matches Dashboard's 5 s but tighter while the modal
  // is the user's focus.  The endpoint is cheap (single indexed select).
  pollTimer = setInterval(() => { void fetchOnce(jobId); }, 2_000);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour12: false }) +
    '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function levelClass(level: string): string {
  switch (level) {
    case 'error': return 'lvl-err';
    case 'warn':  return 'lvl-warn';
    case 'info':  return 'lvl-info';
    case 'debug': return 'lvl-debug';
    default:      return 'lvl-info';
  }
}

async function copyAll() {
  const txt = visible.value
    .map((l) => `${timeOf(l.ts)} [${l.level}] ${l.source}: ${l.message}`)
    .join('\n');
  try {
    await navigator.clipboard.writeText(txt);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1_500);
  } catch { /* clipboard blocked — silent */ }
}

function close() {
  emit('close');
}

function onBackdropClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('backdrop')) close();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

watch(
  () => props.job?.id,
  async (id) => {
    if (!id) {
      lines.value = [];
      stopPoll();
      return;
    }
    loading.value = true;
    error.value = null;
    await fetchOnce(id);
    loading.value = false;
    startPoll(id);
  },
  { immediate: true },
);

// React when the job's status changes (terminal -> stop polling).
watch(() => props.job?.status, (s) => {
  if (!s) return;
  if (NON_TERMINAL.has(s)) {
    if (props.job) startPoll(props.job.id);
  } else {
    stopPoll();
  }
});

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => {
  stopPoll();
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div v-if="job" class="backdrop" @mousedown="onBackdropClick">
    <div class="modal" role="dialog" aria-modal="true" :aria-label="`Logs for job ${job.id}`">
      <header class="modal-head">
        <div class="head-left">
          <span class="pill" :class="job.status">{{ job.status }}</span>
          <strong class="file">{{ job.fileName }}</strong>
          <code class="muted">{{ job.id.slice(0, 8) }}</code>
          <span v-if="job.nodeName" class="muted">on <strong>{{ job.nodeName }}</strong></span>
        </div>
        <button class="icon-btn" type="button" @click="close" title="Close (Esc)">✕</button>
      </header>

      <div class="toolbar">
        <input
          v-model="search"
          class="search"
          type="text"
          placeholder="filter messages…" />
        <select v-model="filter" class="filter">
          <option value="all">All ({{ counts.total }})</option>
          <option value="errors">Errors ({{ counts.err + counts.warn }})</option>
          <option value="server">Server only</option>
          <option value="agent">Agent only</option>
        </select>
        <label class="check">
          <input type="checkbox" v-model="autoScroll" />
          Auto-scroll
        </label>
        <div class="spacer"></div>
        <button class="link" type="button" @click="copyAll" :disabled="!visible.length">
          {{ copied ? 'Copied!' : 'Copy' }}
        </button>
      </div>

      <div ref="tail" class="logs">
        <div v-if="loading" class="muted center pad">loading logs…</div>
        <div v-else-if="error" class="error-box">{{ error }}</div>
        <div v-else-if="!visible.length" class="muted center pad">
          {{ lines.length ? 'no lines match the filter' : 'no log lines yet — the agent has not reported anything' }}
        </div>
        <div v-else class="log-table">
          <div v-for="l in visible" :key="l.id" class="log-row" :class="levelClass(l.level)">
            <code class="ts">{{ timeOf(l.ts) }}</code>
            <span class="lvl">{{ l.level }}</span>
            <span class="src">{{ l.source }}</span>
            <span class="msg">{{ l.message }}</span>
          </div>
        </div>
      </div>

      <footer class="modal-foot muted">
        <span v-if="NON_TERMINAL.has(job.status)" class="live">
          <span class="dot"></span> live — polling every 2 s
        </span>
        <span v-else>finished — {{ counts.total }} log line{{ counts.total === 1 ? '' : 's' }}</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 24px;
}
.modal {
  background: var(--color-bg-elevated);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 8px);
  width: min(960px, 100%);
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}
.head-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.head-left .file { font-size: 14px; }
.head-left code  { font-size: 12px; }
.icon-btn {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}
.icon-btn:hover { background: var(--color-bg-hover); color: var(--color-text); }

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--color-border);
}
.toolbar .search {
  flex: 1;
  min-width: 160px;
  background: var(--color-bg-input);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
}
.toolbar .filter {
  background: var(--color-bg-input);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
}
.toolbar .check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-muted);
}
.toolbar .link {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text);
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
}
.toolbar .link:hover:not(:disabled) { background: var(--color-bg-hover); }
.toolbar .spacer { flex: 1; }

.logs {
  flex: 1;
  overflow: auto;
  background: var(--color-bg-input);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
}
.center { text-align: center; }
.pad    { padding: 32px 16px; }

.log-table { display: block; }
.log-row {
  display: grid;
  grid-template-columns: 96px 56px 64px 1fr;
  gap: 8px;
  padding: 2px 12px;
  align-items: start;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
}
.log-row:last-child { border-bottom: none; }
.log-row .ts  { color: var(--color-text-subtle); white-space: nowrap; }
.log-row .lvl {
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.04em;
  font-weight: 600;
  align-self: center;
}
.log-row .src {
  color: var(--color-text-muted);
  font-size: 11px;
  align-self: center;
}
.log-row .msg { color: var(--color-text); }

.lvl-err   { background: var(--color-error-bg); }
.lvl-err   .lvl { color: var(--color-error); }
.lvl-warn  .lvl { color: var(--color-warning, #b45309); }
.lvl-info  .lvl { color: var(--color-info); }
.lvl-debug .lvl { color: var(--color-text-subtle); }

.modal-foot {
  padding: 8px 16px;
  border-top: 1px solid var(--color-border);
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.live { display: inline-flex; align-items: center; gap: 6px; color: var(--color-success); }
.live .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-success);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.35; }
}
</style>
