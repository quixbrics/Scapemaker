/*
 * Project system (concept §8): new, save, load, autosave.
 * File type `.scapemaker` — JSON, NO audio. Assets are referenced by source URL
 * and resolved from the IndexedDB cache first, then downloadUrl. On load,
 * missing assets are reported clearly — never a silent half-open.
 */

import { openDB } from 'idb';
import type { AssetRef, Project } from './project';
import { migrate } from './project';
import { assetStore } from '../audio/assetStore';
import { store } from './store';
import { history } from './history';
import { downloadBlob, safeName } from '../export/download';

const AUTOSAVE_DB = 'scapemaker-autosave';
const AUTOSAVE_STORE = 'snapshots';
const AUTOSAVE_KEY = 'latest';

// --- file save / load ---------------------------------------------------

export function serialiseProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

export function saveProjectToFile(project: Project): void {
  const blob = new Blob([serialiseProject(project)], { type: 'application/json' });
  downloadBlob(blob, `${safeName(project.name)}.scapemaker`);
  store.markSaved();
}

export interface LoadResult {
  project: Project;
  warnings: string[];
  missingAssets: AssetRef[];
}

export async function loadProjectFromText(text: string): Promise<LoadResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON — it may be corrupt or not a .scapemaker file.');
  }
  const { project, warnings } = migrate(raw);

  // Try to bring every referenced asset back online.
  const missingAssets: AssetRef[] = [];
  const usedIds = new Set<string>();
  for (const t of project.tracks) for (const c of t.clips) usedIds.add(c.assetId);

  for (const id of usedIds) {
    const ref = project.assets[id];
    if (!ref) continue;
    try {
      if (await assetStore.isCached(id)) {
        await assetStore.acquire(ref, { kind: 'url', url: ref.downloadUrl ?? '' });
      } else if (ref.downloadUrl) {
        await assetStore.acquire(ref, { kind: 'url', url: ref.downloadUrl });
      } else {
        missingAssets.push(ref);
      }
    } catch {
      missingAssets.push(ref);
    }
  }

  return { project, warnings, missingAssets };
}

export function applyLoadedProject(project: Project): void {
  store.setProject(project);
  history.clear();
}

// --- autosave (IndexedDB) --------------------------------------------------

async function autosaveDb() {
  return openDB(AUTOSAVE_DB, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(AUTOSAVE_STORE)) d.createObjectStore(AUTOSAVE_STORE);
    },
  });
}

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleAutosave(): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => void writeAutosave(), 4000);
}

export async function writeAutosave(): Promise<void> {
  try {
    const db = await autosaveDb();
    await db.put(
      AUTOSAVE_STORE,
      { project: store.get().project, savedAt: Date.now() },
      AUTOSAVE_KEY,
    );
  } catch {
    /* storage blocked; nothing we can do */
  }
}

export interface AutosaveSnapshot {
  project: Project;
  savedAt: number;
}

export async function readAutosave(): Promise<AutosaveSnapshot | null> {
  try {
    const db = await autosaveDb();
    const snap = (await db.get(AUTOSAVE_STORE, AUTOSAVE_KEY)) as AutosaveSnapshot | undefined;
    return snap ?? null;
  } catch {
    return null;
  }
}

export async function clearAutosave(): Promise<void> {
  try {
    const db = await autosaveDb();
    await db.delete(AUTOSAVE_STORE, AUTOSAVE_KEY);
  } catch {
    /* ignore */
  }
}
