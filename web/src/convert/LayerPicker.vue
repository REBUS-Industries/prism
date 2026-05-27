<script setup lang="ts">
import { computed, ref } from 'vue';
import type { LayerNode } from '../shared/api';
import LayerRow from './LayerRow.vue';

const props = defineProps<{
  /** Layer forest returned from the agent (one or more root nodes). */
  layers: LayerNode[];
  /** Whether the picker is currently submitting (disables interaction). */
  busy?: boolean;
}>();

const emit = defineEmits<{
  (e: 'continue', value: { includedLayers: string[]; includeLayerDescendants: boolean }): void;
  (e: 'cancel'): void;
}>();

// Track expanded nodes and the set of selected FullPaths. Selection is
// stored as a Set of fullPath strings so server-side filtering can do an
// exact-match against Rhino's Layer.FullPath.
const expanded = ref(new Set<string>());
const checked  = ref(new Set<string>());
const includeDescendants = ref(true);

// Pre-expand the top level so the tree is immediately useful.
for (const root of props.layers) {
  const fp = root.fullPath ?? root.name;
  expanded.value.add(fp);
}

function pathOf(node: LayerNode): string {
  return node.fullPath ?? node.name;
}

function descendantPaths(node: LayerNode): string[] {
  const out: string[] = [];
  function walk(n: LayerNode) {
    out.push(pathOf(n));
    if (n.children) for (const c of n.children) walk(c);
  }
  walk(node);
  return out;
}

function tristate(node: LayerNode): 'checked' | 'mixed' | 'unchecked' {
  const paths = descendantPaths(node);
  let on = 0;
  for (const p of paths) if (checked.value.has(p)) on++;
  if (on === 0) return 'unchecked';
  if (on === paths.length) return 'checked';
  return 'mixed';
}

function toggle(node: LayerNode) {
  const state = tristate(node);
  const paths = descendantPaths(node);
  // Tri-state behaviour: clicking a checkbox in mixed state moves everything to checked.
  if (state === 'checked') {
    for (const p of paths) checked.value.delete(p);
  } else {
    for (const p of paths) checked.value.add(p);
  }
  // Trigger reactivity (Set mutations don't auto-track in Vue ≤3.4)
  checked.value = new Set(checked.value);
}

function toggleExpanded(node: LayerNode) {
  const fp = pathOf(node);
  if (expanded.value.has(fp)) expanded.value.delete(fp);
  else expanded.value.add(fp);
  expanded.value = new Set(expanded.value);
}

function selectAll() {
  const all = props.layers.flatMap(descendantPaths);
  checked.value = new Set(all);
}
function selectNone() {
  checked.value = new Set();
}

const selectedCount = computed(() => checked.value.size);
const totalCount    = computed(() => props.layers.flatMap(descendantPaths).length);

function submit() {
  emit('continue', {
    includedLayers: [...checked.value],
    includeLayerDescendants: includeDescendants.value,
  });
}
</script>

<template>
  <div class="picker">
    <div class="header">
      <div>
        <strong>Choose layers to convert</strong>
        <div class="muted" style="font-size: 11px;">
          {{ selectedCount }} of {{ totalCount }} selected
        </div>
      </div>
      <div class="actions">
        <button class="link" type="button" @click="selectAll" :disabled="busy">All</button>
        <button class="link" type="button" @click="selectNone" :disabled="busy">None</button>
      </div>
    </div>

    <div class="tree" role="tree">
      <LayerRow
        v-for="node in layers"
        :key="pathOf(node)"
        :node="node"
        :expanded="expanded"
        :tristate="tristate"
        :busy="busy"
        @toggle="toggle"
        @toggle-expanded="toggleExpanded" />
    </div>

    <label class="check">
      <input type="checkbox" v-model="includeDescendants" :disabled="busy" />
      Include descendants of selected layers automatically
    </label>

    <div class="footer">
      <button type="button" class="ghost" @click="$emit('cancel')" :disabled="busy">Cancel</button>
      <button type="button" class="primary" @click="submit" :disabled="busy || selectedCount === 0">
        {{ busy ? 'Continuing…' : 'Continue' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.header { display: flex; align-items: center; justify-content: space-between; }
.header .actions { display: flex; gap: 8px; }
.header .actions .link {
  background: transparent;
  border: 1px solid var(--color-border);
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
}
.tree {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 8px;
  /*
    Use the design-system input background token so the tree picks up the
    correct surface in both themes (white in light, #191a22 in dark).
    Previously this used `var(--color-surface, #fff)` -- there is no
    --color-surface token, so the white fallback kicked in for dark mode
    and gave us white-on-white layer names.
  */
  background: var(--color-bg-input);
  color: var(--color-text);
}
.check { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--color-text-muted); }
.footer { display: flex; gap: 8px; justify-content: flex-end; }
.footer .ghost { background: transparent; }
</style>
