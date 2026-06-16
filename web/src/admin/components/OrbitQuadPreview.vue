<script setup lang="ts">
import { computed } from 'vue';
import type { ModelOrbitRef } from '../../shared/api';
import OrbitModelViewer from './OrbitModelViewer.vue';
import { buildOrbitModelViewerUrl, orbitServerBaseUrl } from '../utils/orbitViewerUrl';

const props = defineProps<{
  orbitRef: ModelOrbitRef;
  settings?: Record<string, string>;
}>();

const orbitWebUrl = computed(() => buildOrbitModelViewerUrl(
  orbitServerBaseUrl(props.settings ?? {}, props.orbitRef.target),
  props.orbitRef,
));

const QUAD_VIEWS = [
  ['top', 'Top'],
  ['front', 'Front'],
  ['side', 'Side'],
  ['iso', 'ISO'],
] as const;
</script>

<template>
  <div class="orbit-quad-wrap">
    <div class="orbit-quad-toolbar">
      <div class="orbit-quad-toolbar-start">
        <span class="orbit-badge">ORBIT viewer</span>
        <span class="orbit-controls-hint muted small">
          Top / Front / Side / Iso — drag to orbit in the ISO pane
        </span>
      </div>
      <a
        v-if="orbitWebUrl"
        :href="orbitWebUrl"
        class="orbit-open"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open in Orbit ↗
      </a>
    </div>
    <div class="quad-stage">
      <div class="quad-preview">
        <div
          v-for="view in QUAD_VIEWS"
          :key="view[0]"
          class="quad-cell"
        >
          <span class="quad-label">{{ view[1] }}</span>
          <div class="quad-viewport">
            <OrbitModelViewer
              :orbit-ref="orbitRef"
              :settings="settings"
              :view-preset="view[0]"
              :interactive="view[0] === 'iso'"
              fill
              compact
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.orbit-quad-wrap {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--color-bg-elevated);
}
.orbit-quad-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
  flex-shrink: 0;
}
.orbit-quad-toolbar-start {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.orbit-controls-hint {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.orbit-badge {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--orbit-primary, #ff8800);
  flex-shrink: 0;
}
.orbit-open {
  font-size: 12px;
  color: inherit;
  text-decoration: none;
  flex-shrink: 0;
}
.orbit-open:hover { text-decoration: underline; }
.quad-stage {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  padding: 8px;
}
.quad-preview {
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  height: 100%;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.quad-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.quad-label {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-text-subtle);
  padding-left: 2px;
}
.quad-viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--orbit-viewer-canvas-bg, #e8eaed);
  contain: strict;
}
.quad-viewport :deep(.orbit-model-viewer) {
  position: absolute;
  inset: 0;
  min-height: 0;
  border-radius: 0;
}
[data-theme="dark"] .quad-viewport {
  --orbit-viewer-canvas-bg: #1a1a1f;
}
</style>
