/*
 * Long recordings that will not fit in audio memory.
 *
 * The ceiling is on DECODED audio: every sound is held as 48 kHz 32-bit float
 * so it can play instantly, which makes an hour of stereo about 1.4 GB however
 * small the MP3 was. Internet Archive field recordings are often that long.
 * Rather than refuse, offer to keep a section of it — which is all a
 * soundscape usually wants from a long recording anyway.
 *
 * Known limit: decodeAudioData has to decode the whole file once to find out,
 * so a very long file (2 h+, ~2.7 GB) can still be too much for a low-memory
 * machine at that one moment. Streaming decode would need WebCodecs plus a
 * demuxer per container — a much bigger change.
 */

import { assetStore, AssetBudgetError, bytesPerSecond, type AssetEntry, type ProgressFn } from '../audio/assetStore';
import type { AssetRef } from '../state/project';
import { timecode } from '../ui/dom';
import { chooseExcerpt } from '../ui/dialogs/excerpt';

type Source = Parameters<typeof assetStore.acquire>[1];

/** Below this, an excerpt is not worth offering. */
export const MIN_EXCERPT_SECONDS = 5;
/** What the dialog proposes first, if there is room for it. */
export const DEFAULT_EXCERPT_SECONDS = 600;

/**
 * The longest section that fits in `roomBytes`. The peak pyramid adds a few
 * percent on top of the samples, so leave that much slack.
 */
export function maxExcerptSeconds(roomBytes: number, sampleRate: number, channels: number): number {
  const bps = bytesPerSecond(sampleRate, channels);
  if (bps <= 0) return 0;
  return Math.floor((roomBytes * 0.96) / bps);
}

/**
 * A new asset for part of `ref`. Same source, author and licence — an excerpt
 * is still that recording, and the credit must say so — but its own id, so it
 * can sit in the bin beside another excerpt of the same file.
 */
export function excerptRef(ref: AssetRef, start: number, duration: number): AssetRef {
  const of = ref.excerpt?.of ?? ref.id;
  const from = (ref.excerpt?.start ?? 0) + start;
  return {
    ...ref,
    id: `${of}@${from.toFixed(1)}+${duration.toFixed(1)}`,
    title: `${ref.title} (${timecode(from, false)}–${timecode(from + duration, false)})`,
    duration,
    excerpt: { of, start: from, duration },
  };
}

/**
 * `assetStore.acquire`, but a recording too long to fit becomes an offer to
 * keep part of it. Resolves null if the student cancels. Anything else —
 * including a project so full there is no room for even a short excerpt —
 * is thrown as before.
 */
export async function acquireOrExcerpt(
  ref: AssetRef,
  source: Source,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<AssetEntry | null> {
  try {
    return await assetStore.acquire(ref, source, onProgress, signal);
  } catch (err) {
    if (!(err instanceof AssetBudgetError) || !err.full) throw err;
    const full = err.full;
    const max = Math.min(
      full.buffer.duration,
      maxExcerptSeconds(assetStore.roomBytes(), full.buffer.sampleRate, full.buffer.numberOfChannels),
    );
    if (max < MIN_EXCERPT_SECONDS) throw err;
    const range = await chooseExcerpt({
      title: ref.title,
      full,
      needBytes: err.needBytes,
      maxSeconds: max,
      defaultSeconds: Math.min(DEFAULT_EXCERPT_SECONDS, max),
    });
    if (!range) return null;
    return assetStore.admitExcerpt(full, excerptRef(full.ref, range.start, range.duration));
  }
}
