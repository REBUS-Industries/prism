<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { settingsApi, type ApiError } from '../../shared/api';

type FieldType = 'text' | 'select' | 'switch' | 'textarea';

interface FieldDef {
  key: string;
  label: string;
  hint?: string;
  secret?: boolean;
  type?: FieldType;
  placeholder?: string;
  options?: { value: string; label: string }[];
}

const portalFields: FieldDef[] = [
  {
    key: 'portal_adapter',
    label: 'Portal adapter',
    type: 'select',
    options: [
      { value: 'mock', label: 'Mock (prism-dev)' },
      { value: 'real', label: 'REBUS portal API' },
    ],
    hint: 'Mock uses /api/access/mock-login for dev sign-in flows.',
  },
  { key: 'portal_base_url', label: 'Portal API base URL', placeholder: 'https://portal.rebus.industries' },
  { key: 'portal_api_key', label: 'Portal service API key', secret: true, placeholder: 'Bearer token for /portal/* calls' },
  {
    key: 'portal_google_authorize_url',
    label: 'Google OAuth authorize URL',
    placeholder: 'https://portal.rebus.industries/oauth/authorize',
    hint: 'Production admin + connector sign-in redirect target.',
  },
  {
    key: 'portal_mock_persona',
    label: 'Mock persona (dev only)',
    placeholder: 'alice',
    hint: 'Used when adapter=mock and Sign in with Google is clicked.',
  },
];

const workspaceFields: FieldDef[] = [
  {
    key: 'workspace_adapter',
    label: 'Workspace directory adapter',
    type: 'select',
    options: [
      { value: 'mock', label: 'Mock directory' },
      { value: 'google_admin_sdk', label: 'Google Admin SDK' },
    ],
  },
  {
    key: 'workspace_domain',
    label: 'Primary workspace domain',
    placeholder: 'rebus.industries',
    hint: 'Default domain when linking Google Workspace on the Users page.',
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
    hint: 'Web client for Sign in with Google (admin SPA + connectors).',
  },
  {
    key: 'google_oauth_client_secret',
    label: 'Google OAuth client secret',
    secret: true,
    placeholder: 'Write-only after save',
  },
  {
    key: 'google_service_account_json',
    label: 'Google service account JSON',
    type: 'textarea',
    secret: true,
    placeholder: 'Paste service account key JSON for Admin SDK directory sync',
    hint: 'Domain-wide delegation required for google_admin_sdk adapter.',
  },
];

const adminAccessFields: FieldDef[] = [
  {
    key: 'portal_admin_emails',
    label: 'Legacy admin allowlist (emails)',
    placeholder: 'alice@rebus.industries, dom@rebus.industries',
    hint: 'Fallback when user is not marked PRISM admin under Users. Comma-separated.',
  },
  {
    key: 'portal_admin_username',
    label: 'Local admin username bind',
    placeholder: 'admin',
    hint: 'Google admin sessions bind to this admin_users row.',
  },
];

const ALL_FIELDS = [...portalFields, ...workspaceFields, ...googleApiFields, ...adminAccessFields];
const values = reactive<Record<string, { value: string; original: string; configured?: boolean }>>(
  Object.fromEntries(ALL_FIELDS.map((f) => [f.key, { value: '', original: '', configured: false }])),
);
const saving = ref(false);
const loading = ref(true);
const error = ref<string | null>(null);
const status = ref<string | null>(null);

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

onMounted(refresh);
</script>

<template>
  <div v-if="loading" class="muted">Loading…</div>
  <template v-else>
    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="status" class="success-box">{{ status }}</div>

    <section class="section">
      <h3>Portal OAuth</h3>
      <p class="muted section-intro">Connector Sign in with REBUS and admin Google sign-in redirect configuration.</p>
      <div class="field-grid">
        <div v-for="f in portalFields" :key="f.key" class="field">
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
      <h3>Google Workspace</h3>
      <p class="muted section-intro">
        Directory sync + enforcement. Manage provisioned users on
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
      <h3>Google API credentials</h3>
      <p class="muted section-intro">OAuth client for user sign-in and service account for workspace directory sync.</p>
      <div class="field-grid">
        <div v-for="f in googleApiFields" :key="f.key" class="field" :class="{ wide: f.type === 'textarea' }">
          <label :for="`pi-${f.key}`">
            {{ f.label }}
            <code class="muted">{{ f.key }}</code>
          </label>
          <textarea
            v-if="f.type === 'textarea'"
            :id="`pi-${f.key}`"
            v-model="values[f.key].value"
            rows="5"
            :placeholder="values[f.key].configured ? 'Configured — leave blank to keep' : (f.placeholder ?? '')"
          />
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
      <h3>PRISM admin access</h3>
      <p class="muted section-intro">Prefer marking users as PRISM admin on the Users page; these are legacy fallbacks.</p>
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
</style>
