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
/**
 * Keyed so a panel asking on every input event of a drag queues ONE rebuild,
 * not one per event — a long fader drag would otherwise fire hundreds of full
 * re-renders the moment the pointer came up.
 */
const pending = new Map<string, () => void>();

export function isInteracting(): boolean {
  return gestures > 0;
}

/**
 * Run `fn` once the current gesture finishes (or immediately if idle).
 * Repeat calls with the same `key` replace the previous one.
 */
export function onGestureEnd(key: string, fn: () => void): void {
  if (gestures === 0) fn();
  else pending.set(key, fn);
}

/**
 * What counts as a drag. Range inputs were the only thing tracked, so a clip
 * drag, a trim, a ruler scrub and an automation-point drag all read as "idle"
 * — which let the master strip start a full offline render of the project in
 * the middle of the gesture, and let panels rebuild the node being dragged.
 */
const DRAG_SELECTOR = [
  'input[type=range]',
  '.clip',
  '.trim-handle',
  '.auto-handle',
  '.auto-overlay',
  '.ruler-track',
  '.lane-body',
].join(',');

export function installInteractionGuard(): void {
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(DRAG_SELECTOR)) gestures++;
    },
    true,
  );
  const end = () => {
    if (gestures === 0) return;
    gestures = 0;
    const fns = [...pending.values()];
    pending.clear();
    for (const fn of fns) fn();
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
}
