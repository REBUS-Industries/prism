<script setup lang="ts">
/**
 * Reusable texture-library picker. Opens as an overlay; the parent controls
 * visibility via `open` and listens for `select` (a chosen / freshly-uploaded
 * texture) and `close`. Search is debounced into `?q=`, tag pills map to
 * `?tags=`, and "Upload New" multipart-POSTs to /api/textures then emits the
 * created row straight back so the caller can assign it without a round-trip.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { texturesApi, type ApiError, type Texture } from '../../shared/api';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ select: [texture: Texture]; close: [] }>();

const PAGE = 24;

const textures = ref<Texture[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const nextCursor = ref<string | null>(null);

const search = ref('');
const activeTags = ref<string[]>([]);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const availableTags = computed<string[]>(() => {
  const set = new Set<string>();
  for (const t of textures.value) for (const tag of t.tags) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function load(reset = true): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await texturesApi.list({
      q: search.value || undefined,
      tags: activeTags.value.length ? activeTags.value : undefined,
      limit: PAGE,
      cursor: reset ? undefined : nextCursor.value,
    });
    textures.value = reset ? res.textures : [...textures.value, ...res.textures];
    nextCursor.value = res.nextCursor;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load textures';
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

function choose(t: Texture): void {
  emit('select', t);
  emit('close');
}

async function onFileChosen(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (input) input.value = '';
  if (!file) return;
  uploading.value = true;
  error.value = null;
  try {
    const tex = await texturesApi.upload(file, { displayName: file.name });
    emit('select', tex);
    emit('close');
  } catch (err) {
    error.value = (err as ApiError).message ?? 'upload failed';
  } finally {
    uploading.value = false;
  }
}

watch(() => props.open, (o) => {
  if (!o) return;
  search.value = '';
  activeTags.value = [];
  nextCursor.value = null;
  void load(true);
});

onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });
</script>

<template>
  <div v-if="open" class="picker-backdrop" @click.self="emit('close')">
    <div class="picker card">
      <header class="picker-head">
        <h2>Pick a texture</h2>
        <button class="icon-btn" type="button" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <div class="picker-toolbar">
        <input
          v-model="search"
          class="flex-1"
          type="search"
          placeholder="Search textures…"
          @input="onSearchInput"
        />
        <button class="primary" type="button" :disabled="uploading" @click="fileInput?.click()">
          {{ uploading ? 'Uploading…' : 'Upload New' }}
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="image/*,.tga,.exr,.hdr,.tif,.tiff"
          style="display: none;"
          @change="onFileChosen"
        />
      </div>

      <div v-if="availableTags.length" class="tag-row">
        <button
          v-for="tag in availableTags"
          :key="tag"
          class="tag-pill"
          :class="{ active: activeTags.includes(tag) }"
          type="button"
          @click="toggleTag(tag)"
        >{{ tag }}</button>
      </div>

      <div v-if="error" class="error-box mt-sm">{{ error }}</div>

      <div class="picker-body">
        <div v-if="loading && !textures.length" class="muted pad">Loading…</div>
        <div v-else-if="!textures.length" class="muted pad">No textures match.</div>
        <div v-else class="grid">
          <button
            v-for="t in textures"
            :key="t.id"
            class="tex-card"
            type="button"
            :title="t.displayName"
            @click="choose(t)"
          >
            <span class="thumb">
              <img :src="texturesApi.downloadUrl(t.id)" :alt="t.displayName" loading="lazy" />
            </span>
            <span class="tex-name">{{ t.displayName }}</span>
            <span class="tex-meta subtle">{{ formatBytes(t.sizeBytes) }}</span>
          </button>
        </div>
      </div>

      <footer v-if="nextCursor" class="picker-foot">
        <button type="button" :disabled="loading" @click="load(false)">
          {{ loading ? 'Loading…' : 'Load more' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.picker-backdrop {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.picker {
  width: 880px; max-width: 100%; max-height: 88vh;
  display: flex; flex-direction: column; gap: 12px;
  background: var(--color-bg-elevated);
}
.picker-head { display: flex; align-items: center; justify-content: space-between; }
.picker-head h2 { font-size: 16px; margin: 0; }
.picker-toolbar { display: flex; align-items: center; gap: 8px; }
.tag-row { display: flex; flex-wrap: wrap; gap: 6px; }
.tag-pill {
  padding: 2px 10px; font-size: 11px; border-radius: 999px;
  border: 1px solid var(--color-border-strong); background: var(--color-bg-input);
  color: var(--color-text-muted);
}
.tag-pill.active { background: var(--orbit-primary); border-color: var(--orbit-primary); color: #fff; }
.picker-body { overflow: auto; flex: 1; min-height: 160px; }
.pad { padding: 32px; text-align: center; }
.grid {
  display: grid; gap: 10px;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
}
.tex-card {
  display: flex; flex-direction: column; gap: 4px; padding: 6px;
  border: 1px solid var(--color-border); border-radius: var(--radius);
  background: var(--color-bg-input); text-align: left; cursor: pointer;
}
.tex-card:hover { border-color: var(--orbit-primary); }
.thumb {
  display: block; aspect-ratio: 1 / 1; border-radius: var(--radius-sm);
  overflow: hidden; background: var(--color-bg-hover);
  background-image:
    linear-gradient(45deg, var(--color-bg-hover) 25%, transparent 25%),
    linear-gradient(-45deg, var(--color-bg-hover) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--color-bg-hover) 75%),
    linear-gradient(-45deg, transparent 75%, var(--color-bg-hover) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tex-name {
  font-size: 12px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tex-meta { font-size: 11px; }
.picker-foot { display: flex; justify-content: center; }
</style>
