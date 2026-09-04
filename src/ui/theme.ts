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

/** Resolve a token to `rgba()` with an alpha override. */
export function tokenAlpha(name: string, alpha: number): string {
  const c = token(name);
  const el = document.createElement('div');
  el.style.color = c;
  document.body.appendChild(el);
  const rgb = getComputedStyle(el).color;
  el.remove();
  const m = rgb.match(/(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return c;
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
}
