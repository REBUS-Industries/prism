<script setup lang="ts">
import { computed, ref } from 'vue';
import type { JobSummary } from '../../shared/api';
import { adminApi } from '../../shared/api';

const props = defineProps<{ jobs: JobSummary[] }>();
const emit = defineEmits<{ cancelled: [id: string] }>();

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
      <tr v-for="j in sorted" :key="j.id">
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
            v-if="CANCELLABLE.has(j.status)"
            class="btn-cancel"
            :disabled="cancellingId === j.id"
            :title="cancellingId === j.id ? 'Cancelling…' : 'Cancel job'"
            @click="handleCancel(j.id)"
          >{{ cancellingId === j.id ? '…' : '✕' }}</button>
        </td>
      </tr>
      <tr v-if="!sorted.length">
        <td colspan="9" class="muted" style="text-align:center; padding: 24px;">no jobs yet</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
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
.btn-cancel:hover:not(:disabled) {
  background: var(--color-error-bg);
}
.btn-cancel:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
