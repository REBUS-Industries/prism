<script setup lang="ts">
/**
 * Shared texture library. Cards show a thumbnail (streamed from
 * /api/textures/:id/download), display name, human-readable size, tag pills
 * and how many materials reference the texture. Search is debounced into
 * `?q=`, tag pills map to `?tags=`, and the drop-zone multipart-POSTs new
 * textures. Display name + tags are editable inline (PUT); deletes are
 * refused with a 409 when a material still references the texture, in which
 * case we surface the blocking materials.
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  texturesApi,
  type ApiError,
  type Texture,
  type TextureInUseError,
} from '../../shared/api';

const PAGE = 36;

const textures = ref<Texture[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const nextCursor = ref<string | null>(null);

const search = ref('');
const activeTags = ref<string[]>([]);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const uploading = ref(false);
const uploadError = ref<string | null>(null);
const dragOver = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const editingId = ref<string | null>(null);
const editName = ref('');
const editTags = ref('');

const deleteBlock = ref<{ texture: Texture; materials: Array<{ id: string; name: string }> } | null>(null);

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

onMounted(() => void load(true));
onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });
</script>

<template>
  <div class="h-row">
    <h1 class="flex-1">Textures</h1>
    <button class="primary" :disabled="uploading" @click="fileInput?.click()">
      {{ uploading ? 'Uploading…' : '+ Upload textures' }}
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

  <div class="toolbar mt">
    <input
      v-model="search"
      class="flex-1"
      type="search"
      placeholder="Search by name…"
      @input="onSearchInput"
    />
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
  <div v-else-if="!textures.length" class="muted mt-lg">No textures yet. Upload some above to get started.</div>

  <div v-else class="grid mt">
    <div v-for="t in textures" :key="t.id" class="card tex-card">
      <span class="thumb">
        <img :src="texturesApi.downloadUrl(t.id)" :alt="t.displayName" loading="lazy" />
      </span>

      <template v-if="editingId === t.id">
        <input v-model="editName" class="edit-input" placeholder="Display name" />
        <input v-model="editTags" class="edit-input" placeholder="tag1, tag2" />
        <div class="card-actions">
          <button class="primary flex-1" @click="saveEdit(t)">Save</button>
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
          <button class="flex-1" @click="startEdit(t)">Edit</button>
          <button class="flex-1 danger" @click="removeTexture(t)">Delete</button>
        </div>
      </template>
    </div>
  </div>

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
.toolbar { display: flex; gap: 8px; }
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

.grid {
  display: grid; gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
}
.tex-card { display: flex; flex-direction: column; gap: 6px; padding: 10px; }
.thumb {
  display: block; aspect-ratio: 1 / 1; border-radius: var(--radius-sm);
  overflow: hidden; background: var(--color-bg-hover);
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tex-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.pill.tag {
  text-transform: none; letter-spacing: normal; font-weight: 500;
  background: var(--color-bg-hover); color: var(--color-text-muted);
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
