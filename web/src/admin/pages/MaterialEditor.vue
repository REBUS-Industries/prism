<script setup lang="ts">
/**
 * Material editor (route /materials/:id). Loads the full material detail and
 * lays out a node-graph editor (left ~60%) beside a live three.js PBR preview
 * + metadata form + comprehensive properties panel (right ~40%). Slot
 * assignments from the graph are persisted via PUT/DELETE …/slots/:slot and
 * applied optimistically so the preview and the graph update instantly;
 * name / description / tags save via PUT. Export downloads the material ZIP;
 * delete soft-deletes and returns to the library.
 *
 * The Properties panel replicates the glTF-extension editing convention
 * visible in the reference screenshots: always-present base sections + an
 * add/remove Extensions system for optional material extensions.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import PbrNodeGraph from '../components/PbrNodeGraph.vue';
import GlbViewer from '../components/GlbViewer.vue';
import ParamSlider from '../components/ParamSlider.vue';
import ParamColor from '../components/ParamColor.vue';
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

// Live-editable PBR parameters. Kept separate from `material` so rapid slider
// edits update the viewer instantly without round-tripping the slot/metadata
// state; persistence is coalesced + debounced through `pendingPatch`.
const parameters = ref<MaterialParameters>({ ...DEFAULT_MATERIAL_PARAMETERS });
const paramError = ref<string | null>(null);
const pendingPatch: Partial<MaterialParameters> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Properties panel state
// ---------------------------------------------------------------------------

const openSections = ref<Record<string, boolean>>({
  base: true,
  displacement: false,
  textureUv: false,
  alpha: true,
});

function isOpen(section: string): boolean {
  return openSections.value[section] !== false;
}
function toggleSection(section: string): void {
  openSections.value[section] = !isOpen(section);
}

const ALL_EXTENSIONS = [
  { id: 'clearCoat',       label: 'Clear Coat' },
  { id: 'transmission',    label: 'Transmission' },
  { id: 'ior',             label: 'Index of Refraction' },
  { id: 'specular',        label: 'Specular' },
  { id: 'sheen',           label: 'Sheen' },
  { id: 'volume',          label: 'Volume' },
  { id: 'anisotropy',      label: 'Anisotropy' },
  { id: 'iridescence',     label: 'Iridescence' },
  { id: 'emissiveStrength',label: 'Emissive Strength' },
  { id: 'dispersion',      label: 'Dispersion' },
  { id: 'unlit',           label: 'Unlit' },
] as const;

type ExtId = (typeof ALL_EXTENSIONS)[number]['id'];

const EXT_LABELS: Record<string, string> = Object.fromEntries(
  ALL_EXTENSIONS.map((e) => [e.id, e.label]),
);

const availableExtensions = computed(() =>
  ALL_EXTENSIONS.filter((e) => !parameters.value.activeExtensions.includes(e.id)),
);

function addExtension(id: string): void {
  if (!id || parameters.value.activeExtensions.includes(id)) return;
  openSections.value[id] = true;
  onParamChange({
    key: 'activeExtensions',
    value: [...parameters.value.activeExtensions, id],
  });
}

function removeExtension(id: string): void {
  onParamChange({
    key: 'activeExtensions',
    value: parameters.value.activeExtensions.filter((e) => e !== id),
  });
}

function onAddExtension(ev: Event): void {
  const sel = ev.target as HTMLSelectElement;
  const id = sel.value;
  sel.value = '';
  addExtension(id);
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
    parameters.value = { ...DEFAULT_MATERIAL_PARAMETERS, ...m.parameters };
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

onBeforeUnmount(() => {
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
        <button class="primary" :disabled="saving || !name.trim()" @click="save">
          <Icon name="save" :size="16" />{{ saving ? 'Saving…' : 'Save' }}
        </button>
        <button @click="exportZip"><Icon name="download" :size="16" />Export ZIP</button>
        <button class="danger" @click="remove"><Icon name="delete" :size="16" />Delete</button>
      </header>

      <div v-if="saveError" class="error-box">{{ saveError }}</div>
      <div v-if="slotError" class="error-box">{{ slotError }}</div>
      <div v-if="paramError" class="error-box">{{ paramError }}</div>

      <div class="body">
        <div class="graph-pane">
          <PbrNodeGraph
            :material-id="material.id"
            :slots="material.slots"
            :parameters="parameters"
            @assign="onAssign"
            @unassign="onUnassign"
            @param-change="onParamChange"
          />
        </div>

        <div class="side-pane">
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

          <!-- ============================================================
               Material Properties panel
               ============================================================ -->
          <div class="card properties">

            <!-- ── BASE PROPERTIES ──────────────────────────────────────── -->
            <div class="prop-section">
              <button class="sect-head" @click="toggleSection('base')">
                <Icon name="chevron_right" :size="13" :class="['sect-chevron', { open: isOpen('base') }]" />
                <span>BASE PROPERTIES</span>
              </button>
              <div v-if="isOpen('base')" class="sect-body">
                <ParamColor
                  label="Base Color"
                  :model-value="parameters.baseColor"
                  @update:model-value="(v) => onParamChange({ key: 'baseColor', value: v })"
                />
                <ParamSlider
                  label="Metallic" :min="0" :max="1" :step="0.01"
                  :model-value="parameters.metallic"
                  @update:model-value="(v) => onParamChange({ key: 'metallic', value: v })"
                />
                <ParamSlider
                  label="Roughness" :min="0" :max="1" :step="0.01"
                  :model-value="parameters.roughness"
                  @update:model-value="(v) => onParamChange({ key: 'roughness', value: v })"
                />
                <ParamColor
                  label="Emissive"
                  :model-value="parameters.emissiveColor"
                  @update:model-value="(v) => onParamChange({ key: 'emissiveColor', value: v })"
                />
                <ParamSlider
                  label="Emissive Intensity" :min="0" :max="10" :step="0.1"
                  :model-value="parameters.emissiveIntensity"
                  @update:model-value="(v) => onParamChange({ key: 'emissiveIntensity', value: v })"
                />
                <ParamSlider
                  label="Normal Scale" :min="0" :max="2" :step="0.01"
                  :model-value="parameters.normalScale"
                  @update:model-value="(v) => onParamChange({ key: 'normalScale', value: v })"
                />
                <ParamSlider
                  label="Occlusion" sublabel="AO intensity" :min="0" :max="1" :step="0.01"
                  :model-value="parameters.aoIntensity"
                  @update:model-value="(v) => onParamChange({ key: 'aoIntensity', value: v })"
                />
              </div>
            </div>

            <!-- ── DISPLACEMENT ─────────────────────────────────────────── -->
            <div class="prop-section">
              <button class="sect-head" @click="toggleSection('displacement')">
                <Icon name="chevron_right" :size="13" :class="['sect-chevron', { open: isOpen('displacement') }]" />
                <span>DISPLACEMENT</span>
              </button>
              <div v-if="isOpen('displacement')" class="sect-body">
                <ParamSlider
                  label="Scale" :min="0" :max="0.5" :step="0.005"
                  :model-value="parameters.displacementScale"
                  @update:model-value="(v) => onParamChange({ key: 'displacementScale', value: v })"
                />
                <ParamSlider
                  label="Bias" :min="-0.5" :max="0.5" :step="0.005"
                  :model-value="parameters.displacementBias"
                  @update:model-value="(v) => onParamChange({ key: 'displacementBias', value: v })"
                />
              </div>
            </div>

            <!-- ── TEXTURE UV ────────────────────────────────────────────── -->
            <div class="prop-section">
              <button class="sect-head" @click="toggleSection('textureUv')">
                <Icon name="chevron_right" :size="13" :class="['sect-chevron', { open: isOpen('textureUv') }]" />
                <span>TEXTURE UV</span>
              </button>
              <div v-if="isOpen('textureUv')" class="sect-body">
                <div class="sect-grid-2">
                  <ParamSlider
                    label="Tiling X" :min="0.1" :max="16" :step="0.1"
                    :model-value="parameters.tilingX"
                    @update:model-value="(v) => onParamChange({ key: 'tilingX', value: v })"
                  />
                  <ParamSlider
                    label="Tiling Y" :min="0.1" :max="16" :step="0.1"
                    :model-value="parameters.tilingY"
                    @update:model-value="(v) => onParamChange({ key: 'tilingY', value: v })"
                  />
                  <ParamSlider
                    label="Offset X" :min="-2" :max="2" :step="0.01"
                    :model-value="parameters.offsetX"
                    @update:model-value="(v) => onParamChange({ key: 'offsetX', value: v })"
                  />
                  <ParamSlider
                    label="Offset Y" :min="-2" :max="2" :step="0.01"
                    :model-value="parameters.offsetY"
                    @update:model-value="(v) => onParamChange({ key: 'offsetY', value: v })"
                  />
                </div>
              </div>
            </div>

            <!-- ── ALPHA ────────────────────────────────────────────────── -->
            <div class="prop-section">
              <button class="sect-head" @click="toggleSection('alpha')">
                <Icon name="chevron_right" :size="13" :class="['sect-chevron', { open: isOpen('alpha') }]" />
                <span>ALPHA</span>
              </button>
              <div v-if="isOpen('alpha')" class="sect-body">
                <label class="prop-field">
                  <span class="prop-label">Alpha Mode</span>
                  <select
                    class="prop-select"
                    :value="parameters.alphaMode"
                    @change="onParamChange({ key: 'alphaMode', value: ($event.target as HTMLSelectElement).value as 'opaque' | 'blend' | 'mask' })"
                  >
                    <option value="opaque">Opaque</option>
                    <option value="blend">Blend</option>
                    <option value="mask">Mask</option>
                  </select>
                </label>
                <ParamSlider
                  v-if="parameters.alphaMode === 'mask'"
                  label="Alpha Cutoff" :min="0" :max="1" :step="0.01"
                  :model-value="parameters.alphaCutoff"
                  @update:model-value="(v) => onParamChange({ key: 'alphaCutoff', value: v })"
                />
                <label class="prop-toggle">
                  <input
                    type="checkbox"
                    :checked="parameters.doubleSided"
                    @change="onParamChange({ key: 'doubleSided', value: ($event.target as HTMLInputElement).checked })"
                  />
                  Double Sided
                </label>
                <label class="prop-toggle">
                  <input
                    type="checkbox"
                    :checked="parameters.flipNormalY"
                    @change="onParamChange({ key: 'flipNormalY', value: ($event.target as HTMLInputElement).checked })"
                  />
                  Flip Normal Y
                </label>
              </div>
            </div>

            <!-- ── ACTIVE EXTENSION SECTIONS ────────────────────────────── -->
            <div
              v-for="extId in parameters.activeExtensions"
              :key="extId"
              class="prop-section ext-section"
            >
              <div class="sect-head ext-head">
                <button class="sect-toggle-btn" @click="toggleSection(extId)">
                  <Icon name="chevron_right" :size="13" :class="['sect-chevron', { open: isOpen(extId) }]" />
                </button>
                <span class="flex-1">{{ EXT_LABELS[extId] ?? extId }}</span>
                <button
                  class="ext-remove"
                  :title="`Remove ${EXT_LABELS[extId] ?? extId}`"
                  @click="removeExtension(extId)"
                >×</button>
              </div>

              <div v-if="isOpen(extId)" class="sect-body">

                <!-- Clear Coat -->
                <template v-if="extId === 'clearCoat'">
                  <ParamSlider
                    label="Factor" :min="0" :max="1" :step="0.01"
                    :model-value="parameters.clearCoatFactor"
                    @update:model-value="(v) => onParamChange({ key: 'clearCoatFactor', value: v })"
                  />
                  <ParamSlider
                    label="Roughness" :min="0" :max="1" :step="0.01"
                    :model-value="parameters.clearCoatRoughness"
                    @update:model-value="(v) => onParamChange({ key: 'clearCoatRoughness', value: v })"
                  />
                </template>

                <!-- Transmission -->
                <template v-else-if="extId === 'transmission'">
                  <ParamSlider
                    label="Factor" :min="0" :max="1" :step="0.01"
                    :model-value="parameters.transmissionFactor"
                    @update:model-value="(v) => onParamChange({ key: 'transmissionFactor', value: v })"
                  />
                </template>

                <!-- Index of Refraction -->
                <template v-else-if="extId === 'ior'">
                  <ParamSlider
                    label="IOR" :min="1" :max="2.5" :step="0.01"
                    :model-value="parameters.ior"
                    @update:model-value="(v) => onParamChange({ key: 'ior', value: v })"
                  />
                </template>

                <!-- Specular -->
                <template v-else-if="extId === 'specular'">
                  <ParamSlider
                    label="Factor" :min="0" :max="1" :step="0.01"
                    :model-value="parameters.specularFactor"
                    @update:model-value="(v) => onParamChange({ key: 'specularFactor', value: v })"
                  />
                  <ParamColor
                    label="Color"
                    :model-value="parameters.specularColor"
                    @update:model-value="(v) => onParamChange({ key: 'specularColor', value: v })"
                  />
                </template>

                <!-- Sheen -->
                <template v-else-if="extId === 'sheen'">
                  <ParamColor
                    label="Color"
                    :model-value="parameters.sheenColor"
                    @update:model-value="(v) => onParamChange({ key: 'sheenColor', value: v })"
                  />
                  <ParamSlider
                    label="Roughness" :min="0" :max="1" :step="0.01"
                    :model-value="parameters.sheenRoughness"
                    @update:model-value="(v) => onParamChange({ key: 'sheenRoughness', value: v })"
                  />
                </template>

                <!-- Volume -->
                <template v-else-if="extId === 'volume'">
                  <ParamSlider
                    label="Thickness Factor" :min="0" :max="10" :step="0.1"
                    :model-value="parameters.volumeThicknessFactor"
                    @update:model-value="(v) => onParamChange({ key: 'volumeThicknessFactor', value: v })"
                  />
                  <label class="prop-field">
                    <span class="prop-label">Attenuation Distance</span>
                    <input
                      class="prop-number"
                      type="number" min="0" step="1"
                      :value="parameters.volumeAttenuationDistance"
                      @change="onParamChange({ key: 'volumeAttenuationDistance', value: Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 1000) })"
                    />
                  </label>
                  <ParamColor
                    label="Attenuation Color"
                    :model-value="parameters.volumeAttenuationColor"
                    @update:model-value="(v) => onParamChange({ key: 'volumeAttenuationColor', value: v })"
                  />
                </template>

                <!-- Anisotropy -->
                <template v-else-if="extId === 'anisotropy'">
                  <ParamSlider
                    label="Strength" :min="0" :max="1" :step="0.01"
                    :model-value="parameters.anisotropyStrength"
                    @update:model-value="(v) => onParamChange({ key: 'anisotropyStrength', value: v })"
                  />
                  <ParamSlider
                    label="Rotation (rad)" :min="0" :max="6.2832" :step="0.01"
                    :model-value="parameters.anisotropyRotation"
                    @update:model-value="(v) => onParamChange({ key: 'anisotropyRotation', value: v })"
                  />
                </template>

                <!-- Iridescence -->
                <template v-else-if="extId === 'iridescence'">
                  <ParamSlider
                    label="Factor" :min="0" :max="1" :step="0.01"
                    :model-value="parameters.iridescenceFactor"
                    @update:model-value="(v) => onParamChange({ key: 'iridescenceFactor', value: v })"
                  />
                  <ParamSlider
                    label="IOR" :min="1" :max="2.5" :step="0.01"
                    :model-value="parameters.iridescenceIor"
                    @update:model-value="(v) => onParamChange({ key: 'iridescenceIor', value: v })"
                  />
                  <div class="sect-grid-2">
                    <label class="prop-field">
                      <span class="prop-label">Thickness Min</span>
                      <input
                        class="prop-number"
                        type="number" min="0" step="10"
                        :value="parameters.iridescenceThicknessMin"
                        @change="onParamChange({ key: 'iridescenceThicknessMin', value: Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 0) })"
                      />
                    </label>
                    <label class="prop-field">
                      <span class="prop-label">Thickness Max</span>
                      <input
                        class="prop-number"
                        type="number" min="0" step="10"
                        :value="parameters.iridescenceThicknessMax"
                        @change="onParamChange({ key: 'iridescenceThicknessMax', value: Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 0) })"
                      />
                    </label>
                  </div>
                </template>

                <!-- Emissive Strength -->
                <template v-else-if="extId === 'emissiveStrength'">
                  <label class="prop-field">
                    <span class="prop-label">Strength</span>
                    <input
                      class="prop-number"
                      type="number" min="0" step="0.1"
                      :value="parameters.emissiveStrength"
                      @change="onParamChange({ key: 'emissiveStrength', value: Math.max(0, parseFloat(($event.target as HTMLInputElement).value) || 1) })"
                    />
                  </label>
                </template>

                <!-- Dispersion -->
                <template v-else-if="extId === 'dispersion'">
                  <ParamSlider
                    label="Factor" :min="0" :max="1" :step="0.01"
                    :model-value="parameters.dispersionFactor"
                    @update:model-value="(v) => onParamChange({ key: 'dispersionFactor', value: v })"
                  />
                </template>

                <!-- Unlit -->
                <template v-else-if="extId === 'unlit'">
                  <label class="prop-toggle">
                    <input
                      type="checkbox"
                      :checked="parameters.unlit"
                      @change="onParamChange({ key: 'unlit', value: ($event.target as HTMLInputElement).checked })"
                    />
                    Unlit (disable lighting calculations)
                  </label>
                </template>

              </div>
            </div>

            <!-- ── EXTENSIONS add row ────────────────────────────────────── -->
            <div class="prop-section extensions-bar">
              <select class="ext-add-select" @change="onAddExtension">
                <option value="">Add extension…</option>
                <option
                  v-for="ext in availableExtensions"
                  :key="ext.id"
                  :value="ext.id"
                >{{ ext.label }}</option>
              </select>
            </div>

          </div><!-- .properties -->
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
  display: grid;
  grid-template-columns: 6fr 4fr;
  gap: 16px;
}
.graph-pane { min-height: 0; min-width: 0; }
.side-pane {
  display: flex; flex-direction: column; gap: 12px;
  min-height: 0; overflow: auto;
}
.viewer-pane { flex: 0 0 auto; min-height: 280px; }
.meta { display: flex; flex-direction: column; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field textarea { resize: vertical; font-family: inherit; }
.small { font-size: 12px; }
.meta-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }

/* ── Properties panel ─────────────────────────────────────────────────── */
.properties {
  padding: 0;
  overflow: hidden;
  flex: 0 0 auto;
}

.prop-section {
  border-bottom: 1px solid var(--color-border);
}
.prop-section:last-child { border-bottom: none; }

.sect-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  border-radius: 0;
}
.sect-head:hover {
  color: var(--color-text);
  background: var(--color-bg-hover);
}
.sect-chevron {
  flex: none;
  color: var(--color-text-subtle);
  transition: transform 0.15s;
}
.sect-chevron.open { transform: rotate(90deg); }

.sect-body {
  padding: 10px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--color-bg-input);
}
.sect-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}

/* prop-field: a labelled row (for selects + number inputs) */
.prop-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.prop-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text);
}
.prop-select {
  width: 100%;
  padding: 5px 8px;
  font-size: 12px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  cursor: pointer;
}
.prop-number {
  width: 100%;
  padding: 4px 8px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.prop-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-muted);
  cursor: pointer;
}
.prop-toggle input { width: 14px; height: 14px; cursor: pointer; }

/* Extension sections */
.ext-section .sect-head { cursor: default; }
.ext-head {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0;
}
.sect-toggle-btn {
  display: flex;
  align-items: center;
  padding: 8px 4px 8px 12px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  border-radius: 0;
}
.sect-toggle-btn:hover { color: var(--color-text); }
.ext-head .flex-1 {
  flex: 1;
  padding: 8px 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  pointer-events: none;
  user-select: none;
}
.ext-remove {
  padding: 8px 12px;
  font-size: 14px;
  line-height: 1;
  font-weight: 400;
  background: transparent;
  border: none;
  color: var(--color-text-subtle);
  cursor: pointer;
  border-radius: 0;
}
.ext-remove:hover { color: var(--color-error); background: transparent; border-color: transparent; }

/* Extensions add row */
.extensions-bar {
  border-bottom: none;
  padding: 8px 12px;
}
.ext-add-select {
  width: 100%;
  padding: 6px 10px;
  font-size: 12px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
}
.ext-add-select:hover { border-color: var(--orbit-primary); color: var(--color-text); }

@media (max-width: 1100px) {
  .body { grid-template-columns: 1fr; }
  .editor { height: auto; }
  .graph-pane { min-height: 480px; }
}
</style>
