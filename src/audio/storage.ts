/*
 * Storage durability.
 *
 * A .scapemaker file holds no audio, and a student's own recordings have no
 * downloadUrl to fall back on — the IndexedDB cache is the ONLY copy. Under
 * default ("best-effort") storage the browser may evict that whole origin when
 * the disk gets tight, and the project would reopen permanently broken with
 * nothing to re-fetch from.
 *
 * So: ask for persistent storage once, and report how much room is left.
 * Chrome grants it silently on a site the student uses; Firefox prompts;
 * Safari decides on its own. A refusal is not an error — it just means the
 * cache is evictable, which is worth saying out loud before a term's work
 * depends on it.
 */

import { store } from '../state/store';
import { formatBytes } from './assetStore';

export interface StorageStatus {
  /** true once the browser has promised not to evict this origin */
  persisted: boolean;
  /** bytes currently used by this origin, when the browser will say */
  usage: number | null;
  /** bytes this origin may use, when the browser will say */
  quota: number | null;
  /** the API is missing entirely (older Safari, or a locked-down lab machine) */
  supported: boolean;
}

let cached: StorageStatus | null = null;

/**
 * Ask for persistent storage and report what we got. Safe to call more than
 * once — the browser only decides the first time, and the answer is cached.
 */
export async function ensurePersistentStorage(): Promise<StorageStatus> {
  if (cached) return cached;

  const storage = navigator.storage;
  if (!storage || typeof storage.estimate !== 'function') {
    cached = { persisted: false, usage: null, quota: null, supported: false };
    return cached;
  }

  let persisted = false;
  try {
    persisted = (await storage.persisted?.()) ?? false;
    if (!persisted && typeof storage.persist === 'function') {
      persisted = await storage.persist();
    }
  } catch {
    /* a blocked or partial implementation — treat as not persisted */
  }

  let usage: number | null = null;
  let quota: number | null = null;
  try {
    const estimate = await storage.estimate();
    usage = estimate.usage ?? null;
    quota = estimate.quota ?? null;
  } catch {
    /* estimate is advisory; carry on without it */
  }

  cached = { persisted, usage, quota, supported: true };
  return cached;
}

/** Re-read usage without asking about persistence again. */
export async function readStorageEstimate(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    const estimate = await navigator.storage.estimate();
    const next = { usage: estimate.usage ?? null, quota: estimate.quota ?? null };
    if (cached) cached = { ...cached, ...next };
    return next;
  } catch {
    return { usage: null, quota: null };
  }
}

export function lastStorageStatus(): StorageStatus | null {
  return cached;
}

let warned = false;

/**
 * Say once, on the path where it matters, that the browser has not promised to
 * keep the cache. Only fires for a student's own recordings: everything else
 * has a source URL to re-download from, so an eviction there is an
 * inconvenience rather than lost work.
 */
export async function warnIfCacheIsEvictable(): Promise<void> {
  if (warned) return;
  const status = await ensurePersistentStorage();
  if (status.persisted) return;
  warned = true;
  store.toast(
    'warn',
    'This browser has not promised to keep your imported audio. Your recordings are safe on ' +
      'your own drive — keep the originals, because a project file contains no audio.',
    9000,
  );
}

/** One line about where the audio lives, for the memory meter's tooltip. */
export function storageSummary(): string {
  const status = lastStorageStatus();
  if (!status || !status.supported) return '';
  const room =
    status.usage != null && status.quota != null
      ? ` ${formatBytes(status.usage)} of ${formatBytes(status.quota)} used on disk.`
      : '';
  return status.persisted
    ? `Cached audio is stored persistently.${room}`
    : `Cached audio may be evicted by the browser if the disk fills — keep your original files.${room}`;
}
