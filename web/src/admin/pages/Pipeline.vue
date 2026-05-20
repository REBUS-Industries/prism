<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { jobsApi, pipelinesApi, workstationsApi, type JobSummary, type PipelineTopology, type Workstation } from '../../shared/api';
import { adminWs } from '../../shared/ws';
import FlowEditor from '../components/FlowEditor.vue';

const topologies = shallowRef<Record<string, PipelineTopology>>({});
const selected = ref<string>('send');
const workstations = ref<Workstation[]>([]);
const jobs = ref<JobSummary[]>([]);
const loading = ref(true);
let unsub: (() => void) | null = null;

async function refresh() {
  const [p, w, j] = await Promise.all([
    pipelinesApi.list(),
    workstationsApi.list(),
    jobsApi.list({ limit: 50 }),
  ]);
  topologies.value = p.pipelines;
  if (!topologies.value[selected.value]) selected.value = Object.keys(topologies.value)[0] ?? 'send';
  workstations.value = w.workstations;
  jobs.value = j.jobs;
  loading.value = false;
}

onMounted(async () => {
  await refresh();
  unsub = adminWs.on(() => { void refresh(); });
});
onUnmounted(() => unsub?.());
</script>

<template>
  <div class="h-row">
    <h1 class="flex-1">Pipeline</h1>
    <select v-model="selected">
      <option v-for="(_, id) in topologies" :key="id" :value="id">{{ String(id) }}</option>
    </select>
  </div>
  <p class="muted">Live view: stages from <code>server/src/conversion/pipelines.ts</code>, workstation pool nodes from the live agent registry, animated edges where in-flight jobs currently are.</p>

  <div v-if="loading" class="card mt"><div class="muted">loading…</div></div>
  <div v-else class="mt">
    <FlowEditor
      v-if="topologies[selected]"
      :topology="topologies[selected]"
      :workstations="workstations"
      :jobs="jobs"
    />
    <div v-else class="card muted">no topology</div>
  </div>
</template>

<style scoped>
h1 { font-size: 22px; margin: 0 0 8px; }
</style>
