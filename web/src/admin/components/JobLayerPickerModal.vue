<script setup lang="ts">
/**
 * Two-phase layer-selection modal for the admin SPA.
 *
 * When a convert job is submitted with `selectLayers=true`, PRISM dispatches a
 * pollLayers job; the agent returns the Rhino layer tree and the job parks in
 * status `awaiting_selection` (see server/src/ws/agentProtocol.ts). The job
 * sits there until someone POSTs the chosen layers to
 * `POST /api/jobs/:id/layers`, which re-queues it for a normal convert
 * (server/src/api/jobs.ts).
 *
 * The public convert SPA has had this picker since the feature shipped, but the
 * admin SPA never did — so operators could see the `AWAITING_SELECTION` pill but
 * had no way to choose layers and resume. This modal closes that gap.
 *
 * Opened from the Dashboard job table (and the job logs modal) for any
 * `awaiting_selection` job. It fetches the cached tree via
 * `GET /api/jobs/:id/layers`, lets the operator tick layers, and submits the
 * selection. On success the job moves back to `queued` and the dispatcher takes
 * over; on a 409 (the job already changed status under us) we surface the
 * server message instead of silently failing.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { jobsApi, type JobSummary, type LayerNode, type ApiError } from '../../shared/api';
import Icon from '../../shared/Icon.vue';
import LayerTreeNode from './LayerTreeNode.vue';

const props = defineProps<{
  /** The awaiting_selection job to pick layers for. Pass null to keep closed. */
  job: JobSummary | null;
}>();

const emit = defineEmits<{
  /** Selection submitted OK — parent should refresh the job list and close. */
  submitted: [id: string];
  close: [];
}>();

const layers = ref<LayerNode[]>([]);
const expanded = ref(new Set<string>());
const checked = ref(new Set<string>());
const includeDescendants = ref(true);

const loading = ref(false);
const submitting = ref(false);
const error = ref<string | null>(null);
/** Status reported by GET /layers — warn if it is no longer awaiting_selection. */
const loadedStatus = ref<string | null>(null);

function pathOf(node: LayerNode): string {
  return node.fullPath ?? node.name;
}

function descendantPaths(node: LayerNode): string[] {
  const out: string[] = [];
  (function walk(n: LayerNode) {
    out.push(pathOf(n));
    if (n.children) for (const c of n.children) walk(c);
  })(node);
  return out;
}

const allPaths = computed(() => layers.value.flatMap(descendantPaths));
const selectedCount = computed(() => {
  // Only count paths that actually exist in the tree (defends against a
  // restored prior selection that referenced a since-removed layer).
  const present = new Set(allPaths.value);
  let n = 0;
  for (const p of checked.value) if (present.has(p)) n++;
  return n;
});
const totalCount = computed(() => allPaths.value.length);

function tristate(node: LayerNode): 'checked' | 'mixed' | 'unchecked' {
  const paths = descendantPaths(node);
  let on = 0;
  for (const p of paths) if (checked.value.has(p)) on++;
  if (on === 0) return 'unchecked';
  if (on === paths.length) return 'checked';
  return 'mixed';
}

function toggle(node: LayerNode) {
  const state = tristate(node);
  const paths = descendantPaths(node);
  if (state === 'checked') {
    for (const p of paths) checked.value.delete(p);
  } else {
    for (const p of paths) checked.value.add(p);
  }
  // Set mutations don't auto-track in Vue <=3.4 — reassign to trigger reactivity.
  checked.value = new Set(checked.value);
}

function toggleExpanded(node: LayerNode) {
  const fp = pathOf(node);
  if (expanded.value.has(fp)) expanded.value.delete(fp);
  else expanded.value.add(fp);
  expanded.value = new Set(expanded.value);
}

function selectAll() { checked.value = new Set(allPaths.value); }
function selectNone() { checked.value = new Set(); }

async function load(jobId: string) {
  loading.value = true;
  error.value = null;
  loadedStatus.value = null;
  layers.value = [];
  try {
    const res = await jobsApi.getLayers(jobId);
    layers.value = res.layers ?? [];
    loadedStatus.value = res.status;
    // Pre-expand the root level so the tree is immediately useful.
    expanded.value = new Set(layers.value.map(pathOf));
    // Default selection: restore a prior partial selection if one was saved,
    // otherwise pre-select everything (the common "convert all layers" case).
    const present = new Set(layers.value.flatMap(descendantPaths));
    const prior = (res.includedLayers ?? []).filter((p) => present.has(p));
    if (prior.length) {
      checked.value = new Set(prior);
      includeDescendants.value = res.includeLayerDescendants ?? true;
    } else {
      checked.value = new Set(present);
      includeDescendants.value = true;
    }
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load layers';
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!props.job || submitting.value || selectedCount.value === 0) return;
  submitting.value = true;
  error.value = null;
  try {
    await jobsApi.submitLayers(props.job.id, {
      includedLayers: [...checked.value],
      includeLayerDescendants: includeDescendants.value,
    });
    emit('submitted', props.job.id);
  } catch (err) {
    // 409 => the job already left awaiting_selection (cancelled / re-dispatched
    // elsewhere). Surface the server's message rather than failing silently.
    error.value = (err as ApiError).message ?? 'failed to submit selection';
    submitting.value = false;
  }
}

function close() { emit('close'); }

function onBackdropClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('backdrop')) close();
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.job && !submitting.value) close();
}

watch(
  () => props.job?.id,
  (id) => {
    if (!id) {
      layers.value = [];
      checked.value = new Set();
      error.value = null;
      return;
    }
    void load(id);
  },
  { immediate: true },
);

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div v-if="job" class="backdrop" @mousedown="onBackdropClick">
    <div class="modal" role="dialog" aria-modal="true" :aria-label="`Select layers for ${job.fileName}`">
      <header class="modal-head">
        <div class="head-left">
          <span class="pill" :class="job.status">{{ job.status }}</span>
          <strong class="file">{{ job.fileName }}</strong>
          <code class="muted">{{ job.id.slice(0, 8) }}</code>
          <span v-if="job.nodeName" class="muted">on <strong>{{ job.nodeName }}</strong></span>
        </div>
        <button class="icon-btn" type="button" @click="close" title="Close (Esc)" aria-label="Close"><Icon name="close" :size="18" /></button>
      </header>

      <div class="body">
        <div v-if="loading" class="muted center pad">loading layers…</div>

        <div v-else-if="error && !layers.length" class="error-box">{{ error }}</div>

        <template v-else>
          <p class="intro muted">
            Choose which layers to convert. The job will re-queue and dispatch to a
            workstation as a normal convert once you start.
          </p>

          <div
            v-if="loadedStatus && loadedStatus !== 'awaiting_selection'"
            class="warn-box">
            This job is now <strong>{{ loadedStatus }}</strong>, not awaiting selection —
            submitting may be rejected.
          </div>

          <div class="toolbar">
            <div class="muted count">{{ selectedCount }} of {{ totalCount }} selected</div>
            <div class="spacer"></div>
            <button class="link" type="button" @click="selectAll" :disabled="submitting">All</button>
            <button class="link" type="button" @click="selectNone" :disabled="submitting">None</button>
          </div>

          <div class="tree" role="tree">
            <LayerTreeNode
              v-for="node in layers"
              :key="pathOf(node)"
              :node="node"
              :expanded="expanded"
              :tristate="tristate"
              :busy="submitting"
              @toggle="toggle"
              @toggle-expanded="toggleExpanded" />
            <div v-if="!layers.length" class="muted center pad">no layers reported</div>
          </div>

          <label class="check">
            <input type="checkbox" v-model="includeDescendants" :disabled="submitting" />
            Include descendants of selected layers automatically
          </label>

          <div v-if="error" class="error-box">{{ error }}</div>
        </template>
      </div>

      <footer class="modal-foot">
        <button type="button" class="ghost" @click="close" :disabled="submitting">Cancel</button>
        <button
          type="button"
          class="primary"
          @click="submit"
          :disabled="submitting || loading || selectedCount === 0">
          {{ submitting ? 'Starting…' : 'Start convert' }}
        </button>
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
  width: min(560px, 100%);
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
.head-left code { font-size: 12px; }
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

.body {
  padding: 14px 16px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.intro { font-size: 12px; margin: 0; }
.center { text-align: center; }
.pad { padding: 28px 16px; }

.toolbar { display: flex; align-items: center; gap: 8px; }
.toolbar .count { font-size: 12px; }
.toolbar .spacer { flex: 1; }
.toolbar .link {
  /* Compact override of the global 40px-tall uppercase button. */
  min-height: auto;
  text-transform: none;
  letter-spacing: normal;
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text);
  padding: 2px 10px;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
}
.toolbar .link:hover:not(:disabled) { background: var(--color-bg-hover); }

.tree {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 8px;
  background: var(--color-bg-input);
  color: var(--color-text);
}
.check {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: var(--color-text-muted);
  /* Reset the global uppercase/bold <label> styling for this sentence. */
  text-transform: none;
  letter-spacing: normal;
  font-weight: 400;
}

.warn-box {
  border: 1px solid var(--color-warning, #b45309);
  background: var(--color-warning-bg, rgba(180, 83, 9, 0.12));
  color: var(--color-text);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
}
/* .error-box, button.primary and button.ghost all come from the global design
   system (shared/designSystem.css) — we only lay out the footer here. */
.modal-foot {
  padding: 12px 16px;
  border-top: 1px solid var(--color-border);
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
