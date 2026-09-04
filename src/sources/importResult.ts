/*
 * Turn a SoundResult (any of the four sources) into a placed clip with a full
 * attribution record. Handles the restricted-licence warning gate and records
 * the decision.
 */

import { assetStore } from '../audio/assetStore';
import { store } from '../state/store';
import { placeAsset, acknowledgeRestriction } from '../state/edits';
import { isRestrictive } from '../licence/model';
import { resolveArchiveAudio } from './archive';
import type { SoundResult } from './types';
import type { AssetRef } from '../state/project';
import { confirmRestrictedImport } from '../ui/dialogs/licenceWarning';
import { contentEnd } from '../state/project';

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

export async function importResultToTimeline(
  result: SoundResult,
  opts: { trackId?: string; start?: number } = {},
): Promise<ImportOutcome> {
  // restricted-licence gate
  if (isRestrictive(result.licence) || result.licence.id === 'unknown') {
    const proceed = await confirmRestrictedImport(result.licence, result.title);
    if (!proceed) return { ok: false, reason: 'cancelled' };
  }

  // resolve a fetchable URL
  let downloadUrl = result.previewUrl;
  if (!downloadUrl && (result.source === 'archive' || result.source === 'aporee') && result.nativeId) {
    const file = await resolveArchiveAudio(result.nativeId).catch(() => null);
    if (file) downloadUrl = file.url;
  }
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
  const p = store.get().project;
  const trackId = opts.trackId ?? p.tracks.find((t) => t.clips.length === 0)?.id ?? p.tracks[0]?.id;
  if (!trackId) return { ok: false, reason: 'No track to place on.' };
  const start = opts.start ?? contentEnd(p);

  try {
    await assetStore.acquire(ref, { kind: 'url', url: downloadUrl });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Fetch/decode failed.' };
  }

  placeAsset(ref, trackId, start);
  if (isRestrictive(ref.licence) || ref.licence.id === 'unknown') acknowledgeRestriction(ref.id);
  return { ok: true };
}

/** Import a local file's AssetRef (already decoded) onto the timeline. */
export function placeLocalAsset(ref: AssetRef, trackId?: string): void {
  const p = store.get().project;
  const tid = trackId ?? p.tracks.find((t) => t.clips.length === 0)?.id ?? p.tracks[0]?.id;
  if (!tid) return;
  placeAsset(ref, tid, contentEnd(p));
}
