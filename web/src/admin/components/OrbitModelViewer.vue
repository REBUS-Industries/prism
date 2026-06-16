<script setup lang="ts">
/**
 * ORBIT 3rd-party viewer — embeds @speckle/viewer and loads geometry from
 * ORBIT via the PRISM server proxy (GraphQL version resolve + REST objects).
 * See https://orbit.rebus.industries/docs/building-a-3rd-party-viewer
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
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
let resizeObs: ResizeObserver | null = null;
let loadToken = 0;

const orbitWebUrl = buildOrbitModelViewerUrl(
  orbitServerBaseUrl(props.settings, props.orbitRef.target),
  props.orbitRef,
);

const showSettingsLink = computed(() => Boolean(
  error.value && /settings|token|configured|access denied/i.test(error.value),
));

function viewerResize(): void {
  if (viewer && hostRef.value) viewer.resize();
}

function setupResizeObserver(): void {
  resizeObs?.disconnect();
  const el = hostRef.value;
  if (!el) return;
  resizeObs = new ResizeObserver(() => viewerResize());
  resizeObs.observe(el);
  requestAnimationFrame(() => viewerResize());
}

async function disposeViewer(): Promise<void> {
  activeLoader?.cancel();
  activeLoader?.dispose();
  activeLoader = null;
  if (viewer) {
    viewer.dispose();
    viewer = null;
  }
}

function formatLoadError(err: unknown, target: 'prod' | 'dev'): string {
  const e = err as ApiError;
  if (e.status === 412) {
    return `ORBIT ${target} not configured — set server URL + API token in Settings.`;
  }
  if (e.status === 401 || e.status === 403) {
    return `ORBIT ${target} token rejected — update the API token in Settings.`;
  }
  const msg = e.message ?? (err as Error)?.message;
  if (msg) return msg;
  return 'Failed to load ORBIT model';
}

async function loadModel(): Promise<void> {
  const token = ++loadToken;
  await nextTick();
  const host = hostRef.value;
  if (!host) return;

  loading.value = true;
  progress.value = 0;
  error.value = null;
  await disposeViewer();
  host.replaceChildren();
  setupResizeObserver();

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
    viewerResize();
    requestAnimationFrame(() => viewerResize());

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
    viewerResize();
    requestAnimationFrame(() => viewerResize());
  } catch (err) {
    if (token !== loadToken) return;
    error.value = formatLoadError(err, props.orbitRef.target);
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

onMounted(() => {
  void loadModel();
});

onBeforeUnmount(() => {
  loadToken += 1;
  resizeObs?.disconnect();
  resizeObs = null;
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
    <div v-else-if="error" class="overlay error-panel">
      <p class="error-box">{{ error }}</p>
      <RouterLink v-if="showSettingsLink" :to="{ name: 'settings' }" class="settings-link">
        Open Settings →
      </RouterLink>
    </div>
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
  min-height: 240px;
  width: 100%;
  background: #0e0e12;
}
.orbit-model-viewer.fill .orbit-canvas-host {
  min-height: 0;
}
.overlay {
  position: absolute;
  inset: 36px 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
  text-align: center;
  background: rgba(14, 14, 18, 0.82);
  z-index: 1;
}
.error-panel .error-box {
  max-width: 420px;
  margin: 0;
}
.settings-link {
  font-size: 13px;
  color: var(--orbit-primary, #ff8800);
  text-decoration: none;
}
.settings-link:hover { text-decoration: underline; }
.progress { font-variant-numeric: tabular-nums; font-size: 12px; }
</style>
