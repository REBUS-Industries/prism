<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { webhooksApi, type Webhook, type ApiError } from '../../shared/api';
import Icon from '../../shared/Icon.vue';

const hooks = ref<Webhook[]>([]);
const showNew = ref(false);
const newName = ref('');
const newUrl = ref('');
const mintedSecret = ref<string | null>(null);
const error = ref<string | null>(null);

async function refresh() {
  hooks.value = (await webhooksApi.list()).webhooks;
}

async function create() {
  error.value = null;
  try {
    const created = await webhooksApi.create({ name: newName.value, url: newUrl.value });
    if (created.secret) mintedSecret.value = created.secret;
    newName.value = ''; newUrl.value = ''; showNew.value = false;
    await refresh();
  } catch (err) {
    error.value = (err as ApiError).message ?? 'create failed';
  }
}

async function toggle(h: Webhook) {
  await webhooksApi.patch(h.id, { isActive: !h.isActive });
  await refresh();
}

async function regenerate(h: Webhook) {
  if (!confirm('Generate a new HMAC secret? Existing subscribers must be updated.')) return;
  const updated = await webhooksApi.patch(h.id, { regenerateSecret: true });
  if (updated.secret) mintedSecret.value = updated.secret;
  await refresh();
}

async function remove(h: Webhook) {
  if (!confirm(`Delete webhook "${h.name}"?`)) return;
  await webhooksApi.remove(h.id);
  await refresh();
}

onMounted(refresh);
</script>

<template>
  <div class="h-row">
    <h1 class="flex-1">Webhooks</h1>
    <button class="primary" @click="showNew = true"><Icon name="add" :size="16" />New webhook</button>
  </div>
  <p class="muted">PRISM POSTs <code>{ event, ts, job }</code> on <code>job.complete</code> and <code>job.failed</code>. Signed with HMAC-SHA256 in <code>x-prism-signature</code> when a secret is set.</p>

  <div v-if="error" class="error-box mt">{{ error }}</div>
  <div v-if="mintedSecret" class="card mt success-box">
    <strong>HMAC secret — copy now, you won't see it again:</strong>
    <pre style="margin: 8px 0 0; font-size: 12px; word-break: break-all;">{{ mintedSecret }}</pre>
    <div class="mt-sm"><button @click="mintedSecret = null">Dismiss</button></div>
  </div>

  <div v-if="showNew" class="card mt">
    <div class="h-row">
      <input v-model="newName" placeholder="Name" style="flex: 1;" />
      <input v-model="newUrl" placeholder="https://your.callback/endpoint" style="flex: 2;" />
      <button class="primary" :disabled="!newName || !newUrl" @click="create">Create</button>
      <button @click="showNew = false">Cancel</button>
    </div>
  </div>

  <div class="card mt">
    <table>
      <thead><tr><th>Name</th><th>URL</th><th>Events</th><th>Status</th><th></th></tr></thead>
      <tbody>
        <tr v-for="h in hooks" :key="h.id">
          <td>{{ h.name }}</td>
          <td class="muted" style="font-size: 12px;"><code>{{ h.url }}</code></td>
          <td><code>{{ h.events.join(' ') }}</code></td>
          <td><span class="pill" :class="h.isActive ? 'online' : 'offline'">{{ h.isActive ? 'active' : 'paused' }}</span></td>
          <td>
            <button @click="toggle(h)"><Icon :name="h.isActive ? 'pause' : 'play_arrow'" :size="14" />{{ h.isActive ? 'Pause' : 'Resume' }}</button>
            <button @click="regenerate(h)" style="margin-left: 4px;"><Icon name="key" :size="14" />Regen secret</button>
            <button @click="remove(h)" style="margin-left: 4px;"><Icon name="delete" :size="14" />Delete</button>
          </td>
        </tr>
        <tr v-if="!hooks.length"><td colspan="5" class="muted" style="text-align:center; padding: 24px;">no webhooks</td></tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
h1 { font-size: 22px; margin: 0; }
</style>
