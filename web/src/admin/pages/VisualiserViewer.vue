<script setup lang="ts">
/**
 * Admin debug viewer for a single visualiser run (Phase I).
 *
 * Phase G shipped this page with an `<iframe>` shim pointed at the
 * orchestrator's local Cirrus URL — usable on the workstation itself
 * but broken from any other origin because `ws://127.0.0.1:<port>/`
 * isn't reachable. Phase I replaces it with a real Pixel Streaming
 * embed driven by PRISM's WS signalling proxy (`signallingProxy.ts`),
 * which terminates the browser's signalling WebSocket at the server,
 * authenticates with a short-lived HS256 JWT, and forwards each frame
 * across the agent WS to the agent's local Cirrus bridge.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { visualiserApi, type ApiError, type VisualiserRun, type VisualiserRunLogLine, type VisualiserShareTier } from '../../shared/api';
import VisualiserStage from '../../shared/VisualiserStage.vue';
import Icon from '../../shared/Icon.vue';

const route = useRoute();
const runId = computed(() => String(route.params.runId ?? ''));

const run = ref<VisualiserRun | null>(null);
const loadError = ref<string | null>(null);

// Stable per-session seat id reused for the player + control-channel JWTs.
const viewerId = (globalThis.crypto?.randomUUID?.() ?? `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const adminTokenProvider = () => visualiserApi.signallingToken(runId.value, viewerId).then((r) => r.token);

const shareBusy = ref(false);
const shareMsg = ref<string | null>(null);

async function mintShare(tier: VisualiserShareTier) {
  shareBusy.value = true;
  shareMsg.value = null;
  try {
    const res = await visualiserApi.createShare(runId.value, { tier });
    const url = res.url ?? '';
    try { await navigator.clipboard.writeText(url); shareMsg.value = `${tier} link copied to clipboard`; }
    catch { shareMsg.value = `${tier} link: ${url}`; }
  } catch (err) {
    shareMsg.value = (err as ApiError).message ?? 'failed to mint share link';
  } finally {
    shareBusy.value = false;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------- per-run logs (Feature 2)
const logs = ref<VisualiserRunLogLine[]>([]);
const logsError = ref<string | null>(null);

async function refreshLogs() {
  try {
    logs.value = (await visualiserApi.getStreamLogs(runId.value)).logs;
    logsError.value = null;
  } catch (err) {
    logsError.value = (err as ApiError).message ?? 'failed to load logs';
  }
}

function logTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour12: false }) +
    '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function originLabel(r: VisualiserRun): string {
  switch (r.originKind) {
    case 'admin': return 'Admin';
    case 'api':   return 'API';
    case 'orbit': return 'ORBIT';
    case 'internal': return 'Internal';
    default: return '';
  }
}
function originDetail(r: VisualiserRun): string {
  const bits: string[] = [];
  if (r.originPrincipal) bits.push(r.originPrincipal);
  if (r.originAddress)   bits.push(r.originAddress);
  return bits.join(' · ');
}

async function refresh() {
  try {
    run.value = await visualiserApi.getStream(runId.value);
    loadError.value = null;
  } catch (err) {
    loadError.value = (err as ApiError).message ?? 'failed to load run';
  }
}

onMounted(async () => {
  await Promise.all([refresh(), refreshLogs()]);
  // Poll only the metadata; the WebRTC stream is its own long-lived
  // connection. Slower poll than Phase G's 5s — once the player is
  // attached, the status pill rarely changes. Logs poll alongside so
  // lifecycle lines stream in while the run is starting up.
  pollTimer = setInterval(() => { void refresh(); void refreshLogs(); }, 10_000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

async function stopRun() {
  if (!run.value) return;
  if (!confirm('Stop this visualiser run?')) return;
  try {
    await visualiserApi.stopStream(run.value.id);
    await refresh();
  } catch (err) {
    loadError.value = (err as ApiError).message ?? 'stop failed';
  }
}
</script>

<template>
  <section class="viewer">
    <header class="viewer-head">
      <div>
        <RouterLink :to="{ name: 'visualiser' }" class="back"><Icon name="arrow_back" :size="14" />Back to streams</RouterLink>
        <h1>Visualiser <code class="mono">{{ runId.slice(0, 8) }}</code></h1>
        <p class="muted small">
          <template v-if="run">
            status <span :class="['pill', `pill--${run.status}`]">{{ run.status }}</span>
            <template v-if="run.workstationName || run.workstationId">
              · workstation <code class="mono">{{ run.workstationName ?? run.workstationId!.slice(0, 8) }}</code>
            </template>
            <template v-if="run.originKind">
              · origin
              <span :class="['pill', `origin--${run.originKind}`]" :title="originDetail(run)">
                {{ originLabel(run) }}<template v-if="originDetail(run)"> · {{ originDetail(run) }}</template>
              </span>
            </template>
            <template v-if="run.failureReason">
              · failure <code class="mono">{{ run.failureReason }}</code>
            </template>
            <template v-if="run.turn === null">
              · <span class="muted">TURN unset (LAN only)</span>
            </template>
          </template>
        </p>
      </div>
      <div class="head-actions" v-if="run && (run.status === 'streaming' || run.status === 'importing' || run.status === 'queued')">
        <template v-if="run.status === 'streaming'">
          <button class="btn" :disabled="shareBusy" @click="mintShare('view')">Share view link</button>
          <button class="btn" :disabled="shareBusy" @click="mintShare('control')">Share control link</button>
        </template>
        <button class="btn btn-danger" @click="stopRun">Stop</button>
      </div>
    </header>

    <div v-if="shareMsg" class="alert ok">{{ shareMsg }}</div>
    <div v-if="loadError" class="alert err">{{ loadError }}</div>

    <div v-if="run && run.status === 'streaming' && run.signallingUrl" class="player-shell">
      <VisualiserStage
        :run-id="runId"
        :signalling-url="run.signallingUrl"
        :turn="run.turn ?? null"
        :viewer-id="viewerId"
        :token-provider="adminTokenProvider"
      />
    </div>

    <div v-else-if="run" class="placeholder">
      <p v-if="run.status === 'streaming' && !run.signallingUrl">
        Run reported <code>streaming</code> but the server did not
        return a <code>signallingUrl</code>. This is a bug — please report it.
      </p>
      <p v-else-if="run.status === 'queued' || run.status === 'importing'">
        Stream is <strong>{{ run.status }}</strong>. The page will switch to
        the player once the agent reports <code>visualisationReady</code>.
      </p>
      <p v-else-if="run.status === 'failed'">
        Run failed: <code>{{ run.failureReason ?? run.error ?? 'unknown' }}</code>.
      </p>
      <p v-else>Run ended.</p>
    </div>

    <section class="run-logs-panel">
      <header class="rl-head">
        <h2>Run log</h2>
        <span class="muted small">lifecycle events for this run · {{ logs.length }} line{{ logs.length === 1 ? '' : 's' }}</span>
      </header>
      <div v-if="logsError" class="alert err">{{ logsError }}</div>
      <div v-if="!logs.length" class="muted small pad">No log lines yet.</div>
      <div v-else class="rl-list">
        <div v-for="l in logs" :key="l.id" class="rl-line" :class="`lvl-${l.level}`">
          <code class="ts">{{ logTime(l.ts) }}</code>
          <span class="lvl">{{ l.level }}</span>
          <span class="src">{{ l.source }}</span>
          <span class="msg">{{ l.message }}</span>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.viewer { display: flex; flex-direction: column; gap: 16px; height: 100%; min-height: 0; }
.viewer-head { display: flex; justify-content: space-between; align-items: flex-end; }
.viewer-head h1 { margin: 0; font-size: 18px; }
.back { font-size: 12px; color: var(--color-text-muted); text-decoration: none; }
.back:hover { color: var(--color-text); }
.muted { color: var(--color-text-muted); }
.small { font-size: 12px; }
.mono  { font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace); }

.player-shell {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.placeholder {
  padding: 32px; border: 1px dashed var(--color-border); border-radius: var(--radius);
  text-align: center; color: var(--color-text-muted);
}

.alert.err {
  border: 1px solid var(--color-danger, #c33);
  background: var(--color-danger-fade, rgba(204,51,51,0.08));
  padding: 8px 12px; border-radius: var(--radius);
}
.alert.ok {
  border: 1px solid rgba(64,160,96,0.5);
  background: rgba(64,160,96,0.1);
  padding: 8px 12px; border-radius: var(--radius);
}

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

.origin--api      { background: rgba(80,130,220,0.15); border-color: rgba(80,130,220,0.4); color: rgb(90,140,225); }
.origin--admin    { background: rgba(120,90,210,0.15); border-color: rgba(120,90,210,0.4); color: rgb(140,110,225); }
.origin--orbit    { background: rgba(64,160,96,0.15);  border-color: rgba(64,160,96,0.4);  color: rgb(64,160,96); }
.origin--internal,
.origin--anonymous { color: var(--color-text-muted); }

.run-logs-panel {
  border: 1px solid var(--color-border); border-radius: var(--radius);
  background: var(--color-bg-elevated); overflow: hidden;
}
.rl-head {
  display: flex; align-items: baseline; gap: 10px;
  padding: 8px 12px; border-bottom: 1px solid var(--color-border);
}
.rl-head h2 { font-size: 14px; margin: 0; }
.pad { padding: 16px 12px; }
.rl-list { max-height: 280px; overflow: auto; padding: 6px 12px; display: flex; flex-direction: column; gap: 2px; }
.rl-line {
  display: grid; grid-template-columns: 96px 48px 56px 1fr; gap: 8px;
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px;
  align-items: start;
}
.rl-line .ts  { color: var(--color-text-muted); white-space: nowrap; }
.rl-line .lvl { text-transform: uppercase; font-size: 10px; font-weight: 600; align-self: center; }
.rl-line .src { color: var(--color-text-muted); font-size: 11px; align-self: center; }
.rl-line .msg { white-space: pre-wrap; word-break: break-word; }
.rl-line.lvl-error .lvl { color: var(--color-danger, #c33); }
.rl-line.lvl-error .msg { color: rgb(204,80,80); }
.rl-line.lvl-warn  .lvl { color: rgb(196,140,40); }
.rl-line.lvl-info  .lvl { color: var(--color-info, #5a8ce0); }

.btn {
  padding: 6px 12px; border-radius: var(--radius); cursor: pointer;
  border: 1px solid var(--color-border); background: var(--color-bg-elevated); color: var(--color-text);
  font-size: 13px;
}
.btn:hover { background: var(--color-bg); }
.btn-danger { color: var(--color-danger, #c33); }
</style>
