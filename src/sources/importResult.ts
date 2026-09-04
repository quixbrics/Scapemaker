/*
 * Turn a SoundResult (any of the four sources) into a placed clip with a full
 * attribution record. Handles the restricted-licence warning gate and records
 * the decision.
 *
 * The whole path — resolving a playable URL, fetching it, decoding it — can
 * take a visible moment for a large field recording. A PendingImport is
 * registered on the store for the duration so the timeline can show exactly
 * where the clip is landing and how far along it is, instead of leaving the
 * student staring at nothing and clicking again.
 */

import { assetStore } from '../audio/assetStore';
import { store } from '../state/store';
import { placeAsset, acknowledgeRestriction } from '../state/edits';
import { isRestrictive } from '../licence/model';
import { resolveArchiveAudio } from './archive';
import type { SoundResult } from './types';
import type { AssetRef } from '../state/project';
import { confirmRestrictedImport } from '../ui/dialogs/licenceWarning';
import { contentEnd, uid } from '../state/project';

function refFromResult(r: SoundResult, downloadUrl?: string): AssetRef {
  return {
    id: r.id,
    title: r.title,
    source: r.source,
    sourceId: r.nativeId,
    sourceUrl: r.sourceUrl,
    downloadUrl: downloadUrl ?? r.previewUrl,
    author: r.author,
    licence: r.licence,
    duration: r.duration,
    sampleRate: 0,
    channels: 0,
    location: r.location,
    recordedAt: r.recordedAt,
    importedAt: new Date().toISOString(),
    cached: false,
  };
}

export interface ImportOutcome {
  ok: boolean;
  reason?: string;
}

/** Fallback width for the placeholder when the source gives no duration up front (archive/aporee — Freesound does). */
const UNKNOWN_DURATION_ESTIMATE = 8;

/** In-flight imports, so a student can call one off from the timeline placeholder. */
const inFlight = new Map<string, AbortController>();

/** Cancel a pending import by its PendingImport id (the × on the placeholder). */
export function cancelImport(pendingId: string): void {
  inFlight.get(pendingId)?.abort();
  inFlight.delete(pendingId);
  store.removePendingImport(pendingId);
}

export async function importResultToTimeline(
  result: SoundResult,
  opts: { trackId?: string; start?: number } = {},
): Promise<ImportOutcome> {
  // restricted-licence gate — before any placeholder, since this is a modal decision
  if (isRestrictive(result.licence) || result.licence.id === 'unknown') {
    const proceed = await confirmRestrictedImport(result.licence, result.title);
    if (!proceed) return { ok: false, reason: 'cancelled' };
  }

  const p = store.get().project;
  const trackId = opts.trackId ?? p.tracks.find((t) => t.clips.length === 0)?.id ?? p.tracks[0]?.id;
  if (!trackId) return { ok: false, reason: 'No track to place on.' };
  const start = opts.start ?? contentEnd(p);

  const pendingId = uid('pending');
  const abort = new AbortController();
  inFlight.set(pendingId, abort);
  store.addPendingImport({
    id: pendingId,
    trackId,
    start,
    duration: result.duration || UNKNOWN_DURATION_ESTIMATE,
    title: result.title,
    phase: 'resolving',
    fraction: -1,
  });
  const cancelled = () => abort.signal.aborted;

  try {
    // resolve a fetchable URL — the slow, invisible step on archive/aporee
    let downloadUrl = result.previewUrl;
    if (!downloadUrl && (result.source === 'archive' || result.source === 'aporee') && result.nativeId) {
      const file = await resolveArchiveAudio(result.nativeId, abort.signal).catch(() => null);
      if (file) downloadUrl = file.url;
    }
    if (cancelled()) return { ok: false, reason: 'cancelled' };
    if (!downloadUrl) {
      return {
        ok: false,
        reason:
          result.source === 'freesound'
            ? 'No preview available. Download the file from freesound.org and drag it in — the credit is still captured.'
            : 'Could not find a playable file for this item.',
      };
    }

    const ref = refFromResult(result, downloadUrl);

    store.updatePendingImport(pendingId, { phase: 'fetching', fraction: 0 });
    try {
      await assetStore.acquire(
        ref,
        { kind: 'url', url: downloadUrl },
        (fraction) => {
          store.updatePendingImport(pendingId, {
            phase: fraction < 0 ? 'decoding' : 'fetching',
            fraction,
          });
        },
        abort.signal,
      );
    } catch (err) {
      if (cancelled()) return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: err instanceof Error ? err.message : 'Fetch/decode failed.' };
    }
    if (cancelled()) return { ok: false, reason: 'cancelled' };

    placeAsset(ref, trackId, start);
    if (isRestrictive(ref.licence) || ref.licence.id === 'unknown') acknowledgeRestriction(ref.id);
    return { ok: true };
  } finally {
    inFlight.delete(pendingId);
    store.removePendingImport(pendingId);
  }
}

/** Import a local file's AssetRef (already decoded) onto the timeline. */
export function placeLocalAsset(ref: AssetRef, trackId?: string): void {
  const p = store.get().project;
  const tid = trackId ?? p.tracks.find((t) => t.clips.length === 0)?.id ?? p.tracks[0]?.id;
  if (!tid) return;
  placeAsset(ref, tid, contentEnd(p));
}
