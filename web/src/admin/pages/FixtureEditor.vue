<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import FixtureViewer from '../components/FixtureViewer.vue';
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

const name = ref('');
const tags = ref('');
const status = ref('draft');

const previewUrl = computed(() =>
  fixture.value?.hasPreview ? fixturesApi.previewUrl(fixture.value.id) : null,
);

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
    <div class="h-row">
      <RouterLink :to="{ name: 'fixtures' }" class="muted">← Library</RouterLink>
      <h1 class="flex-1">{{ fixture.name }}</h1>
      <button :disabled="saving" class="primary" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>
      <button class="danger" @click="removeFixture">Delete</button>
    </div>

    <div class="editor-grid mt">
      <section class="panel">
        <h2>Metadata</h2>
        <label>Name <input v-model="name" /></label>
        <label>Tags <input v-model="tags" placeholder="comma-separated" /></label>
        <label>Status
          <select v-model="status">
            <option value="draft">draft</option>
            <option value="published">published</option>
          </select>
        </label>
        <p class="muted small">
          {{ fixture.definition.fixtureInformation.manufacturer }}
          · {{ fixture.definition.fixtureInformation.fixtureName }}
          <span v-if="fixture.definition.fixtureInformation.revision">
            · rev {{ fixture.definition.fixtureInformation.revision }}
          </span>
        </p>
        <button class="mt-sm" @click="assignDefaultMaterials">Assign default materials to empty parts</button>
      </section>

      <section class="panel preview-panel">
        <h2>3D preview</h2>
        <FixtureViewer
          :url="previewUrl"
          :datums="datumMarkers"
          @select-datum="selectedPartId = $event"
        />
      </section>

      <section class="panel">
        <h2>Parts</h2>
        <FixturePartTree
          :parts="fixture.definition.parts"
          :selected-id="selectedPartId"
          @select="selectedPartId = $event"
        />
        <DatumEditor :part="selectedPart" @update="updatePivot" />
      </section>

      <section class="panel">
        <h2>DMX modes</h2>
        <DmxModePanel :dmx-mapping="fixture.definition.dmxMapping" />
      </section>

      <section class="panel">
        <h2>IES (per beam)</h2>
        <IesUploader :fixture-id="fixture.id" :beams="fixture.definition.beams" @uploaded="reload" />
        <ul class="beam-list mt-sm">
          <li v-for="b in fixture.definition.beams" :key="b.beamId">
            {{ b.beamId }}
            <span v-if="b.iesAssetId" class="pill online">IES attached</span>
          </li>
        </ul>
      </section>
    </div>
    <div v-if="error" class="error-box mt">{{ error }}</div>
  </template>
</template>

<style scoped>
.editor-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.panel {
  padding: 12px;
  border: 1px solid var(--border, #333);
  border-radius: 8px;
}
.preview-panel { grid-column: span 2; }
label { display: block; margin-top: 8px; font-size: 13px; }
.beam-list { list-style: none; padding: 0; margin: 0; font-size: 13px; }
.beam-list li { padding: 4px 0; display: flex; gap: 8px; align-items: center; }
</style>
