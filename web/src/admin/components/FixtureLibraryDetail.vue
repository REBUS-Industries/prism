<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import {
  fixturesApi,
  type FixtureDetail,
  type FixtureListItem,
  type FixtureUpdateCheck,
  type FixtureVersionSummary,
  type GdtfShareCatalogEntry,
  type GdtfShareRevision,
} from '../../shared/api';
import DmxModePanel from './DmxModePanel.vue';
import FixtureQuadPreview from './FixtureQuadPreview.vue';
import FixtureTypeSelect from './FixtureTypeSelect.vue';
import Icon from '../../shared/Icon.vue';
import { fixtureCategoryFromTags, tagsWithFixtureCategory } from '../utils/fixtureTypes';
import { useFixtureTypesStore } from '../stores/fixtureTypes';
import { parseWheels } from '../utils/gdtfDebugExport';
import {
  cieColorToCss,
  dmxModeCount,
  imageAssetsFromDefinition,
  wheelSlotCount,
} from '../utils/fixtureDetailUtils';

const props = defineProps<{
  entry: GdtfShareCatalogEntry | null;
  localFixture: FixtureListItem | null;
  selectedRid: number | null;
  importing?: boolean;
}>();

const emit = defineEmits<{
  import: [];
  edit: [id: string];
  delete: [fixture: FixtureListItem];
  'update:selectedRid': [rid: number];
  refreshed: [fixture: FixtureListItem];
}>();

const updateCheck = ref<FixtureUpdateCheck | null>(null);
const checkingUpdates = ref(false);
const applyingUpdate = ref(false);
const switchingVersion = ref(false);
const carryReport = ref<string[]>([]);

const savingCategory = ref(false);

type DetailTab = '3d' | 'overview' | 'dmx' | 'wheels' | 'source' | 'images' | 'ies';
const activeTab = ref<DetailTab>('3d');
const localDetail = ref<FixtureDetail | null>(null);
const loadingDetail = ref(false);

const selectedVersion = computed<GdtfShareRevision | null>(() => {
  if (!props.entry) return null;
  if (props.selectedRid != null) {
    return props.entry.versions.find((v) => v.rid === props.selectedRid) ?? null;
  }
  return props.entry.versions[0] ?? null;
});

const previewUrl = computed(() =>
  props.localFixture?.hasPreview ? fixturesApi.previewUrl(props.localFixture.id) : null,
);

const definition = computed(() => localDetail.value?.definition ?? null);

const assembly = computed(() => {
  const def = definition.value;
  const id = props.localFixture?.id;
  if (!def || !id || !def.parts?.length) return null;
  return { fixtureId: id, parts: def.parts, models: def.models ?? [], motionAxes: def.motionRig ?? [] };
});

const wheelRows = computed(() => {
  if (!definition.value) return [];
  return parseWheels(definition.value);
});

const meshRecordCount = computed(() => {
  if (definition.value) {
    return definition.value.parts.length + definition.value.models.length;
  }
  return props.localFixture?.hasPreview ? 1 : 0;
});

const hasFullGdtf = computed(() => !!props.localFixture);

const tabCounts = computed(() => ({
  dmx: dmxModeCount(definition.value, props.entry?.modes?.length ?? 0),
  wheels: definition.value ? wheelSlotCount(definition.value) : 0,
  images: imageAssetsFromDefinition(definition.value, props.localFixture?.id ?? null).length,
}));

const imageAssets = computed(() =>
  imageAssetsFromDefinition(definition.value, props.localFixture?.id ?? null),
);

const detailTabs = computed(() => [
  { id: '3d' as const, label: '3D', count: null },
  { id: 'overview' as const, label: 'Overview', count: null },
  { id: 'dmx' as const, label: 'DMX', count: tabCounts.value.dmx || null },
  { id: 'wheels' as const, label: 'Wheels', count: tabCounts.value.wheels || null },
  { id: 'source' as const, label: 'Source', count: null },
  { id: 'images' as const, label: 'Images', count: tabCounts.value.images || null },
  { id: 'ies' as const, label: 'IES', count: null },
]);

const statusIcons = computed(() => {
  const has3d = props.localFixture?.hasPreview ?? false;
  const hasDmx = (props.entry?.modes?.length ?? 0) > 0
    || (Array.isArray(definition.value?.dmxMapping?.modes)
      && (definition.value!.dmxMapping.modes as unknown[]).length > 0);
  const hasWheels = wheelRows.value.length > 0;
  return [
    { key: '3d', label: '3D', ok: has3d },
    { key: 'dmx', label: 'DMX', ok: hasDmx },
    { key: 'wheels', label: 'Wheels', ok: hasWheels },
  ];
});

const iesBeams = computed(() =>
  (definition.value?.beams ?? []).filter((b) => b.iesAssetId),
);

const dmxMapping = computed(() => {
  if (definition.value?.dmxMapping) {
    return definition.value.dmxMapping;
  }
  const modes = props.entry?.modes ?? [];
  if (!modes.length) return { modes: [] };
  return {
    modes: modes.map((m) => ({
      name: m.name,
      footprint: m.dmxfootprint,
      channels: [],
    })),
  };
});

const store = useFixtureTypesStore();
onMounted(() => void store.ensureLoaded());

const fixtureCategory = computed<string>(() => {
  if (!props.localFixture) return 'Unassigned';
  return fixtureCategoryFromTags(props.localFixture.tags, store.assignableLabels);
});

async function onFixtureCategoryChange(category: string): Promise<void> {
  if (!props.localFixture || savingCategory.value) return;
  const tags = tagsWithFixtureCategory(props.localFixture.tags, category, store.assignableLabels);
  savingCategory.value = true;
  try {
    const res = await fixturesApi.update(props.localFixture.id, { tags });
    emit('refreshed', res.fixture);
  } finally {
    savingCategory.value = false;
  }
}

const modeSummary = computed(() => {
  const modes = Array.isArray(dmxMapping.value.modes) ? dmxMapping.value.modes : [];
  if (!modes.length) return 'No DMX modes';
  return modes.map((m: Record<string, unknown>) => {
    const name = String(m.name ?? 'Mode');
    const ch = m.channels;
    const fp = m.footprint ?? (Array.isArray(ch) ? ch.length : '?');
    return `${name} (${fp} ch)`;
  }).join(' · ');
});

function formatVersionLabel(v: GdtfShareRevision): string {
  const parts = [v.revision, v.version ? `GDTF ${v.version}` : null, v.creator ? `by ${v.creator}` : null]
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : `Revision ${v.rid}`;
}

function formatDate(ts?: string): string {
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

const storedVersions = computed(() => localDetail.value?.versions ?? []);

const activeStoredVersion = computed(() =>
  storedVersions.value.find((v) => v.isActive) ?? localDetail.value?.activeVersion ?? null,
);

const provenanceLine = computed(() => {
  const v = activeStoredVersion.value;
  if (!v) return null;
  return `Downloaded ${formatDate(v.downloadedAt)}${v.revision ? ` · ${v.revision}` : ''}`;
});

async function checkForUpdates(): Promise<void> {
  if (!props.localFixture) return;
  checkingUpdates.value = true;
  carryReport.value = [];
  try {
    const res = await fixturesApi.checkUpdates(props.localFixture.id);
    updateCheck.value = res.check;
  } finally {
    checkingUpdates.value = false;
  }
}

async function applyLatestUpdate(): Promise<void> {
  if (!props.localFixture || !updateCheck.value?.latestRid) return;
  applyingUpdate.value = true;
  carryReport.value = [];
  try {
    const res = await fixturesApi.downloadVersion(
      props.localFixture.id,
      updateCheck.value.latestRid,
      { carryEdits: true },
    );
    carryReport.value = [
      ...res.report.applied.map((a) => `Applied: ${a}`),
      ...res.report.unmapped.map((u) => `Unmapped: ${u}`),
    ];
    await loadLocalDetail(props.localFixture.id);
    emit('refreshed', res.fixture);
    updateCheck.value = null;
    void checkForUpdates();
  } finally {
    applyingUpdate.value = false;
  }
}

async function onSwitchStoredVersion(versionId: string): Promise<void> {
  if (!props.localFixture) return;
  switchingVersion.value = true;
  carryReport.value = [];
  try {
    const res = await fixturesApi.switchActiveVersion(props.localFixture.id, versionId);
    localDetail.value = res.fixture;
    carryReport.value = [
      ...res.report.applied.map((a) => `Applied: ${a}`),
      ...res.report.unmapped.map((u) => `Unmapped: ${u}`),
    ];
    emit('refreshed', res.fixture);
  } finally {
    switchingVersion.value = false;
  }
}

function wheelKind(mediaType: string): string {
  if (/color/i.test(mediaType)) return 'Color';
  if (/gobo/i.test(mediaType)) return 'Gobo';
  if (/animation/i.test(mediaType)) return 'Animation';
  return mediaType;
}

function slotSwatchStyle(slot: { color?: string; mediaType: string }): Record<string, string> {
  const css = cieColorToCss(slot.color);
  if (css) return { background: css };
  if (/color/i.test(slot.mediaType)) return { background: 'linear-gradient(135deg, #3b82f6, #ef4444)' };
  return { background: 'var(--color-bg-hover)' };
}

function mediaUrl(mediaId: string): string | null {
  if (!props.localFixture) return null;
  return fixturesApi.mediaUrl(props.localFixture.id, mediaId);
}

async function loadLocalDetail(id: string): Promise<void> {
  loadingDetail.value = true;
  try {
    const res = await fixturesApi.get(id);
    localDetail.value = res.fixture;
  } catch {
    localDetail.value = null;
  } finally {
    loadingDetail.value = false;
  }
}

watch(
  () => props.localFixture?.id,
  (id) => {
    localDetail.value = null;
    updateCheck.value = null;
    carryReport.value = [];
    if (id) {
      void loadLocalDetail(id);
      void checkForUpdates();
    }
  },
  { immediate: true },
);

watch(
  () => props.entry?.uuid,
  () => { activeTab.value = '3d'; },
);
</script>

<template>
  <div v-if="!entry" class="detail-empty muted">Select a fixture to view details.</div>

  <div v-else class="fixture-detail">
    <h2 class="section-label">Fixture information</h2>

    <p class="detail-name">{{ entry.fixture }}</p>
    <p class="detail-sub muted">{{ entry.manufacturer }} - {{ entry.fixture }}</p>

    <div class="icon-actions">
      <button type="button" class="icon-action" title="Preview" disabled><Icon name="visibility" :size="16" /></button>
      <button
        type="button"
        class="icon-action"
        title="Download & import"
        :disabled="importing || !selectedVersion"
        @click="emit('import')"
      ><Icon name="download" :size="16" /></button>
      <button
        v-if="localFixture"
        type="button"
        class="icon-action"
        title="Edit"
        @click="emit('edit', localFixture.id)"
      ><Icon name="edit" :size="16" /></button>
      <RouterLink
        v-if="localFixture"
        :to="{ name: 'fixture-editor', params: { id: localFixture.id }, query: { tab: 'debug' } }"
        class="icon-action debug-link"
        title="Debug GDTF 3D"
      ><Icon name="view_in_ar" :size="16" /></RouterLink>
      <span
        v-else
        class="icon-action disabled-tip"
        title="Import fixture first"
      ><Icon name="view_in_ar" :size="16" /></span>
      <button
        v-if="localFixture"
        type="button"
        class="icon-action danger"
        title="Delete"
        @click="emit('delete', localFixture)"
      ><Icon name="delete" :size="16" /></button>
    </div>

    <div class="status-row">
      <span v-if="hasFullGdtf" class="full-gdtf-pill">Full GDTF</span>
      <div class="status-icons">
        <span
          v-for="icon in statusIcons"
          :key="icon.key"
          class="status-icon"
          :class="icon.ok ? 'ok' : 'missing'"
          :title="icon.label"
        ><Icon :name="icon.ok ? 'check' : 'close'" :size="15" /></span>
      </div>
      <FixtureTypeSelect
        v-if="localFixture"
        class="inline-type-select"
        :model-value="fixtureCategory"
        :disabled="savingCategory"
        compact
        @update:model-value="onFixtureCategoryChange"
      />
    </div>

    <div v-if="!localFixture" class="version-block">
      <label class="version-label">GDTF-Share version (download)</label>
      <select
        :value="selectedRid ?? entry.versions[0]?.rid"
        class="version-select"
        @change="emit('update:selectedRid', Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="v in entry.versions" :key="v.rid" :value="v.rid">
          {{ formatVersionLabel(v) }}
        </option>
      </select>
      <p v-if="selectedVersion" class="version-meta muted">
        Modified {{ formatDate(selectedVersion.lastModified) }}
        <span v-if="selectedVersion.filesize"> · {{ (selectedVersion.filesize / 1024 / 1024).toFixed(1) }} MB</span>
        <span v-if="selectedVersion.rating"> · <Icon name="star" :size="12" fill /> {{ selectedVersion.rating }}</span>
      </p>
    </div>

    <div v-else class="version-block stored-versions">
      <label class="version-label">Library version history</label>
      <p v-if="provenanceLine" class="provenance muted small">{{ provenanceLine }}</p>
      <select
        v-if="storedVersions.length"
        class="version-select"
        :disabled="switchingVersion"
        :value="activeStoredVersion?.id"
        @change="onSwitchStoredVersion(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="v in storedVersions" :key="v.id" :value="v.id">
          {{ formatStoredVersionLabel(v) }} — {{ formatDate(v.downloadedAt) }}
        </option>
      </select>
      <div class="update-row">
        <button
          type="button"
          class="btn-outline-sm"
          :disabled="checkingUpdates"
          @click="checkForUpdates"
        >{{ checkingUpdates ? 'Checking…' : 'Check for updates' }}</button>
        <button
          v-if="updateCheck?.updateAvailable && updateCheck.latestRid"
          type="button"
          class="btn-update-sm"
          :disabled="applyingUpdate"
          @click="applyLatestUpdate"
        >
          {{ applyingUpdate ? 'Updating…' : `Update to ${updateCheck.latestRevision ?? 'latest'}` }}
        </button>
        <span v-else-if="updateCheck && !updateCheck.updateAvailable" class="muted small">Up to date</span>
        <span v-else-if="localFixture.updateAvailable" class="pill warn-pill">Update available</span>
      </div>
      <ul v-if="carryReport.length" class="carry-report muted small">
        <li v-for="(line, i) in carryReport" :key="i">{{ line }}</li>
      </ul>
    </div>

    <nav class="detail-tabs">
      <button
        v-for="tab in detailTabs"
        :key="tab.id"
        type="button"
        class="detail-tab"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
        <span v-if="tab.count" class="tab-count">{{ tab.count }}</span>
      </button>
    </nav>

    <div class="tab-content">
      <FixtureQuadPreview
        v-if="activeTab === '3d'"
        :preview-url="previewUrl"
        :assembly="assembly"
        :fixture-name="entry.fixture"
        :record-count="meshRecordCount || undefined"
      />

      <div v-else-if="activeTab === 'overview'" class="overview-tab">
        <dl class="overview-meta">
          <dt>Brand</dt>
          <dd>{{ definition?.fixtureInformation.manufacturer ?? entry.manufacturer }}</dd>
          <dt>Fixture type</dt>
          <dd>{{ localFixture ? fixtureCategory : '—' }}</dd>
          <dt>Revision</dt>
          <dd>{{ definition?.fixtureInformation.revision ?? selectedVersion?.revision ?? '—' }}</dd>
          <dt>Creator</dt>
          <dd>{{ entry.creator ?? selectedVersion?.creator ?? '—' }}</dd>
          <dt>Modes</dt>
          <dd>{{ modeSummary }}</dd>
          <dt v-if="localFixture">Local status</dt>
          <dd v-if="localFixture">{{ localFixture.status }}</dd>
        </dl>
        <div class="overview-badges">
          <span v-for="icon in statusIcons.filter((x) => x.ok)" :key="icon.key" class="meta-pill">{{ icon.label }}</span>
        </div>
        <p v-if="definition?.fixtureInformation.description" class="desc muted">
          {{ definition.fixtureInformation.description }}
        </p>
      </div>

      <DmxModePanel
        v-else-if="activeTab === 'dmx'"
        :dmx-mapping="dmxMapping"
        :fixture-name="entry.fixture"
        :manufacturer="entry.manufacturer"
        :fixture-id="localFixture?.id ?? null"
        compact
      />

      <div v-else-if="activeTab === 'wheels'" class="wheels-tab">
        <template v-if="localDetail && wheelRows.length">
          <div v-for="wheel in wheelRows" :key="wheel.wheelId" class="wheel-card">
            <header class="wheel-head">
              <h4>{{ wheel.wheelName }}</h4>
              <span class="wheel-type-pill">{{ wheel.wheelType }}</span>
              <span class="wheel-slot-count muted">{{ wheel.slots.length }} slots</span>
            </header>
            <div class="slot-grid">
              <div
                v-for="slot in wheel.slots"
                :key="`${wheel.wheelId}-${slot.slotIndex}`"
                class="slot-cell"
              >
                <div class="slot-thumb">
                  <img
                    v-if="slot.imageAssetId && mediaUrl(slot.imageAssetId)"
                    :src="mediaUrl(slot.imageAssetId)!"
                    :alt="slot.slotName"
                  />
                  <span v-else class="slot-swatch" :style="slotSwatchStyle(slot)" />
                </div>
                <span class="slot-idx mono">{{ slot.slotIndex }}</span>
                <span class="slot-name">{{ slot.slotName }}</span>
              </div>
            </div>
          </div>
        </template>
        <template v-else-if="localDetail">
          <p class="muted">No wheels defined in this fixture.</p>
        </template>
        <template v-else>
          <p class="muted">
            {{ entry.modes?.length ?? 0 }} DMX mode(s) in catalog.
            Download fixture to view color and gobo wheels.
          </p>
        </template>
      </div>

      <div v-else-if="activeTab === 'source'" class="source-tab">
        <div class="source-card">
          <h4 class="source-card-title">GDTF file</h4>
          <dl class="source-meta">
            <dt>Hash</dt>
            <dd class="mono">{{ localFixture?.sourceGdtfHash ?? '—' }}</dd>
            <dt>Revision</dt>
            <dd>{{ definition?.fixtureInformation.revision ?? selectedVersion?.revision ?? '—' }}</dd>
          </dl>
        </div>
        <div class="source-card">
          <h4 class="source-card-title">GDTF Share</h4>
          <dl class="source-meta">
            <dt>Revision ID</dt>
            <dd class="mono">{{ selectedVersion?.rid ?? '—' }}</dd>
            <dt>Version</dt>
            <dd>{{ selectedVersion?.version ? `GDTF ${selectedVersion.version}` : '—' }}</dd>
            <dt>Size</dt>
            <dd>{{ selectedVersion?.filesize ? `${(selectedVersion.filesize / 1024 / 1024).toFixed(2)} MB` : '—' }}</dd>
            <dt>Last modified</dt>
            <dd>{{ formatDate(selectedVersion?.lastModified) }}</dd>
            <dt>UUID</dt>
            <dd class="mono small-uuid">{{ entry.uuid }}</dd>
          </dl>
        </div>
        <div v-if="localFixture" class="source-card">
          <h4 class="source-card-title">Internal revision</h4>
          <dl class="source-meta">
            <dt>Status</dt>
            <dd>{{ localFixture.status }}</dd>
            <dt>Imported</dt>
            <dd>{{ provenanceLine ?? '—' }}</dd>
          </dl>
        </div>
        <RouterLink
          v-if="localFixture"
          :to="{ name: 'fixture-editor', params: { id: localFixture.id }, query: { tab: 'debug' } }"
          class="debug-link-btn"
        >Developer: open mesh debug</RouterLink>
      </div>

      <div v-else-if="activeTab === 'images'" class="images-tab">
        <div v-if="imageAssets.length" class="image-grid">
          <div v-for="img in imageAssets" :key="img.mediaId" class="image-cell">
            <div class="image-thumb">
              <img v-if="mediaUrl(img.mediaId)" :src="mediaUrl(img.mediaId)!" :alt="img.label" />
            </div>
            <span class="image-label">{{ img.label }}</span>
          </div>
        </div>
        <p v-else class="enrich-msg muted">
          No thumbnail images imported.
          Download the GDTF package to extract <strong>thumbnail.png</strong> / <strong>thumbnail.svg</strong>.
        </p>
      </div>

      <div v-else class="ies-tab">
        <template v-if="localDetail && iesBeams.length">
          <div v-for="beam in iesBeams" :key="beam.beamId" class="ies-card">
            <h4>{{ beam.beamType ?? 'Beam' }}</h4>
            <dl class="overview-meta">
              <dt>Beam ID</dt>
              <dd class="mono">{{ beam.beamId.slice(0, 8) }}…</dd>
              <dt>IES asset</dt>
              <dd class="mono">{{ beam.iesAssetId?.slice(0, 8) }}…</dd>
              <dt v-if="beam.luminousFlux">Flux</dt>
              <dd v-if="beam.luminousFlux">{{ beam.luminousFlux }} lm</dd>
              <dt v-if="beam.beamAngle">Beam angle</dt>
              <dd v-if="beam.beamAngle">{{ beam.beamAngle }}°</dd>
            </dl>
          </div>
        </template>
        <template v-else-if="localDetail">
          <p class="muted">No IES photometric data imported for this fixture.</p>
        </template>
        <template v-else>
          <p class="muted">Download fixture to view IES photometric data.</p>
        </template>
      </div>
    </div>

    <div v-if="loadingDetail" class="loading-hint muted">Loading local data…</div>
  </div>
</template>

<style scoped>
.fixture-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.detail-empty { padding: 24px 16px; }
.section-label {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.detail-name {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  line-height: 1.25;
}
.detail-sub { margin: 0; font-size: 12px; }
.mono { font-family: var(--font-mono); }

.icon-actions {
  display: flex;
  gap: 6px;
}
.icon-action {
  width: 32px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  font-size: 14px;
  cursor: pointer;
  text-decoration: none;
  color: inherit;
}
.icon-action:hover:not(:disabled) { border-color: var(--orbit-primary); }
.icon-action.danger:hover:not(:disabled) { border-color: var(--color-error); }
.icon-action:disabled,
.disabled-tip {
  opacity: 0.4;
  cursor: not-allowed;
}
.debug-link:hover { background: var(--orbit-primary-fade); }

.status-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.full-gdtf-pill {
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--color-success-bg);
  color: var(--color-success);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.status-icons { display: flex; gap: 4px; }
.status-icon {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 700;
}
.status-icon.ok { background: var(--color-success-bg); color: var(--color-success); border-color: var(--color-success); }
.status-icon.missing { background: var(--color-bg-hover); color: var(--color-text-muted); }

.inline-type-select { margin-left: auto; min-width: 120px; }
.type-label,
.version-label {
  display: block;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  margin-bottom: 4px;
}
.type-select,
.version-select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-input);
  color: var(--color-text);
  font-size: 12px;
}
.version-block { margin-top: 4px; }
.version-meta { margin: 4px 0 0; font-size: 11px; }
.stored-versions .provenance { margin: 0 0 6px; }
.update-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
.btn-outline-sm,
.btn-update-sm {
  padding: 6px 10px;
  border-radius: var(--radius);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.btn-outline-sm {
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text);
}
.btn-update-sm {
  border: none;
  background: var(--orbit-primary);
  color: #fff;
}
.warn-pill { background: var(--color-warn-bg); color: var(--color-warn); }
.carry-report { margin: 8px 0 0; padding-left: 16px; }
.small { font-size: 11px; }

.detail-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  border-bottom: 1px solid var(--color-border);
  margin: 4px -16px 0;
  padding: 0 16px;
}
.detail-tab {
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.detail-tab.active {
  color: var(--orbit-primary);
  border-bottom-color: var(--orbit-primary);
}
.tab-count {
  margin-left: 4px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--orbit-primary-fade);
  color: var(--orbit-primary);
  font-size: 10px;
  font-weight: 700;
}
.detail-tab.active .tab-count {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}

.tab-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-top: 8px;
}
.overview-tab { display: flex; flex-direction: column; gap: 12px; }
.overview-meta {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 6px;
  margin: 0;
  font-size: 12px;
}
.overview-meta dt { color: var(--color-text-muted); margin: 0; }
.overview-meta dd { margin: 0; }
.overview-badges { display: flex; flex-wrap: wrap; gap: 4px; }
.meta-pill {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--orbit-primary-fade);
  color: var(--orbit-primary);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}
.desc { margin: 0; font-size: 12px; line-height: 1.45; }

.wheels-tab { display: flex; flex-direction: column; gap: 12px; }
.wheel-slot-count { font-size: 10px; margin-left: auto; }
.slot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 8px;
  padding: 10px;
}
.slot-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
}
.slot-thumb {
  width: 56px;
  height: 56px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg);
}
.slot-thumb img { width: 100%; height: 100%; object-fit: cover; }
.slot-swatch { width: 100%; height: 100%; display: block; }
.slot-idx { font-size: 9px; color: var(--color-text-muted); }
.slot-name { font-size: 10px; line-height: 1.2; word-break: break-word; }
.wheel-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: hidden;
}
.wheel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}
.wheel-head h4 { margin: 0; font-size: 13px; }
.wheel-type-pill {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
}
.wheel-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.wheel-table th,
.wheel-table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--color-border);
}
.wheel-table th {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  background: var(--color-bg);
}
.slot-pill {
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
}
.slot-pill.color { background: #dbeafe; color: #1d4ed8; }
.slot-pill.gobo { background: #f3e8ff; color: #7c3aed; }
.slot-pill.animation { background: #fef3c7; color: #b45309; }
[data-theme="dark"] .slot-pill.color { background: #1e3a5f; color: #93c5fd; }
[data-theme="dark"] .slot-pill.gobo { background: #3b2667; color: #c4b5fd; }

.source-tab { display: flex; flex-direction: column; gap: 10px; }
.source-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 10px 12px;
  background: var(--color-bg-elevated);
}
.source-card-title {
  margin: 0 0 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.source-meta {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 4px 8px;
  margin: 0;
  font-size: 11px;
}
.source-meta dt { color: var(--color-text-muted); margin: 0; }
.source-meta dd { margin: 0; word-break: break-all; }
.small-uuid { font-size: 10px; }
.debug-link-btn {
  font-size: 11px;
  color: var(--orbit-primary);
  text-decoration: none;
  font-weight: 600;
}
.debug-link-btn:hover { text-decoration: underline; }
.sub-label {
  margin: 0 0 6px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}
.revision-list ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.revision-item {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.images-tab { display: flex; flex-direction: column; gap: 12px; }
.image-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.image-cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.image-thumb {
  aspect-ratio: 1;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--color-bg-elevated);
  display: flex;
  align-items: center;
  justify-content: center;
}
.image-thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
.image-label {
  font-size: 10px;
  text-align: center;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
}
.thumb-wrap {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 8px;
  background: var(--color-bg-elevated);
}
.preview-thumb {
  width: 100%;
  max-height: 120px;
  object-fit: contain;
  border-radius: var(--radius-sm);
}
.enrich-msg {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  padding: 12px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius);
}
.small { font-size: 11px; }
.loading-hint { font-size: 11px; }

.ies-tab { display: flex; flex-direction: column; gap: 10px; }
.ies-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 10px;
}
.ies-card h4 { margin: 0 0 8px; font-size: 13px; }
</style>
