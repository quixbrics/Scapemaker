/*
 * Undo/redo behaviour for gestures and for the commands whose undo used to
 * match on coincidental values rather than identity.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { store } from '../src/state/store';
import { history, coalescedEdit, endCoalescedEdit } from '../src/state/history';
import { newProject, type Project } from '../src/state/project';
import { setTrackGain, addTrack, toggleMute } from '../src/state/edits';
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
