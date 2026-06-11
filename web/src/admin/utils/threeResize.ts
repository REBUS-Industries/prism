/** Max CSS pixel dimension passed to WebGLRenderer.setSize (before DPR). */
export const THREE_MAX_CSS_DIM = 8192;

export function clampThreeCssSize(width: number, height: number): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (w <= 0 || h <= 0) return null;
  if (w > THREE_MAX_CSS_DIM || h > THREE_MAX_CSS_DIM) {
    const scale = THREE_MAX_CSS_DIM / Math.max(w, h);
    return {
      width: Math.max(1, Math.floor(w * scale)),
      height: Math.max(1, Math.floor(h * scale)),
    };
  }
  return { width: w, height: h };
}

/** Bounded device pixel ratio for Three.js renderers. */
export function threePixelRatio(): number {
  const dpr = window.devicePixelRatio;
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(dpr, 2);
}

/**
 * Read a container's laid-out size. Prefer getBoundingClientRect; fall back to
 * clientWidth/Height only when the rect is not yet available.
 */
export function readContainerCssSize(el: HTMLElement): { width: number; height: number } | null {
  const rect = el.getBoundingClientRect();
  let width = rect.width;
  let height = rect.height;
  if (width <= 0 || height <= 0) {
    width = el.clientWidth;
    height = el.clientHeight;
  }
  return clampThreeCssSize(width, height);
}
