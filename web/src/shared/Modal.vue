<script setup lang="ts">
/**
 * Reusable modal shell — overlay + centered card with an uppercase title,
 * scrollable body slot, and an optional footer slot (Cancel / Save). Closes
 * on backdrop click and Escape. Matches the portal design system tokens.
 */
import { onMounted, onUnmounted } from 'vue';
import Icon from './Icon.vue';

withDefaults(defineProps<{
  title?: string;
  subtitle?: string;
  /** Target card width in px (clamped to viewport). */
  maxWidth?: number;
  /** Minimum card width in px (clamped to viewport). */
  minWidth?: number;
  /** Viewport width fraction used when clamping (default 92). */
  viewportWidth?: number;
}>(), {
  title: '',
  subtitle: '',
  maxWidth: 560,
  minWidth: 0,
  viewportWidth: 92,
});

const emit = defineEmits<{ close: [] }>();

function close(): void {
  emit('close');
}

function onBackdrop(e: MouseEvent): void {
  if ((e.target as HTMLElement).classList.contains('modal-backdrop')) close();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="modal-backdrop" @mousedown="onBackdrop">
    <div
      class="modal-shell"
      role="dialog"
      aria-modal="true"
      :style="{
        width: `min(${maxWidth}px, ${viewportWidth}vw)`,
        maxWidth: `${viewportWidth}vw`,
        minWidth: minWidth ? `min(${minWidth}px, ${viewportWidth}vw)` : undefined,
      }"
    >
      <header class="modal-head">
        <div class="head-text">
          <h2 v-if="title" class="modal-title">{{ title }}</h2>
          <p v-if="subtitle" class="modal-subtitle">{{ subtitle }}</p>
          <slot name="header" />
        </div>
        <button type="button" class="modal-close" title="Close (Esc)" @click="close">
          <Icon name="close" :size="18" label="Close" />
        </button>
      </header>

      <div class="modal-body">
        <slot />
      </div>

      <footer v-if="$slots.footer" class="modal-foot">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.55);
}
.modal-shell {
  width: 100%;
  min-width: 0;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg-elevated);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-2, 0 16px 40px rgba(0, 0, 0, 0.45));
}
.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}
.head-text { min-width: 0; }
.modal-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.modal-subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--color-text-muted);
}
.modal-close {
  flex-shrink: 0;
  width: 32px;
  min-height: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 15px;
  cursor: pointer;
}
.modal-close:hover { background: var(--color-bg-hover); color: var(--color-text); }
.modal-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 20px;
}
.modal-body :deep(pre) {
  max-width: 100%;
  overflow-x: auto;
  box-sizing: border-box;
}
.modal-body :deep(code) {
  overflow-wrap: anywhere;
  word-break: break-word;
}
.modal-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--color-border);
}
</style>
