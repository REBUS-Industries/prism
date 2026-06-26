<script setup lang="ts">
/**
 * Model library card thumbnail. Prefers a cached Orbit preview PNG from the
 * models service; falls back to a compact embedded ORBIT viewer or local GLB.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { modelsApi, type ModelOrbitRef } from '../../shared/api';
import Icon from '../../shared/Icon.vue';
import ModelViewer from './ModelViewer.vue';
import OrbitModelViewer from './OrbitModelViewer.vue';
import { readModelOrbitRef } from '../utils/orbitViewerUrl';

const props = withDefaults(defineProps<{
  modelId: string;
  hasPreview: boolean;
  hasThumbnail?: boolean;
  alt: string;
  orbitSettings?: Record<string, string>;
}>(), {
  hasThumbnail: false,
  orbitSettings: () => ({}),
});

const rootRef = ref<HTMLElement | null>(null);
const shouldRender = ref(false);
const loading = ref(false);
const orbitRef = ref<ModelOrbitRef | null>(null);
const detailChecked = ref(false);
const imgFailed = ref(false);

const staticUrl = computed(() =>
  props.hasThumbnail ? modelsApi.thumbnailUrl(props.modelId) : null,
);

const showStaticImage = computed(() =>
  shouldRender.value && Boolean(staticUrl.value && !imgFailed.value),
);

const showOrbit = computed(() =>
  shouldRender.value
  && Boolean(orbitRef.value)
  && !showStaticImage.value
  && detailChecked.value,
);

const showGlbViewer = computed(() =>
  shouldRender.value
  && props.hasPreview
  && imgFailed.value
  && !orbitRef.value
  && !props.hasThumbnail
  && detailChecked.value,
);

const showPlaceholder = computed(() =>
  !showStaticImage.value
  && !showOrbit.value
  && !showGlbViewer.value
  && (!loading.value || detailChecked.value),
);

let observer: IntersectionObserver | null = null;

async function loadPreviewSource(): Promise<void> {
  if (detailChecked.value || loading.value) return;
  loading.value = true;
  try {
    const res = await modelsApi.get(props.modelId);
    orbitRef.value = readModelOrbitRef(res.model.definition);
  } catch {
    // Non-fatal — fall back to the cube placeholder.
  } finally {
    detailChecked.value = true;
    loading.value = false;
  }
}

function onImgError(): void {
  imgFailed.value = true;
  if (shouldRender.value) void loadPreviewSource();
}

function beginLazyLoad(): void {
  if (shouldRender.value) return;
  shouldRender.value = true;
  if (!props.hasThumbnail) void loadPreviewSource();
}

onMounted(() => {
  const el = rootRef.value;
  if (!el || typeof IntersectionObserver === 'undefined') {
    beginLazyLoad();
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        beginLazyLoad();
        observer?.disconnect();
        observer = null;
      }
    },
    { rootMargin: '120px' },
  );
  observer.observe(el);
});

onBeforeUnmount(() => {
  observer?.disconnect();
});
</script>

<template>
  <span ref="rootRef" class="model-card-preview">
    <img
      v-if="showStaticImage"
      :src="staticUrl!"
      :alt="alt"
      loading="lazy"
      @error="onImgError"
    />
    <OrbitModelViewer
      v-else-if="showOrbit && orbitRef"
      :orbit-ref="orbitRef"
      :settings="orbitSettings"
      compact
      :interactive="false"
    />
    <ModelViewer
      v-else-if="showGlbViewer"
      :url="modelsApi.previewUrl(modelId)"
      view-preset="iso"
      :interactive="false"
      light-background
      fill
    />
    <Icon v-else-if="showPlaceholder" name="deployed_code" :size="40" class="thumb-fallback" />
    <span v-else-if="loading" class="preview-loading muted small">…</span>
  </span>
</template>

<style scoped>
.model-card-preview {
  display: block;
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
}
.model-card-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.model-card-preview :deep(.orbit-model-viewer) {
  width: 100%;
  height: 100%;
  min-height: 0;
  border-radius: 0;
}
.model-card-preview :deep(.model-viewer) {
  width: 100%;
  height: 100%;
}
.thumb-fallback {
  position: absolute;
  inset: 0;
  margin: auto;
  opacity: 0.3;
}
.preview-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
