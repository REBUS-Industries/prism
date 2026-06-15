<script setup lang="ts">
import { computed, ref } from 'vue';
import type { JobSummary } from '../../shared/api';
import { adminApi } from '../../shared/api';
import Icon from '../../shared/Icon.vue';

const props = defineProps<{ jobs: JobSummary[] }>();
const emit = defineEmits<{
  cancelled: [id: string];
  /**
   * Row click — Dashboard listens to this and pops the JobLogsModal.
   * Emitted only when the click did NOT originate from the cancel
   * button (handled by `.stop` on the click handler in the template).
   */
  selectJob: [job: JobSummary];
  /**
   * "Select layers" button on an `awaiting_selection` job — Dashboard pops
   * the JobLayerPickerModal so the operator can choose layers and resume the
   * two-phase convert. Uses `.stop` so it does not also open the logs modal.
   */
  selectLayers: [job: JobSummary];
}>();

const CANCELLABLE = new Set(['queued', 'dispatched', 'processing', 'uploading']);

const cancellingId = ref<string | null>(null);

const sorted = computed(() => [...props.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));

function fmtSize(b: number): string {
  if (!b) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = b, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
function shortId(id: string): string { return id.slice(0, 8); }

async function handleCancel(id: string) {
  if (cancellingId.value) return;
  cancellingId.value = id;
  try {
    await adminApi.cancelJob(id);
    emit('cancelled', id);
  } catch (err) {
    console.error('cancel failed', err);
  } finally {
    cancellingId.value = null;
  }
}
</script>

<template>
  <table>
    <thead>
      <tr>
        <th>Status</th>
        <th>File</th>
        <th>Size</th>
        <th>Target</th>
        <th>Workstation</th>
        <th>Progress</th>
        <th>Created</th>
        <th>Job</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="j in sorted"
        :key="j.id"
        class="clickable"
        :title="`View logs for ${j.fileName}`"
        @click="$emit('selectJob', j)">
        <td><span class="pill" :class="j.status">{{ j.status }}</span></td>
        <td>{{ j.fileName }} <span class="muted">{{ j.format }}</span></td>
        <td>{{ fmtSize(j.fileSize) }}</td>
        <td>{{ j.orbitTarget }} <span class="muted">{{ j.modelName || j.modelId }}</span></td>
        <td>{{ j.nodeName ?? '—' }}</td>
        <td>
          <div v-if="j.progressPercent != null" class="progress">
            <div class="fill" :style="{ width: `${j.progressPercent}%` }"></div>
          </div>
          <span v-else class="muted">—</span>
          <div v-if="j.lastMessage" class="muted" style="font-size: 11px;">{{ j.lastMessage }}</div>
        </td>
        <td class="muted">{{ new Date(j.createdAt).toLocaleString() }}</td>
        <td><code>{{ shortId(j.id) }}</code></td>
        <td>
          <button
            v-if="j.status === 'awaiting_selection'"
            class="btn-layers"
            title="Select layers and start the convert"
            @click.stop="$emit('selectLayers', j)"
          ><Icon name="layers" :size="14" /> Select layers</button>
          <button
            v-else-if="CANCELLABLE.has(j.status)"
            class="btn-cancel"
            :disabled="cancellingId === j.id"
            :title="cancellingId === j.id ? 'Cancelling…' : 'Cancel job'"
            @click.stop="handleCancel(j.id)"
          ><span v-if="cancellingId === j.id">…</span><Icon v-else name="close" :size="14" /></button>
        </td>
      </tr>
      <tr v-if="!sorted.length">
        <td colspan="9" class="muted" style="text-align:center; padding: 24px;">no jobs yet</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
tr.clickable { cursor: pointer; }
tr.clickable:hover { background: var(--color-bg-hover); }
tr.clickable:hover td { color: var(--color-text); }

.btn-cancel {
  padding: 2px 8px;
  font-size: 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-error);
  background: transparent;
  color: var(--color-error);
  cursor: pointer;
  line-height: 1.4;
  min-width: 28px;
}

/* "Select layers" call-to-action for awaiting_selection jobs. Compact accent
   button (overrides the design-system's 40px-tall uppercase button base). */
.btn-layers {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: auto;
  text-transform: none;
  letter-spacing: normal;
  padding: 3px 10px;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  border-radius: var(--radius-sm);
  border: 1px solid hsl(var(--primary));
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  cursor: pointer;
}
.btn-layers:hover { background: hsl(var(--primary) / 0.9); border-color: hsl(var(--primary) / 0.9); }
.btn-cancel:hover:not(:disabled) {
  background: var(--color-error-bg);
}
.btn-cancel:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
