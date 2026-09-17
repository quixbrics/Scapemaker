/*
 * Undo/redo behaviour for gestures and for the commands whose undo used to
 * match on coincidental values rather than identity.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { store } from '../src/state/store';
import { history, coalescedEdit, endCoalescedEdit } from '../src/state/history';
import { newProject, migrate, type Project } from '../src/state/project';
import { setTrackGain, addTrack, removeTrack, setMasterGain, toggleMute } from '../src/state/edits';
import { setEqBand, setReverbParam, toggleEq } from '../src/state/effectEdits';

const project = () => store.get().project;
const trackOf = (i = 0) => project().tracks[i];

beforeEach(() => {
  store.setProject(newProject());
  history.clear();
  endCoalescedEdit();
});

describe('coalescedEdit', () => {
  const read = (p: Project) => p.tracks[0].gain;
  const write = (p: Project, v: number) => {
    p.tracks[0].gain = v;
  };

  it('collapses a drag into one undo step', () => {
    for (const v of [-1, -2, -3, -4, -5]) {
      coalescedEdit('t:gain', 'Track gain', read, write, v);
    }
    expect(trackOf().gain).toBe(-5);
    history.undo();
    expect(trackOf().gain).toBe(0);
    expect(history.canUndo).toBe(false);
  });

  it('redoes to where the gesture ENDED, not where it started', () => {
    for (const v of [-1, -2, -3]) coalescedEdit('t:gain', 'Track gain', read, write, v);
    history.undo();
    history.redo();
    // The old hand-rolled version closed over the first value and redid to -1.
    expect(trackOf().gain).toBe(-3);
  });

  it('starts a new step for a different key', () => {
    coalescedEdit('a', 'A', read, write, -1);
    coalescedEdit('b', 'B', read, write, -2);
    history.undo();
    expect(trackOf().gain).toBe(-1);
    history.undo();
    expect(trackOf().gain).toBe(0);
  });

  it('starts a new step once the gesture is explicitly ended', () => {
    coalescedEdit('t:gain', 'Track gain', read, write, -1);
    endCoalescedEdit();
    coalescedEdit('t:gain', 'Track gain', read, write, -2);
    history.undo();
    expect(trackOf().gain).toBe(-1);
  });
});

describe('track edits', () => {
  it('undoes a fader drag to the pre-drag value', () => {
    const id = trackOf().id;
    for (const db of [-3, -6, -9]) setTrackGain(id, db);
    expect(trackOf().gain).toBe(-9);
    history.undo();
    expect(trackOf().gain).toBe(0);
  });

  it('keeps a mute toggle as its own step, not folded into a preceding drag', () => {
    const id = trackOf().id;
    setTrackGain(id, -6);
    toggleMute(id);
    expect(trackOf().muted).toBe(true);
    history.undo();
    expect(trackOf().muted).toBe(false);
    expect(trackOf().gain).toBe(-6); // the drag survives
    history.undo();
    expect(trackOf().gain).toBe(0);
  });

  it('removes the track it added, by id', () => {
    addTrack();
    addTrack();
    const added = project().tracks.at(-1)!.id;
    expect(project().tracks).toHaveLength(6);
    history.undo();
    expect(project().tracks).toHaveLength(5);
    expect(project().tracks.some((t) => t.id === added)).toBe(false);
  });
});

describe('effect edits', () => {
  it('undoes an EQ sweep', () => {
    const id = trackOf().id;
    for (const gain of [2, 4, 6]) setEqBand(id, 2, { gain });
    expect(trackOf().eq!.bands[2].gain).toBe(6);
    history.undo();
    expect(trackOf().eq!.bands[2].gain).toBe(0);
    history.redo();
    expect(trackOf().eq!.bands[2].gain).toBe(6);
  });

  it('treats each EQ band field as its own gesture', () => {
    const id = trackOf().id;
    setEqBand(id, 0, { gain: 3 });
    setEqBand(id, 0, { frequency: 120 });
    history.undo();
    expect(trackOf().eq!.bands[0].frequency).toBe(80);
    expect(trackOf().eq!.bands[0].gain).toBe(3);
  });

  it('restores the reverb preset name when a dial tweak is undone', () => {
    const id = trackOf().id;
    const before = { wet: 0.18, preset: 'street' };
    expect(trackOf().reverb).toBeUndefined();
    setReverbParam(id, { wet: 0.5 });
    expect(trackOf().reverb!.wet).toBe(0.5);
    expect(trackOf().reverb!.preset).toBe('custom');
    history.undo();
    expect(trackOf().reverb!.wet).toBe(before.wet);
    expect(trackOf().reverb!.preset).toBe(before.preset);
  });

  it('undoes an EQ enable toggle', () => {
    const id = trackOf().id;
    toggleEq(id);
    expect(trackOf().eq!.enabled).toBe(true);
    history.undo();
    expect(trackOf().eq!.enabled).toBe(false);
  });
});

describe('tracks', () => {
  it('keeps colour indices unique after a delete', () => {
    const p0 = project();
    expect(p0.tracks.map((t) => t.index)).toEqual([0, 1, 2, 3]);

    // Remove the middle track, then add one: the new track must not reuse a
    // colour slot a surviving track still holds.
    const middle = p0.tracks[1].id;
    removeTrack(middle);
    expect(project().tracks.map((t) => t.index)).toEqual([0, 2, 3]);

    addTrack();
    const indices = project().tracks.map((t) => t.index);
    expect(indices).toEqual([0, 2, 3, 1]);
    expect(new Set(indices).size).toBe(indices.length);
  });

  it('puts a deleted track back where it was', () => {
    const before = project().tracks.map((t) => t.id);
    removeTrack(before[1]);
    expect(project().tracks.map((t) => t.id)).toEqual([before[0], before[2], before[3]]);
    history.undo();
    expect(project().tracks.map((t) => t.id)).toEqual(before);
  });

  it('restores the clips that were on a deleted track', () => {
    const id = trackOf(0).id;
    store.mutateProject((p) => {
      p.tracks[0].clips.push({
        id: 'c1', assetId: 'a1', start: 0, sourceOffset: 0, duration: 4, gain: 0,
        fadeIn: { duration: 0, curve: 'equalPower' }, fadeOut: { duration: 0, curve: 'equalPower' },
      });
    });
    removeTrack(id);
    expect(project().tracks.find((t) => t.id === id)).toBeUndefined();
    history.undo();
    expect(project().tracks.find((t) => t.id === id)!.clips).toHaveLength(1);
  });

  it('refuses to remove the last track', () => {
    while (project().tracks.length > 1) removeTrack(project().tracks[0].id);
    const only = project().tracks[0].id;
    removeTrack(only);
    expect(project().tracks).toHaveLength(1);
  });
});

describe('master gain', () => {
  it('defaults to unity and coalesces a drag into one undo step', () => {
    expect(project().masterGain).toBe(0);
    for (const db of [-1, -2, -3]) setMasterGain(db);
    expect(project().masterGain).toBe(-3);
    history.undo();
    expect(project().masterGain).toBe(0);
    history.redo();
    expect(project().masterGain).toBe(-3);
  });

  it('is backfilled on a project saved before it existed', () => {
    const old = JSON.parse(JSON.stringify(newProject())) as Record<string, unknown>;
    delete old.masterGain;
    expect(migrate(old).project.masterGain).toBe(0);
  });
});
