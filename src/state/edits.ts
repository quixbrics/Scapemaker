/*
 * Timeline edit operations, each an undoable history Command (Build Plan §7.3):
 * move, trim, split, duplicate, delete, plus track-level gain/pan/mute/solo and
 * effect toggles. All non-destructive — nothing here touches a decoded buffer.
 */

import { history, trackEditCommand, coalescedEdit, endCoalescedEdit, type Command } from './history';
import { store } from './store';
import {
  makeClip,
  makeTrack,
  nextTrackIndex,
  MAX_TRACKS,
  uid,
  type AssetRef,
  type Clip,
  type Project,
  type Track,
} from './project';
import { assetStore } from '../audio/assetStore';
import { fitDuration } from './project';

function findTrack(p: Project, id: string): Track | undefined {
  return p.tracks.find((t) => t.id === id);
}
function findClip(p: Project, trackId: string, clipId: string): Clip | undefined {
  return findTrack(p, trackId)?.clips.find((c) => c.id === clipId);
}

export function addTrack(): void {
  const p = store.get().project;
  if (p.tracks.length >= MAX_TRACKS) {
    store.toast('warn', `The timeline holds ${MAX_TRACKS} tracks — enough complexity, few enough to stay legible.`);
    return;
  }
  // The lowest free colour slot, not tracks.length: after a delete those
  // differ, and reusing a live track's index would duplicate its colour.
  const track = makeTrack(nextTrackIndex(p.tracks));
  history.push({
    label: 'Add track',
    do: (pr) => pr.tracks.push(structuredClone(track)),
    undo: (pr) => {
      pr.tracks = pr.tracks.filter((t) => t.id !== track.id);
    },
  });
}

/**
 * Remove a track and everything on it. The last track stays: an empty timeline
 * with nowhere to drop a sound is a dead end, not a state worth reaching.
 */
export function removeTrack(trackId: string): void {
  const p = store.get().project;
  if (p.tracks.length <= 1) {
    store.toast('info', 'A project keeps at least one track.');
    return;
  }
  const index = p.tracks.findIndex((t) => t.id === trackId);
  if (index < 0) return;
  const removed = structuredClone(p.tracks[index]);
  const clipCount = removed.clips.length;

  history.push({
    label: clipCount > 0 ? `Delete track (${clipCount} clip${clipCount === 1 ? '' : 's'})` : 'Delete track',
    do: (pr) => {
      pr.tracks = pr.tracks.filter((t) => t.id !== trackId);
    },
    // Back in its original position, not appended, so the timeline does not
    // reshuffle under the student on undo.
    undo: (pr) => pr.tracks.splice(index, 0, structuredClone(removed)),
  });

  const selection = store.get().ui.selection;
  if (selection.trackId === trackId) store.patchUi({ selection: { trackId: null, clipId: null } });
  if (store.get().ui.automationView?.trackId === trackId) store.patchUi({ automationView: null });
}

/** Master bus trim in dB — coalesced like any other fader. */
export function setMasterGain(db: number): void {
  coalescedEdit(
    'master:gain',
    'Master gain',
    (p) => p.masterGain ?? 0,
    (p, v) => {
      p.masterGain = v;
    },
    db,
  );
}

/** Place an already-imported asset as a new clip on `trackId` at `start`. */
export function placeAsset(ref: AssetRef, trackId: string, start: number): void {
  const p = store.get().project;
  const track = findTrack(p, trackId) ?? p.tracks[0];
  if (!track) return;
  const entry = assetStore.peek(ref.id);
  const duration = entry?.buffer.duration ?? ref.duration ?? 5;
  // Fixed up front so undo can match on it. Matching on (assetId, start)
  // instead removed EVERY copy of the same sound placed at the same spot.
  const clipId = uid('clp');
  const at = Math.max(0, start);

  const cmd: Command = {
    label: `Add "${ref.title}"`,
    do(pr) {
      pr.assets[ref.id] = { ...ref, duration };
      const t = findTrack(pr, track.id);
      t?.clips.push({ ...makeClip(ref.id, at, duration), id: clipId });
      pr.duration = fitDuration(pr);
    },
    undo(pr) {
      const t = findTrack(pr, track.id);
      if (t) t.clips = t.clips.filter((c) => c.id !== clipId);
      // keep the asset ref; harmless and avoids churning the bin
    },
  };
  history.push(cmd);
  store.patchUi({ selection: { trackId: track.id, clipId: null } });
}

export function moveClip(trackId: string, clipId: string, newStart: number, newTrackId?: string): void {
  const p = store.get().project;
  const clip = findClip(p, trackId, clipId);
  if (!clip) return;
  const from = { start: clip.start, trackId };
  const targetTrackId = newTrackId ?? trackId;

  history.push({
    label: 'Move clip',
    do(pr) {
      const srcT = findTrack(pr, trackId)!;
      const c = srcT.clips.find((x) => x.id === clipId)!;
      c.start = Math.max(0, newStart);
      if (targetTrackId !== trackId) {
        srcT.clips = srcT.clips.filter((x) => x.id !== clipId);
        findTrack(pr, targetTrackId)?.clips.push(c);
      }
      pr.duration = fitDuration(pr);
    },
    undo(pr) {
      let c: Clip | undefined;
      const cur = findTrack(pr, targetTrackId);
      if (cur) {
        c = cur.clips.find((x) => x.id === clipId);
        if (c && targetTrackId !== from.trackId) {
          cur.clips = cur.clips.filter((x) => x.id !== clipId);
          findTrack(pr, from.trackId)?.clips.push(c);
        }
      }
      if (c) c.start = from.start;
    },
  });
}

/**
 * Crossfade tool (UI spec §4.5 / Build Plan §7.5): drag a clip to overlap its
 * same-track neighbour, and the overlap becomes a crossfade — the earlier
 * clip's fade-out and the later clip's fade-in both set to the overlap length.
 * Equal-power is the default, matching the concept's ambience-first framing.
 * Same-track only; a cross-track drop just moves the clip with no crossfade.
 */
export function moveClipWithCrossfade(trackId: string, clipId: string, newStart: number): void {
  const p = store.get().project;
  const track = findTrack(p, trackId);
  const clip = findClip(p, trackId, clipId);
  if (!track || !clip) return;
  const from = clip.start;
  const fromFadeIn = { ...clip.fadeIn };
  const fromFadeOut = { ...clip.fadeOut };

  const clampedStart = Math.max(0, newStart);
  const neighbours = track.clips.filter((c) => c.id !== clipId);
  const clipEnd = clampedStart + clip.duration;

  let leftNeighbour: Clip | undefined; // ends inside/after our start — we overlap its tail
  let rightNeighbour: Clip | undefined; // starts inside our span — we overlap its head
  for (const n of neighbours) {
    const nEnd = n.start + n.duration;
    if (n.start < clampedStart && nEnd > clampedStart) leftNeighbour = n;
    if (n.start < clipEnd && n.start >= clampedStart) rightNeighbour = n;
  }

  const leftBefore = leftNeighbour ? { ...leftNeighbour.fadeOut } : null;
  const rightBefore = rightNeighbour ? { ...rightNeighbour.fadeIn } : null;
  const leftId = leftNeighbour?.id;
  const rightId = rightNeighbour?.id;

  history.push({
    label: 'Crossfade',
    do(pr) {
      const t = findTrack(pr, trackId)!;
      const c = t.clips.find((x) => x.id === clipId)!;
      c.start = clampedStart;

      if (leftId) {
        const left = t.clips.find((x) => x.id === leftId)!;
        const overlap = Math.min(left.start + left.duration - clampedStart, left.duration, c.duration);
        if (overlap > 0.02) {
          left.fadeOut = { duration: overlap, curve: 'equalPower' };
          c.fadeIn = { duration: overlap, curve: 'equalPower' };
        }
      }
      if (rightId) {
        const right = t.clips.find((x) => x.id === rightId)!;
        const overlap = Math.min(clipEnd - right.start, right.duration, c.duration);
        if (overlap > 0.02) {
          c.fadeOut = { duration: overlap, curve: 'equalPower' };
          right.fadeIn = { duration: overlap, curve: 'equalPower' };
        }
      }
      pr.duration = fitDuration(pr);
    },
    undo(pr) {
      const t = findTrack(pr, trackId)!;
      const c = t.clips.find((x) => x.id === clipId)!;
      c.start = from;
      c.fadeIn = fromFadeIn;
      c.fadeOut = fromFadeOut;
      if (leftId && leftBefore) {
        const left = t.clips.find((x) => x.id === leftId);
        if (left) left.fadeOut = leftBefore;
      }
      if (rightId && rightBefore) {
        const right = t.clips.find((x) => x.id === rightId);
        if (right) right.fadeIn = rightBefore;
      }
    },
  });
}

export function trimClip(
  trackId: string,
  clipId: string,
  edge: 'start' | 'end',
  deltaSeconds: number,
): void {
  const p = store.get().project;
  const clip = findClip(p, trackId, clipId);
  if (!clip) return;
  const asset = assetStore.peek(clip.assetId);
  const maxDur = asset?.buffer.duration ?? clip.sourceOffset + clip.duration;

  history.push(
    trackEditCommand('Trim clip', trackId, (pr) => {
      const c = findClip(pr, trackId, clipId)!;
      if (edge === 'start') {
        const d = Math.max(-c.sourceOffset, Math.min(deltaSeconds, c.duration - 0.05));
        c.start += d;
        c.sourceOffset += d;
        c.duration -= d;
      } else {
        const room = maxDur - (c.sourceOffset + c.duration);
        const d = Math.max(-(c.duration - 0.05), Math.min(deltaSeconds, room));
        c.duration += d;
      }
      pr.duration = fitDuration(pr);
    }),
  );
}

export function splitClipAtPlayhead(): void {
  const { project, transport, ui } = store.get();
  const { trackId, clipId } = ui.selection;
  if (!trackId || !clipId) {
    store.toast('info', 'Select a clip first, then split at the playhead — Cmd/Ctrl + K.');
    return;
  }
  const clip = findClip(project, trackId, clipId);
  if (!clip) return;
  const at = transport.playhead;
  if (at <= clip.start + 0.02 || at >= clip.start + clip.duration - 0.02) {
    store.toast('info', 'Move the playhead over the selected clip to split it.');
    return;
  }
  const offsetIntoClip = at - clip.start;

  history.push(
    trackEditCommand('Split clip', trackId, (pr) => {
      const t = findTrack(pr, trackId)!;
      const i = t.clips.findIndex((c) => c.id === clipId);
      const c = t.clips[i];
      const right: Clip = {
        ...structuredClone(c),
        id: uid('clp'),
        start: c.start + offsetIntoClip,
        sourceOffset: c.sourceOffset + offsetIntoClip,
        duration: c.duration - offsetIntoClip,
        fadeIn: { duration: 0, curve: c.fadeIn.curve },
      };
      c.duration = offsetIntoClip;
      c.fadeOut = { duration: 0, curve: c.fadeOut.curve };
      t.clips.splice(i + 1, 0, right);
    }),
  );
}

// --- copy / paste --------------------------------------------------------

let clipboard: { clip: Clip; trackId: string } | null = null;

/** Cmd/Ctrl+C — copies the selected clip's parameters (not audio) to an in-memory clipboard. */
export function copySelectedClip(): void {
  const { trackId, clipId } = store.get().ui.selection;
  if (!trackId || !clipId) return;
  const clip = findClip(store.get().project, trackId, clipId);
  if (!clip) return;
  clipboard = { clip: structuredClone(clip), trackId };
  store.toast('info', 'Clip copied — Cmd/Ctrl + V to paste at the playhead.', 2200);
}

/**
 * Cmd/Ctrl+V — pastes onto the selected track (falling back to the track it
 * was copied from) at the current playhead position. Same asset, new clip —
 * allocates no audio, exactly like duplicate.
 */
export function pasteClip(): void {
  if (!clipboard) return;
  const { trackId: selectedTrack } = store.get().ui.selection;
  const targetTrackId = selectedTrack ?? clipboard.trackId;
  if (!findTrack(store.get().project, targetTrackId)) return;
  const at = Math.max(0, store.get().transport.playhead);
  const newId = uid('clp');
  const source = clipboard.clip;

  history.push({
    label: 'Paste clip',
    do(pr) {
      const t = findTrack(pr, targetTrackId)!;
      t.clips.push({ ...structuredClone(source), id: newId, start: at });
      pr.duration = fitDuration(pr);
    },
    undo(pr) {
      const t = findTrack(pr, targetTrackId);
      if (t) t.clips = t.clips.filter((c) => c.id !== newId);
    },
  });
  store.patchUi({ selection: { trackId: targetTrackId, clipId: newId } });
}

export function duplicateClip(trackId: string, clipId: string): void {
  const p = store.get().project;
  const clip = findClip(p, trackId, clipId);
  if (!clip) return;
  const newId = uid('clp');
  history.push(
    trackEditCommand('Duplicate clip', trackId, (pr) => {
      const t = findTrack(pr, trackId)!;
      const c = t.clips.find((x) => x.id === clipId)!;
      // duplicating a clip allocates NO audio — it's another view onto the asset
      t.clips.push({ ...structuredClone(c), id: newId, start: c.start + c.duration });
      pr.duration = fitDuration(pr);
    }),
  );
  store.patchUi({ selection: { trackId, clipId: newId } });
}

export function deleteClip(trackId: string, clipId: string): void {
  const p = store.get().project;
  if (!findClip(p, trackId, clipId)) return;
  history.push(
    trackEditCommand('Delete clip', trackId, (pr) => {
      const t = findTrack(pr, trackId)!;
      t.clips = t.clips.filter((c) => c.id !== clipId);
    }),
  );
  const { selection } = store.get().ui;
  if (selection.clipId === clipId) store.patchUi({ selection: { trackId, clipId: null } });
}

export function setClipLoop(trackId: string, clipId: string, count: number, crossfade: number): void {
  history.push(
    trackEditCommand('Loop clip', trackId, (pr) => {
      const c = findClip(pr, trackId, clipId);
      if (!c) return;
      c.loop = { enabled: count > 1, count: Math.max(1, count), crossfade: Math.max(0, crossfade) };
      pr.duration = fitDuration(pr);
    }),
  );
}

const DEFAULT_LOOP_CROSSFADE = 0.05;

/** How many whole+partial iterations of `iterDuration` (minus the crossfade overlap) fit a target span. */
export function loopCountForSpan(iterDuration: number, crossfade: number, targetSpan: number): number {
  const xfade = Math.min(crossfade, Math.max(0, iterDuration - 0.01));
  const step = Math.max(0.01, iterDuration - xfade);
  const count = 1 + Math.round((targetSpan - iterDuration) / step);
  return Math.max(1, Math.min(200, count));
}

/**
 * Loop tool (UI spec §7.4 / Build Plan §7.4): drag a clip's edge with the loop
 * tool active and it repeats its own content for as long as you drag, instead
 * of trimming into silence. `targetSpanSeconds` is the full on-timeline length
 * the student dragged out to; the iteration length (`clip.duration`) never
 * changes — only how many times it repeats.
 */
export function dragLoopClip(trackId: string, clipId: string, targetSpanSeconds: number): void {
  const p = store.get().project;
  const clip = findClip(p, trackId, clipId);
  if (!clip) return;
  const crossfade = clip.loop?.crossfade ?? DEFAULT_LOOP_CROSSFADE;
  const count = loopCountForSpan(clip.duration, crossfade, Math.max(clip.duration, targetSpanSeconds));
  setClipLoop(trackId, clipId, count, crossfade);
}

export function setClipFade(
  trackId: string,
  clipId: string,
  which: 'fadeIn' | 'fadeOut',
  duration: number,
  curve?: 'linear' | 'equalPower',
): void {
  history.push(
    trackEditCommand('Adjust fade', trackId, (pr) => {
      const c = findClip(pr, trackId, clipId);
      if (!c) return;
      c[which] = { duration: Math.max(0, duration), curve: curve ?? c[which].curve };
    }),
  );
}

// --- track params (coalesced; not every drag frame is a discrete undo) -----

function setTrackField<K extends keyof Track>(
  trackId: string,
  field: K,
  value: Track[K],
  label: string,
  coalesce = true,
): void {
  if (!findTrack(store.get().project, trackId)) return;
  const read = (p: Project) => findTrack(p, trackId)?.[field] as Track[K];
  const write = (p: Project, v: Track[K]) => {
    const t = findTrack(p, trackId);
    if (t) t[field] = v;
  };
  // A discrete toggle (mute, solo, rename) is its own undo step and must not
  // absorb the next one.
  if (!coalesce) endCoalescedEdit();
  coalescedEdit(`${trackId}:${String(field)}`, label, read, write, value);
  if (!coalesce) endCoalescedEdit();
}

export const setTrackGain = (id: string, db: number) => setTrackField(id, 'gain', db, 'Track gain');
export const setTrackPan = (id: string, pan: number) => setTrackField(id, 'pan', pan, 'Track pan');
export function toggleMute(id: string): void {
  const t = findTrack(store.get().project, id);
  if (t) setTrackField(id, 'muted', !t.muted, 'Mute', false);
}
export function toggleSolo(id: string): void {
  const t = findTrack(store.get().project, id);
  if (t) setTrackField(id, 'solo', !t.solo, 'Solo', false);
}
export function renameTrack(id: string, name: string): void {
  setTrackField(id, 'name', name.trim() || 'Track', 'Rename track', false);
}

export function updateAssetLicence(assetId: string, licence: AssetRef['licence']): void {
  store.mutateProject((pr) => {
    const ref = pr.assets[assetId];
    if (ref) ref.licence = licence;
  });
}
export function updateAssetAuthor(assetId: string, author: string): void {
  store.mutateProject((pr) => {
    const ref = pr.assets[assetId];
    if (ref) ref.author = author;
  });
}
export function acknowledgeRestriction(assetId: string): void {
  store.mutateProject((pr) => {
    const ref = pr.assets[assetId];
    if (ref) ref.restrictionAcknowledged = true;
  });
}
