<script setup lang="ts">
/**
 * One node in the fixture construction graph (Construction tab).
 *
 * Nodes are compact (icon + title + optional badge). Clicking a node selects it;
 * its parameters/values (and a 3D preview for Model nodes) are shown in the
 * inspector panel on the right of the graph rather than expanding inline.
 */
import { Handle, Position } from '@vue-flow/core';
import Icon from '../../shared/Icon.vue';
import type { FixturePart, FixtureModel } from '../../shared/api';

export interface GraphParam {
  label: string;
  value: string;
}

export interface GraphModelPreview {
  fixtureId: string;
  parts: FixturePart[];
  models: FixtureModel[];
}

export interface FixtureGraphNodeData {
  kind:
    | 'gdtf'
    | 'fixture'
    | 'category'
    | 'info'
    | 'part'
    | 'model'
    | 'beam'
    | 'motion'
    | 'cell'
    | 'dmxmode'
    | 'clamp'
    | 'origin';
  title: string;
  subtitle?: string;
  icon: string;
  badge?: string | number;
  accent?: string;
  params?: GraphParam[];
  modelPreview?: GraphModelPreview | null;
  /** Hide the left target handle (graph roots). */
  noTarget?: boolean;
  /** Hide the right source handle (leaf nodes). */
  noSource?: boolean;
}

const props = defineProps<{ data: FixtureGraphNodeData }>();
const accent = props.data.accent ?? 'var(--orbit-primary)';
</script>

<template>
  <div class="fg-node node-drag-handle" :class="`kind-${data.kind}`" :style="{ '--accent': accent }">
    <Handle v-if="!data.noTarget" type="target" :position="Position.Left" />
    <Handle v-if="!data.noSource" type="source" :position="Position.Right" />

    <span class="fg-icon"><Icon :name="data.icon" :size="16" /></span>
    <span class="fg-titles">
      <span class="fg-title">{{ data.title }}</span>
      <span v-if="data.subtitle" class="fg-subtitle">{{ data.subtitle }}</span>
    </span>
    <span v-if="data.badge !== undefined" class="fg-badge">{{ data.badge }}</span>
  </div>
</template>

<style scoped>
.fg-node {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 232px;
  padding: 8px 10px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  font-size: 12px;
  cursor: pointer;
}

.fg-icon {
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

.fg-titles { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.fg-title {
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fg-subtitle {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fg-badge {
  flex: 0 0 auto;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
  border-radius: 9px;
}
</style>
