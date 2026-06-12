<script setup lang="ts">
/**
 * Global REBUS-tag → material assignment (route /fixtures/materials).
 *
 * Sets a default material per REBUS part tag that applies across ALL fixtures —
 * e.g. assign a material to BASE and every BASE-tagged geometry inherits it.
 * Persisted server-side (fixtures-service settings) so it's global.
 */
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import Icon from '../../shared/Icon.vue';
import { fixturesApi, materialsApi, type MaterialListItem, type ApiError } from '../../shared/api';

const REBUS_TAGS = [
  { tag: 'ORIGIN', icon: 'my_location', hint: 'Fixture reference point' },
  { tag: 'CLAMP', icon: 'precision_manufacturing', hint: 'Hanging clamp / omega bracket' },
  { tag: 'BASE', icon: 'deployed_code', hint: 'Body / base housing' },
  { tag: 'YOKE', icon: 'sync', hint: 'Pan arm' },
  { tag: 'HEAD', icon: 'visibility', hint: 'Tilting head' },
  { tag: 'LENS', icon: 'lens_blur', hint: 'Lens / front optic' },
  { tag: 'BEAM', icon: 'flare', hint: 'Light emission' },
  { tag: 'CELL', icon: 'grid_on', hint: 'Pixel / cell' },
] as const;

const materials = ref<MaterialListItem[]>([]);
const map = ref<Record<string, string | null>>({});
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const savedAt = ref<number | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [mats, tagMap] = await Promise.all([
      materialsApi.list({ limit: 500 }),
      fixturesApi.getTagMaterials(),
    ]);
    materials.value = mats.materials;
    const next: Record<string, string | null> = {};
    for (const { tag } of REBUS_TAGS) next[tag] = tagMap.map[tag] ?? null;
    map.value = next;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load materials';
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  error.value = null;
  try {
    const res = await fixturesApi.setTagMaterials(map.value);
    const next: Record<string, string | null> = {};
    for (const { tag } of REBUS_TAGS) next[tag] = res.map[tag] ?? null;
    map.value = next;
    savedAt.value = Date.now();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to save';
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="h-row">
    <RouterLink :to="{ name: 'prism-library' }" class="muted back-link"><Icon name="arrow_back" :size="14" /> PRISM Library</RouterLink>
    <h1 class="flex-1">Fixture materials</h1>
    <button class="primary" :disabled="saving || loading" @click="save">
      <Icon name="save" :size="16" />{{ saving ? 'Saving…' : 'Save' }}
    </button>
  </div>

  <p class="muted small intro">
    Assign a REBUS material to each part tag. The mapping is <strong>global</strong> — every fixture's
    geometries with that tag inherit the material (a fixture's own per-part override still wins).
  </p>

  <div v-if="loading" class="card mt"><div class="muted">Loading…</div></div>

  <section v-else class="card mt tag-list">
    <div v-for="row in REBUS_TAGS" :key="row.tag" class="tag-row">
      <span class="tag-icon"><Icon :name="row.icon" :size="18" /></span>
      <div class="tag-meta">
        <span class="tag-name">{{ row.tag }}</span>
        <span class="tag-hint">{{ row.hint }}</span>
      </div>
      <select v-model="map[row.tag]" class="mat-select">
        <option :value="null">— No material —</option>
        <option v-for="m in materials" :key="m.id" :value="m.id">{{ m.name }}</option>
      </select>
    </div>
    <p v-if="!materials.length" class="muted small">
      No materials yet — create some in <RouterLink :to="{ name: 'materials' }">Materials</RouterLink>.
    </p>
  </section>

  <p v-if="savedAt" class="muted small saved">Saved.</p>
  <div v-if="error" class="error-box mt">{{ error }}</div>
</template>

<style scoped>
.h-row { display: flex; align-items: center; gap: 12px; }
.back-link { display: inline-flex; align-items: center; gap: 4px; }
.flex-1 { flex: 1; }
.intro { margin: 8px 0 0; max-width: 720px; line-height: 1.5; }

.tag-list { display: flex; flex-direction: column; gap: 4px; padding: 8px; }
.tag-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 8px;
  border-bottom: 1px solid var(--color-border);
}
.tag-row:last-child { border-bottom: none; }
.tag-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
  flex: 0 0 auto;
}
.tag-meta { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.tag-name { font-weight: 700; font-size: 13px; letter-spacing: 0.03em; }
.tag-hint { font-size: 12px; color: var(--color-text-muted); }
.mat-select {
  min-width: 240px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-input);
  color: var(--color-text);
  font-size: 13px;
}
.saved { color: var(--color-success, #16a34a); margin-top: 8px; }
.small { font-size: 12px; }
</style>
