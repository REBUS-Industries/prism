<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import DmxModePanel from '../components/DmxModePanel.vue';
import { fixturesApi, type ApiError, type FixtureDetail } from '../../shared/api';

const route = useRoute();
const fixtureId = computed(() => route.params.id as string | undefined);

const fixture = ref<FixtureDetail | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const dmxMapping = computed(() => fixture.value?.definition.dmxMapping ?? { modes: [] });

async function load(): Promise<void> {
  if (!fixtureId.value) {
    error.value = 'Fixture id required';
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const res = await fixturesApi.get(fixtureId.value);
    fixture.value = res.fixture;
  } catch (err) {
    error.value = (err as ApiError).message ?? 'Failed to load fixture';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="dmx-page">
    <header class="page-head">
      <RouterLink :to="{ name: 'fixtures' }" class="back muted">← Fixture library</RouterLink>
      <h1 v-if="fixture">
        DMX charts
        <span class="fixture-ref muted">· {{ fixture.manufacturer }} {{ fixture.fixtureName }}</span>
      </h1>
      <h1 v-else>DMX charts</h1>
    </header>

    <div v-if="loading" class="muted pad">Loading…</div>
    <div v-else-if="error" class="error-box pad">{{ error }}</div>

    <DmxModePanel
      v-else-if="fixture"
      :dmx-mapping="dmxMapping"
      :fixture-name="fixture.fixtureName"
      :manufacturer="fixture.manufacturer"
    />
  </div>
</template>

<style scoped>
.dmx-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1100px;
}
.page-head { display: flex; flex-direction: column; gap: 6px; }
.back { font-size: 12px; text-decoration: none; }
.page-head h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
}
.fixture-ref { font-weight: 500; font-size: 18px; }
.pad { padding: 24px 0; }
</style>
