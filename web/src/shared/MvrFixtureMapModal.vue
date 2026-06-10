<script setup lang="ts">
/**
 * Modal to map MVR fixture types to Prism library entries, auto-import
 * missing GDTF, then upload resolved instances to ORBIT.
 */
import { computed, ref, watch } from 'vue';
import OrbitPicker from './OrbitPicker.vue';
import Icon from './Icon.vue';
import {
  fixturesApi,
  type ApiError,
  type FixtureListItem,
  type FixtureUpdateCheck,
  type MvrImportResult,
  type MvrUnresolvedFixture,
} from './api';

const props = defineProps<{
  open: boolean;
  result: MvrImportResult | null;
  orbitTarget: 'prod' | 'dev';
}>();

const emit = defineEmits<{
  close: [];
  uploaded: [payload: { versionId: string; objectCount: number }];
}>();

const projectId = ref('');
const modelId = ref('');
const modelName = ref('');
const target = ref<'prod' | 'dev'>(props.orbitTarget);

const fixtures = ref<FixtureListItem[]>([]);
const loadingFixtures = ref(false);
const resolving = ref(false);
const uploading = ref(false);
const error = ref<string | null>(null);
const resolveNotes = ref<string[]>([]);
const localInstances = ref<MvrImportResult['instances']>([]);
const localUnresolved = ref<MvrImportResult['unresolvedFixtures']>([]);
const fixtureUpdates = ref<Record<string, FixtureUpdateCheck>>({});
const autoUpdateBeforeUpload = ref(false);
const updatingFixtureId = ref<string | null>(null);

/** gdtfRefKey → selected Prism fixture type id */
const typeMappings = ref<Record<string, string>>({});

const unresolved = computed(() => localUnresolved.value);
const hasMissing = computed(() => unresolved.value.length > 0);
const allTypesMapped = computed(() =>
  unresolved.value.every((u) => !!typeMappings.value[u.key]),
);
const canUpload = computed(() =>
  !!props.result
  && !!projectId.value.trim()
  && !!modelId.value.trim()
  && allTypesMapped.value
  && !resolving.value
  && !uploading.value,
);

function refKey(row: { gdtfRef: string; key?: string }): string {
  const u = unresolved.value.find((x) => x.gdtfRef === row.gdtfRef);
  return u?.key ?? row.gdtfRef.toLowerCase();
}

async function loadFixtures(): Promise<void> {
  loadingFixtures.value = true;
  try {
    const res = await fixturesApi.list({ limit: 200 });
    fixtures.value = res.fixtures;
  } catch {
    fixtures.value = [];
  } finally {
    loadingFixtures.value = false;
  }
}

function initMappings(): void {
  if (!props.result) return;
  localInstances.value = [...props.result.instances];
  localUnresolved.value = [...props.result.unresolvedFixtures];
  const next: Record<string, string> = {};
  for (const inst of localInstances.value) {
    if (!inst.fixtureTypeId) continue;
    const key = refKey({ gdtfRef: inst.gdtfRef });
    next[key] = inst.fixtureTypeId;
  }
  typeMappings.value = next;
}

const fixturesWithUpdates = computed(() => {
  const ids = new Set<string>();
  for (const inst of localInstances.value) {
    if (inst.fixtureTypeId && fixtureUpdates.value[inst.fixtureTypeId]?.updateAvailable) {
      ids.add(inst.fixtureTypeId);
    }
  }
  for (const mapping of Object.values(typeMappings.value)) {
    if (mapping && fixtureUpdates.value[mapping]?.updateAvailable) ids.add(mapping);
  }
  return [...ids];
});

function mergeFixtureUpdates(updates?: Record<string, FixtureUpdateCheck>): void {
  if (!updates) return;
  fixtureUpdates.value = { ...fixtureUpdates.value, ...updates };
}

watch(() => props.open, (o) => {
  if (!o) return;
  error.value = null;
  resolveNotes.value = [];
  fixtureUpdates.value = {};
  autoUpdateBeforeUpload.value = false;
  target.value = props.orbitTarget;
  initMappings();
  void loadFixtures();
});

async function importMissing(): Promise<void> {
  if (!props.result) return;
  resolving.value = true;
  error.value = null;
  resolveNotes.value = [];
  try {
    const res = await fixturesApi.resolveMvr({
      runId: props.result.runId,
      mappings: Object.entries(typeMappings.value).map(([gdtfRefKey, fixtureTypeId]) => ({
        gdtfRefKey,
        fixtureTypeId,
      })),
      autoImportMissing: true,
    });
    for (const imp of res.imported) {
      typeMappings.value[imp.key] = imp.fixtureTypeId;
      resolveNotes.value.push(`Imported ${imp.key} from ${imp.source}`);
    }
    for (const err of res.errors) {
      resolveNotes.value.push(`Failed ${err.key}: ${err.message}`);
    }
    if (res.unresolvedFixtures.length) {
      error.value = `${res.unresolvedFixtures.length} fixture type(s) still unresolved — pick manually or check GDTF-Share credentials.`;
    }
    localInstances.value = res.instances;
    localUnresolved.value = res.unresolvedFixtures;
    mergeFixtureUpdates(res.fixtureUpdates);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'resolve failed';
  } finally {
    resolving.value = false;
  }
}

async function updateFixtureBeforeUpload(fixtureTypeId: string): Promise<void> {
  const check = fixtureUpdates.value[fixtureTypeId];
  if (!check?.latestRid) return;
  updatingFixtureId.value = fixtureTypeId;
  error.value = null;
  try {
    await fixturesApi.downloadVersion(fixtureTypeId, check.latestRid, true);
    const res = await fixturesApi.checkUpdates(fixtureTypeId);
    fixtureUpdates.value = { ...fixtureUpdates.value, [fixtureTypeId]: res.check };
    resolveNotes.value.push(`Updated fixture ${fixtureTypeId} to ${check.latestRevision ?? 'latest'}`);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'fixture update failed';
  } finally {
    updatingFixtureId.value = null;
  }
}

async function uploadToOrbit(): Promise<void> {
  if (!props.result || !canUpload.value) return;
  uploading.value = true;
  error.value = null;
  try {
    const resolveRes = await fixturesApi.resolveMvr({
      runId: props.result.runId,
      mappings: Object.entries(typeMappings.value).map(([gdtfRefKey, fixtureTypeId]) => ({
        gdtfRefKey,
        fixtureTypeId,
      })),
      autoImportMissing: true,
    });

    if (resolveRes.unresolvedFixtures.length) {
      error.value = 'Some fixture types are still unresolved.';
      localUnresolved.value = resolveRes.unresolvedFixtures;
      return;
    }

    mergeFixtureUpdates(resolveRes.fixtureUpdates);

    const dbIds = resolveRes.persisted.map((p) => p.dbId);
    if (!dbIds.length) {
      error.value = 'No instances were persisted — check fixture mappings.';
      return;
    }

    const uploadRes = await fixturesApi.uploadMvrToOrbit({
      runId: props.result.runId,
      projectId: projectId.value.trim(),
      modelId: modelId.value.trim(),
      orbitTarget: target.value,
      instanceIds: dbIds,
      autoUpdate: autoUpdateBeforeUpload.value,
    });
    emit('uploaded', { versionId: uploadRes.versionId, objectCount: uploadRes.objectCount });
    emit('close');
  } catch (err) {
    error.value = (err as ApiError).message ?? 'upload failed';
  } finally {
    uploading.value = false;
  }
}

function fixturesForRef(u: MvrUnresolvedFixture): FixtureListItem[] {
  const q = `${u.manufacturer} ${u.fixtureName}`.trim().toLowerCase();
  if (!q) return fixtures.value.slice(0, 50);
  const matched = fixtures.value.filter((f) =>
    `${f.manufacturer} ${f.fixtureName} ${f.name}`.toLowerCase().includes(q));
  return matched.length ? matched.slice(0, 50) : fixtures.value.slice(0, 50);
}
</script>

<template>
  <div v-if="open && result" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal card">
      <header class="modal-head">
        <h2>Map MVR fixtures</h2>
        <button type="button" class="icon-btn" aria-label="Close" @click="emit('close')"><Icon name="close" :size="18" /></button>
      </header>

      <p class="muted">
        {{ localInstances.length }} instance(s) · {{ result.embeddedGdtfCount ?? 0 }} embedded GDTF
      </p>

      <div v-if="result.patchConflicts.length" class="error-box">
        Patch conflicts: {{ result.patchConflicts.join('; ') }}
      </div>

      <div class="table-wrap">
        <table class="map-table">
          <thead>
            <tr>
              <th>MVR fixture</th>
              <th>Prism fixture</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in unresolved" :key="u.key">
              <td>
                <div class="cell-main">{{ u.gdtfRef || u.fixtureName }}</div>
                <div class="cell-sub muted">{{ u.instanceCount }} instance(s)</div>
                <div v-if="u.embeddedName" class="cell-sub muted">embedded: {{ u.embeddedName }}</div>
              </td>
              <td>
                <select v-model="typeMappings[u.key]">
                  <option value="">— select —</option>
                  <option v-for="f in fixturesForRef(u)" :key="f.id" :value="f.id">
                    {{ f.manufacturer }} — {{ f.fixtureName || f.name }}
                  </option>
                </select>
              </td>
              <td><span class="pill missing">missing</span></td>
            </tr>
            <tr v-for="inst in localInstances.filter((i) => i.status !== 'missing')" :key="inst.tempId">
              <td>
                <div class="cell-main">{{ inst.instanceName }}</div>
                <div class="cell-sub muted">{{ inst.gdtfRef }}</div>
              </td>
              <td class="muted">{{ inst.fixtureTypeId ? 'auto-matched' : '—' }}</td>
              <td><span class="pill" :class="inst.status">{{ inst.status }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="hasMissing" class="warn-box">
        Some fixture types are not in the Prism library.
        <button type="button" class="primary mt-sm" :disabled="resolving" @click="importMissing">
          {{ resolving ? 'Importing GDTF…' : 'Auto-import missing GDTF' }}
        </button>
      </div>

      <div v-if="fixturesWithUpdates.length" class="warn-box">
        <p class="update-head">
          {{ fixturesWithUpdates.length }} mapped fixture(s) have a newer GDTF revision on GDTF-Share.
        </p>
        <ul class="update-list">
          <li v-for="fid in fixturesWithUpdates" :key="fid">
            <span class="mono">{{ fixtures.find((f) => f.id === fid)?.fixtureName || fid }}</span>
            <span v-if="fixtureUpdates[fid]?.latestRevision" class="muted upd-arrow">
              <Icon name="arrow_right_alt" :size="14" /> {{ fixtureUpdates[fid]?.latestRevision }}
            </span>
            <button
              type="button"
              class="link-btn"
              :disabled="updatingFixtureId === fid"
              @click="updateFixtureBeforeUpload(fid)"
            >
              {{ updatingFixtureId === fid ? 'Updating…' : 'Update before upload' }}
            </button>
          </li>
        </ul>
        <label class="auto-update-label">
          <input v-model="autoUpdateBeforeUpload" type="checkbox" />
          Auto-update all mapped fixtures on upload
        </label>
      </div>

      <ul v-if="resolveNotes.length" class="notes muted">
        <li v-for="(n, i) in resolveNotes" :key="i">{{ n }}</li>
      </ul>

      <h3 class="section-title">Upload to ORBIT</h3>
      <label class="field-label">Target
        <select v-model="target">
          <option value="dev">Dev</option>
          <option value="prod">Production</option>
        </select>
      </label>
      <OrbitPicker
        :target="target"
        v-model:projectId="projectId"
        v-model:modelId="modelId"
        v-model:modelName="modelName"
      />

      <div v-if="error" class="error-box mt">{{ error }}</div>

      <footer class="modal-foot">
        <button type="button" @click="emit('close')">Cancel</button>
        <button type="button" class="primary" :disabled="!canUpload" @click="uploadToOrbit">
          {{ uploading ? 'Uploading…' : 'Upload to ORBIT' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.modal {
  width: 720px; max-width: 100%; max-height: 90vh;
  display: flex; flex-direction: column; gap: 12px;
  background: var(--color-bg-elevated);
  overflow: auto;
}
.modal-head { display: flex; align-items: center; justify-content: space-between; }
.modal-head h2 { font-size: 16px; margin: 0; }
.section-title { font-size: 14px; margin: 8px 0 0; }
.field-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--color-text-muted); }
.table-wrap { overflow: auto; max-height: 240px; border: 1px solid var(--color-border); border-radius: var(--radius); }
.map-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.map-table th, .map-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--color-border); }
.map-table select { width: 100%; max-width: 280px; }
.cell-main { font-weight: 500; }
.cell-sub { font-size: 11px; }
.pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; }
.pill.ok { background: #1a3; color: #fff; }
.pill.warning { background: #c90; color: #000; }
.pill.missing { background: #c33; color: #fff; }
.warn-box {
  padding: 10px; border-radius: var(--radius);
  background: rgba(200, 150, 0, 0.12); border: 1px solid #c90;
  font-size: 13px;
}
.notes { font-size: 12px; margin: 0; padding-left: 18px; }
.update-head { margin: 0 0 8px; }
.update-list { margin: 0 0 8px; padding-left: 18px; font-size: 12px; }
.update-list li { margin-bottom: 4px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.mono { font-family: var(--font-mono, monospace); font-size: 11px; }
.link-btn {
  border: none; background: none; color: var(--orbit-primary);
  font-size: 12px; cursor: pointer; text-decoration: underline; padding: 0;
}
.auto-update-label { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
</style>
