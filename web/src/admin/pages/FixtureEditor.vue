<script setup lang="ts">

import { computed, onMounted, ref } from 'vue';

import { RouterLink, useRouter } from 'vue-router';

import FixtureQuadPreview from '../components/FixtureQuadPreview.vue';

import FixturePartTree from '../components/FixturePartTree.vue';

import DmxModePanel from '../components/DmxModePanel.vue';

import IesUploader from '../components/IesUploader.vue';

import DatumEditor from '../components/DatumEditor.vue';

import {

  fixturesApi,

  materialsApi,

  type ApiError,

  type FixtureDetail,

  type FixturePart,

  type Vec3,

} from '../../shared/api';



const props = defineProps<{ id: string }>();

const router = useRouter();



const fixture = ref<FixtureDetail | null>(null);

const loading = ref(true);

const error = ref<string | null>(null);

const saving = ref(false);

const selectedPartId = ref<string | null>(null);

const activeTab = ref<'overview' | 'dmx' | 'parts' | 'ies' | 'settings'>('overview');



const name = ref('');

const tags = ref('');

const status = ref('draft');



const previewUrl = computed(() =>

  fixture.value?.hasPreview ? fixturesApi.previewUrl(fixture.value.id) : null,

);



const info = computed(() => fixture.value?.definition.fixtureInformation);



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



onMounted(() => void reload());

</script>



<template>

  <div v-if="loading" class="muted">Loading…</div>

  <div v-else-if="error && !fixture" class="error-box">{{ error }}</div>

  <template v-else-if="fixture">

    <div class="editor-shell">

      <header class="editor-head">

        <RouterLink :to="{ name: 'fixtures' }" class="back muted">← Fixture library</RouterLink>

        <div class="head-main">

          <div>

            <h1>{{ fixture.name }}</h1>

            <p class="head-meta muted">

              {{ info?.manufacturer }} · {{ info?.fixtureName }}

              <span v-if="info?.revision"> · v{{ info.revision }}</span>

            </p>

          </div>

          <div class="head-actions">

            <button :disabled="saving" class="primary" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>

            <button class="danger" @click="removeFixture">Delete</button>

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

          <FixtureQuadPreview :preview-url="previewUrl" :fixture-name="info?.fixtureName" />

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

        <section class="panel-card">

          <h2>Part hierarchy</h2>

          <FixturePartTree

            :parts="fixture.definition.parts"

            :selected-id="selectedPartId"

            @select="selectedPartId = $event"

          />

        </section>

        <section class="panel-card">

          <h2>Pivot / datum</h2>

          <DatumEditor :part="selectedPart" @update="updatePivot" />

        </section>

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

.head-actions { display: flex; gap: 8px; flex-shrink: 0; }



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

  grid-template-columns: 1fr 1fr;

  gap: 16px;

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

}

</style>

