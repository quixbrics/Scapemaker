/* Shared "Open project" flow — used by the top bar button and Cmd/Ctrl+O. */

import { h } from '../dom';
import { store } from '../../state/store';
import { loadProjectFromText, applyLoadedProject, confirmDiscardIfDirty } from '../../state/persist';
import {
  isAbort,
  pickOpenFile,
  setCurrentHandle,
  supportsFileSystemAccess,
  type ProjectFileHandle,
} from '../../state/fileHandle';
import { showMissingAssets } from './missingAssets';

async function load(text: string, handle: ProjectFileHandle | null): Promise<void> {
  const { project, warnings, missingAssets } = await loadProjectFromText(text);
  applyLoadedProject(project);
  // Remember the file so Save writes back to it instead of downloading a copy.
  setCurrentHandle(handle);
  await showMissingAssets(missingAssets, warnings);
  store.toast('info', `Opened “${project.name}”.`);
}

export async function openProjectFile(): Promise<void> {
  if (!confirmDiscardIfDirty('Open a different project')) return;

  if (supportsFileSystemAccess()) {
    try {
      const handle = await pickOpenFile();
      if (!handle) return;
      await load(await (await handle.getFile()).text(), handle);
      return;
    } catch (err) {
      if (isAbort(err)) return; // the student closed the picker
      store.toast('error', err instanceof Error ? err.message : 'Could not open that file.');
      return;
    }
  }

  // No File System Access: a plain file input, and Save falls back to a download.
  const input = h('input', { type: 'file', accept: '.scapemaker,application/json' }) as HTMLInputElement;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      await load(await file.text(), null);
    } catch (err) {
      store.toast('error', err instanceof Error ? err.message : 'Could not open that file.');
    }
  };
  input.click();
}
