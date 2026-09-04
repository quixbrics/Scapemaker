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
import { saveProjectToFile, startNewProject } from '../state/persist';
import { openProjectFile } from './dialogs/openProject';

export class TopBar {
  readonly el: HTMLElement;

  private playBtn!: HTMLButtonElement;
  private playIcon!: SVGSVGElement;
  private loopBtn!: HTMLButtonElement;
  private tcMain!: HTMLElement;
  private tcFrac!: HTMLElement;
  private tcTotal!: HTMLElement;

  constructor() {
    this.el = h('div', { class: 'topbar' });
    this.render(store.get());
    this.updateTransport(store.get());
    store.subscribe((s, changed) => {
      if (changed.has('ui') || changed.has('project')) this.render(s);
      if (changed.has('transport')) this.updateTransport(s);
    });
  }

  /** Full rebuild — only for structural (ui/project) changes, never per-frame. */
  private render(s: AppState): void {
    clear(this.el);

    const brand = h('div', { class: 'brand' }, svgIcon('c-wave', 16), h('span', {}, 'ScapeMaker'));

    const name = h('button', { class: 'proj-name', onclick: () => this.rename() }, s.project.name);

    const saved = h(
      'span',
      { class: 'saved mono' },
      s.ui.dirty ? 'UNSAVED' : s.ui.savedAt ? `SAVED ${ago(s.ui.savedAt)}` : 'NOT SAVED',
    );

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
      h('button', { class: s.ui.mode === 'basic' ? 'active' : '', onclick: () => store.patchUi({ mode: 'basic' }) }, 'Basic'),
      h('button', { class: s.ui.mode === 'advanced' ? 'active' : '', onclick: () => store.patchUi({ mode: 'advanced' }) }, 'Advanced'),
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
    const save = h('button', { class: 'btn', ...tt('Save project', 'Cmd/Ctrl + S — downloads a .scapemaker file'), onclick: () => saveProjectToFile(store.get().project) }, 'Save');
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
    return h(
      'div',
      { class: 'transport' },
      h(
        'button',
        {
          class: 'tbtn',
          ...tt('Undo', history.undoLabel ?? 'Nothing to undo'),
          disabled: !history.canUndo,
          onclick: () => history.undo(),
          style: history.canUndo ? '' : 'opacity:.35',
        },
        '⟲',
      ),
      h(
        'button',
        {
          class: 'tbtn',
          ...tt('Redo', history.redoLabel ?? 'Nothing to redo'),
          disabled: !history.canRedo,
          onclick: () => history.redo(),
          style: history.canRedo ? '' : 'opacity:.35',
        },
        '⟳',
      ),
    );
  }

  private rename(): void {
    const next = window.prompt('Project name', store.get().project.name);
    if (next && next.trim()) store.mutateProject((p) => (p.name = next.trim()));
  }
}

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}S AGO`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}M AGO`;
  return `${Math.round(m / 60)}H AGO`;
}
