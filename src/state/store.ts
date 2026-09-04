/*
 * Central application state with a tiny subscribe/emit core.
 * The UI is a small number of long-lived panels driven by this store —
 * no framework. Panels subscribe and re-render on the slices they care about.
 */

import type { AutomationParam, Project } from './project';
import { newProject } from './project';

export type Workspace = 'discovery' | 'production';
export type Mode = 'basic' | 'advanced';
export type Tool = 'select' | 'trim' | 'split' | 'crossfade' | 'loop';
export type DiscoveryTab = 'freesound' | 'archive' | 'map' | 'mine';

export interface Selection {
  trackId: string | null;
  clipId: string | null;
}

/** Which track (if any) has its automation lane expanded, and which param — pure view state, never persisted or marked dirty. */
export interface AutomationView {
  trackId: string;
  param: AutomationParam;
}

/**
 * A source import in flight — a network fetch and/or decode that hasn't
 * landed on the timeline yet. Its own AppState slice (not nested in `ui`) so
 * per-progress-tick updates only wake the timeline, not every panel.
 */
export interface PendingImport {
  id: string;
  trackId: string;
  start: number;
  /** best current estimate in seconds — may be a fallback guess until decoded */
  duration: number;
  title: string;
  phase: 'resolving' | 'fetching' | 'decoding';
  /** 0..1, or -1 for indeterminate (unknown total size, or the decode phase) */
  fraction: number;
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
  automationView: AutomationView | null;
  /** transient status line, cleared after a timeout */
  toast: { kind: 'info' | 'warn' | 'error'; text: string; id: number } | null;
  savedAt: number | null;
  dirty: boolean;
}

export interface AppState {
  project: Project;
  ui: UiState;
  transport: TransportState;
  pendingImports: PendingImport[];
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
    automationView: null,
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
    pendingImports: [],
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
    this.state.ui = { ...this.state.ui, dirty: false, selection: { trackId: null, clipId: null }, automationView: null };
    this.state.transport = { ...initialTransport() };
    this.state.pendingImports = [];
    this.emit(new Set(['project', 'ui', 'transport', 'pendingImports']));
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

  addPendingImport(p: PendingImport): void {
    this.state.pendingImports = [...this.state.pendingImports, p];
    this.emit(new Set(['pendingImports']));
  }

  updatePendingImport(id: string, patch: Partial<PendingImport>): void {
    this.state.pendingImports = this.state.pendingImports.map((p) => (p.id === id ? { ...p, ...patch } : p));
    this.emit(new Set(['pendingImports']));
  }

  removePendingImport(id: string): void {
    this.state.pendingImports = this.state.pendingImports.filter((p) => p.id !== id);
    this.emit(new Set(['pendingImports']));
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
