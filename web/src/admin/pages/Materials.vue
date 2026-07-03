<script setup lang="ts">
/**
 * Materials library. Cards show a persisted preview image when available, or a
 * lazy-loaded PBR sphere (same as the editor) for custom materials without an
 * albedo thumbnail. Materials are created blank, imported from ZIP, or browsed
 * from external providers. Cards link to the editor; duplicate/branch create
 * editable copies; delete soft-deletes.
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  materialsApi,
  materialGroupsApi,
  type ApiError,
  type MaterialGroup as ApiMaterialGroup,
  type MaterialListItem,
} from '../../shared/api';
import Icon from '../../shared/Icon.vue';
import ExternalMaterialsModal from '../components/ExternalMaterialsModal.vue';
import MaterialCardPreview from '../components/MaterialCardPreview.vue';

const router = useRouter();
const PAGE = 36;

type GroupBy = 'none' | 'source' | 'tag' | 'resolution' | 'custom';

const UNGROUPED_KEY = '__ungrouped__';

const materials = ref<MaterialListItem[]>([]);
const groups = ref<ApiMaterialGroup[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const nextCursor = ref<string | null>(null);

const search = ref('');
const activeTags = ref<string[]>([]);
const groupBy = ref<GroupBy>('source');
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const showCreate = ref(false);
const showCreateGroup = ref(false);
const showExternal = ref(false);
const newName = ref('');
const newGroupName = ref('');
const creating = ref(false);
const creatingGroup = ref(false);
const copyingId = ref<string | null>(null);
const renameGroupId = ref<string | null>(null);
const renameGroupName = ref('');
const renamingGroup = ref(false);

const draggingMaterialId = ref<string | null>(null);
const dragOverGroupKey = ref<string | null>(null);

const importing = ref(false);
const importProgress = ref(0);
const importError = ref<string | null>(null);
const dragOver = ref(false);
const zipInput = ref<HTMLInputElement | null>(null);

const skippedDialog = ref<{ id: string; name: string; skipped: string[] } | null>(null);

const RESOLUTION_TAG_PREFIX = 'resolution:';
const HIDDEN_MATERIAL_TAGS = new Set(['external-import']);
const SOURCE_TAGS = new Set(['fab', 'polyhaven', 'ambientcg']);

const GROUP_BY_OPTIONS: Array<{ value: GroupBy; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'source', label: 'Source' },
  { value: 'tag', label: 'Tag' },
  { value: 'resolution', label: 'Resolution' },
  { value: 'custom', label: 'Custom groups' },
];

function importResolution(m: MaterialListItem): string | null {
  const tag = m.tags.find((t) => t.startsWith(RESOLUTION_TAG_PREFIX));
  if (!tag) return null;
  return tag.slice(RESOLUTION_TAG_PREFIX.length).toUpperCase();
}

function displayMaterialTags(m: MaterialListItem): string[] {
  return m.tags.filter(
    (tag) => !tag.startsWith(RESOLUTION_TAG_PREFIX) && !HIDDEN_MATERIAL_TAGS.has(tag),
  );
}

function isSourceTag(tag: string): boolean {
  return SOURCE_TAGS.has(tag);
}

function materialGroupKey(m: MaterialListItem): string {
  if (groupBy.value === 'none') return '';
  if (groupBy.value === 'source') {
    const source = m.tags.find((t) => SOURCE_TAGS.has(t));
    return source ?? 'Local / other';
  }
  if (groupBy.value === 'resolution') {
    return importResolution(m) ?? 'Unknown resolution';
  }
  const tags = displayMaterialTags(m);
  return tags[0] ?? 'Untagged';
}

interface DisplayGroup {
  key: string;
  label?: string;
  items: MaterialListItem[];
}

const groupedMaterials = computed<DisplayGroup[]>(() => {
  if (groupBy.value === 'none') {
    return [{ key: '', items: materials.value }];
  }
  if (groupBy.value === 'custom') {
    const map = new Map<string, MaterialListItem[]>();
    for (const g of groups.value) map.set(g.id, []);
    map.set(UNGROUPED_KEY, []);
    for (const m of materials.value) {
      const key = m.groupId && map.has(m.groupId) ? m.groupId : UNGROUPED_KEY;
      map.get(key)!.push(m);
    }
    const result: DisplayGroup[] = groups.value.map((g) => ({
      key: g.id,
      label: g.name,
      items: map.get(g.id) ?? [],
    }));
    result.push({ key: UNGROUPED_KEY, label: 'Ungrouped', items: map.get(UNGROUPED_KEY) ?? [] });
    return result;
  }
  const map = new Map<string, MaterialListItem[]>();
  for (const m of materials.value) {
    const key = materialGroupKey(m);
    const bucket = map.get(key);
    if (bucket) bucket.push(m);
    else map.set(key, [m]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, items]) => ({ key, items }));
});

const availableTags = computed<string[]>(() => {
  const set = new Set<string>();
  for (const m of materials.value) for (const tag of m.tags) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
});

async function loadGroups(): Promise<void> {
  try {
    const res = await materialGroupsApi.list();
    groups.value = res.groups;
  } catch {
    /* groups are optional until custom mode is used */
  }
}

async function load(reset = true): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await materialsApi.list({
      q: search.value || undefined,
      tags: activeTags.value.length ? activeTags.value : undefined,
      limit: PAGE,
      cursor: reset ? undefined : nextCursor.value,
    });
    materials.value = reset ? res.materials : [...materials.value, ...res.materials];
    nextCursor.value = res.nextCursor;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load materials';
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

function onCardThumbnailUpdated(materialId: string, textureId: string): void {
  const row = materials.value.find((m) => m.id === materialId);
  if (row) {
    row.thumbnailTextureId = textureId;
    row.previewUrl = materialsApi.previewUrl(materialId, Date.now());
  }
}

function openEditor(id: string): void {
  void router.push({ name: 'material-editor', params: { id } });
}

async function createBlank(): Promise<void> {
  const name = newName.value.trim();
  if (!name) return;
  creating.value = true;
  error.value = null;
  try {
    const created = await materialsApi.create({ name });
    showCreate.value = false;
    newName.value = '';
    openEditor(created.id);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'create failed';
  } finally {
    creating.value = false;
  }
}

async function importZip(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    importError.value = 'Please choose a .zip archive.';
    return;
  }
  importing.value = true;
  importProgress.value = 0;
  importError.value = null;
  try {
    const res = await materialsApi.import(file, undefined, (p) => { importProgress.value = p; });
    if (res.skipped.length) {
      skippedDialog.value = { id: res.id, name: res.name, skipped: res.skipped };
    } else {
      openEditor(res.id);
    }
  } catch (err) {
    importError.value = (err as ApiError).message ?? 'import failed';
  } finally {
    importing.value = false;
  }
}

function onZipChosen(ev: Event): void {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (input) input.value = '';
  if (file) void importZip(file);
}

function onDrop(ev: DragEvent): void {
  ev.preventDefault();
  dragOver.value = false;
  if (importing.value) return;
  const file = ev.dataTransfer?.files?.[0];
  if (file) void importZip(file);
}

function onDragOver(ev: DragEvent): void {
  ev.preventDefault();
  if (!importing.value) dragOver.value = true;
}

async function duplicateMaterial(m: MaterialListItem): Promise<void> {
  copyingId.value = m.id;
  error.value = null;
  try {
    const created = await materialsApi.duplicate(m.id);
    materials.value = [created, ...materials.value];
    openEditor(created.id);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'duplicate failed';
  } finally {
    copyingId.value = null;
  }
}

async function branchMaterial(m: MaterialListItem): Promise<void> {
  copyingId.value = m.id;
  error.value = null;
  try {
    const created = await materialsApi.branch(m.id);
    materials.value = [created, ...materials.value];
    openEditor(created.id);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'branch failed';
  } finally {
    copyingId.value = null;
  }
}

async function removeMaterial(m: MaterialListItem): Promise<void> {
  if (!confirm(`Delete material "${m.name}"? This soft-deletes it; textures are kept.`)) return;
  try {
    await materialsApi.remove(m.id);
    materials.value = materials.value.filter((x) => x.id !== m.id);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'delete failed';
  }
}

function onExternalImported(id: string): void {
  showExternal.value = false;
  openEditor(id);
  void load(true);
}

async function createGroup(): Promise<void> {
  const name = newGroupName.value.trim();
  if (!name) return;
  creatingGroup.value = true;
  error.value = null;
  try {
    const created = await materialGroupsApi.create({ name });
    groups.value = [...groups.value, created];
    showCreateGroup.value = false;
    newGroupName.value = '';
    groupBy.value = 'custom';
  } catch (err) {
    error.value = (err as ApiError).message ?? 'create group failed';
  } finally {
    creatingGroup.value = false;
  }
}

function startRenameGroup(groupId: string): void {
  const g = groups.value.find((x) => x.id === groupId);
  if (!g) return;
  renameGroupId.value = groupId;
  renameGroupName.value = g.name;
}

async function confirmRenameGroup(): Promise<void> {
  const id = renameGroupId.value;
  const name = renameGroupName.value.trim();
  if (!id || !name) return;
  renamingGroup.value = true;
  error.value = null;
  try {
    const updated = await materialGroupsApi.update(id, { name });
    groups.value = groups.value.map((g) => (g.id === id ? updated : g));
    renameGroupId.value = null;
    renameGroupName.value = '';
  } catch (err) {
    error.value = (err as ApiError).message ?? 'rename failed';
  } finally {
    renamingGroup.value = false;
  }
}

async function deleteGroup(groupId: string): Promise<void> {
  const g = groups.value.find((x) => x.id === groupId);
  if (!g || !confirm(`Delete group "${g.name}"? Materials in it will become ungrouped.`)) return;
  error.value = null;
  try {
    await materialGroupsApi.remove(groupId);
    groups.value = groups.value.filter((x) => x.id !== groupId);
    for (const m of materials.value) {
      if (m.groupId === groupId) m.groupId = null;
    }
  } catch (err) {
    error.value = (err as ApiError).message ?? 'delete group failed';
  }
}

function onMaterialDragStart(ev: DragEvent, materialId: string): void {
  if (groupBy.value !== 'custom') return;
  draggingMaterialId.value = materialId;
  ev.dataTransfer?.setData('text/plain', materialId);
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
}

function onMaterialDragEnd(): void {
  draggingMaterialId.value = null;
  dragOverGroupKey.value = null;
}

function onGroupDragOver(ev: DragEvent, groupKey: string): void {
  if (groupBy.value !== 'custom' || !draggingMaterialId.value) return;
  ev.preventDefault();
  dragOverGroupKey.value = groupKey;
}

function onGroupDragLeave(groupKey: string): void {
  if (dragOverGroupKey.value === groupKey) dragOverGroupKey.value = null;
}

async function onGroupDrop(ev: DragEvent, groupKey: string): Promise<void> {
  ev.preventDefault();
  dragOverGroupKey.value = null;
  const materialId = ev.dataTransfer?.getData('text/plain') || draggingMaterialId.value;
  draggingMaterialId.value = null;
  if (!materialId || groupBy.value !== 'custom') return;

  const targetGroupId = groupKey === UNGROUPED_KEY ? null : groupKey;
  const material = materials.value.find((m) => m.id === materialId);
  if (!material || material.groupId === targetGroupId) return;

  error.value = null;
  try {
    await materialsApi.update(materialId, { groupId: targetGroupId });
    material.groupId = targetGroupId;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to move material';
  }
}

onMounted(() => {
  void load(true);
  void loadGroups();
});
onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });
</script>

<template>
  <div class="h-row">
    <h1 class="flex-1">Materials</h1>
    <button class="primary" @click="showCreate = true"><Icon name="add" :size="16" />Blank material</button>
    <button @click="showExternal = true"><Icon name="travel_explore" :size="16" />Browse external</button>
    <button :disabled="importing" @click="zipInput?.click()"><Icon name="folder_zip" :size="16" />Import ZIP</button>
    <input
      ref="zipInput"
      type="file"
      accept=".zip,application/zip"
      style="display: none;"
      @change="onZipChosen"
    />
  </div>
  <p class="muted">PBR materials built from the shared texture library. Each carries up to eight slots.</p>

  <div
    class="dropzone mt"
    :class="{ active: dragOver, disabled: importing }"
    @dragover="onDragOver"
    @dragleave="dragOver = false"
    @drop="onDrop"
    @click="!importing && zipInput?.click()"
  >
    <strong v-if="importing">Importing…</strong>
    <strong v-else>Drop a material <code>.zip</code> here, or click to choose</strong>
    <p class="subtle">Megascans channels match by filename; glTF / GLB packages map material texture slots automatically.</p>
  </div>

  <div v-if="importing" class="import-status mt-sm">
    <div class="h-row" style="justify-content: space-between;">
      <span class="muted small">{{ importProgress < 1 ? 'Uploading' : 'Processing' }}…</span>
      <span class="muted small">{{ Math.round(importProgress * 100) }}%</span>
    </div>
    <div class="progress mt-sm"><div class="fill" :style="{ width: `${importProgress * 100}%` }" /></div>
  </div>
  <div v-if="importError" class="error-box mt-sm">{{ importError }}</div>

  <div class="toolbar mt">
    <input v-model="search" class="flex-1" type="search" placeholder="Search materials…" @input="onSearchInput" />
    <label class="group-by">
      <span class="muted small">Group by</span>
      <select v-model="groupBy">
        <option v-for="opt in GROUP_BY_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
    </label>
    <button @click="showCreateGroup = true"><Icon name="create_new_folder" :size="16" />Create group</button>
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

  <div v-if="loading && !materials.length" class="muted mt-lg">Loading…</div>
  <div v-else-if="!materials.length" class="muted mt-lg">No materials yet. Create a blank one or import a ZIP above.</div>

  <template v-else>
    <section
      v-for="group in groupedMaterials"
      :key="group.key || 'all'"
      class="group-section mt"
      :class="{
        'drop-target': groupBy === 'custom' && group.key && dragOverGroupKey === group.key,
        'custom-group': groupBy === 'custom' && group.key,
      }"
      @dragover="groupBy === 'custom' && group.key ? onGroupDragOver($event, group.key) : undefined"
      @dragleave="groupBy === 'custom' && group.key ? onGroupDragLeave(group.key) : undefined"
      @drop="groupBy === 'custom' && group.key ? onGroupDrop($event, group.key) : undefined"
    >
      <div v-if="group.key" class="group-heading-row">
        <h2 class="group-heading">{{ group.label ?? group.key }}</h2>
        <div
          v-if="groupBy === 'custom' && group.key !== UNGROUPED_KEY"
          class="group-actions"
          @click.stop
        >
          <button class="icon-action" title="Rename group" @click="startRenameGroup(group.key)">
            <Icon name="edit" :size="14" />
          </button>
          <button class="icon-action danger" title="Delete group" @click="deleteGroup(group.key)">
            <Icon name="delete" :size="14" />
          </button>
        </div>
      </div>
      <div v-if="groupBy === 'custom' && group.key && !group.items.length" class="empty-drop subtle small">
        Drop materials here
      </div>
      <div class="grid" :class="{ 'mt-sm': group.key }">
        <div
          v-for="m in group.items"
          :key="m.id"
          class="card mat-card"
          :class="{ dragging: draggingMaterialId === m.id }"
          :draggable="groupBy === 'custom'"
          @dragstart="onMaterialDragStart($event, m.id)"
          @dragend="onMaterialDragEnd"
          @click="openEditor(m.id)"
        >
          <span class="thumb">
            <MaterialCardPreview
              :material-id="m.id"
              :thumbnail-texture-id="m.thumbnailTextureId"
              :preview-url="m.previewUrl"
              :alt="m.name"
              @thumbnail-updated="onCardThumbnailUpdated(m.id, $event)"
            />
          </span>
          <div class="mat-name" :title="m.name">{{ m.name }}</div>
          <div v-if="m.branchedFromId" class="branch-hint subtle small">Branched copy</div>
          <div v-if="importResolution(m) || displayMaterialTags(m).length" class="tags">
            <span v-if="importResolution(m)" class="pill resolution-badge">{{ importResolution(m) }}</span>
            <span
              v-for="tag in displayMaterialTags(m)"
              :key="tag"
              class="pill tag"
              :class="{ 'source-tag': isSourceTag(tag) }"
            >{{ tag }}</span>
          </div>
          <div class="mat-foot">
            <span class="pill" :class="m.slotsFilled === m.slotsTotal ? 'online' : ''">
              {{ m.slotsFilled }}/{{ m.slotsTotal }} slots
            </span>
            <div class="mat-actions" @click.stop>
              <button
                class="icon-action"
                :disabled="copyingId === m.id"
                title="Duplicate"
                @click="duplicateMaterial(m)"
              ><Icon name="content_copy" :size="14" /></button>
              <button
                class="icon-action"
                :disabled="copyingId === m.id"
                title="Branch (editable copy with lineage)"
                @click="branchMaterial(m)"
              ><Icon name="fork_right" :size="14" /></button>
              <button class="danger" @click="removeMaterial(m)"><Icon name="delete" :size="14" />Delete</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  </template>

  <div v-if="nextCursor" class="load-more mt">
    <button :disabled="loading" @click="load(false)">{{ loading ? 'Loading…' : 'Load more' }}</button>
  </div>

  <!-- Blank material name prompt -->
  <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false">
    <div class="card modal">
      <h2>New material</h2>
      <input
        v-model="newName"
        placeholder="Material name"
        @keyup.enter="createBlank"
      />
      <div class="h-row" style="justify-content: flex-end;">
        <button :disabled="creating" @click="showCreate = false">Cancel</button>
        <button class="primary" :disabled="!newName.trim() || creating" @click="createBlank">
          {{ creating ? 'Creating…' : 'Create' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Create group -->
  <div v-if="showCreateGroup" class="modal-backdrop" @click.self="showCreateGroup = false">
    <div class="card modal">
      <h2>New group</h2>
      <input
        v-model="newGroupName"
        placeholder="Group name"
        @keyup.enter="createGroup"
      />
      <div class="h-row" style="justify-content: flex-end;">
        <button :disabled="creatingGroup" @click="showCreateGroup = false">Cancel</button>
        <button class="primary" :disabled="!newGroupName.trim() || creatingGroup" @click="createGroup">
          {{ creatingGroup ? 'Creating…' : 'Create' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Rename group -->
  <div v-if="renameGroupId" class="modal-backdrop" @click.self="renameGroupId = null">
    <div class="card modal">
      <h2>Rename group</h2>
      <input
        v-model="renameGroupName"
        placeholder="Group name"
        @keyup.enter="confirmRenameGroup"
      />
      <div class="h-row" style="justify-content: flex-end;">
        <button :disabled="renamingGroup" @click="renameGroupId = null">Cancel</button>
        <button class="primary" :disabled="!renameGroupName.trim() || renamingGroup" @click="confirmRenameGroup">
          {{ renamingGroup ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Fab import -->
  <ExternalMaterialsModal
    :open="showExternal"
    @close="showExternal = false"
    @imported="onExternalImported"
  />

  <!-- Import skipped files -->
  <div v-if="skippedDialog" class="modal-backdrop" @click.self="openEditor(skippedDialog.id)">
    <div class="card modal">
      <h2>Imported “{{ skippedDialog.name }}”</h2>
      <p class="muted">
        {{ skippedDialog.skipped.length }} file{{ skippedDialog.skipped.length === 1 ? '' : 's' }}
        {{ skippedDialog.skipped.length === 1 ? 'was' : 'were' }} skipped
        (unmatched channels, duplicate slots, or metadata such as <code>.json</code> manifests):
      </p>
      <ul class="skip-list">
        <li v-for="(f, i) in skippedDialog.skipped" :key="i"><code>{{ f }}</code></li>
      </ul>
      <div class="h-row" style="justify-content: flex-end;">
        <button class="primary" @click="openEditor(skippedDialog.id)">Open editor</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
h1 { font-size: 22px; margin: 0; }
.small { font-size: 12px; }
.toolbar { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
.group-by { display: flex; flex-direction: column; gap: 2px; }
.group-by select { min-width: 120px; }
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
.import-status { max-width: 100%; }

.group-heading {
  font-size: 13px;
  font-weight: 600;
  text-transform: capitalize;
  margin: 0;
  color: var(--color-text-muted);
  letter-spacing: 0.02em;
}
.group-heading-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.group-actions { display: flex; align-items: center; gap: 4px; }
.group-section.custom-group {
  border: 1px dashed var(--color-border);
  border-radius: var(--radius);
  padding: 10px;
  transition: border-color 80ms, background 80ms;
}
.group-section.custom-group.drop-target {
  border-color: var(--orbit-primary);
  background: var(--orbit-primary-fade);
}
.empty-drop {
  padding: 12px;
  text-align: center;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-sm);
  margin-bottom: 8px;
}
.mat-card.dragging { opacity: 0.45; }
.mat-card[draggable='true'] { cursor: grab; }
.mat-card[draggable='true']:active { cursor: grabbing; }
.group-section + .group-section { margin-top: 20px; }

.grid {
  display: grid; gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
}
.mat-card { display: flex; flex-direction: column; gap: 6px; padding: 10px; cursor: pointer; }
.mat-card:hover { border-color: var(--orbit-primary); box-shadow: var(--shadow-2); }
.thumb {
  aspect-ratio: 1 / 1; border-radius: var(--radius-sm);
  overflow: hidden; background: var(--color-bg-hover);
  display: flex; align-items: center; justify-content: center;
}
.mat-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.branch-hint { font-style: italic; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.pill.tag {
  text-transform: none; letter-spacing: normal; font-weight: 500;
  background: var(--color-bg-hover); color: var(--color-text-muted);
}
.pill.tag.source-tag {
  background: var(--orbit-primary); color: #fff;
}
.pill.resolution-badge {
  text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600;
  background: var(--color-bg-input); color: var(--color-text);
  border: 1px solid var(--color-border-strong);
}
.mat-foot { margin-top: auto; display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; }
.mat-foot .pill { text-transform: none; letter-spacing: normal; }
.mat-actions { display: flex; align-items: center; gap: 4px; }
.mat-actions button { padding: 3px 8px; font-size: 12px; }
button.icon-action {
  padding: 3px 6px;
  color: var(--color-text-muted);
}
button.icon-action:hover:not(:disabled) { color: var(--orbit-primary); border-color: var(--orbit-primary); }
button.danger { color: var(--color-error); }
button.danger:hover { border-color: var(--color-error); }
.load-more { display: flex; justify-content: center; }

.modal-backdrop {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.modal { width: 440px; max-width: 100%; display: flex; flex-direction: column; gap: 12px; }
.modal h2 { font-size: 16px; margin: 0; }
.skip-list {
  margin: 0; padding-left: 18px; max-height: 220px; overflow: auto;
  display: flex; flex-direction: column; gap: 3px; font-size: 12px;
}
</style>
