<script setup lang="ts">
/**
 * Permissions — Connector Light guest access graph.
 *
 * Guests (invite keys) on the left, ORBIT projects on the right.
 * Draw edges guest → project to grant access. Right-click a guest for
 * functions / target / redemptions / expiry and a project checkbox tree.
 *
 * Tool access (portal roles → PRISM tools) lives at /permissions/tools.
 */
import { computed, onMounted, ref } from 'vue';
import { MarkerType, type Connection } from '@vue-flow/core';
import { RouterLink } from 'vue-router';
import Icon from '../../shared/Icon.vue';
import PolicyGraphBoard from '../components/permissions/PolicyGraphBoard.vue';
import PolicyInspector from '../components/permissions/PolicyInspector.vue';
import GuestPropertiesDialog, {
  type GuestPropertiesModel,
} from '../components/permissions/GuestPropertiesDialog.vue';
import ConnectorPanelPreview from '../components/permissions/ConnectorPanelPreview.vue';
import {
  LIGHT_CONNECTOR_FUNCTIONS,
  accessApi,
  orbitApi,
  settingsApi,
  type ApiError,
  type ConnectorFunction,
  type InviteKeyRecord,
  type OrbitProject,
} from '../../shared/api';
import type { GuestInviteNodeMeta, PolicyFlowEdge, PolicyFlowNode } from '../utils/policyGraphLayout';

const GUEST_COLUMN_X = 80;
const PROJECT_COLUMN_X = 520;
const ROW_Y = 72;
const START_Y = 80;

const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const status = ref<string | null>(null);

const grantAllProjects = ref(true);
const savingAccess = ref(false);
const accessStatus = ref<string | null>(null);

const orbitTarget = ref<'prod' | 'dev'>('prod');
const orbitProjects = ref<OrbitProject[]>([]);
const nodes = ref<PolicyFlowNode[]>([]);
const edges = ref<PolicyFlowEdge[]>([]);
const selectedNodeId = ref<string | null>(null);

const dialogOpen = ref(false);
const dialogModel = ref<GuestPropertiesModel | null>(null);
const dialogGuestNodeId = ref<string | null>(null);
const mintedKey = ref<string | null>(null);
const mintedRedeemUrl = ref<string | null>(null);

const columnLabels = [
  { type: 'user' as const, label: 'Guests' },
  { type: 'project' as const, label: 'Projects' },
];

const selectedNode = computed(() => {
  const id = selectedNodeId.value;
  if (!id) return null;
  for (const n of nodes.value) {
    if (n.id === id) return { id: n.id, data: n.data };
  }
  return null;
});

const selectedIsGuest = computed(() => !!selectedNode.value?.data?.guest);

const selectedGuestFunctions = computed<ConnectorFunction[]>(() => {
  const fns = selectedNode.value?.data?.guestMeta?.allowedFunctions;
  return Array.isArray(fns) ? [...fns] : [];
});

function projectNodeId(projectId: string): string {
  return `project-${projectId}`;
}

function guestNodeId(keyId: string): string {
  return `guest-${keyId}`;
}

function projectIdsForGuest(nodeId: string): string[] {
  const ids: string[] = [];
  for (const e of edges.value) {
    if (e.source !== nodeId) continue;
    const n = nodes.value.find((x) => x.id === e.target);
    if (n?.data.policyType === 'project' && n.data.refValue) ids.push(n.data.refValue);
  }
  return ids;
}

function buildProjectNames(ids: string[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const id of ids) {
    const p = orbitProjects.value.find((x) => x.id === id);
    if (p?.name?.trim()) names[id] = p.name.trim();
  }
  return names;
}

function layoutGuestY(index: number): number {
  return START_Y + index * ROW_Y;
}

function layoutProjectY(index: number): number {
  return START_Y + index * ROW_Y;
}

function guestMetaFromKey(key: InviteKeyRecord): GuestInviteNodeMeta {
  return {
    inviteKeyId: key.id,
    orbitTarget: key.orbitTarget,
    allowedFunctions: [...key.allowedFunctions],
    maxRedemptions: key.maxRedemptions ?? null,
    expiresAt: key.expiresAt ?? null,
    redemptionCount: key.redemptionCount,
    revoked: !!key.revokedAt,
    dirty: false,
    modelAccess: key.modelAccess ?? 'all',
    selectedModelIds: [...(key.selectedModelIds ?? [])],
  };
}

function rebuildGraph(keys: InviteKeyRecord[], projects: OrbitProject[], preservePositions = false) {
  const posById = preservePositions
    ? new Map(nodes.value.map((n) => [n.id, { ...n.position }]))
    : null;

  const nextNodes: PolicyFlowNode[] = [];
  const nextEdges: PolicyFlowEdge[] = [];

  const activeKeys = keys.filter((k) => !k.revokedAt);
  activeKeys.forEach((key, i) => {
    const id = guestNodeId(key.id);
    nextNodes.push({
      id,
      type: 'policy',
      position: posById?.get(id) ?? { x: GUEST_COLUMN_X, y: layoutGuestY(i) },
      data: {
        policyType: 'user',
        label: key.label?.trim() || 'Guest',
        refValue: key.id,
        guest: true,
        noTarget: true,
        guestMeta: guestMetaFromKey(key),
      },
    });
  });

  // Keep draft guests that aren't saved yet.
  for (const n of nodes.value) {
    if (!n.data.guest || n.data.guestMeta?.inviteKeyId) continue;
    if (nextNodes.some((x) => x.id === n.id)) continue;
    nextNodes.push({
      ...n,
      position: posById?.get(n.id) ?? n.position,
    });
  }

  projects.forEach((p, i) => {
    const id = projectNodeId(p.id);
    nextNodes.push({
      id,
      type: 'policy',
      position: posById?.get(id) ?? { x: PROJECT_COLUMN_X, y: layoutProjectY(i) },
      data: {
        policyType: 'project',
        label: p.name?.trim() || p.id,
        refValue: p.id,
        noSource: true,
      },
    });
  });

  // Ensure projects referenced by keys exist even if missing from the ORBIT list.
  for (const key of activeKeys) {
    for (const proj of key.projects) {
      const id = projectNodeId(proj.orbitProjectId);
      if (nextNodes.some((n) => n.id === id)) continue;
      nextNodes.push({
        id,
        type: 'policy',
        position: posById?.get(id) ?? {
          x: PROJECT_COLUMN_X,
          y: layoutProjectY(nextNodes.filter((n) => n.data.policyType === 'project').length),
        },
        data: {
          policyType: 'project',
          label: proj.projectName?.trim() || proj.orbitProjectId,
          refValue: proj.orbitProjectId,
          noSource: true,
        },
      });
    }
  }

  for (const key of activeKeys) {
    const source = guestNodeId(key.id);
    for (const proj of key.projects) {
      const target = projectNodeId(proj.orbitProjectId);
      nextEdges.push({
        id: `e-${source}-${target}`,
        source,
        target,
        markerEnd: MarkerType.ArrowClosed,
        animated: true,
      });
    }
  }

  // Preserve draft guest edges.
  for (const e of edges.value) {
    const src = nextNodes.find((n) => n.id === e.source);
    if (!src?.data.guest || src.data.guestMeta?.inviteKeyId) continue;
    if (!nextNodes.some((n) => n.id === e.target)) continue;
    if (nextEdges.some((x) => x.id === e.id)) continue;
    nextEdges.push(e);
  }

  nodes.value = nextNodes;
  edges.value = nextEdges;
}

async function loadOrbitProjects() {
  try {
    const res = await orbitApi.projects(orbitTarget.value, 500);
    orbitProjects.value = res.items;
  } catch {
    orbitProjects.value = [];
  }
}

async function refresh(preservePositions = false) {
  loading.value = true;
  error.value = null;
  try {
    await loadOrbitProjects();
    const { keys } = await accessApi.listInviteKeys();
    rebuildGraph(keys, orbitProjects.value, preservePositions);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Failed to load guest access';
    if ((err as ApiError).status === 404) {
      error.value =
        'Invite-keys API not found on the permissions service. Deploy the latest prism-permissions-service (invite-keys routes), then Refresh.';
    }
  } finally {
    loading.value = false;
  }
}

async function saveAccessMode() {
  savingAccess.value = true;
  accessStatus.value = null;
  error.value = null;
  try {
    await settingsApi.set('workspace_grant_all_projects', grantAllProjects.value ? '1' : '0');
    accessStatus.value = grantAllProjects.value
      ? 'Blanket access on — every signed-in user can use all projects'
      : 'Blanket access off — users only get projects assigned on Users';
    setTimeout(() => (accessStatus.value = null), 3000);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to save access mode';
  } finally {
    savingAccess.value = false;
  }
}

async function onTargetChange() {
  await loadOrbitProjects();
  try {
    const { keys } = await accessApi.listInviteKeys();
    rebuildGraph(keys, orbitProjects.value, true);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Failed to reload projects';
  }
}

function openGuestDialog(nodeId: string) {
  const node = nodes.value.find((n) => n.id === nodeId);
  if (!node?.data.guest || !node.data.guestMeta) return;
  dialogGuestNodeId.value = nodeId;
  dialogModel.value = {
    label: node.data.label,
    projectIds: projectIdsForGuest(nodeId),
    meta: { ...node.data.guestMeta },
  };
  mintedKey.value = node.data.guestMeta.plaintextKey ?? null;
  mintedRedeemUrl.value = node.data.guestMeta.redeemUrl ?? null;
  dialogOpen.value = true;
}

function addGuest() {
  const draftId = `guest-draft-${Date.now()}`;
  let guestCount = 0;
  for (const n of nodes.value) {
    if (n.data.guest) guestCount += 1;
  }
  nodes.value = [
    ...nodes.value,
    {
      id: draftId,
      type: 'policy',
      position: { x: GUEST_COLUMN_X, y: layoutGuestY(guestCount) },
      data: {
        policyType: 'user',
        label: 'New guest',
        refValue: '',
        guest: true,
        noTarget: true,
        guestMeta: {
          inviteKeyId: null,
          orbitTarget: orbitTarget.value,
          allowedFunctions: [...LIGHT_CONNECTOR_FUNCTIONS],
          maxRedemptions: null,
          expiresAt: null,
          redemptionCount: 0,
          dirty: true,
          modelAccess: 'all',
          selectedModelIds: [],
        },
      },
    },
  ];
  selectedNodeId.value = draftId;
  openGuestDialog(draftId);
}

function syncEdgesToProjects(guestId: string, projectIds: string[]) {
  const keep: PolicyFlowEdge[] = [];
  for (const e of edges.value) {
    if (e.source !== guestId) keep.push(e);
  }
  for (const pid of projectIds) {
    const target = projectNodeId(pid);
    if (!nodes.value.some((n) => n.id === target)) {
      // Add missing project node from known list or as orphan.
      const p = orbitProjects.value.find((x) => x.id === pid);
      nodes.value = [
        ...nodes.value,
        {
          id: target,
          type: 'policy',
          position: {
            x: PROJECT_COLUMN_X,
            y: layoutProjectY(nodes.value.filter((n) => n.data.policyType === 'project').length),
          },
          data: {
            policyType: 'project',
            label: p?.name?.trim() || pid,
            refValue: pid,
            noSource: true,
          },
        },
      ];
    }
    keep.push({
      id: `e-${guestId}-${target}`,
      source: guestId,
      target,
      markerEnd: MarkerType.ArrowClosed,
      animated: true,
    });
  }
  edges.value = keep;
}

function onConnect(conn: Connection) {
  const source = conn.source!;
  const target = conn.target!;
  const src = nodes.value.find((n) => n.id === source);
  const tgt = nodes.value.find((n) => n.id === target);
  if (!src?.data.guest || tgt?.data.policyType !== 'project') {
    error.value = 'Connect a guest to a project (left → right).';
    return;
  }
  if (src.data.guestMeta?.revoked) {
    error.value = 'Revoked guests cannot gain projects.';
    return;
  }
  const id = `e-${source}-${target}`;
  if (edges.value.some((e) => e.id === id)) return;
  edges.value = [
    ...edges.value,
    { id, source, target, markerEnd: MarkerType.ArrowClosed, animated: true },
  ];
  // Mark dirty and open properties so they can save.
  for (const n of nodes.value) {
    if (n.id !== source || !n.data.guestMeta) continue;
    n.data = {
      ...n.data,
      guestMeta: { ...n.data.guestMeta, dirty: true },
    };
    break;
  }
  status.value = 'Project linked — right-click the guest and Save to apply.';
  setTimeout(() => (status.value = null), 4000);
}

function onEdgeDelete(edgeId: string) {
  const edge = edges.value.find((e) => e.id === edgeId);
  edges.value = edges.value.filter((e) => e.id !== edgeId);
  if (!edge) return;
  for (const n of nodes.value) {
    if (n.id !== edge.source || !n.data.guestMeta) continue;
    n.data = {
      ...n.data,
      guestMeta: { ...n.data.guestMeta, dirty: true },
    };
    break;
  }
  status.value = 'Project unlinked — right-click the guest and Save to apply.';
  setTimeout(() => (status.value = null), 4000);
}

function onNodeContextMenu(payload: { nodeId: string }) {
  const node = nodes.value.find((n) => n.id === payload.nodeId);
  if (node?.data.guest) openGuestDialog(payload.nodeId);
}

function closeDialog() {
  dialogOpen.value = false;
  dialogModel.value = null;
  dialogGuestNodeId.value = null;
}

async function saveGuestFromDialog(model: GuestPropertiesModel) {
  const nodeId = dialogGuestNodeId.value;
  if (!nodeId) return;
  saving.value = true;
  error.value = null;
  try {
    const projectNames = buildProjectNames(model.projectIds);
    const existingId = model.meta.inviteKeyId;

    if (!existingId) {
      const created = await accessApi.createInviteKey({
        label: model.label,
        orbitTarget: model.meta.orbitTarget,
        orbitProjectIds: model.projectIds,
        projectNames,
        allowedFunctions: model.meta.allowedFunctions,
        maxRedemptions: model.meta.maxRedemptions ?? null,
        expiresAt: model.meta.expiresAt ?? null,
        modelAccess: model.meta.modelAccess ?? 'all',
        selectedModelIds:
          (model.meta.modelAccess ?? 'all') === 'selected'
            ? [...(model.meta.selectedModelIds ?? [])]
            : [],
      });
      mintedKey.value = created.key;
      mintedRedeemUrl.value = created.redeemUrl;
      // Replace draft node id with stable guest-<id>
      const newId = guestNodeId(created.id);
      const createdMeta: GuestInviteNodeMeta = {
        inviteKeyId: created.id,
        orbitTarget: model.meta.orbitTarget,
        allowedFunctions: [...created.allowedFunctions],
        maxRedemptions: created.maxRedemptions ?? null,
        expiresAt: created.expiresAt ?? null,
        redemptionCount: 0,
        dirty: false,
        plaintextKey: created.key,
        redeemUrl: created.redeemUrl,
        modelAccess: created.modelAccess ?? model.meta.modelAccess ?? 'all',
        selectedModelIds: [...(created.selectedModelIds ?? model.meta.selectedModelIds ?? [])],
      };
      nodes.value = nodes.value.map((n) => {
        if (n.id !== nodeId) return n;
        return {
          ...n,
          id: newId,
          data: {
            ...n.data,
            label: created.label?.trim() || model.label,
            refValue: created.id,
            guestMeta: createdMeta,
          },
        };
      });
      edges.value = edges.value.map((e) => {
        if (e.source !== nodeId) return e;
        const target = e.target;
        return {
          ...e,
          id: `e-${newId}-${target}`,
          source: newId,
        };
      });
      syncEdgesToProjects(newId, model.projectIds);
      dialogGuestNodeId.value = newId;
      selectedNodeId.value = newId;
      dialogModel.value = {
        label: created.label?.trim() || model.label,
        projectIds: model.projectIds,
        meta: createdMeta,
      };
      status.value = 'Guest key created — copy the plaintext key now.';
    } else {
      try {
        await accessApi.updateInviteKey(existingId, {
          label: model.label,
          orbitProjectIds: model.projectIds,
          projectNames,
          allowedFunctions: model.meta.allowedFunctions,
          maxRedemptions: model.meta.maxRedemptions ?? null,
          expiresAt: model.meta.expiresAt ?? null,
          modelAccess: model.meta.modelAccess ?? 'all',
          selectedModelIds:
            (model.meta.modelAccess ?? 'all') === 'selected'
              ? [...(model.meta.selectedModelIds ?? [])]
              : [],
        });
      } catch (err) {
        const apiErr = err as ApiError;
        if (apiErr.status === 404 || apiErr.status === 405) {
          throw new Error(
            'Updating guests requires permissions-service PATCH /api/access/invite-keys/:id. Apply the scaffold patch and redeploy, or revoke and create a new key.',
          );
        }
        throw err;
      }
      for (const n of nodes.value) {
        if (n.id !== nodeId) continue;
        n.data = {
          ...n.data,
          label: model.label,
          guestMeta: { ...model.meta, dirty: false },
        };
        break;
      }
      syncEdgesToProjects(nodeId, model.projectIds);
      closeDialog();
      status.value = 'Guest updated.';
    }
    setTimeout(() => (status.value = null), 4000);
  } catch (err) {
    error.value = err instanceof Error ? err.message : (err as ApiError).message ?? 'Save failed';
  } finally {
    saving.value = false;
  }
}

async function revokeGuestFromDialog() {
  const nodeId = dialogGuestNodeId.value;
  const model = dialogModel.value;
  if (!nodeId || !model?.meta.inviteKeyId) return;
  if (!confirm(`Revoke guest "${model.label}"? This ends all Connector Light sessions using this key.`)) return;
  saving.value = true;
  error.value = null;
  try {
    await accessApi.revokeInviteKey(model.meta.inviteKeyId);
    nodes.value = nodes.value.filter((n) => n.id !== nodeId);
    edges.value = edges.value.filter((e) => e.source !== nodeId && e.target !== nodeId);
    closeDialog();
    status.value = 'Guest key revoked.';
    setTimeout(() => (status.value = null), 3000);
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Revoke failed';
  } finally {
    saving.value = false;
  }
}

function deleteSelectedGuest() {
  const node = selectedNode.value;
  if (!node?.data?.guest) return;
  if (node.data.guestMeta?.inviteKeyId) {
    dialogGuestNodeId.value = node.id;
    dialogModel.value = {
      label: node.data.label,
      projectIds: projectIdsForGuest(node.id),
      meta: { ...node.data.guestMeta! },
    };
    void revokeGuestFromDialog();
    return;
  }
  // Unsaved draft — just remove.
  nodes.value = nodes.value.filter((n) => n.id !== node.id);
  edges.value = edges.value.filter((e) => e.source !== node.id && e.target !== node.id);
  selectedNodeId.value = null;
}

onMounted(async () => {
  try {
    const s = (await settingsApi.list()).settings;
    grantAllProjects.value = s['workspace_grant_all_projects'] !== '0';
  } catch {
    /* non-fatal */
  }
  await refresh();
});
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>Permissions</h1>
        <p class="muted">
          Guest access for Connector Light — add guests, draw lines to ORBIT projects, right-click a guest for properties.
          Portal role → PRISM tool grants live under
          <RouterLink :to="{ name: 'tool-access' }">Tool access</RouterLink>.
        </p>
      </div>
      <div class="toolbar">
        <label class="target-pick">
          Projects from
          <select v-model="orbitTarget" @change="onTargetChange">
            <option value="prod">prod</option>
            <option value="dev">dev</option>
          </select>
        </label>
        <button type="button" :disabled="loading" @click="refresh(true)">
          <Icon name="refresh" :size="16" /> Refresh
        </button>
        <button type="button" class="primary" :disabled="loading" @click="addGuest">
          <Icon name="person_add" :size="16" /> Add guest
        </button>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="status" class="ok">{{ status }}</p>

    <section class="access-mode">
      <div class="access-head">
        <div>
          <h2>Access mode</h2>
          <p class="muted">How ORBIT project access is granted to users who sign in via a connector (portal / Google).</p>
        </div>
        <label class="switch-row">
          <input type="checkbox" v-model="grantAllProjects" :disabled="savingAccess" @change="saveAccessMode" />
          <span>Blanket — every user can use all ORBIT projects</span>
        </label>
      </div>
      <p v-if="grantAllProjects" class="muted hint">
        On — every signed-in user gets full connector access to all ORBIT projects.
        Guests below are always project-scoped (never blanket).
      </p>
      <p v-else class="muted hint">
        Off — portal users only get projects assigned on
        <RouterLink :to="{ name: 'users' }">Users</RouterLink>.
        Guests still use the graph below.
      </p>
      <p v-if="accessStatus" class="ok">{{ accessStatus }}</p>
    </section>

    <div v-if="loading" class="muted">Loading guest access…</div>

    <PolicyGraphBoard
      v-else
      v-model:nodes="nodes"
      v-model:edges="edges"
      v-model:selected-node-id="selectedNodeId"
      legend-title="Guest access"
      :column-labels="columnLabels"
      @connect="onConnect"
      @node-contextmenu="onNodeContextMenu"
      @edge-delete="onEdgeDelete"
    >
      <template #inspector>
        <aside class="side-help">
          <PolicyInspector
            v-if="selectedNode && !selectedIsGuest"
            :node="selectedNode"
            readonly
          />
          <div v-else-if="selectedIsGuest" class="guest-hint">
            <h3>{{ selectedNode?.data?.label }}</h3>
            <p class="muted">
              Right-click to edit functions, target, redemptions, expiry, and project access.
              Drag from this guest to a project to grant access; double-click an edge to remove it.
            </p>
            <ConnectorPanelPreview
              compact
              :allowed-functions="selectedGuestFunctions"
            />
            <div class="btn-col">
              <button type="button" class="primary" @click="openGuestDialog(selectedNodeId!)">
                <Icon name="tune" :size="16" /> Properties
              </button>
              <button type="button" class="danger-btn" @click="deleteSelectedGuest">
                <Icon name="delete" :size="16" />
                {{ selectedNode?.data?.guestMeta?.inviteKeyId ? 'Revoke' : 'Remove draft' }}
              </button>
            </div>
          </div>
          <div v-else class="guest-hint empty">
            <Icon name="ads_click" :size="22" />
            <p class="muted">
              Select a guest or project. Add a guest, then draw lines to projects.
              Right-click a guest for the properties dialog.
            </p>
          </div>
        </aside>
      </template>
    </PolicyGraphBoard>

    <GuestPropertiesDialog
      :open="dialogOpen"
      :model="dialogModel"
      :projects="orbitProjects"
      :saving="saving"
      :minted-key="mintedKey"
      :minted-redeem-url="mintedRedeemUrl"
      @close="closeDialog"
      @save="saveGuestFromDialog"
      @revoke="revokeGuestFromDialog"
    />
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; height: 100%; }
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.target-pick { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; }
.error { color: var(--danger, #ef4444); margin: 0; }
.ok { color: var(--success, #16a34a); font-size: 13px; margin: 0; }
.access-mode { border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--surface, transparent); }
.access-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.access-head h2 { margin: 0 0 2px; font-size: 15px; }
.access-head .muted { margin: 0; }
.switch-row { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; white-space: nowrap; }
.hint { margin: 8px 0 0; font-size: 13px; }
.side-help {
  flex: 0 0 300px;
  width: 300px;
  align-self: stretch;
}
.side-help :deep(.policy-inspector) {
  width: 100%;
  flex: 1;
  height: 100%;
}
.guest-hint {
  height: 100%;
  min-height: 200px;
  border: 1px solid var(--color-border, var(--border));
  border-radius: var(--radius-lg, 8px);
  background: var(--color-bg-elevated, var(--surface, transparent));
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.guest-hint.empty {
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--color-text-muted);
}
.guest-hint h3 { margin: 0; font-size: 15px; }
.guest-hint .muted { margin: 0; font-size: 13px; }
.btn-col { display: flex; flex-direction: column; gap: 8px; margin-top: auto; }
.danger-btn { color: var(--danger, #ef4444); }
</style>
