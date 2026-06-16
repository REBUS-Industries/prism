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
  UpdateFlags,
} from '@speckle/viewer';
import { orbitApi, type ApiError, type ModelOrbitRef } from '../../shared/api';
import { buildOrbitModelViewerUrl, orbitServerBaseUrl } from '../utils/orbitViewerUrl';
import { readContainerCssSize } from '../utils/threeResize';
import { ORBIT_VIEWER_LOG, OrbitProxySpeckleLoader } from '../utils/orbitSpeckleLoader';

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
let resizeRaf = 0;
let lastResizeW = 0;
let lastResizeH = 0;
let loadToken = 0;
let loadStep = 0;

const HOST_LAYOUT_MAX_FRAMES = 90;

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function hostDims(el: HTMLElement | null): Record<string, number> | null {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    clientW: Math.round(rect.width),
    clientH: Math.round(rect.height),
    offsetW: el.offsetWidth,
    offsetH: el.offsetHeight,
  };
}

function logStep(message: string, detail?: unknown): void {
  loadStep += 1;
  if (detail !== undefined) {
    console.log(`${ORBIT_VIEWER_LOG} [${ts()}] #${loadStep} ${message}`, detail);
  } else {
    console.log(`${ORBIT_VIEWER_LOG} [${ts()}] #${loadStep} ${message}`);
  }
}

const orbitWebUrl = buildOrbitModelViewerUrl(
  orbitServerBaseUrl(props.settings, props.orbitRef.target),
  props.orbitRef,
);

const showSettingsLink = computed(() => Boolean(
  error.value && /settings|token|configured|access denied/i.test(error.value),
));

/** Speckle Viewer.resize() reads container.offsetWidth/offsetHeight — sync those from layout. */
function syncHostLayoutSize(host: HTMLElement, size: { width: number; height: number }): void {
  host.style.width = `${size.width}px`;
  host.style.height = `${size.height}px`;
}

/** Keep host offsetWidth/offsetHeight in sync even before the Speckle viewer exists. */
function syncHostLayoutFromContainer(host: HTMLElement): { width: number; height: number } | null {
  const size = readContainerCssSize(host);
  if (!size) return null;
  syncHostLayoutSize(host, size);
  return size;
}

function styleViewerCanvas(v: Viewer): void {
  const canvas = v.getCanvas();
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
}

function logWebGlDimensions(v: Viewer, host: HTMLElement, reason: string): void {
  const canvas = v.getCanvas();
  const container = v.getContainer();
  logStep(`webgl-dims (${reason})`, {
    host: hostDims(host),
    container: {
      offsetW: container.offsetWidth,
      offsetH: container.offsetHeight,
      clientW: container.clientWidth,
      clientH: container.clientHeight,
    },
    canvas: {
      bufferW: canvas.width,
      bufferH: canvas.height,
      cssW: canvas.clientWidth,
      cssH: canvas.clientHeight,
      offsetW: canvas.offsetWidth,
      offsetH: canvas.offsetHeight,
    },
  });
}

function requestViewerRedraw(v: Viewer, reason: string): void {
  v.requestRender(UpdateFlags.RENDER_RESET | UpdateFlags.RENDER | UpdateFlags.SHADOWS);
  if (import.meta.env.DEV) {
    console.log(`${ORBIT_VIEWER_LOG} [${ts()}] requestRender (${reason})`);
  }
}

async function waitForHostLayout(host: HTMLElement, reason: string): Promise<{ width: number; height: number } | null> {
  for (let frame = 0; frame < HOST_LAYOUT_MAX_FRAMES; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const size = readContainerCssSize(host);
    if (size) {
      syncHostLayoutSize(host, size);
      logStep(`host:layout-ready (${reason})`, { ...hostDims(host), applied: size, frame });
      return size;
    }
  }
  const size = readContainerCssSize(host);
  if (size) syncHostLayoutSize(host, size);
  logStep(`host:layout-timeout (${reason})`, hostDims(host));
  return size;
}

/**
 * Resize Speckle's WebGL pipeline using explicit CSS dimensions.
 * viewer.resize() only reads offsetWidth/offsetHeight; in flex panes those can
 * lag getBoundingClientRect. SpeckleRenderer.resize(w,h) sizes the FBOs directly.
 */
function viewerResize(reason: string, opts?: { force?: boolean }): void {
  if (!viewer || !hostRef.value) return;
  const host = hostRef.value;
  const size = syncHostLayoutFromContainer(host);
  if (!size) {
    console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] resize:skip (${reason}) — zero container`);
    return;
  }
  if (
    !opts?.force
    && size.width === lastResizeW
    && size.height === lastResizeH
    && reason === 'resize-observer'
  ) {
    return;
  }

  lastResizeW = size.width;
  lastResizeH = size.height;

  console.log(`${ORBIT_VIEWER_LOG} [${ts()}] resize`, { reason, dims: hostDims(host), applied: size });
  viewer.getRenderer().resize(size.width, size.height);
  viewer.resize();
  logWebGlDimensions(viewer, host, reason);

  const canvas = viewer.getCanvas();
  if (canvas.width <= 0 || canvas.height <= 0) {
    console.error(`${ORBIT_VIEWER_LOG} [${ts()}] resize:zero-buffer (${reason})`, {
      applied: size,
      canvas: { bufferW: canvas.width, bufferH: canvas.height },
    });
  } else {
    requestViewerRedraw(viewer, reason);
  }
}

function scheduleViewerResize(reason: string): void {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    viewerResize(reason);
  });
}

function setupResizeObserver(): void {
  resizeObs?.disconnect();
  const el = hostRef.value;
  if (!el) return;
  logStep('resize-observer:setup', hostDims(el));
  resizeObs = new ResizeObserver(() => {
    syncHostLayoutFromContainer(el);
    scheduleViewerResize('resize-observer');
  });
  resizeObs.observe(el);
  scheduleViewerResize('setup-raf');
}

async function disposeViewer(reason: string): Promise<void> {
  if (!viewer && !activeLoader) return;
  logStep('dispose', { reason, hadViewer: Boolean(viewer), hadLoader: Boolean(activeLoader) });
  activeLoader?.cancel();
  activeLoader?.dispose();
  activeLoader = null;
  if (viewer) {
    viewer.dispose();
    viewer = null;
  }
  lastResizeW = 0;
  lastResizeH = 0;
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
  loadStep = 0;
  logStep('loadModel:start', {
    loadToken: token,
    orbitRef: {
      target: props.orbitRef.target,
      projectId: props.orbitRef.projectId,
      modelId: props.orbitRef.modelId,
      versionId: props.orbitRef.versionId,
    },
    fill: props.fill,
  });

  await nextTick();
  const host = hostRef.value;
  if (!host) {
    console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] loadModel:abort — host ref missing`);
    return;
  }
  logStep('host:ready', hostDims(host));

  loading.value = true;
  progress.value = 0;
  error.value = null;
  await disposeViewer('reload');
  host.replaceChildren();
  host.style.width = '';
  host.style.height = '';
  setupResizeObserver();

  const initialLayout = await waitForHostLayout(host, 'pre-resolve');
  if (token !== loadToken) return;
  if (!initialLayout) {
    error.value = 'Viewer area has no size yet — wait for layout or widen the preview pane.';
    loading.value = false;
    return;
  }

  try {
    logStep('resolveViewerVersion:start', {
      target: props.orbitRef.target,
      projectId: props.orbitRef.projectId,
      modelId: props.orbitRef.modelId,
      versionId: props.orbitRef.versionId ?? '(latest)',
    });
    const resolved = await orbitApi.resolveViewerVersion(
      props.orbitRef.target,
      props.orbitRef.projectId,
      props.orbitRef.modelId,
      props.orbitRef.versionId,
    );
    if (token !== loadToken) {
      console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] loadModel:stale after resolve`, { loadToken: token });
      return;
    }
    logStep('resolveViewerVersion:ok', {
      projectId: resolved.projectId,
      modelId: resolved.modelId,
      versionId: resolved.versionId,
      rootObjectId: `${resolved.rootObjectId.slice(0, 12)}…`,
    });

    const layout = await waitForHostLayout(host, 'pre-viewer');
    if (token !== loadToken) {
      console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] loadModel:stale after layout`, { loadToken: token });
      return;
    }
    if (!layout) {
      throw new Error('Viewer container collapsed to zero size before init.');
    }

    const params = { ...DefaultViewerParams, verbose: import.meta.env.DEV };
    logStep('viewer:new', { verbose: params.verbose, hostDims: hostDims(host), layout });
    viewer = new Viewer(host, params);
    styleViewerCanvas(viewer);
    viewerResize('post-constructor', { force: true });
    logStep('viewer:init start');
    await viewer.init();
    logStep('viewer:init complete');
    viewer.createExtension(CameraController);
    logStep('viewer:CameraController attached');
    // Disable the Speckle shadowcatcher BEFORE loading geometry. Its render
    // target is sized from the model's bounding box (textureSize / aspect); a
    // flat or empty ORBIT model gives a zero-height aspect, so the catcher
    // bakes a 0-size FBO and floods the context with "Framebuffer is
    // incomplete: Attachment has zero size" every frame. It renders outside
    // SpeckleRenderer.resize(), which is why prior resize fixes had no effect.
    viewer.setLightConfiguration({ shadowcatcher: false });
    logStep('viewer:shadowcatcher disabled');
    viewerResize('post-init', { force: true });
    scheduleViewerResize('post-init-raf');

    activeLoader = new OrbitProxySpeckleLoader(viewer.getWorldTree(), {
      target: props.orbitRef.target,
      projectId: resolved.projectId,
      rootObjectId: resolved.rootObjectId,
      resourceLabel: `${resolved.projectId}/${resolved.versionId.slice(0, 8)}`,
    });
    activeLoader.on(LoaderEvent.LoadProgress, (payload) => {
      progress.value = Math.round((payload.progress ?? 0) * 100);
    });

    logStep('viewer:loadObject start', { resource: activeLoader.resource });
    await viewer.loadObject(activeLoader, true);
    if (token !== loadToken) {
      console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] loadModel:stale after loadObject`, { loadToken: token });
      return;
    }
    logStep('viewer:loadObject complete', {
      resource: activeLoader.resource,
      finished: activeLoader.finished,
      progress: progress.value,
    });
    await nextTick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    viewerResize('post-load', { force: true });
    scheduleViewerResize('post-load-raf');
  } catch (err) {
    if (token !== loadToken) return;
    console.error(`${ORBIT_VIEWER_LOG} [${ts()}] loadModel:error`, {
      loadToken: token,
      orbitRef: props.orbitRef,
      error: err,
      apiStatus: (err as ApiError)?.status,
      message: (err as Error)?.message,
    });
    error.value = formatLoadError(err, props.orbitRef.target);
  } finally {
    if (token === loadToken) {
      loading.value = false;
      logStep('loadModel:done', { error: error.value, progress: progress.value });
    }
  }
}

onMounted(() => {
  logStep('mounted', { hostDims: hostDims(hostRef.value), orbitRef: props.orbitRef });
  void loadModel();
});

onBeforeUnmount(() => {
  logStep('unmount');
  loadToken += 1;
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = 0;
  resizeObs?.disconnect();
  resizeObs = null;
  void disposeViewer('unmount');
});

watch(
  () => [
    props.orbitRef.target,
    props.orbitRef.projectId,
    props.orbitRef.modelId,
    props.orbitRef.versionId,
  ],
  (next, prev) => {
    console.log(`${ORBIT_VIEWER_LOG} [${ts()}] orbitRef changed`, { prev, next });
    void loadModel();
  },
);

watch(loading, (isLoading, wasLoading) => {
  if (wasLoading && !isLoading && viewer) {
    scheduleViewerResize('loading-overlay-removed');
  }
});
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
  position: relative;
  overflow: hidden;
  background: #0e0e12;
}
.orbit-model-viewer.fill .orbit-canvas-host {
  min-height: 0;
  height: 100%;
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
