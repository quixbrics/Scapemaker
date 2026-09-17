/*
 * Dark/light theme switch (UI spec §2.7). Default dark. Persist to localStorage
 * under `scapemaker.theme`, wrapped in try/catch. Do NOT follow
 * prefers-color-scheme automatically.
 */

const KEY = 'scapemaker.theme';
export type Theme = 'dark' | 'light';

const listeners = new Set<(t: Theme) => void>();

export function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' ? 'light' : 'dark';
}

export function initTheme(): Theme {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    /* lab machines may block storage */
  }
  const theme: Theme = stored === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  return theme;
}

export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn(theme);
}

export function toggleTheme(): void {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

/** Canvas/SVG code re-reads tokens on theme change rather than caching them. */
export function onThemeChange(fn: (t: Theme) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resolve a CSS custom property to its computed value (for canvas painting). */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Token resolved to `rgb` components, cached per theme.
 *
 * Resolving one meant appending a div to the body and reading its computed
 * colour — a forced style recalculation, and the master heatmap calls it once
 * per bucket on every repaint. The cache is cleared whenever the theme
 * changes, which is the only time these values can move.
 */
const rgbCache = new Map<string, string | null>();
listeners.add(() => rgbCache.clear());

function tokenRgb(name: string): string | null {
  const key = `${currentTheme()}:${name}`;
  const hit = rgbCache.get(key);
  if (hit !== undefined) return hit;

  const el = document.createElement('div');
  el.style.color = token(name);
  document.body.appendChild(el);
  const rgb = getComputedStyle(el).color;
  el.remove();
  const m = rgb.match(/(\d+),\s*(\d+),\s*(\d+)/);
  const value = m ? `${m[1]}, ${m[2]}, ${m[3]}` : null;
  rgbCache.set(key, value);
  return value;
}

/** Resolve a token to `rgba()` with an alpha override. */
export function tokenAlpha(name: string, alpha: number): string {
  const rgb = tokenRgb(name);
  return rgb ? `rgba(${rgb}, ${alpha})` : token(name);
}
