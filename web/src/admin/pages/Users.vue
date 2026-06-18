<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  workspaceApi,
  settingsApi,
  type ApiError,
  type GoogleWorkspaceLink,
  type PortalProjectLevel,
  type ProvisionedUser,
  type ProvisionedUserStatus,
} from '../../shared/api';
import Icon from '../../shared/Icon.vue';

const workspace = ref<GoogleWorkspaceLink | null>(null);
const users = ref<ProvisionedUser[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const syncMessage = ref<string | null>(null);

const linkDomain = ref('rebus.industries');
const linkDisplayName = ref('REBUS Industries');

const showAdd = ref(false);
const newEmail = ref('');
const newDisplayName = ref('');
const newIsAdmin = ref(false);
const newStatus = ref<ProvisionedUserStatus>('pending');
const newProjectId = ref('');
const newProjectLevel = ref<PortalProjectLevel>('viewer');
const newRoleRefs = ref('');

const editing = ref<ProvisionedUser | null>(null);
const editIsAdmin = ref(false);
const editStatus = ref<ProvisionedUserStatus>('pending');
const editProjectId = ref('');
const editProjectLevel = ref<PortalProjectLevel>('viewer');
const editRoleRefs = ref('');

const workspaceLinked = computed(() => workspace.value?.status === 'linked' || workspace.value?.status === 'syncing');

function roleRefsFromInput(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function formatProjects(user: ProvisionedUser): string {
  if (!user.projectPermissions.length) return '—';
  return user.projectPermissions
    .map((p) => `${p.projectName ?? p.orbitProjectId} (${p.level})`)
    .join(', ');
}

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    const data = await workspaceApi.get();
    workspace.value = data.workspace;
    users.value = data.users;
    const settings = (await settingsApi.list()).settings;
    if (settings.workspace_domain && !workspace.value) {
      linkDomain.value = settings.workspace_domain;
    }
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Failed to load workspace';
  } finally {
    loading.value = false;
  }
}

async function linkWorkspace() {
  error.value = null;
  try {
    const res = await workspaceApi.link(linkDomain.value.trim(), linkDisplayName.value.trim() || undefined);
    workspace.value = res.workspace;
    await refresh();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Link failed';
  }
}

async function syncWorkspace() {
  error.value = null;
  syncMessage.value = null;
  try {
    const res = await workspaceApi.sync();
    syncMessage.value = `Sync complete — imported ${res.imported}, updated ${res.updated}, unchanged ${res.unchanged}.`;
    await refresh();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Sync failed';
  }
}

async function unlinkWorkspace() {
  if (!confirm('Unlink Google Workspace? Provisioned users remain until deleted manually.')) return;
  error.value = null;
  try {
    await workspaceApi.unlink();
    workspace.value = null;
    await refresh();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Unlink failed';
  }
}

async function createUser() {
  error.value = null;
  try {
    const projectPermissions = newProjectId.value.trim()
      ? [{ orbitProjectId: newProjectId.value.trim(), level: newProjectLevel.value }]
      : [];
    await workspaceApi.createUser({
      email: newEmail.value.trim(),
      displayName: newDisplayName.value.trim() || undefined,
      isPrismAdmin: newIsAdmin.value,
      status: newStatus.value,
      projectPermissions,
      roleRefs: roleRefsFromInput(newRoleRefs.value),
    });
    showAdd.value = false;
    newEmail.value = '';
    newDisplayName.value = '';
    newIsAdmin.value = false;
    newStatus.value = 'pending';
    newProjectId.value = '';
    newProjectLevel.value = 'viewer';
    newRoleRefs.value = '';
    await refresh();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Create failed';
  }
}

function startEdit(user: ProvisionedUser) {
  editing.value = user;
  editIsAdmin.value = user.isPrismAdmin;
  editStatus.value = user.status;
  const first = user.projectPermissions[0];
  editProjectId.value = first?.orbitProjectId ?? '';
  editProjectLevel.value = first?.level ?? 'viewer';
  editRoleRefs.value = user.roleRefs.join(', ');
}

async function saveEdit() {
  if (!editing.value) return;
  error.value = null;
  try {
    const projectPermissions = editProjectId.value.trim()
      ? [{ orbitProjectId: editProjectId.value.trim(), level: editProjectLevel.value }]
      : [];
    await workspaceApi.updateUser(editing.value.id, {
      isPrismAdmin: editIsAdmin.value,
      status: editStatus.value,
      projectPermissions,
      roleRefs: roleRefsFromInput(editRoleRefs.value),
    });
    editing.value = null;
    await refresh();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Save failed';
  }
}

async function removeUser(user: ProvisionedUser) {
  if (!confirm(`Remove provisioned user ${user.email}?`)) return;
  error.value = null;
  try {
    await workspaceApi.deleteUser(user.id);
    await refresh();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Delete failed';
  }
}

onMounted(refresh);
</script>

<template>
  <h1>Users &amp; Google Workspace</h1>
  <p class="muted">
    Link your Google Workspace to import directory users, predefine ORBIT project access and PRISM admin
    rights before they sign in. Effective connector permissions still intersect with
    <RouterLink :to="{ name: 'tool-access' }">Permissions</RouterLink>.
    Password login via <RouterLink :to="{ name: 'profile' }">Profile</RouterLink> remains available for local admin accounts.
  </p>

  <div v-if="error" class="error-box mt">{{ error }}</div>
  <div v-if="syncMessage" class="card mt success-box">{{ syncMessage }}</div>

  <section class="card mt">
    <div class="h-row">
      <h2 class="flex-1">Google Workspace</h2>
      <span v-if="workspaceLinked" class="chip active">{{ workspace?.adapter }} · {{ workspace?.domain }}</span>
    </div>

    <template v-if="!workspaceLinked">
      <p class="muted">Connect a workspace domain to sync users and manage access centrally.</p>
      <div class="form-grid">
        <label>Domain
          <input v-model="linkDomain" placeholder="rebus.industries" />
        </label>
        <label>Display name
          <input v-model="linkDisplayName" placeholder="REBUS Industries" />
        </label>
      </div>
      <button class="primary mt" type="button" @click="linkWorkspace">
        <Icon name="link" :size="16" />Link Google Workspace
      </button>
    </template>

    <template v-else>
      <p class="muted">
        Linked {{ workspace?.linkedAt ? new Date(workspace.linkedAt).toLocaleString() : 'recently' }}.
        Last sync: {{ workspace?.lastSyncAt ? new Date(workspace.lastSyncAt).toLocaleString() : 'never' }}.
        {{ workspace?.userCount ?? 0 }} provisioned users.
      </p>
      <div class="btn-row mt">
        <button class="secondary" type="button" @click="syncWorkspace">
          <Icon name="sync" :size="16" />Sync directory
        </button>
        <button class="secondary" type="button" @click="showAdd = true">
          <Icon name="person_add" :size="16" />Add user
        </button>
        <button class="secondary danger-text" type="button" @click="unlinkWorkspace">Unlink</button>
      </div>
    </template>
  </section>

  <section v-if="showAdd" class="card mt">
    <h2>Add provisioned user</h2>
    <div class="form-grid">
      <label>Email<input v-model="newEmail" type="email" required /></label>
      <label>Display name<input v-model="newDisplayName" /></label>
      <label>Status
        <select v-model="newStatus">
          <option value="pending">pending</option>
          <option value="active">active</option>
          <option value="suspended">suspended</option>
        </select>
      </label>
      <label class="checkbox-row">
        <input v-model="newIsAdmin" type="checkbox" /> PRISM admin (Google sign-in)
      </label>
      <label>Primary ORBIT project id<input v-model="newProjectId" placeholder="mock-project-1" /></label>
      <label>Project level
        <select v-model="newProjectLevel">
          <option value="viewer">viewer</option>
          <option value="contributor">contributor</option>
          <option value="owner">owner</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <label>Policy role refs (comma-separated)<input v-model="newRoleRefs" placeholder="contributor, design-team" /></label>
    </div>
    <div class="btn-row mt">
      <button class="primary" type="button" @click="createUser">Save user</button>
      <button class="secondary" type="button" @click="showAdd = false">Cancel</button>
    </div>
  </section>

  <section v-if="editing" class="card mt">
    <h2>Edit {{ editing.email }}</h2>
    <div class="form-grid">
      <label>Status
        <select v-model="editStatus">
          <option value="pending">pending</option>
          <option value="active">active</option>
          <option value="suspended">suspended</option>
        </select>
      </label>
      <label class="checkbox-row">
        <input v-model="editIsAdmin" type="checkbox" /> PRISM admin (Google sign-in)
      </label>
      <label>Primary ORBIT project id<input v-model="editProjectId" /></label>
      <label>Project level
        <select v-model="editProjectLevel">
          <option value="viewer">viewer</option>
          <option value="contributor">contributor</option>
          <option value="owner">owner</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <label>Policy role refs<input v-model="editRoleRefs" /></label>
    </div>
    <div class="btn-row mt">
      <button class="primary" type="button" @click="saveEdit">Save changes</button>
      <button class="secondary" type="button" @click="editing = null">Cancel</button>
    </div>
  </section>

  <section class="card mt">
    <div class="h-row">
      <h2 class="flex-1">Provisioned users</h2>
      <span v-if="loading" class="muted">Loading…</span>
    </div>
    <p class="muted">
      Users appear here before first login. Assign project access and admin flags, then they can sign in with Google or via connectors.
    </p>
    <table v-if="users.length" class="data-table">
      <thead>
        <tr>
          <th>Email</th>
          <th>Status</th>
          <th>Admin</th>
          <th>Projects</th>
          <th>Roles</th>
          <th>Source</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="user in users" :key="user.id">
          <td>
            <strong>{{ user.email }}</strong>
            <div v-if="user.displayName" class="muted small">{{ user.displayName }}</div>
          </td>
          <td><span class="chip" :class="{ active: user.status === 'active' }">{{ user.status }}</span></td>
          <td>{{ user.isPrismAdmin ? 'yes' : 'no' }}</td>
          <td class="wrap-cell">{{ formatProjects(user) }}</td>
          <td>{{ user.roleRefs.length ? user.roleRefs.join(', ') : '—' }}</td>
          <td>{{ user.source }}</td>
          <td class="actions">
            <button class="secondary small" type="button" @click="startEdit(user)">Edit</button>
            <button class="secondary small danger-text" type="button" @click="removeUser(user)">Remove</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="!loading" class="muted">No provisioned users yet. Link a workspace and sync, or add users manually.</p>
  </section>
</template>

<style scoped>
h1 { font-size: 22px; margin: 0 0 8px; }
h2 { font-size: 16px; margin: 0; }
.mt { margin-top: 16px; }
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
label { display: flex; flex-direction: column; gap: 6px; }
.checkbox-row { flex-direction: row; align-items: center; gap: 8px; margin-top: 24px; }
.btn-row { display: flex; flex-wrap: wrap; gap: 8px; }
.data-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
.data-table th, .data-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid hsl(var(--border)); vertical-align: top; }
.actions { white-space: nowrap; display: flex; gap: 6px; }
.wrap-cell { max-width: 280px; }
.small { font-size: 0.8125rem; }
button.small { padding: 4px 10px; font-size: 0.8125rem; }
.danger-text { color: hsl(var(--destructive)); }
.success-box { border-color: hsl(var(--success) / 0.4); }
</style>
