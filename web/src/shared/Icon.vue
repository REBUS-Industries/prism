<script setup lang="ts">
/**
 * Material Symbols icon.
 *
 * Renders a single Material Symbols Outlined glyph by ligature name (see
 * https://fonts.google.com/icons). The font is self-hosted and wired up in
 * `designSystem.css`; this component only sets the per-instance variable-font
 * axes (size / fill / weight / grade) and accessibility attributes.
 *
 * Icons inherit `currentColor`, so they follow the surrounding theme text or
 * `--primary` colour automatically in both light and dark modes.
 *
 *   <Icon name="dashboard" />                     decorative, 20px
 *   <Icon name="delete" :size="18" />             smaller
 *   <Icon name="check_circle" fill />             filled variant
 *   <Icon name="settings" label="Settings" />     announced to screen readers
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** Material Symbol ligature name, e.g. `dashboard`, `dark_mode`. */
    name: string;
    /** Rendered size in px. Drives font-size and the optical-size axis. */
    size?: number;
    /** Filled variant (FILL axis 0 → 1). */
    fill?: boolean;
    /** Weight axis (100–700). */
    weight?: number;
    /** Grade axis (-50–200) for subtle weight emphasis. */
    grade?: number;
    /**
     * Accessible label. When provided the icon is exposed as `role="img"`
     * with this label; when omitted the icon is decorative (`aria-hidden`).
     */
    label?: string;
  }>(),
  {
    size: 20,
    fill: false,
    weight: 400,
    grade: 0,
    label: undefined,
  },
);

const style = computed(() => {
  // Optical size tracks the rendered size, clamped to the font's axis range.
  const opsz = Math.min(48, Math.max(20, props.size));
  return {
    fontSize: `${props.size}px`,
    fontVariationSettings: `'FILL' ${props.fill ? 1 : 0}, 'wght' ${props.weight}, 'GRAD' ${props.grade}, 'opsz' ${opsz}`,
  };
});
</script>

<template>
  <span
    class="material-symbols-outlined"
    :style="style"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
  >{{ name }}</span>
</template>
