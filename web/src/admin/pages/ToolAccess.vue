<script setup lang="ts">
/**
 * Read-only view of portal role → PRISM tool grants (Vue Flow).
 * Grants are managed in the portal; this page polls for live updates.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  VueFlow,
  MarkerType,
  Position,
  type Edge,
  type Node,
} from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import PolicyNode from '../components/permissions/PolicyNode.vue';
import {
  permissionsApi,
  type PrismTool,
  type ToolGrants,
} from '../../shared/api';

const loading = ref(true);
const error = ref<string | null>(null);
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
        <p class="muted">Portal role grants for PRISM functions. Super Admin / Admin / PRISM admins get all tools automatically. Edit grants in the portal — changes appear here live.</p>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="loading" class="muted">Loading tool grants…</div>

    <div v-else class="layout">
      <div class="graph-wrap">
        <VueFlow
          v-model:nodes="nodes"
          v-model:edges="edges"
          fit-view-on-init
          :nodes-connectable="false"
          :edges-updatable="false"
          :default-edge-options="{ markerEnd: MarkerType.ArrowClosed, type: 'smoothstep' }"
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
        <h2>Node</h2>
        <p class="muted">{{ selectedNode.data?.policyType }} · {{ selectedNode.data?.label }}</p>
        <dl v-if="selectedNode.data?.refValue" class="ref-dl">
          <dt>Ref</dt>
          <dd>{{ selectedNode.data.refValue }}</dd>
        </dl>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; height: 100%; }
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
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
.ref-dl { margin: 12px 0 0; font-size: 13px; }
.ref-dl dt { font-weight: 600; margin-bottom: 4px; }
.ref-dl dd { margin: 0; font-family: var(--mono, monospace); word-break: break-all; }
.error { color: var(--danger, #ef4444); }
</style>
