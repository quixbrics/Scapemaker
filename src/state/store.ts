/*
 * Central application state with a tiny subscribe/emit core.
 * The UI is a small number of long-lived panels driven by this store —
 * no framework. Panels subscribe and re-render on the slices they care about.
 */

import type { Project } from './project';
import { newProject } from './project';

export type Workspace = 'discovery' | 'production';
export type Mode = 'basic' | 'advanced';
export type Tool = 'select' | 'trim' | 'split' | 'crossfade';
export type DiscoveryTab = 'freesound' | 'archive' | 'map' | 'mine';

export interface Selection {
  trackId: string | null;
  clipId: string | null;
}

export interface TransportState {
  playing: boolean;
  looping: boolean;
  /** playhead position in seconds — authoritative between rAF ticks */
  playhead: number;
  loopStart: number;
  loopEnd: number;
}

export interface UiState {
  workspace: Workspace;
  mode: Mode;
  tool: Tool;
  discoveryTab: DiscoveryTab;
  snap: boolean;
  selection: Selection;
  /** transient status line, cleared after a timeout */
  toast: { kind: 'info' | 'warn' | 'error'; text: string; id: number } | null;
  savedAt: number | null;
  dirty: boolean;
}

export interface AppState {
  project: Project;
  ui: UiState;
  transport: TransportState;
}

export type Listener = (state: AppState, changed: ReadonlySet<keyof AppState>) => void;

function initialUi(): UiState {
  return {
    workspace: 'production',
    mode: 'advanced',
    tool: 'select',
    discoveryTab: 'mine',
    snap: true,
    selection: { trackId: null, clipId: null },
    toast: null,
    savedAt: null,
    dirty: false,
  };
}

function initialTransport(): TransportState {
  return { playing: false, looping: false, playhead: 0, loopStart: 0, loopEnd: 0 };
}

class Store {
  private state: AppState = {
    project: newProject(),
    ui: initialUi(),
    transport: initialTransport(),
  };

  private listeners = new Set<Listener>();
  private toastSeq = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  get(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Replace one or more top-level slices and notify. */
  patch(partial: Partial<AppState>): void {
    const changed = new Set<keyof AppState>();
    for (const key of Object.keys(partial) as (keyof AppState)[]) {
      if (partial[key] !== undefined) {
        // @ts-expect-error index assignment across the union is safe here
        this.state[key] = partial[key];
        changed.add(key);
      }
    }
    this.emit(changed);
  }

  patchUi(partial: Partial<UiState>): void {
    this.state.ui = { ...this.state.ui, ...partial };
    this.emit(new Set(['ui']));
  }

  patchTransport(partial: Partial<TransportState>): void {
    this.state.transport = { ...this.state.transport, ...partial };
    this.emit(new Set(['transport']));
  }

  /**
   * Mutate the project in place via `fn`, then notify. Used by history commands
   * and by direct edits that are not undoable (e.g. view/scroll).
   */
  mutateProject(fn: (p: Project) => void, opts: { markDirty?: boolean } = {}): void {
    fn(this.state.project);
    this.state.project.modifiedAt = new Date().toISOString();
    if (opts.markDirty !== false) this.state.ui = { ...this.state.ui, dirty: true };
    this.emit(new Set(['project', 'ui']));
  }

  setProject(project: Project): void {
    this.state.project = project;
    this.state.ui = { ...this.state.ui, dirty: false, selection: { trackId: null, clipId: null } };
    this.state.transport = { ...initialTransport() };
    this.emit(new Set(['project', 'ui', 'transport']));
  }

  toast(kind: 'info' | 'warn' | 'error', text: string, ms = 4200): void {
    const id = ++this.toastSeq;
    this.state.ui = { ...this.state.ui, toast: { kind, text, id } };
    this.emit(new Set(['ui']));
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      if (this.state.ui.toast?.id === id) {
        this.state.ui = { ...this.state.ui, toast: null };
        this.emit(new Set(['ui']));
      }
    }, ms);
  }

  markSaved(): void {
    this.state.ui = { ...this.state.ui, savedAt: Date.now(), dirty: false };
    this.emit(new Set(['ui']));
  }

  private emit(changed: ReadonlySet<keyof AppState>): void {
    for (const fn of this.listeners) fn(this.state, changed);
  }
}

export const store = new Store();
