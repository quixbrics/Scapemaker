/*
 * Asset store — the binding constraint (Build Plan §1.1, §6.1).
 *
 *  - ONE decoded AudioBuffer per source asset.
 *  - Clips are non-owning views; duplicating a clip allocates nothing.
 *  - Liveness is DERIVED from the project (`retain`), not reference-counted:
 *    undo and redo move clips in and out of existence without passing through
 *    any acquire/release pair, so a hand-kept count would drift.
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
/** Sweep idle assets once memory passes this fraction of the budget, leaving headroom for the next import. */
const EVICT_ABOVE = 0.8;

/**
 * Raised when decoded audio will not fit, even after evicting idle assets.
 * `full` is the recording that was decoded to find that out, so the caller can
 * offer to keep part of it (sources/excerpt.ts) without decoding it again.
 */
export class AssetBudgetError extends Error {
  constructor(
    readonly title: string,
    readonly needBytes: number,
    readonly usedBytes: number,
    readonly budgetBytes = ASSET_BUDGET_BYTES,
    readonly full?: AssetEntry,
  ) {
    super(
      `"${title}" needs ${formatBytes(needBytes)} of audio memory and there is not enough room ` +
        `(${formatBytes(usedBytes)} of ${formatBytes(budgetBytes)} in use). ` +
        `Delete some clips you are not using, or start a new project.`,
    );
    this.name = 'AssetBudgetError';
  }
}

/** Decoded audio is 32-bit float per channel per sample. */
export function bytesPerSecond(sampleRate: number, channels: number): number {
  return sampleRate * channels * 4;
}

/** Anything with an AudioBuffer's shape — lets the tests slice a fake one. */
interface BufferLike {
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * Copy `[start, start + duration)` of `buffer` into a new buffer made by
 * `create`. The original can then be dropped, which is the point.
 */
export function sliceBuffer<B extends BufferLike>(
  buffer: BufferLike,
  start: number,
  duration: number,
  create: (channels: number, length: number, sampleRate: number) => B,
): B {
  const from = Math.max(0, Math.min(buffer.length - 1, Math.round(start * buffer.sampleRate)));
  const length = Math.max(1, Math.min(buffer.length - from, Math.round(duration * buffer.sampleRate)));
  const out = create(buffer.numberOfChannels, length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.getChannelData(c).set(buffer.getChannelData(c).subarray(from, from + length));
  }
  return out;
}

/** Where an asset's original file is cached: an excerpt shares its original's. */
export function cacheKey(ref: Pick<AssetRef, 'id' | 'excerpt'>): AssetId {
  return ref.excerpt?.of ?? ref.id;
}

const createInContext = (channels: number, length: number, sampleRate: number) =>
  getAudioContext().createBuffer(channels, length, sampleRate);

export function formatBytes(n: number): string {
  if (n <= 0) return '0 MB';
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

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

/** 0..1 while fetching; -1 once fetch is done and decode has started (no native decode progress). */
export type ProgressFn = (fraction: number) => void;

/** Fetch with byte-level progress when the server sends Content-Length; falls back to a plain fetch otherwise. */
async function fetchWithProgress(
  url: string,
  title: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<Blob> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${title}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!onProgress || !res.body || !total) {
    return res.blob();
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(1, received / total));
  }
  return new Blob(chunks as BlobPart[]);
}

export class AssetStore {
  private entries = new Map<AssetId, AssetEntry>();
  /**
   * Assets the project still refers to. Derived from the project on every
   * change (see `retain`) rather than reference-counted by hand: the project
   * IS the truth about what is live, and undo/redo move clips in and out of
   * existence without going through any acquire/release pair.
   */
  private live = new Set<AssetId>();
  /** When each no-longer-referenced asset fell out of use, for eviction order. */
  private idleSince = new Map<AssetId, number>();
  private inflight = new Map<AssetId, Promise<AssetEntry>>();
  private listeners = new Set<() => void>();
  /**
   * The audio-memory ceiling. A field rather than the bare constant so it can
   * be lowered from the console to try the excerpt path without a huge file:
   * `scapemaker.assetStore.budget = 50 * 2 ** 20`.
   */
  budget = ASSET_BUDGET_BYTES;

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
    return this.budget;
  }
  get overBudget(): boolean {
    return this.usedBytes > this.budget;
  }
  /** 0..1 of the budget in use — what the meter draws. */
  get usedFraction(): number {
    return this.usedBytes / this.budget;
  }

  /**
   * Room for new audio if every idle asset were swept — what an excerpt may
   * use. Live assets are never evicted, so they are the only thing counted.
   */
  roomBytes(): number {
    let live = 0;
    for (const [id, e] of this.entries) if (!this.idleSince.has(id)) live += e.bytes;
    return Math.max(0, this.budget - live);
  }

  /**
   * Tell the store which assets the project still uses. Anything decoded but
   * absent from `ids` becomes evictable; anything that comes back (undo, or a
   * re-added clip) stops being evictable again without a re-decode.
   *
   * Nothing is thrown away here. An idle asset is kept until the memory is
   * actually wanted, so undoing a delete is instant rather than a re-decode.
   */
  retain(ids: Iterable<AssetId>): void {
    this.live = new Set(ids);
    const now = Date.now();
    for (const id of this.entries.keys()) {
      if (this.live.has(id)) this.idleSince.delete(id);
      else if (!this.idleSince.has(id)) this.idleSince.set(id, now);
    }
    if (this.usedBytes > this.budget * EVICT_ABOVE) this.sweep();
  }

  /**
   * Drop idle assets, oldest first, until back under the high-water mark.
   * Returns the bytes reclaimed. Live assets are never touched — running out
   * of room is reported to the student, not silently papered over by unloading
   * audio their timeline still points at.
   */
  private sweep(target = this.budget * EVICT_ABOVE): number {
    const idle = [...this.idleSince.entries()]
      .filter(([id]) => this.entries.has(id))
      .sort((a, b) => a[1] - b[1]);

    let freed = 0;
    for (const [id] of idle) {
      if (this.usedBytes <= target) break;
      freed += this.entries.get(id)?.bytes ?? 0;
      this.entries.delete(id);
      this.idleSince.delete(id);
    }
    if (freed > 0) this.notify();
    return freed;
  }

  /** Decoded assets the project no longer refers to, and what they cost. */
  idleBytes(): number {
    let n = 0;
    for (const id of this.idleSince.keys()) n += this.entries.get(id)?.bytes ?? 0;
    return n;
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
   * Ensure an asset is decoded and in memory. Deduplicates concurrent calls
   * for the same id. `source` is only used on a cache miss — pass the freshest
   * way to obtain the bytes. `onProgress` reports fetch progress (0..1, or -1
   * once decoding starts — decodeAudioData has no progress event) so the UI
   * can show something better than a spinner on a slow file.
   *
   * Throws AssetBudgetError if the decoded audio would not fit even after
   * idle assets are evicted. That is a refusal the student is told about, not
   * a tab that dies partway through a decode.
   */
  async acquire(
    ref: AssetRef,
    source: Source,
    onProgress?: ProgressFn,
    signal?: AbortSignal,
  ): Promise<AssetEntry> {
    const existing = this.entries.get(ref.id);
    if (existing) {
      this.idleSince.delete(ref.id);
      return existing;
    }
    const pending = this.inflight.get(ref.id);
    if (pending) return pending;

    const task = this.load(ref, source, onProgress, signal);
    this.inflight.set(ref.id, task);
    try {
      return this.admit(await task, true);
    } finally {
      this.inflight.delete(ref.id);
    }
  }

  /**
   * Keep only part of a recording that did not fit (the `full` entry carried
   * by an AssetBudgetError). Cut from the buffer already in hand — no second
   * fetch or decode — and admitted under the excerpt's own id.
   */
  admitExcerpt(full: AssetEntry, excerptRef: AssetRef): AssetEntry {
    const ex = excerptRef.excerpt;
    if (!ex) throw new Error('admitExcerpt needs a ref with an excerpt range');
    const existing = this.entries.get(excerptRef.id);
    if (existing) return this.admit(existing, false);
    const buffer = sliceBuffer(full.buffer, ex.start, ex.duration, createInContext);
    return this.admit(this.entryFor({ ...excerptRef }, buffer), false);
  }

  /** Make room, then refuse rather than blow the budget. */
  private admit(entry: AssetEntry, offerExcerpt: boolean): AssetEntry {
    const id = entry.ref.id;
    if (this.usedBytes + entry.bytes > this.budget) this.sweep(this.budget - entry.bytes);
    if (this.usedBytes + entry.bytes > this.budget) {
      throw new AssetBudgetError(entry.ref.title, entry.bytes, this.usedBytes, this.budget, offerExcerpt ? entry : undefined);
    }
    this.entries.set(id, entry);
    this.idleSince.delete(id);
    this.notify();
    return entry;
  }

  private entryFor(ref: AssetRef, buffer: AudioBuffer): AssetEntry {
    const peaks = buildPeakPyramid(buffer);
    const bytes = buffer.length * buffer.numberOfChannels * 4 + pyramidBytes(peaks);
    ref.duration = buffer.duration;
    ref.sampleRate = buffer.sampleRate;
    ref.channels = buffer.numberOfChannels;
    return { ref, buffer, peaks, bytes };
  }

  private async load(
    ref: AssetRef,
    source: Source,
    onProgress?: ProgressFn,
    signal?: AbortSignal,
  ): Promise<AssetEntry> {
    let arrayBuf: ArrayBuffer;
    let blobForCache: Blob | null = null;

    const key = cacheKey(ref);
    const cached = await idbGet(key);
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
      const blob = await fetchWithProgress(source.url, ref.title, onProgress, signal);
      arrayBuf = await blob.arrayBuffer();
      blobForCache = blob;
    }

    onProgress?.(-1); // decodeAudioData has no progress event
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

    if (blobForCache) {
      // A working copy of the audio for the CURRENT project — allowed for every
      // source, Freesound included. Search results/metadata are never persisted
      // (that rule is enforced in sources/freesound.ts). An excerpt caches the
      // whole original under the original's id: the cut is re-made on load.
      void idbPut({ id: key, blob: blobForCache, ref: { ...ref, id: key, excerpt: undefined, cached: true }, savedAt: Date.now() });
      ref.cached = true;
    }

    // Keep only the excerpt; the full decode is dropped when this returns.
    if (ref.excerpt) buffer = sliceBuffer(buffer, ref.excerpt.start, ref.excerpt.duration, createInContext);

    return this.entryFor(ref, buffer);
  }

  /** Remove from memory AND the IndexedDB cache. */
  async forget(id: AssetId): Promise<void> {
    this.entries.delete(id);
    this.idleSince.delete(id);
    this.live.delete(id);
    await idbDelete(id);
    this.notify();
  }

  /** For project load: is the original file available offline? Pass `cacheKey(ref)` for an excerpt. */
  async isCached(id: AssetId): Promise<boolean> {
    return (await idbGet(id)) !== undefined;
  }

  /** Is this asset decoded but no longer referenced by the project? */
  isIdle(id: AssetId): boolean {
    return this.idleSince.has(id);
  }
}

export const assetStore = new AssetStore();
