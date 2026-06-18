<script setup lang="ts">
/**
 * Role -> PRISM tool grants editor (Vue Flow).
 * Effective admin access = portal role grants stored in prism-permissions-service.
 */
import { computed, onMounted, ref } from 'vue';
import {
  VueFlow,
  MarkerType,
  type Connection,
} from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import Icon from '../../shared/Icon.vue';
import type { PolicyFlowEdge, ToolFlowNode } from '../utils/policyGraphLayout';
import {
  permissionsApi,
  type PolicyNode as PolicyNodeType,
  type PrismTool,
  type ToolGrants,
} from '../../shared/api';

const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const status = ref<string | null>(null);
const grants = ref<ToolGrants>({ roles: {}, users: {} });
const nodes = ref<ToolFlowNode[]>([]);
const edges = ref<PolicyFlowEdge[]>([]);
const selectedNodeId = ref<string | null>(null);

const portalRoles = ['superAdmin', 'admin', 'staff', 'viewer', 'IT Department'];
const toolLabels: Record<PrismTool, string> = {
  convert: 'Convert',
  visualiser: 'Visualiser',
  fixtures: 'Fixture Library',
  materials: 'Material Library',
  models: 'Model Library',
};

const selectedNode = computed((): ToolFlowNode | null => {
  const id = selectedNodeId.value;
  if (!id) return null;
  for (const n of nodes.value) {
    if (n.id === id) return n;
  }
  return null;
});

function nodeLabel(n: PolicyNodeType) {
  const ref = n.ref ? ` (${n.ref})` : '';
  return `[${n.type}] ${n.label}${ref}`;
}

function grantsToGraph(g: ToolGrants) {
  const nextNodes: ToolFlowNode[] = [];
  const nextEdges: PolicyFlowEdge[] = [];
  let y = 80;

  for (const role of Object.keys(g.roles)) {
    const id = `role-${role}`;
    nextNodes.push({
      id,
      label: nodeLabel({ id, type: 'role', label: role, ref: role, position: { x: 80, y } }),
      position: { x: 80, y },
      data: { policyType: 'role', label: role, refValue: role },
    });
    y += 72;
  }

  let tx = 520;
  let ty = 80;
  for (const tool of permissionsApi.toolsList()) {
    const id = `tool-${tool}`;
    nextNodes.push({
      id,
      label: nodeLabel({ id, type: 'tool', label: toolLabels[tool], ref: tool, position: { x: tx, y: ty } }),
      position: { x: tx, y: ty },
      data: { policyType: 'tool', label: toolLabels[tool], refValue: tool },
    });
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
  const toolIds = new Set<string>();
  for (const n of nodes.value) {
    if (n.data.policyType === 'tool') toolIds.add(String(n.data.refValue ?? ''));
  }

  for (const edge of edges.value) {
    let source: ToolFlowNode | undefined;
    let target: ToolFlowNode | undefined;
    for (const n of nodes.value) {
      if (n.id === edge.source) source = n;
      if (n.id === edge.target) target = n;
    }
    if (!source || !target) continue;
    if (source.data.policyType !== 'role' || target.data.policyType !== 'tool') continue;
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
    markerEnd: MarkerType.ArrowClosed,
    animated: true,
  });
}

function addRoleNode() {
  const role = prompt('Portal role name (e.g. staff, viewer, custom role id):');
  if (!role?.trim()) return;
  const ref = role.trim();
  const id = `role-${ref}`;
  for (const n of nodes.value) {
    if (n.id === id) return;
  }
  nodes.value.push({
    id,
    label: nodeLabel({ id, type: 'role', label: ref, ref, position: { x: 80, y: 80 + nodes.value.length * 24 } }),
    position: { x: 80, y: 80 + nodes.value.length * 24 },
    data: { policyType: 'role', label: ref, refValue: ref },
  });
}

function addToolNode(tool: PrismTool) {
  const id = `tool-${tool}`;
  for (const n of nodes.value) {
    if (n.id === id) return;
  }
  nodes.value.push({
    id,
    label: nodeLabel({ id, type: 'tool', label: toolLabels[tool], ref: tool, position: { x: 520, y: 80 + nodes.value.length * 24 } }),
    position: { x: 520, y: 80 + nodes.value.length * 24 },
    data: { policyType: 'tool', label: toolLabels[tool], refValue: tool },
  });
}

function seedDefaultRoles() {
  for (const role of portalRoles) {
    if (!grants.value.roles[role]) grants.value.roles[role] = [];
  }
  grantsToGraph(grants.value);
}

async function loadGrants() {
  loading.value = true;
  error.value = null;
  try {
    const res = await permissionsApi.getToolGrants();
    grants.value = res.grants;
    if (Object.keys(res.grants.roles).length === 0) seedDefaultRoles();
    else grantsToGraph(res.grants);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load tool grants';
  } finally {
    loading.value = false;
  }
}

async function saveGrants() {
  saving.value = true;
  error.value = null;
  status.value = null;
  try {
    const payload = graphToGrants();
    const res = await permissionsApi.saveToolGrants(payload);
    grants.value = res.grants;
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
  node.data = { ...node.data, refValue: value, label: value || node.data.label };
  node.label = nodeLabel({
    id: node.id,
    type: node.data.policyType,
    label: node.data.label,
    ref: value || null,
    position: node.position,
  });
}

onMounted(loadGrants);
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
          :default-edge-options="{ markerEnd: MarkerType.ArrowClosed }"
          @connect="onConnect"
          @node-click="(evt) => (selectedNodeId = evt.node.id)"
        >
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
.props { border: 1px solid var(--border); border-radius: 8px; padding: 12px; align-self: start; }
.props label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; margin-top: 8px; }
.props input { font-weight: 400; }
.error { color: var(--danger, #ef4444); }
.ok { color: var(--success, #16a34a); font-size: 13px; }
.hint { font-size: 12px; margin-top: 8px; }
</style>
