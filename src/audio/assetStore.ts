/*
 * Asset store — the binding constraint (Build Plan §1.1, §6.1).
 *
 *  - ONE decoded AudioBuffer per source asset, reference-counted.
 *  - Clips are non-owning views; duplicating a clip allocates nothing.
 *  - Original compressed files are cached in IndexedDB keyed by AssetId.
 *  - Decoded buffers are NEVER persisted (10x larger, cheap to rebuild).
 *  - A hard per-project byte budget, surfaced to the UI as a meter.
 *
 * Freesound audio for the current project is a working copy and MAY be cached.
 * Freesound search results and metadata must NEVER be persisted (non-negotiable
 * #5) — that is enforced in sources/freesound.ts, not here.
 */

import { openDB, type IDBPDatabase } from 'idb';
import { getAudioContext } from './context';
import { buildPeakPyramid, pyramidBytes, type PeakPyramid } from './peaks';
import type { AssetId, AssetRef } from '../state/project';

/** Provisional until S3 is measured in-browser. ~600 MB of decoded audio. */
export const ASSET_BUDGET_BYTES = 600 * 1024 * 1024;

const DB_NAME = 'scapemaker';
const DB_VERSION = 1;
const FILE_STORE = 'files'; // AssetId -> { blob, ref: AssetRef, savedAt }

interface CachedFile {
  id: AssetId;
  blob: Blob;
  ref: AssetRef;
  savedAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(FILE_STORE)) {
          d.createObjectStore(FILE_STORE, { keyPath: 'id' });
        }
      },
    }).catch((err) => {
      console.warn('[assetStore] IndexedDB unavailable, running memory-only:', err);
      throw err;
    });
  }
  return dbPromise;
}

async function idbGet(id: AssetId): Promise<CachedFile | undefined> {
  try {
    return (await db()).get(FILE_STORE, id) as Promise<CachedFile | undefined>;
  } catch {
    return undefined;
  }
}
async function idbPut(entry: CachedFile): Promise<void> {
  try {
    await (await db()).put(FILE_STORE, entry);
  } catch {
    /* lab machines may block storage; degrade silently */
  }
}
async function idbDelete(id: AssetId): Promise<void> {
  try {
    await (await db()).delete(FILE_STORE, id);
  } catch {
    /* ignore */
  }
}

export interface AssetEntry {
  ref: AssetRef;
  buffer: AudioBuffer;
  peaks: PeakPyramid;
  bytes: number; // decoded buffer + pyramid
}

type Source =
  | { kind: 'blob'; blob: Blob }
  | { kind: 'url'; url: string }
  | { kind: 'arrayBuffer'; data: ArrayBuffer };

export class AssetStore {
  private entries = new Map<AssetId, AssetEntry>();
  private refs = new Map<AssetId, number>();
  private inflight = new Map<AssetId, Promise<AssetEntry>>();
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  get usedBytes(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.bytes;
    return n;
  }
  get budgetBytes(): number {
    return ASSET_BUDGET_BYTES;
  }
  get overBudget(): boolean {
    return this.usedBytes > ASSET_BUDGET_BYTES;
  }

  has(id: AssetId): boolean {
    return this.entries.has(id);
  }
  peek(id: AssetId): AssetEntry | undefined {
    return this.entries.get(id);
  }
  getPeaks(id: AssetId): PeakPyramid | undefined {
    return this.entries.get(id)?.peaks;
  }
  getBuffer(id: AssetId): AudioBuffer | undefined {
    return this.entries.get(id)?.buffer;
  }

  /**
   * Ensure an asset is decoded and cached. Increments the ref count.
   * Deduplicates concurrent calls for the same id. `source` is only used on a
   * cache miss — pass the freshest way to obtain the bytes.
   */
  async acquire(ref: AssetRef, source: Source): Promise<AssetEntry> {
    const existing = this.entries.get(ref.id);
    if (existing) {
      this.refs.set(ref.id, (this.refs.get(ref.id) ?? 0) + 1);
      return existing;
    }
    const pending = this.inflight.get(ref.id);
    if (pending) {
      this.refs.set(ref.id, (this.refs.get(ref.id) ?? 0) + 1);
      return pending;
    }

    const task = this.load(ref, source);
    this.inflight.set(ref.id, task);
    try {
      const entry = await task;
      this.entries.set(ref.id, entry);
      this.refs.set(ref.id, (this.refs.get(ref.id) ?? 0) + 1);
      this.notify();
      return entry;
    } finally {
      this.inflight.delete(ref.id);
    }
  }

  private async load(ref: AssetRef, source: Source): Promise<AssetEntry> {
    let arrayBuf: ArrayBuffer;
    let blobForCache: Blob | null = null;

    const cached = await idbGet(ref.id);
    if (cached) {
      arrayBuf = await cached.blob.arrayBuffer();
      ref.cached = true;
    } else if (source.kind === 'arrayBuffer') {
      arrayBuf = source.data;
      blobForCache = new Blob([source.data]);
    } else if (source.kind === 'blob') {
      arrayBuf = await source.blob.arrayBuffer();
      blobForCache = source.blob;
    } else {
      const res = await fetch(source.url);
      if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${ref.title}`);
      const blob = await res.blob();
      arrayBuf = await blob.arrayBuffer();
      blobForCache = blob;
    }

    // decodeAudioData detaches the ArrayBuffer — clone for safety.
    const ctx = getAudioContext();
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(arrayBuf.slice(0));
    } catch {
      throw new Error(
        `Could not decode "${ref.title}". Supported: WAV, AIFF, MP3, OGG, FLAC, M4A.`,
      );
    }

    const peaks = buildPeakPyramid(buffer);
    const bytes = buffer.length * buffer.numberOfChannels * 4 + pyramidBytes(peaks);

    if (blobForCache) {
      // A working copy of the audio for the CURRENT project — allowed for every
      // source, Freesound included. Search results/metadata are never persisted
      // (that rule is enforced in sources/freesound.ts).
      void idbPut({ id: ref.id, blob: blobForCache, ref: { ...ref, cached: true }, savedAt: Date.now() });
      ref.cached = true;
    }

    // Fill in real decoded characteristics.
    ref.duration = buffer.duration;
    ref.sampleRate = buffer.sampleRate;
    ref.channels = buffer.numberOfChannels;

    return { ref, buffer, peaks, bytes };
  }

  /** Decrement ref count; evict the decoded buffer at zero. IndexedDB stays. */
  release(id: AssetId): void {
    const n = (this.refs.get(id) ?? 0) - 1;
    if (n <= 0) {
      this.refs.delete(id);
      this.entries.delete(id);
      this.notify();
    } else {
      this.refs.set(id, n);
    }
  }

  /** Remove from memory AND the IndexedDB cache. */
  async forget(id: AssetId): Promise<void> {
    this.refs.delete(id);
    this.entries.delete(id);
    await idbDelete(id);
    this.notify();
  }

  /** For project load: is the original file available offline? */
  async isCached(id: AssetId): Promise<boolean> {
    return (await idbGet(id)) !== undefined;
  }

  refCount(id: AssetId): number {
    return this.refs.get(id) ?? 0;
  }
}

export const assetStore = new AssetStore();
