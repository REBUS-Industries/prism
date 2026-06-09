<script setup lang="ts">
/**
 * Compact labelled colour control: a native swatch picker paired with an
 * editable `#rrggbb` hex field. Two-way binds the hex string via `v-model`;
 * the hex box only commits when it parses to a valid 6-digit colour. Carries
 * `nodrag nopan` so use inside a Vue Flow node never pans or drags the graph.
 */
defineProps<{
  label: string;
  sublabel?: string | null;
}>();

const model = defineModel<string>({ required: true });

function onSwatch(ev: Event): void {
  model.value = (ev.target as HTMLInputElement).value.toLowerCase();
}

function onHex(ev: Event): void {
  const el = ev.target as HTMLInputElement;
  let v = el.value.trim();
  if (v && !v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    model.value = v.toLowerCase();
  } else {
    el.value = model.value;
  }
}
</script>

<template>
  <div class="param-field nodrag nopan">
    <div class="pf-label">
      <span class="pf-name">{{ label }}</span>
      <span v-if="sublabel" class="pf-sub">{{ sublabel }}</span>
    </div>
    <div class="pf-row">
      <input
        class="pf-swatch nodrag nopan"
        type="color"
        :value="model"
        @input="onSwatch"
      />
      <input
        class="pf-hex nodrag nopan"
        type="text"
        spellcheck="false"
        maxlength="7"
        :value="model"
        @change="onHex"
      />
    </div>
  </div>
</template>

<style scoped>
.param-field { display: flex; flex-direction: column; gap: 4px; }
.pf-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}
.pf-name { font-size: 11px; font-weight: 600; color: var(--color-text); }
.pf-sub {
  font-size: 10px;
  color: var(--color-text-subtle);
  text-transform: lowercase;
  letter-spacing: 0.01em;
}
.pf-row { display: flex; align-items: center; gap: 8px; }
.pf-swatch {
  width: 34px;
  height: 26px;
  flex: none;
  padding: 2px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  background: var(--color-bg-input);
}
.pf-swatch::-webkit-color-swatch-wrapper { padding: 0; }
.pf-swatch::-webkit-color-swatch { border: none; border-radius: 2px; }
.pf-swatch::-moz-color-swatch { border: none; border-radius: 2px; }
.pf-hex {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 11px;
  font-family: var(--font-mono);
  text-transform: lowercase;
}
</style>
