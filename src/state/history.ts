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
