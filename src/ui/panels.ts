/*
 * Side panels you can resize and fold away, so the timeline can have the
 * room. Drag a panel's inner edge to resize it (double-click the edge, or
 * press its chevron, to fold it to a thin rail); ` folds both at once, like
 * maximising a panel in Premiere.
 *
 * Widths are a preference of the machine you are sitting at, not of the
 * piece, so they live in localStorage (as the theme does) and never in the
 * project file.
 */

import { h, svgIcon } from './dom';
import { tt } from './tooltip';

export interface SidePanel {
  readonly collapsed: boolean;
  setCollapsed(collapsed: boolean): void;
}

interface Options {
  side: 'left' | 'right';
  /** localStorage key suffix */
  key: string;
  /** name for the rail and tooltips, e.g. "Library" */
  label: string;
  min: number;
  max: number;
}

interface Saved {
  width?: number;
  collapsed?: boolean;
}

function read(key: string): Saved {
  try {
    return JSON.parse(localStorage.getItem(`scapemaker.panel.${key}`) ?? '{}') as Saved;
  } catch {
    return {};
  }
}
function write(key: string, v: Saved): void {
  try {
    localStorage.setItem(`scapemaker.panel.${key}`, JSON.stringify(v));
  } catch {
    /* private window: the layout just won't be remembered */
  }
}

export function installSidePanel(panel: HTMLElement, opts: Options): SidePanel {
  const saved = read(opts.key);
  let width = saved.width ?? panel.getBoundingClientRect().width ?? opts.min;
  let collapsed = !!saved.collapsed;

  // Points the way the panel will move: toward its own edge to fold.
  const foldIcon = opts.side === 'left' ? 'c-chev-left' : 'c-chev-right';
  const openIcon = opts.side === 'left' ? 'c-chev-right' : 'c-chev-left';

  const foldBtn = h(
    'button',
    {
      class: 'panel-fold',
      ...tt(`Hide ${opts.label.toLowerCase()}`, 'Gives the timeline the room. ` hides both side panels.'),
      onclick: () => api.setCollapsed(true),
    },
    svgIcon(foldIcon, 13),
  );
  const rail = h(
    'button',
    {
      class: 'panel-rail',
      ...tt(`Show ${opts.label.toLowerCase()}`),
      onclick: () => api.setCollapsed(false),
    },
    svgIcon(openIcon, 13),
    h('span', { class: 'rail-label' }, opts.label),
  );
  const resizer = h('div', {
    class: `panel-resizer ${opts.side}`,
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': `Resize ${opts.label.toLowerCase()}`,
    ...tt(`Drag to resize the ${opts.label.toLowerCase()}`, 'Double-click to hide it'),
  });
  panel.classList.add('side-panel', opts.side);
  panel.append(foldBtn, rail, resizer);

  const apply = () => {
    panel.classList.toggle('collapsed', collapsed);
    const w = collapsed ? 30 : width;
    panel.style.width = `${w}px`;
    panel.style.flexBasis = `${w}px`;
    write(opts.key, { width, collapsed });
  };

  resizer.addEventListener('dblclick', () => api.setCollapsed(!collapsed));
  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = collapsed ? 30 : width;
    document.body.classList.add('col-resizing');
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * (opts.side === 'left' ? 1 : -1);
      const next = startW + dx;
      // Drag well past the minimum and the panel folds away; drag back out and it returns.
      if (next < opts.min - 60) {
        if (!collapsed) {
          collapsed = true;
          apply();
        }
        return;
      }
      collapsed = false;
      width = Math.max(opts.min, Math.min(opts.max, next));
      apply();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('col-resizing');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  const api: SidePanel = {
    get collapsed() {
      return collapsed;
    },
    setCollapsed(v: boolean) {
      if (v === collapsed) return;
      collapsed = v;
      apply();
    },
  };
  width = Math.max(opts.min, Math.min(opts.max, width));
  apply();
  return api;
}
