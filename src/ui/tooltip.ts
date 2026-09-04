/*
 * ONE delegated tooltip controller for the whole app (UI spec §5, Build Plan
 * §7.9). Any element with `data-tt="Title"` (and optional `data-tt-sub="…"`)
 * gets a tooltip: dark chip in both themes, bold first line, faint second line,
 * ~400 ms delay, 120 ms fade, appears below by default.
 *
 * Positioning is a known bug source: wide tips near a panel edge get clamped to
 * the viewport; a trigger in the bottom 120 px opens upward.
 */

let tipEl: HTMLDivElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let current: HTMLElement | null = null;

function ensureEl(): HTMLDivElement {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.setAttribute('role', 'tooltip');
  Object.assign(tipEl.style, {
    position: 'fixed',
    zIndex: '9999',
    maxWidth: '260px',
    padding: '7px 10px',
    borderRadius: '4px',
    background: 'var(--tip-bg)',
    color: 'var(--tip-text)',
    border: '1px solid var(--tip-border)',
    boxShadow: 'var(--tip-shadow, 0 8px 22px rgba(0,0,0,.5))',
    font: '400 11px/1.4 var(--font-ui)',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'opacity .12s ease',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(tipEl);
  return tipEl;
}

function render(target: HTMLElement): void {
  const el = ensureEl();
  const title = target.dataset.tt ?? '';
  const sub = target.dataset.ttSub;
  el.innerHTML = '';
  const b = document.createElement('b');
  b.style.cssText = 'display:block;font-weight:600;margin-bottom:2px';
  b.textContent = title;
  el.appendChild(b);
  if (sub) {
    const s = document.createElement('span');
    s.style.cssText = 'display:block;color:var(--tip-sub);font-size:10.5px';
    s.textContent = sub;
    el.appendChild(s);
  }

  const r = target.getBoundingClientRect();
  el.style.opacity = '0';
  el.style.left = '0px';
  el.style.top = '0px';
  // measure
  const tw = el.offsetWidth;
  const th = el.offsetHeight;
  const margin = 8;
  const openUp = r.bottom > window.innerHeight - 120;

  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));
  const top = openUp ? r.top - th - margin : r.bottom + margin;

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.opacity = '1';
}

function hide(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  current = null;
  if (tipEl) tipEl.style.opacity = '0';
}

export function installTooltips(): void {
  const findTrigger = (e: Event): HTMLElement | null => {
    let n = e.target as HTMLElement | null;
    while (n && n !== document.body) {
      if (n.dataset && n.dataset.tt) return n;
      n = n.parentElement;
    }
    return null;
  };

  document.addEventListener('pointerover', (e) => {
    const t = findTrigger(e);
    if (!t || t === current) return;
    current = t;
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      if (current === t) render(t);
    }, 400);
  });
  document.addEventListener('pointerout', (e) => {
    const t = findTrigger(e);
    if (t && t === current) hide();
  });
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}

/** Convenience for building trigger attrs. */
export function tt(title: string, sub?: string): Record<string, string> {
  return sub ? { 'data-tt': title, 'data-tt-sub': sub } : { 'data-tt': title };
}
