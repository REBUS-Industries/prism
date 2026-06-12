<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  externalMaterialsSettingsApi,
  type ApiError,
  type ExternalMaterialsSettings,
} from '../../shared/api';

const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const status = ref<string | null>(null);

const settings = ref<ExternalMaterialsSettings | null>(null);
const tokenInput = ref('');
const tokenDirty = ref(false);

const form = reactive({
  fabEnabled: true,
  fabHttpProxy: '',
  polyhavenEnabled: true,
  ambientcgEnabled: true,
});

const fabStatusLine = computed(() => {
  if (!settings.value) return 'Loading…';
  const fab = settings.value.fab;
  if (!fab.enabled) return 'Fab disabled';
  if (fab.tokenConfigured) {
    const src = fab.tokenSource === 'env' ? ' (from env)' : '';
    return `Token configured${src}${fab.tokenPreview ? `: ${fab.tokenPreview}` : ''}`;
  }
  return 'No Epic token — search may be blocked by Cloudflare';
});

const isDirty = computed(() => {
  if (!settings.value) return false;
  const s = settings.value;
  return (
    form.fabEnabled !== s.fab.enabled
    || form.fabHttpProxy !== s.fab.httpProxy
    || form.polyhavenEnabled !== s.polyhaven.enabled
    || form.ambientcgEnabled !== s.ambientcg.enabled
    || tokenDirty.value
  );
});

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await externalMaterialsSettingsApi.get();
    settings.value = res.settings;
    form.fabEnabled = res.settings.fab.enabled;
    form.fabHttpProxy = res.settings.fab.httpProxy;
    form.polyhavenEnabled = res.settings.polyhaven.enabled;
    form.ambientcgEnabled = res.settings.ambientcg.enabled;
    tokenInput.value = '';
    tokenDirty.value = false;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'failed to load settings';
  } finally {
    loading.value = false;
  }
}

function onTokenInput(): void {
  tokenDirty.value = true;
}

async function save(): Promise<void> {
  if (!settings.value) return;
  saving.value = true;
  error.value = null;
  try {
    const patch: Parameters<typeof externalMaterialsSettingsApi.patch>[0] = {
      fab: {
        enabled: form.fabEnabled,
        httpProxy: form.fabHttpProxy,
      },
      polyhaven: { enabled: form.polyhavenEnabled },
      ambientcg: { enabled: form.ambientcgEnabled },
    };
    if (tokenDirty.value) {
      patch.fab!.epicRefreshToken = tokenInput.value;
    }
    const res = await externalMaterialsSettingsApi.patch(patch);
    settings.value = res.settings;
    tokenInput.value = '';
    tokenDirty.value = false;
    status.value = 'Saved external materials settings';
    setTimeout(() => (status.value = null), 2000);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'save failed';
  } finally {
    saving.value = false;
  }
}

onMounted(() => { void refresh(); });
</script>

<template>
  <div v-if="loading" class="muted">Loading provider settings…</div>
  <template v-else>
    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="status" class="success-box">{{ status }}</div>

    <div class="field-stack">
      <fieldset class="provider-block">
        <legend>Fab (Epic Games marketplace)</legend>
        <label class="switch-row">
          <input v-model="form.fabEnabled" type="checkbox" />
          <span>Enable Fab search and import</span>
        </label>
        <div class="field">
          <label for="fab-token">Epic refresh token</label>
          <input
            id="fab-token"
            v-model="tokenInput"
            type="password"
            autocomplete="off"
            placeholder="Paste refresh token — write-only, never echoed after save"
            @input="onTokenInput"
          />
          <p class="hint muted">
            Status: {{ fabStatusLine }}.
            An Epic OAuth refresh token enables authenticated Fab API calls and imports;
            it often bypasses Cloudflare blocks on datacenter IPs.
            Leave blank to keep the current token; submit empty to clear a DB override.
          </p>
        </div>
        <div class="field">
          <label for="fab-proxy">HTTP proxy URL <code class="muted">fab_http_proxy</code></label>
          <input
            id="fab-proxy"
            v-model="form.fabHttpProxy"
            type="text"
            placeholder="http://user:pass@host:port (optional)"
          />
          <p class="hint muted">
            Optional outbound proxy for Fab requests when Cloudflare blocks the server IP.
            Overrides <code>FAB_HTTP_PROXY</code> when set here.
          </p>
        </div>
      </fieldset>

      <fieldset class="provider-block">
        <legend>Poly Haven</legend>
        <label class="switch-row">
          <input v-model="form.polyhavenEnabled" type="checkbox" />
          <span>Enable Poly Haven (CC0 textures, no auth)</span>
        </label>
      </fieldset>

      <fieldset class="provider-block">
        <legend>ambientCG</legend>
        <label class="switch-row">
          <input v-model="form.ambientcgEnabled" type="checkbox" />
          <span>Enable ambientCG (CC0 PBR materials, no auth)</span>
        </label>
      </fieldset>
    </div>

    <div class="help-copy muted">
      <p>
        These settings apply to the materials service on the next external-materials request.
        Fab import still requires an Epic account that owns (or can acquire free) the asset.
        See <code>infra/.env.example</code> for Epic OAuth setup if you need a refresh token.
      </p>
    </div>
  </template>

  <div class="footer-actions">
    <button class="primary" type="button" :disabled="!isDirty || saving" @click="save">
      {{ saving ? 'Saving…' : 'Save' }}
    </button>
  </div>
</template>

<style scoped>
.field-stack { display: flex; flex-direction: column; gap: 16px; }
.provider-block {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 8px);
  padding: 12px 14px 14px;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.provider-block legend {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 0 6px;
}
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-weight: 600; display: flex; align-items: baseline; gap: 8px; }
.field label code { font-size: 11px; font-weight: 400; }
.field input[type="text"],
.field input[type="password"] { width: 100%; }
.switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.hint { font-size: 11px; line-height: 1.45; margin: 0; }
.help-copy { margin-top: 4px; font-size: 12px; line-height: 1.5; }
.help-copy p { margin: 0; }
.footer-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border);
}
</style>
