<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { fixturesApi, type ApiError, type FixtureListItem } from '../../shared/api';

const router = useRouter();
const PAGE = 36;

const fixtures = ref<FixtureListItem[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const nextCursor = ref<string | null>(null);
const search = ref('');
const activeTags = ref<string[]>([]);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const showCreate = ref(false);
const newName = ref('');
const creating = ref(false);

const availableTags = computed(() => {
  const set = new Set<string>();
  for (const f of fixtures.value) for (const t of f.tags) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
});

async function load(reset = true): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await fixturesApi.list({
      q: search.value || undefined,
      tags: activeTags.value.length ? activeTags.value : undefined,
      limit: PAGE,
      cursor: reset ? undefined : nextCursor.value,
    });
    fixtures.value = reset ? res.fixtures : [...fixtures.value, ...res.fixtures];
    nextCursor.value = res.nextCursor;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load fixtures';
  } finally {
    loading.value = false;
  }
}

function onSearchInput(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void load(true), 300);
}

function toggleTag(tag: string): void {
  activeTags.value = activeTags.value.includes(tag)
    ? activeTags.value.filter((t) => t !== tag)
    : [...activeTags.value, tag];
  void load(true);
}

function openEditor(id: string): void {
  void router.push({ name: 'fixture-editor', params: { id } });
}

async function createBlank(): Promise<void> {
  const name = newName.value.trim();
  if (!name) return;
  creating.value = true;
  try {
    const created = await fixturesApi.create({ name });
    showCreate.value = false;
    newName.value = '';
    openEditor(created.fixture.id);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'create failed';
  } finally {
    creating.value = false;
  }
}

async function removeFixture(f: FixtureListItem): Promise<void> {
  if (!confirm(`Delete fixture "${f.name}"?`)) return;
  try {
    await fixturesApi.remove(f.id);
    fixtures.value = fixtures.value.filter((x) => x.id !== f.id);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'delete failed';
  }
}

onMounted(() => void load(true));
onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });
</script>

<template>
  <div class="h-row">
    <h1 class="flex-1">Fixtures</h1>
    <RouterLink :to="{ name: 'fixture-import' }"><button>Import GDTF</button></RouterLink>
    <RouterLink :to="{ name: 'mvr-import' }"><button>MVR import</button></RouterLink>
    <button class="primary" @click="showCreate = true">+ Blank fixture</button>
  </div>
  <p class="muted">Lighting fixture types from GDTF. Instances are created via MVR import or connectors.</p>

  <div class="toolbar mt">
    <input v-model="search" class="flex-1" type="search" placeholder="Search fixtures…" @input="onSearchInput" />
  </div>
  <div v-if="availableTags.length" class="tag-row mt-sm">
    <button
      v-for="tag in availableTags"
      :key="tag"
      class="tag-pill"
      :class="{ active: activeTags.includes(tag) }"
      type="button"
      @click="toggleTag(tag)"
    >{{ tag }}</button>
  </div>

  <div v-if="error" class="error-box mt">{{ error }}</div>
  <div v-if="loading && !fixtures.length" class="muted mt-lg">Loading…</div>
  <div v-else-if="!fixtures.length" class="muted mt-lg">No fixtures yet.</div>

  <div v-else class="grid mt">
    <div v-for="f in fixtures" :key="f.id" class="card mat-card" @click="openEditor(f.id)">
      <span class="thumb subtle">{{ f.hasPreview ? 'GLB preview' : 'No preview' }}</span>
      <div class="mat-name" :title="f.name">{{ f.name }}</div>
      <div class="muted small">{{ f.manufacturer }} · {{ f.fixtureName }}</div>
      <div v-if="f.tags.length" class="tags">
        <span v-for="tag in f.tags" :key="tag" class="pill tag">{{ tag }}</span>
      </div>
      <div class="mat-foot">
        <span class="pill">{{ f.status }}</span>
        <button class="danger" @click.stop="removeFixture(f)">Delete</button>
      </div>
    </div>
  </div>

  <div v-if="nextCursor" class="load-more mt">
    <button :disabled="loading" @click="load(false)">{{ loading ? 'Loading…' : 'Load more' }}</button>
  </div>

  <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false">
    <div class="card modal">
      <h2>New fixture type</h2>
      <input v-model="newName" placeholder="Display name" @keyup.enter="createBlank" />
      <div class="h-row" style="justify-content: flex-end;">
        <button @click="showCreate = false">Cancel</button>
        <button class="primary" :disabled="creating" @click="createBlank">Create</button>
      </div>
    </div>
  </div>
</template>
