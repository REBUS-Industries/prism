<script setup lang="ts">
import FixtureViewer from './FixtureViewer.vue';
import type { FixturePart, FixtureModel } from '../../shared/api';

defineProps<{
  previewUrl?: string | null;
  /** Full geometry tree + models for assembled rendering (preferred). */
  assembly?: { fixtureId: string; parts: FixturePart[]; models: FixtureModel[]; motionAxes?: import('../../shared/api').MotionAxis[]; selectedModeGeometryId?: string | null } | null;
  fixtureName?: string;
  /** Mesh / GDTF record count for footer caption. */
  recordCount?: number;
}>();
</script>

<template>
  <div class="quad-wrap">
    <div class="quad-stage">
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
  flex: 1;
  min-height: 0;
  gap: 8px;
}
.quad-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  container-type: size;
}
.quad-preview {
  width: min(100cqw, 100cqh);
  aspect-ratio: 1;
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
  background: #e8eaed;
  contain: strict;
}
.quad-viewport :deep(.fixture-viewer) {
  position: absolute;
  inset: 0;
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
  flex-shrink: 0;
  margin: 0;
  font-size: 10px;
  line-height: 1.4;
}
</style>
