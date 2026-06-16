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
 * ORBIT / Speckle "Shaded" view mode — renders mesh `renderMaterial` PBR colours
 * and textures instead of the default edge-outline technical drawing style.
 * Must run after geometry batches exist (post-`loadObject`).
 */
export function applyOrbitViewerMaterialsStyle(v: Viewer): void {
  const viewModes = v.hasExtension(ViewModes)
    ? v.getExtension(ViewModes)
    : v.createExtension(ViewModes);
  viewModes.setViewMode(ViewMode.SHADED, { edges: false });
}

/**
 * Sync Speckle pipeline background + sun/IBL to the PRISM admin theme.
 * Safe to call after `viewer.init()` and on every theme toggle.
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
