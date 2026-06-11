<script setup lang="ts">
import { ref, watch } from 'vue';
import FixtureTypeSelect from './FixtureTypeSelect.vue';
import FixtureModelQualitySelect from './FixtureModelQualitySelect.vue';
import { fixturesApi, type ApiError } from '../../shared/api';
import {
  DEFAULT_GDTF_MODEL_QUALITY,
  coerceModelQuality,
  defaultModelQualityForAvailable,
  type GdtfModelQuality,
  type GdtfModelFormat,
} from '../utils/fixtureModelQuality';

const props = defineProps<{
  fixtureName: string;
  manufacturer: string;
  rid: number;
  saving?: boolean;
}>();

const emit = defineEmits<{
  cancel: [];
  confirm: [fixtureType: string, modelQuality: GdtfModelQuality];
}>();

const fixtureType = ref<string>('Spot');
const modelQuality = ref<GdtfModelQuality>(DEFAULT_GDTF_MODEL_QUALITY);
const availableModelQualities = ref<GdtfModelQuality[] | null>(null);
const availableModelFormats = ref<GdtfModelFormat[] | null>(null);
const loadingQualities = ref(false);
const qualityError = ref<string | null>(null);

async function loadQualities(rid: number): Promise<void> {
  loadingQualities.value = true;
  qualityError.value = null;
  availableModelQualities.value = null;
  availableModelFormats.value = null;
  try {
    const res = await fixturesApi.gdtfShareModelQualities(rid);
    availableModelQualities.value = res.availableModelQualities;
    availableModelFormats.value = res.availableModelFormats ?? null;
    modelQuality.value = defaultModelQualityForAvailable(res.availableModelQualities);
  } catch (err) {
    qualityError.value = (err as ApiError).message ?? 'failed to read GDTF mesh options';
    modelQuality.value = DEFAULT_GDTF_MODEL_QUALITY;
  } finally {
    loadingQualities.value = false;
  }
}

watch(
  () => props.rid,
  (rid) => { void loadQualities(rid); },
  { immediate: true },
);
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
      <FixtureModelQualitySelect
        v-model="modelQuality"
        :available="availableModelQualities"
        :formats="availableModelFormats"
        :loading="loadingQualities"
        :disabled="saving"
      />
      <p v-if="qualityError" class="error-inline small">{{ qualityError }}</p>
      <div class="modal-actions">
        <button type="button" class="btn-cancel" @click="emit('cancel')">Cancel</button>
        <button
          type="button"
          class="btn-save"
          :disabled="saving || loadingQualities || !(availableModelQualities?.length)"
          @click="emit('confirm', fixtureType, coerceModelQuality(modelQuality, availableModelQualities))"
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

.error-inline {
  margin: 0;
  color: var(--color-danger, #e55);
}
</style>
