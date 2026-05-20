/**
 * Theme preference store, shared by both PRISM SPAs (admin + convert).
 *
 * Three states are persisted under `localStorage["prism.theme"]`:
 *
 *   - `system` (default) — follow `prefers-color-scheme`, live-react
 *                          to OS-level changes via the matchMedia listener.
 *   - `light`            — force the light palette.
 *   - `dark`             — force the ORBIT-aligned dark palette.
 *
 * The actual `data-theme` attribute on `<html>` is set as early as possible
 * by an inline script in each entry HTML (see `admin/index.html` and
 * `convert/index.html`) to avoid a flash of the wrong palette before Vue
 * boots. This module then takes over: it owns the reactive `themePref`
 * ref the toggle component binds to, syncs it to localStorage, and keeps
 * `data-theme` in sync when the user (or OS) changes preference.
 */
import { ref, watch } from 'vue';

export type ThemePref = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'prism.theme';

function loadPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* SSR / privacy mode / sandboxed iframes */
  }
  return 'system';
}

function savePref(v: ThemePref): void {
  try { localStorage.setItem(STORAGE_KEY, v); } catch { /* ignore */ }
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return pref;
}

function applyTheme(pref: ThemePref): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = resolveTheme(pref);
}

/** User's persisted preference. Bind to this from the toggle component. */
export const themePref = ref<ThemePref>(loadPref());

// Apply once at import time. The inline bootstrap script in index.html has
// already done this, but calling it again is a no-op for that case and a
// safety net when this module is loaded outside the SPA entry.
applyTheme(themePref.value);

// Re-resolve when the OS preference flips and we're in `system` mode.
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = (): void => {
    if (themePref.value === 'system') applyTheme('system');
  };
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onChange);
  } else if (typeof mq.addListener === 'function') {
    // Safari < 14 fallback — harmless on modern browsers.
    mq.addListener(onChange);
  }
}

watch(themePref, (v) => {
  savePref(v);
  applyTheme(v);
});

/** Cycle through `system` → `light` → `dark` → `system`. */
export function cycleTheme(): void {
  themePref.value =
    themePref.value === 'system' ? 'light'
    : themePref.value === 'light' ? 'dark'
    : 'system';
}

/** Set theme directly (used by tests / wiring code; toggle button uses cycle). */
export function setTheme(v: ThemePref): void {
  themePref.value = v;
}
