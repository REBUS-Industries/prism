<script setup lang="ts">

import { computed, onMounted, ref } from 'vue';

import { RouterLink, useRouter } from 'vue-router';

import FixtureQuadPreview from '../components/FixtureQuadPreview.vue';

import FixturePartTree from '../components/FixturePartTree.vue';

import FixturePartProperties from '../components/FixturePartProperties.vue';

import FixtureViewer from '../components/FixtureViewer.vue';

import DmxModePanel from '../components/DmxModePanel.vue';

import IesUploader from '../components/IesUploader.vue';

import DatumEditor from '../components/DatumEditor.vue';

import Icon from '../../shared/Icon.vue';

import {

  fixturesApi,

  materialsApi,

  type ApiError,

  type FixtureDetail,

  type FixturePart,

  type FixtureUpdateCheck,

  type FixtureVersionSummary,

  type Vec3,

} from '../../shared/api';



const props = defineProps<{ id: string }>();

const router = useRouter();



const fixture = ref<FixtureDetail | null>(null);

const loading = ref(true);

const error = ref<string | null>(null);

const saving = ref(false);

const selectedPartId = ref<string | null>(null);

const assemblyRevision = ref(0);

const activeTab = ref<'overview' | 'dmx' | 'parts' | 'ies' | 'settings'>('overview');



const name = ref('');

const tags = ref('');

const status = ref('draft');

const updateCheck = ref<FixtureUpdateCheck | null>(null);

const checkingUpdates = ref(false);

const applyingUpdate = ref(false);

const switchingVersion = ref(false);

const carryReport = ref<string[]>([]);



const previewUrl = computed(() =>

  fixture.value?.hasPreview ? fixturesApi.previewUrl(fixture.value.id) : null,

);

const assembly = computed(() => {
  const def = fixture.value?.definition;
  const id = fixture.value?.id;
  if (!def || !id || !def.parts?.length) return null;
  return { fixtureId: id, parts: def.parts, models: def.models ?? [], motionAxes: def.motionRig ?? [] };
});



const info = computed(() => fixture.value?.definition.fixtureInformation);

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
    const res = await fixturesApi.downloadVersion(props.id, updateCheck.value.latestRid, true);
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

async function onSwitchStoredVersion(versionId: string): Promise<void> {
  switchingVersion.value = true;
  carryReport.value = [];
  try {
    const res = await fixturesApi.switchActiveVersion(props.id, versionId);
    fixture.value = res.fixture;
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



const selectedPart = computed<FixturePart | null>(() => {

  if (!fixture.value || !selectedPartId.value) return null;

  return fixture.value.definition.parts.find((p) => p.partId === selectedPartId.value) ?? null;

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



async function reload(): Promise<void> {

  loading.value = true;

  error.value = null;

  try {

    const res = await fixturesApi.get(props.id);

    fixture.value = res.fixture;

    name.value = res.fixture.name;

    tags.value = res.fixture.tags.join(', ');

    status.value = res.fixture.status;

    if (!selectedPartId.value && res.fixture.definition.parts[0]) {

      selectedPartId.value = res.fixture.definition.parts[0].partId;

    }

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

    const res = await fixturesApi.update(props.id, {

      name: name.value.trim(),

      tags: tags.value.split(',').map((s) => s.trim()).filter(Boolean),

      status: status.value,

      definition: fixture.value.definition,

    });

    fixture.value = res.fixture;

  } catch (err) {

    error.value = (err as ApiError).message ?? 'save failed';

  } finally {

    saving.value = false;

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

  void router.push({ name: 'fixtures' });

}



onMounted(() => {
  void reload();
  void checkForUpdates();
});

</script>



<template>

  <div v-if="loading" class="muted">Loading…</div>

  <div v-else-if="error && !fixture" class="error-box">{{ error }}</div>

  <template v-else-if="fixture">

    <div class="editor-shell">

      <header class="editor-head">

        <RouterLink :to="{ name: 'fixtures' }" class="back muted"><Icon name="arrow_back" :size="14" /> Fixture library</RouterLink>

        <div class="head-main">

          <div>

            <h1>{{ fixture.name }}</h1>

            <p class="head-meta muted">

              {{ info?.manufacturer }} · {{ info?.fixtureName }}

              <span v-if="info?.revision"> · v{{ info.revision }}</span>

            </p>

            <div v-if="storedVersions.length" class="version-bar">
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

            <RouterLink
              :to="{ name: 'fixture-debug', params: { id: fixture.id } }"
              class="btn-debug"
            >Debug GDTF 3D</RouterLink>

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

        </div>

      </header>



      <nav class="tab-bar">

        <button

          v-for="tab in ([

            ['overview', 'Overview'],

            ['dmx', 'DMX'],

            ['parts', 'Parts'],

            ['ies', 'IES'],

            ['settings', 'Settings'],

          ] as const)"

          :key="tab[0]"

          type="button"

          class="tab-btn"

          :class="{ active: activeTab === tab[0] }"

          @click="activeTab = tab[0]"

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

            <dt>Brand</dt><dd>{{ info?.manufacturer ?? '—' }}</dd>

            <dt>Fixture</dt><dd>{{ info?.fixtureName ?? '—' }}</dd>

            <dt>Revision</dt><dd>{{ info?.revision ?? fixture.revision ?? '—' }}</dd>

            <dt>Status</dt><dd>{{ fixture.status }}</dd>

            <dt>Source hash</dt><dd class="mono">{{ fixture.sourceGdtfHash?.slice(0, 16) ?? '—' }}</dd>

          </dl>

          <p v-if="info?.description" class="desc muted">{{ info.description }}</p>

        </section>

      </div>



      <div v-else-if="activeTab === 'dmx'" class="tab-panel">

        <DmxModePanel

          :dmx-mapping="fixture.definition.dmxMapping"

          :fixture-name="info?.fixtureName"

          :manufacturer="info?.manufacturer"

        />

      </div>



      <div v-else-if="activeTab === 'parts'" class="tab-panel parts-panel">

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

            <FixtureViewer

              v-if="previewUrl || assembly"

              :url="previewUrl"

              :assembly="assembly"

              :assembly-revision="assemblyRevision"

              :datums="datumMarkers"

              fill

              light-background

              @select-datum="selectedPartId = $event"

            />

            <p v-else class="muted no-preview">No 3D preview available.</p>

          </div>

        </section>

        <aside class="panel-card parts-props-card">

          <FixturePartProperties

            :part="selectedPart"

            :models="fixture.definition.models"

            @change="onGeometryChange"

          />

          <details class="datum-block">

            <summary>Pivot / datum</summary>

            <DatumEditor :part="selectedPart" @update="updatePivot" />

          </details>

        </aside>

      </div>



      <div v-else-if="activeTab === 'ies'" class="tab-panel">

        <section class="panel-card">

          <h2>IES profiles (per beam)</h2>

          <IesUploader :fixture-id="fixture.id" :beams="fixture.definition.beams" @uploaded="reload" />

          <ul class="beam-list">

            <li v-for="b in fixture.definition.beams" :key="b.beamId">

              <span>{{ b.beamId }}</span>

              <span v-if="b.iesAssetId" class="pill online">IES attached</span>

              <span v-else class="pill muted-pill">No IES</span>

            </li>

          </ul>

        </section>

      </div>



      <div v-else class="tab-panel">

        <section class="panel-card settings-card">

          <h2>Metadata</h2>

          <label>Name <input v-model="name" /></label>

          <label>Tags <input v-model="tags" placeholder="comma-separated" /></label>

          <label>Status

            <select v-model="status">

              <option value="draft">draft</option>

              <option value="published">published</option>

            </select>

          </label>

          <button class="mt-sm" @click="assignDefaultMaterials">Assign default materials to empty parts</button>

        </section>

      </div>



      <div v-if="error" class="error-box mt">{{ error }}</div>

    </div>

  </template>

</template>



<style scoped>

.editor-shell {

  display: flex;

  flex-direction: column;

  gap: 16px;

  min-height: calc(100vh - 48px);

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

.head-actions { display: flex; gap: 8px; flex-shrink: 0; align-items: center; }

.btn-debug {
  padding: 8px 14px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  text-decoration: none;
  white-space: nowrap;
}
.btn-debug:hover {
  border-color: var(--orbit-primary);
  background: var(--orbit-primary-fade);
  color: var(--orbit-primary);
}



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



.tab-panel { flex: 1; }

.overview-panel {

  display: grid;

  grid-template-columns: 1.2fr 0.8fr;

  gap: 16px;

}

.preview-card, .info-card, .panel-card {

  border: 1px solid var(--color-border);

  border-radius: var(--radius-lg);

  padding: 16px;

  background: var(--color-bg);

}

.preview-card {

  min-height: 0;

  overflow: hidden;

}

.preview-caption { margin: 8px 0 0; }

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

  display: grid;

  grid-template-columns: 220px 1fr 280px;

  gap: 16px;

  min-height: 480px;

}

.parts-tree-card,

.parts-props-card {

  overflow-y: auto;

  max-height: calc(100vh - 220px);

}

.parts-viewport-card {

  display: flex;

  flex-direction: column;

  min-height: 0;

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

  flex: 1;

  min-height: 360px;

  border: 1px solid var(--color-border);

  border-radius: var(--radius-sm);

  overflow: hidden;

  contain: strict;

}

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



@media (max-width: 960px) {

  .overview-panel, .parts-panel { grid-template-columns: 1fr; }

  .parts-tree-card, .parts-props-card { max-height: none; }

}

</style>

