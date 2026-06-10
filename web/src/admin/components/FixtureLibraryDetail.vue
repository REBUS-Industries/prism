<script setup lang="ts">
import { computed, ref, watch } from 'vue';
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
import { parseWheels } from '../utils/gdtfDebugExport';

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

const FIXTURE_TYPES = ['Spot', 'Wash', 'Beam', 'Profile', 'Moving Head', 'LED', 'Strobe', 'Other'];

type DetailTab = '3d' | 'overview' | 'dmx' | 'wheels' | 'source' | 'images';
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

const hasMetadata = computed(() => {
  if (definition.value?.metadata && Object.keys(definition.value.metadata).length > 0) return true;
  return !!(props.entry?.creator || props.entry?.uploader || selectedVersion.value?.creator);
});

const badges = computed(() => {
  const hasLocal = !!props.localFixture;
  const has3d = props.localFixture?.hasPreview ?? false;
  const hasDmx = (props.entry?.modes?.length ?? 0) > 0
    || (Array.isArray(definition.value?.dmxMapping?.modes)
      && (definition.value!.dmxMapping.modes as unknown[]).length > 0);
  const hasWheels = wheelRows.value.length > 0
    || (props.entry?.modes?.length ?? 0) > 0;
  return [
    { label: 'Full data', ok: hasLocal },
    { label: '3D', ok: has3d },
    { label: 'DMX', ok: hasDmx },
    { label: 'Wheels', ok: hasLocal && wheelRows.value.length > 0 },
    { label: 'Metadata', ok: hasMetadata },
  ];
});

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

const fixtureType = computed(() => {
  const tags = props.localFixture?.tags ?? [];
  const match = tags.find((t) => FIXTURE_TYPES.some((ft) => ft.toLowerCase() === t.toLowerCase()));
  if (match) return match;
  if (tags.length) return tags[0];
  return 'Spot';
});

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
      true,
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
    <p class="detail-sub muted">{{ entry.manufacturer }}</p>

    <div class="icon-actions">
      <button type="button" class="icon-action" title="Preview" disabled>👁</button>
      <button
        type="button"
        class="icon-action"
        title="Download & import"
        :disabled="importing || !selectedVersion"
        @click="emit('import')"
      >⬇</button>
      <button
        v-if="localFixture"
        type="button"
        class="icon-action"
        title="Edit"
        @click="emit('edit', localFixture.id)"
      >✎</button>
      <RouterLink
        v-if="localFixture"
        :to="{ name: 'fixture-debug', params: { id: localFixture.id } }"
        class="icon-action debug-link"
        title="Debug GDTF 3D"
      >⚙</RouterLink>
      <span
        v-else
        class="icon-action disabled-tip"
        title="Import fixture first"
      >⚙</span>
      <button
        v-if="localFixture"
        type="button"
        class="icon-action danger"
        title="Delete"
        @click="emit('delete', localFixture)"
      >🗑</button>
    </div>

    <button
      class="download-primary"
      :disabled="importing || !selectedVersion || !!localFixture"
      @click="emit('import')"
    >
      {{ importing ? 'Downloading…' : localFixture ? 'Downloaded' : 'Download' }}
    </button>

    <div class="badge-row">
      <span
        v-for="b in badges"
        :key="b.label"
        class="status-badge"
        :class="b.ok ? 'ok' : 'missing'"
      >{{ b.label }}</span>
    </div>

    <div class="type-block">
      <label class="type-label">Type</label>
      <select class="type-select" :value="fixtureType" disabled>
        <option v-for="t in FIXTURE_TYPES" :key="t" :value="t">{{ t }}</option>
      </select>
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
        <span v-if="selectedVersion.rating"> · ★ {{ selectedVersion.rating }}</span>
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
        v-for="tab in ([
          ['3d', '3D'],
          ['overview', 'Overview'],
          ['dmx', 'DMX'],
          ['wheels', 'Wheels'],
          ['source', 'Source'],
          ['images', 'Images'],
        ] as const)"
        :key="tab[0]"
        type="button"
        class="detail-tab"
        :class="{ active: activeTab === tab[0] }"
        @click="activeTab = tab[0]"
      >{{ tab[1] }}</button>
    </nav>

    <div class="tab-content">
      <FixtureQuadPreview
        v-if="activeTab === '3d'"
        :preview-url="previewUrl"
        :fixture-name="entry.fixture"
        :record-count="meshRecordCount || undefined"
      />

      <div v-else-if="activeTab === 'overview'" class="overview-tab">
        <dl class="overview-meta">
          <dt>Brand</dt>
          <dd>{{ definition?.fixtureInformation.manufacturer ?? entry.manufacturer }}</dd>
          <dt>Fixture type</dt>
          <dd>{{ fixtureType }}</dd>
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
          <span v-for="b in badges.filter((x) => x.ok)" :key="b.label" class="meta-pill">{{ b.label }}</span>
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
        compact
      />

      <div v-else-if="activeTab === 'wheels'" class="wheels-tab">
        <template v-if="localDetail && wheelRows.length">
          <div v-for="wheel in wheelRows" :key="wheel.wheelId" class="wheel-card">
            <header class="wheel-head">
              <h4>{{ wheel.wheelName }}</h4>
              <span class="wheel-type-pill">{{ wheel.wheelType }}</span>
            </header>
            <table class="wheel-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Slot</th>
                  <th>Type</th>
                  <th>DMX</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="slot in wheel.slots" :key="`${wheel.wheelId}-${slot.slotIndex}`">
                  <td class="mono">{{ slot.slotIndex }}</td>
                  <td>{{ slot.slotName }}</td>
                  <td><span class="slot-pill" :class="wheelKind(slot.mediaType).toLowerCase()">{{ wheelKind(slot.mediaType) }}</span></td>
                  <td class="mono muted">
                    <template v-if="slot.dmxFrom != null">{{ slot.dmxFrom }}<template v-if="slot.dmxTo != null">–{{ slot.dmxTo }}</template></template>
                    <template v-else>—</template>
                  </td>
                </tr>
              </tbody>
            </table>
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
        <dl class="overview-meta">
          <dt>UUID</dt>
          <dd class="mono">{{ entry.uuid }}</dd>
          <dt>Hash</dt>
          <dd class="mono">{{ localFixture?.sourceGdtfHash ?? '—' }}</dd>
          <dt>File size</dt>
          <dd>
            <template v-if="selectedVersion?.filesize">
              {{ (selectedVersion.filesize / 1024 / 1024).toFixed(2) }} MB
            </template>
            <template v-else>—</template>
          </dd>
          <dt>Creator</dt>
          <dd>{{ entry.creator ?? selectedVersion?.creator ?? '—' }}</dd>
          <dt>Uploader</dt>
          <dd>{{ entry.uploader ?? selectedVersion?.uploader ?? '—' }}</dd>
        </dl>
        <section v-if="entry.versions.length" class="revision-list">
          <h4 class="sub-label">Revisions</h4>
          <ul>
            <li v-for="v in entry.versions" :key="v.rid" class="revision-item">
              <span class="mono">rid {{ v.rid }}</span>
              <span>{{ formatVersionLabel(v) }}</span>
              <span v-if="v.filesize" class="muted">{{ (v.filesize / 1024 / 1024).toFixed(1) }} MB</span>
            </li>
          </ul>
        </section>
      </div>

      <div v-else class="images-tab">
        <div v-if="previewUrl" class="thumb-wrap">
          <FixtureQuadPreview :preview-url="previewUrl" :fixture-name="entry.fixture" />
          <p class="muted small">3D preview available — product photos not linked.</p>
        </div>
        <p class="enrich-msg muted">
          Product photos not available for this entry.
          Use <strong>Enrich missing photos</strong> in the library toolbar when catalog images are linked.
        </p>
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

.download-primary {
  width: 100%;
  padding: 10px 16px;
  border: none;
  border-radius: var(--radius);
  background: var(--orbit-primary);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
}
.download-primary:hover:not(:disabled) { background: var(--orbit-primary-hover); }
.download-primary:disabled { opacity: 0.55; cursor: not-allowed; }

.badge-row { display: flex; flex-wrap: wrap; gap: 6px; }
.status-badge {
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.status-badge.ok { background: var(--color-success-bg); color: var(--color-success); }
.status-badge.missing { background: var(--color-warn-bg); color: var(--color-warn); }

.type-block { margin-top: 2px; }
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

.source-tab { display: flex; flex-direction: column; gap: 12px; }
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
</style>
