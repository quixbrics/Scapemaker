/* Minimal element helper. No framework (Build Plan §2). */

type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k === 'html') el.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  nameFromTooltip(el);
  return el;
}

/** Controls that carry their own accessible name in their text content. */
const NAMED_BY_TOOLTIP = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);

/**
 * Most controls here are icon-only: svgIcon marks its SVG aria-hidden, so a
 * button holding nothing else had NO accessible name at all — a screen reader
 * announced "button" for play, stop, mute, solo and every tool. The tooltip
 * title is already a good, human name for each, so use it.
 *
 * Only for real controls: aria-label on a plain div is ignored without a role,
 * and `tt` is used on plenty of decorative spans (fade wedges, loop ticks).
 * An explicit aria-label always wins.
 */
function nameFromTooltip(el: HTMLElement): void {
  if (!NAMED_BY_TOOLTIP.has(el.tagName)) return;
  if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return;
  const title = el.dataset.tt;
  if (!title) return;
  // WCAG 2.5.3: the accessible name must contain the visible label. Every
  // tooltip title here either expands the visible text ("Save" -> "Save
  // project") or replaces a bare glyph, so the check is cheap insurance
  // against a future title that drifts from its button.
  const visible = (el.textContent ?? '').trim();
  if (visible && !title.toLowerCase().includes(visible.toLowerCase())) {
    el.setAttribute('aria-label', `${visible} — ${title}`);
  } else {
    el.setAttribute('aria-label', title);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function svgIcon(id: string, size = 15): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

/** mm:ss.mmm timecode. */
export function timecode(seconds: number, withMs = true): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  const base = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return withMs ? `${base}.${String(ms).padStart(3, '0')}` : base;
}

export function fmtDb(db: number): string {
  if (!isFinite(db)) return '−∞';
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)}`;
}

export function fmtCoord(lat: number, lon: number): string {
  const la = `${Math.abs(lat).toFixed(4)} ${lat >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(lon).toFixed(4)} ${lon >= 0 ? 'E' : 'W'}`;
  return `${la} ${lo}`;
}
