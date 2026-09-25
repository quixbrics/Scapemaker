/*
 * The editing operations behind the razor, Option-drag, arrow nudges, clip
 * pan and Auto-level. Each is one undo step and undoes to exactly where it
 * started.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { store } from '../src/state/store';
import { history, endCoalescedEdit } from '../src/state/history';
import { newProject, makeClip, migrate } from '../src/state/project';
import {
  splitClipAt,
  splitAllAt,
  duplicateClipTo,
  nudgeClip,
  setClipPan,
  setClipGain,
  cutSelectedClip,
  pasteClip,
  autoLevelMaster,
  applyMasterGain,
  setMasterGain,
  setClipLoop,
} from '../src/state/edits';

const project = () => store.get().project;
const track = (i: number) => project().tracks[i];

function addClip(trackIndex: number, start: number, duration: number, id: string): void {
  store.mutateProject((p) => {
    p.tracks[trackIndex].clips.push({ ...makeClip('asset-a', start, duration), id });
  });
}

beforeEach(() => {
  store.setProject(newProject());
  history.clear();
  endCoalescedEdit();
  addClip(0, 2, 10, 'c1');
});

describe('razor: splitClipAt', () => {
  it('cuts one clip into two views that together cover the original', () => {
    expect(splitClipAt(track(0).id, 'c1', 5)).toBeNull();
    const [a, b] = track(0).clips;
    expect(a).toMatchObject({ start: 2, duration: 3, sourceOffset: 0 });
    expect(b).toMatchObject({ start: 5, duration: 7, sourceOffset: 3 });
    // the half to the right of the cut is selected, ready for the next cut
    expect(store.get().ui.selection.clipId).toBe(b.id);
  });

  it('is one undo step', () => {
    splitClipAt(track(0).id, 'c1', 5);
    history.undo();
    expect(track(0).clips).toHaveLength(1);
    expect(track(0).clips[0]).toMatchObject({ start: 2, duration: 10 });
  });

  it('refuses a cut at or outside the clip edges', () => {
    expect(splitClipAt(track(0).id, 'c1', 2)).toBe('outside');
    expect(splitClipAt(track(0).id, 'c1', 12)).toBe('outside');
    expect(splitClipAt(track(0).id, 'c1', 30)).toBe('outside');
    expect(track(0).clips).toHaveLength(1);
    expect(history.canUndo).toBe(false);
  });

  it('refuses to cut a looping clip rather than mangle its repeats', () => {
    setClipLoop(track(0).id, 'c1', 3, 0.05);
    history.clear();
    expect(splitClipAt(track(0).id, 'c1', 15)).toBe('looping');
    expect(track(0).clips).toHaveLength(1);
  });
});

describe('razor: splitAllAt', () => {
  it('cuts every clip the line crosses, on every track, as one step', () => {
    addClip(1, 0, 8, 'c2');
    addClip(2, 20, 5, 'c3'); // not crossed
    history.clear();
    expect(splitAllAt(6)).toBe(2);
    expect(track(0).clips).toHaveLength(2);
    expect(track(1).clips).toHaveLength(2);
    expect(track(2).clips).toHaveLength(1);
    history.undo();
    expect(track(0).clips).toHaveLength(1);
    expect(track(1).clips).toHaveLength(1);
    expect(history.canUndo).toBe(false);
  });
});

describe('Option-drag: duplicateClipTo', () => {
  it('leaves the original and drops a copy on another track', () => {
    duplicateClipTo(track(0).id, 'c1', 30, track(2).id);
    expect(track(0).clips).toHaveLength(1);
    expect(track(0).clips[0].start).toBe(2);
    expect(track(2).clips).toHaveLength(1);
    expect(track(2).clips[0]).toMatchObject({ start: 30, duration: 10, assetId: 'asset-a' });
    expect(track(2).clips[0].id).not.toBe('c1');
    history.undo();
    expect(track(2).clips).toHaveLength(0);
    expect(track(0).clips).toHaveLength(1);
  });
});

describe('arrow nudge', () => {
  it('is undoable, and a held key is one step', () => {
    for (let i = 0; i < 5; i++) nudgeClip(track(0).id, 'c1', 0.1);
    expect(track(0).clips[0].start).toBeCloseTo(2.5);
    history.undo();
    expect(track(0).clips[0].start).toBe(2);
    expect(history.canUndo).toBe(false);
  });

  it('never pushes a clip before zero', () => {
    nudgeClip(track(0).id, 'c1', -5);
    expect(track(0).clips[0].start).toBe(0);
  });
});

describe('clip gain and pan', () => {
  it('pan is clamped, coalesced and undoable', () => {
    for (const v of [-0.2, -0.6, -1.4]) setClipPan(track(0).id, 'c1', v);
    expect(track(0).clips[0].pan).toBe(-1);
    history.undo();
    expect(track(0).clips[0].pan).toBe(0);
  });

  it('gain is undoable (the Inspector slider used to bypass history)', () => {
    setClipGain(track(0).id, 'c1', -9);
    history.undo();
    expect(track(0).clips[0].gain).toBe(0);
  });

  it('older project files load with centred clips', () => {
    const raw = JSON.parse(JSON.stringify(newProject()));
    raw.tracks[0].clips = [{ id: 'x', assetId: 'a', start: 0, sourceOffset: 0, duration: 1, gain: 0 }];
    expect(migrate(raw).project.tracks[0].clips[0].pan).toBe(0);
  });
});

describe('cut and paste', () => {
  it('removes the clip and pastes it back at the playhead', () => {
    store.patchUi({ selection: { trackId: track(0).id, clipId: 'c1' } });
    cutSelectedClip();
    expect(track(0).clips).toHaveLength(0);
    store.patchTransport({ playhead: 40 });
    pasteClip();
    expect(track(0).clips).toHaveLength(1);
    expect(track(0).clips[0].start).toBe(40);
  });
});

describe('Auto-level', () => {
  it('lowers a clipping mix so its peak lands on the target', () => {
    // measured +0.6 dB with the master at 0 → master to −1.6 gives −1 dB
    expect(autoLevelMaster(0.6, 0)).toBe(-1.6);
  });

  it('accounts for the master already in the measurement', () => {
    expect(autoLevelMaster(-4, -3)).toBe(0);
  });

  it('raises a quiet mix, but no further than the fader goes', () => {
    expect(autoLevelMaster(-30, 0)).toBe(6);
  });

  it('does nothing for silence', () => {
    expect(autoLevelMaster(-Infinity, 0)).toBeNull();
  });

  it('is its own undo step, never folded into a fader drag', () => {
    setMasterGain(-2);
    setMasterGain(-3);
    applyMasterGain(-7.5);
    expect(project().masterGain).toBe(-7.5);
    history.undo();
    expect(project().masterGain).toBe(-3);
  });
});
