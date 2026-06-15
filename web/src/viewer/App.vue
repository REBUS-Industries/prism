<script setup lang="ts">
/**
 * Login-free PRISM share viewer.
 *
 * Opened by a share link of the form:
 *   /viewer/#/<runId>?st=<opaqueShareToken>
 *
 * Flow: parse runId + share token → POST /shares/exchange (public) to get
 * a signalling JWT (carrying the link's tier + a stable viewerId we
 * supply) + signallingUrl + TURN → hand them to the shared VisualiserStage,
 * which connects the Pixel Streaming player and the control channel. No
 * admin/portal session is required.
 */
import { onMounted, ref } from 'vue';
import { visualiserApi, type ApiError, type VisualiserTurnBundle } from '../shared/api';
import VisualiserStage from '../shared/VisualiserStage.vue';

const loading = ref(true);
const error = ref<string | null>(null);

const runId = ref('');
const shareToken = ref('');
const signallingUrl = ref('');
const turn = ref<VisualiserTurnBundle | null>(null);

// Stable per-session seat id; reused for every exchange so the JWT seat +
// controller lock stay consistent across token refreshes.
const viewerId = (globalThis.crypto?.randomUUID?.() ?? `share-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function parseHash(): { runId: string; st: string } | null {
  // location.hash === '#/<runId>?st=<token>'
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return null;
  const [path, query] = raw.split('?');
  const id = decodeURIComponent(path.split('/')[0] ?? '');
  const params = new URLSearchParams(query ?? '');
  const st = params.get('st') ?? '';
  if (!id || !st) return null;
  return { runId: id, st };
}

const tokenProvider = () =>
  visualiserApi.exchangeShare(runId.value, shareToken.value, viewerId).then((r) => r.token);

onMounted(async () => {
  const parsed = parseHash();
  if (!parsed) {
    error.value = 'This share link is malformed.';
    loading.value = false;
    return;
  }
  runId.value = parsed.runId;
  shareToken.value = parsed.st;
  try {
    const res = await visualiserApi.exchangeShare(parsed.runId, parsed.st, viewerId);
    signallingUrl.value = res.signallingUrl;
    turn.value = res.turn;
  } catch (err) {
    const e = err as ApiError;
    error.value = e.message ?? 'This share link is invalid or has expired.';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="viewer-page">
    <header class="bar">
      <span class="brand brand-mark">PR<span class="brand-accent">ISM</span></span>
      <span class="muted small">shared viewport</span>
    </header>

    <div v-if="loading" class="center muted">Connecting…</div>
    <div v-else-if="error" class="center error">{{ error }}</div>

    <VisualiserStage
      v-else
      class="stage"
      :run-id="runId"
      :signalling-url="signallingUrl"
      :turn="turn"
      :viewer-id="viewerId"
      :token-provider="tokenProvider"
    />
  </div>
</template>

<style scoped>
.viewer-page {
  display: flex; flex-direction: column;
  height: 100vh; width: 100vw;
  background: var(--color-bg, #111); color: var(--color-text, #eee);
}
.bar {
  display: flex; align-items: baseline; gap: 10px;
  padding: 8px 14px; border-bottom: 1px solid var(--color-border, #333);
}
.brand { font-weight: 700; letter-spacing: 0.5px; }
.muted { color: var(--color-text-muted, #888); }
.small { font-size: 12px; }
.center { flex: 1 1 0; display: flex; align-items: center; justify-content: center; }
.error { color: rgb(204,80,80); padding: 24px; text-align: center; }
.stage { flex: 1 1 0; min-height: 0; padding: 10px; }
</style>
