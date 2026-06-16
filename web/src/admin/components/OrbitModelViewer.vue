<script setup lang="ts">
/**
 * Embeds the Orbit (Speckle frontend-2) web viewer for a project model.
 * Auth relies on the operator's existing Orbit session cookies in the browser.
 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  url: string;
  fill?: boolean;
}>(), {
  fill: false,
});

const safeUrl = computed(() => props.url.trim());
</script>

<template>
  <div class="orbit-model-viewer" :class="{ fill }">
    <div class="orbit-toolbar">
      <span class="orbit-badge">Orbit viewer</span>
      <a
        v-if="safeUrl"
        :href="safeUrl"
        class="orbit-open"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open in Orbit ↗
      </a>
    </div>
    <iframe
      v-if="safeUrl"
      class="orbit-frame"
      :src="safeUrl"
      title="Orbit 3D model viewer"
      allow="fullscreen"
      referrerpolicy="no-referrer"
    />
    <div v-else class="muted empty">Orbit viewer URL not available.</div>
  </div>
</template>

<style scoped>
.orbit-model-viewer {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 320px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-2, #1a1a1f);
}
.orbit-model-viewer.fill {
  min-height: 0;
  height: 100%;
  border-radius: 0;
}
.orbit-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-border, #2a2a32);
  background: var(--surface-1, #121216);
  flex-shrink: 0;
}
.orbit-badge {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--orbit-primary, #ff8800);
}
.orbit-open {
  font-size: 12px;
  color: inherit;
  text-decoration: none;
}
.orbit-open:hover { text-decoration: underline; }
.orbit-frame {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: none;
  background: #0e0e12;
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
