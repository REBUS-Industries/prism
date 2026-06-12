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
const authCodeInput = ref('');
const copiedKey = ref<string | null>(null);

const EPIC_CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const EPIC_CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';
const epicLoginUrl = `https://www.epicgames.com/id/api/redirect?clientId=${EPIC_CLIENT_ID}&responseType=code`;

function escapeForPowerShellDoubleQuote(value: string): string {
  return value
    .replace(/`/g, '``')
    .replace(/\$/g, '`$')
    .replace(/"/g, '`"');
}

function buildExchangeScript(codeLiteral: string): string {
  return [
    `$clientId  = "${EPIC_CLIENT_ID}"`,
    `$clientSecret = "${EPIC_CLIENT_SECRET}"`,
    `$code = "${codeLiteral}"`,
    '',
    '$basic = [Convert]::ToBase64String(',
    '  [Text.Encoding]::ASCII.GetBytes("${clientId}:${clientSecret}")',
    ')',
    '$body = "grant_type=authorization_code&code=$([uri]::EscapeDataString($code))&token_type=eg1"',
    '',
    '$response = Invoke-RestMethod `',
    '  -Uri "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token" `',
    '  -Method POST `',
    '  -Headers @{',
    '    Authorization = "Basic $basic"',
    '    "Content-Type" = "application/x-www-form-urlencoded"',
    '  } `',
    '  -Body $body',
    '',
    '$response.refresh_token',
  ].join('\n');
}

function buildVerifyRefreshScript(): string {
  return [
    `$clientId  = "${EPIC_CLIENT_ID}"`,
    `$clientSecret = "${EPIC_CLIENT_SECRET}"`,
    '$refreshToken = "PASTE_REFRESH_TOKEN_HERE"',
    '',
    '$basic = [Convert]::ToBase64String(',
    '  [Text.Encoding]::ASCII.GetBytes("${clientId}:${clientSecret}")',
    ')',
    '$body = "grant_type=refresh_token&refresh_token=$([uri]::EscapeDataString($refreshToken))&token_type=eg1"',
    '',
    '$response = Invoke-RestMethod `',
    '  -Uri "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token" `',
    '  -Method POST `',
    '  -Headers @{',
    '    Authorization = "Basic $basic"',
    '    "Content-Type" = "application/x-www-form-urlencoded"',
    '  } `',
    '  -Body $body',
    '',
    '$response.access_token',
  ].join('\n');
}

const legendaryCliScript = [
  'pip install legendary-gl',
  'legendary auth',
].join('\n');

const exchangeScript = computed(() => {
  const codeLiteral = authCodeInput.value.trim()
    ? escapeForPowerShellDoubleQuote(authCodeInput.value.trim())
    : 'PASTE_CODE_HERE';
  return buildExchangeScript(codeLiteral);
});

const verifyRefreshScript = buildVerifyRefreshScript();

function openEpicLoginUrl(): void {
  window.open(epicLoginUrl, '_blank', 'noopener,noreferrer');
}

async function copyText(text: string, key: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copiedKey.value = key;
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = null;
    }, 2000);
  } catch {
    // Fallback for older browsers / non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    copiedKey.value = key;
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = null;
    }, 2000);
  }
}

const form = reactive({
  fabEnabled: true,
  fabHttpProxy: '',
  fabFlareSolverrUrl: '',
  polyhavenEnabled: true,
  ambientcgEnabled: true,
});

const fieldErrors = reactive({
  fabHttpProxy: null as string | null,
  fabFlareSolverrUrl: null as string | null,
});

function validateHttpUrlField(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    if (/^[\w.-]+:\d+(\/.*)?$/i.test(candidate)) {
      candidate = `http://${candidate}`;
    }
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `${label} must use http:// or https://`;
    }
  } catch {
    return `${label} is not a valid URL`;
  }
  return null;
}

function validateFabUrlFields(): boolean {
  fieldErrors.fabHttpProxy = validateHttpUrlField('Fab HTTP proxy URL', form.fabHttpProxy);
  fieldErrors.fabFlareSolverrUrl = validateHttpUrlField('FlareSolverr URL', form.fabFlareSolverrUrl);
  return !fieldErrors.fabHttpProxy && !fieldErrors.fabFlareSolverrUrl;
}

function clearFieldError(field: 'fabHttpProxy' | 'fabFlareSolverrUrl'): void {
  fieldErrors[field] = null;
}

const DEFAULT_FLARESOLVERR_URL = 'http://flaresolverr:8191/v1';
const HOST_FLARESOLVERR_URL = 'http://127.0.0.1:8191/v1';
const DOCKER_HOST_FLARESOLVERR_URL = 'http://host.docker.internal:8191/v1';
const FLARESOLVERR_IMAGE = 'https://ghcr.io/flaresolverr/flaresolverr';

const flareSolverrUrlHint = computed(() => {
  const current = form.fabFlareSolverrUrl.trim();
  if (!current || current === HOST_FLARESOLVERR_URL) {
    return (
      'Split-stack dev (docker-compose.dev.yml): use '
      + `${DEFAULT_FLARESOLVERR_URL}. `
      + 'FlareSolverr on the VM host while PRISM runs in Docker: '
      + `${DOCKER_HOST_FLARESOLVERR_URL} (Windows/Mac) or http://172.17.0.1:8191/v1 (Linux). `
      + `${HOST_FLARESOLVERR_URL} only when PRISM and FlareSolverr share the same network namespace.`
    );
  }
  return null;
});

const fabMarketplaceUrl = 'https://www.fab.com';
const fabTestSearchUrl = computed(() => {
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  return `${base}/api/external-materials/search?q=brick&sources=fab&limit=1`;
});

const flareSolverrDockerRun = [
  '# Option A — included in docker-compose.dev.yml (VM 212 dev):',
  '#   service name flaresolverr → http://flaresolverr:8191/v1',
  '',
  '# Option B — standalone on the VM host:',
  'docker run -d --name flaresolverr --restart unless-stopped \\',
  '  -p 8191:8191 \\',
  '  -e LOG_LEVEL=info \\',
  '  ghcr.io/flaresolverr/flaresolverr:latest',
].join('\n');

function openExternalUrl(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

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
    || form.fabFlareSolverrUrl !== s.fab.flareSolverrUrl
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
    form.fabFlareSolverrUrl = res.settings.fab.flareSolverrUrl;
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
  if (!validateFabUrlFields()) {
    error.value = 'Fix invalid URL fields before saving';
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    const patch: Parameters<typeof externalMaterialsSettingsApi.patch>[0] = {
      fab: {
        enabled: form.fabEnabled,
        httpProxy: form.fabHttpProxy,
        flareSolverrUrl: form.fabFlareSolverrUrl,
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
    const apiErr = err as ApiError;
    const body = apiErr.body as { field?: string; error?: string } | undefined;
    if (body?.field === 'fab.httpProxy') {
      fieldErrors.fabHttpProxy = body.error ?? apiErr.message;
    } else if (body?.field === 'fab.flareSolverrUrl') {
      fieldErrors.fabFlareSolverrUrl = body.error ?? apiErr.message;
    }
    error.value = apiErr.message ?? 'save failed';
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
                  <div class="token-help code-block">
                    <div class="code-block-toolbar">
                      <span class="code-block-label">Epic login redirect</span>
                      <div class="code-block-actions">
                        <button
                          type="button"
                          class="copy-btn"
                          @click="openEpicLoginUrl"
                        >Open URL</button>
                        <button
                          type="button"
                          class="copy-btn"
                          @click="copyText(epicLoginUrl, 'url')"
                        >{{ copiedKey === 'url' ? 'Copied' : 'Copy' }}</button>
                      </div>
                    </div>
                    <pre class="token-help-code">{{ epicLoginUrl }}</pre>
                  </div>
                </li>
                <li>
                  Sign in. The page shows JSON — copy the <code>authorizationCode</code> value
                  (not <code>exchangeCode</code>).
                </li>
                <li>
                  Paste the code below — the PowerShell snippet updates automatically (code expires
                  in ~5 minutes and is single-use):
                  <div class="token-help auth-code-field">
                    <label for="fab-auth-code">Authorization code (from browser JSON)</label>
                    <input
                      id="fab-auth-code"
                      v-model="authCodeInput"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      placeholder="Paste authorizationCode from Epic JSON response"
                    />
                  </div>
                  <div class="token-help code-block">
                    <div class="code-block-toolbar">
                      <span class="code-block-label">Exchange script (PowerShell)</span>
                      <button
                        type="button"
                        class="copy-btn"
                        @click="copyText(exchangeScript, 'exchange')"
                      >{{ copiedKey === 'exchange' ? 'Copied' : 'Copy' }}</button>
                    </div>
                    <pre class="token-help-code">{{ exchangeScript }}</pre>
                  </div>
                </li>
                <li>Copy the printed <code>refresh_token</code> value and paste it above, then Save.</li>
              </ol>

              <details class="token-help verify-details">
                <summary>Optional — verify a refresh token</summary>
                <p class="muted">
                  Run this in PowerShell to confirm a refresh token still works before saving it
                  in PRISM.
                </p>
                <div class="code-block">
                  <div class="code-block-toolbar">
                    <span class="code-block-label">Verify script (PowerShell)</span>
                    <button
                      type="button"
                      class="copy-btn"
                      @click="copyText(verifyRefreshScript, 'verify')"
                    >{{ copiedKey === 'verify' ? 'Copied' : 'Copy' }}</button>
                  </div>
                  <pre class="token-help-code">{{ verifyRefreshScript }}</pre>
                </div>
              </details>

              <h4>Method B — Legendary CLI</h4>
              <div class="token-help code-block">
                <div class="code-block-toolbar">
                  <span class="code-block-label">Legendary CLI</span>
                  <button
                    type="button"
                    class="copy-btn"
                    @click="copyText(legendaryCliScript, 'legendary')"
                  >{{ copiedKey === 'legendary' ? 'Copied' : 'Copy' }}</button>
                </div>
                <pre class="token-help-code">{{ legendaryCliScript }}</pre>
              </div>
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
                Fab search runs on the PRISM server (VM 211/212), not in your browser.
                Configure <strong>FlareSolverr</strong> in the Cloudflare section below —
                PRISM calls it to obtain <code>cf_clearance</code> cookies for server-side Fab
                API requests. Solving a Cloudflare challenge on your PC does
                <strong>not</strong> replace FlareSolverr for server egress.
              </p>
              <p>
                Optionally set an outbound HTTP proxy via <code>FAB_HTTP_PROXY</code> in
                <code>infra/.env.example</code> when Fab and FlareSolverr must share a
                residential egress IP.
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
            @input="clearFieldError('fabHttpProxy')"
          />
          <p v-if="fieldErrors.fabHttpProxy" class="field-error">{{ fieldErrors.fabHttpProxy }}</p>
          <p class="hint muted">
            Optional outbound proxy for Fab requests when Cloudflare blocks the server IP.
            Overrides <code>FAB_HTTP_PROXY</code> when set here.
          </p>
        </div>

        <fieldset class="cloudflare-block">
          <legend>Cloudflare / Fab access</legend>
          <p class="hint muted cf-intro">
            Fab search runs on the PRISM server (VM 211 prod / VM 212 dev), not in your
            browser. Cloudflare blocks datacenter IPs; PRISM uses
            <strong>FlareSolverr</strong> to obtain <code>cf_clearance</code> cookies for
            server-side Fab API calls. On the dev split stack,
            <code>docker-compose.dev.yml</code> includes a <code>flaresolverr</code> service —
            use <code>{{ DEFAULT_FLARESOLVERR_URL }}</code>. Do not use
            <code>{{ HOST_FLARESOLVERR_URL }}</code> from inside a container (that address is
            the container itself). Solving a bot challenge on your residential PC does
            <strong>not</strong> replace FlareSolverr.
          </p>
          <div class="cf-link-row">
            <button type="button" class="link-btn" @click="openExternalUrl(fabMarketplaceUrl)">
              Open Fab marketplace
            </button>
            <button type="button" class="link-btn" @click="openExternalUrl(fabTestSearchUrl)">
              Test search API
            </button>
          </div>
          <p class="hint muted">
            “Open Fab marketplace” is for manual browsing only. “Test search API” hits
            <code>/api/external-materials/search</code> through the server — use it to verify
            proxy/FlareSolverr fixes, not to paste cookies from your PC.
          </p>

          <div class="field">
            <label for="fab-flaresolverr">FlareSolverr URL <code class="muted">fab_flaresolverr_url</code></label>
            <input
              id="fab-flaresolverr"
              v-model="form.fabFlareSolverrUrl"
              type="text"
              :placeholder="DEFAULT_FLARESOLVERR_URL"
              @input="clearFieldError('fabFlareSolverrUrl')"
            />
            <p v-if="fieldErrors.fabFlareSolverrUrl" class="field-error">{{ fieldErrors.fabFlareSolverrUrl }}</p>
            <p class="hint muted">
              PRISM calls this FlareSolverr <code>/v1</code> API before Fab browse requests to
              obtain Cloudflare clearance cookies. Overrides
              <code>FAB_FLARESOLVERR_URL</code> when set here; see
              <code>infra/.env.example</code>.
            </p>
            <p v-if="flareSolverrUrlHint" class="hint muted">{{ flareSolverrUrlHint }}</p>
          </div>

          <details class="help-details">
            <summary>Run FlareSolverr on the server (Docker)</summary>
            <div class="help-body muted">
              <p>
                On VM 212 dev, <code>docker-compose.dev.yml</code> already defines a
                <code>flaresolverr</code> service — set
                <code>{{ DEFAULT_FLARESOLVERR_URL }}</code> above (or leave env default).
                For a standalone container on the VM host while PRISM runs in Docker, use
                <code>{{ DOCKER_HOST_FLARESOLVERR_URL }}</code> (Windows/Mac) or
                <code>http://172.17.0.1:8191/v1</code> (Linux). Image:
                <button type="button" class="link-btn inline-link" @click="openExternalUrl(FLARESOLVERR_IMAGE)">
                  ghcr.io/flaresolverr/flaresolverr
                </button>.
                Save the URL, then re-test with “Test search API”.
              </p>
              <div class="code-block">
                <div class="code-block-toolbar">
                  <span class="code-block-label">Docker run</span>
                  <button
                    type="button"
                    class="copy-btn"
                    @click="copyText(flareSolverrDockerRun, 'flaresolverr-docker')"
                  >{{ copiedKey === 'flaresolverr-docker' ? 'Copied' : 'Copy' }}</button>
                </div>
                <pre class="token-help-code">{{ flareSolverrDockerRun }}</pre>
              </div>
              <p>
                If Fab uses an HTTP proxy, pass the same proxy to FlareSolverr via its
                <code>proxy</code> request field (PRISM forwards your Fab proxy automatically).
                Re-test with “Test search API” after saving.
              </p>
            </div>
          </details>
        </fieldset>
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
        <code>FAB_HTTP_PROXY</code>, <code>FAB_FLARESOLVERR_URL</code>) for container-level configuration.
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
.field-stack { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
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
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
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
.hint {
  font-size: 11px;
  line-height: 1.45;
  margin: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.field-error {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--color-danger, #dc2626);
}
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
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
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
.help-steps li { margin-bottom: 8px; min-width: 0; }
.help-steps li:last-child { margin-bottom: 0; }
.token-help.code-block,
.help-body .code-block {
  margin: 8px 0 0;
  border-radius: var(--radius-sm, 6px);
  border: 1px solid var(--color-border);
  background: #1e1e2e;
  max-width: 100%;
  min-width: 0;
}
.code-block-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.code-block-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.55);
}
.code-block-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.copy-btn {
  flex-shrink: 0;
  padding: 3px 10px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.85);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  line-height: 1.4;
}
.copy-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.25);
}
.token-help-code {
  margin: 0;
  padding: 12px;
  background: #1e1e1e;
  font-family: ui-monospace, 'Cascadia Code', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #e8e8e8;
  white-space: pre;
  overflow-x: auto;
  overflow-y: hidden;
  max-width: 100%;
  box-sizing: border-box;
  tab-size: 2;
}
.auth-code-field {
  margin: 8px 0 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.auth-code-field label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text);
}
.auth-code-field input {
  width: 100%;
  font-family: ui-monospace, 'Cascadia Code', 'Consolas', monospace;
  font-size: 12px;
}
.verify-details {
  margin: 12px 0 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  padding: 0 10px 10px;
}
.verify-details summary {
  cursor: pointer;
  padding: 8px 0;
  font-size: 11px;
  font-weight: 600;
  list-style: none;
}
.verify-details summary::-webkit-details-marker { display: none; }
.verify-details summary::before {
  content: '▸ ';
  display: inline-block;
  transition: transform 0.15s ease;
}
.verify-details[open] summary::before { transform: rotate(90deg); }
.verify-details p { margin: 0 0 8px; font-size: 11px; }
.help-copy {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.help-copy p { margin: 0; }
.footer-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border);
}
.cloudflare-block {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 8px);
  padding: 10px 12px 12px;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cloudflare-block legend {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 0 6px;
}
.cf-intro { margin: 0; }
.cf-link-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.link-btn {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg-elevated, var(--color-bg));
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.link-btn:hover {
  border-color: var(--color-accent, #6366f1);
}
.inline-link {
  display: inline;
  padding: 0 2px;
  font-size: inherit;
  font-weight: inherit;
  vertical-align: baseline;
}
</style>
