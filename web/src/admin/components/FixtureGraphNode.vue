<script setup lang="ts">
/**
 * One node in the fixture construction graph (Construction tab).
 *
 * A single flexible node renders every kind of entry in the REBUS fixture
 * structure — the GDTF source, the Fixture root, each category branch, and the
 * individual items (parts, models, beams, motion axes, cells, DMX modes, …).
 * Each node is collapsible; expanding reveals its parameters as label/value
 * rows. Model nodes additionally render a small 3D preview of the mesh.
 */
import { ref, computed } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import Icon from '../../shared/Icon.vue';
import FixtureViewer from './FixtureViewer.vue';
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
  defaultExpanded?: boolean;
}

const props = defineProps<{ data: FixtureGraphNodeData }>();

const expanded = ref(props.data.defaultExpanded ?? false);

const accent = computed(() => props.data.accent ?? 'var(--orbit-primary)');
const hasBody = computed(
  () => (props.data.params?.length ?? 0) > 0 || !!props.data.modelPreview,
);

function toggle(): void {
  if (hasBody.value) expanded.value = !expanded.value;
}
</script>

<template>
  <div class="fg-node" :class="`kind-${data.kind}`" :style="{ '--accent': accent }">
    <Handle v-if="!data.noTarget" type="target" :position="Position.Left" />
    <Handle v-if="!data.noSource" type="source" :position="Position.Right" />

    <header class="fg-head node-drag-handle" :class="{ clickable: hasBody }" @click="toggle">
      <span class="fg-icon"><Icon :name="data.icon" :size="16" /></span>
      <span class="fg-titles">
        <span class="fg-title">{{ data.title }}</span>
        <span v-if="data.subtitle" class="fg-subtitle">{{ data.subtitle }}</span>
      </span>
      <span v-if="data.badge !== undefined" class="fg-badge">{{ data.badge }}</span>
      <button
        v-if="hasBody"
        type="button"
        class="fg-toggle"
        :aria-label="expanded ? 'Collapse' : 'Expand'"
        @click.stop="toggle"
      >
        <Icon :name="expanded ? 'expand_less' : 'expand_more'" :size="16" />
      </button>
    </header>

    <div v-if="expanded && hasBody" class="fg-body">
      <div v-if="data.modelPreview" class="fg-preview">
        <FixtureViewer
          :assembly="{ fixtureId: data.modelPreview.fixtureId, parts: data.modelPreview.parts, models: data.modelPreview.models }"
          :interactive="true"
          light-background
          fill
        />
      </div>
      <dl v-if="data.params?.length" class="fg-params">
        <div v-for="(p, i) in data.params" :key="i" class="fg-param">
          <dt :title="p.label">{{ p.label }}</dt>
          <dd :title="p.value">{{ p.value }}</dd>
        </div>
      </dl>
    </div>
  </div>
</template>

<style scoped>
.fg-node {
  width: 252px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  font-size: 12px;
  overflow: hidden;
}

.fg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
}
.fg-head.clickable { cursor: pointer; }

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

.fg-toggle {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.fg-toggle:hover { background: var(--color-bg-hover); color: var(--color-text); }

.fg-body { border-top: 1px solid var(--color-border); }

.fg-preview {
  height: 150px;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
}

.fg-params { margin: 0; padding: 6px 10px; display: flex; flex-direction: column; gap: 2px; }
.fg-param {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 8px;
  padding: 3px 0;
  border-bottom: 1px dashed var(--color-border);
}
.fg-param:last-child { border-bottom: none; }
.fg-param dt {
  margin: 0;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fg-param dd {
  margin: 0;
  color: var(--color-text);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  word-break: break-word;
}
</style>
