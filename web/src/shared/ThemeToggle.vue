<script setup lang="ts">
/**
 * Theme toggle button — cycles `system` → `light` → `dark`.
 *
 * Renders the icon for the *currently chosen* preference (so the operator
 * can tell at a glance whether their session is on auto-follow or pinned)
 * and exposes the resolved value via the title for accessibility.
 */
import { computed } from 'vue';
import { cycleTheme, resolveTheme, themePref } from './theme';

const resolved = computed(() => resolveTheme(themePref.value));
const title = computed(() => {
  switch (themePref.value) {
    case 'light':  return `Theme: light (click for dark)`;
    case 'dark':   return `Theme: dark (click for system)`;
    default:       return `Theme: system — currently ${resolved.value} (click for light)`;
  }
});
</script>

<template>
  <button type="button"
          class="icon-btn"
          :title="title"
          :aria-label="title"
          @click="cycleTheme">
    <!-- Sun (light pinned) -->
    <svg v-if="themePref === 'light'"
         viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
    <!-- Moon (dark pinned) -->
    <svg v-else-if="themePref === 'dark'"
         viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
    <!-- Monitor (system / auto) -->
    <svg v-else
         viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  </button>
</template>
