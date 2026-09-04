/* Shared "Open project" flow — used by the top bar button and Cmd/Ctrl+O. */

import { h } from '../dom';
import { store } from '../../state/store';
import { loadProjectFromText, applyLoadedProject, confirmDiscardIfDirty } from '../../state/persist';
import { showMissingAssets } from './missingAssets';

export function openProjectFile(): void {
  if (!confirmDiscardIfDirty('Open a different project')) return;
  const input = h('input', { type: 'file', accept: '.scapemaker,application/json' }) as HTMLInputElement;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const { project, warnings, missingAssets } = await loadProjectFromText(text);
      applyLoadedProject(project);
      await showMissingAssets(missingAssets, warnings);
      store.toast('info', `Opened “${project.name}”.`);
    } catch (err) {
      store.toast('error', err instanceof Error ? err.message : 'Could not open that file.');
    }
  };
  input.click();
}
