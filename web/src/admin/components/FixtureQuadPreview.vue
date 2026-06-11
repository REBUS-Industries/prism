<script setup lang="ts">
import FixtureViewer from './FixtureViewer.vue';
import type { FixturePart, FixtureModel } from '../../shared/api';

defineProps<{
  previewUrl?: string | null;
  /** Full geometry tree + models for assembled rendering (preferred). */
  assembly?: { fixtureId: string; parts: FixturePart[]; models: FixtureModel[]; motionAxes?: import('../../shared/api').MotionAxis[] } | null;
  fixtureName?: string;
  /** Mesh / GDTF record count for footer caption. */
  recordCount?: number;
}>();
</script>

<template>
  <div class="quad-wrap">
    <div class="quad-preview">
      <div
        v-for="view in ([
          ['top', 'Top'],
          ['front', 'Front'],
          ['side', 'Side'],
          ['iso', 'ISO'],
        ] as const)"
        :key="view[0]"
        class="quad-cell"
      >
        <span class="quad-label">{{ view[1] }}</span>
        <div class="quad-viewport">
          <FixtureViewer
            v-if="previewUrl || assembly"
            :url="previewUrl"
            :assembly="assembly"
            :view-preset="view[0]"
            :interactive="view[0] === 'iso'"
            fill
            light-background
          />
          <div v-else class="quad-placeholder">
            <span class="quad-grid-bg" aria-hidden="true" />
            <span class="quad-icon muted">◎</span>
          </div>
        </div>
      </div>
    </div>
    <p v-if="recordCount != null" class="quad-footer muted">
      {{ recordCount }} mesh JSON records — Top / Front / Side / Iso quad view
    </p>
  </div>
</template>

<style scoped>
.quad-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.quad-preview {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.quad-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.quad-label {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-text-subtle);
  padding-left: 2px;
}
.quad-viewport {
  position: relative;
  aspect-ratio: 1;
  min-height: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: #e8eaed;
  contain: strict;
}
[data-theme="dark"] .quad-viewport {
  background: #1a1c22;
}
.quad-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  position: relative;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 11px,
    var(--color-border) 11px,
    var(--color-border) 12px
  ),
  repeating-linear-gradient(
    90deg,
    transparent,
    transparent 11px,
    var(--color-border) 11px,
    var(--color-border) 12px
  );
}
.quad-grid-bg {
  position: absolute;
  inset: 0;
}
.quad-icon {
  font-size: 24px;
  opacity: 0.35;
  z-index: 1;
}
.quad-icon.muted { color: var(--color-text-subtle); }
.quad-footer {
  margin: 0;
  font-size: 10px;
  line-height: 1.4;
}
</style>
