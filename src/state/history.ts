/*
 * Undo/redo as a command stack. Every project mutation that a student can see
 * goes through here. Retrofitting undo is far more expensive than building on it
 * (Build Plan §4.7), so all timeline edits construct a Command.
 */

import type { Project } from './project';
import { store } from './store';

export interface Command {
  /** short label for a future "Undo <label>" affordance */
  label: string;
  do(p: Project): void;
  undo(p: Project): void;
}

class History {
  private past: Command[] = [];
  private future: Command[] = [];
  private limit = 200;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get undoLabel(): string | null {
    return this.past.at(-1)?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.future.at(-1)?.label ?? null;
  }

  /** Run a command and push it onto the undo stack. */
  push(cmd: Command): void {
    store.mutateProject((p) => cmd.do(p));
    this.past.push(cmd);
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
    this.notify();
  }

  undo(): void {
    const cmd = this.past.pop();
    if (!cmd) return;
    store.mutateProject((p) => cmd.undo(p));
    this.future.push(cmd);
    this.notify();
  }

  redo(): void {
    const cmd = this.future.pop();
    if (!cmd) return;
    store.mutateProject((p) => cmd.do(p));
    this.past.push(cmd);
    this.notify();
  }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

export const history = new History();

/**
 * Helper for the common case: a command that captures a deep snapshot of one
 * track before and after a mutator runs. Simple and allocation-cheap enough for
 * a single track's clip array; heavier ops can implement Command directly.
 */
export function trackEditCommand(
  label: string,
  trackId: string,
  mutate: (p: Project) => void,
): Command {
  let before: string | null = null;
  let after: string | null = null;
  const snap = (p: Project) => JSON.stringify(p.tracks.find((t) => t.id === trackId));
  const restore = (p: Project, json: string | null) => {
    if (json === null) return;
    const idx = p.tracks.findIndex((t) => t.id === trackId);
    if (idx >= 0) p.tracks[idx] = JSON.parse(json);
  };
  return {
    label,
    do(p) {
      if (before === null) {
        before = snap(p);
        mutate(p);
        after = snap(p);
      } else {
        restore(p, after);
      }
    },
    undo(p) {
      restore(p, before);
    },
  };
}

// ---------------------------------------------------------------------------
// Coalesced gestures
// ---------------------------------------------------------------------------

interface Gesture<T> {
  /** where the value was before the gesture started */
  prev: T;
  /** the latest value the gesture has reached */
  value: T;
}

let activeKey: string | null = null;
let activeGesture: Gesture<unknown> | null = null;
let gestureTimer: ReturnType<typeof setTimeout> | null = null;

function closeGesture(): void {
  activeKey = null;
  activeGesture = null;
  if (gestureTimer) {
    clearTimeout(gestureTimer);
    gestureTimer = null;
  }
}

/**
 * One undo step for a whole gesture — a fader drag, an EQ sweep — rather than
 * one per input event.
 *
 * The first call for a `key` pushes a command; later calls within the window
 * update that same command's target value in place. This matters for redo: a
 * command that closed over the value from the *first* event of the drag would
 * redo to a stale position, which is what the previous hand-rolled version in
 * edits.ts did.
 *
 * `read` and `write` address one field so the command stays cheap — no
 * snapshotting a whole track per animation frame.
 */
export function coalescedEdit<T>(
  key: string,
  label: string,
  read: (p: Project) => T,
  write: (p: Project, value: T) => void,
  value: T,
  windowMs = 500,
): void {
  const restart = () => {
    if (gestureTimer) clearTimeout(gestureTimer);
    gestureTimer = setTimeout(closeGesture, windowMs);
  };

  if (activeKey === key && activeGesture) {
    (activeGesture as Gesture<T>).value = value;
    store.mutateProject((p) => write(p, value));
    restart();
    return;
  }

  closeGesture();
  const gesture: Gesture<T> = { prev: read(store.get().project), value };
  activeKey = key;
  activeGesture = gesture as Gesture<unknown>;
  history.push({
    label,
    // Reads gesture.value at do-time, so redo lands where the gesture ENDED.
    do: (p) => write(p, gesture.value),
    undo: (p) => write(p, gesture.prev),
  });
  restart();
}

/** End any open gesture, so the next edit starts a fresh undo step. */
export function endCoalescedEdit(): void {
  closeGesture();
}
