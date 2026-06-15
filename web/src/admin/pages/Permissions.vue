<script setup lang="ts">
/**
 * Node-based permissions editor — function policy graph (portal project grants
 * are read-only context; effective connector permissions = portal ∩ this graph).
 */
import { onMounted, ref } from 'vue';
import {
  VueFlow,
  MarkerType,
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
import {
  permissionsApi,
  type ConnectorFunction,
  type PolicyEdge,
  type PolicyNode as PolicyNodeType,
} from '../../shared/api';

const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const defaultFunctions = ref<ConnectorFunction[]>([]);
const nodes = ref<Node[]>([]);
const edges = ref<Edge[]>([]);

function onConnect(conn: Connection) {
  edges.value.push({
    id: `e-${conn.source}-${conn.target}`,
    source: conn.source!,
    target: conn.target!,
    markerEnd: MarkerType.ArrowClosed,
    animated: true,
  });
}

const functionOptions = permissionsApi.functionsList();

function nodeLabel(n: PolicyNodeType) {
  const ref = n.ref ? ` (${n.ref})` : '';
  return `[${n.type}] ${n.label}${ref}`;
}

onMounted(async () => {
  try {
    const res = await permissionsApi.getPolicy();
    defaultFunctions.value = res.defaultFunctions;
    nodes.value = res.graph.nodes.map((n) => ({
      id: n.id,
      label: nodeLabel(n),
      position: n.position,
      data: { policyType: n.type, label: n.label, refValue: n.ref },
    }));
    edges.value = res.graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      markerEnd: MarkerType.ArrowClosed,
    }));
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load policy';
  } finally {
    loading.value = false;
  }
});

function addNode(type: PolicyNodeType['type']) {
  const id = `${type}-${Date.now()}`;
  const label = type === 'role' ? 'Role' : type === 'user' ? 'User' : type === 'project' ? 'Project' : 'Function';
  const node: PolicyNodeType = { id, type, label, ref: null, position: { x: 120 + nodes.value.length * 40, y: 120 + nodes.value.length * 32 } };
  nodes.value.push({
    id,
    label: nodeLabel(node),
    position: node.position,
    data: { policyType: type, label, refValue: '' },
  });
}

async function savePolicy() {
  saving.value = true;
  error.value = null;
  try {
    const graphNodes: PolicyNodeType[] = [];
    for (const n of nodes.value) {
      graphNodes.push({
        id: n.id,
        type: (n.data?.policyType as PolicyNodeType['type']) ?? 'role',
        label: String(n.data?.label ?? n.id),
        ref: (n.data?.refValue as string) || null,
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
        <button type="button" class="primary" :disabled="saving" @click="savePolicy">
          {{ saving ? 'Saving…' : 'Save policy' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="loading" class="muted">Loading policy…</div>

    <div v-else class="graph-wrap">
      <VueFlow
        v-model:nodes="nodes"
        v-model:edges="edges"
        fit-view-on-init
        :default-edge-options="{ markerEnd: MarkerType.ArrowClosed }"
        @connect="onConnect"
      >
        <Background />
        <Controls />
      </VueFlow>
    </div>

    <section class="defaults">
      <h2>Default functions</h2>
      <p class="muted">Applied when no graph edge matches. Set node <code>ref</code> in saved policy JSON (email, role level, project id, function id).</p>
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
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
.graph-wrap { flex: 1; min-height: 420px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.defaults { padding: 12px 0; }
.fn-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; margin-top: 8px; }
.fn-check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.error { color: var(--danger, #ef4444); }
</style>
