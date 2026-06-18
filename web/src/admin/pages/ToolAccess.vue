<script setup lang="ts">
/**
 * Read-only PRISM tool access pin board.
 *
 * Role nodes are driven by the portal's LIVE role list
 * (GET /api/permissions/portal-roles) so deleted/renamed portal roles never
 * linger. Tool grants (GET /api/permissions/tool-grants) draw the role→tool
 * edges. Grants for roles no longer in the portal list are pruned automatically
 * by the permissions service when the live role feed is available.
 * Both feeds are polled so the graph updates without a refresh.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { MarkerType } from '@vue-flow/core';
import PolicyGraphBoard from '../components/permissions/PolicyGraphBoard.vue';
import PolicyInspector from '../components/permissions/PolicyInspector.vue';
import type { PolicyFlowEdge, PolicyFlowNode } from '../utils/policyGraphLayout';
import {
  permissionsApi,
  type PortalRole,
  type PrismTool,
  type ToolGrants,
} from '../../shared/api';

const loading = ref(true);
const error = ref<string | null>(null);
const grants = ref<ToolGrants>({ roles: {}, users: {} });
const portalRoles = ref<PortalRole[]>([]);
const portalRolesSupported = ref(true);
const nodes = ref<PolicyFlowNode[]>([]);
const edges = ref<PolicyFlowEdge[]>([]);
const selectedNodeId = ref<string | null>(null);

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

interface RoleEntry {
  key: string;
  label: string;
  stale: boolean;
}

/** Combine the live portal role list with grant role keys. Portal roles win. */
const roleEntries = computed<RoleEntry[]>(() => {
  const entries: RoleEntry[] = [];
  const seen = new Set<string>();
  if (portalRolesSupported.value) {
    for (const r of portalRoles.value) {
      const key = r.id.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push({ key, label: r.name?.trim() || key, stale: false });
    }
  }
  for (const key of Object.keys(grants.value.roles ?? {})) {
    if (seen.has(key)) continue;
    seen.add(key);
    // A grant role missing from a supported portal list is stale; when the
    // portal feed is unavailable we can't tell, so don't flag it.
    entries.push({ key, label: key, stale: portalRolesSupported.value });
  }
  return entries;
});

const hasRoles = computed(() => roleEntries.value.length > 0);
const staleRoles = computed(() => roleEntries.value.filter((r) => r.stale).map((r) => r.key));

let remoteFingerprint = '';
let pollTimer: ReturnType<typeof setInterval> | null = null;

function stateFingerprint(): string {
  const roles = Object.fromEntries(
    Object.entries(grants.value.roles ?? {}).map(([k, v]) => [k, [...v].sort()]),
  );
  const users = Object.fromEntries(
    Object.entries(grants.value.users ?? {}).map(([k, v]) => [k, [...v].sort()]),
  );
  const portal = {
    supported: portalRolesSupported.value,
    roles: portalRoles.value.map((r) => `${r.id}:${r.name ?? ''}`).sort(),
  };
  return JSON.stringify({ roles, users, portal });
}

function roleNode(entry: RoleEntry, position: { x: number; y: number }): PolicyFlowNode {
  return {
    id: `role-${entry.key}`,
    type: 'policy',
    position,
    data: {
      policyType: 'role',
      label: entry.label,
      refValue: entry.key,
      noTarget: true,
      stale: entry.stale,
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

function buildGraph(preservePositions = false) {
  const posById = preservePositions
    ? new Map(nodes.value.map((n) => [n.id, { ...n.position }]))
    : null;

  const nextNodes: PolicyFlowNode[] = [];
  const nextEdges: PolicyFlowEdge[] = [];

  let y = 80;
  for (const entry of roleEntries.value) {
    const id = `role-${entry.key}`;
    nextNodes.push(roleNode(entry, posById?.get(id) ?? { x: 80, y }));
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

  const toolIds = new Set(permissionsApi.toolsList());
  for (const [role, tools] of Object.entries(grants.value.roles ?? {})) {
    for (const tool of tools) {
      if (!toolIds.has(tool)) continue;
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

async function fetchState() {
  const [grantsRes, rolesRes] = await Promise.allSettled([
    permissionsApi.getToolGrants(),
    permissionsApi.getPortalRoles(),
  ]);

  if (grantsRes.status === 'fulfilled') {
    grants.value = grantsRes.value.grants;
  } else if (loading.value) {
    throw grantsRes.reason;
  }

  if (rolesRes.status === 'fulfilled') {
    portalRolesSupported.value = rolesRes.value.supported;
    portalRoles.value = rolesRes.value.roles ?? [];
  } else {
    // Portal feed unavailable — fall back to grant-derived roles.
    portalRolesSupported.value = false;
    portalRoles.value = [];
  }
}

async function loadInitial() {
  loading.value = true;
  error.value = null;
  try {
    await fetchState();
    remoteFingerprint = stateFingerprint();
    buildGraph();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load tool access';
  } finally {
    loading.value = false;
  }
}

async function poll() {
  if (loading.value) return;
  try {
    await fetchState();
    const fp = stateFingerprint();
    if (fp === remoteFingerprint) return;
    remoteFingerprint = fp;
    buildGraph(true);
  } catch {
    /* keep polling */
  }
}

onMounted(() => {
  void loadInitial();
  pollTimer = setInterval(() => { void poll(); }, 4_000);
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
          Role nodes mirror the portal's live role list. Super Admin / Admin / PRISM admins get all tools automatically.
          Edit roles and grants in the portal — changes appear here within a few seconds.
        </p>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <p v-else-if="!portalRolesSupported && hasRoles" class="muted warn-hint">
      Live portal role feed unavailable — showing roles derived from existing grants. Ask the portal team to implement
      <code>GET /portal/roles</code> so PRISM can mirror the current role list.
    </p>

    <p v-else-if="staleRoles.length" class="muted warn-hint">
      Removing stale role grant(s) for <strong>{{ staleRoles.join(', ') }}</strong> — not in the portal's current role list.
      They will disappear automatically on the next refresh.
    </p>

    <div v-if="loading" class="muted">Loading tool access…</div>

    <p v-else-if="!hasRoles" class="muted empty-hint">
      No portal roles found. Roles shown here mirror the portal exactly — PRISM does not invent any.
    </p>

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
.empty-hint { margin: 0; }
.warn-hint { margin: 0; font-size: 13px; color: var(--warning, #d97706); }
.warn-hint code { font-family: var(--mono, monospace); }
</style>
