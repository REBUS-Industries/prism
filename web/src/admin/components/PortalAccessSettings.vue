<script setup lang="ts">
/**
 * Settings tile: the portal service API key PRISM uses to read the live role
 * list + permissions from the REBUS portal (Bearer on `<base>/portal/*`).
 * Stored as settings `portal_api_key` / `portal_base_url`; the permissions
 * service reads them from the shared settings table.
 */
import { computed, onMounted, ref } from 'vue';
import { permissionsApi, settingsApi, type ApiError } from '../../shared/api';

const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const status = ref<string | null>(null);

const baseUrl = ref('');
const baseUrlOriginal = ref('');
const adapter = ref('');

// API key is write-only: never echoed back. `configured` = a key is stored.
const apiKey = ref('');
const keyConfigured = ref(false);

type CheckState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; count: number; names: string[] }
  | { kind: 'unsupported' }
  | { kind: 'pending' }
  | { kind: 'fail'; reason: string };
const check = ref<CheckState>({ kind: 'idle' });

const adapterIsReal = computed(() => adapter.value === 'real');
const dirty = computed(
  () => baseUrl.value.trim() !== baseUrlOriginal.value.trim() || apiKey.value.trim().length > 0,
);

function isMasked(v: string): boolean {
  return v.includes('\u2022\u2022\u2022\u2022');
}

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    const all = (await settingsApi.list()).settings;
    const url = all['portal_base_url'] ?? '';
    baseUrl.value = url;
    baseUrlOriginal.value = url;
    adapter.value = all['portal_adapter'] ?? '';
    keyConfigured.value = isMasked(all['portal_api_key'] ?? '') || !!(all['portal_api_key'] ?? '').trim();
    apiKey.value = '';
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Failed to load settings';
  } finally {
    loading.value = false;
  }
}

async function saveOnly(): Promise<boolean> {
  saving.value = true;
  error.value = null;
  status.value = null;
  try {
    if (baseUrl.value.trim() !== baseUrlOriginal.value.trim()) {
      await settingsApi.set('portal_base_url', baseUrl.value.trim());
      baseUrlOriginal.value = baseUrl.value.trim();
    }
    if (apiKey.value.trim()) {
      await settingsApi.set('portal_api_key', apiKey.value.trim());
      keyConfigured.value = true;
      apiKey.value = '';
    }
    return true;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Save failed';
    return false;
  } finally {
    saving.value = false;
  }
}

async function save() {
  if (await saveOnly()) {
    status.value = 'Saved portal access key';
    setTimeout(() => (status.value = null), 2000);
  }
}

async function saveAndCheck() {
  check.value = { kind: 'idle' };
  if (!(await saveOnly())) return;
  check.value = { kind: 'busy' };
  try {
    const res = await permissionsApi.getPortalRoles();
    if (res.supported) {
      check.value = { kind: 'ok', count: res.roles.length, names: res.roles.map((r) => r.name || r.id) };
    } else {
      check.value = { kind: 'unsupported' };
    }
  } catch (err) {
    const e = err as ApiError;
    if (e.status === 404) check.value = { kind: 'pending' };
    else check.value = { kind: 'fail', reason: e.message ?? 'Connection check failed' };
  }
}

onMounted(refresh);
</script>

<template>
  <div v-if="loading" class="muted">Loading…</div>
  <template v-else>
    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="status" class="success-box">{{ status }}</div>

    <p class="muted intro">
      The portal mints a service API key; paste it here so PRISM can read the live role list and
      permissions from the portal. PRISM sends it as <code>Authorization: Bearer …</code> on
      <code>{{ baseUrl || 'https://portal.rebus.industries' }}/portal/*</code>.
    </p>

    <div class="field">
      <label for="pa-base">
        Portal API base URL
        <code class="muted">portal_base_url</code>
      </label>
      <input id="pa-base" v-model="baseUrl" placeholder="https://portal.rebus.industries" />
    </div>

    <div class="field">
      <label for="pa-key">
        Portal service API key
        <code class="muted">portal_api_key</code>
      </label>
      <input
        id="pa-key"
        v-model="apiKey"
        type="password"
        autocomplete="off"
        :placeholder="keyConfigured ? 'Configured — leave blank to keep' : 'Paste the portal service key'"
      />
      <p class="hint">
        <span v-if="keyConfigured" class="ok-badge">Stored</span>
        Write-only — never echoed back. This is the portal's own service key (same one used for
        <code>POST /portal/oauth/token</code>), <strong>not</strong> a PRISM <code>prism_…</code> key.
      </p>
    </div>

    <p v-if="adapter && !adapterIsReal" class="hint warn">
      Sign-in method is <code>{{ adapter }}</code>, not <code>real</code>. The portal feed is only used by the
      REBUS portal adapter — set it under <strong>Portal &amp; Google Workspace</strong> for this key to take effect.
    </p>

    <div class="actions">
      <button type="button" :disabled="saving || !dirty" @click="save">
        {{ saving ? 'Saving…' : 'Save' }}
      </button>
      <button type="button" class="primary" :disabled="saving" @click="saveAndCheck">
        {{ saving ? 'Saving…' : 'Save & check connection' }}
      </button>
    </div>

    <div v-if="check.kind !== 'idle'" class="check">
      <span v-if="check.kind === 'busy'" class="pill">checking…</span>
      <template v-else-if="check.kind === 'ok'">
        <span class="pill ok">connected</span>
        <span class="muted check-detail">
          Portal returned {{ check.count }} role{{ check.count === 1 ? '' : 's' }}<span v-if="check.names.length">: {{ check.names.join(', ') }}</span>
        </span>
      </template>
      <template v-else-if="check.kind === 'unsupported'">
        <span class="pill warn">unavailable</span>
        <span class="muted check-detail">
          PRISM reached the portal feed but it reported unsupported. Verify the key + base URL, and that the
          portal serves <code>GET /portal/roles</code>.
        </span>
      </template>
      <template v-else-if="check.kind === 'pending'">
        <span class="pill warn">pending deploy</span>
        <span class="muted check-detail">
          The PRISM permissions service hasn't shipped <code>/api/permissions/portal-roles</code> yet. The key is
          saved; the check will pass once that service is deployed.
        </span>
      </template>
      <template v-else-if="check.kind === 'fail'">
        <span class="pill fail">failed</span>
        <span class="muted check-detail">{{ check.reason }}</span>
      </template>
    </div>
  </template>
</template>

<style scoped>
.intro { margin: 0 0 16px; font-size: 12px; line-height: 1.5; }
.intro code, .hint code { font-family: var(--mono, monospace); font-size: 11px; }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
.field label { display: flex; align-items: baseline; gap: 8px; font-weight: 600; font-size: 13px; }
.field label code { font-size: 10px; font-weight: 400; }
.field input { width: 100%; }
.hint { margin: 0; font-size: 11px; color: var(--color-text-muted); line-height: 1.4; }
.hint.warn { color: var(--warning, #d97706); margin-bottom: 12px; }
.actions { display: flex; gap: 10px; margin-top: 8px; padding-top: 16px; border-top: 1px solid var(--color-border); }
.check { display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
.check-detail { font-size: 12px; }
.pill {
  display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.04em; background: var(--color-bg-hover); color: var(--color-text-muted);
}
.pill.ok { background: hsl(140 60% 40% / 0.15); color: hsl(140 60% 35%); }
.pill.warn { background: hsl(38 92% 50% / 0.15); color: #b45309; }
.pill.fail { background: hsl(0 70% 50% / 0.15); color: #b91c1c; }
.ok-badge {
  display: inline-block; margin-right: 6px; padding: 1px 8px; border-radius: 999px; font-size: 10px;
  font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  background: hsl(140 60% 40% / 0.15); color: hsl(140 60% 35%);
}
</style>
