<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import {
  filesApi,
  orbitApi,
  settingsApi,
  type ApiError,
  type FileBrowseResult,
  type FileLibraryProjectFolder,
  type FileLibraryStatus,
  type OrbitProject,
} from '../../shared/api';
import Icon from '../../shared/Icon.vue';

interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  type?: 'text' | 'number';
}

const fields: FieldDef[] = [
  {
    key: 'file_library_root',
    label: 'Storage root (in-container path)',
    placeholder: '/mnt/fileserver/rebus',
  },
  {
    key: 'file_library_max_bytes',
    label: 'Max upload size (bytes)',
    type: 'number',
    placeholder: '2147483648',
  },
  {
    key: 'file_library_allowed_exts',
    label: 'Allowed extensions',
    placeholder: '.3dm,.vwx,.dwg,.rvt,.skp,.fbx,.obj,.zip',
  },
];

const values = reactive<Record<string, { value: string; original: string }>>(
  Object.fromEntries(fields.map((f) => [f.key, { value: '', original: '' }])),
);
const savingKey = reactive<Record<string, boolean>>({});
const loading = ref(true);
const error = ref<string | null>(null);
const statusMsg = ref<string | null>(null);
const libStatus = ref<FileLibraryStatus | null>(null);

const projects = ref<OrbitProject[]>([]);
const folders = ref<FileLibraryProjectFolder[]>([]);
const folderByProject = computed(() => {
  const m = new Map<string, FileLibraryProjectFolder>();
  for (const f of folders.value) m.set(f.projectId, f);
  return m;
});

const pickerOpen = ref(false);
const pickerProject = ref<OrbitProject | null>(null);
const browse = ref<FileBrowseResult | null>(null);
const browseLoading = ref(false);
const browsePath = ref('');
const savingFolder = ref(false);

const dirtyFields = computed(() => fields.filter((f) => values[f.key].value !== values[f.key].original));

async function refreshSettings(): Promise<void> {
  const all = (await settingsApi.list()).settings;
  for (const f of fields) {
    const v = all[f.key] ?? '';
    values[f.key] = { value: v, original: v };
  }
}

async function refreshStatus(): Promise<void> {
  try {
    libStatus.value = await filesApi.status();
  } catch {
    libStatus.value = null;
  }
}

async function refreshFolders(): Promise<void> {
  const res = await filesApi.listProjectFolders();
  folders.value = res.folders;
}

async function refreshProjects(): Promise<void> {
  const res = await orbitApi.projects('prod', 500);
  projects.value = [...res.items].sort((a, b) =>
    (a.name || a.id).localeCompare(b.name || b.id, undefined, { sensitivity: 'base' }),
  );
}

async function reload(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    await Promise.all([refreshSettings(), refreshStatus(), refreshFolders(), refreshProjects()]);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load File Library settings';
  } finally {
    loading.value = false;
  }
}

async function saveField(key: string): Promise<void> {
  savingKey[key] = true;
  error.value = null;
  try {
    await settingsApi.set(key, values[key].value.trim());
    values[key].original = values[key].value.trim();
    values[key].value = values[key].original;
    statusMsg.value = `Saved ${key}`;
    setTimeout(() => { statusMsg.value = null; }, 1500);
    if (key === 'file_library_root') await refreshStatus();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'save failed';
  } finally {
    savingKey[key] = false;
  }
}

async function saveDirty(): Promise<void> {
  for (const f of dirtyFields.value) await saveField(f.key);
}

async function loadBrowse(path = ''): Promise<void> {
  browseLoading.value = true;
  error.value = null;
  try {
    browse.value = await filesApi.browse(path);
    browsePath.value = browse.value.path;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'browse failed';
  } finally {
    browseLoading.value = false;
  }
}

function openPicker(project: OrbitProject): void {
  pickerProject.value = project;
  pickerOpen.value = true;
  const existing = folderByProject.value.get(project.id)?.relativePath ?? '';
  void loadBrowse(existing);
}

function closePicker(): void {
  pickerOpen.value = false;
  pickerProject.value = null;
  browse.value = null;
}

async function selectCurrentFolder(): Promise<void> {
  if (!pickerProject.value) return;
  const path = browsePath.value;
  if (!path) {
    error.value = 'Select a project subfolder (not the share root)';
    return;
  }
  const projectName = pickerProject.value.name || null;
  const projectLabel = pickerProject.value.name || path;
  savingFolder.value = true;
  error.value = null;
  try {
    await filesApi.setProjectFolder(pickerProject.value.id, {
      relativePath: path,
      projectName,
    });
    await refreshFolders();
    closePicker();
    statusMsg.value = `Folder set for ${projectLabel}`;
    setTimeout(() => { statusMsg.value = null; }, 2000);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to save folder';
  } finally {
    savingFolder.value = false;
  }
}

async function clearFolder(projectId: string): Promise<void> {
  if (!confirm('Clear the File Library folder for this project? Uploads will fail until a folder is set again.')) {
    return;
  }
  error.value = null;
  try {
    await filesApi.clearProjectFolder(projectId);
    await refreshFolders();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to clear folder';
  }
}

const configuredCount = computed(() =>
  projects.value.filter((p) => folderByProject.value.has(p.id)).length,
);

function onPickerKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && pickerOpen.value) {
    e.stopPropagation();
    closePicker();
  }
}

watch(pickerOpen, (open) => {
  if (open) window.addEventListener('keydown', onPickerKey, true);
  else window.removeEventListener('keydown', onPickerKey, true);
});

onMounted(() => void reload());
onUnmounted(() => window.removeEventListener('keydown', onPickerKey, true));
</script>

<template>
  <div class="fl-settings">
    <p v-if="loading" class="muted">Loading…</p>
    <div v-if="error" class="error-box">{{ error }}</div>
    <p v-if="statusMsg" class="muted small ok">{{ statusMsg }}</p>

    <section class="block">
      <h3 class="block-title">Storage</h3>
      <p v-if="libStatus" class="muted small status-line" :class="{ warn: !libStatus.writable }">
        Mount:
        <code>{{ libStatus.root }}</code>
        · {{ libStatus.writable ? 'writable' : 'not writable' }}
        <template v-if="libStatus.projectFolderCount != null">
          · {{ libStatus.projectFolderCount }} project folder{{ libStatus.projectFolderCount === 1 ? '' : 's' }}
        </template>
      </p>
      <div class="field-stack">
        <div v-for="f in fields" :key="f.key" class="field">
          <label :for="`fl-${f.key}`">
            {{ f.label }}
            <code class="muted">{{ f.key }}</code>
          </label>
          <div class="field-row">
            <input
              :id="`fl-${f.key}`"
              :type="f.type === 'number' ? 'number' : 'text'"
              :placeholder="f.placeholder ?? ''"
              v-model="values[f.key].value"
            />
            <button
              class="primary"
              :disabled="savingKey[f.key] || values[f.key].value === values[f.key].original"
              @click="saveField(f.key)"
            >
              Save
            </button>
          </div>
        </div>
      </div>
      <div class="actions">
        <button :disabled="!dirtyFields.length" class="primary" @click="saveDirty">Save all changes</button>
        <button :disabled="loading" @click="reload"><Icon name="refresh" :size="14" />Refresh</button>
      </div>
    </section>

    <section class="block">
      <h3 class="block-title">Project folders</h3>
      <p class="muted small">
        Each Orbit project must have a folder under the share root before uploads are accepted.
        {{ configuredCount }} / {{ projects.length }} configured.
      </p>

      <div class="table-wrap">
        <table class="proj-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Folder</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in projects" :key="p.id">
              <td>
                <div class="proj-name">{{ p.name || p.id }}</div>
                <div class="muted small mono">{{ p.id }}</div>
              </td>
              <td>
                <code v-if="folderByProject.get(p.id)" class="path">{{ folderByProject.get(p.id)!.relativePath }}</code>
                <span v-else class="pill warn">not set — uploads blocked</span>
              </td>
              <td class="row-actions">
                <button class="btn-link" @click="openPicker(p)">
                  <Icon name="folder_open" :size="14" />
                  {{ folderByProject.has(p.id) ? 'Change' : 'Select folder' }}
                </button>
                <button
                  v-if="folderByProject.has(p.id)"
                  class="btn-link danger"
                  @click="clearFolder(p.id)"
                >
                  Clear
                </button>
              </td>
            </tr>
            <tr v-if="!projects.length && !loading">
              <td colspan="3" class="muted">No Orbit projects returned. Check ORBIT settings / token.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <Teleport to="body">
      <div v-if="pickerOpen" class="picker-backdrop" @click.self="closePicker">
        <div class="picker" role="dialog" aria-modal="true" aria-label="Select folder">
          <header class="picker-head">
            <div class="picker-head-text">
              <h3 class="picker-title">Select folder</h3>
              <p class="muted small">
                {{ pickerProject?.name }}
                <span class="mono">{{ pickerProject?.id }}</span>
              </p>
            </div>
            <button type="button" class="picker-close" title="Close" @click="closePicker">
              <Icon name="close" :size="18" label="Close" />
            </button>
          </header>

          <div class="crumbs">
            <button type="button" class="crumb" :disabled="browseLoading" @click="loadBrowse('')">share root</button>
            <template v-if="browsePath">
              <span
                v-for="(seg, i) in browsePath.split('/')"
                :key="i"
                class="crumb-wrap"
              >
                <span class="sep">/</span>
                <button
                  type="button"
                  class="crumb"
                  :disabled="browseLoading"
                  @click="loadBrowse(browsePath.split('/').slice(0, i + 1).join('/'))"
                >
                  {{ seg }}
                </button>
              </span>
            </template>
          </div>

          <p class="muted small current">
            Current:
            <code>{{ browsePath || '(share root — pick a subfolder)' }}</code>
          </p>

          <div class="dir-list">
            <p v-if="browseLoading" class="muted">Loading…</p>
            <button
              v-if="browse && browse.parentPath !== null"
              type="button"
              class="dir-row"
              :disabled="browseLoading"
              @click="loadBrowse(browse.parentPath ?? '')"
            >
              <Icon name="arrow_upward" :size="16" /> ..
            </button>
            <button
              v-for="d in browse?.directories ?? []"
              :key="d.path"
              type="button"
              class="dir-row"
              :disabled="browseLoading"
              @click="loadBrowse(d.path)"
            >
              <Icon name="folder" :size="16" /> {{ d.name }}
            </button>
            <p v-if="browse && !browse.directories.length && !browseLoading" class="muted small">
              No subfolders here.
            </p>
          </div>

          <footer class="picker-foot">
            <button type="button" @click="closePicker">Cancel</button>
            <button
              type="button"
              class="primary"
              :disabled="savingFolder || !browsePath"
              @click="selectCurrentFolder"
            >
              {{ savingFolder ? 'Saving…' : 'Use this folder' }}
            </button>
          </footer>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.fl-settings { display: flex; flex-direction: column; gap: 20px; }
.block-title { margin: 0 0 6px; font-size: 15px; }
.field-stack { display: flex; flex-direction: column; gap: 12px; }
.field label { display: flex; gap: 8px; align-items: baseline; font-size: 13px; margin-bottom: 4px; }
.field-row { display: flex; gap: 8px; }
.field-row input { flex: 1; }
.actions { display: flex; gap: 8px; margin-top: 12px; }
.status-line { margin: 0 0 10px; }
.status-line.warn { color: var(--color-warning); }
.ok { color: var(--color-success); }
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 8px);
  background: var(--color-bg-elevated);
}
.proj-table { width: 100%; border-collapse: collapse; font-size: 13px; color: var(--color-text); }
.proj-table th, .proj-table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--color-border);
  vertical-align: top;
}
.proj-table th {
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
  font-weight: 600;
}
.proj-name { font-weight: 500; color: var(--color-text); }
.mono { font-family: ui-monospace, monospace; font-size: 11px; }
.path { font-size: 12px; word-break: break-all; color: var(--color-text); }
.pill.warn {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--color-warning-bg);
  color: var(--color-warning);
  font-size: 12px;
}
.row-actions { display: flex; gap: 8px; justify-content: flex-end; white-space: nowrap; }
.btn-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: var(--color-text);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  padding: 4px 6px;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.btn-link:hover { color: hsl(var(--primary)); }
.btn-link.danger { color: var(--color-danger); }
.btn-link.danger:hover { color: var(--color-danger); filter: brightness(0.9); }

.picker-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.picker {
  width: min(640px, 100%);
  max-height: min(80vh, 720px);
  background: var(--color-bg-elevated);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 12px);
  box-shadow: var(--shadow-2, 0 16px 40px rgba(0, 0, 0, 0.35));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.picker-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border);
}
.picker-head-text { min-width: 0; }
.picker-title {
  margin: 0 0 2px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text);
}
.picker-close {
  flex-shrink: 0;
  width: 32px;
  min-height: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.picker-close:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}
.crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 10px 16px 0;
  font-size: 12px;
}
.crumb {
  background: transparent;
  border: none;
  color: hsl(var(--primary));
  cursor: pointer;
  padding: 2px 4px;
  text-decoration: underline;
  text-underline-offset: 2px;
  font: inherit;
  text-transform: none;
  letter-spacing: normal;
  min-height: 0;
}
.crumb:hover { color: hsl(var(--primary) / 0.85); background: transparent; }
.crumb:disabled { opacity: 0.4; cursor: default; }
.sep { color: var(--color-text-muted); margin: 0 2px; }
.current { padding: 8px 16px; margin: 0; }
.current code { color: var(--color-text); }
.dir-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 12px;
  min-height: 180px;
  background: var(--color-bg);
}
.dir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  border-radius: var(--radius-sm, 6px);
  font: inherit;
  font-size: 13px;
  text-transform: none;
  letter-spacing: normal;
  min-height: 0;
}
.dir-row:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}
.dir-row:disabled { opacity: 0.5; cursor: default; }
.picker-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
}
</style>
