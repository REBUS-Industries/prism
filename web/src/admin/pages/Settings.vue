<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { orbitApi, settingsApi, type ApiError, type OrbitTestFail, type OrbitTestOk } from '../../shared/api';
import Modal from '../../shared/Modal.vue';
import Icon from '../../shared/Icon.vue';
import FixtureTypesManager from '../components/FixtureTypesManager.vue';
import ExternalMaterialsSettings from '../components/ExternalMaterialsSettings.vue';
import PortalIdentitySettings from '../components/PortalIdentitySettings.vue';
import { useFixtureTypesStore } from '../stores/fixtureTypes';

interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  type?: 'text' | 'number' | 'switch';
}

const orbitProdFields: FieldDef[] = [
  { key: 'orbit_server_url', label: 'Server URL', placeholder: 'https://orbit.rebus.industries' },
  { key: 'orbit_token',      label: 'API token (PAT)', secret: true, placeholder: 'paste a personal access token here' },
];
const orbitDevFields: FieldDef[] = [
  { key: 'orbit_dev_server_url', label: 'Server URL', placeholder: 'https://orbit-dev.rebus.industries' },
  { key: 'orbit_dev_token',      label: 'API token (PAT)', secret: true },
];
const otherFields: FieldDef[] = [
  { key: 'job_retention_hours', label: 'Job retention (hours)', type: 'number', placeholder: '720' },
  { key: 'maintenance_mode',    label: 'Maintenance mode', type: 'switch' },
];

const gdtfShareFields: FieldDef[] = [
  { key: 'gdtf_share_username', label: 'GDTF-Share username', placeholder: 'account@example.com' },
  { key: 'gdtf_share_password', label: 'GDTF-Share password', secret: true, placeholder: 'write-only — not echoed after save' },
];

const workstationAgentFields: FieldDef[] = [
  {
    key: 'workstation_agent_ws_url',
    label: 'WS endpoint override',
    placeholder: 'wss://prism.rebus.industries/ws/agent (leave blank to derive from request)',
  },
  {
    key: 'workstation_dns_suffix',
    label: 'DNS suffix for workstation Web UI links',
    placeholder: 'ad.rebus.industries',
  },
];

// Reactive state for each known key: current input + original DB value.
// Pre-populate synchronously so the template can render before refresh()
// returns — otherwise `values[f.key].value` blows up on first paint.
const ALL_KEYS = [...orbitProdFields, ...orbitDevFields, ...gdtfShareFields, ...otherFields, ...workstationAgentFields].map((f) => f.key);
const values = reactive<Record<string, { value: string; original: string }>>(
  Object.fromEntries(ALL_KEYS.map((k) => [k, { value: '', original: '' }])),
);
const saving = reactive<Record<string, boolean>>({});
const status = ref<string | null>(null);
const error  = ref<string | null>(null);

const fixtureTypesStore = useFixtureTypesStore();

// ── Tile model ──────────────────────────────────────────────────────────
// Each section is a tile; clicking either opens a modal (fields/custom) or
// navigates to a named route (routeName).
type TileKey = 'orbit-prod' | 'orbit-dev' | 'gdtf' | 'server' | 'workstation' | 'fixture-types'
             | 'external-materials' | 'portal-identity'
             | 'users' | 'webhooks' | 'api-keys';
interface TileDef {
  key: TileKey;
  title: string;
  /** Material Symbols ligature name (shared Icon.vue). */
  icon: string;
  description: string;
  fields?: FieldDef[];
  testTarget?: 'prod' | 'dev';
  custom?: 'fixture-types' | 'external-materials' | 'portal-identity';
  /** Navigate to this named route instead of opening a modal. */
  routeName?: string;
}

const router = useRouter();

const tiles: TileDef[] = [
  { key: 'orbit-prod',     title: 'ORBIT — Production',   icon: 'cloud',     description: 'Production server URL + API token used by the orchestrator.', fields: orbitProdFields, testTarget: 'prod' },
  { key: 'orbit-dev',      title: 'ORBIT — Dev / Staging', icon: 'science',   description: 'Dev/staging server URL + API token.', fields: orbitDevFields, testTarget: 'dev' },
  { key: 'gdtf',           title: 'GDTF-Share',            icon: 'lightbulb', description: 'Credentials for fixture library import from GDTF-Share.com.', fields: gdtfShareFields },
  { key: 'fixture-types',  title: 'Fixture Types',         icon: 'palette',   description: 'Manage fixture categories and the colours shown across the library.', custom: 'fixture-types' },
  { key: 'external-materials', title: 'External materials', icon: 'travel_explore', description: 'Fab, Poly Haven, and ambientCG search providers + Epic OAuth token.', custom: 'external-materials' },
  { key: 'portal-identity', title: 'Portal & Google Workspace', icon: 'account_circle', description: 'Portal OAuth, Google API credentials, workspace sync, and admin Google sign-in.', custom: 'portal-identity' },
  { key: 'server',         title: 'Server',                icon: 'dns',       description: 'Job retention window and maintenance mode.', fields: otherFields },
  { key: 'workstation',    title: 'Workstation agent',     icon: 'lan',       description: 'Agent WS endpoint override + DNS suffix for Web UI links.', fields: workstationAgentFields },
  { key: 'users',          title: 'Users',                 icon: 'group',     description: 'Manage admin accounts and access.', routeName: 'users' },
  { key: 'webhooks',       title: 'Webhooks',              icon: 'webhook',   description: 'Configure outbound webhook endpoints for job events.', routeName: 'webhooks' },
  { key: 'api-keys',       title: 'API Keys',              icon: 'key',       description: 'Issue and revoke API keys for programmatic access.', routeName: 'keys' },
];

const activeKey = ref<TileKey | null>(null);
const activeTile = computed(() => tiles.find((t) => t.key === activeKey.value) ?? null);

type TestState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok';   user: { name: string; email?: string | null }; server: { name: string; version: string } }
  | { kind: 'fail'; reason: string };

const testProd = reactive<TestState>({ kind: 'idle' });
const testDev  = reactive<TestState>({ kind: 'idle' });

async function refresh() {
  const all = (await settingsApi.list()).settings;
  for (const f of [...orbitProdFields, ...orbitDevFields, ...gdtfShareFields, ...otherFields, ...workstationAgentFields]) {
    const v = all[f.key] ?? '';
    values[f.key] = { value: v, original: v };
  }
}

function isDirty(key: string): boolean {
  const v = values[key];
  return !!v && v.value !== v.original;
}

function tileDirty(tile: TileDef): boolean {
  return (tile.fields ?? []).some((f) => isDirty(f.key));
}

/**
 * Per-key client-side normalisation applied just before save. Currently
 * only `workstation_dns_suffix` needs cleanup -- it's surfaced verbatim
 * in browser URLs by the Workstations / Pipeline pages so we strip any
 * accidental scheme prefix, leading dots, trailing slashes, port, and
 * surrounding whitespace before persisting.
 */
function sanitizeValue(key: string, raw: string): string {
  let v = (raw ?? '').trim();
  if (key === 'workstation_dns_suffix') {
    v = v
      .replace(/^[a-z]+:\/\//i, '')   // strip http:// / https:// / ws:// etc.
      .replace(/^\.+/, '')             // strip leading dots
      .replace(/\/.*$/, '')            // strip trailing path
      .replace(/:\d+$/, '');           // strip trailing :port
  }
  return v;
}

async function save(key: string) {
  error.value = null;
  saving[key] = true;
  try {
    const cleaned = sanitizeValue(key, values[key].value);
    // Reflect any normalisation back into the input so the operator
    // can see what was actually persisted.
    values[key].value = cleaned;
    await settingsApi.set(key, cleaned);
    values[key].original = cleaned;
    status.value = `Saved ${key}`;
    setTimeout(() => (status.value = null), 1500);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'save failed';
  } finally {
    saving[key] = false;
  }
}

async function saveAll(fields: FieldDef[]) {
  for (const f of fields) if (isDirty(f.key)) await save(f.key);
}

function setTestState(state: TestState, target: 'prod' | 'dev') {
  const t = target === 'prod' ? testProd : testDev;
  Object.assign(t, state);
}

async function runTest(target: 'prod' | 'dev') {
  setTestState({ kind: 'busy' }, target);
  // If unsaved changes exist for this target, save them first so the test
  // hits the values the operator just typed.
  const fields = target === 'prod' ? orbitProdFields : orbitDevFields;
  await saveAll(fields);

  const r = await orbitApi.test(target);
  if ((r as OrbitTestOk).ok) {
    const ok = r as OrbitTestOk;
    setTestState({
      kind: 'ok',
      user:   { name: ok.user.name, email: ok.user.email ?? null },
      server: { name: ok.serverInfo.name, version: ok.serverInfo.version },
    }, target);
  } else {
    const fail = r as OrbitTestFail;
    setTestState({ kind: 'fail', reason: fail.error }, target);
  }
}

const activeTest = computed<TestState | null>(() => {
  const target = activeTile.value?.testTarget;
  if (!target) return null;
  return target === 'prod' ? testProd : testDev;
});

function openTile(key: TileKey) {
  const tile = tiles.find((t) => t.key === key);
  if (tile?.routeName) {
    void router.push({ name: tile.routeName });
    return;
  }
  error.value = null;
  activeKey.value = key;
}

function closeTile() {
  activeKey.value = null;
  // Drop any unsaved edits so re-opening shows the persisted values.
  void refresh();
}

async function saveActive() {
  if (activeTile.value?.fields) await saveAll(activeTile.value.fields);
}

/** Short status/summary line shown on each tile. */
function tileSummary(tile: TileDef): string {
  switch (tile.key) {
    case 'orbit-prod':
      return values.orbit_server_url.value || 'Not configured';
    case 'orbit-dev':
      return values.orbit_dev_server_url.value || 'Not configured';
    case 'gdtf':
      return values.gdtf_share_username.value
        ? `User: ${values.gdtf_share_username.value}`
        : 'Not configured';
    case 'server':
      return `Retention ${values.job_retention_hours.value || '720'}h · Maintenance ${values.maintenance_mode.value === '1' ? 'ON' : 'off'}`;
    case 'workstation':
      return values.workstation_dns_suffix.value
        ? `DNS ${values.workstation_dns_suffix.value}`
        : 'Auto (derive from host)';
    case 'fixture-types':
      return `${fixtureTypesStore.labels.length} type${fixtureTypesStore.labels.length === 1 ? '' : 's'}`;
    case 'external-materials':
      return 'Fab · Poly Haven · ambientCG';
    case 'portal-identity':
      return 'OAuth · Workspace · Google API';
    case 'users':
    case 'webhooks':
    case 'api-keys':
      return '';
    default:
      return '';
  }
}

onMounted(() => {
  void refresh();
  void fixtureTypesStore.ensureLoaded();
});
</script>

<template>
  <h1>Settings</h1>
  <p class="muted">Live values used by the orchestrator + dispatcher. Click a card to edit. Secrets are masked after saving and never re-exposed to the browser through the API.</p>

  <div v-if="error"  class="error-box mt">{{ error }}</div>
  <div v-if="status" class="success-box mt">{{ status }}</div>

  <!-- ─────────────────────────────── Tile grid ─────────────────────────── -->
  <div class="tile-grid">
    <button
      v-for="tile in tiles"
      :key="tile.key"
      type="button"
      class="tile"
      @click="openTile(tile.key)"
    >
      <span class="tile-icon"><Icon :name="tile.icon" :size="24" /></span>
      <span class="tile-body">
        <span class="tile-title">{{ tile.title }}</span>
        <span class="tile-desc">{{ tile.description }}</span>
        <span class="tile-summary">{{ tileSummary(tile) }}</span>
      </span>
      <Icon class="tile-chevron" name="chevron_right" :size="22" />
    </button>
  </div>

  <!-- ─────────────────────────────── Modal ─────────────────────────────── -->
  <Modal
    v-if="activeTile"
    :title="activeTile.title"
    :subtitle="activeTile.description"
    :max-width="activeTile.custom === 'fixture-types' ? 600 : activeTile.custom === 'external-materials' ? 960 : activeTile.custom === 'portal-identity' ? 920 : 560"
    :min-width="activeTile.custom === 'external-materials' || activeTile.custom === 'portal-identity' ? 720 : 0"
    :viewport-width="activeTile.custom === 'external-materials' || activeTile.custom === 'portal-identity' ? 94 : undefined"
    @close="closeTile"
  >
    <!-- Fixture Types manager -->
    <FixtureTypesManager v-if="activeTile.custom === 'fixture-types'" />

    <!-- External materials providers -->
    <ExternalMaterialsSettings v-else-if="activeTile.custom === 'external-materials'" />

    <!-- Portal OAuth + Google Workspace -->
    <PortalIdentitySettings v-else-if="activeTile.custom === 'portal-identity'" />

    <!-- Standard key/value field sections -->
    <template v-else>
      <div class="field-stack">
        <div class="field" v-for="f in activeTile.fields" :key="f.key">
          <label :for="`set-${f.key}`">
            {{ f.label }}
            <code class="muted">{{ f.key }}</code>
          </label>
          <select
            v-if="f.type === 'switch'"
            :id="`set-${f.key}`"
            v-model="values[f.key].value"
          >
            <option value="0">Off</option>
            <option value="1">On — block API + agents</option>
          </select>
          <input
            v-else
            :id="`set-${f.key}`"
            :type="f.secret ? 'password' : (f.type ?? 'text')"
            :placeholder="f.placeholder ?? ''"
            v-model="values[f.key].value"
          />
        </div>
      </div>

      <!-- ORBIT connection test -->
      <div v-if="activeTile.testTarget && activeTest" class="test-block">
        <button
          class="primary"
          :disabled="activeTest.kind === 'busy'"
          @click="runTest(activeTile.testTarget)"
        >
          {{ activeTest.kind === 'busy' ? 'Testing…' : 'Test connection' }}
        </button>
        <div class="status mt-sm" v-if="activeTest.kind !== 'idle'">
          <span v-if="activeTest.kind === 'busy'" class="pill">checking…</span>
          <span v-else-if="activeTest.kind === 'ok'" class="pill ok">connected</span>
          <span v-else class="pill fail">failed</span>

          <span v-if="activeTest.kind === 'ok'" class="muted test-detail">
            as <strong>{{ activeTest.user.name }}</strong>
            <span v-if="activeTest.user.email"> ({{ activeTest.user.email }})</span>
            on {{ activeTest.server.name }} {{ activeTest.server.version }}
          </span>
          <span v-else-if="activeTest.kind === 'fail'" class="muted test-detail">{{ activeTest.reason }}</span>
        </div>
      </div>

      <!-- Workstation agent explanatory copy -->
      <div v-if="activeTile.key === 'workstation'" class="help-copy muted">
        <p>
          Surfaced on the
          <RouterLink :to="{ name: 'workstations' }">Workstations</RouterLink>
          page under <em>Node downloads</em>. The agent download URL and version
          are auto-resolved from the latest GitHub Release — no admin action
          needed. Leave the WS endpoint override blank to derive
          <code>wss://&lt;host&gt;/ws/agent</code> from the request host.
        </p>
        <p>
          The <em>DNS suffix</em> is appended to each workstation's
          <code>nodeName</code> when building the <em>Open Web UI <Icon name="open_in_new" :size="12" /></em> link.
          Leave blank if your network resolves bare hostnames. The link
          auto-strips a leading dot, scheme prefix, trailing path, and
          <code>:port</code> on save.
        </p>
      </div>
    </template>

    <template v-if="activeTile.custom === 'fixture-types'" #footer>
      <button class="primary" @click="closeTile">Done</button>
    </template>
    <template v-else-if="activeTile.custom === 'external-materials'" #footer>
      <button @click="closeTile">Close</button>
    </template>
    <template v-else-if="activeTile.custom === 'portal-identity'" #footer>
      <button @click="closeTile">Close</button>
    </template>
    <template v-else #footer>
      <button @click="closeTile">Cancel</button>
      <button class="primary" :disabled="!tileDirty(activeTile)" @click="saveActive">Save</button>
    </template>
  </Modal>
</template>

<style scoped>
h1 { font-size: 22px; margin: 0 0 4px; }

.tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
  margin-top: 20px;
}

.tile {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  width: 100%;
  padding: 16px;
  text-align: left;
  text-transform: none;
  letter-spacing: normal;
  min-height: 0;
  border: 1px solid var(--color-border);
  border-radius: 0;
  background: var(--color-bg-elevated);
  color: var(--color-text);
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
}
@media (min-width: 640px) {
  .tile { border-radius: var(--radius); box-shadow: var(--shadow-1); }
}
.tile:hover {
  background: var(--color-bg-hover);
  border-color: var(--orbit-primary);
}
.tile:focus-visible {
  outline: 2px solid var(--orbit-primary);
  outline-offset: 2px;
}

.tile-icon {
  flex-shrink: 0;
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm, 8px);
  background: var(--orbit-primary-fade);
  font-size: 20px;
  line-height: 1;
}

.tile-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.tile-title {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.tile-desc {
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-text-muted);
}
.tile-summary {
  margin-top: 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--orbit-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.tile-chevron {
  flex-shrink: 0;
  font-size: 22px;
  line-height: 1;
  color: var(--color-text-muted);
}

/* ── Modal field stack ── */
.field-stack { display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-weight: 600;
}
.field label code { font-size: 11px; font-weight: 400; }
.field input, .field select { width: 100%; }

.test-block { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--color-border); }
.status { display: flex; align-items: center; gap: 10px; font-size: 12px; flex-wrap: wrap; }
.test-detail { font-size: 12px; }

.help-copy { margin-top: 14px; font-size: 12px; line-height: 1.5; }
.help-copy p { margin: 0 0 8px; }
.help-copy p:last-child { margin-bottom: 0; }
</style>
