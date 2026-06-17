<script setup lang="ts">
/**
 * ORBIT 3rd-party viewer — embeds @speckle/viewer and loads geometry from
 * ORBIT via the PRISM server proxy (GraphQL version resolve + REST objects).
 * See https://orbit.rebus.industries/docs/building-a-3rd-party-viewer
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { resolveTheme, themePref, type ResolvedTheme } from '../../shared/theme';
import { RouterLink } from 'vue-router';
import {
  Viewer,
  DefaultViewerParams,
  CameraController,
  type CanonicalView,
  LoaderEvent,
  SpeckleType,
  UpdateFlags,
} from '@speckle/viewer';
import type { Vector3 } from 'three';
import { orbitApi, type ApiError, type ModelOrbitRef } from '../../shared/api';
import { buildOrbitModelViewerUrl, orbitServerBaseUrl } from '../utils/orbitViewerUrl';
import { readContainerCssSize } from '../utils/threeResize';
import { ORBIT_VIEWER_LOG, OrbitProxySpeckleLoader } from '../utils/orbitSpeckleLoader';
import { applyOrbitViewerMaterialsStyle, applyOrbitViewerTheme } from '../utils/orbitViewerTheme';
import {
  OrbitWorldHelpers,
  sceneSpanFromViewer,
} from '../utils/orbitViewerWorldHelpers';
import type { OrbitViewerSession } from '../utils/orbitViewerSession';
import Icon from '../../shared/Icon.vue';

export type OrbitViewPreset = 'top' | 'front' | 'side' | 'iso';

const props = withDefaults(defineProps<{
  orbitRef: ModelOrbitRef;
  /** Non-secret admin settings (server URLs). */
  settings?: Record<string, string>;
  fill?: boolean;
  /** Library card / thumbnail — hide chrome, fill parent, no pointer interaction. */
  compact?: boolean;
  interactive?: boolean;
  /** Fixed camera angle for quad ortho panes (iso keeps perspective orbit). */
  viewPreset?: OrbitViewPreset;
  /** World-origin grid + axes; defaults off in compact library thumbnails. */
  showWorldHelpers?: boolean;
  /** Quad view: shared resolve + closure from parent (avoids 4× network download). */
  preloadedSession?: OrbitViewerSession | null;
}>(), {
  settings: () => ({}),
  fill: false,
  compact: false,
  interactive: true,
  viewPreset: 'iso',
  showWorldHelpers: undefined,
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
let modelHasGeometry = false;
let worldHelpers: OrbitWorldHelpers | null = null;
let systemThemeMq: MediaQueryList | null = null;
let onSystemThemeChange: ((e: MediaQueryListEvent) => void) | null = null;

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

const systemPrefersDark = ref(
  typeof window !== 'undefined'
    && !!window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches,
);

const resolvedTheme = computed<ResolvedTheme>(() => {
  if (themePref.value !== 'system') return resolveTheme(themePref.value);
  return systemPrefersDark.value ? 'dark' : 'light';
});

function shouldShowWorldHelpers(): boolean {
  if (props.showWorldHelpers === false) return false;
  if (props.showWorldHelpers === true) return true;
  return !props.compact;
}

function disposeWorldHelpers(): void {
  worldHelpers?.dispose();
  worldHelpers = null;
}

function syncWorldHelpers(v: Viewer, reason: string): void {
  if (!shouldShowWorldHelpers()) {
    disposeWorldHelpers();
    return;
  }
  try {
    if (!worldHelpers) worldHelpers = new OrbitWorldHelpers();
    worldHelpers.attach(v);
    const span = sceneSpanFromViewer(v);
    worldHelpers.rebuild(span, resolvedTheme.value);
    requestViewerRedraw(v, `world-helpers:${reason}`);
    logStep(`viewer:world-helpers (${reason})`, { span });
  } catch (err) {
    console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] world-helpers skipped (${reason})`, err);
    disposeWorldHelpers();
  }
}

function syncViewerTheme(reason: string): void {
  if (!viewer) return;
  applyOrbitViewerTheme(viewer, resolvedTheme.value);
  worldHelpers?.syncTheme(resolvedTheme.value);
  if (worldHelpers) requestViewerRedraw(viewer, `world-helpers-theme:${reason}`);
  if (import.meta.env.DEV) {
    console.log(`${ORBIT_VIEWER_LOG} [${ts()}] theme:${resolvedTheme.value} (${reason})`);
  }
}

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
  const container = v.getContainer();
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
  canvas.style.pointerEvents = props.interactive ? 'auto' : 'none';
  container.style.touchAction = 'none';
  container.style.cursor = props.interactive ? 'grab' : 'default';
}

function orbitCanonicalView(preset: OrbitViewPreset): CanonicalView {
  if (preset === 'top') return 'top';
  if (preset === 'front') return 'front';
  if (preset === 'side') return 'right';
  return '3d';
}

/** Apply top / front / side ortho or iso perspective after load or preset change. */
function applyViewPreset(v: Viewer, reason: string): void {
  if (!v.hasExtension(CameraController)) return;
  const camera = v.getExtension(CameraController);
  const preset = props.viewPreset;
  try {
    if (preset === 'iso') {
      camera.setPerspectiveCameraOn();
      if (modelHasGeometry) {
        camera.setCameraView('3d', false);
      } else {
        camera.setCameraView(undefined, false);
      }
    } else {
      camera.setOrthoCameraOn();
      camera.setCameraView(orbitCanonicalView(preset), false);
    }
    requestViewerRedraw(v, `view-preset:${preset}`);
    logStep(`viewer:view-preset=${preset} (${reason})`);
  } catch (err) {
    console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] view-preset failed`, { preset, err });
  }
}

/** Wire Speckle CameraController (orbit / pan / zoom) to the interactive prop. */
function syncCameraInteractivity(v: Viewer, reason: string): void {
  if (!v.hasExtension(CameraController)) return;
  const camera = v.getExtension(CameraController);
  const allowInteraction = props.interactive && props.viewPreset === 'iso';
  camera.enabled = allowInteraction;
  if (allowInteraction) {
    camera.enableRotations();
    camera.options = {
      ...camera.options,
      enableOrbit: true,
      enableZoom: true,
      enablePan: true,
      touchAction: 'none',
    };
  } else {
    camera.disableRotations();
  }
  styleViewerCanvas(v);
  if (import.meta.env.DEV) {
    logStep(`camera:interactive=${allowInteraction} (${reason})`);
  }
}

function zoomToExtents(): void {
  if (!viewer) return;
  applyViewPreset(viewer, 'zoom-extents');
}

function resetCameraView(): void {
  if (!viewer?.hasExtension(CameraController)) return;
  const camera = viewer.getExtension(CameraController);
  try {
    camera.default();
    applyViewPreset(viewer, 'reset-view');
    logStep('viewer:reset-view');
  } catch (err) {
    console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] reset-view failed`, err);
  }
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

/** Speckle types that produce drawable geometry; used to count render views. */
const RENDERABLE_SPECKLE_TYPES: SpeckleType[] = [
  SpeckleType.Mesh,
  SpeckleType.Brep,
  SpeckleType.Pointcloud,
  SpeckleType.Point,
  SpeckleType.Line,
  SpeckleType.Polyline,
  SpeckleType.Polycurve,
  SpeckleType.Curve,
  SpeckleType.Circle,
  SpeckleType.Arc,
  SpeckleType.Ellipse,
  SpeckleType.Box,
  SpeckleType.Text,
];

function vec3(v: Vector3 | null | undefined): Record<string, number> | null {
  if (!v) return null;
  return {
    x: Number(v.x.toFixed(3)),
    y: Number(v.y.toFixed(3)),
    z: Number(v.z.toFixed(3)),
  };
}

/**
 * Logs what actually made it into the scene after load so we can tell a
 * camera-framing problem (geometry exists, bbox finite) from a converter
 * problem (zero batches / empty bbox => no renderable meshes were produced).
 */
function logSceneDiagnostics(v: Viewer, reason: string): { hasGeometry: boolean } {
  const tree = v.getWorldTree();
  const renderer = v.getRenderer();

  let nodesWithRenderView = 0;
  const typeCounts: Record<string, number> = {};
  try {
    tree.walk((node) => {
      const data = (node as { model?: { renderView?: unknown; raw?: Record<string, unknown> } }).model;
      if (data?.renderView) nodesWithRenderView += 1;
      const speckleType = data?.raw?.speckle_type;
      if (typeof speckleType === 'string') {
        const short = speckleType.split('.').pop() ?? speckleType;
        typeCounts[short] = (typeCounts[short] ?? 0) + 1;
      }
      return true;
    });
  } catch (err) {
    console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] diag:walk failed`, err);
  }

  let renderableRenderViews = 0;
  try {
    const renderTree = tree.getRenderTree();
    renderableRenderViews = renderTree
      ? renderTree.getRenderableRenderViews(...RENDERABLE_SPECKLE_TYPES).length
      : 0;
  } catch (err) {
    console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] diag:renderViews failed`, err);
  }

  let batchCount = 0;
  let meshObjectCount = 0;
  try {
    batchCount = renderer.getBatchIds().length;
    meshObjectCount = renderer.getObjects().length;
  } catch (err) {
    console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] diag:batches failed`, err);
  }

  const box = renderer.sceneBox;
  const sphere = renderer.sceneSphere;
  const boxEmpty = !box || box.isEmpty();
  const size = boxEmpty
    ? null
    : {
        x: Number((box.max.x - box.min.x).toFixed(3)),
        y: Number((box.max.y - box.min.y).toFixed(3)),
        z: Number((box.max.z - box.min.z).toFixed(3)),
      };

  const hasGeometry = batchCount > 0 && !boxEmpty;

  logStep(`diag:scene (${reason})`, {
    nodeCount: tree.nodeCount,
    nodesWithRenderView,
    renderableRenderViews,
    batchCount,
    meshObjectCount,
    typeCounts,
    sceneBoxEmpty: boxEmpty,
    sceneBox: boxEmpty ? null : { min: vec3(box.min), max: vec3(box.max), size },
    sceneCenter: vec3(renderer.sceneCenter),
    sphereRadius: sphere ? Number(sphere.radius.toFixed(3)) : null,
    hasGeometry,
  });

  if (!hasGeometry) {
    console.warn(
      `${ORBIT_VIEWER_LOG} [${ts()}] diag:no-renderable-geometry — ${batchCount} batches, `
        + `sceneBoxEmpty=${boxEmpty}. The converter produced no drawable meshes for this `
        + 'ORBIT version (likely Rhino breps/curves without mesh display values).',
    );
  }

  return { hasGeometry };
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
  if (!viewer && !activeLoader && !worldHelpers) return;
  logStep('dispose', { reason, hadViewer: Boolean(viewer), hadLoader: Boolean(activeLoader) });
  disposeWorldHelpers();
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
  modelHasGeometry = false;
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
    let resolved: {
      projectId: string;
      modelId: string;
      versionId: string;
      rootObjectId: string;
    };

    if (props.preloadedSession) {
      resolved = props.preloadedSession.resolved;
      logStep('resolveViewerVersion:preloaded', {
        projectId: resolved.projectId,
        versionId: resolved.versionId,
        rootObjectId: `${resolved.rootObjectId.slice(0, 12)}…`,
      });
    } else {
      logStep('resolveViewerVersion:start', {
        target: props.orbitRef.target,
        projectId: props.orbitRef.projectId,
        modelId: props.orbitRef.modelId,
        versionId: props.orbitRef.versionId ?? '(latest)',
      });
      const r = await orbitApi.resolveViewerVersion(
        props.orbitRef.target,
        props.orbitRef.projectId,
        props.orbitRef.modelId,
        props.orbitRef.versionId,
      );
      resolved = r;
      logStep('resolveViewerVersion:ok', {
        projectId: resolved.projectId,
        modelId: resolved.modelId,
        versionId: resolved.versionId,
        rootObjectId: `${resolved.rootObjectId.slice(0, 12)}…`,
      });
    }

    if (token !== loadToken) {
      console.warn(`${ORBIT_VIEWER_LOG} [${ts()}] loadModel:stale after resolve`, { loadToken: token });
      return;
    }

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
    syncCameraInteractivity(viewer, 'post-create');
    logStep('viewer:CameraController attached');
    // Disable the Speckle shadowcatcher BEFORE loading geometry. Its render
    // target is sized from the model's bounding box (textureSize / aspect); a
    // flat or empty ORBIT model gives a zero-height aspect, so the catcher
    // bakes a 0-size FBO and floods the context with "Framebuffer is
    // incomplete: Attachment has zero size" every frame. It renders outside
    // SpeckleRenderer.resize(), which is why prior resize fixes had no effect.
    syncViewerTheme('post-init');
    logStep('viewer:theme applied', { theme: resolvedTheme.value });
    viewerResize('post-init', { force: true });
    scheduleViewerResize('post-init-raf');

    activeLoader = new OrbitProxySpeckleLoader(viewer.getWorldTree(), {
      target: props.orbitRef.target,
      projectId: resolved.projectId,
      rootObjectId: resolved.rootObjectId,
      resourceLabel: `${resolved.projectId}/${resolved.versionId.slice(0, 8)}`,
      preloadedObjects: props.preloadedSession?.objects,
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
    const { hasGeometry } = logSceneDiagnostics(viewer, 'post-load');
    modelHasGeometry = hasGeometry;
    applyOrbitViewerMaterialsStyle(viewer);
    syncViewerTheme('post-load-materials');
    logStep('viewer:materials render style (SHADED)');
    await nextTick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    viewerResize('post-load', { force: true });
    scheduleViewerResize('post-load-raf');
    // Explicit zoom-to-fit after the post-load resize so the camera frames the
    // model against the final FBO size. loadObject(…, true) already requests a
    // zoom, but it runs before our forced resize; re-framing here is the fix
    // for the "geometry loaded but off-screen / black canvas" case.
    applyViewPreset(viewer, 'post-load');
    syncWorldHelpers(viewer, 'post-load');
    if (!hasGeometry) {
      console.warn(
        `${ORBIT_VIEWER_LOG} [${ts()}] viewer:zoom-skip — no renderable geometry to frame`,
      );
    }
    syncCameraInteractivity(viewer, 'post-load');
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
  if (typeof window !== 'undefined' && window.matchMedia) {
    systemThemeMq = window.matchMedia('(prefers-color-scheme: dark)');
    onSystemThemeChange = (e: MediaQueryListEvent): void => {
      systemPrefersDark.value = e.matches;
    };
    if (typeof systemThemeMq.addEventListener === 'function') {
      systemThemeMq.addEventListener('change', onSystemThemeChange);
    } else if (typeof systemThemeMq.addListener === 'function') {
      systemThemeMq.addListener(onSystemThemeChange);
    }
  }
  void loadModel();
});

onBeforeUnmount(() => {
  logStep('unmount');
  if (systemThemeMq && onSystemThemeChange) {
    if (typeof systemThemeMq.removeEventListener === 'function') {
      systemThemeMq.removeEventListener('change', onSystemThemeChange);
    } else if (typeof systemThemeMq.removeListener === 'function') {
      systemThemeMq.removeListener(onSystemThemeChange);
    }
  }
  systemThemeMq = null;
  onSystemThemeChange = null;
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

watch(resolvedTheme, () => {
  syncViewerTheme('theme-toggle');
});

watch(() => props.interactive, () => {
  if (viewer) syncCameraInteractivity(viewer, 'interactive-prop');
});

watch(() => props.viewPreset, () => {
  if (viewer) {
    applyViewPreset(viewer, 'view-preset-prop');
    syncCameraInteractivity(viewer, 'view-preset-prop');
  }
});
</script>

<template>
  <div class="orbit-model-viewer" :class="{ fill: fill || compact, compact, static: !interactive }">
    <div v-if="!compact" class="orbit-toolbar">
      <div class="orbit-toolbar-start">
        <span class="orbit-badge">ORBIT viewer</span>
        <span v-if="interactive" class="orbit-controls-hint muted small">
          Drag to orbit · Shift+drag to pan · Scroll to zoom
        </span>
      </div>
      <div class="orbit-toolbar-actions">
        <button
          v-if="interactive"
          type="button"
          class="orbit-nav-btn"
          title="Zoom to fit"
          :disabled="loading || !!error"
          @click="zoomToExtents"
        >
          <Icon name="fit_screen" :size="16" />
        </button>
        <button
          v-if="interactive"
          type="button"
          class="orbit-nav-btn"
          title="Reset view"
          :disabled="loading || !!error"
          @click="resetCameraView"
        >
          <Icon name="restart_alt" :size="16" />
        </button>
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
    </div>
    <div
      ref="hostRef"
      class="orbit-canvas-host"
      :class="{ interactive }"
    />
    <div v-if="loading" class="overlay muted" :class="{ compact }">
      <template v-if="compact">…</template>
      <template v-else>
        Loading ORBIT geometry…
        <span v-if="progress > 0" class="progress">{{ progress }}%</span>
      </template>
    </div>
    <div v-else-if="error && !compact" class="overlay error-panel">
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
  background: var(--color-bg-elevated);
}
.orbit-model-viewer.fill {
  min-height: 0;
  height: 100%;
  border-radius: 0;
}
.orbit-model-viewer.compact {
  min-height: 0;
  height: 100%;
  border-radius: 0;
  background: transparent;
}
.orbit-model-viewer.static {
  pointer-events: none;
}
.orbit-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
  flex-shrink: 0;
  z-index: 2;
}
.orbit-toolbar-start {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.orbit-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.orbit-controls-hint {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.orbit-nav-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-muted, #9aa0a6);
  cursor: pointer;
}
.orbit-nav-btn:hover:not(:disabled) {
  background: var(--color-bg-hover, #2a2a32);
  color: inherit;
}
.orbit-nav-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
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
  background: var(--orbit-viewer-canvas-bg, #e8eaed);
  touch-action: none;
}
.orbit-canvas-host.interactive:active {
  cursor: grabbing;
}
[data-theme="dark"] .orbit-canvas-host {
  --orbit-viewer-canvas-bg: #1a1a1f;
}
.orbit-model-viewer.fill .orbit-canvas-host,
.orbit-model-viewer.compact .orbit-canvas-host {
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
  background: color-mix(in srgb, var(--color-bg-elevated) 88%, transparent);
  z-index: 1;
}
.overlay.compact {
  inset: 0;
  background: color-mix(in srgb, var(--color-bg-elevated) 72%, transparent);
  font-size: 18px;
}
[data-theme="dark"] .overlay.compact {
  background: color-mix(in srgb, var(--color-bg-elevated) 88%, transparent);
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
