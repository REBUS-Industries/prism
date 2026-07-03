<script setup lang="ts">
/**
 * PRISM Fixture Library — the downloaded + modified fixtures that are the
 * authoritative, editable set the ORBIT connector and ORBIT consume.
 *
 * This is the second of the two fixture libraries. The GDTF Share Library
 * (Fixtures.vue) browses the upstream catalog and downloads into here; this
 * view manages the PRISM-owned records: edit category/status, view version
 * history + provenance back to GDTF-Share, check for upstream updates, and
 * export the connector/ORBIT payload.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import Icon from '../../shared/Icon.vue';
import Modal from '../../shared/Modal.vue';
import FixtureTypeSelect from '../components/FixtureTypeSelect.vue';
import { fixtureCategoryFromTags, tagsWithFixtureCategory } from '../utils/fixtureTypes';
import { duplicateFixtureName as defaultDuplicateName, fixtureLabel } from '../utils/fixtureLabel';
import { enrichFixtureListItem, enrichFixturesOrbitFromDetails, fixtureHasOrbitPublish, readFixtureOrbitRef } from '../utils/fixtureOrbitUrl';
import { fixtureHasCustomMeshes } from '../utils/fixtureCustomMesh';
import { useFixtureTypesStore } from '../stores/fixtureTypes';
import {
  fixturesApi,
  orbitApi,
  FIXTURE_ORIGIN_LABELS,
  type ApiError,
  type FixtureConnectorExport,
  type FixtureListItem,
  type FixtureOrigin,
  type FixtureDefinition,
  type OrbitVersion,
  type FixtureOrbitRef,
} from '../../shared/api';

const router = useRouter();
const store = useFixtureTypesStore();

const PAGE = 500;

type OriginFilter = 'all' | FixtureOrigin;
type StatusFilter = 'all' | 'draft' | 'published';

const fixtures = ref<FixtureListItem[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const search = ref('');
const selectedManufacturer = ref('__all__');
const originFilter = ref<OriginFilter>('all');
const statusFilter = ref<StatusFilter>('all');
const selectedId = ref<string | null>(null);

const checkingUpdates = ref(false);
const enrichingOrbit = ref(false);
const savingCategory = ref(false);
const savingStatus = ref(false);

const showCreate = ref(false);
const newName = ref('');
const creating = ref(false);
const importing = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const copyingId = ref<string | null>(null);
const showDuplicate = ref(false);
const duplicateSource = ref<FixtureListItem | null>(null);
const duplicateName = ref('');
const duplicateDisplayName = ref('');
const duplicateManufacturer = ref('');
const duplicateFixtureNameField = ref('');
const duplicateRevision = ref('');

const showExport = ref(false);
const exportPayload = ref<FixtureConnectorExport | null>(null);
const exportLoading = ref(false);
const exportError = ref<string | null>(null);
const copied = ref(false);

type RepublishFailure = { id: string; label: string; message: string };

const showRepublishAll = ref(false);
const republishingAll = ref(false);
const republishDone = ref(false);
const republishCancelled = ref(false);
const republishProgress = ref({ done: 0, total: 0, current: '' });
const republishSucceeded = ref(0);
const republishFailures = ref<RepublishFailure[]>([]);

const selectedDefinition = ref<FixtureDefinition | null>(null);
const orbitVersions = ref<OrbitVersion[]>([]);
const orbitVersionsTotal = ref(0);
const loadingOrbitVersions = ref(false);
const orbitVersionsError = ref<string | null>(null);
const deletingOrbitVersionId = ref<string | null>(null);
let orbitVersionsReq = 0;

type OrbitFixtureTarget = {
  fixtureId: string;
  label: string;
  target: FixtureOrbitRef['target'];
  projectId: string;
  modelId: string;
};

const ORBIT_REF_BATCH = 12;

const showPurgeOrbitVersions = ref(false);
const purgeBeforeDate = ref('');
const purgePreviewLoading = ref(false);
const purgePreview = ref<{ fixtures: number; versions: number } | null>(null);
const purgePreviewError = ref<string | null>(null);
const purgingOrbitVersions = ref(false);
const purgeDone = ref(false);
const purgeCancelled = ref(false);
const purgeProgress = ref({ done: 0, total: 0, current: '' });
const purgeDeleted = ref(0);
const purgeFailures = ref<RepublishFailure[]>([]);

const ORIGIN_CHIPS: Array<{ key: OriginFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'gdtf-share', label: 'GDTF Share' },
  { key: 'upload', label: 'Uploaded' },
  { key: 'mvr', label: 'MVR' },
  { key: 'manual', label: 'Manual' },
];

function originLabel(o: FixtureOrigin): string {
  return FIXTURE_ORIGIN_LABELS[o] ?? o;
}

function categoryOf(f: FixtureListItem): string {
  return fixtureCategoryFromTags(f.tags, store.assignableLabels);
}

/** Fixtures after search + origin + status filters (not manufacturer). */
const preManufacturer = computed(() => {
  const q = search.value.trim().toLowerCase();
  return fixtures.value.filter((f) => {
    if (originFilter.value !== 'all' && f.origin !== originFilter.value) return false;
    if (statusFilter.value !== 'all' && f.status !== statusFilter.value) return false;
    if (!q) return true;
    const hay = `${f.displayName ?? ''} ${f.name} ${f.manufacturer} ${f.fixtureName}`.toLowerCase();
    return q.split(/\s+/).every((term) => hay.includes(term));
  });
});

const displayManufacturers = computed(() => {
  const counts = new Map<string, number>();
  for (const f of preManufacturer.value) {
    const m = f.manufacturer || 'Unknown';
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

const filtered = computed(() =>
  preManufacturer.value.filter(
    (f) => selectedManufacturer.value === '__all__' || (f.manufacturer || 'Unknown') === selectedManufacturer.value,
  ),
);

const groupedFixtures = computed(() => {
  const groups = new Map<string, FixtureListItem[]>();
  for (const f of filtered.value) {
    const m = f.manufacturer || 'Unknown';
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m)!.push(f);
  }
  for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
});

const selected = computed(() => fixtures.value.find((f) => f.id === selectedId.value) ?? null);

const selectedHasCustomMeshes = computed(() => {
  if (selected.value?.hasCustomMeshes) return true;
  if (selectedDefinition.value) return fixtureHasCustomMeshes(selectedDefinition.value);
  return false;
});

const selectedOrbitRef = computed(() => readFixtureOrbitRef(selectedDefinition.value));

const orbitVersionsUrl = computed(() => {
  const ref = selectedOrbitRef.value;
  if (!ref) return null;
  const base = ref.target === 'dev' ? 'https://orbit-dev.rebus.industries' : 'https://orbit.rebus.industries';
  return `${base}/projects/${ref.projectId}/models/${ref.modelId}/versions`;
});

const totalCount = computed(() => fixtures.value.length);
const withPreview = computed(() => fixtures.value.filter((f) => f.hasPreview).length);
const publishedCount = computed(() => fixtures.value.filter((f) => f.status === 'published').length);
const updatesCount = computed(() => fixtures.value.filter((f) => f.updateAvailable).length);
const orbitPublishedCount = computed(() => fixtures.value.filter((f) => fixtureHasOrbitPublish(f)).length);

const listCountLabel = computed(() => `${filtered.value.length} / ${totalCount.value} fixtures`);

function orbitPublishBlockedReason(f: FixtureListItem): string | null {
  if (!f.manufacturer?.trim() || !f.fixtureName?.trim()) {
    return 'manufacturer and fixture name are required';
  }
  return null;
}

const republishCandidates = computed(() =>
  fixtures.value.filter((f) => !orbitPublishBlockedReason(f)),
);

const republishSkipped = computed(() =>
  fixtures.value.filter((f) => orbitPublishBlockedReason(f)),
);

const republishProgressPct = computed(() => {
  const { done, total } = republishProgress.value;
  return total > 0 ? Math.round((done / total) * 100) : 0;
});

const purgeProgressPct = computed(() => {
  const { done, total } = purgeProgress.value;
  return total > 0 ? Math.round((done / total) * 100) : 0;
});

const purgeCutoffLabel = computed(() => {
  const cutoff = parsePurgeCutoff(purgeBeforeDate.value);
  return cutoff ? cutoff.toLocaleDateString() : '';
});

async function enrichCustomMeshFlags(): Promise<void> {
  const pending = fixtures.value.filter((f) => f.hasCustomMeshes === undefined);
  if (!pending.length) return;

  const BATCH = 16;
  for (let i = 0; i < pending.length; i += BATCH) {
    const chunk = pending.slice(i, i + BATCH);
    await Promise.all(chunk.map(async (f) => {
      try {
        const { fixture } = await fixturesApi.get(f.id);
        upsert({
          ...fixture,
          hasCustomMeshes: fixture.hasCustomMeshes ?? fixtureHasCustomMeshes(fixture.definition),
        });
      } catch {
        /* non-fatal — leave icon hidden for this row */
      }
    }));
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await fixturesApi.list({ limit: PAGE });
    fixtures.value = res.fixtures.map((f) => enrichFixtureListItem(f));
    if (!selectedId.value && res.fixtures[0]) selectedId.value = res.fixtures[0].id;
    void bulkCheckUpdates();
    void enrichOrbitStatus();
    void enrichCustomMeshFlags();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load PRISM library';
  } finally {
    loading.value = false;
  }
}

async function enrichOrbitStatus(): Promise<void> {
  if (enrichingOrbit.value) return;
  enrichingOrbit.value = true;
  try {
    await enrichFixturesOrbitFromDetails(
      fixtures.value,
      async (id) => (await fixturesApi.get(id)).fixture,
      upsert,
    );
  } finally {
    enrichingOrbit.value = false;
  }
}

function upsert(item: FixtureListItem & { definition?: FixtureDefinition | null }): void {
  const enriched = enrichFixtureListItem(item);
  const { definition: _omit, ...row } = enriched;
  const idx = fixtures.value.findIndex((f) => f.id === row.id);
  if (idx >= 0) fixtures.value[idx] = { ...fixtures.value[idx], ...row };
  else fixtures.value = [row, ...fixtures.value];
}

async function bulkCheckUpdates(): Promise<void> {
  const ids = fixtures.value.filter((f) => f.gdtfShareUuid).map((f) => f.id);
  if (!ids.length) return;
  checkingUpdates.value = true;
  try {
    const res = await fixturesApi.bulkCheckUpdates(ids);
    fixtures.value = fixtures.value.map((f) => ({
      ...f,
      updateAvailable: f.gdtfShareUuid ? (res.updates[f.id] ?? false) : f.updateAvailable,
    }));
  } catch {
    /* non-fatal */
  } finally {
    checkingUpdates.value = false;
  }
}

function selectFixture(f: FixtureListItem): void {
  selectedId.value = f.id;
}

async function loadSelectedOrbitVersions(): Promise<void> {
  const id = selectedId.value;
  orbitVersions.value = [];
  orbitVersionsTotal.value = 0;
  orbitVersionsError.value = null;
  selectedDefinition.value = null;
  if (!id) return;

  const reqId = ++orbitVersionsReq;
  loadingOrbitVersions.value = true;
  try {
    const full = await fixturesApi.get(id);
    if (reqId !== orbitVersionsReq) return;
    selectedDefinition.value = full.fixture.definition ?? null;
    upsert(full.fixture);

    const ref = readFixtureOrbitRef(selectedDefinition.value);
    if (!ref) return;

    const res = await orbitApi.modelVersions(ref.target, ref.projectId, ref.modelId);
    if (reqId !== orbitVersionsReq) return;
    orbitVersions.value = res.items;
    orbitVersionsTotal.value = res.totalCount;
  } catch (err) {
    if (reqId !== orbitVersionsReq) return;
    orbitVersionsError.value = (err as ApiError).message ?? 'failed to load Orbit versions';
  } finally {
    if (reqId === orbitVersionsReq) loadingOrbitVersions.value = false;
  }
}

function formatOrbitVersionDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function isLatestOrbitVersion(index: number): boolean {
  return index === 0;
}

function isStoredOrbitVersion(versionId: string): boolean {
  return selectedOrbitRef.value?.versionId === versionId;
}

async function deleteOrbitVersion(version: OrbitVersion): Promise<void> {
  const ref = selectedOrbitRef.value;
  if (!ref || deletingOrbitVersionId.value) return;
  if (orbitVersions.value.length <= 1) {
    orbitVersionsError.value = 'Cannot delete the only Orbit version.';
    return;
  }
  const label = version.message?.trim() || version.id.slice(0, 8);
  if (!window.confirm(`Delete Orbit version "${label}"? This cannot be undone.`)) return;

  deletingOrbitVersionId.value = version.id;
  orbitVersionsError.value = null;
  try {
    await orbitApi.deleteModelVersions(ref.target, ref.projectId, [version.id]);
    await loadSelectedOrbitVersions();
  } catch (err) {
    orbitVersionsError.value = (err as ApiError).message ?? 'failed to delete Orbit version';
  } finally {
    deletingOrbitVersionId.value = null;
  }
}

function defaultPurgeBeforeDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parsePurgeCutoff(dateStr: string): Date | null {
  if (!dateStr.trim()) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

async function resolveOrbitFixtureTargets(): Promise<OrbitFixtureTarget[]> {
  type Row = FixtureListItem & { definition?: FixtureDefinition | null };
  const candidates = fixtures.value.filter((f) => fixtureHasOrbitPublish(f)) as Row[];
  const missing = candidates.filter((f) => !readFixtureOrbitRef(f.definition));
  for (let i = 0; i < missing.length; i += ORBIT_REF_BATCH) {
    const chunk = missing.slice(i, i + ORBIT_REF_BATCH);
    await Promise.all(chunk.map(async (f) => {
      try {
        const detail = await fixturesApi.get(f.id);
        upsert(detail.fixture);
      } catch {
        /* non-fatal */
      }
    }));
  }
  const out: OrbitFixtureTarget[] = [];
  for (const f of candidates) {
    const ref = readFixtureOrbitRef(f.definition);
    if (!ref) continue;
    out.push({
      fixtureId: f.id,
      label: fixtureLabel(f),
      target: ref.target,
      projectId: ref.projectId,
      modelId: ref.modelId,
    });
  }
  return out;
}

function groupOrbitTargets(targets: OrbitFixtureTarget[]) {
  const map = new Map<string, { target: FixtureOrbitRef['target']; projectId: string; modelIds: string[] }>();
  for (const t of targets) {
    const key = `${t.target}:${t.projectId}`;
    let group = map.get(key);
    if (!group) {
      group = { target: t.target, projectId: t.projectId, modelIds: [] };
      map.set(key, group);
    }
    if (!group.modelIds.includes(t.modelId)) group.modelIds.push(t.modelId);
  }
  return [...map.values()];
}

function resetPurgeState(): void {
  purgeDone.value = false;
  purgeCancelled.value = false;
  purgeProgress.value = { done: 0, total: 0, current: '' };
  purgeDeleted.value = 0;
  purgeFailures.value = [];
}

function openPurgeOrbitVersions(): void {
  resetPurgeState();
  purgeBeforeDate.value = defaultPurgeBeforeDate();
  purgePreview.value = null;
  purgePreviewError.value = null;
  showPurgeOrbitVersions.value = true;
  void runPurgeOrbitPreview();
}

function onPurgeModalClose(): void {
  if (purgingOrbitVersions.value) {
    purgeCancelled.value = true;
    return;
  }
  showPurgeOrbitVersions.value = false;
}

async function runPurgeOrbitPreview(): Promise<void> {
  const cutoff = parsePurgeCutoff(purgeBeforeDate.value);
  if (!cutoff) {
    purgePreviewError.value = 'Choose a valid date.';
    purgePreview.value = null;
    return;
  }
  purgePreviewLoading.value = true;
  purgePreviewError.value = null;
  try {
    const targets = await resolveOrbitFixtureTargets();
    if (!targets.length) {
      purgePreview.value = { fixtures: 0, versions: 0 };
      return;
    }
    let versions = 0;
    let fixtures = 0;
    for (const group of groupOrbitTargets(targets)) {
      const res = await orbitApi.purgeVersionsBefore(group.target, group.projectId, {
        before: cutoff.toISOString(),
        modelIds: group.modelIds,
        dryRun: true,
      });
      versions += res.versionCount;
      fixtures += res.modelsWithDeletions;
    }
    purgePreview.value = { fixtures, versions };
  } catch (err) {
    purgePreviewError.value = (err as ApiError).message ?? 'preview failed';
    purgePreview.value = null;
  } finally {
    purgePreviewLoading.value = false;
  }
}

async function runPurgeOrbitVersions(): Promise<void> {
  const cutoff = parsePurgeCutoff(purgeBeforeDate.value);
  if (!cutoff || purgingOrbitVersions.value) return;
  const targets = await resolveOrbitFixtureTargets();
  if (!targets.length) return;

  purgingOrbitVersions.value = true;
  purgeDone.value = false;
  purgeCancelled.value = false;
  purgeProgress.value = { done: 0, total: targets.length, current: '' };
  purgeDeleted.value = 0;
  purgeFailures.value = [];
  error.value = null;

  for (let i = 0; i < targets.length; i++) {
    if (purgeCancelled.value) break;
    const t = targets[i]!;
    purgeProgress.value = {
      done: i,
      total: targets.length,
      current: t.label,
    };
    try {
      const res = await orbitApi.purgeVersionsBefore(t.target, t.projectId, {
        before: cutoff.toISOString(),
        modelIds: [t.modelId],
        dryRun: false,
      });
      purgeDeleted.value += res.deletedCount;
      for (const failure of res.failures) {
        purgeFailures.value.push({
          id: t.fixtureId,
          label: t.label,
          message: failure.error,
        });
      }
    } catch (err) {
      purgeFailures.value.push({
        id: t.fixtureId,
        label: t.label,
        message: (err as ApiError).message ?? 'purge failed',
      });
    }
  }

  purgeProgress.value = {
    done: purgeCancelled.value ? purgeProgress.value.done : targets.length,
    total: targets.length,
    current: '',
  };
  purgeDone.value = true;
  purgingOrbitVersions.value = false;
  if (selectedId.value) void loadSelectedOrbitVersions();
}

function openEditor(id: string, query?: Record<string, string>): void {
  void router.push({ name: 'fixture-editor', params: { id }, query });
}

function prefillDuplicateForm(f: FixtureListItem): void {
  duplicateSource.value = f;
  duplicateName.value = defaultDuplicateName(f.name);
  duplicateDisplayName.value = f.displayName?.trim()
    ? defaultDuplicateName(f.displayName.trim())
    : '';
  duplicateManufacturer.value = f.manufacturer;
  duplicateFixtureNameField.value = f.fixtureName;
  duplicateRevision.value = f.revision ?? '';
}

function openDuplicateDialog(f: FixtureListItem): void {
  prefillDuplicateForm(f);
  showDuplicate.value = true;
}

async function duplicateFixture(
  f: FixtureListItem,
  overrides: {
    name?: string;
    manufacturer?: string;
    fixtureName?: string;
    revision?: string | null;
    displayName?: string | null;
  } = {},
): Promise<void> {
  copyingId.value = f.id;
  error.value = null;
  try {
    const res = await fixturesApi.duplicate(f.id, overrides);
    upsert(res.fixture);
    selectedId.value = res.fixture.id;
    showDuplicate.value = false;
    duplicateSource.value = null;
    openEditor(res.fixture.id, { from: 'duplicate' });
  } catch (err) {
    error.value = (err as ApiError).message ?? 'duplicate failed';
  } finally {
    copyingId.value = null;
  }
}

async function confirmDuplicateDialog(): Promise<void> {
  const source = duplicateSource.value;
  if (!source) return;
  const name = duplicateName.value.trim();
  if (!name) return;
  await duplicateFixture(source, {
    name,
    manufacturer: duplicateManufacturer.value.trim() || undefined,
    fixtureName: duplicateFixtureNameField.value.trim() || undefined,
    revision: duplicateRevision.value.trim() || null,
    displayName: duplicateDisplayName.value.trim() || null,
  });
}

async function onCategoryChange(category: string): Promise<void> {
  const f = selected.value;
  if (!f || savingCategory.value) return;
  savingCategory.value = true;
  try {
    const tags = tagsWithFixtureCategory(f.tags, category, store.assignableLabels);
    const res = await fixturesApi.update(f.id, { tags });
    upsert(res.fixture);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to update category';
  } finally {
    savingCategory.value = false;
  }
}

async function toggleStatus(): Promise<void> {
  const f = selected.value;
  if (!f || savingStatus.value) return;
  const next = f.status === 'published' ? 'draft' : 'published';
  savingStatus.value = true;
  try {
    const res = await fixturesApi.update(f.id, { status: next });
    upsert(res.fixture);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to update status';
  } finally {
    savingStatus.value = false;
  }
}

async function removeFixture(f: FixtureListItem): Promise<void> {
  if (!confirm(`Delete "${fixtureLabel(f)}" from the PRISM library?`)) return;
  try {
    await fixturesApi.remove(f.id);
    fixtures.value = fixtures.value.filter((x) => x.id !== f.id);
    if (selectedId.value === f.id) selectedId.value = fixtures.value[0]?.id ?? null;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'delete failed';
  }
}

async function createBlank(): Promise<void> {
  const name = newName.value.trim();
  if (!name) return;
  creating.value = true;
  try {
    const res = await fixturesApi.create({ name });
    showCreate.value = false;
    newName.value = '';
    openEditor(res.fixture.id);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'create failed';
  } finally {
    creating.value = false;
  }
}

async function onFile(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  importing.value = true;
  error.value = null;
  try {
    const res = await fixturesApi.importGdtf(file);
    await load();
    openEditor(res.fixture.id);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'import failed';
  } finally {
    importing.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

async function openExport(id: string): Promise<void> {
  showExport.value = true;
  exportLoading.value = true;
  exportError.value = null;
  exportPayload.value = null;
  copied.value = false;
  try {
    const res = await fixturesApi.export(id);
    exportPayload.value = res.fixture;
  } catch (err) {
    exportError.value = (err as ApiError).message ?? 'export failed';
  } finally {
    exportLoading.value = false;
  }
}

const exportJson = computed(() =>
  exportPayload.value ? JSON.stringify(exportPayload.value, null, 2) : '',
);

async function copyExport(): Promise<void> {
  if (!exportJson.value) return;
  try {
    await navigator.clipboard.writeText(exportJson.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    /* clipboard unavailable */
  }
}

function resetFilters(): void {
  search.value = '';
  selectedManufacturer.value = '__all__';
  originFilter.value = 'all';
  statusFilter.value = 'all';
}

function resetRepublishState(): void {
  republishDone.value = false;
  republishCancelled.value = false;
  republishProgress.value = { done: 0, total: republishCandidates.value.length, current: '' };
  republishSucceeded.value = 0;
  republishFailures.value = [];
}

function openRepublishAll(): void {
  resetRepublishState();
  showRepublishAll.value = true;
}

function onRepublishModalClose(): void {
  if (republishingAll.value) {
    republishCancelled.value = true;
    return;
  }
  showRepublishAll.value = false;
}

async function runRepublishAll(): Promise<void> {
  const candidates = republishCandidates.value;
  if (!candidates.length || republishingAll.value) return;
  republishingAll.value = true;
  republishDone.value = false;
  republishCancelled.value = false;
  republishProgress.value = { done: 0, total: candidates.length, current: '' };
  republishSucceeded.value = 0;
  republishFailures.value = [];
  error.value = null;

  for (let i = 0; i < candidates.length; i++) {
    if (republishCancelled.value) break;
    const f = candidates[i]!;
    republishProgress.value = {
      done: i,
      total: candidates.length,
      current: fixtureLabel(f),
    };
    try {
      const res = await fixturesApi.publishToOrbit(f.id);
      upsert(res.fixture);
      republishSucceeded.value += 1;
    } catch (err) {
      republishFailures.value.push({
        id: f.id,
        label: fixtureLabel(f),
        message: (err as ApiError).message ?? 'publish to Orbit failed',
      });
    }
  }

  republishProgress.value = {
    done: republishCancelled.value ? republishProgress.value.done : candidates.length,
    total: candidates.length,
    current: '',
  };
  republishDone.value = true;
  republishingAll.value = false;
  if (selectedId.value) void loadSelectedOrbitVersions();
}

watch(selectedId, () => {
  void loadSelectedOrbitVersions();
});

onMounted(() => {
  void store.ensureLoaded();
  void load();
});
</script>

<template>
  <div class="prism-library page-fill">
    <header class="lib-header">
      <div class="header-brand">
        <span class="brand-icon" aria-hidden="true">P</span>
        <div>
          <h1>PRISM Fixture Library</h1>
          <p class="header-sub">
            The downloaded &amp; modified fixtures designed for use with the ORBIT connector and ORBIT.
            Edit, categorise, version and export them here.
          </p>
        </div>
      </div>
      <div class="lib-actions">
        <button class="btn-outline" :disabled="loading" @click="load">
          <Icon name="refresh" :size="16" /> Refresh
        </button>
        <button class="btn-outline" :disabled="checkingUpdates" @click="bulkCheckUpdates">
          <Icon name="sync" :size="16" /> {{ checkingUpdates ? 'Checking…' : 'Check updates' }}
        </button>
        <button
          class="btn-outline"
          :disabled="loading || republishingAll || !republishCandidates.length"
          :title="!republishCandidates.length ? 'No fixtures with manufacturer and fixture name' : 'Republish every library fixture to Orbit'"
          @click="openRepublishAll"
        >
          <Icon name="cloud_upload" :size="16" /> Republish all
        </button>
        <button
          class="btn-outline"
          :disabled="loading || purgingOrbitVersions || !orbitPublishedCount"
          :title="!orbitPublishedCount ? 'No fixtures published to Orbit yet' : 'Delete Orbit versions older than a date across all library fixtures'"
          @click="openPurgeOrbitVersions"
        >
          <Icon name="history" :size="16" /> Purge old Orbit versions
        </button>
        <RouterLink :to="{ name: 'fixtures' }" class="btn-primary link-btn">
          <Icon name="travel_explore" :size="16" /> Browse GDTF Share
        </RouterLink>
        <input ref="fileInput" type="file" accept=".gdtf" hidden @change="onFile" />
      </div>
    </header>

    <div class="stat-strip">
      <span class="stat"><strong>{{ totalCount }}</strong> fixtures</span>
      <span class="stat"><strong>{{ withPreview }}</strong> with 3D</span>
      <span class="stat"><strong>{{ publishedCount }}</strong> published</span>
      <span class="stat"><strong>{{ orbitPublishedCount }}</strong> on Orbit{{ enrichingOrbit ? '…' : '' }}</span>
      <span class="stat" :class="{ warn: updatesCount }"><strong>{{ updatesCount }}</strong> updates available</span>
    </div>

    <div class="filter-toolbar">
      <div class="search-wrap">
        <Icon name="search" :size="16" class="search-icon" />
        <input v-model="search" class="search-input" type="search" placeholder="Search fixture, manufacturer…" />
      </div>
      <div class="filter-pills">
        <div class="chip-row">
          <span class="chip-label">Origin</span>
          <button
            v-for="chip in ORIGIN_CHIPS"
            :key="chip.key"
            type="button"
            class="chip"
            :class="{ active: originFilter === chip.key }"
            @click="originFilter = chip.key"
          >{{ chip.label }}</button>
        </div>
        <div class="chip-row">
          <span class="chip-label">Status</span>
          <button type="button" class="chip" :class="{ active: statusFilter === 'all' }" @click="statusFilter = 'all'">All</button>
          <button type="button" class="chip" :class="{ active: statusFilter === 'draft' }" @click="statusFilter = 'draft'">Draft</button>
          <button type="button" class="chip" :class="{ active: statusFilter === 'published' }" @click="statusFilter = 'published'">Published</button>
        </div>
      </div>
      <div class="toolbar-right">
        <button type="button" class="btn-reset" @click="resetFilters">Reset</button>
        <span class="count-label">{{ listCountLabel }}</span>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>

    <div class="lib-body">
      <aside class="mfg-sidebar">
        <h2>Manufacturers</h2>
        <button
          type="button"
          class="mfg-item"
          :class="{ active: selectedManufacturer === '__all__' }"
          @click="selectedManufacturer = '__all__'"
        >
          <span>All manufacturers</span>
          <span class="mfg-count">{{ preManufacturer.length }}</span>
        </button>
        <button
          v-for="m in displayManufacturers"
          :key="m.name"
          type="button"
          class="mfg-item"
          :class="{ active: selectedManufacturer === m.name }"
          @click="selectedManufacturer = m.name"
        >
          <span>{{ m.name }}</span>
          <span class="mfg-count">{{ m.count }}</span>
        </button>
      </aside>

      <section class="fixture-list">
        <div v-if="loading && !fixtures.length" class="muted pad">Loading…</div>
        <div v-else-if="!fixtures.length" class="empty-state">
          <Icon name="lightbulb" :size="32" />
          <p>No fixtures in the PRISM library yet.</p>
          <RouterLink :to="{ name: 'fixtures' }" class="btn-primary link-btn">
            <Icon name="travel_explore" :size="16" /> Browse GDTF Share to download one
          </RouterLink>
        </div>
        <div v-else-if="!groupedFixtures.length" class="muted pad">No fixtures match the current filters.</div>

        <template v-for="[mfg, list] in groupedFixtures" :key="mfg">
          <div class="mfg-group-header">
            <span class="mfg-logo">{{ mfg.charAt(0) }}</span>
            <span class="mfg-group-name">{{ mfg }}</span>
            <span class="mfg-group-count muted">{{ list.length }}</span>
          </div>

          <button
            v-for="f in list"
            :key="f.id"
            type="button"
            class="fixture-row"
            :class="{ active: selectedId === f.id }"
            @click="selectFixture(f)"
          >
            <span
              v-if="categoryOf(f) !== 'Unassigned'"
              class="type-bar"
              :style="{ background: store.colorFor(categoryOf(f)) }"
              :title="categoryOf(f)"
              aria-hidden="true"
            />
            <span
              class="status-dot"
              :class="f.status === 'published' ? 'published' : 'draft'"
              :title="f.status === 'published' ? 'Published — ready for connector/ORBIT' : 'Draft'"
            />
            <div class="row-main">
              <span class="row-title">
                {{ fixtureLabel(f) }}
                <span v-if="f.updateAvailable" class="update-badge" title="Newer GDTF revision available">
                  <Icon name="arrow_upward" :size="11" />
                </span>
              </span>
              <span class="row-sub muted">
                <span v-if="f.displayName?.trim()">{{ f.name }} · </span>{{ f.fixtureName || f.manufacturer }}
              </span>
            </div>
            <span class="origin-badge" :class="`origin-${f.origin}`">{{ originLabel(f.origin) }}</span>
            <span
              v-if="f.hasCustomMeshes"
              class="data-icon custom-mesh-icon on"
              title="Custom mesh assigned"
            >
              <Icon name="upload_file" :size="16" />
            </span>
            <span class="data-icon" :class="{ on: f.hasPreview }" title="3D preview">
              <Icon name="view_in_ar" :size="18" />
            </span>
          </button>
        </template>
      </section>

      <aside class="detail-panel">
        <div v-if="!selected" class="detail-empty muted">Select a fixture to view details.</div>
        <div v-else class="fixture-detail">
          <h2 class="section-label">PRISM library fixture</h2>
          <p class="detail-name">{{ fixtureLabel(selected) }}</p>
          <p class="detail-sub muted">
            <span v-if="selected.displayName?.trim()">{{ selected.name }} · </span>{{ selected.manufacturer }} — {{ selected.fixtureName }}
          </p>

          <div class="icon-actions">
            <button type="button" class="icon-action" title="Open in editor" @click="openEditor(selected.id)">
              <Icon name="edit" :size="16" />
            </button>
            <button
              type="button"
              class="icon-action"
              title="Duplicate… (Shift+click: duplicate now)"
              :disabled="copyingId === selected.id"
              @click.exact="openDuplicateDialog(selected)"
              @click.shift="duplicateFixture(selected)"
            >
              <Icon name="content_copy" :size="16" />
            </button>
            <button type="button" class="icon-action" title="Export for connector / ORBIT" @click="openExport(selected.id)">
              <Icon name="ios_share" :size="16" />
            </button>
            <button type="button" class="icon-action danger" title="Delete" @click="removeFixture(selected)">
              <Icon name="delete" :size="16" />
            </button>
          </div>

          <div class="status-row">
            <span class="origin-badge" :class="`origin-${selected.origin}`">{{ originLabel(selected.origin) }}</span>
            <span v-if="selected.hasPreview" class="full-gdtf-pill">3D ready</span>
            <span v-if="selectedHasCustomMeshes" class="full-gdtf-pill custom-mesh-pill">Custom mesh</span>
            <button
              type="button"
              class="status-toggle"
              :class="selected.status"
              :disabled="savingStatus"
              :title="selected.status === 'published' ? 'Click to unpublish' : 'Publish for connector/ORBIT'"
              @click="toggleStatus"
            >
              <Icon :name="selected.status === 'published' ? 'check_circle' : 'radio_button_unchecked'" :size="14" />
              {{ selected.status === 'published' ? 'Published' : 'Draft' }}
            </button>
          </div>

          <FixtureTypeSelect
            class="type-select-block"
            :model-value="categoryOf(selected)"
            :disabled="savingCategory"
            label="Fixture type"
            @update:model-value="onCategoryChange"
          />

          <div class="source-card">
            <h4 class="source-card-title">Source &amp; provenance</h4>
            <dl class="source-meta">
              <dt>Origin</dt>
              <dd>{{ originLabel(selected.origin) }}</dd>
              <dt>GDTF Share</dt>
              <dd class="mono small-uuid">{{ selected.gdtfShareUuid ?? '—' }}</dd>
              <dt>GDTF hash</dt>
              <dd class="mono">{{ selected.sourceGdtfHash ? selected.sourceGdtfHash.slice(0, 12) + '…' : '—' }}</dd>
              <dt>Updates</dt>
              <dd>
                <span v-if="selected.updateAvailable && selected.gdtfShareUuid && selected.importSource !== 'duplicate'" class="pill warn-pill">Update available</span>
                <span v-else-if="selected.gdtfShareUuid" class="muted">Up to date</span>
                <span v-else class="muted">Not linked</span>
              </dd>
            </dl>
          </div>

          <div class="connector-card">
            <h4 class="source-card-title">Connector / ORBIT</h4>
            <p class="connector-note muted">
              This PRISM-library fixture is the authoritative source the ORBIT connector and ORBIT consume.
            </p>
            <button type="button" class="btn-export" @click="openExport(selected.id)">
              <Icon name="ios_share" :size="15" /> View export payload
            </button>

            <div v-if="selectedOrbitRef || loadingOrbitVersions" class="orbit-versions-block">
              <div class="orbit-versions-head">
                <span class="orbit-versions-title">Orbit versions</span>
                <a
                  v-if="orbitVersionsUrl"
                  class="orbit-versions-link"
                  :href="orbitVersionsUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open in Orbit
                </a>
              </div>
              <p v-if="selectedOrbitRef" class="muted small orbit-model-id">
                Model <span class="mono">{{ selectedOrbitRef.modelId }}</span>
                <span v-if="orbitVersionsTotal"> · {{ orbitVersionsTotal }} version{{ orbitVersionsTotal === 1 ? '' : 's' }}</span>
              </p>
              <div v-if="loadingOrbitVersions" class="muted small">Loading Orbit versions…</div>
              <div v-else-if="orbitVersionsError" class="orbit-versions-error">{{ orbitVersionsError }}</div>
              <ul v-else-if="orbitVersions.length" class="orbit-version-list">
                <li v-for="(v, idx) in orbitVersions" :key="v.id">
                  <div class="orbit-version-body">
                    <div class="orbit-version-main">
                      <span class="mono orbit-version-id">{{ v.id.slice(0, 8) }}</span>
                      <span v-if="isLatestOrbitVersion(idx)" class="pill orbit-pill latest">Latest</span>
                      <span v-if="isStoredOrbitVersion(v.id)" class="pill orbit-pill stored">PRISM ref</span>
                    </div>
                    <span class="muted small orbit-version-date">{{ formatOrbitVersionDate(v.createdAt) }}</span>
                    <p v-if="v.message?.trim()" class="orbit-version-msg muted small">{{ v.message }}</p>
                  </div>
                  <button
                    v-if="orbitVersions.length > 1"
                    type="button"
                    class="btn-version-delete"
                    :disabled="deletingOrbitVersionId === v.id"
                    :title="isLatestOrbitVersion(idx) ? 'Delete latest — previous version becomes latest' : 'Delete this version'"
                    @click="deleteOrbitVersion(v)"
                  >
                    <Icon name="delete" :size="14" />
                  </button>
                </li>
              </ul>
              <p v-else-if="selectedOrbitRef" class="muted small">No Orbit versions found.</p>
            </div>
            <p v-else class="muted small orbit-not-published">Not published to Orbit yet.</p>
          </div>
        </div>
      </aside>
    </div>

    <div class="lib-footer">
      <button class="btn-outline small" :disabled="importing" @click="fileInput?.click()">
        <Icon name="upload_file" :size="14" /> Upload .gdtf
      </button>
      <button class="btn-outline small" @click="showCreate = true">
        <Icon name="add" :size="14" /> Blank fixture
      </button>
    </div>

    <Modal
      v-if="showRepublishAll"
      title="Republish all to Orbit"
      :subtitle="republishDone ? 'Bulk republish finished' : `${republishCandidates.length} fixtures ready`"
      :max-width="560"
      @close="onRepublishModalClose"
    >
      <div v-if="!republishDone && !republishingAll" class="republish-intro">
        <p class="muted small">
          Publishes or republishes every fixture in the PRISM library that has a manufacturer and fixture name.
          Fixtures already on Orbit are updated in place (same model id, new version).
        </p>
        <ul class="republish-summary">
          <li><strong>{{ republishCandidates.length }}</strong> to publish</li>
          <li v-if="republishSkipped.length"><strong>{{ republishSkipped.length }}</strong> skipped (missing identity)</li>
          <li><strong>{{ orbitPublishedCount }}</strong> currently on Orbit</li>
        </ul>
        <p v-if="republishSkipped.length" class="muted small">
          Skipped fixtures need manufacturer and fixture name before they can be published.
        </p>
      </div>

      <div v-else class="republish-progress">
        <div class="progress-bar" aria-hidden="true">
          <div class="progress-fill" :style="{ width: `${republishProgressPct}%` }" />
        </div>
        <p class="republish-status">
          <template v-if="republishingAll">
            {{ republishProgress.done + 1 }} / {{ republishProgress.total }}
            <span v-if="republishProgress.current" class="muted"> — {{ republishProgress.current }}</span>
          </template>
          <template v-else-if="republishCancelled">
            Stopped after {{ republishProgress.done }} of {{ republishProgress.total }}.
          </template>
          <template v-else>
            Completed {{ republishProgress.total }} fixtures.
          </template>
        </p>
        <p class="republish-result">
          <span class="ok-count">{{ republishSucceeded }} succeeded</span>
          <span v-if="republishFailures.length" class="fail-count">{{ republishFailures.length }} failed</span>
        </p>
        <ul v-if="republishFailures.length" class="republish-failures">
          <li v-for="item in republishFailures" :key="item.id">
            <strong>{{ item.label }}</strong>
            <span class="muted"> — {{ item.message }}</span>
          </li>
        </ul>
      </div>

      <template #footer>
        <button type="button" class="btn-cancel" @click="onRepublishModalClose">
          {{ republishingAll ? 'Stop' : 'Close' }}
        </button>
        <button
          v-if="!republishDone && !republishingAll"
          type="button"
          class="btn-save"
          :disabled="!republishCandidates.length"
          @click="runRepublishAll"
        >
          <Icon name="cloud_upload" :size="14" /> Start republish
        </button>
      </template>
    </Modal>

    <Modal
      v-if="showPurgeOrbitVersions"
      title="Purge old Orbit versions"
      :subtitle="purgeDone ? 'Bulk purge finished' : `${orbitPublishedCount} fixtures on Orbit`"
      :max-width="560"
      @close="onPurgeModalClose"
    >
      <div v-if="!purgeDone && !purgingOrbitVersions" class="republish-intro">
        <p class="muted small">
          Permanently deletes Orbit model versions created before the selected date for every
          fixture in the PRISM library that is published to Orbit. At least one version is always
          kept per model.
        </p>
        <label class="purge-date-field">
          <span class="purge-date-label">Delete versions older than</span>
          <input
            v-model="purgeBeforeDate"
            class="purge-date-input"
            type="date"
            :disabled="purgePreviewLoading"
            @change="runPurgeOrbitPreview"
          >
        </label>
        <p v-if="purgePreviewLoading" class="muted small">Calculating impact…</p>
        <p v-else-if="purgePreviewError" class="orbit-versions-error">{{ purgePreviewError }}</p>
        <ul v-else-if="purgePreview" class="republish-summary">
          <li><strong>{{ purgePreview.versions }}</strong> version{{ purgePreview.versions === 1 ? '' : 's' }} to delete</li>
          <li><strong>{{ purgePreview.fixtures }}</strong> fixture model{{ purgePreview.fixtures === 1 ? '' : 's' }} affected</li>
          <li v-if="purgeCutoffLabel"><span class="muted">Before {{ purgeCutoffLabel }}</span></li>
        </ul>
        <p v-if="purgePreview && !purgePreview.versions" class="muted small">
          No Orbit versions match this cutoff.
        </p>
        <p v-else class="muted small">
          This cannot be undone. PRISM may still reference deleted version ids until fixtures are republished.
        </p>
      </div>

      <div v-else class="republish-progress">
        <div class="progress-bar" aria-hidden="true">
          <div class="progress-fill" :style="{ width: `${purgeProgressPct}%` }" />
        </div>
        <p class="republish-status">
          <template v-if="purgingOrbitVersions">
            {{ purgeProgress.done + 1 }} / {{ purgeProgress.total }}
            <span v-if="purgeProgress.current" class="muted"> — {{ purgeProgress.current }}</span>
          </template>
          <template v-else-if="purgeCancelled">
            Stopped after {{ purgeProgress.done }} of {{ purgeProgress.total }}.
          </template>
          <template v-else>
            Completed {{ purgeProgress.total }} fixtures.
          </template>
        </p>
        <p class="republish-result">
          <span class="ok-count">{{ purgeDeleted }} deleted</span>
          <span v-if="purgeFailures.length" class="fail-count">{{ purgeFailures.length }} failed</span>
        </p>
        <ul v-if="purgeFailures.length" class="republish-failures">
          <li v-for="item in purgeFailures" :key="`${item.id}-${item.message}`">
            <strong>{{ item.label }}</strong>
            <span class="muted"> — {{ item.message }}</span>
          </li>
        </ul>
      </div>

      <template #footer>
        <button type="button" class="btn-cancel" @click="onPurgeModalClose">
          {{ purgingOrbitVersions ? 'Stop' : 'Close' }}
        </button>
        <button
          v-if="!purgeDone && !purgingOrbitVersions"
          type="button"
          class="btn-save danger-save"
          :disabled="purgePreviewLoading || !purgePreview?.versions"
          @click="runPurgeOrbitVersions"
        >
          <Icon name="delete" :size="14" /> Delete old versions
        </button>
      </template>
    </Modal>

    <Modal v-if="showExport" title="Connector / ORBIT export" :subtitle="exportPayload ? `${exportPayload.manufacturer} — ${exportPayload.name}` : ''" :max-width="640" @close="showExport = false">
      <div v-if="exportLoading" class="muted">Building export payload…</div>
      <div v-else-if="exportError" class="error-box">{{ exportError }}</div>
      <div v-else-if="exportPayload" class="export-body">
        <div class="export-summary">
          <span class="meta-pill">format v{{ exportPayload.exportFormatVersion }}</span>
          <span class="meta-pill">{{ exportPayload.assets.previewModel ? '1' : '0' }} model</span>
          <span class="meta-pill">{{ exportPayload.assets.ies.length }} IES</span>
          <span class="meta-pill">{{ exportPayload.assets.images.length }} images</span>
          <span class="meta-pill">{{ exportPayload.definition.parts?.length ?? 0 }} parts</span>
        </div>
        <p class="muted small">
          Endpoint: <code>GET /api/fixtures/export/{{ exportPayload.id }}</code> — the connector pulls this
          self-contained payload (identity, provenance, full definition, asset URLs).
        </p>
        <pre class="export-json">{{ exportJson }}</pre>
      </div>
      <template #footer>
        <button type="button" class="btn-cancel" @click="showExport = false">Close</button>
        <button type="button" class="btn-save" :disabled="!exportJson" @click="copyExport">
          <Icon name="content_copy" :size="14" /> {{ copied ? 'Copied!' : 'Copy JSON' }}
        </button>
      </template>
    </Modal>

    <div v-if="showDuplicate && duplicateSource" class="modal-backdrop" @click.self="showDuplicate = false">
      <div class="card modal duplicate-modal">
        <h2>Duplicate fixture</h2>
        <p class="muted small">Creates an independent draft copy. Edit identity before publishing to Orbit.</p>
        <label>Name <input v-model="duplicateName" maxlength="256" @keyup.enter="confirmDuplicateDialog" /></label>
        <label>Display name
          <input v-model="duplicateDisplayName" :placeholder="duplicateName || 'Custom label (optional)'" maxlength="256" />
        </label>
        <label>Manufacturer <input v-model="duplicateManufacturer" maxlength="256" /></label>
        <label>Fixture name <input v-model="duplicateFixtureNameField" maxlength="256" /></label>
        <label>Revision <input v-model="duplicateRevision" maxlength="128" /></label>
        <div class="h-row duplicate-actions">
          <button type="button" class="btn-cancel" @click="showDuplicate = false">Cancel</button>
          <button
            type="button"
            class="btn-save"
            :disabled="!duplicateName.trim() || copyingId === duplicateSource.id"
            @click="confirmDuplicateDialog"
          >
            {{ copyingId === duplicateSource.id ? 'Duplicating…' : 'Duplicate' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false">
      <div class="card modal">
        <h2>New blank fixture</h2>
        <input v-model="newName" placeholder="Display name" @keyup.enter="createBlank" />
        <div class="h-row" style="justify-content: flex-end; gap: 8px;">
          <button class="btn-cancel" @click="showCreate = false">Cancel</button>
          <button class="btn-save" :disabled="creating" @click="createBlank"><Icon name="add" :size="14" /> Create</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prism-library {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.lib-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-shrink: 0;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
}
.header-brand { display: flex; align-items: flex-start; gap: 14px; }
.brand-icon {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--orbit-primary);
  color: #fff;
  font-size: 20px;
  font-weight: 800;
}
.lib-header h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.header-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--color-text-muted);
  max-width: 560px;
  line-height: 1.4;
}
.lib-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; }
.btn-outline, .btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: var(--radius);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  cursor: pointer;
  white-space: nowrap;
}
.btn-outline {
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg);
  color: var(--color-text);
}
.btn-outline:hover:not(:disabled) { border-color: var(--orbit-primary); color: var(--orbit-primary); }
.btn-outline:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-primary { border: 1px solid var(--orbit-primary); background: var(--orbit-primary); color: #fff; text-decoration: none; }
.btn-primary:hover:not(:disabled) { background: var(--orbit-primary-hover); border-color: var(--orbit-primary-hover); }
.link-btn { text-decoration: none; }

.stat-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
}
.stat { font-size: 12px; color: var(--color-text-muted); }
.stat strong { color: var(--color-text); font-size: 14px; margin-right: 2px; }
.stat.warn strong { color: var(--color-warn, #d97706); }

.filter-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
}
.search-wrap { position: relative; flex: 1; min-width: 200px; }
.search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); opacity: 0.5; pointer-events: none; }
.search-input {
  width: 100%;
  padding: 9px 14px 9px 36px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-input);
  color: var(--color-text);
  font-size: 13px;
}
.filter-pills { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 20px; }
.chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.chip-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
  margin-right: 2px;
}
.chip {
  padding: 5px 12px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-bg);
  color: var(--color-text-muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.chip:hover { border-color: var(--orbit-primary); color: var(--orbit-primary); }
.chip.active { background: var(--orbit-primary); border-color: var(--orbit-primary); color: #fff; }
.toolbar-right { display: flex; align-items: center; gap: 12px; margin-left: auto; }
.btn-reset {
  padding: 7px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.btn-reset:hover { border-color: var(--orbit-primary); color: var(--orbit-primary); }
.count-label { font-size: 12px; color: var(--color-text-muted); white-space: nowrap; }

.error-box {
  margin: 10px 20px;
  padding: 10px 14px;
  border: 1px solid var(--color-error, #ef4444);
  border-radius: var(--radius);
  background: var(--color-error-bg, rgba(239, 68, 68, 0.1));
  color: var(--color-error, #ef4444);
  font-size: 13px;
}

.lib-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 220px 1fr 340px;
  overflow: hidden;
  background: var(--color-bg);
}
.mfg-sidebar {
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  min-height: 0;
  overflow-y: auto;
  padding: 12px 10px;
}
.mfg-sidebar h2 {
  margin: 0 0 8px;
  padding: 0 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.mfg-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 8px 12px;
  margin-bottom: 2px;
  border: none;
  border-radius: 999px;
  background: transparent;
  text-align: left;
  font-size: 13px;
  color: var(--color-text);
  cursor: pointer;
}
.mfg-item:hover { background: var(--color-bg-hover); }
.mfg-item.active { background: var(--orbit-primary); color: #fff; }
.mfg-count {
  font-size: 11px;
  font-weight: 600;
  min-width: 24px;
  height: 20px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.1);
}
.mfg-item.active .mfg-count { background: rgba(255, 255, 255, 0.25); }

.fixture-list { min-height: 0; overflow-y: auto; border-right: 1px solid var(--color-border); }
.mfg-group-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px 6px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}
.mfg-logo {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--orbit-primary-fade);
  color: var(--orbit-primary);
  font-size: 12px;
  font-weight: 700;
}
.mfg-group-name { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
.mfg-group-count { margin-left: auto; font-size: 11px; }

.fixture-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 16px 10px 14px;
  border: none;
  border-bottom: 1px solid var(--color-border);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.fixture-row:hover { background: var(--color-bg-hover); }
.fixture-row.active { background: rgba(255, 107, 0, 0.12); }
.type-bar { position: absolute; left: 0; top: 0; bottom: 0; width: 4px; }
.status-dot { flex-shrink: 0; width: 10px; height: 10px; border-radius: 50%; }
.status-dot.published { background: #22c55e; }
.status-dot.draft { background: var(--color-border-strong, #9ca3af); }
.row-main { min-width: 0; flex: 1; }
.row-title {
  display: block;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-sub { font-size: 11px; }
.update-badge {
  display: inline-flex;
  margin-left: 6px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--color-warn-bg, #fef3c7);
  color: var(--color-warn, #b45309);
  vertical-align: middle;
}
.origin-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
}
.origin-badge.origin-gdtf-share { background: rgba(59, 130, 246, 0.16); color: #2563eb; }
.origin-badge.origin-upload { background: rgba(168, 85, 247, 0.16); color: #9333ea; }
.origin-badge.origin-mvr { background: rgba(249, 115, 22, 0.16); color: #ea580c; }
.origin-badge.origin-manual { background: var(--color-bg-hover); color: var(--color-text-muted); }
.data-icon { flex-shrink: 0; display: flex; align-items: center; color: var(--color-text-muted); opacity: 0.35; }
.data-icon.on { opacity: 1; color: var(--orbit-primary); }
.custom-mesh-icon.on { color: #9333ea; }
.custom-mesh-pill { background: rgba(168, 85, 247, 0.16); color: #9333ea; }

.detail-panel { min-height: 0; overflow-y: auto; padding: 16px; }
.detail-empty { padding: 24px 16px; }
.fixture-detail { display: flex; flex-direction: column; gap: 10px; }
.section-label {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.detail-name { margin: 0; font-size: 17px; font-weight: 700; line-height: 1.25; }
.detail-sub { margin: 0; font-size: 12px; }
.mono { font-family: var(--font-mono); }
.small-uuid { font-size: 10px; word-break: break-all; }

.icon-actions { display: flex; gap: 6px; }
.icon-action {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  cursor: pointer;
  color: inherit;
}
.icon-action:hover:not(:disabled) { border-color: var(--orbit-primary); }
.icon-action.danger:hover { border-color: var(--color-error, #ef4444); color: var(--color-error, #ef4444); }

.status-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.full-gdtf-pill {
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--color-success-bg, rgba(34, 197, 94, 0.15));
  color: var(--color-success, #16a34a);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}
.status-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  cursor: pointer;
}
.status-toggle.published { border-color: #22c55e; color: #16a34a; }
.status-toggle.draft { color: var(--color-text-muted); }
.status-toggle:disabled { opacity: 0.55; cursor: not-allowed; }

.type-select-block { margin-top: 2px; }

.source-card, .connector-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 10px 12px;
  background: var(--color-bg-elevated);
}
.source-card-title {
  margin: 0 0 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.source-meta { display: grid; grid-template-columns: 96px 1fr; gap: 4px 8px; margin: 0; font-size: 11px; }
.source-meta dt { color: var(--color-text-muted); margin: 0; }
.source-meta dd { margin: 0; }
.pill { padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; }
.warn-pill { background: var(--color-warn-bg, #fef3c7); color: var(--color-warn, #b45309); }
.connector-note { margin: 0 0 8px; font-size: 11px; line-height: 1.45; }
.btn-export {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid var(--orbit-primary);
  border-radius: var(--radius);
  background: var(--orbit-primary-fade);
  color: var(--orbit-primary);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  cursor: pointer;
}
.btn-export:hover { background: var(--orbit-primary); color: #fff; }

.orbit-versions-block {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}
.orbit-versions-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.orbit-versions-title {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.orbit-versions-link {
  font-size: 11px;
  color: var(--orbit-primary);
  text-decoration: none;
}
.orbit-versions-link:hover { text-decoration: underline; }
.orbit-model-id { margin: 0 0 8px; }
.orbit-versions-error {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: rgba(239, 68, 68, 0.1);
  color: var(--color-error, #ef4444);
  font-size: 11px;
}
.orbit-version-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.orbit-version-list li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
}
.orbit-version-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.orbit-version-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.orbit-version-id { font-size: 11px; font-weight: 600; }
.orbit-version-date { font-size: 10px; line-height: 1.3; }
.orbit-version-msg {
  margin: 0;
  line-height: 1.35;
  word-break: break-word;
}
.orbit-pill {
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
}
.orbit-pill.latest {
  background: var(--orbit-primary-fade);
  color: var(--orbit-primary);
}
.orbit-pill.stored {
  background: rgba(34, 197, 94, 0.15);
  color: var(--color-success, #16a34a);
}
.btn-version-delete {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.btn-version-delete:hover:not(:disabled) {
  border-color: var(--color-error, #ef4444);
  color: var(--color-error, #ef4444);
}
.btn-version-delete:disabled { opacity: 0.5; cursor: not-allowed; }
.orbit-not-published { margin: 10px 0 0; }

.republish-intro { display: flex; flex-direction: column; gap: 10px; }
.republish-summary {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.6;
}
.republish-progress { display: flex; flex-direction: column; gap: 10px; }
.progress-bar {
  height: 8px;
  border-radius: 999px;
  background: var(--color-border);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--orbit-primary);
  transition: width 0.2s ease;
}
.republish-status { margin: 0; font-size: 13px; }
.republish-result { margin: 0; font-size: 12px; display: flex; gap: 12px; }
.ok-count { color: var(--color-success, #16a34a); font-weight: 700; }
.fail-count { color: var(--color-error, #ef4444); font-weight: 700; }
.republish-failures {
  margin: 0;
  padding: 10px 12px;
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  font-size: 11px;
  line-height: 1.5;
  list-style: none;
}
.republish-failures li + li { margin-top: 6px; }

.purge-date-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.purge-date-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.purge-date-input {
  width: 100%;
  max-width: 220px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  color: inherit;
  font: inherit;
}
.danger-save {
  background: var(--color-error, #ef4444);
  border-color: var(--color-error, #ef4444);
}
.danger-save:hover:not(:disabled) {
  background: #dc2626;
  border-color: #dc2626;
}

.lib-footer {
  display: flex;
  gap: 8px;
  padding: 8px 20px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
}
.lib-footer .small { font-size: 12px; padding: 6px 12px; text-transform: none; letter-spacing: 0; font-weight: 600; }

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 48px 24px;
  color: var(--color-text-muted);
  text-align: center;
}

.export-body { display: flex; flex-direction: column; gap: 10px; }
.export-summary { display: flex; flex-wrap: wrap; gap: 6px; }
.meta-pill {
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--orbit-primary-fade);
  color: var(--orbit-primary);
  font-size: 11px;
  font-weight: 700;
}
.export-json {
  margin: 0;
  padding: 12px;
  max-height: 360px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre;
}
.small { font-size: 11px; }
.small code { font-family: var(--font-mono); }

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  padding: 24px;
}
.modal {
  width: 100%;
  max-width: 400px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.modal h2 { margin: 0; font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.modal input {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-input);
  color: var(--color-text);
  font-size: 13px;
}
.btn-cancel {
  padding: 9px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.btn-save {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 16px;
  border: none;
  border-radius: var(--radius);
  background: var(--orbit-primary);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  cursor: pointer;
}
.btn-save:hover:not(:disabled) { background: var(--orbit-primary-hover); }
.btn-save:disabled { opacity: 0.55; cursor: not-allowed; }
.pad { padding: 24px 16px; }

@media (max-width: 1100px) { .lib-body { grid-template-columns: 180px 1fr 300px; } }
@media (max-width: 900px) {
  .lib-body { grid-template-columns: 1fr; grid-template-rows: auto 1fr auto; }
  .mfg-sidebar, .fixture-list { border-right: none; border-bottom: 1px solid var(--color-border); }
  .mfg-sidebar { max-height: 160px; }
}
</style>
