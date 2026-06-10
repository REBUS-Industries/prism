<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  dmxMapping: Record<string, unknown>;
}>();

const modes = computed(() => {
  const raw = props.dmxMapping?.modes;
  if (!Array.isArray(raw)) return [];
  return raw as Array<{ name?: string; footprint?: number; modeId?: string }>;
});
</script>

<template>
  <div v-if="!modes.length" class="muted">No DMX modes parsed.</div>
  <table v-else class="dmx-table">
    <thead><tr><th>Mode</th><th>Footprint</th></tr></thead>
    <tbody>
      <tr v-for="(m, i) in modes" :key="m.modeId ?? i">
        <td>{{ m.name ?? '—' }}</td>
        <td>{{ m.footprint ?? '—' }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.dmx-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dmx-table th, .dmx-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border, #333); }
</style>
