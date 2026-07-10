<script setup lang="ts">
/**
 * Admin UI for collaborator invite keys (REBUS Connector Light / Rhino guest access).
 * Keys exchange for a scoped ConnectorManifest without portal/Google sign-in.
 */
import { computed, onMounted, ref } from 'vue';
import Icon from '../../../shared/Icon.vue';
import {
  accessApi,
  LIGHT_CONNECTOR_FUNCTIONS,
  orbitApi,
  type ApiError,
  type ConnectorFunction,
  type CreateInviteKeyResponse,
  type InviteKeyRecord,
  type OrbitProject,
} from '../../../shared/api';

const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const keys = ref<InviteKeyRecord[]>([]);
const orbitProjects = ref<OrbitProject[]>([]);
const projectsLoading = ref(false);

const showCreate = ref(false);
const editing = ref<InviteKeyRecord | null>(null);

const formLabel = ref('');
const formTarget = ref<'prod' | 'dev'>('prod');
const formProjectIds = ref<string[]>([]);
const formManualProjectId = ref('');
const formFunctions = ref<ConnectorFunction[]>([...LIGHT_CONNECTOR_FUNCTIONS]);
const formMaxRedemptions = ref('');
const formExpiresAt = ref('');

const minted = ref<CreateInviteKeyResponse | null>(null);

const functionOptions = LIGHT_CONNECTOR_FUNCTIONS;

const activeKeys = computed(() =>
  keys.value.filter((k) => !k.revokedAt && !isExpired(k)),
);

function isExpired(key: InviteKeyRecord): boolean {
  if (!key.expiresAt) return false;
  return new Date(key.expiresAt).getTime() <= Date.now();
}

function keyStatus(key: InviteKeyRecord): 'active' | 'revoked' | 'expired' {
  if (key.revokedAt) return 'revoked';
  if (isExpired(key)) return 'expired';
  return 'active';
}

function formatProjects(key: InviteKeyRecord): string {
  if (!key.projects.length) return '—';
  return key.projects
    .map((p) => p.projectName?.trim() || p.orbitProjectId)
    .join(', ');
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function projectNameForId(id: string): string | undefined {
  const match = orbitProjects.value.find((p) => p.id === id);
  return match?.name?.trim() || undefined;
}

function buildProjectNames(ids: string[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const id of ids) {
    const name = projectNameForId(id);
    if (name) names[id] = name;
  }
  return names;
}

function resetForm() {
  formLabel.value = '';
  formTarget.value = 'prod';
  formProjectIds.value = [];
  formManualProjectId.value = '';
  formFunctions.value = [...LIGHT_CONNECTOR_FUNCTIONS];
  formMaxRedemptions.value = '';
  formExpiresAt.value = '';
}

function startCreate() {
  editing.value = null;
  resetForm();
  showCreate.value = true;
}

function startEdit(key: InviteKeyRecord) {
  showCreate.value = false;
  editing.value = key;
  formLabel.value = key.label?.trim() ?? '';
  formTarget.value = key.orbitTarget;
  formProjectIds.value = key.projects.map((p) => p.orbitProjectId);
  formFunctions.value = [...key.allowedFunctions];
  formMaxRedemptions.value = key.maxRedemptions != null ? String(key.maxRedemptions) : '';
  formExpiresAt.value = key.expiresAt ? key.expiresAt.slice(0, 16) : '';
}

function cancelForm() {
  showCreate.value = false;
  editing.value = null;
  resetForm();
}

function toggleProject(id: string) {
  const idx = formProjectIds.value.indexOf(id);
  if (idx >= 0) {
    formProjectIds.value = formProjectIds.value.filter((x) => x !== id);
  } else {
    formProjectIds.value = [...formProjectIds.value, id];
  }
}

function addManualProject() {
  const id = formManualProjectId.value.trim();
  if (!id || formProjectIds.value.includes(id)) return;
  formProjectIds.value = [...formProjectIds.value, id];
  formManualProjectId.value = '';
}

function parseMaxRedemptions(): number | null {
  const raw = formMaxRedemptions.value.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseExpiresAt(): string | null {
  const raw = formExpiresAt.value.trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard may be blocked; user can still select from the pre block.
  }
}

async function loadKeys() {
  const res = await accessApi.listInviteKeys();
  keys.value = res.keys;
}

async function loadOrbitProjects() {
  projectsLoading.value = true;
  try {
    const res = await orbitApi.projects(formTarget.value, 200);
    orbitProjects.value = res.items;
  } catch {
    orbitProjects.value = [];
  } finally {
    projectsLoading.value = false;
  }
}

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    await Promise.all([loadKeys(), loadOrbitProjects()]);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Failed to load guest keys';
  } finally {
    loading.value = false;
  }
}

async function onTargetChange() {
  await loadOrbitProjects();
}

async function createKey() {
  if (!formProjectIds.value.length) {
    error.value = 'Select at least one ORBIT project';
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    const created = await accessApi.createInviteKey({
      label: formLabel.value.trim() || null,
      orbitTarget: formTarget.value,
      orbitProjectIds: [...formProjectIds.value],
      projectNames: buildProjectNames(formProjectIds.value),
      allowedFunctions: [...formFunctions.value],
      maxRedemptions: parseMaxRedemptions(),
      expiresAt: parseExpiresAt(),
    });
    minted.value = created;
    showCreate.value = false;
    resetForm();
    await loadKeys();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Failed to create guest key';
  } finally {
    saving.value = false;
  }
}

async function saveEdit() {
  if (!editing.value) return;
  if (!formProjectIds.value.length) {
    error.value = 'Select at least one ORBIT project';
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    await accessApi.updateInviteKey(editing.value.id, {
      label: formLabel.value.trim() || null,
      orbitProjectIds: [...formProjectIds.value],
      projectNames: buildProjectNames(formProjectIds.value),
      allowedFunctions: [...formFunctions.value],
      maxRedemptions: parseMaxRedemptions(),
      expiresAt: parseExpiresAt(),
    });
    editing.value = null;
    resetForm();
    await loadKeys();
  } catch (err) {
    const apiErr = err as ApiError;
    if (apiErr.status === 404 || apiErr.status === 405) {
      error.value =
        'Editing guest keys requires permissions-service PATCH /api/access/invite-keys/:id. Revoke and create a new key until that is deployed.';
    } else {
      error.value = apiErr.message ?? 'Failed to update guest key';
    }
  } finally {
    saving.value = false;
  }
}

async function revokeKey(key: InviteKeyRecord) {
  const label = key.label?.trim() || key.id.slice(0, 8);
  if (!confirm(`Revoke guest key "${label}"? This ends all active Connector Light sessions using it.`)) return;
  saving.value = true;
  error.value = null;
  try {
    await accessApi.revokeInviteKey(key.id);
    if (editing.value?.id === key.id) cancelForm();
    await loadKeys();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Failed to revoke guest key';
  } finally {
    saving.value = false;
  }
}

async function loadDemoKey() {
  error.value = null;
  try {
    const demo = await accessApi.demoInviteKey();
    minted.value = {
      id: demo.id,
      key: demo.key,
      redeemUrl: `${window.location.origin}/api/access/invite-login?key=${encodeURIComponent(demo.key)}`,
      projects: [{ orbitProjectId: demo.orbitProjectId, projectName: null }],
      allowedFunctions: demo.allowedFunctions,
      label: 'Demo key',
      expiresAt: null,
      maxRedemptions: null,
    };
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Demo key unavailable (mock adapter only)';
  }
}

const connectorRedirectHint = 'http://localhost:29364/';

onMounted(refresh);
</script>

<template>
  <section class="guest-panel">
    <div class="guest-head">
      <div>
        <h2>Guest access (Connector Light)</h2>
        <p class="muted">
          Mint invite keys for external Rhino collaborators who do not have a portal account.
          They paste the key in Connector Light or open the redeem URL with
          <code>&amp;redirect_uri={{ connectorRedirectHint }}</code>.
        </p>
      </div>
      <div class="guest-actions">
        <button type="button" class="secondary" :disabled="loading" @click="loadDemoKey">
          <Icon name="science" :size="16" /> Demo key
        </button>
        <button type="button" class="primary" :disabled="loading" @click="startCreate">
          <Icon name="person_add" :size="16" /> New guest key
        </button>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="minted" class="minted card">
      <strong>Invite key — copy now; the plaintext is shown only once.</strong>
      <div class="minted-row">
        <span class="minted-label">Key</span>
        <pre class="minted-value">{{ minted.key }}</pre>
        <button type="button" class="small" @click="copyText(minted.key)">Copy key</button>
      </div>
      <div class="minted-row">
        <span class="minted-label">Redeem URL</span>
        <pre class="minted-value">{{ minted.redeemUrl }}</pre>
        <button type="button" class="small" @click="copyText(minted.redeemUrl)">Copy URL</button>
      </div>
      <p class="muted small">
        Connector loopback:
        <code>{{ minted.redeemUrl }}&amp;redirect_uri={{ connectorRedirectHint }}</code>
      </p>
      <button type="button" class="small" @click="minted = null">Dismiss</button>
    </div>

    <div v-if="showCreate || editing" class="form-card card">
      <h3>{{ editing ? `Edit ${editing.label?.trim() || 'guest key'}` : 'Create guest key' }}</h3>
      <div class="form-grid">
        <label>
          Guest name / label
          <input v-model="formLabel" placeholder="Acme collaborator" autocomplete="off" />
        </label>
        <label>
          ORBIT target
          <select v-model="formTarget" :disabled="!!editing" @change="onTargetChange">
            <option value="prod">prod</option>
            <option value="dev">dev</option>
          </select>
        </label>
        <label>
          Max redemptions
          <input v-model="formMaxRedemptions" type="number" min="1" placeholder="Unlimited" />
        </label>
        <label>
          Expires
          <input v-model="formExpiresAt" type="datetime-local" />
        </label>
      </div>

      <div class="projects-block">
        <span class="field-label">ORBIT project access</span>
        <p v-if="projectsLoading" class="muted small">Loading projects…</p>
        <div v-else-if="orbitProjects.length" class="project-picks">
          <label v-for="p in orbitProjects" :key="p.id" class="project-pick">
            <input
              type="checkbox"
              :checked="formProjectIds.includes(p.id)"
              @change="toggleProject(p.id)"
            />
            <span>{{ p.name?.trim() || p.id }}</span>
            <code class="muted small">{{ p.id }}</code>
          </label>
        </div>
        <p v-else class="muted small">Could not load ORBIT projects — enter ids manually below.</p>
        <div class="manual-project">
          <input
            v-model="formManualProjectId"
            placeholder="Orbit project id"
            autocomplete="off"
            @keydown.enter.prevent="addManualProject"
          />
          <button type="button" class="secondary small" @click="addManualProject">Add project</button>
        </div>
        <div v-if="formProjectIds.length" class="selected-projects">
          <span v-for="id in formProjectIds" :key="id" class="chip active">
            {{ projectNameForId(id) ?? id }}
            <button type="button" class="chip-x" aria-label="Remove" @click="toggleProject(id)">×</button>
          </span>
        </div>
      </div>

      <div class="functions-block">
        <span class="field-label">Allowed functions</span>
        <div class="fn-grid">
          <label v-for="fn in functionOptions" :key="fn" class="fn-check">
            <input v-model="formFunctions" type="checkbox" :value="fn" />
            {{ fn }}
          </label>
        </div>
        <p class="muted small">Light keys cannot grant <code>receive</code> or <code>create_project</code>.</p>
      </div>

      <div class="btn-row">
        <button
          type="button"
          class="primary"
          :disabled="saving || !formProjectIds.length"
          @click="editing ? saveEdit() : createKey()"
        >
          {{ saving ? 'Saving…' : editing ? 'Save changes' : 'Create key' }}
        </button>
        <button type="button" class="secondary" :disabled="saving" @click="cancelForm">Cancel</button>
      </div>
    </div>

    <div v-if="loading" class="muted">Loading guest keys…</div>

    <table v-else class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Projects</th>
          <th>Target</th>
          <th>Redemptions</th>
          <th>Status</th>
          <th>Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="key in keys" :key="key.id">
          <td>
            <strong>{{ key.label?.trim() || '—' }}</strong>
            <div class="muted small">{{ key.id.slice(0, 8) }}…</div>
          </td>
          <td class="wrap-cell">{{ formatProjects(key) }}</td>
          <td>{{ key.orbitTarget }}</td>
          <td>
            {{ key.redemptionCount }}
            <span v-if="key.maxRedemptions != null" class="muted">/ {{ key.maxRedemptions }}</span>
          </td>
          <td>
            <span class="chip" :class="{ active: keyStatus(key) === 'active', danger: keyStatus(key) !== 'active' }">
              {{ keyStatus(key) }}
            </span>
          </td>
          <td class="muted small">{{ formatDate(key.createdAt) }}</td>
          <td class="actions">
            <button
              v-if="keyStatus(key) === 'active'"
              type="button"
              class="secondary small"
              :disabled="saving"
              @click="startEdit(key)"
            >
              Edit
            </button>
            <button
              v-if="keyStatus(key) === 'active'"
              type="button"
              class="secondary small danger-text"
              :disabled="saving"
              @click="revokeKey(key)"
            >
              Revoke
            </button>
          </td>
        </tr>
        <tr v-if="!keys.length">
          <td colspan="7" class="muted empty">No guest keys yet — create one for Connector Light collaborators.</td>
        </tr>
      </tbody>
    </table>

    <p v-if="activeKeys.length" class="muted small footnote">
      {{ activeKeys.length }} active key{{ activeKeys.length === 1 ? '' : 's' }}.
      Plaintext keys cannot be retrieved after creation — revoke and create a new key if lost.
    </p>
  </section>
</template>

<style scoped>
.guest-panel { border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--surface, transparent); }
.guest-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
.guest-head h2 { margin: 0 0 4px; font-size: 15px; }
.guest-head .muted { margin: 0; max-width: 52rem; }
.guest-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.card { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-top: 12px; }
.minted { background: color-mix(in srgb, var(--success, #16a34a) 8%, transparent); border-color: color-mix(in srgb, var(--success, #16a34a) 35%, var(--border)); }
.minted-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; margin-top: 10px; }
.minted-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; min-width: 5rem; padding-top: 4px; }
.minted-value { flex: 1 1 280px; margin: 0; font-size: 12px; word-break: break-all; white-space: pre-wrap; }
.form-card h3 { margin: 0 0 12px; font-size: 14px; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.field-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.projects-block, .functions-block { margin-top: 14px; }
.project-picks { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 6px; max-height: 180px; overflow: auto; padding: 8px; border: 1px solid var(--border); border-radius: 6px; }
.project-pick { flex-direction: row; align-items: flex-start; gap: 8px; font-size: 13px; }
.project-pick code { display: block; }
.manual-project { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.manual-project input { flex: 1 1 200px; }
.selected-projects { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); }
.chip.active { border-color: color-mix(in srgb, var(--primary) 40%, var(--border)); }
.chip.danger { opacity: 0.85; }
.chip-x { border: none; background: none; cursor: pointer; padding: 0 2px; font-size: 14px; line-height: 1; }
.fn-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; }
.fn-check { flex-direction: row; align-items: center; gap: 6px; font-size: 13px; }
.btn-row { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.data-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
.data-table th, .data-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
.actions { white-space: nowrap; display: flex; gap: 6px; }
.wrap-cell { max-width: 220px; }
.empty { text-align: center; padding: 20px !important; }
.small { font-size: 12px; }
.footnote { margin: 10px 0 0; }
.error { color: var(--danger, #ef4444); margin: 0 0 8px; }
.danger-text { color: var(--danger, #ef4444); }
button.small { font-size: 12px; padding: 4px 8px; }
button.secondary { border: 1px solid var(--border); background: transparent; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
button.primary { border-radius: 6px; padding: 6px 10px; cursor: pointer; }
</style>
