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
  'PROGRESSIVE-AO',
]);

/**
 * Speckle {@link ViewMode.SHADED} — the same display style Rhino / ORBIT call
 * "Rendered": PBR `renderMaterial` colours and textures, no technical edges.
 */
export const ORBIT_VIEWER_RENDER_MODE = ViewMode.SHADED;

const RENDER_MODE_OPTIONS = { edges: false } as const;

function viewModesExtension(v: Viewer): ViewModes {
  return v.hasExtension(ViewModes)
    ? v.getExtension(ViewModes)
    : v.createExtension(ViewModes);
}

/**
 * Switch the Speckle pipeline to Rendered (SHADED). Must run after geometry
 * batches exist for best results, but safe to call repeatedly post-`init()`.
 */
export function applyOrbitViewerMaterialsStyle(v: Viewer): void {
  const viewModes = viewModesExtension(v);
  viewModes.setViewMode(ORBIT_VIEWER_RENDER_MODE, RENDER_MODE_OPTIONS);
  v.requestRender(UpdateFlags.RENDER_RESET | UpdateFlags.RENDER | UpdateFlags.SHADOWS);
}

/**
 * Sync Speckle pipeline background + sun/IBL to the PRISM admin theme.
 * Does not change view mode — pair with {@link applyOrbitViewerMaterialsStyle}.
 */
export function applyOrbitViewerTheme(v: Viewer, theme: ResolvedTheme): void {
  const bg = VIEWER_BG[theme];
  v.setLightConfiguration(LIGHT_CONFIG[theme]);

  const pipeline = v.getRenderer().pipeline;
  for (const pass of pipeline.passes) {
    if (CLEAR_COLOR_PASS_NAMES.has(pass.displayName)) {
      pass.setClearColor(bg, 1);
    }
  }

  for (const pass of pipeline.getPass('SHADED')) {
    pass.setClearColor(bg, 1);
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

/** Rendered display mode + PRISM theme — call after init and whenever the scene changes. */
export function applyOrbitViewerRenderStyle(v: Viewer, theme: ResolvedTheme): void {
  applyOrbitViewerMaterialsStyle(v);
  applyOrbitViewerTheme(v, theme);
}

/** True when the viewer pipeline is on Rendered (SHADED) with edges off. */
export function isOrbitViewerRenderedMode(v: Viewer): boolean {
  if (!v.hasExtension(ViewModes)) return false;
  const viewModes = v.getExtension(ViewModes);
  return viewModes.viewMode === ORBIT_VIEWER_RENDER_MODE
    && viewModes.viewModeOptions.edges === false;
}
