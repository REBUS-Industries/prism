<script setup lang="ts">

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { RouterLink, useRoute, useRouter } from 'vue-router';

import FixtureQuadPreview from '../components/FixtureQuadPreview.vue';

import FixturePartTree from '../components/FixturePartTree.vue';

import FixturePartProperties from '../components/FixturePartProperties.vue';

import FixtureViewer, { type PartTransformEdit } from '../components/FixtureViewer.vue';

import FixtureConstructionGraph from '../components/FixtureConstructionGraph.vue';

import FixtureGdtfDebugPanel from '../components/FixtureGdtfDebugPanel.vue';

import { buildTransform4x4 } from '../utils/fixtureTransform';

import { isCustomReplacedModel } from '../utils/fixtureCustomMesh';

import { getModelMediaId } from '../utils/fixtureAssembly';

import {
  gdtfBoundsFromBox3,
  readGdtfBounds,
  writeGdtfBounds,
  type GdtfReferenceBounds,
} from '../utils/fixtureGdtfBounds';

import { loadModelBoundsFromUrl } from '../utils/fixtureModelBounds';

import { fixtureLabel } from '../utils/fixtureLabel';

import DmxModePanel from '../components/DmxModePanel.vue';

import IesUploader from '../components/IesUploader.vue';
import { iesProfileCount, beamDisplayLabel } from '../utils/fixtureIes';

import DatumEditor from '../components/DatumEditor.vue';

import FixtureModelQualitySelect from '../components/FixtureModelQualitySelect.vue';

import Icon from '../../shared/Icon.vue';

import {
  DEFAULT_GDTF_MODEL_QUALITY,
  GDTF_MODEL_QUALITY_LABELS,
  availableModelQualitiesFromDefinition,
  availableModelFormatsFromDefinition,
  coerceModelQuality,
  modelQualityFromDefinition,
  type GdtfModelQuality,
} from '../utils/fixtureModelQuality';

import {
  computeMeshOrigins,
  meshOriginsToCsv,
  downloadTextFile,
} from '../utils/fixtureOrigins';

import { fixtureZOffsetM, readClampModelLibraryId, readClampPlacement, REBUS_CLAMP_MODEL_ID } from '../utils/fixturePlacement';
import { isModelLengthUnit, type ModelLengthUnit } from '../utils/modelUnits';

import { fixtureInformationParams } from '../utils/fixtureInformation';

import {

  fixturesApi,

  materialsApi,

  modelsApi,

  type ApiError,

  type FixtureDetail,

  type FixtureModel,

  type FixtureOrbitRef,

  type FixtureOrbitPublishTemplate,

  type FixturePart,

  type FixtureUpdateCheck,

  type FixtureVersionSummary,

  type ModelListItem,

  type ModelMaterialSlot,

  type ModelTransform,

  type Vec3,

} from '../../shared/api';



const props = defineProps<{ id: string }>();

const PARTS_PROPS_WIDTH_KEY = 'prism-fixture-editor-parts-props-width';
const PARTS_PROPS_WIDTH_MIN = 240;
const PARTS_VIEWPORT_MIN = 320;
const PARTS_PROPS_WIDTH_DEFAULT = 280;

const router = useRouter();
const route = useRoute();



const fixture = ref<FixtureDetail | null>(null);

const loading = ref(true);

const error = ref<string | null>(null);

const saving = ref(false);

const publishingOrbit = ref(false);

const publishOrbitError = ref<string | null>(null);

const iesOrbitMessage = ref<string | null>(null);

const orbitUnitNumber = ref('');

const orbitPatchUniverse = ref<number | ''>('');

const orbitPatchAddress = ref<number | ''>('');

const selectedPartId = ref<string | null>(null);

const assemblyRevision = ref(0);

const gizmoMode = ref<'translate' | 'rotate' | 'scale'>('translate');

const gizmoSpace = ref<'world' | 'local'>('local');

type EditorTab = 'overview' | 'dmx' | 'parts' | 'construction' | 'control' | 'ies' | 'settings';

const activeTab = ref<EditorTab>('overview');

function selectTab(tab: EditorTab): void {
  activeTab.value = tab;
  if (tab === 'control') {
    router.replace({ query: { ...route.query, tab: 'control' } });
  } else if (route.query.tab === 'control' || route.query.tab === 'debug') {
    const { tab: _tab, ...rest } = route.query;
    router.replace({ query: rest });
  }
}

watch(() => route.query.tab, (tab) => {
  if (tab === 'control' || tab === 'debug') activeTab.value = 'control';
}, { immediate: true });



const name = ref('');

const displayName = ref('');

const manufacturer = ref('');

const fixtureName = ref('');

const revision = ref('');

const tags = ref('');

const status = ref('draft');

const updateCheck = ref<FixtureUpdateCheck | null>(null);

const checkingUpdates = ref(false);

const applyingUpdate = ref(false);

const switchingVersion = ref(false);

const carryReport = ref<string[]>([]);

const modelQuality = ref<GdtfModelQuality>(DEFAULT_GDTF_MODEL_QUALITY);

const reimportingMeshes = ref(false);
const resettingToGdtf = ref(false);

const availableModelQualities = computed(() =>
  availableModelQualitiesFromDefinition(fixture.value?.definition.metadata),
);

const availableModelFormats = computed(() =>
  availableModelFormatsFromDefinition(fixture.value?.definition.metadata),
);

// A quality choice only exists when the GDTF ships more than one mesh LOD.
const canChooseModelQuality = computed(() => (availableModelQualities.value?.length ?? 0) > 1);



const previewUrl = computed(() =>

  fixture.value?.hasPreview ? fixturesApi.previewUrl(fixture.value.id) : null,

);

interface EditorDmxMode { modeId: string; name: string; geometry?: string }

const dmxModes = computed<EditorDmxMode[]>(() => {
  const raw = (fixture.value?.definition?.dmxMapping as { modes?: unknown })?.modes;
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>).map((m) => ({
    modeId: String(m.modeId ?? m.name ?? ''),
    name: String(m.name ?? m.modeId ?? 'Mode'),
    geometry: typeof m.geometry === 'string' ? m.geometry : undefined,
  }));
});

// Top-level geometries referenced by the modes — only filter when modes
// actually map to distinct root geometries (multi-mode fixtures like JDC1).
const hasModeGeometries = computed(() =>
  new Set(dmxModes.value.map((m) => m.geometry).filter(Boolean)).size > 1,
);

const selectedModeId = ref<string | null>(null);

const selectedModeGeometryId = computed<string | null>(() => {
  if (!hasModeGeometries.value) return null;
  const mode = dmxModes.value.find((m) => m.modeId === selectedModeId.value) ?? dmxModes.value[0];
  return mode?.geometry ?? null;
});

watch(dmxModes, (modes) => {
  if (!modes.some((m) => m.modeId === selectedModeId.value)) {
    selectedModeId.value = modes[0]?.modeId ?? null;
  }
}, { immediate: true });

const assembly = computed(() => {
  const def = fixture.value?.definition;
  const id = fixture.value?.id;
  if (!def || !id || !def.parts?.length) return null;
  return {
    fixtureId: id,
    parts: def.parts,
    models: def.models ?? [],
    motionAxes: def.motionRig ?? [],
    selectedModeGeometryId: selectedModeGeometryId.value,
    fixtureZOffsetM: fixtureZOffsetMm.value / 1000,
    clampPlacement: {
      mirrorZ: clampMirrorZ.value,
      rotateZDeg: clampRotateZDeg.value,
    },
    clampModelUrl: clampModelLibraryId.value ? modelsApi.previewUrl(clampModelLibraryId.value) : undefined,
    clampMaterialSlots: clampMaterialSlots.value.length ? clampMaterialSlots.value : undefined,
    clampModelTransform: clampModelLibraryId.value ? clampModelTransform.value ?? undefined : undefined,
    clampSourceUnits: clampModelLibraryId.value ? clampSourceUnits.value ?? undefined : undefined,
  };
});



const info = computed(() => fixture.value?.definition.fixtureInformation);

const canCheckGdtfUpdates = computed(() =>
  !!fixture.value?.gdtfShareUuid && fixture.value.importSource !== 'duplicate',
);

const showDuplicateBanner = computed(() => route.query.from === 'duplicate');

const fixtureInfoRows = computed(() => {
  const def = fixture.value?.definition;
  if (!def) return [];
  return fixtureInformationParams(def.fixtureInformation, def.parts, def.models);
});

const storedVersions = computed(() => fixture.value?.versions ?? []);

const activeStoredVersion = computed(() =>
  storedVersions.value.find((v) => v.isActive) ?? fixture.value?.activeVersion ?? null,
);

const provenanceLine = computed(() => {
  const v = activeStoredVersion.value;
  if (!v) return null;
  return `Downloaded ${formatEditorDate(v.downloadedAt)}${v.revision ? ` · ${v.revision}` : ''}`;
});

function formatEditorDate(ts?: string): string {
  if (!ts) return '—';
  const n = parseInt(ts, 10);
  if (n > 1_000_000_000_000) return new Date(n).toLocaleString();
  if (n > 1_000_000_000) return new Date(n * 1000).toLocaleString();
  return ts;
}

function formatStoredVersionLabel(v: FixtureVersionSummary): string {
  const parts = [
    v.revision,
    v.gdtfVersion ? `GDTF ${v.gdtfVersion}` : null,
    v.isActive ? '(active)' : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : `Hash ${v.gdtfHash.slice(0, 8)}`;
}

async function checkForUpdates(): Promise<void> {
  if (!canCheckGdtfUpdates.value) return;
  checkingUpdates.value = true;
  carryReport.value = [];
  try {
    const res = await fixturesApi.checkUpdates(props.id);
    updateCheck.value = res.check;
  } finally {
    checkingUpdates.value = false;
  }
}

async function applyLatestUpdate(): Promise<void> {
  if (!updateCheck.value?.latestRid) return;
  applyingUpdate.value = true;
  carryReport.value = [];
  try {
    const res = await fixturesApi.downloadVersion(props.id, updateCheck.value.latestRid, {
      carryEdits: true,
      modelQuality: modelQuality.value,
    });
    carryReport.value = [
      ...res.report.applied.map((a) => `Applied: ${a}`),
      ...res.report.unmapped.map((u) => `Unmapped: ${u}`),
    ];
    await reload();
    void checkForUpdates();
  } finally {
    applyingUpdate.value = false;
  }
}

async function runMeshReimport(quality: GdtfModelQuality): Promise<void> {
  if (!fixture.value) return;
  reimportingMeshes.value = true;
  error.value = null;
  try {
    const shareRid = activeStoredVersion.value?.gdtfShareRid;
    if (shareRid) {
      // GDTF-Share fixtures: re-download the active revision with the chosen mesh LOD.
      await fixturesApi.downloadVersion(props.id, shareRid, {
        carryEdits: true,
        modelQuality: quality,
      });
    } else {
      // Uploaded/manual fixtures: swap meshes from the stored local GDTF package.
      const res = await fixturesApi.reimportMeshes(props.id, quality);
      fixture.value = res.fixture;
    }
    assemblyRevision.value += 1;
    await reload();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'mesh reimport failed';
  } finally {
    reimportingMeshes.value = false;
  }
}

async function applyModelQuality(): Promise<void> {
  if (!fixture.value) return;
  const stored = modelQualityFromDefinition(fixture.value.definition.metadata);
  if (stored === modelQuality.value) return;
  await runMeshReimport(modelQuality.value);
}

// Re-run mesh conversion at the current quality without changing the LOD. Lets
// users refresh a fixture's 3D model after a pipeline fix (e.g. 3DS->GLB) even
// when the GDTF ships a single mesh and the quality picker is hidden.
async function reloadModelMeshes(): Promise<void> {
  await runMeshReimport(modelQuality.value);
}

async function resetToGdtf(): Promise<void> {
  if (!fixture.value) return;
  const label = fixtureLabel(fixture.value);
  const confirmed = window.confirm(
    `Reset "${label}" to the original GDTF data?\n\n`
    + 'This will permanently discard all local edits, including:\n'
    + '• Part position and rotation\n'
    + '• Custom mesh uploads and mesh offsets\n'
    + '• Materials, IES profiles, and placement settings\n'
    + '• Display name and other metadata changes\n\n'
    + 'This cannot be undone.',
  );
  if (!confirmed) return;

  resettingToGdtf.value = true;
  error.value = null;
  carryReport.value = [];
  try {
    await fixturesApi.resetToGdtf(props.id, { modelQuality: modelQuality.value });
    assemblyRevision.value += 1;
    await reload();
    void checkForUpdates();
  } catch (err) {
    const e = err as ApiError;
    if (e.status === 404) {
      error.value = 'Reset to GDTF is unavailable — deploy prism-fixtures-service with POST /api/fixtures/:id/reset-gdtf (see scaffold patch fixtures-reset-gdtf-custom-mesh.patch).';
    } else {
      error.value = e.message ?? 'Reset to GDTF failed';
    }
  } finally {
    resettingToGdtf.value = false;
  }
}

const meshOriginCount = computed(
  () => computeMeshOrigins(
    fixture.value?.definition.parts ?? [],
    fixture.value?.definition.models ?? [],
    fixtureZOffsetMm.value / 1000,
    fixture.value?.definition.metadata,
  ).length,
);

function downloadMeshOrigins(): void {
  const def = fixture.value?.definition;
  if (!def) return;
  const origins = computeMeshOrigins(
    def.parts ?? [],
    def.models ?? [],
    fixtureZOffsetMm.value / 1000,
    def.metadata,
  );
  if (!origins.length) return;
  const csv = meshOriginsToCsv(origins);
  const info = def.fixtureInformation;
  const slug = `${info.manufacturer ?? ''} ${info.fixtureName ?? 'fixture'}`
    .trim().replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'fixture';
  downloadTextFile(`${slug}-mesh-origins.csv`, csv);
}

const replacingModelId = ref<string | null>(null);
const meshUploadMessage = ref<string | null>(null);
const meshUploadTarget = ref<string | null>(null);

/** Filename of an uploaded custom mesh on a model (set by replaceFixtureModel), else null. */
function customMeshFilename(m: FixtureModel | undefined): string | null {
  const meta = m?.metadata as { replaced?: unknown; replacedFilename?: unknown } | undefined;
  if (!meta || meta.replaced !== true) return null;
  return typeof meta.replacedFilename === 'string' && meta.replacedFilename
    ? meta.replacedFilename
    : 'custom mesh';
}

const clampCustomMeshFilename = computed(() =>
  customMeshFilename(
    fixture.value?.definition.models?.find((m) => m.modelId === REBUS_CLAMP_MODEL_ID),
  ),
);

/** Millimetres to lower the fixture body (clamp stays at the hang point). */
const fixtureZOffsetMm = ref(0);
const clampMirrorZ = ref(false);
const clampRotateZDeg = ref(0);
const clampModelLibraryId = ref<string | null>(null);
const clampMaterialSlots = ref<ModelMaterialSlot[]>([]);
const clampModelTransform = ref<ModelTransform | null>(null);
const clampSourceUnits = ref<ModelLengthUnit | null>(null);
const clampLibraryModels = ref<ModelListItem[]>([]);
const clampLibraryLoading = ref(false);
const clampLibraryPreviewMissing = ref(false);
const clampLibraryShowingAll = ref(false);

function isClampLibraryModel(m: ModelListItem): boolean {
  if (m.category?.toLowerCase() === 'clamp') return true;
  return m.tags.some((t) => t.toLowerCase() === 'clamp');
}

function clampLibraryOptionLabel(m: ModelListItem): string {
  let label = m.name;
  if (m.status === 'draft') label += ' (draft)';
  if (clampLibraryShowingAll.value && m.category) label += ` [${m.category}]`;
  return label;
}

const clampHasUploadedMesh = computed(() => {
  const meta = fixture.value?.definition.models
    ?.find((m) => m.modelId === REBUS_CLAMP_MODEL_ID)?.metadata as { mediaId?: unknown } | undefined;
  return typeof meta?.mediaId === 'string' && meta.mediaId.length > 0;
});

const clampHasMesh = computed(() =>
  clampHasUploadedMesh.value || !!clampModelLibraryId.value,
);

const swapModels = computed(() =>
  (fixture.value?.definition.models ?? []).filter((m) => m.modelId !== REBUS_CLAMP_MODEL_ID),
);

function syncPlacementFromFixture(): void {
  const meta = fixture.value?.definition.metadata;
  fixtureZOffsetMm.value = Math.round(fixtureZOffsetM(meta) * 1000);
  const clamp = readClampPlacement(meta);
  clampMirrorZ.value = clamp.mirrorZ;
  clampRotateZDeg.value = clamp.rotateZDeg;
  clampModelLibraryId.value = readClampModelLibraryId(meta);
  void verifyClampLibraryPreview();
  void loadClampLibraryDefinition();
}

async function loadClampLibraryDefinition(): Promise<void> {
  const id = clampModelLibraryId.value;
  if (!id) {
    clampMaterialSlots.value = [];
    clampModelTransform.value = null;
    clampSourceUnits.value = null;
    return;
  }
  try {
    const res = await modelsApi.get(id);
    const def = res.model.definition;
    clampMaterialSlots.value = def?.materialSlots ?? [];
    clampModelTransform.value = def?.transform ?? null;
    const su = (def as { sourceUnits?: unknown } | undefined)?.sourceUnits;
    clampSourceUnits.value = isModelLengthUnit(su) ? su : null;
  } catch {
    clampMaterialSlots.value = [];
    clampModelTransform.value = null;
    clampSourceUnits.value = null;
  }
}

function applyPlacementToDefinition(): void {
  if (!fixture.value) return;
  const meta: Record<string, unknown> = {
    ...fixture.value.definition.metadata,
    fixtureZOffsetM: fixtureZOffsetMm.value / 1000,
    clampRotateZDeg: clampRotateZDeg.value,
  };
  if (clampMirrorZ.value) {
    meta.clampMirrorZ = true;
  } else {
    delete meta.clampMirrorZ;
  }
  delete meta.clampMirrorY;
  if (clampModelLibraryId.value) {
    meta.clampModelLibraryId = clampModelLibraryId.value;
  } else {
    delete meta.clampModelLibraryId;
  }
  fixture.value.definition.metadata = meta;
}

async function loadClampLibraryModels(): Promise<void> {
  clampLibraryLoading.value = true;
  try {
    const res = await modelsApi.list({ limit: 200 });
    const withPreview = res.models.filter((m) => m.hasPreview);
    const clampMatches = withPreview.filter(isClampLibraryModel);
    if (clampMatches.length > 0) {
      clampLibraryModels.value = clampMatches;
      clampLibraryShowingAll.value = false;
    } else {
      clampLibraryModels.value = withPreview;
      clampLibraryShowingAll.value = withPreview.length > 0;
    }
    const assignedId = clampModelLibraryId.value;
    if (assignedId && !clampLibraryModels.value.some((m) => m.id === assignedId)) {
      const assigned = res.models.find((m) => m.id === assignedId);
      if (assigned) clampLibraryModels.value = [assigned, ...clampLibraryModels.value];
    }
  } catch {
    clampLibraryModels.value = [];
    clampLibraryShowingAll.value = false;
  } finally {
    clampLibraryLoading.value = false;
  }
}

async function verifyClampLibraryPreview(): Promise<void> {
  const id = clampModelLibraryId.value;
  if (!id) {
    clampLibraryPreviewMissing.value = false;
    return;
  }
  try {
    const res = await modelsApi.get(id);
    clampLibraryPreviewMissing.value = !res.model.hasPreview;
  } catch {
    clampLibraryPreviewMissing.value = true;
  }
}

function onClampLibraryChange(): void {
  applyPlacementToDefinition();
  void verifyClampLibraryPreview();
  void loadClampLibraryDefinition();
  assemblyRevision.value += 1;
}

function clearClampLibrary(): void {
  clampModelLibraryId.value = null;
  onClampLibraryChange();
}

function onFixtureZOffsetChange(): void {
  applyPlacementToDefinition();
  assemblyRevision.value += 1;
}

function onClampPlacementChange(): void {
  applyPlacementToDefinition();
  assemblyRevision.value += 1;
}

watch(fixture, () => syncPlacementFromFixture(), { immediate: true });

async function replaceModel(modelId: string, ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  replacingModelId.value = modelId;
  error.value = null;
  meshUploadMessage.value = null;

  const modelBefore = fixture.value?.definition.models.find((m) => m.modelId === modelId);
  let capturedBounds: GdtfReferenceBounds | null = null;
  if (
    modelBefore
    && !readGdtfBounds(modelBefore.metadata as Record<string, unknown>)
    && !isCustomReplacedModel(modelBefore)
  ) {
    const mediaId = getModelMediaId(modelBefore);
    if (mediaId) {
      const box = await loadModelBoundsFromUrl(
        fixturesApi.mediaUrl(props.id, mediaId),
        modelBefore,
        false,
      );
      capturedBounds = box ? gdtfBoundsFromBox3(box) : null;
    }
  }

  try {
    await fixturesApi.replaceModel(props.id, modelId, file);
    await reload();

    const modelAfter = fixture.value?.definition.models.find((m) => m.modelId === modelId);
    if (modelAfter && capturedBounds) {
      if (!modelAfter.metadata || typeof modelAfter.metadata !== 'object') modelAfter.metadata = {};
      writeGdtfBounds(modelAfter.metadata as Record<string, unknown>, capturedBounds);
      await save();
    }

    assemblyRevision.value += 1;
    meshUploadTarget.value = modelId;
    meshUploadMessage.value = orbitFixtureRef.value
      ? `Uploaded ${file.name}. Mesh uses its file origin by default — adjust Mesh offset if needed, or use Align to GDTF bounds. Republish to Orbit to update the published mesh.`
      : `Uploaded ${file.name}. Mesh uses its file origin by default — adjust Mesh offset if needed, or use Align to GDTF bounds, then Publish to Orbit.`;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'model replace failed';
  } finally {
    replacingModelId.value = null;
    input.value = '';
  }
}

async function onSwitchStoredVersion(versionId: string): Promise<void> {
  switchingVersion.value = true;
  carryReport.value = [];
  try {
    const res = await fixturesApi.switchActiveVersion(props.id, versionId);
    fixture.value = res.fixture;
    const available = availableModelQualitiesFromDefinition(res.fixture.definition.metadata);
    modelQuality.value = coerceModelQuality(
      modelQualityFromDefinition(res.fixture.definition.metadata) ?? DEFAULT_GDTF_MODEL_QUALITY,
      available,
    );
    assemblyRevision.value += 1;
    carryReport.value = [
      ...res.report.applied.map((a) => `Applied: ${a}`),
      ...res.report.unmapped.map((u) => `Unmapped: ${u}`),
    ];
  } finally {
    switchingVersion.value = false;
  }
}



const badges = computed(() => {

  if (!fixture.value) return [];

  const def = fixture.value.definition;

  const has3d = fixture.value.hasPreview || def.parts.some((p) => p.modelId);

  const hasDmx = Array.isArray(def.dmxMapping?.modes) && (def.dmxMapping.modes as unknown[]).length > 0;

  const hasWheels = def.wheels.length > 0;

  return [

    { label: 'Full data', ok: true },

    { label: '3D', ok: has3d },

    { label: 'DMX', ok: hasDmx },

    { label: 'Wheels', ok: hasWheels },

  ];

});



const orbitFixtureRef = computed<FixtureOrbitRef | null>(() => {
  const raw = fixture.value?.definition?.metadata?.orbitFixtureRef;
  if (!raw || typeof raw !== 'object') return null;
  const bag = raw as Record<string, unknown>;
  const modelId = typeof bag.modelId === 'string' ? bag.modelId : '';
  if (!modelId) return null;
  return {
    target: bag.target === 'dev' ? 'dev' : 'prod',
    projectId: String(bag.projectId ?? ''),
    modelId,
    versionId: String(bag.versionId ?? ''),
    objectId: String(bag.objectId ?? ''),
    publishedAt: String(bag.publishedAt ?? ''),
    orbitUrl: typeof bag.orbitUrl === 'string' ? bag.orbitUrl : undefined,
  };
});

const orbitPublishBlockedReason = computed(() => {
  const def = fixture.value?.definition;
  if (!def) return 'fixture not loaded';
  if (!def.parts?.length) return 'fixture has no geometry parts';
  const info = def.fixtureInformation;
  if (!info?.manufacturer?.trim() || !info?.fixtureName?.trim()) {
    return 'manufacturer and fixture name are required';
  }
  return null;
});

const canPublishToOrbit = computed(() => !orbitPublishBlockedReason.value);



const selectedPart = computed<FixturePart | null>(() => {

  if (!fixture.value || !selectedPartId.value) return null;

  return fixture.value.definition.parts.find((p) => p.partId === selectedPartId.value) ?? null;

});

/** GDTF reference bounds for the selected part's custom mesh (viewer overlay). */
const selectedGdtfBounds = computed(() => {
  const part = selectedPart.value;
  if (!part?.modelId || !fixture.value) return null;
  const model = fixture.value.definition.models.find((m) => m.modelId === part.modelId);
  if (!model || !isCustomReplacedModel(model)) return null;
  return readGdtfBounds(model.metadata as Record<string, unknown>);
});



const datumMarkers = computed(() => {

  if (!fixture.value) return [];

  return fixture.value.definition.parts

    .filter((p) => p.pivot)

    .map((p) => ({

      id: p.partId,

      position: p.pivot!,

      color: p.partId === selectedPartId.value ? '#00ccff' : '#ff6600',

    }));

});



function syncIdentityFromFixture(): void {
  if (!fixture.value) return;
  displayName.value = fixture.value.displayName ?? '';
  manufacturer.value = fixture.value.manufacturer ?? info.value?.manufacturer ?? '';
  fixtureName.value = fixture.value.fixtureName ?? info.value?.fixtureName ?? '';
  revision.value = fixture.value.revision ?? info.value?.revision ?? '';
}

function applyIdentityToDefinition(): void {
  if (!fixture.value) return;
  const infoBlock = { ...(fixture.value.definition.fixtureInformation ?? {}) };
  infoBlock.manufacturer = manufacturer.value.trim();
  infoBlock.fixtureName = fixtureName.value.trim();
  infoBlock.revision = revision.value.trim() || undefined;
  fixture.value.definition.fixtureInformation = infoBlock;
}

async function reload(): Promise<void> {

  loading.value = true;

  error.value = null;

  try {

    const res = await fixturesApi.get(props.id);

    fixture.value = res.fixture;

    name.value = res.fixture.name;

    displayName.value = res.fixture.displayName ?? '';

    manufacturer.value = res.fixture.manufacturer;

    fixtureName.value = res.fixture.fixtureName;

    revision.value = res.fixture.revision ?? '';

    tags.value = res.fixture.tags.join(', ');

    status.value = res.fixture.status;

    const available = availableModelQualitiesFromDefinition(res.fixture.definition.metadata);
    modelQuality.value = coerceModelQuality(
      modelQualityFromDefinition(res.fixture.definition.metadata) ?? DEFAULT_GDTF_MODEL_QUALITY,
      available,
    );

    if (!selectedPartId.value && res.fixture.definition.parts[0]) {

      selectedPartId.value = res.fixture.definition.parts[0].partId;

    }

    syncOrbitPublishFields();

  } catch (err) {

    error.value = (err as ApiError).message ?? 'failed to load';

    fixture.value = null;

  } finally {

    loading.value = false;

  }

}



async function save(): Promise<void> {

  if (!fixture.value) return;

  saving.value = true;

  try {

    applyPlacementToDefinition();
    applyIdentityToDefinition();
    applyOrbitPublishTemplate();

    const res = await fixturesApi.update(props.id, {

      name: name.value.trim(),

      displayName: displayName.value.trim() || null,

      manufacturer: manufacturer.value.trim(),

      fixtureName: fixtureName.value.trim(),

      revision: revision.value.trim() || null,

      tags: tags.value.split(',').map((s) => s.trim()).filter(Boolean),

      status: status.value,

      definition: fixture.value.definition,

    });

    fixture.value = res.fixture;

    syncIdentityFromFixture();

  } catch (err) {

    error.value = (err as ApiError).message ?? 'save failed';

  } finally {

    saving.value = false;

  }

}



function readOrbitPublishTemplate(): FixtureOrbitPublishTemplate {
  const raw = fixture.value?.definition?.metadata?.orbitPublishTemplate;
  if (!raw || typeof raw !== 'object') return {};
  return raw as FixtureOrbitPublishTemplate;
}

function syncOrbitPublishFields(): void {
  const template = readOrbitPublishTemplate();
  orbitUnitNumber.value = template.unitNumber ?? '';
  orbitPatchUniverse.value = template.patch?.universe ?? '';
  orbitPatchAddress.value = template.patch?.address ?? '';
}

function applyOrbitPublishTemplate(): void {
  if (!fixture.value) return;
  const patchUniverse = orbitPatchUniverse.value;
  const patchAddress = orbitPatchAddress.value;
  const hasPatch = patchUniverse !== '' && patchAddress !== '';
  const template: FixtureOrbitPublishTemplate = {
    ...(orbitUnitNumber.value.trim() ? { unitNumber: orbitUnitNumber.value.trim() } : {}),
    ...(hasPatch ? {
      patch: {
        protocol: 'DMX',
        universe: Number(patchUniverse),
        address: Number(patchAddress),
        absoluteAddress: Number(patchUniverse) * 512 + Number(patchAddress),
        break: 1,
        footprint: 0,
        channelRange: '',
        status: 'template',
      },
    } : {}),
  };
  fixture.value.definition.metadata = {
    ...(fixture.value.definition.metadata ?? {}),
    orbitPublishTemplate: Object.keys(template).length ? template : undefined,
  };
}

async function publishToOrbit(): Promise<void> {
  if (!fixture.value || !canPublishToOrbit.value) return;
  publishingOrbit.value = true;
  publishOrbitError.value = null;
  error.value = null;
  try {
    await save();
    const res = await fixturesApi.publishToOrbit(props.id);
    fixture.value = res.fixture;
    syncOrbitPublishFields();
  } catch (err) {
    publishOrbitError.value = (err as ApiError).message ?? 'publish to Orbit failed';
  } finally {
    publishingOrbit.value = false;
  }
}

async function onIesUploaded(): Promise<void> {
  iesOrbitMessage.value = null;
  publishOrbitError.value = null;
  await reload();
  if (!orbitFixtureRef.value) {
    iesOrbitMessage.value =
      'IES saved in PRISM. Publish to Orbit to attach photometric blobs on FixtureType.assets.ies for Rhino and viewers.';
    return;
  }
  if (!canPublishToOrbit.value) {
    iesOrbitMessage.value =
      'IES saved in PRISM. Complete manufacturer/fixture name and geometry, then republish to Orbit to sync profiles.';
    return;
  }
  publishingOrbit.value = true;
  try {
    const res = await fixturesApi.publishToOrbit(props.id);
    fixture.value = res.fixture;
    syncOrbitPublishFields();
    iesOrbitMessage.value = 'IES uploaded and republished to Orbit — profiles are available on FixtureType.assets.ies.';
  } catch (err) {
    publishOrbitError.value = (err as ApiError).message ?? 'republish to Orbit failed after IES upload';
  } finally {
    publishingOrbit.value = false;
  }
}



function updatePivot(pivot: Vec3): void {

  if (!fixture.value || !selectedPartId.value) return;

  const part = fixture.value.definition.parts.find((p) => p.partId === selectedPartId.value);

  if (!part) return;

  part.pivot = pivot;

}



function onGeometryChange(): void {

  assemblyRevision.value += 1;

}



function onTransformPart(edit: PartTransformEdit): void {

  if (!fixture.value) return;

  const part = fixture.value.definition.parts.find((p) => p.partId === edit.partId);

  if (!part) return;

  // The gizmo already moved the live scene node; only sync the data model so the

  // numeric panel updates. Bumping assemblyRevision would rebuild + reset the gizmo.

  part.localTransform = buildTransform4x4(edit.position, edit.rotation, edit.scale);

}



async function assignDefaultMaterials(): Promise<void> {

  if (!fixture.value) return;

  const res = await materialsApi.list({ q: 'grey', limit: 20 });

  const fallback = res.materials[0];

  if (!fallback) return;

  for (const part of fixture.value.definition.parts) {

    if (!part.materialId) part.materialId = fallback.id;

  }

}



async function removeFixture(): Promise<void> {

  if (!fixture.value || !confirm(`Delete "${fixture.value.name}"?`)) return;

  await fixturesApi.remove(props.id);

  void router.push({ name: 'prism-library' });

}



const partsPanelRef = ref<HTMLDivElement | null>(null);
const propsPaneWidth = ref(PARTS_PROPS_WIDTH_DEFAULT);
const draggingPropsSplitter = ref(false);
let partsPanelResizeObserver: ResizeObserver | null = null;

function getPartsPanelWidth(): number {
  return partsPanelRef.value?.clientWidth ?? 1200;
}

function maxPropsPaneWidth(bodyW = getPartsPanelWidth()): number {
  const reserved = 220 + 16 + PARTS_VIEWPORT_MIN;
  return Math.max(PARTS_PROPS_WIDTH_MIN, bodyW - reserved);
}

function clampPropsPaneWidth(px: number, bodyW = getPartsPanelWidth()): number {
  return Math.min(Math.max(px, PARTS_PROPS_WIDTH_MIN), maxPropsPaneWidth(bodyW));
}

function readStoredPropsPaneWidth(): number | null {
  try {
    const raw = localStorage.getItem(PARTS_PROPS_WIDTH_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function resolveInitialPropsPaneWidth(bodyW: number): number {
  const stored = readStoredPropsPaneWidth();
  if (stored === null) return clampPropsPaneWidth(PARTS_PROPS_WIDTH_DEFAULT, bodyW);
  return clampPropsPaneWidth(stored, bodyW);
}

function setupPartsPanelResize(): void {
  if (!partsPanelRef.value) return;
  const bodyW = partsPanelRef.value.clientWidth;
  propsPaneWidth.value = resolveInitialPropsPaneWidth(bodyW);

  if (!partsPanelResizeObserver) {
    partsPanelResizeObserver = new ResizeObserver(() => {
      propsPaneWidth.value = clampPropsPaneWidth(propsPaneWidth.value);
    });
    partsPanelResizeObserver.observe(partsPanelRef.value);
  }
}

function persistPropsPaneWidth(): void {
  try {
    localStorage.setItem(PARTS_PROPS_WIDTH_KEY, String(propsPaneWidth.value));
  } catch {
    // non-fatal
  }
}

function onPropsSplitterPointerDown(ev: PointerEvent): void {
  if (!partsPanelRef.value) return;
  draggingPropsSplitter.value = true;
  const startX = ev.clientX;
  const startW = propsPaneWidth.value;

  const onMove = (moveEv: PointerEvent): void => {
    const delta = startX - moveEv.clientX;
    propsPaneWidth.value = clampPropsPaneWidth(startW + delta);
  };

  const onUp = (): void => {
    draggingPropsSplitter.value = false;
    persistPropsPaneWidth();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

watch(activeTab, (tab) => {
  if (tab === 'parts') nextTick(() => setupPartsPanelResize());
});

onBeforeUnmount(() => {
  partsPanelResizeObserver?.disconnect();
  partsPanelResizeObserver = null;
});

onMounted(() => {
  void reload().then(() => {
    if (canCheckGdtfUpdates.value) void checkForUpdates();
  });
  void loadClampLibraryModels();
});

</script>



<template>

  <div v-if="loading" class="muted">Loading…</div>

  <div v-else-if="error && !fixture" class="error-box">{{ error }}</div>

  <template v-else-if="fixture">

    <div class="editor-shell page-fill">

      <header class="editor-head">

        <RouterLink :to="{ name: 'prism-library' }" class="back muted"><Icon name="arrow_back" :size="14" /> Fixture library</RouterLink>

        <p v-if="showDuplicateBanner" class="duplicate-banner">
          Draft copy — update manufacturer and fixture name, then publish to Orbit when ready.
        </p>

        <div class="head-main">

          <div>

            <h1>{{ fixtureLabel(fixture) }}</h1>

            <p class="head-meta muted">

              <span v-if="fixture.displayName?.trim()">{{ fixture.name }} · </span>

              {{ manufacturer || info?.manufacturer }} · {{ fixtureName || info?.fixtureName }}

              <span v-if="revision || info?.revision"> · v{{ revision || info?.revision }}</span>

              <span v-if="fixture.status === 'draft'" class="draft-badge">draft</span>

            </p>

            <div v-if="storedVersions.length && canCheckGdtfUpdates" class="version-bar">
              <p v-if="provenanceLine" class="provenance muted">{{ provenanceLine }}</p>
              <div class="version-controls">
                <select
                  class="version-select"
                  :disabled="switchingVersion"
                  :value="activeStoredVersion?.id"
                  @change="onSwitchStoredVersion(($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="v in storedVersions" :key="v.id" :value="v.id">
                    {{ formatStoredVersionLabel(v) }} — {{ formatEditorDate(v.downloadedAt) }}
                  </option>
                </select>
                <button
                  type="button"
                  class="btn-outline"
                  :disabled="checkingUpdates"
                  @click="checkForUpdates"
                >{{ checkingUpdates ? 'Checking…' : 'Check updates' }}</button>
                <button
                  v-if="updateCheck?.updateAvailable && updateCheck.latestRid"
                  type="button"
                  class="btn-update"
                  :disabled="applyingUpdate"
                  @click="applyLatestUpdate"
                >
                  {{ applyingUpdate ? 'Updating…' : `Update to ${updateCheck.latestRevision ?? 'latest'}` }}
                </button>
                <span v-else-if="fixture.updateAvailable" class="pill warn">Update available</span>
              </div>
              <ul v-if="carryReport.length" class="carry-report muted">
                <li v-for="(line, i) in carryReport" :key="i">{{ line }}</li>
              </ul>
            </div>

          </div>

          <div class="head-actions">

            <button
              type="button"
              class="btn-orbit"
              :disabled="publishingOrbit || saving || !canPublishToOrbit"
              :title="orbitPublishBlockedReason ?? undefined"
              @click="publishToOrbit"
            >
              <Icon name="cloud_upload" :size="16" />
              {{ publishingOrbit ? 'Publishing…' : (orbitFixtureRef ? 'Republish to Orbit' : 'Publish to Orbit') }}
            </button>


            <button :disabled="saving" class="primary" @click="save"><Icon name="save" :size="16" />{{ saving ? 'Saving…' : 'Save' }}</button>

            <button class="danger" @click="removeFixture"><Icon name="delete" :size="16" />Delete</button>

          </div>

        </div>

        <div class="badge-row">

          <span

            v-for="b in badges"

            :key="b.label"

            class="status-badge"

            :class="b.ok ? 'ok' : 'missing'"

          >{{ b.label }}</span>

          <span v-for="tag in fixture.tags" :key="tag" class="pill tag">{{ tag }}</span>

          <span v-if="orbitFixtureRef" class="pill orbit-pill">
            <a
              v-if="orbitFixtureRef.orbitUrl"
              :href="orbitFixtureRef.orbitUrl"
              target="_blank"
              rel="noopener noreferrer"
            >Orbit · {{ formatEditorDate(orbitFixtureRef.publishedAt) }}</a>
            <span v-else>Orbit · {{ formatEditorDate(orbitFixtureRef.publishedAt) }}</span>
          </span>

          <span v-else class="pill muted-pill">Not on Orbit</span>

        </div>

        <p v-if="publishOrbitError" class="orbit-error">{{ publishOrbitError }}</p>
        <p v-else-if="orbitPublishBlockedReason" class="muted small orbit-hint">{{ orbitPublishBlockedReason }}</p>

      </header>



      <nav class="tab-bar">

        <button

          v-for="tab in ([

            ['overview', 'Overview'],

            ['dmx', 'DMX'],

            ['parts', 'Parts'],

            ['construction', 'Construction'],

            ['control', 'Control'],

            ['ies', 'IES'],

            ['settings', 'Settings'],

          ] as const)"

          :key="tab[0]"

          type="button"

          class="tab-btn"

          :class="{ active: activeTab === tab[0] }"

          @click="selectTab(tab[0])"

        >{{ tab[1] }}</button>

      </nav>



      <div v-if="activeTab === 'overview'" class="tab-panel overview-panel">

        <section class="preview-card">

          <FixtureQuadPreview :preview-url="previewUrl" :assembly="assembly" :fixture-name="info?.fixtureName" />

          <p class="muted small preview-caption">

            {{ fixture.definition.parts.length }} parts

            <span v-if="fixture.hasPreview"> · GLB preview (Iso view interactive)</span>

          </p>

        </section>

        <section class="info-card">

          <h2>Fixture information</h2>

          <dl class="info-grid">
            <template v-for="row in fixtureInfoRows" :key="row.label">
              <dt>{{ row.label }}</dt><dd :class="{ mono: row.label === 'GDTF type id' }">{{ row.value }}</dd>
            </template>
            <dt>Status</dt><dd>{{ fixture.status }}</dd>
            <dt>Source hash</dt><dd class="mono">{{ fixture.sourceGdtfHash?.slice(0, 16) ?? '—' }}</dd>
          </dl>

        </section>

      </div>



      <div v-else-if="activeTab === 'dmx'" class="tab-panel">

        <DmxModePanel

          :dmx-mapping="fixture.definition.dmxMapping"

          :fixture-name="info?.fixtureName"

          :manufacturer="info?.manufacturer"

        />

      </div>



      <div
        v-else-if="activeTab === 'parts'"
        ref="partsPanelRef"
        class="tab-panel parts-panel"
        :class="{ 'is-dragging': draggingPropsSplitter }"
      >

        <aside class="panel-card parts-tree-card">

          <h2>Geometry</h2>

          <FixturePartTree

            :parts="fixture.definition.parts"

            :selected-id="selectedPartId"

            @select="selectedPartId = $event"

          />

        </aside>

        <section class="panel-card parts-viewport-card">

          <div class="viewport-head">

            <h2>Assembly preview</h2>

            <span v-if="selectedPart" class="muted small">{{ selectedPart.name }}</span>

          </div>

          <div class="parts-viewport">

            <div v-if="assembly" class="gizmo-toolbar">

              <button type="button" class="gizmo-btn" :class="{ active: gizmoMode === 'translate' }" title="Move (translate)" @click="gizmoMode = 'translate'"><Icon name="open_with" :size="16" /></button>

              <button type="button" class="gizmo-btn" :class="{ active: gizmoMode === 'rotate' }" title="Rotate" @click="gizmoMode = 'rotate'"><Icon name="3d_rotation" :size="16" /></button>

              <button type="button" class="gizmo-btn" :class="{ active: gizmoMode === 'scale' }" title="Scale" @click="gizmoMode = 'scale'"><Icon name="zoom_out_map" :size="16" /></button>

              <span class="gizmo-sep" aria-hidden="true" />

              <button type="button" class="gizmo-btn space" :title="`Gizmo space: ${gizmoSpace}`" @click="gizmoSpace = gizmoSpace === 'local' ? 'world' : 'local'">{{ gizmoSpace === 'local' ? 'LOCAL' : 'WORLD' }}</button>

              <template v-if="hasModeGeometries">
                <span class="gizmo-sep" aria-hidden="true" />
                <label class="gizmo-mode-select" title="DMX mode — shows only this mode's 3D model">
                  <span>Mode</span>
                  <select v-model="selectedModeId">
                    <option v-for="m in dmxModes" :key="m.modeId" :value="m.modeId">{{ m.name }}</option>
                  </select>
                </label>
              </template>

            </div>

            <FixtureViewer

              v-if="previewUrl || assembly"

              :url="previewUrl"

              :assembly="assembly"

              :assembly-revision="assemblyRevision"

              :datums="datumMarkers"

              :gdtf-reference-bounds="selectedGdtfBounds"

              :editable="!!assembly"

              :selected-part-id="selectedPartId"

              :gizmo-mode="gizmoMode"

              :gizmo-space="gizmoSpace"

              fill

              light-background

              @select-datum="selectedPartId = $event"

              @select-part="selectedPartId = $event"

              @transform-part="onTransformPart"

            />

            <p v-else class="muted no-preview">No 3D preview available.</p>

          </div>

          <p v-if="assembly" class="muted small gizmo-hint">Click a part to select · drag the gizmo to move / rotate it · edits save with the fixture.</p>

        </section>

        <div
          class="col-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize properties panel"
          @pointerdown="onPropsSplitterPointerDown"
        />

        <aside
          class="panel-card parts-props-card"
          :style="{ width: `${propsPaneWidth}px`, flex: `0 0 ${propsPaneWidth}px` }"
        >

          <FixturePartProperties

            :part="selectedPart"

            :models="fixture.definition.models"

            :fixture-id="fixture.id"

            @change="onGeometryChange"

          />

          <details class="datum-block">

            <summary>Pivot / datum</summary>

            <DatumEditor :part="selectedPart" @update="updatePivot" />

          </details>

        </aside>

      </div>



      <div v-else-if="activeTab === 'construction'" class="tab-panel construction-panel">

        <FixtureConstructionGraph
          v-if="fixture?.definition"
          :fixture-id="fixture.id"
          :definition="fixture.definition"
        />

      </div>



      <div v-else-if="activeTab === 'control'" class="tab-panel control-tab-panel">

        <FixtureGdtfDebugPanel v-if="fixture" :fixture="fixture" />

      </div>



      <div v-else-if="activeTab === 'ies'" class="tab-panel">

        <section class="panel-card">

          <h2>IES profiles (per beam × zoom)</h2>

          <p class="muted small">
            Upload a photometric (.ies) file for each zoom position — typically DMX 0 (wide), 128 (mid), and 255 (narrow).
            Profiles are stored in PRISM and uploaded to Orbit as blobs on
            <code>FixtureType.assets.ies</code> when you publish or republish.
            If this fixture is already on Orbit, each upload triggers an automatic republish.
          </p>

          <IesUploader
            :fixture-id="fixture.id"
            :beams="fixture.definition.beams"
            :parts="fixture.definition.parts"
            :disabled="publishingOrbit"
            @uploaded="onIesUploaded"
          />

          <p v-if="publishingOrbit" class="muted small mt-sm">Republishing IES profiles to Orbit…</p>
          <p v-else-if="iesOrbitMessage" class="muted small mt-sm sync-ok">{{ iesOrbitMessage }}</p>
          <p v-if="publishOrbitError" class="error-box mt-sm">{{ publishOrbitError }}</p>

          <ul class="beam-list">

            <li v-for="b in fixture.definition.beams" :key="b.beamId">

              <span>{{ beamDisplayLabel(b, fixture.definition.parts) }}</span>

              <span v-if="iesProfileCount(b)" class="pill online">{{ iesProfileCount(b) }} IES profile(s)</span>

              <span v-else class="pill muted-pill">No IES</span>

            </li>

          </ul>

        </section>

      </div>



      <div v-else class="tab-panel">

        <section class="panel-card settings-card">

          <h2>Metadata</h2>

          <label>Name <input v-model="name" maxlength="256" /></label>

          <label>Display name
            <input v-model="displayName" :placeholder="name || 'Custom label (optional)'" maxlength="256" />
          </label>

          <p class="field-hint muted">Optional. Shown across PRISM, the connector, and Orbit. Leave blank to use the fixture name.</p>

          <label>Manufacturer <input v-model="manufacturer" maxlength="256" /></label>

          <label>Fixture name <input v-model="fixtureName" maxlength="256" /></label>

          <label>Revision <input v-model="revision" maxlength="128" /></label>

          <label>Tags <input v-model="tags" placeholder="comma-separated" /></label>

          <label>Status

            <select v-model="status">

              <option value="draft">draft</option>

              <option value="published">published</option>

            </select>

          </label>

          <button class="mt-sm" @click="assignDefaultMaterials">Assign default materials to empty parts</button>

        </section>

        <section class="panel-card settings-card">
          <h2>GDTF source</h2>
          <p class="muted small">
            Re-download the fixture from GDTF Share (or re-parse the stored GDTF package for uploaded fixtures)
            and replace the working copy with a fresh import. All local edits are discarded.
          </p>
          <button
            type="button"
            class="mt-sm danger"
            :disabled="resettingToGdtf || saving || reimportingMeshes"
            @click="resetToGdtf"
          >
            {{ resettingToGdtf ? 'Resetting…' : 'Reset to GDTF' }}
          </button>
        </section>

        <section class="panel-card settings-card">
          <h2>Clamp</h2>
          <p class="muted small">
            Pick a clamp from the Model Library or upload a custom mesh. It renders at the fixture origin while the body can be lowered separately.
          </p>
          <label class="clamp-library-label">
            Model Library
            <div class="clamp-library-row">
              <select
                v-model="clampModelLibraryId"
                class="clamp-library-select"
                :disabled="clampLibraryLoading"
                @change="onClampLibraryChange"
              >
                <option :value="null">— None (use upload) —</option>
                <option v-for="m in clampLibraryModels" :key="m.id" :value="m.id">{{ clampLibraryOptionLabel(m) }}</option>
              </select>
              <button
                v-if="clampModelLibraryId"
                type="button"
                class="btn-link small"
                @click="clearClampLibrary"
              >
                Clear
              </button>
            </div>
          </label>
          <p v-if="clampLibraryLoading" class="muted small">Loading clamp models…</p>
          <p v-else-if="clampLibraryShowingAll" class="muted small">
            Showing all library models with a preview mesh. Set Category to <strong>clamp</strong> (or add a <strong>clamp</strong> tag) in the Model Editor to filter this list.
          </p>
          <p v-else-if="!clampLibraryLoading && clampLibraryModels.length === 0" class="muted small">
            No clamp models with a preview yet. In the Model Library, import or convert a mesh, set Category to <strong>clamp</strong> (or tag <strong>clamp</strong>), then pick it here. Draft models are included.
          </p>
          <p v-if="clampLibraryPreviewMissing" class="warn small">
            The assigned library model is missing or has no preview — the viewport may not show a clamp until you pick another model or upload one.
          </p>
          <div class="clamp-upload-row">
            <label class="model-swap-btn" :class="{ busy: replacingModelId === REBUS_CLAMP_MODEL_ID }">
              <Icon name="upload_file" :size="14" />
              {{ replacingModelId === REBUS_CLAMP_MODEL_ID ? 'Converting…' : (clampHasUploadedMesh ? 'Replace clamp upload' : 'Upload clamp model') }}
              <input
                type="file"
                accept=".gltf,.glb,.obj,.fbx,.3ds,.stl,.dae,.ply"
                :disabled="!!replacingModelId"
                @change="replaceModel(REBUS_CLAMP_MODEL_ID, $event)"
              />
            </label>
            <span v-if="clampHasMesh" class="pill online">Attached</span>
            <span v-else class="pill muted-pill">No model</span>
          </div>
          <p v-if="clampCustomMeshFilename" class="muted small">Custom mesh: {{ clampCustomMeshFilename }}</p>
          <p v-if="meshUploadMessage && meshUploadTarget === REBUS_CLAMP_MODEL_ID" class="muted small sync-ok">
            {{ meshUploadMessage }}
          </p>
          <p v-if="clampModelLibraryId && clampHasUploadedMesh" class="muted small">
            Library model is used in the viewport when set; the uploaded mesh remains for ORBIT export until you clear the library pick.
          </p>
          <template v-if="clampHasMesh">
            <label class="check-row clamp-option">
              <input v-model="clampMirrorZ" type="checkbox" @change="onClampPlacementChange" />
              Mirror on Z axis (dual clamp)
            </label>
            <label class="clamp-rotate-label">
              Rotate around centre Z
              <div class="clamp-rotate-row">
                <input
                  v-model.number="clampRotateZDeg"
                  type="range"
                  min="-180"
                  max="180"
                  step="1"
                  class="range-orange"
                  @input="onClampPlacementChange"
                />
                <input
                  v-model.number="clampRotateZDeg"
                  type="number"
                  min="-180"
                  max="180"
                  step="1"
                  class="clamp-rotate-input"
                  @input="onClampPlacementChange"
                />
                <span class="muted small">°</span>
              </div>
            </label>
            <p class="muted small">
              Z mirror duplicates the clamp mesh across the fixture centre line; Z rotation spins both clamps around the hang point.
            </p>
          </template>
        </section>

        <section class="panel-card settings-card">
          <h2>Fixture placement</h2>
          <label class="offset-label">
            Lower fixture body
            <div class="offset-row">
              <input
                v-model.number="fixtureZOffsetMm"
                type="number"
                min="0"
                step="1"
                class="offset-input"
                @input="onFixtureZOffsetChange"
              />
              <span class="muted small">mm</span>
            </div>
          </label>
          <p class="muted small">
            Shifts base, yoke, head, lenses and motion downward in Z (GDTF metres) so a clamp model can sit at the hang point above the fixture.
          </p>

        <section class="panel-card settings-card">
<h2>Orbit publish</h2>
          <p class="muted small">
            Publishes this fixture type to the Orbit Fixtures project. Republish after edits to update the existing Orbit model (new version, same model id).
          </p>
          <p v-if="orbitFixtureRef" class="muted small">
            Last published {{ formatEditorDate(orbitFixtureRef.publishedAt) }}
            <span v-if="orbitFixtureRef.orbitUrl">
              · <a :href="orbitFixtureRef.orbitUrl" target="_blank" rel="noopener noreferrer">Open in Orbit</a>
            </span>
          </p>
          <label>Unit number (optional template)
            <input v-model="orbitUnitNumber" placeholder="e.g. 101" @change="applyOrbitPublishTemplate" />
          </label>
          <div class="orbit-patch-row">
            <label>Patch universe (optional)
              <input v-model.number="orbitPatchUniverse" type="number" min="0" step="1" @change="applyOrbitPublishTemplate" />
            </label>
            <label>Patch address (optional)
              <input v-model.number="orbitPatchAddress" type="number" min="1" step="1" @change="applyOrbitPublishTemplate" />
            </label>
          </div>
          <p class="muted small">
            Includes fixture information, REBUS tags, per-part material IDs, motion rig, and preview asset URLs. Mesh geometry is referenced via preview GLB URL — direct Orbit mesh upload is not yet wired.
          </p>
          <button
            type="button"
            class="mt-sm btn-orbit"
            :disabled="publishingOrbit || saving || !canPublishToOrbit"
            @click="publishToOrbit"
          >
            {{ publishingOrbit ? 'Publishing…' : (orbitFixtureRef ? 'Republish to Orbit' : 'Publish to Orbit') }}
          </button>
        </section>

        </section>

        <section class="panel-card settings-card">
          <h2>3D models</h2>
          <p v-if="!availableModelQualities" class="muted small">
            Mesh options not recorded for this fixture — re-download or apply an update to refresh from the GDTF package.
          </p>
          <template v-else>
            <p v-if="modelQualityFromDefinition(fixture?.definition.metadata)" class="muted small">
              Current import: {{ GDTF_MODEL_QUALITY_LABELS[modelQualityFromDefinition(fixture!.definition.metadata)!] }}
            </p>
            <FixtureModelQualitySelect
              v-model="modelQuality"
              :available="availableModelQualities"
              :formats="availableModelFormats"
              :disabled="reimportingMeshes"
            />
            <template v-if="canChooseModelQuality">
              <button
                class="mt-sm"
                :disabled="reimportingMeshes || modelQualityFromDefinition(fixture?.definition.metadata) === modelQuality"
                @click="applyModelQuality"
              >
                {{ reimportingMeshes ? 'Re-importing meshes…' : 'Apply model quality' }}
              </button>
              <p class="muted small">
                GDTF-Share fixtures re-download the active revision with the chosen mesh LOD. Uploaded fixtures re-parse the stored local package. Part transforms and edits are kept.
              </p>
            </template>
            <button
              class="mt-sm"
              :disabled="reimportingMeshes"
              @click="reloadModelMeshes"
            >
              {{ reimportingMeshes ? 'Reloading 3D model…' : 'Reload 3D model' }}
            </button>
            <p class="muted small">
              Re-converts the GDTF mesh (e.g. 3DS → glTF) with the current pipeline. Use if the fixture is showing placeholder boxes instead of its model.
            </p>
          </template>

          <div v-if="meshOriginCount > 0" class="origin-export">
            <h3 class="model-swap-title">Mesh origins</h3>
            <p class="muted small">
              Download the origin point + rotation of every mesh in GDTF coordinates
              (Z-up, metres) to line the same meshes up in your 3D software.
            </p>
            <button class="mt-sm" @click="downloadMeshOrigins">
              <Icon name="download" :size="14" />
              Download mesh origins ({{ meshOriginCount }})
            </button>
          </div>

          <div v-if="swapModels.length" class="model-swap">
            <h3 class="model-swap-title">Swap a model</h3>
            <p class="muted small">
              Upload a 3D file to replace a model's mesh (glTF, GLB, OBJ, FBX, 3DS, STL, DAE, PLY).
              Custom meshes render at their authored 1:1 scale — use <strong>Mesh offset</strong> translation on the
              part (Parts tab) to align without moving the pan/tilt pivot.
            </p>
            <ul class="model-swap-list">
              <li v-for="m in swapModels" :key="m.modelId" class="model-swap-row">
                <span class="model-swap-meta">
                  <span class="model-swap-name">{{ m.modelId }}</span>
                  <span class="model-swap-tag">{{ m.partTag }}</span>
                  <span v-if="customMeshFilename(m)" class="pill online custom-mesh-pill">
                    Custom: {{ customMeshFilename(m) }}
                  </span>
                </span>
                <label class="model-swap-btn" :class="{ busy: replacingModelId === m.modelId }">
                  <Icon name="upload_file" :size="14" />
                  {{ replacingModelId === m.modelId ? 'Converting…' : 'Replace' }}
                  <input
                    type="file"
                    accept=".gltf,.glb,.obj,.fbx,.3ds,.stl,.dae,.ply"
                    :disabled="!!replacingModelId"
                    @change="replaceModel(m.modelId, $event)"
                  />
                </label>
              </li>
            </ul>
            <p v-if="meshUploadMessage && meshUploadTarget !== REBUS_CLAMP_MODEL_ID" class="muted small sync-ok">
              {{ meshUploadMessage }}
            </p>
          </div>
        </section>

      </div>



      <div v-if="error" class="error-box mt">{{ error }}</div>

    </div>

  </template>

</template>



<style scoped>

.editor-shell {

  gap: 16px;

}

.editor-head,
.tab-bar {
  flex-shrink: 0;
}

.editor-head {

  display: flex;

  flex-direction: column;

  gap: 10px;

}

.back { font-size: 13px; text-decoration: none; }

.head-main {

  display: flex;

  justify-content: space-between;

  align-items: flex-start;

  gap: 16px;

}

.head-main h1 {

  margin: 0;

  font-size: 24px;

  font-weight: 700;

  letter-spacing: -0.02em;

}

.head-meta { margin: 4px 0 0; font-size: 13px; }

.field-hint { margin: -4px 0 6px; font-size: 11px; line-height: 1.4; }

.duplicate-banner {
  margin: 8px 0 0;
  padding: 8px 12px;
  border-radius: var(--radius);
  background: #fef3c7;
  color: #92400e;
  font-size: 13px;
}
[data-theme="dark"] .duplicate-banner { background: #422006; color: #fcd34d; }

.draft-badge {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 999px;
  background: #fef3c7;
  color: #92400e;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}
[data-theme="dark"] .draft-badge { background: #422006; color: #fcd34d; }

.version-bar { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.version-bar .provenance { margin: 0; font-size: 12px; }
.version-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.version-select {
  min-width: 220px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-input);
  font-size: 12px;
}
.btn-outline {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}
.btn-update {
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius);
  background: var(--orbit-primary);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.pill.warn { background: var(--color-warn-bg); color: var(--color-warn); font-size: 11px; padding: 2px 8px; border-radius: 999px; }
.carry-report { margin: 0; padding-left: 18px; font-size: 11px; }

.head-actions { display: flex; gap: 8px; flex-shrink: 0; align-items: center; flex-wrap: wrap; }
.btn-orbit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid var(--orbit-primary, #ff8800);
  background: transparent;
  color: var(--orbit-primary, #ff8800);
  font-weight: 600;
  cursor: pointer;
}
.btn-orbit:disabled { opacity: 0.5; cursor: not-allowed; }
.orbit-pill a { color: inherit; text-decoration: none; }
.orbit-pill a:hover { text-decoration: underline; }
.orbit-error { color: var(--color-error); margin: 8px 0 0; font-size: 13px; }
.orbit-hint { margin: 8px 0 0; }
.orbit-patch-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 10px; }



.badge-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

.status-badge {

  padding: 4px 10px;

  border-radius: 999px;

  font-size: 11px;

  font-weight: 600;

  text-transform: uppercase;

  letter-spacing: 0.03em;

}

.status-badge.ok { background: var(--color-success-bg); color: var(--color-success); }

.status-badge.missing { background: var(--color-error-bg); color: var(--color-error); }

.pill.tag { font-size: 11px; }



.tab-bar {

  display: flex;

  gap: 4px;

  border-bottom: 1px solid var(--color-border);

  padding-bottom: 0;

}

.tab-btn {

  padding: 10px 16px;

  border: none;

  background: transparent;

  color: var(--color-text-muted);

  font-size: 13px;

  font-weight: 600;

  cursor: pointer;

  border-bottom: 2px solid transparent;

  margin-bottom: -1px;

}

.tab-btn.active {

  color: var(--orbit-primary);

  border-bottom-color: var(--orbit-primary);

}



.tab-panel {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* Flex fill (not vh calc) so viewer/graph panels get a definite height inside the shell */
.construction-panel,
.control-tab-panel,
.parts-panel {
  overflow: hidden;
}

.construction-panel,
.control-tab-panel {
  display: flex;
  flex-direction: column;
}

.construction-panel > *,
.control-tab-panel > * {
  flex: 1;
  min-height: 0;
  height: 100%;
}

.model-swap { margin-top: 16px; border-top: 1px solid var(--color-border); padding-top: 12px; }
.model-swap-title { margin: 0 0 4px; font-size: 13px; font-weight: 700; }
.model-swap-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.model-swap-row { display: flex; align-items: center; gap: 10px; }
.model-swap-meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.model-swap-name { font-size: 13px; color: var(--color-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.custom-mesh-pill { align-self: flex-start; margin-top: 4px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-swap-tag { font-size: 11px; color: var(--color-text-muted); }
.model-swap-btn {
  display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
  padding: 6px 12px; font-size: 12px; cursor: pointer;
  border: 1px solid var(--color-border); border-radius: var(--radius);
  background: var(--color-bg-input); color: var(--color-text);
}
.model-swap-btn:hover { border-color: var(--orbit-primary); color: var(--orbit-primary); }
.model-swap-btn.busy { opacity: 0.6; cursor: progress; }
.model-swap-btn input { display: none; }
.clamp-upload-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 8px; }
.clamp-library-label {
  display: block;
  margin-top: 8px;
  font-size: 13px;
}
.clamp-library-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.clamp-library-select {
  flex: 1;
  min-width: 180px;
  max-width: 100%;
}
.warn { color: var(--color-warn, #b45309); }
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.clamp-option { margin-top: 12px; }
.clamp-rotate-label {
  display: block;
  margin-top: 12px;
  font-size: 13px;
}
.clamp-rotate-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}
.clamp-rotate-row .range-orange { flex: 1; min-width: 120px; }
.clamp-rotate-input {
  width: 72px;
  padding: 6px 8px;
  font-size: 13px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-input);
  color: var(--color-text);
}
.range-orange { accent-color: var(--orbit-primary); }
.offset-label { display: block; margin-top: 10px; font-size: 13px; }
.offset-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.offset-input {
  width: 120px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-input);
  color: var(--color-text);
}

.overview-panel {

  display: grid;

  grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);

  gap: 16px;

  min-height: 0;

  overflow: hidden;

}

.preview-card, .info-card, .panel-card {

  border: 1px solid var(--color-border);

  border-radius: var(--radius-lg);

  padding: 16px;

  background: var(--color-bg);

}

.preview-card {

  display: flex;

  flex-direction: column;

  min-height: 0;

  overflow: hidden;

}

.info-card {

  min-height: 0;

  overflow-y: auto;

}

.preview-caption { flex-shrink: 0; margin: 8px 0 0; }

.info-card h2, .panel-card h2 {

  margin: 0 0 12px;

  font-size: 13px;

  font-weight: 700;

  text-transform: uppercase;

  letter-spacing: 0.05em;

  color: var(--color-text-muted);

}

.info-grid {

  display: grid;

  grid-template-columns: 100px 1fr;

  gap: 8px 12px;

  margin: 0;

  font-size: 13px;

}

.info-grid dt { color: var(--color-text-muted); margin: 0; }

.info-grid dd { margin: 0; }

.mono { font-family: var(--font-mono); font-size: 12px; }

.desc { margin-top: 12px; font-size: 13px; line-height: 1.5; }



.parts-panel {

  display: flex;

  flex-direction: row;

  align-items: stretch;

  gap: 0;

}

.parts-panel.is-dragging {

  cursor: col-resize;

  user-select: none;

}

.parts-tree-card {

  flex: 0 0 220px;

  overflow-y: auto;

  min-height: 0;

  margin-right: 16px;

}

.parts-props-card {

  overflow-y: auto;

  min-height: 0;

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

.parts-panel.is-dragging .col-splitter {

  background: color-mix(in srgb, var(--orbit-primary) 35%, transparent);

}

.parts-viewport-card {

  display: flex;

  flex-direction: column;

  flex: 1 1 0;

  min-width: 0;

  min-height: 0;

  margin-right: 5px;

}

.viewport-head {

  display: flex;

  align-items: baseline;

  justify-content: space-between;

  gap: 8px;

  margin-bottom: 8px;

}

.viewport-head h2 { margin: 0; }

.parts-viewport {

  position: relative;

  flex: 1;

  min-height: 0;

  border: 1px solid var(--color-border);

  border-radius: var(--radius-sm);

  overflow: hidden;

  contain: strict;

}

.gizmo-toolbar {

  position: absolute;

  top: 8px;

  left: 8px;

  z-index: 2;

  display: flex;

  align-items: center;

  gap: 2px;

  padding: 3px;

  border-radius: var(--radius-sm);

  background: var(--color-bg);

  border: 1px solid var(--color-border);

  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);

}

.gizmo-btn {

  display: inline-flex;

  align-items: center;

  justify-content: center;

  min-width: 28px;

  height: 28px;

  padding: 0 6px;

  border: none;

  border-radius: var(--radius-sm);

  background: transparent;

  color: var(--color-text-muted);

  cursor: pointer;

  font-size: 10px;

  font-weight: 700;

  letter-spacing: 0.04em;

}

.gizmo-btn:hover { background: var(--color-bg-hover); color: var(--color-text); }

.gizmo-btn.active { background: var(--orbit-primary); color: #fff; }

.gizmo-btn.space { font-family: var(--font-mono, monospace); min-width: 52px; }

.gizmo-sep { width: 1px; height: 18px; background: var(--color-border); margin: 0 2px; }

.gizmo-mode-select { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; }

.gizmo-mode-select > span { color: var(--color-text-muted, #9aa0a6); text-transform: uppercase; letter-spacing: 0.04em; }

.gizmo-mode-select select {
  font-size: 12px;
  padding: 3px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-input);
  color: var(--color-text);
  max-width: 220px;
}

.gizmo-hint { margin: 8px 0 0; }

.no-preview {

  padding: 24px;

  text-align: center;

}

.datum-block {

  margin-top: 16px;

  padding-top: 12px;

  border-top: 1px solid var(--color-border);

}

.datum-block summary {

  cursor: pointer;

  font-size: 11px;

  font-weight: 700;

  text-transform: uppercase;

  letter-spacing: 0.05em;

  color: var(--color-text-muted);

  margin-bottom: 8px;

}

.settings-card label { display: block; margin-top: 10px; font-size: 13px; }



.beam-list { list-style: none; padding: 0; margin: 12px 0 0; font-size: 13px; }

.beam-list li {

  display: flex;

  gap: 8px;

  align-items: center;

  padding: 8px 0;

  border-bottom: 1px solid var(--color-border);

}

.muted-pill { opacity: 0.7; }

.sync-ok { color: #7fd18c; }



@media (max-width: 960px) {

  .overview-panel { grid-template-columns: 1fr; }

  .parts-panel { flex-direction: column; }

  .col-splitter { display: none; }

  .parts-tree-card,
  .parts-props-card {

    width: 100% !important;

    flex: none !important;

    max-height: none;

    margin-right: 0;

  }

}

</style>

