<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { jobsApi, workstationsApi, type JobSummary, type Workstation } from '../../shared/api';
import { adminWs } from '../../shared/ws';
import JobTable from '../components/JobTable.vue';
import JobLogsModal from '../components/JobLogsModal.vue';

// The job whose logs are currently in the modal.  Clicking a row in
// JobTable opens the modal; closing it clears this back to null.
const selectedJob = ref<JobSummary | null>(null);

// Keep selectedJob in sync with the live jobs[] array so the modal's
// status pill / lastMessage stay current as WS updates arrive.  Without
// this the modal would show a stale snapshot of the row at click time.
function syncSelectedJob() {
  if (!selectedJob.value) return;
  const fresh = jobs.value.find((j) => j.id === selectedJob.value!.id);
  if (fresh && fresh !== selectedJob.value) selectedJob.value = fresh;
}

const jobs = ref<JobSummary[]>([]);
const workstations = ref<Workstation[]>([]);
const loading = ref(true);
let unsubscribe: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const NON_TERMINAL = new Set<string>(['queued', 'dispatched', 'processing']);

function hasActiveJobs() {
  return jobs.value.some((j) => NON_TERMINAL.has(j.status));
}

function startPollIfNeeded() {
  if (pollTimer || !hasActiveJobs()) return;
  pollTimer = setInterval(async () => {
    try {
      const [j, w] = await Promise.all([
        jobsApi.list({ limit: 100 }),
        workstationsApi.list(),
      ]);
      jobs.value = j.jobs;
      workstations.value = w.workstations;
    } catch { /* keep polling */ }
    if (!hasActiveJobs()) {
      clearInterval(pollTimer!);
      pollTimer = null;
    }
  }, 5_000);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function refresh() {
  const [j, w] = await Promise.all([
    jobsApi.list({ limit: 100 }),
    workstationsApi.list(),
  ]);
  jobs.value = j.jobs;
  workstations.value = w.workstations;
  syncSelectedJob();
  loading.value = false;
  startPollIfNeeded();
}

onMounted(async () => {
  await refresh();
  unsubscribe = adminWs.on((ev) => {
    if (ev.type === 'job') {
      const idx = jobs.value.findIndex((j) => j.id === ev['jobId']);
      if (idx === -1) { void refresh(); return; }
      const patch: Partial<JobSummary> = {};
      if (typeof ev['status']           === 'string') patch.status         = ev['status'] as JobSummary['status'];
      if (typeof ev['currentStage']     === 'string') patch.currentStage   = ev['currentStage'] as string;
      if (typeof ev['progressPercent']  === 'number') patch.progressPercent= ev['progressPercent'] as number;
      if (typeof ev['lastMessage']      === 'string') patch.lastMessage    = ev['lastMessage'] as string;
      if (typeof ev['resultUrl']        === 'string') patch.resultUrl      = ev['resultUrl'] as string;
      if (typeof ev['error']            === 'string') patch.error          = ev['error'] as string;
      if (typeof ev['nodeName']         === 'string') patch.nodeName       = ev['nodeName'] as string;
      jobs.value = jobs.value.map((j, i) => (i === idx ? { ...j, ...patch } : j));
      syncSelectedJob();
      // Re-evaluate polling need after a WS patch (job may have gone terminal).
      if (!hasActiveJobs()) stopPoll();
      else startPollIfNeeded();
    } else if (ev.type === 'workstation') {
      void refresh();
    }
  });
});

onUnmounted(() => { unsubscribe?.(); stopPoll(); });

const activeCount = computed(() => jobs.value.filter((j) => j.status === 'queued' || j.status === 'dispatched' || j.status === 'processing').length);
const failedCount = computed(() => jobs.value.filter((j) => j.status === 'failed').length);
const onlineCount = computed(() => workstations.value.filter((w) => w.online).length);
</script>

<template>
  <h1>Dashboard</h1>

  <div class="stats">
    <div class="card stat">
      <div class="muted">In flight</div>
      <div class="num">{{ activeCount }}</div>
    </div>
    <div class="card stat">
      <div class="muted">Failed</div>
      <div class="num">{{ failedCount }}</div>
    </div>
    <div class="card stat">
      <div class="muted">Workstations online</div>
      <div class="num">{{ onlineCount }} <span class="muted" style="font-size: 13px;">/ {{ workstations.length }}</span></div>
    </div>
  </div>

  <div class="card mt-lg">
    <h2>Recent jobs</h2>
    <div v-if="loading" class="muted">loading…</div>
    <JobTable
      v-else
      :jobs="jobs"
      @cancelled="refresh"
      @select-job="(j) => selectedJob = j" />
  </div>

  <JobLogsModal :job="selectedJob" @close="selectedJob = null" />
</template>

<style scoped>
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.stat .num { font-size: 28px; font-weight: 700; margin-top: 6px; }
h1 { font-size: 22px; margin: 0 0 16px; }
h2 { font-size: 16px; margin: 0 0 12px; }
</style>
