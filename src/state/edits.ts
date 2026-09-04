/*
 * Timeline edit operations, each an undoable history Command (Build Plan §7.3):
 * move, trim, split, duplicate, delete, plus track-level gain/pan/mute/solo and
 * effect toggles. All non-destructive — nothing here touches a decoded buffer.
 */

import { history, trackEditCommand, type Command } from './history';
import { store } from './store';
import {
  makeClip,
  makeTrack,
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
  const index = p.tracks.length;
  history.push({
    label: 'Add track',
    do: (pr) => pr.tracks.push(makeTrack(index)),
    undo: (pr) => {
      pr.tracks = pr.tracks.filter((t) => t.index !== index);
    },
  });
}

/** Place an already-imported asset as a new clip on `trackId` at `start`. */
export function placeAsset(ref: AssetRef, trackId: string, start: number): void {
  const p = store.get().project;
  const track = findTrack(p, trackId) ?? p.tracks[0];
  if (!track) return;
  const entry = assetStore.peek(ref.id);
  const duration = entry?.buffer.duration ?? ref.duration ?? 5;

  const cmd: Command = {
    label: `Add "${ref.title}"`,
    do(pr) {
      pr.assets[ref.id] = { ...ref, duration };
      const t = findTrack(pr, track.id);
      t?.clips.push(makeClip(ref.id, Math.max(0, start), duration));
      pr.duration = fitDuration(pr);
    },
    undo(pr) {
      const t = findTrack(pr, track.id);
      if (t) t.clips = t.clips.filter((c) => !(c.assetId === ref.id && Math.abs(c.start - Math.max(0, start)) < 1e-6));
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

let coalesceKey: string | null = null;
let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

function setTrackField<K extends keyof Track>(
  trackId: string,
  field: K,
  value: Track[K],
  label: string,
  coalesce = true,
): void {
  const p = store.get().project;
  const track = findTrack(p, trackId);
  if (!track) return;
  const key = `${trackId}:${String(field)}`;
  const prev = track[field];

  if (coalesce && coalesceKey === key) {
    store.mutateProject((pr) => {
      const t = findTrack(pr, trackId);
      if (t) t[field] = value;
    });
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(() => (coalesceKey = null), 500);
    return;
  }

  history.push({
    label,
    do(pr) {
      const t = findTrack(pr, trackId);
      if (t) t[field] = value;
    },
    undo(pr) {
      const t = findTrack(pr, trackId);
      if (t) t[field] = prev;
    },
  });
  if (coalesce) {
    coalesceKey = key;
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(() => (coalesceKey = null), 500);
  }
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
