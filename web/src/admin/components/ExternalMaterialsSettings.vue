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
            Leave blank to keep the current token; clear the field and Save to remove a DB override.
          </p>

          <details class="help-details">
            <summary>How to get an Epic refresh token</summary>
            <div class="help-body muted">
              <h4>Why this is needed</h4>
              <p>
                Fab search and import run on the PRISM server. Cloudflare often blocks
                datacenter IPs without authenticated Epic OAuth. A long-lived
                <code>refresh_token</code> lets the server obtain access tokens automatically
                for Fab API calls and asset downloads.
              </p>

              <h4>What to copy</h4>
              <p>
                Paste the OAuth <strong>refresh token</strong> — not the short-lived access token.
                Use an Epic account that has Fab marketplace access and owns (or can claim free)
                the materials you want to import.
              </p>

              <h4>Method A — Browser (recommended)</h4>
              <ol class="help-steps">
                <li>
                  Sign out of Epic in your browser, or use a private window so you can pick the
                  correct account.
                </li>
                <li>
                  Open the Epic login redirect URL (UE Launcher public client):
                  <pre class="help-code">https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&amp;responseType=code</pre>
                </li>
                <li>
                  Sign in. The page shows JSON — copy the <code>authorizationCode</code> value
                  (not <code>exchangeCode</code>).
                </li>
                <li>
                  In PowerShell, exchange the code for tokens (code expires in ~5 minutes and is
                  single-use):
                  <pre class="help-code">$clientId  = "34a02cf8f4414e29b15921876da36f9a"
$clientSecret = "daafbccc737745039dffe53d94fc76cf"
$code = "PASTE_authorizationCode_HERE"

$basic = [Convert]::ToBase64String(
  [Text.Encoding]::ASCII.GetBytes("${clientId}:${clientSecret}")
)
$body = "grant_type=authorization_code&amp;code=$([uri]::EscapeDataString($code))&amp;token_type=eg1"

$response = Invoke-RestMethod `
  -Uri "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token" `
  -Method POST `
  -Headers @{
    Authorization = "Basic $basic"
    "Content-Type" = "application/x-www-form-urlencoded"
  } `
  -Body $body

$response.refresh_token</pre>
                </li>
                <li>Copy the printed <code>refresh_token</code> value and paste it above, then Save.</li>
              </ol>

              <h4>Method B — Legendary CLI</h4>
              <pre class="help-code">pip install legendary-gl
legendary auth</pre>
              <p>
                After authenticating, read <code>refresh_token</code> from
                <code>%USERPROFILE%\.config\legendary\user.json</code> (Windows) or
                <code>~/.config/legendary/user.json</code> (macOS/Linux).
              </p>

              <h4>Do not use device-code flow</h4>
              <p>
                Epic's UE Launcher client does not support the device authorization grant —
                attempts return error <code>1032</code>. Use Method A or B instead.
              </p>

              <h4>After obtaining the token</h4>
              <p>
                Paste it in the field above and click Save. A value saved here overrides
                <code>FAB_EPIC_REFRESH_TOKEN</code> from the server environment. To revert to the
                env value, clear the field and Save again.
              </p>

              <h4>If Cloudflare still blocks search</h4>
              <p>
                Set an outbound HTTP proxy in the field above or via
                <code>FAB_HTTP_PROXY</code> in <code>infra/.env.example</code> — useful when
                bearer auth alone is not enough from your server's IP.
              </p>
            </div>
          </details>
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
        These settings apply on the next external-materials request.
        See also <code>infra/.env.example</code> (<code>FAB_EPIC_REFRESH_TOKEN</code>,
        <code>FAB_HTTP_PROXY</code>) for container-level configuration.
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
.help-details {
  margin-top: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 8px);
  background: var(--color-bg-elevated, var(--color-bg));
}
.help-details summary {
  cursor: pointer;
  padding: 8px 10px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  list-style: none;
}
.help-details summary::-webkit-details-marker { display: none; }
.help-details summary::before {
  content: '▸ ';
  display: inline-block;
  transition: transform 0.15s ease;
}
.help-details[open] summary::before { transform: rotate(90deg); }
.help-body {
  padding: 0 12px 12px;
  font-size: 11px;
  line-height: 1.5;
}
.help-body h4 {
  margin: 12px 0 4px;
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text);
}
.help-body h4:first-child { margin-top: 0; }
.help-body p { margin: 0 0 8px; }
.help-body p:last-child { margin-bottom: 0; }
.help-steps {
  margin: 4px 0 8px;
  padding-left: 18px;
}
.help-steps li { margin-bottom: 8px; }
.help-steps li:last-child { margin-bottom: 0; }
.help-code {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg-hover, rgba(0, 0, 0, 0.06));
  border: 1px solid var(--color-border);
  font-family: ui-monospace, 'Cascadia Code', 'Consolas', monospace;
  font-size: 10px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
}
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
