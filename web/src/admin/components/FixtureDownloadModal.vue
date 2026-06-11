<script setup lang="ts">
import { ref } from 'vue';
import FixtureTypeSelect from './FixtureTypeSelect.vue';
import FixtureModelQualitySelect from './FixtureModelQualitySelect.vue';
import { DEFAULT_GDTF_MODEL_QUALITY, type GdtfModelQuality } from '../utils/fixtureModelQuality';

defineProps<{
  fixtureName: string;
  manufacturer: string;
  saving?: boolean;
}>();

const emit = defineEmits<{
  cancel: [];
  confirm: [fixtureType: string, modelQuality: GdtfModelQuality];
}>();

const fixtureType = ref<string>('Spot');
const modelQuality = ref<GdtfModelQuality>(DEFAULT_GDTF_MODEL_QUALITY);
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('cancel')">
    <div class="modal card">
      <h2>Download fixture</h2>
      <p class="muted small">
        {{ manufacturer }} — {{ fixtureName }}
      </p>
      <FixtureTypeSelect
        v-model="fixtureType"
        label="Fixture type"
        :include-unassigned="false"
      />
      <FixtureModelQualitySelect v-model="modelQuality" />
      <div class="modal-actions">
        <button type="button" class="btn-cancel" @click="emit('cancel')">Cancel</button>
        <button
          type="button"
          class="btn-save"
          :disabled="saving"
          @click="emit('confirm', fixtureType, modelQuality)"
        >{{ saving ? 'Downloading…' : 'Save & download' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  padding: 24px;
}

.modal {
  width: 100%;
  max-width: 420px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.btn-cancel {
  padding: 9px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.btn-save {
  padding: 9px 16px;
  border: none;
  border-radius: var(--radius);
  background: var(--orbit-primary);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  cursor: pointer;
}

.btn-save:hover:not(:disabled) { background: var(--orbit-primary-hover); }
.btn-save:disabled { opacity: 0.55; cursor: not-allowed; }

.small { font-size: 12px; }
</style>
