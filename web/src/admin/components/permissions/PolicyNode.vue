<script setup lang="ts">
import { computed } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import Icon from '../../../shared/Icon.vue';
import type { PolicyNodeType } from '../../../shared/api';
import type { PolicyNodeData } from '../../utils/policyGraphLayout';

const NODE_META: Record<PolicyNodeType, { icon: string; accent: string; kind: string }> = {
  role: { icon: 'badge', accent: '#6366f1', kind: 'Role' },
  user: { icon: 'person', accent: '#22c55e', kind: 'User' },
  project: { icon: 'folder', accent: '#f59e0b', kind: 'Project' },
  function: { icon: 'bolt', accent: '#ec4899', kind: 'Function' },
  tool: { icon: 'build', accent: '#3b82f6', kind: 'Tool' },
};

const props = defineProps<{ data: PolicyNodeData }>();

const meta = computed(() => {
  if (props.data.guest) {
    return { icon: 'person_outline', accent: '#0d9488', kind: 'Guest' };
  }
  return NODE_META[props.data.policyType] ?? NODE_META.role;
});
const accent = computed(() => {
  if (props.data.guestMeta?.revoked) return '#ef4444';
  if (props.data.stale) return '#ef4444';
  return meta.value.accent;
});
const subtitle = computed(() => {
  if (props.data.guest) {
    const t = props.data.guestMeta?.orbitTarget ?? 'prod';
    const dirty = props.data.guestMeta?.dirty ? ' · unsaved' : '';
    return `${t}${dirty}`;
  }
  return props.data.refValue?.trim() || meta.value.kind;
});
const kindLabel = computed(() => {
  if (props.data.guestMeta?.revoked) return 'Revoked';
  if (props.data.guestMeta?.dirty) return 'Draft';
  return meta.value.kind;
});
</script>

<template>
  <div
    class="policy-node node-drag-handle"
    :class="{
      'policy-node--stale': data.stale || data.guestMeta?.revoked,
      'policy-node--guest': data.guest,
    }"
    :style="{ '--accent': accent }"
  >
    <Handle v-if="!data.noTarget" type="target" :position="Position.Left" />
    <Handle v-if="!data.noSource" type="source" :position="Position.Right" />

    <span class="policy-node__icon">
      <Icon :name="meta.icon" :size="16" />
    </span>
    <span class="policy-node__titles">
      <span class="policy-node__label">{{ data.label }}</span>
      <span class="policy-node__sub">{{ subtitle }}</span>
    </span>
    <span
      v-if="data.stale"
      class="policy-node__kind policy-node__kind--stale"
      title="This role has grants but is no longer in the portal's role list"
    >Stale</span>
    <span v-else class="policy-node__kind">{{ kindLabel }}</span>
  </div>
</template>

<style scoped>
.policy-node {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 220px;
  padding: 8px 10px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  font-size: 12px;
  cursor: grab;
}

.policy-node:active {
  cursor: grabbing;
}

.policy-node__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent);
  flex: 0 0 auto;
}

.policy-node__titles {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.policy-node__label {
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.policy-node__sub {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.policy-node__kind {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  padding: 2px 7px;
  border-radius: 9px;
}

.policy-node--stale {
  border-style: dashed;
}

.policy-node__kind--stale {
  color: #ef4444;
  background: color-mix(in srgb, #ef4444 14%, transparent);
}
</style>
