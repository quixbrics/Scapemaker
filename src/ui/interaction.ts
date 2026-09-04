/*
 * A global "the user is mid-gesture" flag.
 *
 * Panels re-render from the store, and a slider's `oninput` mutates the store —
 * so without this, dragging any slider replaced the very element being dragged
 * on the first input event, and the gesture died after one step. (The zoom
 * slider, the track faders and every Inspector control all had this.)
 * Controls update their own readouts live; panels skip destructive rebuilds
 * until the gesture ends.
 */

let gestures = 0;
const listeners = new Set<() => void>();

export function isInteracting(): boolean {
  return gestures > 0;
}

/** Run `fn` once the current gesture finishes (or immediately if idle). */
export function onGestureEnd(fn: () => void): void {
  if (gestures === 0) fn();
  else listeners.add(fn);
}

export function installInteractionGuard(): void {
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t && t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'range') gestures++;
    },
    true,
  );
  const end = () => {
    if (gestures === 0) return;
    gestures = 0;
    for (const fn of listeners) fn();
    listeners.clear();
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
}
