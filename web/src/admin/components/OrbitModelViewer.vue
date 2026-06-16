<script setup lang="ts">
/**
 * ORBIT 3rd-party viewer — embeds @speckle/viewer and loads geometry from
 * ORBIT via the PRISM server proxy (GraphQL version resolve + REST objects).
 * See https://orbit.rebus.industries/docs/building-a-3rd-party-viewer
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Viewer,
  DefaultViewerParams,
  CameraController,
  LoaderEvent,
} from '@speckle/viewer';
import { orbitApi, type ApiError, type ModelOrbitRef } from '../../shared/api';
import { buildOrbitModelViewerUrl, orbitServerBaseUrl } from '../utils/orbitViewerUrl';
import { OrbitProxySpeckleLoader } from '../utils/orbitSpeckleLoader';

const props = withDefaults(defineProps<{
  orbitRef: ModelOrbitRef;
  /** Non-secret admin settings (server URLs). */
  settings?: Record<string, string>;
  fill?: boolean;
}>(), {
  settings: () => ({}),
  fill: false,
});

const hostRef = ref<HTMLDivElement | null>(null);
const loading = ref(true);
const progress = ref(0);
const error = ref<string | null>(null);

let viewer: Viewer | null = null;
let activeLoader: OrbitProxySpeckleLoader | null = null;
let loadToken = 0;

const orbitWebUrl = buildOrbitModelViewerUrl(
  orbitServerBaseUrl(props.settings, props.orbitRef.target),
  props.orbitRef,
);

async function disposeViewer(): Promise<void> {
  activeLoader?.cancel();
  activeLoader?.dispose();
  activeLoader = null;
  if (viewer) {
    viewer.dispose();
    viewer = null;
  }
}

async function loadModel(): Promise<void> {
  const token = ++loadToken;
  const host = hostRef.value;
  if (!host) return;

  loading.value = true;
  progress.value = 0;
  error.value = null;
  await disposeViewer();
  host.replaceChildren();

  try {
    const resolved = await orbitApi.resolveViewerVersion(
      props.orbitRef.target,
      props.orbitRef.projectId,
      props.orbitRef.modelId,
      props.orbitRef.versionId,
    );
    if (token !== loadToken) return;

    const params = { ...DefaultViewerParams, verbose: import.meta.env.DEV };
    viewer = new Viewer(host, params);
    await viewer.init();
    viewer.createExtension(CameraController);

    activeLoader = new OrbitProxySpeckleLoader(viewer.getWorldTree(), {
      target: props.orbitRef.target,
      projectId: resolved.projectId,
      rootObjectId: resolved.rootObjectId,
      resourceLabel: `${resolved.projectId}/${resolved.versionId.slice(0, 8)}`,
    });
    activeLoader.on(LoaderEvent.LoadProgress, (payload) => {
      progress.value = Math.round((payload.progress ?? 0) * 100);
    });

    await viewer.loadObject(activeLoader, true);
    if (token !== loadToken) return;
  } catch (err) {
    if (token !== loadToken) return;
    const e = err as ApiError;
    if (e.status === 412) {
      error.value = `ORBIT ${props.orbitRef.target} not configured — set URL + token in Settings.`;
    } else {
      error.value = e.message ?? 'Failed to load ORBIT model';
    }
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

onMounted(() => {
  void loadModel();
});

onBeforeUnmount(() => {
  loadToken += 1;
  void disposeViewer();
});

watch(
  () => [
    props.orbitRef.target,
    props.orbitRef.projectId,
    props.orbitRef.modelId,
    props.orbitRef.versionId,
  ],
  () => { void loadModel(); },
);
</script>

<template>
  <div class="orbit-model-viewer" :class="{ fill }">
    <div class="orbit-toolbar">
      <span class="orbit-badge">ORBIT viewer</span>
      <a
        v-if="orbitWebUrl"
        :href="orbitWebUrl"
        class="orbit-open"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open in Orbit ↗
      </a>
    </div>
    <div ref="hostRef" class="orbit-canvas-host" />
    <div v-if="loading" class="overlay muted">
      Loading ORBIT geometry…
      <span v-if="progress > 0" class="progress">{{ progress }}%</span>
    </div>
    <div v-else-if="error" class="overlay error-box">{{ error }}</div>
  </div>
</template>

<style scoped>
.orbit-model-viewer {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 320px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-2, #1a1a1f);
}
.orbit-model-viewer.fill {
  min-height: 0;
  height: 100%;
  border-radius: 0;
}
.orbit-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-border, #2a2a32);
  background: var(--surface-1, #121216);
  flex-shrink: 0;
  z-index: 2;
}
.orbit-badge {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--orbit-primary, #ff8800);
}
.orbit-open {
  font-size: 12px;
  color: inherit;
  text-decoration: none;
}
.orbit-open:hover { text-decoration: underline; }
.orbit-canvas-host {
  flex: 1;
  min-height: 0;
  width: 100%;
  background: #0e0e12;
}
.overlay {
  position: absolute;
  inset: 36px 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 16px;
  text-align: center;
  background: rgba(14, 14, 18, 0.82);
  z-index: 1;
}
.progress { font-variant-numeric: tabular-nums; font-size: 12px; }
</style>
