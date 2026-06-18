<script setup lang="ts">
/**
 * Read-only portal role → PRISM tool grants pin board.
 * Grants are managed in the portal; this page polls for live updates.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { MarkerType } from '@vue-flow/core';
import PolicyGraphBoard from '../components/permissions/PolicyGraphBoard.vue';
import PolicyInspector from '../components/permissions/PolicyInspector.vue';
import type { PolicyFlowEdge, PolicyFlowNode } from '../utils/policyGraphLayout';
import {
  permissionsApi,
  type PrismTool,
  type ToolGrants,
} from '../../shared/api';

const loading = ref(true);
const error = ref<string | null>(null);
const grants = ref<ToolGrants>({ roles: {}, users: {} });
const nodes = ref<PolicyFlowNode[]>([]);
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

const toolColumnLabels = [
  { type: 'role' as const, label: 'Roles' },
  { type: 'tool' as const, label: 'Tools' },
];

const selectedNode = computed(() => {
  const id = selectedNodeId.value;
  if (!id) return null;
  for (const n of nodes.value) {
    if (n.id === id) return { id: n.id, data: n.data };
  }
  return null;
});

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

function roleNode(id: string, role: string, position: { x: number; y: number }): PolicyFlowNode {
  return {
    id,
    type: 'policy',
    position,
    data: {
      policyType: 'role',
      label: role,
      refValue: role,
      noTarget: true,
    },
  };
}

function toolNode(id: string, tool: PrismTool, position: { x: number; y: number }): PolicyFlowNode {
  return {
    id,
    type: 'policy',
    position,
    data: {
      policyType: 'tool',
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

  const nextNodes: PolicyFlowNode[] = [];
  const nextEdges: PolicyFlowEdge[] = [];
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
        markerEnd: MarkerType.ArrowClosed,
        animated: true,
      });
    }
  }

  nodes.value = nextNodes;
  edges.value = nextEdges;
}

function seedDefaultRoles() {
  for (const role of portalRoles) {
    if (!grants.value.roles[role]) grants.value.roles[role] = [];
  }
  grantsToGraph(grants.value);
}

function applyRemoteGrants(g: ToolGrants) {
  remoteFingerprint = grantsFingerprint(g);
  grants.value = g;
  grantsToGraph(g, true);
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
  if (loading.value) return;
  try {
    const res = await permissionsApi.getToolGrants();
    const fp = grantsFingerprint(res.grants);
    if (fp === remoteFingerprint) return;
    applyRemoteGrants(res.grants);
  } catch {
    /* keep polling */
  }
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
        <p class="muted">
          Portal role grants for PRISM functions. Super Admin / Admin / PRISM admins get all tools automatically.
          Edit grants in the portal — changes appear here live.
        </p>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="loading" class="muted">Loading tool grants…</div>

    <PolicyGraphBoard
      v-else
      v-model:nodes="nodes"
      v-model:edges="edges"
      v-model:selected-node-id="selectedNodeId"
      readonly
      legend-title="Tool access"
      :column-labels="toolColumnLabels"
    >
      <template #inspector>
        <PolicyInspector readonly :node="selectedNode" />
      </template>
    </PolicyGraphBoard>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; height: 100%; }
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.error { color: var(--danger, #ef4444); }
</style>
