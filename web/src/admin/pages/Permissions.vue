<script setup lang="ts">
/**
 * Node-based permissions editor — function policy graph (portal project grants
 * are read-only context; effective connector permissions = portal ∩ this graph).
 */
import { computed, onMounted, ref } from 'vue';
import { MarkerType, type Connection } from '@vue-flow/core';
import { RouterLink } from 'vue-router';
import Icon from '../../shared/Icon.vue';
import PolicyGraphBoard from '../components/permissions/PolicyGraphBoard.vue';
import PolicyInspector from '../components/permissions/PolicyInspector.vue';
import type { PolicyNodeData } from '../utils/policyGraphLayout';
import {
  policyColumnPosition,
  policyNodeTypeLabel,
  type PolicyFlowEdge,
  type PolicyFlowNode,
} from '../utils/policyGraphLayout';
import {
  permissionsApi,
  settingsApi,
  type ConnectorFunction,
  type PolicyEdge,
  type PolicyNode as PolicyNodeType,
} from '../../shared/api';

const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const defaultFunctions = ref<ConnectorFunction[]>([]);
const nodes = ref<PolicyFlowNode[]>([]);
const edges = ref<PolicyFlowEdge[]>([]);
const selectedNodeId = ref<string | null>(null);

const grantAllProjects = ref(true);
const savingAccess = ref(false);
const accessStatus = ref<string | null>(null);

const selectedNode = computed((): { id: string; data?: PolicyNodeData } | null => {
  if (!selectedNodeId.value) return null;
  for (const n of nodes.value) {
    if (n.id === selectedNodeId.value) return { id: n.id, data: n.data };
  }
  return null;
});

const functionOptions = permissionsApi.functionsList();

function toFlowNode(n: PolicyNodeType): PolicyFlowNode {
  return {
    id: n.id,
    type: 'policy',
    position: n.position,
    data: { policyType: n.type, label: n.label, refValue: n.ref ?? '' },
  };
}

async function saveAccessMode() {
  savingAccess.value = true;
  accessStatus.value = null;
  error.value = null;
  try {
    await settingsApi.set('workspace_grant_all_projects', grantAllProjects.value ? '1' : '0');
    accessStatus.value = grantAllProjects.value
      ? 'Blanket access on — every user can use all projects'
      : 'Blanket access off — users only get projects assigned on Users';
    setTimeout(() => (accessStatus.value = null), 3000);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to save access mode';
  } finally {
    savingAccess.value = false;
  }
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

onMounted(async () => {
  try {
    const s = (await settingsApi.list()).settings;
    grantAllProjects.value = s['workspace_grant_all_projects'] !== '0';
  } catch {
    // non-fatal — access mode controls just default to granular/contributor
  }
  try {
    const res = await permissionsApi.getPolicy();
    defaultFunctions.value = res.defaultFunctions;
    nodes.value = res.graph.nodes.map(toFlowNode);
    edges.value = res.graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      markerEnd: MarkerType.ArrowClosed,
      animated: true,
    }));
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load policy';
  } finally {
    loading.value = false;
  }
});

function addNode(type: PolicyNodeType['type']) {
  const id = `${type}-${Date.now()}`;
  const label = policyNodeTypeLabel(type);
  let indexInColumn = 0;
  for (const n of nodes.value) {
    if (n.data.policyType === type) indexInColumn += 1;
  }
  nodes.value.push({
    id,
    type: 'policy',
    position: policyColumnPosition(type, indexInColumn),
    data: { policyType: type, label, refValue: '' },
  });
}

function updateSelectedLabel(value: string) {
  const id = selectedNodeId.value;
  if (!id) return;
  for (const n of nodes.value) {
    if (n.id === id) {
      n.data = { ...n.data, label: value };
      break;
    }
  }
}

function updateSelectedRef(value: string) {
  const id = selectedNodeId.value;
  if (!id) return;
  for (const n of nodes.value) {
    if (n.id === id) {
      n.data = { ...n.data, refValue: value };
      break;
    }
  }
}

function deleteSelectedNode() {
  if (!selectedNodeId.value) return;
  const id = selectedNodeId.value;
  const nextNodes: PolicyFlowNode[] = [];
  for (const n of nodes.value) {
    if (n.id !== id) nextNodes.push(n);
  }
  nodes.value = nextNodes;
  const nextEdges: PolicyFlowEdge[] = [];
  for (const e of edges.value) {
    if (e.source !== id && e.target !== id) nextEdges.push(e);
  }
  edges.value = nextEdges;
  selectedNodeId.value = null;
}

async function savePolicy() {
  saving.value = true;
  error.value = null;
  try {
    const graphNodes: PolicyNodeType[] = [];
    for (const n of nodes.value) {
      graphNodes.push({
        id: n.id,
        type: n.data.policyType,
        label: n.data.label,
        ref: n.data.refValue || null,
        position: n.position,
      });
    }
    const graphEdges: PolicyEdge[] = [];
    for (const e of edges.value) {
      graphEdges.push({ id: e.id, source: e.source, target: e.target, grant: true });
    }
    const res = await permissionsApi.savePolicy({
      graph: { nodes: graphNodes, edges: graphEdges },
      defaultFunctions: defaultFunctions.value,
    });
    defaultFunctions.value = res.defaultFunctions;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Save failed';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>Permissions</h1>
        <p class="muted">
          Function policy graph — effective connector access = portal project grants ∩ grants defined here.
        </p>
      </div>
      <div class="toolbar">
        <button type="button" @click="addNode('role')"><Icon name="badge" :size="16" /> Role</button>
        <button type="button" @click="addNode('user')"><Icon name="person" :size="16" /> User</button>
        <button type="button" @click="addNode('project')"><Icon name="folder" :size="16" /> Project</button>
        <button type="button" @click="addNode('function')"><Icon name="bolt" :size="16" /> Function</button>
        <RouterLink :to="{ name: 'tool-access' }" class="link-btn"><Icon name="build" :size="16" /> Tool access</RouterLink>
        <button type="button" class="primary" :disabled="saving" @click="savePolicy">
          {{ saving ? 'Saving…' : 'Save policy' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <section class="access-mode">
      <div class="access-head">
        <div>
          <h2>Access mode</h2>
          <p class="muted">How ORBIT project access is granted to users who sign in via a connector.</p>
        </div>
        <label class="switch-row">
          <input type="checkbox" v-model="grantAllProjects" :disabled="savingAccess" @change="saveAccessMode" />
          <span>Blanket — every user can use all ORBIT projects</span>
        </label>
      </div>
      <p v-if="grantAllProjects" class="muted hint">
        On — every signed-in user gets full connector access (send, receive, create) to all ORBIT projects.
        Refine later by switching this off and assigning projects per user on the
        <RouterLink :to="{ name: 'users' }">Users</RouterLink> page.
      </p>
      <p v-else class="muted hint">
        Off — users only get the projects assigned on the
        <RouterLink :to="{ name: 'users' }">Users</RouterLink> page (users with none still get blanket access so they're not locked out).
      </p>
      <p v-if="accessStatus" class="ok">{{ accessStatus }}</p>
    </section>

    <div v-if="loading" class="muted">Loading policy…</div>

    <PolicyGraphBoard
      v-else
      v-model:nodes="nodes"
      v-model:edges="edges"
      v-model:selected-node-id="selectedNodeId"
      @connect="onConnect"
    >
      <template #inspector>
        <PolicyInspector
          :node="selectedNode"
          @update-label="updateSelectedLabel"
          @update-ref="updateSelectedRef"
          @delete-node="deleteSelectedNode"
        />
      </template>
    </PolicyGraphBoard>

    <section class="defaults">
      <h2>Default functions</h2>
      <p class="muted">Applied when no graph edge matches. Set node ref in the inspector (email, role level, project id, function id).</p>
      <div class="fn-grid">
        <label v-for="fn in functionOptions" :key="fn" class="fn-check">
          <input v-model="defaultFunctions" type="checkbox" :value="fn" />
          {{ fn }}
        </label>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; height: 100%; }
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.link-btn { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; text-decoration: none; }
.defaults { padding: 12px 0; }
.fn-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; margin-top: 8px; }
.fn-check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.error { color: var(--danger, #ef4444); }
.ok { color: var(--success, #16a34a); font-size: 13px; margin: 4px 0 0; }
.access-mode { border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--surface, transparent); }
.access-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.access-head h2 { margin: 0 0 2px; font-size: 15px; }
.access-head .muted { margin: 0; }
.switch-row { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; white-space: nowrap; }
</style>
