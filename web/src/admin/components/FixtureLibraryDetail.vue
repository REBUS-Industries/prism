<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  fixturesApi,
  type FixtureDetail,
  type FixtureListItem,
  type GdtfShareCatalogEntry,
  type GdtfShareRevision,
} from '../../shared/api';
import DmxModePanel from './DmxModePanel.vue';
import FixtureQuadPreview from './FixtureQuadPreview.vue';

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
}>();

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

const badges = computed(() => {
  const hasLocal = !!props.localFixture;
  const has3d = props.localFixture?.hasPreview ?? false;
  const hasDmx = (props.entry?.modes?.length ?? 0) > 0
    || (Array.isArray(localDetail.value?.definition.dmxMapping?.modes)
      && (localDetail.value!.definition.dmxMapping.modes as unknown[]).length > 0);
  const hasWheels = (localDetail.value?.definition.wheels.length ?? 0) > 0;
  return [
    { label: 'Full data', ok: hasLocal },
    { label: '3D', ok: has3d },
    { label: 'DMX', ok: hasDmx },
    { label: 'Wheels', ok: hasWheels },
  ];
});

const dmxMapping = computed(() => {
  if (localDetail.value?.definition.dmxMapping) {
    return localDetail.value.definition.dmxMapping;
  }
  const modes = props.entry?.modes ?? [];
  if (!modes.length) return { modes: [] };
  return {
    modes: modes.map((m, i) => ({
      name: m.name,
      footprint: m.dmxfootprint,
      channels: [],
    })),
  };
});

const typeTags = computed(() => {
  const tags = props.localFixture?.tags ?? [];
  if (tags.length) return tags;
  return props.entry?.modes?.length ? ['DMX'] : [];
});

function formatVersionLabel(v: GdtfShareRevision): string {
  const parts = [v.revision, v.version ? `GDTF ${v.version}` : null, v.creator ? `by ${v.creator}` : null]
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : `Revision ${v.rid}`;
}

function formatDate(ts?: string): string {
  if (!ts) return '—';
  const n = parseInt(ts, 10);
  if (!n) return ts;
  return new Date(n * 1000).toLocaleDateString();
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
    if (id) void loadLocalDetail(id);
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
    <p class="detail-uuid mono">{{ entry.uuid }}</p>
    <p v-if="selectedVersion" class="detail-version muted">
      {{ formatVersionLabel(selectedVersion) }}
    </p>

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

    <dl class="meta-grid">
      <dt>Brand</dt><dd>{{ entry.manufacturer }}</dd>
      <dt>ID</dt><dd>{{ selectedVersion?.revision ?? entry.uuid.slice(0, 8) }}</dd>
      <dt v-if="typeTags.length">Type</dt>
      <dd v-if="typeTags.length" class="type-tags">
        <span v-for="tag in typeTags" :key="tag" class="type-tag">{{ tag }}</span>
      </dd>
    </dl>

    <div class="version-block">
      <label class="version-label">GDTF version / revision</label>
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
      />

      <div v-else-if="activeTab === 'overview'" class="overview-tab">
        <FixtureQuadPreview :preview-url="previewUrl" :fixture-name="entry.fixture" />
        <dl class="overview-meta">
          <dt>Manufacturer</dt><dd>{{ entry.manufacturer }}</dd>
          <dt>Creator</dt><dd>{{ entry.creator ?? '—' }}</dd>
          <dt>Uploader</dt><dd>{{ entry.uploader ?? '—' }}</dd>
          <dt>Modes</dt><dd>{{ entry.modes?.length ?? 0 }}</dd>
          <dt v-if="localFixture">Local status</dt>
          <dd v-if="localFixture">{{ localFixture.status }}</dd>
        </dl>
      </div>

      <DmxModePanel
        v-else-if="activeTab === 'dmx'"
        :dmx-mapping="dmxMapping"
        :fixture-name="entry.fixture"
        :manufacturer="entry.manufacturer"
        compact
      />

      <div v-else-if="activeTab === 'wheels'" class="stub-tab muted">
        <template v-if="localDetail?.definition.wheels.length">
          {{ localDetail.definition.wheels.length }} wheel(s) defined in local fixture.
        </template>
        <template v-else>Wheel data available after download.</template>
      </div>

      <div v-else-if="activeTab === 'source'" class="stub-tab">
        <dl class="overview-meta">
          <dt>UUID</dt><dd class="mono">{{ entry.uuid }}</dd>
          <dt>Creator</dt><dd>{{ entry.creator ?? '—' }}</dd>
          <dt v-if="localFixture">Source hash</dt>
          <dd v-if="localFixture" class="mono">{{ localFixture.sourceGdtfHash?.slice(0, 24) ?? '—' }}</dd>
        </dl>
      </div>

      <div v-else class="stub-tab muted">
        Photo enrichment coming soon.
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
.detail-uuid {
  margin: 0;
  font-size: 10px;
  word-break: break-all;
  color: var(--color-text-subtle);
}
.detail-version { margin: 0; font-size: 12px; }
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
}
.icon-action:hover:not(:disabled) { border-color: var(--orbit-primary); }
.icon-action.danger:hover:not(:disabled) { border-color: var(--color-error); }
.icon-action:disabled { opacity: 0.4; cursor: not-allowed; }

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
.status-badge.missing { background: var(--color-error-bg); color: var(--color-error); }

.meta-grid {
  display: grid;
  grid-template-columns: 56px 1fr;
  gap: 4px 8px;
  margin: 0;
  font-size: 12px;
}
.meta-grid dt { color: var(--color-text-muted); margin: 0; }
.meta-grid dd { margin: 0; }
.type-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.type-tag {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--orbit-primary-fade);
  color: var(--orbit-primary);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}

.version-block { margin-top: 4px; }
.version-label {
  display: block;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  margin-bottom: 4px;
}
.version-select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-input);
  color: var(--color-text);
  font-size: 12px;
}
.version-meta { margin: 4px 0 0; font-size: 11px; }

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
.stub-tab { padding: 16px 0; font-size: 13px; }
.loading-hint { font-size: 11px; }
</style>
