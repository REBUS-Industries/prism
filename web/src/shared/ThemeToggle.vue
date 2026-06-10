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
import Icon from './Icon.vue';

const resolved = computed(() => resolveTheme(themePref.value));

const iconName = computed(() => {
  switch (themePref.value) {
    case 'light': return 'light_mode';
    case 'dark':  return 'dark_mode';
    default:      return 'computer';
  }
});
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
    <Icon :name="iconName" :size="18" />
  </button>
</template>
