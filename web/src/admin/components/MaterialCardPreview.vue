<script setup lang="ts">
/**
 * Material library card thumbnail. Uses the persisted albedo / captured preview
 * image when available; otherwise lazy-loads material detail and renders a
 * compact flat swatch (same look as the editor preview).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import MaterialPreviewSwatch from './MaterialPreviewSwatch.vue';
import {
  DEFAULT_MATERIAL_PARAMETERS,
  materialsApi,
  texturesApi,
  type MaterialDetail,
  type MaterialParameters,
  type MaterialSlot,
} from '../../shared/api';

const props = defineProps<{
  materialId: string;
  thumbnailTextureId: string | null;
  alt: string;
}>();

const emit = defineEmits<{
  /** Emitted after a captured preview is persisted from the editor. */
  thumbnailUpdated: [textureId: string];
}>();

const rootRef = ref<HTMLElement | null>(null);
const shouldRender = ref(false);
const loading = ref(false);
const detail = ref<MaterialDetail | null>(null);
const failed = ref(false);

const staticUrl = computed(() =>
  props.thumbnailTextureId ? texturesApi.previewUrl(props.thumbnailTextureId) : null,
);

const sources = computed<Partial<Record<MaterialSlot, string>>>(() => {
  if (!detail.value) return {};
  const map: Partial<Record<MaterialSlot, string>> = {};
  for (const s of detail.value.slots) map[s.slot] = s.texture.previewUrl ?? texturesApi.previewUrl(s.textureId);
  return map;
});

const parameters = computed<MaterialParameters>(() =>
  detail.value
    ? { ...DEFAULT_MATERIAL_PARAMETERS, ...detail.value.parameters }
    : { ...DEFAULT_MATERIAL_PARAMETERS },
);

let observer: IntersectionObserver | null = null;

async function loadPreview(): Promise<void> {
  if (staticUrl.value || detail.value || loading.value || failed.value) return;
  loading.value = true;
  try {
    detail.value = await materialsApi.get(props.materialId);
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  if (staticUrl.value) return;
  const el = rootRef.value;
  if (!el || typeof IntersectionObserver === 'undefined') {
    shouldRender.value = true;
    void loadPreview();
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        shouldRender.value = true;
        void loadPreview();
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

/** Allow parent list to swap in a persisted thumbnail without re-fetching detail. */
defineExpose({
  setThumbnail(textureId: string): void {
    emit('thumbnailUpdated', textureId);
  },
});
</script>

<template>
  <span ref="rootRef" class="material-card-preview">
    <img v-if="staticUrl" :src="staticUrl" :alt="alt" loading="lazy" />
    <MaterialPreviewSwatch
      v-else-if="shouldRender && detail"
      :sources="sources"
      :parameters="parameters"
    />
    <span v-else-if="failed" class="preview-placeholder subtle">No preview</span>
    <span v-else-if="shouldRender && loading" class="preview-placeholder subtle">…</span>
    <span v-else class="preview-placeholder subtle">Preview</span>
  </span>
</template>

<style scoped>
.material-card-preview {
  display: block;
  width: 100%;
  height: 100%;
}
.material-card-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.material-card-preview :deep(.material-preview-swatch) {
  width: 100%;
  height: 100%;
  min-height: 0;
}
.preview-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 12px;
}
</style>
