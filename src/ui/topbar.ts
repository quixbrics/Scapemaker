/*
 * Top bar (UI spec §4.1): brand · project · saved | transport | timecode |
 * theme switch · Basic/Advanced · licence-warning chip · Export.
 *
 * IMPORTANT: the playhead patches the store on every animation frame while
 * playing. A full clear()+rebuild on every 'transport' change used to replace
 * the Play/Stop buttons under the pointer ~60 times a second, so a click's
 * mousedown and mouseup landed on two different (one of them detached) DOM
 * nodes and the browser never fired `click` at all — the buttons looked dead
 * while audio kept running. Fix: build the transport controls ONCE and only
 * ever patch their class/text in place; `render()` (full rebuild) responds
 * only to 'ui'/'project' changes.
 */

import { store, type AppState } from '../state/store';
import { transport } from '../audio/transport';
import { clear, h, svgIcon, timecode } from './dom';
import { tt } from './tooltip';
import { toggleTheme, currentTheme } from './theme';
import { restrictedCount } from '../licence/warnings';
import { openExportDialog } from './dialogs/exportDialog';
import { history } from '../state/history';
import { saveProjectToFile, startNewProject, currentFileName } from '../state/persist';
import { openProjectFile } from './dialogs/openProject';

export class TopBar {
  readonly el: HTMLElement;

  private playBtn!: HTMLButtonElement;
  private playIcon!: SVGSVGElement;
  private loopBtn!: HTMLButtonElement;
  private tcMain!: HTMLElement;
  private tcFrac!: HTMLElement;
  private tcTotal!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private savedEl!: HTMLElement;

  constructor() {
    this.el = h('div', { class: 'topbar' });
    this.render(store.get());
    this.updateTransport(store.get());
    store.subscribe((s, changed) => {
      if (changed.has('ui') || changed.has('project')) this.render(s);
      if (changed.has('transport')) this.updateTransport(s);
    });
    // history.push() mutates the project BEFORE putting the command on the
    // stack, so the render triggered by that mutation still saw the previous
    // command: the Undo button showed the wrong label and stayed disabled for
    // one edit after the first. The stack has its own notifier — use it.
    history.subscribe(() => this.updateHistory());
    // "SAVED 3S AGO" went stale the moment it was painted, and only refreshed
    // when some unrelated edit forced a rebuild. Once a minute is enough:
    // the text only changes at minute boundaries after the first one.
    setInterval(() => this.updateSaved(store.get()), 30_000);
  }

  private updateSaved(s: AppState): void {
    if (!this.savedEl) return;
    this.savedEl.textContent = s.ui.dirty
      ? 'UNSAVED'
      : s.ui.savedAt
        ? `SAVED ${ago(s.ui.savedAt)}`
        : 'NOT SAVED';
  }

  /** Full rebuild — only for structural (ui/project) changes, never per-frame. */
  private render(s: AppState): void {
    clear(this.el);

    const brand = h('div', { class: 'brand' }, svgIcon('c-wave', 16), h('span', {}, 'ScapeMaker'));

    const name = h('button', { class: 'proj-name', onclick: () => this.rename() }, s.project.name);

    this.savedEl = h('span', { class: 'saved mono' });
    const saved = this.savedEl;
    this.updateSaved(s);

    this.playIcon = svgIcon('c-play', 15);
    this.playBtn = h(
      'button',
      { class: 'tbtn play', ...tt('Play', 'Space'), onclick: () => (transport.playing ? transport.stop() : transport.play()) },
      this.playIcon,
    ) as HTMLButtonElement;

    this.loopBtn = h(
      'button',
      { class: 'tbtn', ...tt('Loop playback', 'Repeats the marked region — L'), onclick: () => transport.toggleLoop() },
      svgIcon('c-loop', 14),
    ) as HTMLButtonElement;

    const transportEl = h(
      'div',
      { class: 'transport' },
      h('button', { class: 'tbtn', ...tt('Go to start', 'Home'), onclick: () => transport.goToStart() }, svgIcon('c-start', 14)),
      this.playBtn,
      h('button', { class: 'tbtn', ...tt('Stop'), onclick: () => transport.stop() }, svgIcon('c-stop', 14)),
      this.loopBtn,
    );

    this.tcMain = h('span', {});
    this.tcFrac = h('span', { class: 'frac' });
    const tc = h('div', { class: 'tc' }, this.tcMain, this.tcFrac);
    this.tcTotal = h('div', { class: 'tc-total' });

    const themeSwitch = h(
      'button',
      {
        class: 'segmented',
        ...tt('Appearance', 'Dark for edit suites, light for bright rooms and projectors. Remembered on this machine.'),
        onclick: () => toggleTheme(),
      },
      h('span', { class: `seg-icon${currentTheme() === 'light' ? ' active' : ''}` }, svgIcon('c-sun', 14)),
      h('span', { class: `seg-icon${currentTheme() === 'dark' ? ' active' : ''}` }, svgIcon('c-moon', 14)),
    );

    const modeSwitch = h(
      'div',
      { class: 'segmented' },
      h(
        'button',
        {
          class: s.ui.mode === 'basic' ? 'active' : '',
          ...tt('Basic', 'Select, trim and split, with gain and fades. Enough for a first soundscape.'),
          onclick: () => setMode('basic'),
        },
        'Basic',
      ),
      h(
        'button',
        {
          class: s.ui.mode === 'advanced' ? 'active' : '',
          ...tt('Advanced', 'Adds crossfade and loop, automation curves, EQ and reverb.'),
          onclick: () => setMode('advanced'),
        },
        'Advanced',
      ),
    );

    const rc = restrictedCount(s.project);
    const chip =
      rc > 0
        ? h(
            'div',
            {
              class: 'chip',
              ...tt(
                `${rc} sound${rc > 1 ? 's have' : ' has'} licence restrictions`,
                'NonCommercial or NoDerivatives. You can hand this in, but you cannot publish it publicly.',
              ),
            },
            svgIcon('c-warn', 13),
            h('span', {}, `${rc} restricted`),
          )
        : null;

    const newBtn = h('button', { class: 'btn', ...tt('New project', 'Starts empty. Asks first if you have unsaved changes.'), onclick: () => startNewProject() }, 'New');
    const openBtn = h('button', { class: 'btn', ...tt('Open project', 'Load a .scapemaker file. Asks first if you have unsaved changes.'), onclick: () => openProjectFile() }, 'Open');
    const file = currentFileName();
    const save = h(
      'button',
      {
        class: 'btn',
        ...tt(
          'Save project',
          file
            ? `Cmd/Ctrl + S — writes back to ${file}. Shift-click to save a copy.`
            : 'Cmd/Ctrl + S — asks where to keep the .scapemaker file.',
        ),
        // Shift is the conventional "save a copy" modifier, and keeps a second
        // button out of an already-crowded bar.
        onclick: (e) => void saveProjectToFile(store.get().project, { saveAs: (e as MouseEvent).shiftKey }),
      },
      'Save',
    );
    const exportBtn = h('button', { class: 'btn-primary', onclick: () => openExportDialog() }, 'Export');

    this.el.append(
      brand,
      h('div', { class: 'vrule' }),
      name,
      saved,
      h('div', { class: 'spacer' }),
      transportEl,
      tc,
      this.tcTotal,
      h('div', { class: 'spacer' }),
      this.undoRedo(),
      themeSwitch,
      modeSwitch,
      chip ?? document.createComment('no-restrictions'),
      newBtn,
      openBtn,
      save,
      exportBtn,
    );

    this.updateTransport(s);
  }

  /** Lightweight — called on every transport tick. Never replaces DOM nodes. */
  private updateTransport(s: AppState): void {
    const t = s.transport;
    const full = timecode(t.playhead);
    const [main, frac] = full.split('.');
    if (this.tcMain) this.tcMain.textContent = main;
    if (this.tcFrac) this.tcFrac.textContent = `.${frac}`;
    if (this.tcTotal) this.tcTotal.textContent = `/${timecode(Math.max(s.project.duration, 0)).replace(/^00:/, '')}`;

    if (this.playBtn) {
      this.playBtn.classList.toggle('on', t.playing);
      this.playBtn.dataset.tt = t.playing ? 'Pause' : 'Play';
    }
    if (this.playIcon) {
      const use = this.playIcon.querySelector('use');
      use?.setAttribute('href', t.playing ? '#c-stop' : '#c-play');
    }
    if (this.loopBtn) this.loopBtn.classList.toggle('on', t.looping);
  }

  private undoRedo(): HTMLElement {
    this.undoBtn = h(
      'button',
      { class: 'tbtn', 'aria-label': 'Undo', onclick: () => history.undo() },
      '⟲',
    ) as HTMLButtonElement;
    this.redoBtn = h(
      'button',
      { class: 'tbtn', 'aria-label': 'Redo', onclick: () => history.redo() },
      '⟳',
    ) as HTMLButtonElement;
    this.updateHistory();
    return h('div', { class: 'transport' }, this.undoBtn, this.redoBtn);
  }

  /** In-place patch — safe to call from the history notifier at any time. */
  private updateHistory(): void {
    if (!this.undoBtn || !this.redoBtn) return;
    const apply = (btn: HTMLButtonElement, can: boolean, label: string, what: string | null) => {
      btn.disabled = !can;
      btn.style.opacity = can ? '' : '.35';
      btn.dataset.tt = label;
      btn.dataset.ttSub = what ?? `Nothing to ${label.toLowerCase()}`;
      btn.setAttribute('aria-label', what ? `${label} ${what}` : `${label} (unavailable)`);
    };
    apply(this.undoBtn, history.canUndo, 'Undo', history.undoLabel);
    apply(this.redoBtn, history.canRedo, 'Redo', history.redoLabel);
  }

  private rename(): void {
    const next = window.prompt('Project name', store.get().project.name);
    if (next && next.trim()) store.mutateProject((p) => (p.name = next.trim()));
  }
}

/**
 * Basic hides the crossfade and loop tools and the automation lanes, so
 * dropping into it while one of them is in use would leave the student
 * holding a tool with no button and no way back to it.
 */
function setMode(mode: 'basic' | 'advanced'): void {
  const { ui } = store.get();
  if (mode === 'basic') {
    const tool = ui.tool === 'crossfade' || ui.tool === 'loop' ? 'select' : ui.tool;
    store.patchUi({ mode, tool, automationView: null });
  } else {
    store.patchUi({ mode });
  }
}

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}S AGO`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}M AGO`;
  return `${Math.round(m / 60)}H AGO`;
}
