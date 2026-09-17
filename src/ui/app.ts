/* App shell — assembles the panels and wires global keyboard shortcuts. */

import '../styles/app.css';
import { store, type AppState } from '../state/store';
import { history } from '../state/history';
import { transport } from '../audio/transport';
import { h } from './dom';
import { installIconSheet } from './icons';
import { installTooltips } from './tooltip';
import { installInteractionGuard } from './interaction';
import { TopBar } from './topbar';
import { Discovery } from './discovery';
import { Timeline } from './timeline';
import { RightPanel } from './rightPanel';
import { MasterStrip } from './master';
import { splitClipAtPlayhead, duplicateClip, deleteClip, copySelectedClip, pasteClip } from '../state/edits';
import { openExportDialog } from './dialogs/exportDialog';
import { openProjectFile } from './dialogs/openProject';
import { saveProjectToFile, scheduleAutosave } from '../state/persist';
import { flushReflectionEdits } from './reflection';
import { assetStore } from '../audio/assetStore';

export function mountApp(root: HTMLElement): void {
  installIconSheet();
  installTooltips();
  installInteractionGuard();

  const topbar = new TopBar();
  const discovery = new Discovery();
  const timeline = new Timeline();
  const rightPanel = new RightPanel();
  const master = new MasterStrip();

  timeline.getMasterHost().replaceWith(master.el);

  const body = h('div', { class: 'body' }, discovery.el, timeline.el, rightPanel.el);
  root.append(h('div', { class: 'shell' }, topbar.el, body));
  root.removeAttribute('aria-busy');

  wireKeyboard();
  wireToast();

  // autosave on every project change
  store.subscribe((_s, changed) => {
    if (changed.has('project')) scheduleAutosave();
  });

  // Tell the asset store which decoded audio the project still points at, so
  // sounds deleted from the timeline stop counting against the memory budget.
  // Derived from the project rather than hooked into deleteClip, because undo
  // and redo add and remove clips without going through the edit functions.
  const retainUsedAssets = (s: AppState) => {
    const live = new Set<string>();
    for (const track of s.project.tracks) for (const clip of track.clips) live.add(clip.assetId);
    assetStore.retain(live);
  };
  store.subscribe((s, changed) => {
    if (changed.has('project')) retainUsedAssets(s);
  });
  retainUsedAssets(store.get());

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

    // Clicking Save or Export blurs the textarea and flushes on the way out;
    // the keyboard path never leaves the field, so flush explicitly.
    if (mod && 'seo'.includes(e.key.toLowerCase())) flushReflectionEdits();

    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveProjectToFile(store.get().project, { saveAs: e.shiftKey });
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
    // Everything below this line belongs to the timeline, not to text. Only
    // Save / Export / Open are global enough to fire while a field has focus —
    // undo and split in particular must leave the field's own editing alone,
    // or writing a reflection would lose text to a project-level undo.
    if (typing) return;

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
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copySelectedClip();
      return;
    }
    if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      pasteClip();
      return;
    }

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
      // Crossfade and loop only exist in Advanced; their shortcuts should not
      // select a tool whose button is not on screen.
      case 'f':
      case 'F':
        if (store.get().ui.mode === 'advanced') store.patchUi({ tool: 'crossfade' });
        break;
      case 'r':
      case 'R':
        if (store.get().ui.mode === 'advanced') store.patchUi({ tool: 'loop' });
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
  // A live region so the message is announced, not merely drawn. Errors and
  // warnings interrupt; an ordinary confirmation waits its turn.
  const region = h('div', {
    class: 'toast-region',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });
  document.body.append(region);

  store.subscribe((s, changed) => {
    if (!changed.has('ui')) return;
    const t = s.ui.toast;
    region.setAttribute('aria-live', t && t.kind !== 'info' ? 'assertive' : 'polite');
    region.replaceChildren();
    if (t) region.append(h('div', { class: `toast ${t.kind === 'info' ? '' : t.kind}` }, t.text));
  });
}
