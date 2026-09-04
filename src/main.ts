/* App bootstrap. */

import './styles/tokens.css';
import './styles/base.css';
import { initTheme } from './ui/theme';
import { installResumeOnGesture } from './audio/context';
import { mountApp } from './ui/app';
import { store } from './state/store';
import { readAutosave, applyLoadedProject, clearAutosave } from './state/persist';
import { assetStore } from './audio/assetStore';
import { newProject } from './state/project';

const MIN_WIDTH = 1024;

function checkViewport(): boolean {
  const ok = window.innerWidth >= MIN_WIDTH;
  document.getElementById('unsupported')!.hidden = ok;
  document.getElementById('app')!.hidden = !ok;
  return ok;
}

async function boot(): Promise<void> {
  initTheme();
  installResumeOnGesture();

  const app = document.getElementById('app')!;
  if (!checkViewport()) {
    window.addEventListener('resize', () => {
      if (checkViewport()) location.reload();
    });
    return;
  }

  mountApp(app);

  // Offer autosave recovery.
  try {
    const snap = await readAutosave();
    if (snap && Date.now() - snap.savedAt < 1000 * 60 * 60 * 24 * 14) {
      const when = new Date(snap.savedAt).toLocaleString();
      if (window.confirm(`Recover your last session from ${when}?`)) {
        applyLoadedProject(snap.project);
        // best-effort: re-acquire cached assets
        for (const ref of Object.values(snap.project.assets)) {
          if (ref.downloadUrl || (await assetStore.isCached(ref.id))) {
            assetStore.acquire(ref, { kind: 'url', url: ref.downloadUrl ?? '' }).catch(() => {});
          }
        }
      } else {
        await clearAutosave();
      }
    }
  } catch {
    /* autosave optional */
  }

  // Expose a tiny console handle for headless Phase 1 checks.
  (window as unknown as { scapemaker: unknown }).scapemaker = { store, assetStore, newProject };

  window.addEventListener('resize', () => checkViewport());
  window.addEventListener('beforeunload', (e) => {
    if (store.get().ui.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

void boot();
