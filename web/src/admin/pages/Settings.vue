<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { orbitApi, settingsApi, type ApiError, type OrbitTestFail, type OrbitTestOk } from '../../shared/api';

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

const workstationAgentFields: FieldDef[] = [
  {
    key: 'workstation_agent_ws_url',
    label: 'WS endpoint override',
    placeholder: 'wss://prism.rebus.industries/ws/agent (leave blank to derive from request)',
  },
];

// Reactive state for each known key: current input + original DB value.
// Pre-populate synchronously so the template can render before refresh()
// returns — otherwise `values[f.key].value` blows up on first paint.
const ALL_KEYS = [...orbitProdFields, ...orbitDevFields, ...otherFields, ...workstationAgentFields].map((f) => f.key);
const values = reactive<Record<string, { value: string; original: string }>>(
  Object.fromEntries(ALL_KEYS.map((k) => [k, { value: '', original: '' }])),
);
const saving = reactive<Record<string, boolean>>({});
const status = ref<string | null>(null);
const error  = ref<string | null>(null);

type TestState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok';   user: { name: string; email?: string | null }; server: { name: string; version: string } }
  | { kind: 'fail'; reason: string };

const testProd = reactive<TestState>({ kind: 'idle' });
const testDev  = reactive<TestState>({ kind: 'idle' });

async function refresh() {
  const all = (await settingsApi.list()).settings;
  for (const f of [...orbitProdFields, ...orbitDevFields, ...otherFields, ...workstationAgentFields]) {
    const v = all[f.key] ?? '';
    values[f.key] = { value: v, original: v };
  }
}

function isDirty(key: string): boolean {
  const v = values[key];
  return !!v && v.value !== v.original;
}

async function save(key: string) {
  error.value = null;
  saving[key] = true;
  try {
    await settingsApi.set(key, values[key].value);
    values[key].original = values[key].value;
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

onMounted(refresh);
</script>

<template>
  <h1>Settings</h1>
  <p class="muted">Live values used by the orchestrator + dispatcher. Secrets are masked after saving and never re-exposed to the browser through the API.</p>

  <div v-if="error"  class="error-box mt">{{ error }}</div>
  <div v-if="status" class="success-box mt">{{ status }}</div>

  <!-- ============================================== ORBIT — Production -->
  <section class="block">
    <header class="block-head">
      <h2>ORBIT — Production</h2>
      <button class="primary" :disabled="testProd.kind === 'busy'" @click="runTest('prod')">
        {{ testProd.kind === 'busy' ? 'Testing…' : 'Test connection' }}
      </button>
    </header>

    <div class="card">
      <div class="row" v-for="f in orbitProdFields" :key="f.key">
        <label>
          {{ f.label }}
          <code class="muted">{{ f.key }}</code>
        </label>
        <input
          :type="f.secret ? 'password' : 'text'"
          :placeholder="f.placeholder ?? ''"
          v-model="values[f.key].value"
        />
        <button :disabled="!isDirty(f.key) || saving[f.key]" @click="save(f.key)">Save</button>
      </div>
    </div>

    <div class="status mt-sm" v-if="testProd.kind !== 'idle'">
      <span v-if="testProd.kind === 'busy'" class="pill">checking…</span>
      <span v-else-if="testProd.kind === 'ok'" class="pill ok">
        connected
      </span>
      <span v-else class="pill fail">failed</span>

      <span v-if="testProd.kind === 'ok'" class="muted">
        as <strong>{{ testProd.user.name }}</strong>
        <span v-if="testProd.user.email"> ({{ testProd.user.email }})</span>
        on {{ testProd.server.name }} {{ testProd.server.version }}
      </span>
      <span v-else-if="testProd.kind === 'fail'" class="muted">{{ testProd.reason }}</span>
    </div>
  </section>

  <!-- ============================================== ORBIT — Dev -->
  <section class="block">
    <header class="block-head">
      <h2>ORBIT — Dev / Staging</h2>
      <button class="primary" :disabled="testDev.kind === 'busy'" @click="runTest('dev')">
        {{ testDev.kind === 'busy' ? 'Testing…' : 'Test connection' }}
      </button>
    </header>

    <div class="card">
      <div class="row" v-for="f in orbitDevFields" :key="f.key">
        <label>
          {{ f.label }}
          <code class="muted">{{ f.key }}</code>
        </label>
        <input
          :type="f.secret ? 'password' : 'text'"
          :placeholder="f.placeholder ?? ''"
          v-model="values[f.key].value"
        />
        <button :disabled="!isDirty(f.key) || saving[f.key]" @click="save(f.key)">Save</button>
      </div>
    </div>

    <div class="status mt-sm" v-if="testDev.kind !== 'idle'">
      <span v-if="testDev.kind === 'busy'" class="pill">checking…</span>
      <span v-else-if="testDev.kind === 'ok'" class="pill ok">connected</span>
      <span v-else class="pill fail">failed</span>

      <span v-if="testDev.kind === 'ok'" class="muted">
        as <strong>{{ testDev.user.name }}</strong>
        <span v-if="testDev.user.email"> ({{ testDev.user.email }})</span>
        on {{ testDev.server.name }} {{ testDev.server.version }}
      </span>
      <span v-else-if="testDev.kind === 'fail'" class="muted">{{ testDev.reason }}</span>
    </div>
  </section>

  <!-- ============================================== Other -->
  <section class="block">
    <header class="block-head">
      <h2>Server</h2>
    </header>
    <div class="card">
      <div class="row" v-for="f in otherFields" :key="f.key">
        <label>
          {{ f.label }}
          <code class="muted">{{ f.key }}</code>
        </label>
        <input
          v-if="f.type !== 'switch'"
          :type="f.type ?? 'text'"
          :placeholder="f.placeholder ?? ''"
          v-model="values[f.key].value"
        />
        <select v-else v-model="values[f.key].value">
          <option value="0">Off</option>
          <option value="1">On — block API + agents</option>
        </select>
        <button :disabled="!isDirty(f.key) || saving[f.key]" @click="save(f.key)">Save</button>
      </div>
    </div>
  </section>

  <!-- ============================================== Workstation agent -->
  <section class="block">
    <header class="block-head">
      <h2>Workstation agent</h2>
    </header>
    <p class="muted" style="font-size: 12px; margin: 0 0 8px;">
      Surfaced on the
      <RouterLink :to="{ name: 'workstations' }">Workstations</RouterLink>
      page under <em>Node downloads</em>. The agent download URL and version
      are auto-resolved from the latest GitHub Release at
      <code>REBUS-ORBIT/prism-agent</code> on every request — no admin action
      needed. Leave the WS endpoint override blank to derive
      <code>wss://&lt;host&gt;/ws/agent</code> from the request host; set it
      only when the public proxy host differs from the request host.
    </p>
    <div class="card">
      <div class="row" v-for="f in workstationAgentFields" :key="f.key">
        <label>
          {{ f.label }}
          <code class="muted">{{ f.key }}</code>
        </label>
        <input
          type="text"
          :placeholder="f.placeholder ?? ''"
          v-model="values[f.key].value"
        />
        <button :disabled="!isDirty(f.key) || saving[f.key]" @click="save(f.key)">Save</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 14px; margin: 0; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-text-muted); }
.block { margin-top: 28px; }
.block-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.row {
  display: grid; grid-template-columns: 220px 1fr auto; gap: 12px; align-items: center;
  padding: 10px 0; border-bottom: 1px solid var(--color-border);
}
.row:last-child { border-bottom: none; }
label { display: flex; flex-direction: column; gap: 2px; font-weight: 500; }
label code { font-size: 11px; font-weight: 400; }
.status { display: flex; align-items: center; gap: 10px; font-size: 12px; }
/* `.pill.ok` and `.pill.fail` are styled globally in designSystem.css. */
</style>
