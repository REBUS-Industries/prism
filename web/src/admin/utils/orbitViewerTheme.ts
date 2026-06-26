import { UpdateFlags, ViewMode, ViewModes, type Viewer } from '@speckle/viewer';
import type { ResolvedTheme } from '../../shared/theme';

/** Canvas / edge-pass colours aligned with ModelViewer & FixtureViewer. */
const VIEWER_BG: Record<ResolvedTheme, number> = {
  light: 0xe8eaed,
  dark: 0x1a1a1f,
};

/** Edge outline tint — darker on light bg, lighter on dark bg. */
const EDGE_OUTLINE: Record<ResolvedTheme, number> = {
  light: 0x888888,
  dark: 0xaaaaaa,
};

const LIGHT_CONFIG: Record<ResolvedTheme, {
  enabled: boolean;
  intensity: number;
  indirectLightIntensity: number;
  shadowcatcher: boolean;
}> = {
  light: {
    enabled: true,
    intensity: 1.15,
    indirectLightIntensity: 1.35,
    shadowcatcher: false,
  },
  dark: {
    enabled: true,
    intensity: 1.0,
    indirectLightIntensity: 1.2,
    shadowcatcher: false,
  },
};

/** Depth / MRT passes that clear to the scene background before compositing. */
const CLEAR_COLOR_PASS_NAMES = new Set([
  'DEPTH',
  'DEPTH-NORMAL',
  'DEPTH-NORMAL-ID',
  // Do NOT include PROGRESSIVE-AO — Speckle runs that pass when the camera is
  // idle; clearing it to the dark bg drives AO toward zero and darkens the model.
]);

/**
 * Speckle {@link ViewMode.DEFAULT} with edges off — the GeometryPass that
 * renders real `SpeckleStandardMaterial` PBR (renderMaterial colours + textures),
 * matching ORBIT's "Rendered" display. NOTE: ViewMode.SHADED is NOT this — its
 * pipeline draws a flat discreet-colour ramp per material (no textures, grey
 * fallback), which is why materials looked unshaded.
 */
export const ORBIT_VIEWER_RENDER_MODE = ViewMode.DEFAULT;

const RENDER_MODE_OPTIONS = { edges: false } as const;

function viewModesExtension(v: Viewer): ViewModes {
  return v.hasExtension(ViewModes)
    ? v.getExtension(ViewModes)
    : v.createExtension(ViewModes);
}

/**
 * Switch the Speckle pipeline to Rendered (DEFAULT geometry pass, edges off).
 * Must run after geometry batches exist. Speckle dedupes identical mode/options
 * internally — safe to call after resize / view-preset (never from LoadComplete).
 */
export function applyOrbitViewerMaterialsStyle(v: Viewer): void {
  try {
    const viewModes = viewModesExtension(v);
    viewModes.setViewMode(ORBIT_VIEWER_RENDER_MODE, RENDER_MODE_OPTIONS);
    v.requestRender(UpdateFlags.RENDER_RESET | UpdateFlags.RENDER | UpdateFlags.SHADOWS);
  } catch (err) {
    console.warn('[OrbitViewer] Rendered view mode failed — keeping default pipeline', err);
  }
}

/**
 * Sync Speckle pipeline background + sun/IBL to the PRISM admin theme.
 * Does not change view mode — pair with {@link applyOrbitViewerMaterialsStyle}.
 */
export function applyOrbitViewerTheme(v: Viewer, theme: ResolvedTheme): void {
  const bg = VIEWER_BG[theme];
  v.setLightConfiguration(LIGHT_CONFIG[theme]);

  // Background comes from the renderer's clear colour, NOT the geometry passes.
  // Calling setClearColor on a GEOMETRY pass makes it clear the colour buffer
  // (base GPass.clear() clears whenever _clearColor is set); since DEFAULT mode
  // has multiple GEOMETRY passes (opaque + transparent) sharing a target, the
  // later pass wipes the meshes the earlier one drew → nothing renders.
  v.getRenderer().renderer.setClearColor(bg, 1);
  const pipeline = v.getRenderer().pipeline;
  for (const pass of pipeline.passes) {
    if (CLEAR_COLOR_PASS_NAMES.has(pass.displayName)) {
      pass.setClearColor(bg, 1);
    }
  }

  for (const pass of pipeline.getPass('EDGES')) {
    pass.options = {
      ...pass.options,
      backgroundColor: bg,
      outlineColor: EDGE_OUTLINE[theme],
    };
  }

  v.requestRender(UpdateFlags.RENDER_RESET | UpdateFlags.RENDER | UpdateFlags.SHADOWS);
}

/** Rendered (DEFAULT geometry) display mode + PRISM theme — call after geometry + final resize. */
export function applyOrbitViewerRenderStyle(v: Viewer, theme: ResolvedTheme): void {
  applyOrbitViewerMaterialsStyle(v);
  applyOrbitViewerTheme(v, theme);
}

/** True when the viewer pipeline is on Rendered (DEFAULT geometry) with edges off. */
export function isOrbitViewerRenderedMode(v: Viewer): boolean {
  if (!v.hasExtension(ViewModes)) return false;
  const viewModes = v.getExtension(ViewModes);
  return viewModes.viewMode === ORBIT_VIEWER_RENDER_MODE
    && viewModes.viewModeOptions.edges !== true;
}
