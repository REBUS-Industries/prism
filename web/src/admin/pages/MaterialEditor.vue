<script setup lang="ts">

/**

 * Material editor (route /materials/:id). Loads the full material detail and

 * lays out a node-graph editor beside a live three.js PBR preview

 * + metadata form (default 50/50 split, resizable). Slot assignments from the graph are persisted

 * via PUT/DELETE …/slots/:slot and applied optimistically so the preview and

 * the graph update instantly; name / description / tags save via PUT. Export

 * downloads the material ZIP; delete soft-deletes and returns to the library.

 *

 * PBR parameters (base + extensions) are edited entirely on the node graph.

 */

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { RouterLink, useRouter } from 'vue-router';

import PbrNodeGraph from '../components/PbrNodeGraph.vue';

import GlbViewer from '../components/GlbViewer.vue';

import Icon from '../../shared/Icon.vue';

import {

  materialsApi,

  texturesApi,

  MATERIAL_SLOTS,

  DEFAULT_MATERIAL_PARAMETERS,

  type ApiError,

  type MaterialDetail,

  type MaterialParameters,

  type MaterialSlot,

  type MaterialSlotAssignment,

  type Texture,

} from '../../shared/api';



const SIDE_WIDTH_KEY = 'prism-material-editor-side-width';

const SIDE_WIDTH_MIN = 280;

const MIN_GRAPH_WIDTH = 280;

const OLD_SIDE_WIDTH_DEFAULT = 380;



const props = defineProps<{ id: string }>();

const router = useRouter();



const material = ref<MaterialDetail | null>(null);

const loading = ref(true);

const error = ref<string | null>(null);



const name = ref('');

const description = ref('');

const tags = ref('');

const saving = ref(false);

const saveError = ref<string | null>(null);

const slotError = ref<string | null>(null);



const parameters = ref<MaterialParameters>({ ...DEFAULT_MATERIAL_PARAMETERS });

const baselineParameters = ref<MaterialParameters>({ ...DEFAULT_MATERIAL_PARAMETERS });

const paramError = ref<string | null>(null);

const pendingPatch: Partial<MaterialParameters> = {};

let flushTimer: ReturnType<typeof setTimeout> | null = null;



const bodyRef = ref<HTMLDivElement | null>(null);

const sidePaneWidth = ref(400);

const draggingSplitter = ref(false);

let bodyResizeObserver: ResizeObserver | null = null;



function getBodyWidth(): number {

  return bodyRef.value?.clientWidth ?? 1200;

}



function defaultSideWidth(bodyW = getBodyWidth()): number {

  return Math.floor(bodyW * 0.5);

}



function maxSideWidth(bodyW = getBodyWidth()): number {

  return Math.max(SIDE_WIDTH_MIN, bodyW - MIN_GRAPH_WIDTH);

}



function clampSideWidth(px: number, bodyW = getBodyWidth()): number {

  return Math.min(Math.max(px, SIDE_WIDTH_MIN), maxSideWidth(bodyW));

}



function readStoredSideWidth(): number | null {

  try {

    const raw = localStorage.getItem(SIDE_WIDTH_KEY);

    if (!raw) return null;

    const n = Number(raw);

    return Number.isFinite(n) ? n : null;

  } catch {

    return null;

  }

}



function resolveInitialSideWidth(bodyW: number): number {

  const stored = readStoredSideWidth();

  if (stored === null) {

    return clampSideWidth(defaultSideWidth(bodyW), bodyW);

  }

  const tooNarrow = stored < bodyW * 0.3;

  const oldDefault = stored === OLD_SIDE_WIDTH_DEFAULT && bodyW > 800;

  if (tooNarrow || oldDefault) {

    return clampSideWidth(defaultSideWidth(bodyW), bodyW);

  }

  return clampSideWidth(stored, bodyW);

}



function setupBodyLayout(): void {

  if (!bodyRef.value) return;

  const bodyW = bodyRef.value.clientWidth;

  sidePaneWidth.value = resolveInitialSideWidth(bodyW);

  if (!bodyResizeObserver) {

    bodyResizeObserver = new ResizeObserver(() => {

      sidePaneWidth.value = clampSideWidth(sidePaneWidth.value);

    });

    bodyResizeObserver.observe(bodyRef.value);

  }

}



function persistSideWidth(): void {

  try {

    localStorage.setItem(SIDE_WIDTH_KEY, String(sidePaneWidth.value));

  } catch {

    // non-fatal

  }

}



function onSplitterPointerDown(ev: PointerEvent): void {

  if (!bodyRef.value) return;

  draggingSplitter.value = true;

  const startX = ev.clientX;

  const startW = sidePaneWidth.value;



  const onMove = (moveEv: PointerEvent): void => {

    const delta = startX - moveEv.clientX;

    sidePaneWidth.value = clampSideWidth(startW + delta);

  };



  const onUp = (): void => {

    draggingSplitter.value = false;

    persistSideWidth();

    window.removeEventListener('pointermove', onMove);

    window.removeEventListener('pointerup', onUp);

  };



  window.addEventListener('pointermove', onMove);

  window.addEventListener('pointerup', onUp);

}



// ---------------------------------------------------------------------------

// Slot + material helpers

// ---------------------------------------------------------------------------



const sources = computed<Partial<Record<MaterialSlot, string>>>(() => {

  const map: Partial<Record<MaterialSlot, string>> = {};

  if (material.value) {

    for (const s of material.value.slots) map[s.slot] = texturesApi.downloadUrl(s.textureId);

  }

  return map;

});



function syncForm(m: MaterialDetail): void {

  name.value = m.name;

  description.value = m.description ?? '';

  tags.value = m.tags.join(', ');

}



function tagsArray(): string[] {

  return tags.value.split(',').map((s) => s.trim()).filter(Boolean);

}



async function reload(): Promise<void> {

  loading.value = true;

  error.value = null;

  try {

    const m = await materialsApi.get(props.id);

    material.value = m;

    const merged = { ...DEFAULT_MATERIAL_PARAMETERS, ...m.parameters };

    parameters.value = merged;

    baselineParameters.value = structuredClone(merged);

    syncForm(m);

  } catch (err) {

    error.value = (err as ApiError).message ?? 'failed to load material';

    material.value = null;

  } finally {

    loading.value = false;

  }

}



function patchSlotLocal(slot: MaterialSlot, texture: Texture): void {

  if (!material.value) return;

  const assignment: MaterialSlotAssignment = {

    slot,

    textureId: texture.id,

    assignedAt: new Date().toISOString(),

    texture: {

      id: texture.id,

      displayName: texture.displayName,

      originalFilename: texture.originalFilename,

      contentType: texture.contentType,

      sizeBytes: texture.sizeBytes,

    },

  };

  const slots = [...material.value.slots.filter((s) => s.slot !== slot), assignment]

    .sort((a, b) => MATERIAL_SLOTS.indexOf(a.slot) - MATERIAL_SLOTS.indexOf(b.slot));

  material.value = { ...material.value, slots, slotsFilled: slots.length };

}



function removeSlotLocal(slot: MaterialSlot): void {

  if (!material.value) return;

  const slots = material.value.slots.filter((s) => s.slot !== slot);

  material.value = { ...material.value, slots, slotsFilled: slots.length };

}



async function onAssign(slot: MaterialSlot, texture: Texture): Promise<void> {

  if (!material.value) return;

  const id = material.value.id;

  slotError.value = null;

  patchSlotLocal(slot, texture);

  try {

    material.value = await materialsApi.assignSlot(id, slot, texture.id);

  } catch (err) {

    slotError.value = (err as ApiError).message ?? 'failed to assign texture';

    await reload();

  }

}



async function onUnassign(slot: MaterialSlot): Promise<void> {

  if (!material.value) return;

  const id = material.value.id;

  slotError.value = null;

  removeSlotLocal(slot);

  try {

    material.value = await materialsApi.unassignSlot(id, slot);

  } catch (err) {

    slotError.value = (err as ApiError).message ?? 'failed to clear slot';

    await reload();

  }

}



async function save(): Promise<void> {

  if (!material.value || !name.value.trim()) return;

  saving.value = true;

  saveError.value = null;

  try {

    const updated = await materialsApi.update(material.value.id, {

      name: name.value.trim(),

      description: description.value.trim() || null,

      tags: tagsArray(),

    });

    material.value = updated;

    syncForm(updated);

  } catch (err) {

    saveError.value = (err as ApiError).message ?? 'save failed';

  } finally {

    saving.value = false;

  }

}



function onParamChange({

  key,

  value,

}: {

  key: keyof MaterialParameters;

  value: number | string | boolean | string[];

}): void {

  if (!material.value) return;

  (parameters.value as Record<string, unknown>)[key] = value;

  (pendingPatch as Record<string, unknown>)[key] = value;

  scheduleParamFlush(material.value.id);

}



function resetParameterKeys(keys: ReadonlyArray<keyof MaterialParameters>): void {

  if (!material.value || keys.length === 0) return;

  for (const key of keys) {

    const baseline = baselineParameters.value[key];

    (parameters.value as Record<string, unknown>)[key] = baseline;

    (pendingPatch as Record<string, unknown>)[key] = baseline;

  }

  scheduleParamFlush(material.value.id);

}



function scheduleParamFlush(id: string): void {

  if (flushTimer) clearTimeout(flushTimer);

  flushTimer = setTimeout(() => void flushParams(id), 350);

}



async function flushParams(id: string): Promise<void> {

  flushTimer = null;

  const patch = { ...pendingPatch } as Partial<MaterialParameters>;

  for (const k of Object.keys(pendingPatch) as Array<keyof MaterialParameters>) {

    delete pendingPatch[k];

  }

  if (Object.keys(patch).length === 0) return;

  paramError.value = null;

  try {

    await materialsApi.updateParameters(id, patch);

  } catch (err) {

    paramError.value = (err as ApiError).message ?? 'failed to save parameters';

    console.error('material parameter save failed', err);

  }

}



function exportZip(): void {

  if (!material.value) return;

  const a = document.createElement('a');

  a.href = materialsApi.downloadUrl(material.value.id);

  a.rel = 'noopener';

  document.body.appendChild(a);

  a.click();

  a.remove();

}



async function remove(): Promise<void> {

  if (!material.value) return;

  if (!confirm(`Delete material "${material.value.name}"? This soft-deletes it; textures are kept.`)) return;

  try {

    await materialsApi.remove(material.value.id);

    void router.push({ name: 'materials' });

  } catch (err) {

    error.value = (err as ApiError).message ?? 'delete failed';

  }

}



watch(() => props.id, () => void reload(), { immediate: true });



watch(

  () => material.value,

  async (m) => {

    if (!m) return;

    await nextTick();

    setupBodyLayout();

  },

  { immediate: true },

);



onBeforeUnmount(() => {

  bodyResizeObserver?.disconnect();

  bodyResizeObserver = null;

  if (flushTimer) {

    clearTimeout(flushTimer);

    flushTimer = null;

    if (material.value) void flushParams(material.value.id);

  }

});

</script>



<template>

  <section class="editor">

    <div v-if="loading" class="muted">Loading material…</div>



    <div v-else-if="error" class="error-box">

      {{ error }}

      <div class="mt-sm"><RouterLink :to="{ name: 'materials' }" class="back-link"><Icon name="arrow_back" :size="14" />Back to materials</RouterLink></div>

    </div>



    <template v-else-if="material">

      <header class="topbar">

        <RouterLink :to="{ name: 'materials' }" class="back" title="Back to materials" aria-label="Back to materials"><Icon name="arrow_back" :size="18" /></RouterLink>

        <input v-model="name" class="title-input flex-1" placeholder="Material name" @keyup.enter="save" />

        <button class="primary" :disabled="saving || !name.trim()" title="Save name, description, and tags" @click="save">

          <Icon name="save" :size="16" />{{ saving ? 'Saving…' : 'Save' }}

        </button>

        <button title="Download material ZIP" @click="exportZip"><Icon name="download" :size="16" />Export ZIP</button>

        <button class="danger" title="Delete material" @click="remove"><Icon name="delete" :size="16" />Delete</button>

      </header>



      <div v-if="saveError" class="error-box">{{ saveError }}</div>

      <div v-if="slotError" class="error-box">{{ slotError }}</div>

      <div v-if="paramError" class="error-box">{{ paramError }}</div>



      <div ref="bodyRef" class="body" :class="{ 'is-dragging': draggingSplitter }">

        <div class="graph-pane">

          <PbrNodeGraph

            :material-id="material.id"

            :slots="material.slots"

            :parameters="parameters"

            :baseline="baselineParameters"

            @assign="onAssign"

            @unassign="onUnassign"

            @param-change="onParamChange"

            @reset-keys="resetParameterKeys"

          />

        </div>



        <div

          class="col-splitter"

          role="separator"

          aria-orientation="vertical"

          aria-label="Resize side panel"

          @pointerdown="onSplitterPointerDown"

        />



        <div class="side-pane" :style="{ width: `${sidePaneWidth}px`, flex: `0 0 ${sidePaneWidth}px` }">

          <div class="viewer-pane">

            <GlbViewer :sources="sources" :parameters="parameters" />

          </div>



          <div class="card meta">

            <label class="field">

              <span class="muted small">Name</span>

              <input v-model="name" placeholder="Material name" />

            </label>

            <label class="field">

              <span class="muted small">Description</span>

              <textarea v-model="description" rows="2" placeholder="Optional notes about this material" />

            </label>

            <label class="field">

              <span class="muted small">Tags <span class="subtle">(comma separated)</span></span>

              <input v-model="tags" placeholder="brick, exterior, 4k" />

            </label>

            <div class="meta-foot">

              <span class="muted small">{{ material.slotsFilled }}/{{ material.slotsTotal }} slots filled</span>

              <button class="primary" :disabled="saving || !name.trim()" @click="save">

                <Icon name="save" :size="16" />{{ saving ? 'Saving…' : 'Save' }}

              </button>

            </div>

          </div>

        </div>

      </div>

    </template>

  </section>

</template>



<style scoped>

.editor {

  display: flex;

  flex-direction: column;

  gap: 12px;

  height: calc(100vh - 48px);

}

.topbar { display: flex; align-items: center; gap: 8px; }

.back {

  font-size: 18px; line-height: 1; padding: 6px 10px;

  border: 1px solid var(--color-border-strong); border-radius: var(--radius);

  color: var(--color-text); text-decoration: none;

}

.back:hover { border-color: var(--orbit-primary); text-decoration: none; }

.title-input {

  font-size: 18px; font-weight: 700; padding: 7px 12px;

}

button.danger { color: var(--color-error); }

button.danger:hover { border-color: var(--color-error); }



.body {

  flex: 1;

  min-height: 0;

  display: flex;

  flex-direction: row;

  gap: 0;

  align-items: stretch;

}

.body.is-dragging {

  cursor: col-resize;

  user-select: none;

}

.graph-pane {

  flex: 1 1 0;

  min-height: 0;

  min-width: 0;

}

.col-splitter {

  flex: 0 0 6px;

  margin: 0 5px;

  cursor: col-resize;

  border-radius: 3px;

  background: color-mix(in srgb, var(--color-border-strong) 45%, transparent);

  transition: background 0.15s;

}

.col-splitter:hover,

.body.is-dragging .col-splitter {

  background: color-mix(in srgb, var(--orbit-primary) 35%, transparent);

}

.side-pane {

  display: flex;

  flex-direction: column;

  gap: 12px;

  min-height: 0;

  overflow: hidden;

}

.viewer-pane {

  flex: 1 1 400px;

  min-height: 0;

  display: flex;

  flex-direction: column;

}

.viewer-pane :deep(.glb-viewer) {

  flex: 1;

  min-height: 0;

}

.meta { flex: 0 0 auto; display: flex; flex-direction: column; gap: 10px; }

.field { display: flex; flex-direction: column; gap: 4px; }

.field textarea { resize: vertical; font-family: inherit; }

.small { font-size: 12px; }

.meta-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }



@media (max-width: 1100px) {

  .body { flex-direction: column; }

  .col-splitter { display: none; }

  .side-pane {

    width: 100% !important;

    flex: 0 0 auto !important;

  }

  .editor { height: auto; }

  .graph-pane { min-height: 480px; }

}

</style>

