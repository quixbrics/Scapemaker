/* App bootstrap. */

import './styles/tokens.css';
import './styles/base.css';
import { initTheme } from './ui/theme';
import { installResumeOnGesture } from './audio/context';
import { mountApp } from './ui/app';
import { store } from './state/store';
import { readAutosave, applyLoadedProject, clearAutosave } from './state/persist';
import { assetStore } from './audio/assetStore';
import { newProject, type Project } from './state/project';
import { ensurePersistentStorage } from './audio/storage';
import { askToRecoverSession } from './ui/dialogs/recoverSession';

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
  // Ask before anything can be written: a student's own recordings live only
  // in the IndexedDB cache, and best-effort storage can be evicted wholesale.
  void ensurePersistentStorage();

  const app = document.getElementById('app')!;
  if (!checkViewport()) {
    window.addEventListener('resize', () => {
      if (checkViewport()) location.reload();
    });
    return;
  }

  mountApp(app);

  // Offer autosave recovery. The app is already mounted, so this is the app's
  // own dialog rather than a browser confirm fired at a half-painted page.
  try {
    const snap = await readAutosave();
    if (snap && Date.now() - snap.savedAt < 1000 * 60 * 60 * 24 * 14) {
      if ((await askToRecoverSession(snap.project, snap.savedAt)) === 'recover') {
        applyLoadedProject(snap.project);
        await reacquireAssets(snap.project);
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

/**
 * Best-effort: bring back the audio a recovered project points at. Cached
 * originals come from IndexedDB; anything else is re-fetched from its source
 * URL. An asset with neither is left missing rather than retried against an
 * empty URL, which is what the old `url: ref.downloadUrl ?? ''` did.
 */
async function reacquireAssets(project: Project): Promise<void> {
  const used = new Set<string>();
  for (const track of project.tracks) for (const clip of track.clips) used.add(clip.assetId);

  await Promise.all(
    [...used].map(async (id) => {
      const ref = project.assets[id];
      if (!ref) return;
      const cached = await assetStore.isCached(id);
      if (!cached && !ref.downloadUrl) return;
      await assetStore
        .acquire(ref, { kind: 'url', url: ref.downloadUrl ?? '' })
        .catch(() => {});
    }),
  );
}

void boot();
