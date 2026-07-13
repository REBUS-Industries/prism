<script setup lang="ts">
/**
 * Shared texture library. Cards show a thumbnail (streamed from
 * /api/textures/:id/download), display name, human-readable size, tag pills
 * and how many materials reference the texture. Search is debounced into
 * `?q=`, tag pills map to `?tags=`, slot pills filter by PBR suffix (`?slot=`)
 * or group loaded rows by detected slot when "All" is selected.
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  texturesApi,
  MATERIAL_SLOTS,
  SLOT_LABELS,
  SLOT_SUFFIX_HINTS,
  textureSlotFor,
  textureMatchesSlotFilter,
  type ApiError,
  type MaterialSlot,
  type Texture,
  type TextureInUseError,
} from '../../shared/api';
import Icon from '../../shared/Icon.vue';

const PAGE = 36;

type SlotFilter = 'all' | MaterialSlot | 'other';

interface TextureSection {
  id: SlotFilter;
  label: string;
  hint?: string;
  textures: Texture[];
}

const SLOT_FILTER_LABELS: Record<MaterialSlot, string> = {
  albedo:       'Albedo',
  normal:       'Normal',
  roughness:    'Roughness',
  metallic:     'Metallic',
  ao:           'AO',
  emissive:     'Emissive',
  opacity:      'Opacity',
  displacement: 'Height / Bump',
};

const textures = ref<Texture[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const nextCursor = ref<string | null>(null);

const search = ref('');
const activeTags = ref<string[]>([]);
const activeSlotFilter = ref<SlotFilter>('all');
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const uploading = ref(false);
const uploadError = ref<string | null>(null);
const dragOver = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const editingId = ref<string | null>(null);
const editName = ref('');
const editTags = ref('');

const deleteBlock = ref<{ texture: Texture; materials: Array<{ id: string; name: string }> } | null>(null);

const cleaningUnused = ref(false);
const cleanupMessage = ref<string | null>(null);

const unusedOnPageCount = computed(() => textures.value.filter((t) => t.referenceCount === 0).length);

const availableTags = computed<string[]>(() => {
  const set = new Set<string>();
  for (const t of textures.value) for (const tag of t.tags) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
});

const displaySections = computed<TextureSection[]>(() => {
  if (activeSlotFilter.value === 'all') {
    const buckets = new Map<MaterialSlot | 'other', Texture[]>();
    for (const slot of MATERIAL_SLOTS) buckets.set(slot, []);
    buckets.set('other', []);
    for (const t of textures.value) {
      buckets.get(textureSlotFor(t))!.push(t);
    }
    const sections: TextureSection[] = [];
    for (const slot of MATERIAL_SLOTS) {
      const items = buckets.get(slot)!;
      if (items.length) {
        sections.push({
          id: slot,
          label: SLOT_LABELS[slot],
          hint: SLOT_SUFFIX_HINTS[slot],
          textures: items,
        });
      }
    }
    const other = buckets.get('other')!;
    if (other.length) {
      sections.push({
        id: 'other',
        label: 'Other / Unclassified',
        hint: 'No recognised PBR suffix',
        textures: other,
      });
    }
    return sections;
  }

  const filter = activeSlotFilter.value;
  const label = filter === 'other' ? 'Other / Unclassified' : SLOT_LABELS[filter];
  const hint = filter === 'other' ? 'No recognised PBR suffix' : SLOT_SUFFIX_HINTS[filter];
  const filtered = textures.value.filter((t) => textureMatchesSlotFilter(t, filter));
  return [{ id: filter, label, hint, textures: filtered }];
});

const hasTextures = computed(() =>
  displaySections.value.some((section) => section.textures.length > 0),
);

const isFiltered = computed(() =>
  !!search.value.trim() || activeTags.value.length > 0 || activeSlotFilter.value !== 'all',
);

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
      slot: activeSlotFilter.value === 'all' ? undefined : activeSlotFilter.value,
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

function setSlotFilter(filter: SlotFilter): void {
  if (activeSlotFilter.value === filter) return;
  activeSlotFilter.value = filter;
  void load(true);
}

async function uploadFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  if (!list.length) return;
  uploading.value = true;
  uploadError.value = null;
  try {
    for (const file of list) {
      await texturesApi.upload(file);
    }
    await load(true);
  } catch (err) {
    uploadError.value = (err as ApiError).message ?? 'upload failed';
  } finally {
    uploading.value = false;
  }
}

function onFileChosen(ev: Event): void {
  const input = ev.target as HTMLInputElement;
  if (input.files?.length) void uploadFiles(input.files);
  if (input) input.value = '';
}

function onDrop(ev: DragEvent): void {
  ev.preventDefault();
  dragOver.value = false;
  if (ev.dataTransfer?.files?.length) void uploadFiles(ev.dataTransfer.files);
}

function onDragOver(ev: DragEvent): void {
  ev.preventDefault();
  dragOver.value = true;
}

function startEdit(t: Texture): void {
  editingId.value = t.id;
  editName.value = t.displayName;
  editTags.value = t.tags.join(', ');
}

function cancelEdit(): void {
  editingId.value = null;
}

async function saveEdit(t: Texture): Promise<void> {
  const tags = editTags.value.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const updated = await texturesApi.update(t.id, { displayName: editName.value.trim() || t.displayName, tags });
    textures.value = textures.value.map((x) => (x.id === t.id ? updated : x));
    editingId.value = null;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'update failed';
  }
}

async function removeTexture(t: Texture): Promise<void> {
  if (!confirm(`Delete texture "${t.displayName}"? This cannot be undone.`)) return;
  try {
    await texturesApi.remove(t.id);
    textures.value = textures.value.filter((x) => x.id !== t.id);
  } catch (err) {
    const e = err as ApiError;
    if (e.status === 409 && e.body && typeof e.body === 'object') {
      const body = e.body as TextureInUseError;
      deleteBlock.value = { texture: t, materials: body.referencingMaterials ?? [] };
    } else {
      error.value = e.message ?? 'delete failed';
    }
  }
}

async function cleanupUnusedTextures(): Promise<void> {
  cleaningUnused.value = true;
  cleanupMessage.value = null;
  error.value = null;
  try {
    const preview = await texturesApi.cleanupUnused({ dryRun: true });
    if (!preview.deleted) {
      cleanupMessage.value = 'No unused textures to remove.';
      return;
    }
    const noun = preview.deleted === 1 ? 'texture' : 'textures';
    if (!confirm(
      `Remove ${preview.deleted} unused ${noun} from the library?\n\n`
      + 'Only textures not referenced by any material are deleted. This cannot be undone.',
    )) return;

    const res = await texturesApi.cleanupUnused();
    cleanupMessage.value = `Removed ${res.deleted} unused ${res.deleted === 1 ? 'texture' : 'textures'}.`;
    await load(true);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'cleanup failed';
  } finally {
    cleaningUnused.value = false;
  }
}

onMounted(() => void load(true));
onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });
</script>

<template>
  <div class="h-row">
    <h1 class="flex-1">Textures</h1>
    <button
      class="cleanup-btn"
      :disabled="cleaningUnused || uploading"
      :title="unusedOnPageCount ? `${unusedOnPageCount} unused on this page` : 'Remove textures not used by any material'"
      @click="cleanupUnusedTextures"
    >
      <Icon name="cleaning_services" :size="16" />
      {{ cleaningUnused ? 'Cleaning…' : 'Clean up unused' }}
    </button>
    <button class="primary" :disabled="uploading || cleaningUnused" @click="fileInput?.click()">
      <Icon name="upload" :size="16" />
      {{ uploading ? 'Uploading…' : 'Upload textures' }}
    </button>
    <input
      ref="fileInput"
      type="file"
      multiple
      accept="image/*,.tga,.exr,.hdr,.tif,.tiff"
      style="display: none;"
      @change="onFileChosen"
    />
  </div>
  <p class="muted">
    Shared texture library. Textures are reused across materials — deleting one is blocked while any material references it.
  </p>

  <div
    class="dropzone mt"
    :class="{ active: dragOver, disabled: uploading }"
    @dragover="onDragOver"
    @dragleave="dragOver = false"
    @drop="onDrop"
    @click="fileInput?.click()"
  >
    <strong v-if="uploading">Uploading…</strong>
    <strong v-else>Drop image files here, or click to choose</strong>
    <p class="subtle">PNG / JPG / TGA / EXR / HDR / TIFF · max 50&nbsp;MB each</p>
  </div>
  <div v-if="uploadError" class="error-box mt-sm">{{ uploadError }}</div>
  <div v-if="cleanupMessage" class="info-box mt-sm">{{ cleanupMessage }}</div>

  <div class="toolbar mt">
    <input
      v-model="search"
      class="flex-1"
      type="search"
      placeholder="Search by name…"
      @input="onSearchInput"
    />
  </div>

  <div class="slot-filter-row mt-sm">
    <span class="slot-filter-label">Type</span>
    <button
      type="button"
      class="slot-pill"
      :class="{ active: activeSlotFilter === 'all' }"
      @click="setSlotFilter('all')"
    >All</button>
    <button
      v-for="slot in MATERIAL_SLOTS"
      :key="slot"
      type="button"
      class="slot-pill"
      :class="{ active: activeSlotFilter === slot }"
      :title="SLOT_SUFFIX_HINTS[slot]"
      @click="setSlotFilter(slot)"
    >{{ SLOT_FILTER_LABELS[slot] }}</button>
    <button
      type="button"
      class="slot-pill"
      :class="{ active: activeSlotFilter === 'other' }"
      title="No recognised PBR suffix"
      @click="setSlotFilter('other')"
    >Other</button>
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

  <div v-if="loading && !textures.length" class="muted mt-lg">Loading…</div>
  <div v-else-if="!hasTextures" class="muted mt-lg">
    {{ isFiltered ? 'No textures match.' : 'No textures yet. Upload some above to get started.' }}
  </div>

  <template v-else>
    <section
      v-for="section in displaySections"
      :key="section.id"
      class="slot-section mt"
      :class="{ grouped: activeSlotFilter === 'all' }"
    >
      <header v-if="activeSlotFilter === 'all'" class="slot-section-head">
        <h2>{{ section.label }}</h2>
        <span class="subtle small">{{ section.textures.length }}</span>
        <span v-if="section.hint" class="subtle small slot-hint">{{ section.hint }}</span>
      </header>

      <div class="grid">
        <div v-for="t in section.textures" :key="t.id" class="card tex-card">
          <span class="thumb">
            <img :src="t.previewUrl ?? texturesApi.previewUrl(t.id)" :alt="t.displayName" loading="lazy" />
          </span>

          <template v-if="editingId === t.id">
            <input v-model="editName" class="edit-input" placeholder="Display name" />
            <input v-model="editTags" class="edit-input" placeholder="tag1, tag2" />
            <div class="card-actions">
              <button class="primary flex-1" @click="saveEdit(t)"><Icon name="save" :size="14" />Save</button>
              <button class="flex-1" @click="cancelEdit">Cancel</button>
            </div>
          </template>

          <template v-else>
            <div class="tex-name" :title="t.displayName">{{ t.displayName }}</div>
            <div class="subtle small">{{ formatBytes(t.sizeBytes) }}</div>
            <div v-if="t.tags.length" class="tags">
              <span v-for="tag in t.tags" :key="tag" class="pill tag">{{ tag }}</span>
            </div>
            <div class="ref muted small">
              {{ t.referenceCount === 0 ? 'Unused' : `Used by ${t.referenceCount} material${t.referenceCount === 1 ? '' : 's'}` }}
            </div>
            <div class="card-actions">
              <button class="flex-1" @click="startEdit(t)"><Icon name="edit" :size="14" />Edit</button>
              <button class="flex-1 danger" @click="removeTexture(t)"><Icon name="delete" :size="14" />Delete</button>
            </div>
          </template>
        </div>
      </div>
    </section>
  </template>

  <div v-if="nextCursor" class="load-more mt">
    <button :disabled="loading" @click="load(false)">{{ loading ? 'Loading…' : 'Load more' }}</button>
  </div>

  <!-- Delete blocked (409) -->
  <div v-if="deleteBlock" class="modal-backdrop" @click.self="deleteBlock = null">
    <div class="card modal">
      <h2>Can't delete “{{ deleteBlock.texture.displayName }}”</h2>
      <p class="muted">This texture is still referenced by the following materials. Remove it from them first.</p>
      <ul class="ref-list">
        <li v-for="m in deleteBlock.materials" :key="m.id">
          <RouterLink :to="{ name: 'material-editor', params: { id: m.id } }" @click="deleteBlock = null">
            {{ m.name }}
          </RouterLink>
        </li>
      </ul>
      <div class="h-row" style="justify-content: flex-end;">
        <button class="primary" @click="deleteBlock = null">Close</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
h1 { font-size: 22px; margin: 0; }
.small { font-size: 12px; }
.cleanup-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.cleanup-btn:hover:not(:disabled) {
  border-color: var(--orbit-primary);
  color: var(--orbit-primary);
}
.cleanup-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.toolbar { display: flex; gap: 8px; }
.slot-filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.slot-filter-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  margin-right: 2px;
}
.slot-pill {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg-input);
  color: var(--color-text-muted);
  cursor: pointer;
}
.slot-pill:hover {
  color: var(--color-text);
  border-color: var(--color-border);
}
.slot-pill.active {
  background: var(--orbit-primary);
  border-color: var(--orbit-primary);
  color: #fff;
}
.tag-row { display: flex; flex-wrap: wrap; gap: 6px; }
.tag-pill {
  padding: 2px 10px; font-size: 11px; border-radius: 999px;
  border: 1px solid var(--color-border-strong); background: var(--color-bg-input);
  color: var(--color-text-muted);
}
.tag-pill.active { background: var(--orbit-primary); border-color: var(--orbit-primary); color: #fff; }

.dropzone {
  border: 2px dashed var(--color-border);
  border-radius: var(--radius);
  padding: 24px 16px;
  text-align: center;
  cursor: pointer;
  transition: background 80ms, border-color 80ms;
}
.dropzone:hover { background: var(--color-bg-elevated); }
.dropzone.active { border-color: var(--orbit-primary); background: var(--orbit-primary-fade); }
.dropzone.disabled { opacity: 0.65; cursor: progress; }
.dropzone p { margin: 4px 0 0; }

.slot-section.grouped + .slot-section.grouped { margin-top: 20px; }
.slot-section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
}
.slot-section-head h2 {
  font-size: 14px;
  font-weight: 700;
  margin: 0;
}
.slot-hint { font-style: italic; }

.grid {
  display: grid; gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
}
.tex-card {
  display: flex; flex-direction: column; gap: 6px; padding: 10px;
  min-width: 0;
  overflow: hidden;
}
.thumb {
  display: block; width: 100%; aspect-ratio: 1 / 1; border-radius: var(--radius-sm);
  overflow: hidden; background: var(--color-bg-hover);
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tex-name {
  display: block;
  width: 100%;
  min-width: 0;
  font-weight: 600;
  line-height: 1.35;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.subtle.small {
  line-height: 1.35;
}
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.pill.tag {
  text-transform: none; letter-spacing: normal; font-weight: 500;
  background: var(--color-bg-hover); color: #fff;
}
.ref { margin-top: auto; }
.card-actions { display: flex; gap: 6px; }
.card-actions button { padding: 4px 8px; font-size: 12px; }
.edit-input { width: 100%; }
button.danger { color: var(--color-error); }
button.danger:hover { border-color: var(--color-error); }
.load-more { display: flex; justify-content: center; }

.modal-backdrop {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.modal { width: 460px; max-width: 100%; display: flex; flex-direction: column; gap: 12px; }
.modal h2 { font-size: 16px; margin: 0; }
.ref-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
</style>
