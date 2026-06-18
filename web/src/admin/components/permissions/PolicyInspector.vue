<script setup lang="ts">
import Icon from '../../../shared/Icon.vue';
import type { PolicyNodeData } from '../../utils/policyGraphLayout';
import type { PolicyNodeType } from '../../../shared/api';
import { policyNodeTypeLabel } from '../../utils/policyGraphLayout';

export interface PolicyInspectorNode {
  id: string;
  data?: PolicyNodeData;
}

defineProps<{
  node: PolicyInspectorNode | null;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  updateLabel: [value: string];
  updateRef: [value: string];
  deleteNode: [];
}>();

const REF_HINTS: Record<PolicyNodeType, string> = {
  role: 'Portal role id (e.g. staff, viewer, customRoleId)',
  user: 'User email address',
  project: 'ORBIT project id',
  function: 'Connector function id (send, receive, …)',
  tool: 'PRISM tool id (convert, visualiser, …)',
};
</script>

<template>
  <aside class="policy-inspector">
    <div v-if="!node" class="policy-inspector__empty">
      <Icon name="ads_click" :size="22" />
      <p>{{ readonly ? 'Select a node to view its details.' : 'Select a node to edit its label and ref, or drag between columns to wire grants.' }}</p>
    </div>

    <template v-else>
      <header
        class="policy-inspector__head"
        :class="`policy-inspector__head--${String(node.data?.policyType ?? 'role')}`"
      >
        <h2>{{ policyNodeTypeLabel(node.data?.policyType as PolicyNodeType) }}</h2>
        <span class="policy-inspector__id">{{ node.id }}</span>
      </header>

      <div class="policy-inspector__body">
        <template v-if="readonly">
          <dl class="policy-inspector__ro">
            <dt>Label</dt>
            <dd>{{ node.data?.label ?? '—' }}</dd>
            <dt>Ref</dt>
            <dd>{{ node.data?.refValue?.trim() || '—' }}</dd>
          </dl>
        </template>
        <template v-else>
          <label>
            Label
            <input
              :value="String(node.data?.label ?? '')"
              @input="emit('updateLabel', ($event.target as HTMLInputElement).value)"
            />
          </label>

          <label>
            Ref
            <input
              :value="String(node.data?.refValue ?? '')"
              placeholder="Identifier matched at runtime"
              @input="emit('updateRef', ($event.target as HTMLInputElement).value)"
            />
          </label>

          <button type="button" class="danger-btn" @click="emit('deleteNode')">
            <Icon name="delete" :size="16" /> Remove node
          </button>
        </template>

        <p class="policy-inspector__hint muted">
          {{ REF_HINTS[(node.data?.policyType as PolicyNodeType) ?? 'role'] }}
        </p>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.policy-inspector {
  flex: 0 0 280px;
  width: 280px;
  align-self: stretch;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-elevated);
  overflow-y: auto;
}

.policy-inspector__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  min-height: 200px;
  padding: 24px;
  color: var(--color-text-muted);
  text-align: center;
  font-size: 13px;
}

.policy-inspector__head {
  padding: 14px;
  border-bottom: 1px solid var(--color-border);
  border-left: 3px solid var(--orbit-primary);
}

.policy-inspector__head--role { border-left-color: #6366f1; }
.policy-inspector__head--user { border-left-color: #22c55e; }
.policy-inspector__head--project { border-left-color: #f59e0b; }
.policy-inspector__head--function { border-left-color: #ec4899; }
.policy-inspector__head--tool { border-left-color: #3b82f6; }

.policy-inspector__head h2 {
  margin: 0;
  font-size: 15px;
}

.policy-inspector__id {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  font-family: var(--mono, monospace);
  color: var(--color-text-muted);
  word-break: break-all;
}

.policy-inspector__body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.policy-inspector__body label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}

.policy-inspector__body input {
  font-weight: 400;
}

.policy-inspector__ro {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.policy-inspector__ro dt {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
}

.policy-inspector__ro dd {
  margin: 0 0 4px;
  font-size: 13px;
  font-family: var(--mono, monospace);
  word-break: break-all;
}

.policy-inspector__hint {
  font-size: 12px;
  margin: 0;
}

.danger-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 4px;
  color: var(--danger, #ef4444);
  border-color: color-mix(in srgb, var(--danger, #ef4444) 35%, var(--color-border));
}
</style>
