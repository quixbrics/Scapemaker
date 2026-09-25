/*
 * Dragging a sound from the library (Mine, or a search result) onto a track.
 *
 * This used to be native HTML5 drag-and-drop, which was unreliable here in
 * two ways. The browser gives no say over what is drawn while dragging, so
 * nothing on the timeline showed where the clip would land. And the "Mine"
 * list rebuilt itself on every project change — the timeline writes its scroll
 * position into the project, and the browser auto-scrolls it during a drag —
 * which pulled the drag source out of the document and silently killed the
 * drag. Each row also placed the sound on a plain click, so a drag the browser
 * refused to start came out as a click, and the clip landed at the end of the
 * first empty track: "it didn't respond, then put it somewhere random".
 *
 * Pointer events on `window` survive any re-render, and the timeline draws a
 * ghost clip at the exact drop position while the pointer is over a lane.
 */

import type { AssetRef } from '../state/project';
import type { SoundResult } from '../sources/types';
import { h, timecode } from './dom';

export type LibraryPayload =
  | { kind: 'asset'; ref: AssetRef; title: string; duration: number }
  | { kind: 'result'; result: SoundResult; title: string; duration: number };

export interface DragMods {
  /** Cmd/Ctrl held: place exactly where the pointer is, ignoring snap */
  bypassSnap: boolean;
}

/** Whatever can accept a library drop. The timeline registers itself. */
export interface DropTarget {
  /** Show where the drop would land. Returns false if the point is not over a lane. */
  hover(clientX: number, clientY: number, payload: LibraryPayload, mods: DragMods): boolean;
  leave(): void;
  drop(clientX: number, clientY: number, payload: LibraryPayload, mods: DragMods): boolean;
}

let target: DropTarget | null = null;
export function registerDropTarget(t: DropTarget): void {
  target = t;
}

/** Movement (px) before a press on a row counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;

/**
 * Call from a row's `pointerdown`. Nothing happens until the pointer has
 * moved a few pixels, so the row's own buttons and clicks still work.
 */
export function beginLibraryDrag(down: PointerEvent, payload: LibraryPayload): void {
  if (down.button !== 0) return;
  // Buttons inside the row (preview, add) keep their own click.
  if ((down.target as HTMLElement).closest('button, input, select, a')) return;
  // Stop the browser starting a text selection under the drag.
  down.preventDefault();

  let dragging = false;
  let last = { x: down.clientX, y: down.clientY };
  let mods: DragMods = { bypassSnap: false };
  let over = false;
  let raf = 0;
  const chip = h(
    'div',
    { class: 'drag-chip', 'aria-hidden': 'true' },
    h('span', { class: 'dc-title' }, payload.title),
    h('span', { class: 'dc-dur' }, payload.duration > 0 ? timecode(payload.duration, false) : '—'),
  );

  const paint = () => {
    chip.style.transform = `translate(${last.x + 14}px, ${last.y + 12}px)`;
    over = target?.hover(last.x, last.y, payload, mods) ?? false;
    chip.classList.toggle('over', over);
  };
  // Re-run every frame, not only on pointermove: holding still near the edge
  // of the timeline keeps it scrolling, and the ghost has to follow.
  const frame = () => {
    paint();
    raf = requestAnimationFrame(frame);
  };

  const move = (ev: PointerEvent) => {
    last = { x: ev.clientX, y: ev.clientY };
    mods = { bypassSnap: ev.metaKey || ev.ctrlKey };
    if (!dragging) {
      if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < DRAG_THRESHOLD) return;
      dragging = true;
      document.body.append(chip);
      document.body.classList.add('library-dragging');
      raf = requestAnimationFrame(frame);
    }
  };
  const finish = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
    cancelAnimationFrame(raf);
    chip.remove();
    document.body.classList.remove('library-dragging');
    target?.leave();
  };
  const up = (ev: PointerEvent) => {
    const wasDragging = dragging;
    last = { x: ev.clientX, y: ev.clientY };
    mods = { bypassSnap: ev.metaKey || ev.ctrlKey };
    finish();
    if (wasDragging) target?.drop(last.x, last.y, payload, mods);
  };
  const cancel = () => finish();
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !dragging) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    finish();
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
}
