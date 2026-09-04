/*
 * Top bar (UI spec §4.1): brand · project · saved | transport | timecode |
 * theme switch · Basic/Advanced · licence-warning chip · Export.
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

  constructor() {
    this.el = h('div', { class: 'topbar' });
    this.render(store.get());
    store.subscribe((s, changed) => {
      if (changed.has('ui') || changed.has('project') || changed.has('transport')) this.render(s);
    });
  }

  private render(s: AppState): void {
    clear(this.el);
    const t = s.transport;

    const brand = h(
      'div',
      { class: 'brand' },
      svgIcon('c-wave', 16),
      h('span', {}, 'ScapeMaker'),
    );

    const name = h('button', {
      class: 'proj-name',
      onclick: () => this.rename(),
    }, s.project.name);

    const saved = h(
      'span',
      { class: 'saved mono' },
      s.ui.dirty ? 'UNSAVED' : s.ui.savedAt ? `SAVED ${ago(s.ui.savedAt)}` : 'NOT SAVED',
    );

    const tbtn = (icon: string, title: string, sub: string | undefined, on: boolean, cls: string, fn: () => void) =>
      h(
        'button',
        { class: `tbtn ${cls}${on ? ' on' : ''}`, ...tt(title, sub ?? ''), onclick: fn },
        svgIcon(icon, cls === 'play' ? 15 : 14),
      );

    const transportEl = h(
      'div',
      { class: 'transport' },
      tbtn('c-start', 'Go to start', 'Home', false, '', () => transport.goToStart()),
      tbtn('c-play', t.playing ? 'Pause' : 'Play', 'Space', t.playing, 'play', () =>
        t.playing ? transport.stop() : transport.play(),
      ),
      tbtn('c-stop', 'Stop', undefined, false, '', () => transport.stop()),
      tbtn('c-loop', 'Loop playback', 'Repeats the marked region — L', t.looping, '', () => transport.toggleLoop()),
    );

    const total = Math.max(s.project.duration, 0);
    const tc = h(
      'div',
      { class: 'tc' },
      timecode(t.playhead).split('.')[0],
      h('span', { class: 'frac' }, `.${timecode(t.playhead).split('.')[1]}`),
    );
    const tcTotal = h('div', { class: 'tc-total' }, `/${timecode(total).replace(/^00:/, '')}`);

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
        { class: s.ui.mode === 'basic' ? 'active' : '', onclick: () => store.patchUi({ mode: 'basic' }) },
        'Basic',
      ),
      h(
        'button',
        { class: s.ui.mode === 'advanced' ? 'active' : '', onclick: () => store.patchUi({ mode: 'advanced' }) },
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
      tcTotal,
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
