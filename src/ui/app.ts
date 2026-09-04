/* App shell — assembles the panels and wires global keyboard shortcuts. */

import '../styles/app.css';
import { store } from '../state/store';
import { history } from '../state/history';
import { transport } from '../audio/transport';
import { h } from './dom';
import { installIconSheet } from './icons';
import { installTooltips } from './tooltip';
import { TopBar } from './topbar';
import { Discovery } from './discovery';
import { Timeline } from './timeline';
import { Inspector } from './inspector';
import { MasterStrip } from './master';
import { splitClipAtPlayhead, duplicateClip, deleteClip } from '../state/edits';
import { openExportDialog } from './dialogs/exportDialog';
import { openProjectFile } from './dialogs/openProject';
import { saveProjectToFile, scheduleAutosave } from '../state/persist';

export function mountApp(root: HTMLElement): void {
  installIconSheet();
  installTooltips();

  const topbar = new TopBar();
  const discovery = new Discovery();
  const timeline = new Timeline();
  const inspector = new Inspector();
  const master = new MasterStrip();

  timeline.getMasterHost().replaceWith(master.el);

  const body = h('div', { class: 'body' }, discovery.el, timeline.el, inspector.el);
  root.append(h('div', { class: 'shell' }, topbar.el, body));
  root.removeAttribute('aria-busy');

  wireKeyboard();
  wireToast();

  // autosave on every project change
  store.subscribe((_s, changed) => {
    if (changed.has('project')) scheduleAutosave();
  });

  // never two things playing at once: starting the mix silences any Discovery preview
  store.subscribe((s, changed) => {
    if (changed.has('transport') && s.transport.playing) discovery.stopPreview();
  });
}

function wireKeyboard(): void {
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveProjectToFile(store.get().project);
      return;
    }
    if (mod && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      openExportDialog();
      return;
    }
    if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openProjectFile();
      return;
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      splitClipAtPlayhead();
      return;
    }
    if (typing) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        store.get().transport.playing ? transport.stop() : transport.play();
        break;
      case 'Home':
        transport.goToStart();
        break;
      case 'v':
      case 'V':
        store.patchUi({ tool: 'select' });
        break;
      case 't':
      case 'T':
        store.patchUi({ tool: 'trim' });
        break;
      case 'f':
      case 'F':
        store.patchUi({ tool: 'crossfade' });
        break;
      case 'l':
      case 'L':
        transport.toggleLoop();
        break;
      case 'd':
      case 'D': {
        const { trackId, clipId } = store.get().ui.selection;
        if (trackId && clipId) {
          e.preventDefault();
          duplicateClip(trackId, clipId);
        }
        break;
      }
      case 'Backspace':
      case 'Delete': {
        const { trackId, clipId } = store.get().ui.selection;
        if (trackId && clipId) {
          e.preventDefault();
          deleteClip(trackId, clipId);
        }
        break;
      }
      case 'Escape':
        store.patchUi({ selection: { trackId: null, clipId: null } });
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        const { trackId, clipId } = store.get().ui.selection;
        if (!trackId || !clipId) break;
        e.preventDefault();
        const nudge = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowLeft' ? -1 : 1);
        store.mutateProject((p) => {
          const c = p.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
          if (c) c.start = Math.max(0, c.start + nudge);
        });
        break;
      }
    }
  });
}

function wireToast(): void {
  let el: HTMLElement | null = null;
  store.subscribe((s, changed) => {
    if (!changed.has('ui')) return;
    const t = s.ui.toast;
    if (el) {
      el.remove();
      el = null;
    }
    if (t) {
      el = h('div', { class: `toast ${t.kind === 'info' ? '' : t.kind}` }, t.text);
      document.body.append(el);
    }
  });
}
