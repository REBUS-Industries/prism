<script setup lang="ts">
import { computed, ref } from 'vue';
import ParamSlider from './ParamSlider.vue';
import { fixturesApi, type FixtureModel, type FixturePart } from '../../shared/api';
import {
  buildTransform4x4,
  ensureTransform,
  metresToMm,
  mmToMetres,
  readMeshOffset,
  writeMeshOffset,
  type MeshOffset,
} from '../utils/fixtureTransform';
import { isCustomReplacedModel } from '../utils/fixtureCustomMesh';
import { getModelMediaId } from '../utils/fixtureAssembly';
import { box3FromGdtfBounds, readGdtfBounds } from '../utils/fixtureGdtfBounds';
import { readFlipNormals, writeFlipNormals } from '../utils/fixtureFlipNormals';
import { loadModelBoundsFromUrl } from '../utils/fixtureModelBounds';
import {
  alignOffset,
  DEFAULT_BBOX_ANCHORS,
  type BboxAnchor,
  type BboxAnchors,
} from '../utils/fixtureMeshAlign';

const props = defineProps<{
  part: FixturePart | null;
  models: FixtureModel[];
  fixtureId?: string;
}>();

const emit = defineEmits<{
  change: [];
}>();

const bboxAnchors = ref<BboxAnchors>({ ...DEFAULT_BBOX_ANCHORS });
const aligning = ref(false);
const alignError = ref<string | null>(null);

const ANCHOR_OPTIONS: { value: BboxAnchor; label: string }[] = [
  { value: 'min', label: 'Min' },
  { value: 'center', label: 'Center' },
  { value: 'max', label: 'Max' },
];

const geometryType = computed(() => {
  if (!props.part) return '—';
  const meta = props.part.metadata as { geometryType?: string; geometryNodeType?: string };
  return meta.geometryType ?? meta.geometryNodeType ?? props.part.tag;
});

const linkedModel = computed(() => {
  if (!props.part?.modelId) return null;
  return props.models.find((m) => m.modelId === props.part!.modelId) ?? null;
});

const isCustomMesh = computed(() => isCustomReplacedModel(linkedModel.value));

const hasGdtfBounds = computed(() =>
  !!readGdtfBounds((linkedModel.value?.metadata ?? {}) as Record<string, unknown>),
);

const hasModelMesh = computed(() => !!getModelMediaId(linkedModel.value ?? undefined));

const flipNormals = computed(() =>
  readFlipNormals((linkedModel.value?.metadata ?? {}) as Record<string, unknown>),
);

const modelOptions = computed(() =>
  props.models.map((m) => ({
    id: m.modelId,
    label: m.sourceGdtfModel ?? m.modelId,
  })),
);

function notify(): void {
  emit('change');
}

function updateName(ev: Event): void {
  if (!props.part) return;
  props.part.name = (ev.target as HTMLInputElement).value;
  notify();
}

function posMm(axis: 'x' | 'y' | 'z', mm: number): void {
  if (!props.part) return;
  const t = ensureTransform(props.part.localTransform);
  t.position[axis] = mmToMetres(mm);
  props.part.localTransform = buildTransform4x4(t.position, t.rotation, t.scale);
  notify();
}

function rotDeg(axis: 'x' | 'y' | 'z', deg: number): void {
  if (!props.part) return;
  const t = ensureTransform(props.part.localTransform);
  t.rotation[axis] = deg;
  props.part.localTransform = buildTransform4x4(t.position, t.rotation, t.scale);
  notify();
}

function posMmValue(axis: 'x' | 'y' | 'z'): number {
  const t = ensureTransform(props.part?.localTransform);
  return metresToMm(t.position[axis]);
}

function rotDegValue(axis: 'x' | 'y' | 'z'): number {
  const t = ensureTransform(props.part?.localTransform);
  return t.rotation[axis];
}

function dimMm(axis: 'length' | 'width' | 'height'): number {
  const meta = (linkedModel.value?.metadata ?? {}) as Record<string, unknown>;
  const m = typeof meta[axis] === 'number' ? (meta[axis] as number) : 0;
  return metresToMm(m);
}

function setDimMm(axis: 'length' | 'width' | 'height', mm: number): void {
  const model = linkedModel.value;
  if (!model) return;
  if (!model.metadata || typeof model.metadata !== 'object') model.metadata = {};
  (model.metadata as Record<string, unknown>)[axis] = mmToMetres(Math.max(0, mm));
  notify();
}

const ZERO_MESH_OFFSET: MeshOffset = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
};

const hasMeshOffset = computed(() =>
  !!readMeshOffset((linkedModel.value?.metadata ?? {}) as Record<string, unknown>),
);

function currentMeshOffset(): MeshOffset {
  const stored = readMeshOffset((linkedModel.value?.metadata ?? {}) as Record<string, unknown>);
  return stored
    ? { position: { ...stored.position }, rotation: { ...stored.rotation } }
    : { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
}

function commitMeshOffset(offset: MeshOffset): void {
  const model = linkedModel.value;
  if (!model) return;
  if (!model.metadata || typeof model.metadata !== 'object') model.metadata = {};
  const toWrite = isCustomReplacedModel(model)
    ? { position: { ...offset.position }, rotation: { x: 0, y: 0, z: 0 } }
    : offset;
  writeMeshOffset(model.metadata as Record<string, unknown>, toWrite);
  notify();
}

function meshOffsetPosMmValue(axis: 'x' | 'y' | 'z'): number {
  return metresToMm(currentMeshOffset().position[axis]);
}

function meshOffsetRotDegValue(axis: 'x' | 'y' | 'z'): number {
  return currentMeshOffset().rotation[axis];
}

function setMeshOffsetPos(axis: 'x' | 'y' | 'z', mm: number): void {
  const offset = currentMeshOffset();
  offset.position[axis] = mmToMetres(mm);
  commitMeshOffset(offset);
}

function setMeshOffsetRot(axis: 'x' | 'y' | 'z', deg: number): void {
  const offset = currentMeshOffset();
  offset.rotation[axis] = deg;
  commitMeshOffset(offset);
}

function resetMeshOffset(): void {
  commitMeshOffset({ ...ZERO_MESH_OFFSET, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } });
}

function setFlipNormals(enabled: boolean): void {
  const model = linkedModel.value;
  if (!model) return;
  if (!model.metadata || typeof model.metadata !== 'object') model.metadata = {};
  writeFlipNormals(model.metadata as Record<string, unknown>, enabled);
  notify();
}

async function alignToGdtfBounds(): Promise<void> {
  const model = linkedModel.value;
  const fixtureId = props.fixtureId;
  if (!model || !fixtureId) return;

  const gdtfBounds = readGdtfBounds(model.metadata as Record<string, unknown>);
  if (!gdtfBounds) {
    alignError.value = 'No GDTF reference bounds stored for this model.';
    return;
  }

  const mediaId = getModelMediaId(model);
  if (!mediaId) {
    alignError.value = 'Custom mesh media is missing.';
    return;
  }

  aligning.value = true;
  alignError.value = null;
  try {
    const customBox = await loadModelBoundsFromUrl(
      fixturesApi.mediaUrl(fixtureId, mediaId),
      model,
      true,
    );
    if (!customBox || customBox.isEmpty()) {
      alignError.value = 'Could not measure the custom mesh bounds.';
      return;
    }
    const gdtfBox = box3FromGdtfBounds(gdtfBounds);
    const position = alignOffset(gdtfBox, customBox, bboxAnchors.value);
    commitMeshOffset({ position, rotation: { x: 0, y: 0, z: 0 } });
  } catch {
    alignError.value = 'Failed to align mesh to GDTF bounds.';
  } finally {
    aligning.value = false;
  }
}

function onModelChange(ev: Event): void {
  if (!props.part) return;
  const nextId = (ev.target as HTMLSelectElement).value || null;
  const prevId = props.part.modelId ?? null;

  if (prevId) {
    const prev = props.models.find((m) => m.modelId === prevId);
    if (prev) {
      prev.assignedPartIds = prev.assignedPartIds.filter((id) => id !== props.part!.partId);
    }
  }

  props.part.modelId = nextId;

  if (nextId) {
    const next = props.models.find((m) => m.modelId === nextId);
    if (next && !next.assignedPartIds.includes(props.part.partId)) {
      next.assignedPartIds.push(props.part.partId);
    }
  }

  notify();
}
</script>

<template>
  <div v-if="!part" class="props-empty muted">Select a geometry node to edit its properties.</div>

  <div v-else class="part-props">
    <header class="props-head">
      <h3>Properties</h3>
      <span class="pill tag">{{ part.tag }}</span>
    </header>

    <label class="field">
      <span class="field-label">Name</span>
      <input class="field-input" type="text" :value="part.name" @change="updateName" />
    </label>

    <fieldset class="field-group">
      <legend>Position <span class="unit">mm</span></legend>
      <ParamSlider
        label="X"
        :min="-5000"
        :max="5000"
        :step="1"
        :model-value="posMmValue('x')"
        @update:model-value="posMm('x', $event)"
      />
      <ParamSlider
        label="Y"
        :min="-5000"
        :max="5000"
        :step="1"
        :model-value="posMmValue('y')"
        @update:model-value="posMm('y', $event)"
      />
      <ParamSlider
        label="Z"
        :min="-5000"
        :max="5000"
        :step="1"
        :model-value="posMmValue('z')"
        @update:model-value="posMm('z', $event)"
      />
    </fieldset>

    <fieldset class="field-group">
      <legend>Rotation <span class="unit">°</span></legend>
      <ParamSlider
        label="X"
        :min="-360"
        :max="360"
        :step="0.1"
        :model-value="rotDegValue('x')"
        @update:model-value="rotDeg('x', $event)"
      />
      <ParamSlider
        label="Y"
        :min="-360"
        :max="360"
        :step="0.1"
        :model-value="rotDegValue('y')"
        @update:model-value="rotDeg('y', $event)"
      />
      <ParamSlider
        label="Z"
        :min="-360"
        :max="360"
        :step="0.1"
        :model-value="rotDegValue('z')"
        @update:model-value="rotDeg('z', $event)"
      />
    </fieldset>

    <label class="field">
      <span class="field-label">Geometry type</span>
      <input class="field-input readonly" type="text" :value="geometryType" readonly />
    </label>

    <label class="field">
      <span class="field-label">Linked model</span>
      <select class="field-input" :value="part.modelId ?? ''" @change="onModelChange">
        <option value="">— None —</option>
        <option v-for="opt in modelOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
      </select>
    </label>

    <label v-if="linkedModel && hasModelMesh" class="field flip-normals-field">
      <span class="field-label">Flip normals</span>
      <div class="flip-row">
        <input
          type="checkbox"
          :checked="flipNormals"
          @change="setFlipNormals(($event.target as HTMLInputElement).checked)"
        />
        <span class="muted small flip-hint">
          Reverses face winding (Rhino <em>Flip</em>) so materials render on the correct side in Orbit / Rhino. Republish to apply.
        </span>
      </div>
    </label>

    <fieldset v-if="linkedModel && !isCustomMesh" class="field-group">
      <legend>Model dimensions <span class="unit">mm</span></legend>
      <ParamSlider
        label="Length"
        :min="0"
        :max="5000"
        :step="1"
        :model-value="dimMm('length')"
        @update:model-value="setDimMm('length', $event)"
      />
      <ParamSlider
        label="Width"
        :min="0"
        :max="5000"
        :step="1"
        :model-value="dimMm('width')"
        @update:model-value="setDimMm('width', $event)"
      />
      <ParamSlider
        label="Height"
        :min="0"
        :max="5000"
        :step="1"
        :model-value="dimMm('height')"
        @update:model-value="setDimMm('height', $event)"
      />
    </fieldset>

    <p v-else-if="linkedModel && isCustomMesh" class="muted small dims-hint">
      Custom mesh — placed at its file origin by default (pivot and datums unchanged).
      The green wireframe shows the original GDTF bounds. Use mesh offset or Align below to nudge.
    </p>
    <p v-else class="muted small dims-hint">Link a model to edit Length / Width / Height.</p>

    <fieldset v-if="linkedModel" class="field-group">
      <legend class="offset-legend">
        <span>Mesh offset <span class="unit">{{ isCustomMesh ? 'mm' : 'mm / °' }}</span></span>
        <button v-if="hasMeshOffset" type="button" class="reset-btn" @click="resetMeshOffset">Reset</button>
      </legend>
      <p class="muted small offset-hint">
        <template v-if="isCustomMesh">
          Aligns the custom mesh inside the part frame without moving the part position or pan/tilt pivot.
          Only translation is applied — the mesh is not scaled or rotated.
        </template>
        <template v-else>
          Aligns a custom / imported mesh to the part origin without moving the part
          position or pan/tilt pivot. Applied in the published Orbit mesh too.
        </template>
      </p>

      <div v-if="isCustomMesh && hasGdtfBounds" class="align-assist">
        <p class="muted small align-hint">
          Best-fit assist — verify on asymmetric meshes. Export with the file origin at the GDTF mount point for exact placement without offset.
        </p>
        <div class="anchor-row">
          <label v-for="axis in (['x', 'y', 'z'] as const)" :key="axis" class="anchor-field">
            <span>{{ axis.toUpperCase() }}</span>
            <select v-model="bboxAnchors[axis]" class="field-input anchor-select">
              <option v-for="opt in ANCHOR_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          class="align-btn"
          :disabled="aligning"
          @click="alignToGdtfBounds"
        >
          {{ aligning ? 'Aligning…' : 'Align to GDTF bounds (best fit)' }}
        </button>
        <p v-if="alignError" class="align-error">{{ alignError }}</p>
      </div>

      <div class="offset-sub">Translation</div>
      <ParamSlider
        label="X"
        :min="-2000"
        :max="2000"
        :step="1"
        :model-value="meshOffsetPosMmValue('x')"
        @update:model-value="setMeshOffsetPos('x', $event)"
      />
      <ParamSlider
        label="Y"
        :min="-2000"
        :max="2000"
        :step="1"
        :model-value="meshOffsetPosMmValue('y')"
        @update:model-value="setMeshOffsetPos('y', $event)"
      />
      <ParamSlider
        label="Z"
        :min="-2000"
        :max="2000"
        :step="1"
        :model-value="meshOffsetPosMmValue('z')"
        @update:model-value="setMeshOffsetPos('z', $event)"
      />
      <template v-if="!isCustomMesh">
      <div class="offset-sub">Rotation</div>
      <ParamSlider
        label="X"
        :min="-180"
        :max="180"
        :step="0.5"
        :model-value="meshOffsetRotDegValue('x')"
        @update:model-value="setMeshOffsetRot('x', $event)"
      />
      <ParamSlider
        label="Y"
        :min="-180"
        :max="180"
        :step="0.5"
        :model-value="meshOffsetRotDegValue('y')"
        @update:model-value="setMeshOffsetRot('y', $event)"
      />
      <ParamSlider
        label="Z"
        :min="-180"
        :max="180"
        :step="0.5"
        :model-value="meshOffsetRotDegValue('z')"
        @update:model-value="setMeshOffsetRot('z', $event)"
      />
      </template>
    </fieldset>
  </div>
</template>

<style scoped>
.props-empty {
  padding: 12px 0;
  font-size: 13px;
}
.part-props {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.props-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.props-head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
}
.pill.tag {
  font-size: 10px;
  text-transform: uppercase;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text);
}
.field-input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-input);
  font-size: 12px;
}
.field-input.readonly {
  color: var(--color-text-muted);
  background: var(--color-bg-hover);
}
.flip-normals-field {
  gap: 6px;
}
.flip-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.flip-row input[type="checkbox"] {
  margin-top: 2px;
  flex-shrink: 0;
}
.flip-hint {
  line-height: 1.4;
}
.field-group {
  border: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.field-group legend {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  margin-bottom: 4px;
}
.unit {
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  color: var(--color-text-subtle);
}
.dims-hint { margin: 0; }
.small { font-size: 11px; }
.offset-legend {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
}
.offset-hint { margin: 0 0 4px; }
.align-assist {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
  padding: 8px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--surface-1, rgba(0, 0, 0, 0.03));
}
.align-hint { margin: 0; line-height: 1.4; }
.anchor-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.anchor-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--color-text-subtle);
}
.anchor-select {
  font-size: 11px;
  padding: 4px 6px;
}
.align-btn {
  align-self: flex-start;
  font-size: 11px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--surface-2, #fff);
  cursor: pointer;
}
.align-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.align-error {
  margin: 0;
  font-size: 11px;
  color: var(--color-danger, #c0392b);
}
.offset-sub {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-subtle);
  margin-top: 4px;
}
.reset-btn {
  font-size: 10px;
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-input);
  cursor: pointer;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
}
.reset-btn:hover { background: var(--color-bg-hover); }
</style>
