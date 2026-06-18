<script setup lang="ts">
/**
 * Role -> PRISM tool grants editor (Vue Flow).
 * Effective admin access = portal role grants stored in prism-permissions-service.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  VueFlow,
  MarkerType,
  Position,
  type Connection,
  type Edge,
  type Node,
} from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import Icon from '../../shared/Icon.vue';
import PolicyNode from '../components/permissions/PolicyNode.vue';
import {
  permissionsApi,
  type PrismTool,
  type ToolGrants,
} from '../../shared/api';

const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const status = ref<string | null>(null);
const grants = ref<ToolGrants>({ roles: {}, users: {} });
const nodes = ref<Node[]>([]);
const edges = ref<Edge[]>([]);
const selectedNodeId = ref<string | null>(null);

const portalRoles = ['superAdmin', 'admin', 'staff', 'viewer', 'IT Department'];
const toolLabels: Record<PrismTool, string> = {
  convert: 'Convert',
  visualiser: 'Visualiser',
  fixtures: 'Fixture Library',
  materials: 'Material Library',
  models: 'Model Library',
};

const selectedNode = computed(() => nodes.value.find((n) => n.id === selectedNodeId.value) ?? null);

let remoteFingerprint = '';
let pollTimer: ReturnType<typeof setInterval> | null = null;

function grantsFingerprint(g: ToolGrants): string {
  const roles = Object.fromEntries(
    Object.entries(g.roles).map(([k, v]) => [k, [...v].sort()]),
  );
  const users = Object.fromEntries(
    Object.entries(g.users ?? {}).map(([k, v]) => [k, [...v].sort()]),
  );
  return JSON.stringify({ roles, users });
}

function roleNode(id: string, role: string, position: { x: number; y: number }): Node {
  return {
    id,
    type: 'policyNode',
    position,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      policyType: 'role',
      nodeType: 'role',
      label: role,
      refValue: role,
      noTarget: true,
    },
  };
}

function toolNode(id: string, tool: PrismTool, position: { x: number; y: number }): Node {
  return {
    id,
    type: 'policyNode',
    position,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      policyType: 'tool',
      nodeType: 'tool',
      label: toolLabels[tool],
      refValue: tool,
      noSource: true,
    },
  };
}

function grantsToGraph(g: ToolGrants, preservePositions = false) {
  const posById = preservePositions
    ? new Map(nodes.value.map((n) => [n.id, { ...n.position }]))
    : null;

  const nextNodes: Node[] = [];
  const nextEdges: Edge[] = [];
  let y = 80;

  for (const role of Object.keys(g.roles)) {
    const id = `role-${role}`;
    nextNodes.push(roleNode(id, role, posById?.get(id) ?? { x: 80, y }));
    y += 72;
  }

  let tx = 520;
  let ty = 80;
  for (const tool of permissionsApi.toolsList()) {
    const id = `tool-${tool}`;
    nextNodes.push(toolNode(id, tool, posById?.get(id) ?? { x: tx, y: ty }));
    ty += 72;
    if (ty > 420) {
      ty = 80;
      tx += 220;
    }
  }

  for (const [role, tools] of Object.entries(g.roles)) {
    for (const tool of tools) {
      nextEdges.push({
        id: `e-${role}-${tool}`,
        source: `role-${role}`,
        target: `tool-${tool}`,
        type: 'smoothstep',
        markerEnd: MarkerType.ArrowClosed,
        animated: true,
      });
    }
  }

  nodes.value = nextNodes;
  edges.value = nextEdges;
}

function graphToGrants(): ToolGrants {
  const roleTools: Record<string, PrismTool[]> = {};
  const toolIds = new Set(
    nodes.value
      .filter((n) => n.data?.policyType === 'tool')
      .map((n) => String(n.data?.refValue ?? '')),
  );

  for (const edge of edges.value) {
    const source = nodes.value.find((n) => n.id === edge.source);
    const target = nodes.value.find((n) => n.id === edge.target);
    if (!source || !target) continue;
    if (source.data?.policyType !== 'role' || target.data?.policyType !== 'tool') continue;
    const role = String(source.data.refValue ?? '').trim();
    const tool = String(target.data.refValue ?? '').trim() as PrismTool;
    if (!role || !toolIds.has(tool)) continue;
    const list = roleTools[role] ?? (roleTools[role] = []);
    if (!list.includes(tool)) list.push(tool);
  }

  return { roles: roleTools, users: grants.value.users ?? {} };
}

function onConnect(conn: Connection) {
  edges.value.push({
    id: `e-${conn.source}-${conn.target}`,
    source: conn.source!,
    target: conn.target!,
    type: 'smoothstep',
    markerEnd: MarkerType.ArrowClosed,
    animated: true,
  });
}

function addRoleNode() {
  const role = prompt('Portal role name (e.g. staff, viewer, custom role id):');
  if (!role?.trim()) return;
  const ref = role.trim();
  const id = `role-${ref}`;
  if (nodes.value.some((n) => n.id === id)) return;
  nodes.value.push(roleNode(id, ref, { x: 80, y: 80 + nodes.value.length * 24 }));
}

function addToolNode(tool: PrismTool) {
  const id = `tool-${tool}`;
  if (nodes.value.some((n) => n.id === id)) return;
  nodes.value.push(toolNode(id, tool, { x: 520, y: 80 + nodes.value.length * 24 }));
}

function seedDefaultRoles() {
  for (const role of portalRoles) {
    if (!grants.value.roles[role]) grants.value.roles[role] = [];
  }
  grantsToGraph(grants.value);
}

function applyRemoteGrants(g: ToolGrants, hadLocalEdits: boolean) {
  remoteFingerprint = grantsFingerprint(g);
  grants.value = g;
  grantsToGraph(g, true);
  if (hadLocalEdits) {
    status.value = 'Synced portal changes (local unsaved edits were replaced)';
    setTimeout(() => {
      if (status.value?.startsWith('Synced')) status.value = null;
    }, 4000);
  }
}

async function loadGrants() {
  loading.value = true;
  error.value = null;
  try {
    const res = await permissionsApi.getToolGrants();
    remoteFingerprint = grantsFingerprint(res.grants);
    grants.value = res.grants;
    if (Object.keys(res.grants.roles).length === 0) seedDefaultRoles();
    else grantsToGraph(res.grants);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load tool grants';
  } finally {
    loading.value = false;
  }
}

async function pollGrants() {
  if (saving.value || loading.value) return;
  try {
    const res = await permissionsApi.getToolGrants();
    const fp = grantsFingerprint(res.grants);
    if (fp === remoteFingerprint) return;
    const hadLocalEdits = grantsFingerprint(graphToGrants()) !== remoteFingerprint;
    applyRemoteGrants(res.grants, hadLocalEdits);
  } catch {
    /* keep polling */
  }
}

async function saveGrants() {
  saving.value = true;
  error.value = null;
  status.value = null;
  try {
    const payload = graphToGrants();
    const res = await permissionsApi.saveToolGrants(payload);
    applyRemoteGrants(res.grants, false);
    status.value = 'Tool grants saved';
    setTimeout(() => (status.value = null), 2500);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Save failed';
  } finally {
    saving.value = false;
  }
}

function updateSelectedRef(value: string) {
  const node = selectedNode.value;
  if (!node) return;
  node.data = { ...node.data, refValue: value, label: value || node.data?.label };
}

onMounted(() => {
  void loadGrants();
  pollTimer = setInterval(() => { void pollGrants(); }, 4_000);
});

onUnmounted(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>PRISM tool access</h1>
        <p class="muted">Wire portal roles to PRISM functions. Super Admin / Admin / PRISM admins get all tools automatically.</p>
      </div>
      <div class="toolbar">
        <button type="button" @click="addRoleNode"><Icon name="badge" :size="16" /> Role</button>
        <button
          v-for="tool in permissionsApi.toolsList()"
          :key="tool"
          type="button"
          @click="addToolNode(tool)"
        >
          <Icon name="build" :size="16" /> {{ toolLabels[tool] }}
        </button>
        <button type="button" class="primary" :disabled="saving" @click="saveGrants">
          {{ saving ? 'Saving…' : 'Save grants' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="status" class="ok">{{ status }}</p>

    <div v-if="loading" class="muted">Loading tool grants…</div>

    <div v-else class="layout">
      <div class="graph-wrap">
        <VueFlow
          v-model:nodes="nodes"
          v-model:edges="edges"
          fit-view-on-init
          :default-edge-options="{ markerEnd: MarkerType.ArrowClosed, type: 'smoothstep' }"
          @connect="onConnect"
          @node-click="(evt) => (selectedNodeId = evt.node.id)"
        >
          <template #node-policyNode="nodeProps">
            <PolicyNode
              :label="String(nodeProps.data.label ?? '')"
              :node-type="String(nodeProps.data.nodeType ?? nodeProps.data.policyType ?? 'role')"
              :ref-value="(nodeProps.data.refValue as string | null | undefined) ?? null"
              :no-target="Boolean(nodeProps.data.noTarget)"
              :no-source="Boolean(nodeProps.data.noSource)"
            />
          </template>
          <Background />
          <Controls />
        </VueFlow>
      </div>

      <aside v-if="selectedNode" class="props">
        <h2>Node properties</h2>
        <p class="muted">{{ selectedNode.data?.policyType }} node</p>
        <label>
          Ref
          <input
            :value="String(selectedNode.data?.refValue ?? '')"
            @input="updateSelectedRef(($event.target as HTMLInputElement).value)"
          />
        </label>
        <p class="hint muted">Role ref must match portal role/customRoleId. Tool ref must be convert, visualiser, fixtures, materials, or models.</p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; height: 100%; }
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
.layout { display: grid; grid-template-columns: 1fr 260px; gap: 12px; flex: 1; min-height: 420px; }
.graph-wrap { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; min-height: 420px; }
.graph-wrap :deep(.vue-flow__node-policyNode) {
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 0;
  box-shadow: none;
  width: auto;
}
.graph-wrap :deep(.vue-flow__handle) {
  width: 8px;
  height: 8px;
  background: var(--color-border-strong, #64748b);
  border: 1.5px solid var(--surface-2, #fff);
}
.props { border: 1px solid var(--border); border-radius: 8px; padding: 12px; align-self: start; }
.props label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; margin-top: 8px; }
.props input { font-weight: 400; }
.error { color: var(--danger, #ef4444); }
.ok { color: var(--success, #16a34a); font-size: 13px; }
.hint { font-size: 12px; margin-top: 8px; }
</style>
