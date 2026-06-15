<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { settingsApi, type ApiError } from '../../shared/api';

const route = useRoute();

type FieldType = 'text' | 'select' | 'switch' | 'textarea';

interface FieldDef {
  key: string;
  label: string;
  hint?: string;
  secret?: boolean;
  type?: FieldType;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** When set, only show this field if the selected portal_adapter is in the list. */
  adapters?: string[];
}

const portalFields: FieldDef[] = [
  {
    key: 'portal_adapter',
    label: 'Sign-in method',
    type: 'select',
    options: [
      { value: 'google', label: 'Google Workspace (direct)' },
      { value: 'mock', label: 'Mock (dev only)' },
      { value: 'real', label: 'REBUS portal (future)' },
    ],
    hint: 'Google Workspace is the live method. REBUS portal is for when portal.rebus.industries ships.',
  },
  { key: 'portal_base_url', label: 'Portal API base URL', placeholder: 'https://portal.rebus.industries', adapters: ['real'] },
  { key: 'portal_api_key', label: 'Portal service API key', secret: true, placeholder: 'Bearer token for /portal/* calls', adapters: ['real'] },
  {
    key: 'portal_google_authorize_url',
    label: 'Portal OAuth authorize URL',
    placeholder: 'https://portal.rebus.industries/oauth/authorize',
    adapters: ['real'],
  },
  {
    key: 'portal_mock_persona',
    label: 'Mock persona',
    placeholder: 'alice',
    hint: 'Dev only — persona used when Sign in with Google is clicked in mock mode.',
    adapters: ['mock'],
  },
];

const workspaceFields: FieldDef[] = [
  {
    key: 'workspace_adapter',
    label: 'Directory source',
    type: 'select',
    options: [
      { value: 'google_admin_sdk', label: 'Google Workspace' },
      { value: 'mock', label: 'Mock (dev only)' },
    ],
  },
  {
    key: 'workspace_domain',
    label: 'Workspace domain',
    placeholder: 'rebus.industries',
    hint: 'Domain to import users from on the Users page.',
  },
  {
    key: 'workspace_enforce_provisioned',
    label: 'Require provisioned users',
    type: 'switch',
    hint: 'When on, only users listed under Admin → Users may sign in.',
  },
];

const googleApiFields: FieldDef[] = [
  {
    key: 'google_oauth_client_id',
    label: 'Google OAuth client ID',
    placeholder: 'xxxx.apps.googleusercontent.com',
    hint: 'Web client for Sign in with Google.',
  },
  {
    key: 'google_oauth_client_secret',
    label: 'Google OAuth client secret',
    secret: true,
    placeholder: 'Write-only after save',
  },
  {
    key: 'google_oauth_scopes',
    label: 'Google OAuth scopes',
    placeholder: 'openid email profile',
    hint: 'Advanced — leave default unless adding connector scopes.',
  },
];

const adminAccessFields: FieldDef[] = [
  {
    key: 'portal_admin_emails',
    label: 'Admin allowlist (emails)',
    placeholder: 'it@rebus.industries',
    hint: 'Break-glass: these emails get admin even if not marked PRISM admin under Users. Comma-separated.',
  },
];

const ALL_FIELDS = [...portalFields, ...workspaceFields, ...googleApiFields, ...adminAccessFields];
const DIRECTORY_TOKEN_KEY = 'google_workspace_directory_refresh_token';
const values = reactive<Record<string, { value: string; original: string; configured?: boolean }>>(
  Object.fromEntries(ALL_FIELDS.map((f) => [f.key, { value: '', original: '', configured: false }])),
);
const saving = ref(false);
const loading = ref(true);
const error = ref<string | null>(null);
const status = ref<string | null>(null);
const directorySyncConfigured = ref(false);

const currentAdapter = computed(() => values['portal_adapter']?.value ?? 'google');
const visiblePortalFields = computed(() =>
  portalFields.filter((f) => !f.adapters || f.adapters.includes(currentAdapter.value)),
);
const dirty = computed(() => ALL_FIELDS.some((f) => isDirty(f.key)));

function isMasked(v: string): boolean {
  return v.includes('••••');
}

function isDirty(key: string): boolean {
  const row = values[key];
  if (!row) return false;
  if (row.configured && !row.value.trim()) return false;
  return row.value !== row.original;
}

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    const all = (await settingsApi.list()).settings;
    for (const f of ALL_FIELDS) {
      const v = all[f.key] ?? '';
      const configured = f.secret && isMasked(v);
      values[f.key] = {
        value: configured ? '' : v,
        original: configured ? '' : v,
        configured,
      };
    }
    directorySyncConfigured.value = !!(all[DIRECTORY_TOKEN_KEY] ?? '').trim();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Failed to load settings';
  } finally {
    loading.value = false;
  }
}

async function saveAll() {
  saving.value = true;
  error.value = null;
  try {
    for (const f of ALL_FIELDS) {
      if (!isDirty(f.key)) continue;
      const row = values[f.key];
      if (f.secret && !row.value.trim() && row.configured) continue;
      await settingsApi.set(f.key, row.value.trim());
      row.original = row.value.trim();
      row.configured = f.secret ? !!row.value.trim() : row.configured;
    }
    status.value = 'Saved portal & workspace settings';
    setTimeout(() => (status.value = null), 2000);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Save failed';
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  if (route.query.directory_oauth === 'ok') {
    status.value = 'Directory sync authorized — refresh token saved';
  } else if (typeof route.query.directory_oauth_error === 'string' && route.query.directory_oauth_error) {
    error.value = decodeURIComponent(route.query.directory_oauth_error);
  }
  await refresh();
});
</script>

<template>
  <div v-if="loading" class="muted">Loading…</div>
  <template v-else>
    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="status" class="success-box">{{ status }}</div>

    <section class="section">
      <h3>Sign-in</h3>
      <p class="muted section-intro">How admins and connectors authenticate.</p>
      <div class="field-grid">
        <div v-for="f in visiblePortalFields" :key="f.key" class="field">
          <label :for="`pi-${f.key}`">
            {{ f.label }}
            <code class="muted">{{ f.key }}</code>
          </label>
          <select v-if="f.type === 'select'" :id="`pi-${f.key}`" v-model="values[f.key].value">
            <option v-for="opt in f.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <input
            v-else
            :id="`pi-${f.key}`"
            v-model="values[f.key].value"
            :type="f.secret ? 'password' : 'text'"
            :placeholder="values[f.key].configured ? 'Configured — leave blank to keep' : (f.placeholder ?? '')"
          />
          <p v-if="f.hint" class="hint">{{ f.hint }}</p>
        </div>
      </div>
    </section>

    <section class="section">
      <h3>Workspace directory</h3>
      <p class="muted section-intro">
        Import + enforcement. Manage provisioned users on
        <RouterLink :to="{ name: 'users' }">Users</RouterLink>.
      </p>
      <div class="field-grid">
        <div v-for="f in workspaceFields" :key="f.key" class="field">
          <label :for="`pi-${f.key}`">
            {{ f.label }}
            <code class="muted">{{ f.key }}</code>
          </label>
          <select v-if="f.type === 'select'" :id="`pi-${f.key}`" v-model="values[f.key].value">
            <option v-for="opt in f.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <select v-else-if="f.type === 'switch'" :id="`pi-${f.key}`" v-model="values[f.key].value">
            <option value="1">On — only provisioned users</option>
            <option value="0">Off — allow portal grants</option>
          </select>
          <input v-else :id="`pi-${f.key}`" v-model="values[f.key].value" :placeholder="f.placeholder ?? ''" />
          <p v-if="f.hint" class="hint">{{ f.hint }}</p>
        </div>
      </div>
    </section>

    <section class="section">
      <h3>Google credentials</h3>
      <p class="muted section-intro">OAuth web client for sign-in. Directory sync uses a one-time super-admin authorization.</p>
      <div class="directory-auth-row">
        <a class="btn secondary" href="/api/admin/directory-oauth/start">
          {{ directorySyncConfigured ? 'Re-authorize directory sync' : 'Authorize directory sync' }}
        </a>
        <p class="hint">
          <span v-if="directorySyncConfigured" class="ok-badge">Authorized</span>
          Sign in once as a Workspace super-admin — no service account key needed.
        </p>
      </div>
      <div class="field-grid">
        <div v-for="f in googleApiFields" :key="f.key" class="field">
          <label :for="`pi-${f.key}`">
            {{ f.label }}
            <code class="muted">{{ f.key }}</code>
          </label>
          <input
            :id="`pi-${f.key}`"
            v-model="values[f.key].value"
            :type="f.secret ? 'password' : 'text'"
            :placeholder="values[f.key].configured ? 'Configured — leave blank to keep' : (f.placeholder ?? '')"
          />
          <p v-if="f.hint" class="hint">{{ f.hint }}</p>
        </div>
      </div>
    </section>

    <section class="section">
      <h3>Admin access</h3>
      <p class="muted section-intro">Prefer marking users as PRISM admin on the Users page; this is a break-glass fallback.</p>
      <div class="field-grid">
        <div v-for="f in adminAccessFields" :key="f.key" class="field">
          <label :for="`pi-${f.key}`">
            {{ f.label }}
            <code class="muted">{{ f.key }}</code>
          </label>
          <input :id="`pi-${f.key}`" v-model="values[f.key].value" :placeholder="f.placeholder ?? ''" />
          <p v-if="f.hint" class="hint">{{ f.hint }}</p>
        </div>
      </div>
    </section>

    <section class="section setup-help">
      <h3>Google Cloud setup</h3>
      <ol class="setup-steps">
        <li>Create a <strong>Web application</strong> OAuth client in Google Cloud Console.</li>
        <li>Add these authorized redirect URIs:
          <code>https://prism-dev.rebus.industries/admin/?portal_callback=1</code> and
          <code>https://prism-dev.rebus.industries/api/admin/directory-oauth/callback</code>
          (add the <code>prism.rebus.industries</code> equivalents when prod goes live).
        </li>
        <li>Paste the client ID + secret above and save.</li>
        <li>Click <strong>Authorize directory sync</strong> and sign in as a Workspace super-admin.</li>
        <li>Import users on <RouterLink :to="{ name: 'users' }">Users</RouterLink>, assign permissions, then everyone signs in with Google.</li>
      </ol>
      <p class="muted section-intro">Full checklist: <code>docs/WORKSPACE.md</code></p>
    </section>

    <div class="actions">
      <button class="primary" type="button" :disabled="saving || !dirty" @click="saveAll">
        {{ saving ? 'Saving…' : 'Save changes' }}
      </button>
    </div>
  </template>
</template>

<style scoped>
.section { margin-bottom: 24px; }
.section h3 { margin: 0 0 6px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; }
.section-intro { margin: 0 0 12px; font-size: 12px; line-height: 1.45; }
.field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
}
.field { display: flex; flex-direction: column; gap: 6px; }
.field.wide { grid-column: 1 / -1; }
.field label { display: flex; align-items: baseline; gap: 8px; font-weight: 600; font-size: 13px; }
.field label code { font-size: 10px; font-weight: 400; }
.field input, .field select, .field textarea { width: 100%; }
.hint { margin: 0; font-size: 11px; color: var(--color-text-muted); line-height: 1.4; }
.actions { margin-top: 8px; padding-top: 16px; border-top: 1px solid var(--color-border); }
.setup-help ol { margin: 0; padding-left: 20px; font-size: 12px; line-height: 1.55; }
.setup-help li { margin-bottom: 8px; }
.setup-help code { font-size: 11px; word-break: break-all; }
.directory-auth-row { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.directory-auth-row .btn { align-self: flex-start; text-decoration: none; }
.ok-badge {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: hsl(140 60% 40% / 0.15);
  color: hsl(140 60% 35%);
}
</style>
