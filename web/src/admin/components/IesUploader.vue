<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FixtureBeam, FixturePart } from '../../shared/api';
import { fixturesApi, type ApiError } from '../../shared/api';
import {
  groupBeamsForIes,
  iesGroupStatus,
  IES_ZOOM_DMX_SLOTS,
  iesZoomSlotLabel,
  type IesBeamGroup,
} from '../utils/fixtureIes';

const props = defineProps<{
  fixtureId: string;
  beams: FixtureBeam[];
  parts?: FixturePart[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ uploaded: [] }>();

const uploadingKey = ref<string | null>(null);
const error = ref<string | null>(null);

const zoomSlots = IES_ZOOM_DMX_SLOTS;
const parts = computed(() => props.parts ?? []);
const groups = computed(() => groupBeamsForIes(props.beams, parts.value));
const hasBeams = computed(() => props.beams.length > 0);

function slotKey(groupKey: string, zoomDmx: number): string {
  return `${groupKey}:${zoomDmx}`;
}

function statusLabel(group: IesBeamGroup, zoomDmx: number): string {
  const s = iesGroupStatus(group, zoomDmx);
  if (s === 'all') return group.beams.length > 1 ? 'IES on all' : 'IES attached';
  if (s === 'partial') return 'IES on some';
  return 'No IES';
}

async function onFile(group: IesBeamGroup, zoomDmx: number, ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const key = slotKey(group.key, zoomDmx);
  uploadingKey.value = key;
  error.value = null;
  try {
    // One upload applies to every beam in the group, across all DMX modes.
    await fixturesApi.uploadIes(props.fixtureId, group.beams.map((b) => b.beamId), file, zoomDmx);
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
    <p v-else class="muted small ies-note">
      IES profiles apply to the whole fixture across all DMX modes. Identical beams
      (e.g. every pixel or head) are grouped — one upload covers the group.
    </p>

    <div v-for="group in groups" :key="group.key" class="beam-block">
      <h3 class="beam-title">
        {{ group.label }}
        <span v-if="group.beams.length > 1" class="count-badge">{{ group.beams.length }} beams</span>
      </h3>
      <p v-if="group.detail" class="muted small beam-detail">{{ group.detail }}</p>
      <p
        v-if="group.representative.zoomMinAngle != null && group.representative.zoomMaxAngle != null"
        class="muted small beam-zoom-range"
      >
        Zoom range {{ group.representative.zoomMaxAngle.toFixed(1) }}° wide → {{ group.representative.zoomMinAngle.toFixed(1) }}° narrow
      </p>

      <ul class="zoom-list">
        <li v-for="zoomDmx in zoomSlots" :key="zoomDmx" class="zoom-row">
          <span class="zoom-label">{{ iesZoomSlotLabel(zoomDmx, group.representative) }}</span>
          <span
            class="pill"
            :class="{
              online: iesGroupStatus(group, zoomDmx) === 'all',
              'partial-pill': iesGroupStatus(group, zoomDmx) === 'partial',
              'muted-pill': iesGroupStatus(group, zoomDmx) === 'none',
            }"
          >
            {{ statusLabel(group, zoomDmx) }}
          </span>
          <label class="upload-btn" :class="{ busy: uploadingKey === slotKey(group.key, zoomDmx) }">
            {{ uploadingKey === slotKey(group.key, zoomDmx) ? 'Uploading…' : 'Upload .ies' }}
            <input
              type="file"
              accept=".ies,text/plain"
              :disabled="props.disabled || uploadingKey != null"
              @change="onFile(group, zoomDmx, $event)"
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

.ies-note { margin: 0; }

.count-badge {
  margin-left: 8px;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 999px;
  background: var(--color-bg-input);
  border: 1px solid var(--color-border);
  vertical-align: middle;
}

.partial-pill {
  background: #3a2f12;
  color: #e6b53c;
}

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

.beam-detail { margin: 0 0 4px; }

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
