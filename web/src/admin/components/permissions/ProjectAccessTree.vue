<script setup lang="ts">
/**
 * Hierarchical checkbox tree for ORBIT project selection.
 * Groups projects by the prefix before " - " (e.g. "LIVE NATION - U2" → LIVE NATION / U2).
 */
import { computed, ref, watch } from 'vue';
import Icon from '../../../shared/Icon.vue';
import type { OrbitProject } from '../../../shared/api';

export interface ProjectTreeLeaf {
  kind: 'project';
  id: string;
  label: string;
  projectId: string;
}

export interface ProjectTreeGroup {
  kind: 'group';
  id: string;
  label: string;
  children: ProjectTreeLeaf[];
}

export type ProjectTreeNode = ProjectTreeGroup | ProjectTreeLeaf;

const props = defineProps<{
  projects: OrbitProject[];
  modelValue: string[];
  filterPlaceholder?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [string[]];
}>();

const filter = ref('');
const expanded = ref<Set<string>>(new Set());

const selected = computed({
  get: () => new Set(props.modelValue),
  set: (next: Set<string>) => emit('update:modelValue', [...next]),
});

function groupKey(name: string): string | null {
  const idx = name.indexOf(' - ');
  if (idx <= 0) return null;
  return name.slice(0, idx).trim() || null;
}

function childLabel(name: string, group: string): string {
  const prefix = `${group} - `;
  if (name.startsWith(prefix)) return name.slice(prefix.length).trim() || name;
  return name;
}

const tree = computed((): ProjectTreeNode[] => {
  const q = filter.value.trim().toLowerCase();
  const groups = new Map<string, OrbitProject[]>();
  const ungrouped: OrbitProject[] = [];

  for (const p of props.projects) {
    const name = p.name?.trim() || p.id;
    if (q && !name.toLowerCase().includes(q) && !p.id.toLowerCase().includes(q)) continue;
    const g = groupKey(name);
    if (g) {
      const list = groups.get(g) ?? [];
      list.push(p);
      groups.set(g, list);
    } else {
      ungrouped.push(p);
    }
  }

  const nodes: ProjectTreeNode[] = [];
  const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const g of groupNames) {
    const children = (groups.get(g) ?? [])
      .slice()
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
      .map((p): ProjectTreeLeaf => ({
        kind: 'project',
        id: `p-${p.id}`,
        label: childLabel(p.name?.trim() || p.id, g),
        projectId: p.id,
      }));
    nodes.push({ kind: 'group', id: `g-${g}`, label: g, children });
  }

  for (const p of ungrouped.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))) {
    nodes.push({
      kind: 'project',
      id: `p-${p.id}`,
      label: p.name?.trim() || p.id,
      projectId: p.id,
    });
  }
  return nodes;
});

watch(
  tree,
  (nodes) => {
    const next = new Set(expanded.value);
    for (const n of nodes) {
      if (n.kind === 'group' && !next.has(n.id)) next.add(n.id);
    }
    expanded.value = next;
  },
  { immediate: true },
);

function isExpanded(id: string): boolean {
  return expanded.value.has(id);
}

function toggleExpand(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function leafChecked(projectId: string): boolean {
  return selected.value.has(projectId);
}

function groupState(group: ProjectTreeGroup): 'all' | 'some' | 'none' {
  let n = 0;
  for (const c of group.children) {
    if (selected.value.has(c.projectId)) n += 1;
  }
  if (n === 0) return 'none';
  if (n === group.children.length) return 'all';
  return 'some';
}

function setLeaf(projectId: string, on: boolean) {
  const next = new Set(selected.value);
  if (on) next.add(projectId);
  else next.delete(projectId);
  selected.value = next;
}

function setGroup(group: ProjectTreeGroup, on: boolean) {
  const next = new Set(selected.value);
  for (const c of group.children) {
    if (on) next.add(c.projectId);
    else next.delete(c.projectId);
  }
  selected.value = next;
}

function onGroupChange(group: ProjectTreeGroup, ev: Event) {
  const checked = (ev.target as HTMLInputElement).checked;
  setGroup(group, checked);
}

function bindIndeterminate(el: unknown, some: boolean) {
  if (el instanceof HTMLInputElement) el.indeterminate = some;
}
</script>

<template>
  <div class="project-tree">
    <div class="project-tree__filter">
      <Icon name="search" :size="16" />
      <input
        v-model="filter"
        type="search"
        :placeholder="filterPlaceholder ?? 'Filter projects…'"
        autocomplete="off"
      />
    </div>

    <div v-if="!tree.length" class="project-tree__empty muted">
      {{ filter.trim() ? 'No projects match the filter.' : 'No ORBIT projects loaded.' }}
    </div>

    <ul v-else class="project-tree__list" role="tree">
      <template v-for="node in tree" :key="node.id">
        <li v-if="node.kind === 'group'" class="project-tree__group" role="treeitem" :aria-expanded="isExpanded(node.id)">
          <div class="project-tree__row project-tree__row--group">
            <button
              type="button"
              class="project-tree__twist"
              :aria-label="isExpanded(node.id) ? 'Collapse' : 'Expand'"
              @click="toggleExpand(node.id)"
            >
              <Icon :name="isExpanded(node.id) ? 'expand_more' : 'chevron_right'" :size="16" />
            </button>
            <label class="project-tree__check">
              <input
                type="checkbox"
                :checked="groupState(node) === 'all'"
                :ref="(el) => bindIndeterminate(el, groupState(node) === 'some')"
                @change="onGroupChange(node, $event)"
              />
              <span class="project-tree__label">{{ node.label }}</span>
              <span class="muted small">{{ node.children.length }}</span>
            </label>
          </div>
          <ul v-if="isExpanded(node.id)" class="project-tree__children" role="group">
            <li v-for="child in node.children" :key="child.id" class="project-tree__leaf" role="treeitem">
              <label class="project-tree__check project-tree__check--leaf">
                <input
                  type="checkbox"
                  :checked="leafChecked(child.projectId)"
                  @change="setLeaf(child.projectId, ($event.target as HTMLInputElement).checked)"
                />
                <span class="project-tree__label">{{ child.label }}</span>
                <code class="muted small">{{ child.projectId }}</code>
              </label>
            </li>
          </ul>
        </li>

        <li v-else class="project-tree__leaf project-tree__leaf--root" role="treeitem">
          <label class="project-tree__check project-tree__check--leaf">
            <input
              type="checkbox"
              :checked="leafChecked(node.projectId)"
              @change="setLeaf(node.projectId, ($event.target as HTMLInputElement).checked)"
            />
            <span class="project-tree__label">{{ node.label }}</span>
            <code class="muted small">{{ node.projectId }}</code>
          </label>
        </li>
      </template>
    </ul>
  </div>
</template>

<style scoped>
.project-tree {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.project-tree__filter {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--color-border, var(--border));
  border-radius: 6px;
  background: var(--color-bg, transparent);
}
.project-tree__filter input {
  flex: 1;
  border: none;
  background: transparent;
  outline: none;
  font-size: 13px;
}
.project-tree__list,
.project-tree__children {
  list-style: none;
  margin: 0;
  padding: 0;
}
.project-tree__list {
  max-height: 280px;
  overflow: auto;
  border: 1px solid var(--color-border, var(--border));
  border-radius: 6px;
  padding: 4px 0;
}
.project-tree__children {
  padding-left: 28px;
}
.project-tree__row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.project-tree__twist {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: 4px;
}
.project-tree__twist:hover { background: var(--color-bg-hover, rgba(0,0,0,.06)); }
.project-tree__check {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding: 5px 10px 5px 4px;
  font-size: 13px;
  cursor: pointer;
}
.project-tree__check--leaf { padding-left: 28px; }
.project-tree__leaf--root .project-tree__check--leaf { padding-left: 28px; }
.project-tree__label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.project-tree__check code {
  margin-left: auto;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}
.project-tree__empty {
  padding: 16px;
  text-align: center;
  font-size: 13px;
  border: 1px dashed var(--color-border, var(--border));
  border-radius: 6px;
}
.small { font-size: 11px; }
</style>
