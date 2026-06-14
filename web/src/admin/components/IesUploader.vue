<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FixtureBeam } from '../../shared/api';
import { fixturesApi, type ApiError } from '../../shared/api';
import {
  IES_ZOOM_DMX_SLOTS,
  iesAssetForZoom,
  iesZoomSlotLabel,
} from '../utils/fixtureIes';

const props = defineProps<{ fixtureId: string; beams: FixtureBeam[] }>();
const emit = defineEmits<{ uploaded: [] }>();

const uploadingKey = ref<string | null>(null);
const error = ref<string | null>(null);

const zoomSlots = IES_ZOOM_DMX_SLOTS;

const hasBeams = computed(() => props.beams.length > 0);

function slotKey(beamId: string, zoomDmx: number): string {
  return `${beamId}:${zoomDmx}`;
}

async function onFile(beamId: string, zoomDmx: number, ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const key = slotKey(beamId, zoomDmx);
  uploadingKey.value = key;
  error.value = null;
  try {
    await fixturesApi.uploadIes(props.fixtureId, beamId, file, zoomDmx);
    emit('uploaded');
  } catch (err) {
    error.value = (err as ApiError).message ?? 'upload failed';
  } finally {
    uploadingKey.value = null;
    input.value = '';
  }
}
</script>

<template>
  <div class="ies-uploader">
    <p v-if="!hasBeams" class="muted small">No beams in this fixture.</p>

    <div v-for="beam in beams" :key="beam.beamId" class="beam-block">
      <h3 class="beam-title">{{ beam.beamId }}</h3>
      <p v-if="beam.zoomMinAngle != null && beam.zoomMaxAngle != null" class="muted small beam-zoom-range">
        Zoom range {{ beam.zoomMaxAngle.toFixed(1) }}° wide → {{ beam.zoomMinAngle.toFixed(1) }}° narrow
      </p>

      <ul class="zoom-list">
        <li v-for="zoomDmx in zoomSlots" :key="zoomDmx" class="zoom-row">
          <span class="zoom-label">{{ iesZoomSlotLabel(zoomDmx, beam) }}</span>
          <span
            class="pill"
            :class="iesAssetForZoom(beam, zoomDmx) ? 'online' : 'muted-pill'"
          >
            {{ iesAssetForZoom(beam, zoomDmx) ? 'IES attached' : 'No IES' }}
          </span>
          <label class="upload-btn" :class="{ busy: uploadingKey === slotKey(beam.beamId, zoomDmx) }">
            {{ uploadingKey === slotKey(beam.beamId, zoomDmx) ? 'Uploading…' : 'Upload .ies' }}
            <input
              type="file"
              accept=".ies,text/plain"
              :disabled="uploadingKey != null"
              @change="onFile(beam.beamId, zoomDmx, $event)"
            />
          </label>
        </li>
      </ul>
    </div>

    <div v-if="error" class="error-box mt-sm">{{ error }}</div>
  </div>
</template>

<style scoped>
.ies-uploader { display: flex; flex-direction: column; gap: 16px; }

.beam-block {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 12px;
  background: var(--color-bg-elevated);
}

.beam-title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
}

.beam-zoom-range { margin: 0 0 10px; }

.zoom-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.zoom-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.zoom-label {
  flex: 1 1 200px;
  font-size: 12px;
  min-width: 0;
}

.upload-btn {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  font-size: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-input);
  cursor: pointer;
}

.upload-btn.busy { opacity: 0.6; cursor: wait; }
.upload-btn input { display: none; }
</style>
