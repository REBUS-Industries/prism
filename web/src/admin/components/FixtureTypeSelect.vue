<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  FIXTURE_CATEGORY_COLORS,
  LIBRARY_FIXTURE_CATEGORIES,
  type LibraryFixtureCategory,
} from '../utils/fixtureTypes';

const props = withDefaults(defineProps<{
  modelValue: LibraryFixtureCategory;
  disabled?: boolean;
  includeUnassigned?: boolean;
  label?: string;
  compact?: boolean;
}>(), {
  disabled: false,
  includeUnassigned: true,
  label: 'TYPE',
  compact: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: LibraryFixtureCategory];
}>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const options = computed(() =>
  props.includeUnassigned
    ? [...LIBRARY_FIXTURE_CATEGORIES]
    : LIBRARY_FIXTURE_CATEGORIES.filter((c) => c !== 'Unassigned'),
);

function dotColor(category: LibraryFixtureCategory): string {
  return FIXTURE_CATEGORY_COLORS[category];
}

function select(category: LibraryFixtureCategory): void {
  emit('update:modelValue', category);
  open.value = false;
}

function onDocClick(e: MouseEvent): void {
  if (!root.value?.contains(e.target as Node)) open.value = false;
}

onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <div ref="root" class="fixture-type-select" :class="{ compact, open, disabled }">
    <span v-if="label" class="type-label">{{ label }}</span>
    <button
      type="button"
      class="type-trigger"
      :disabled="disabled"
      :aria-expanded="open"
      @click.stop="open = !open"
    >
      <span class="type-dot" :style="{ background: dotColor(modelValue) }" aria-hidden="true" />
      <span class="type-value">{{ modelValue }}</span>
      <span class="type-chevron" aria-hidden="true">▾</span>
    </button>
    <ul v-if="open && !disabled" class="type-menu" role="listbox">
      <li
        v-for="opt in options"
        :key="opt"
        role="option"
        :aria-selected="opt === modelValue"
        class="type-option"
        @click.stop="select(opt)"
      >
        <span v-if="opt === modelValue" class="type-check" aria-hidden="true">✓</span>
        <span v-else class="type-check-spacer" aria-hidden="true" />
        <span class="type-dot" :style="{ background: dotColor(opt) }" aria-hidden="true" />
        <span class="type-option-label">{{ opt }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.fixture-type-select {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.fixture-type-select.compact {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}
.type-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  flex-shrink: 0;
}
.type-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 140px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-input);
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.compact .type-trigger {
  min-width: 0;
  padding: 5px 8px;
  font-size: 11px;
}
.type-trigger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.type-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.type-value { flex: 1; min-width: 0; }
.type-chevron {
  font-size: 10px;
  color: var(--color-text-muted);
}
.type-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 50;
  margin: 0;
  padding: 6px 0;
  list-style: none;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-elevated, #1a1a1a);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  max-height: 280px;
  overflow-y: auto;
}
.compact .type-menu {
  left: auto;
  right: 0;
  min-width: 180px;
}
.type-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  cursor: pointer;
}
.type-option:hover { background: var(--color-bg-hover); }
.type-check {
  width: 14px;
  font-size: 12px;
  color: var(--color-text);
  flex-shrink: 0;
}
.type-check-spacer { width: 14px; flex-shrink: 0; }
.type-option-label { flex: 1; }
</style>
