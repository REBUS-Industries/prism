<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';

const props = defineProps<{ id: string }>();
const router = useRouter();

onMounted(() => {
  router.replace({
    name: 'fixture-editor',
    params: { id: props.id },
    query: { tab: 'debug' },
  });
});
</script>

<template>
  <p class="muted redirect-msg">Opening fixture debug…</p>
</template>

<style scoped>
.redirect-msg {
  padding: 24px;
  text-align: center;
}
</style>
