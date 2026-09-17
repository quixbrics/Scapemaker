/*
 * Regression guard: a lane re-sorts its points by time on every write, so the
 * index a drag started with goes stale as soon as the dragged point crosses a
 * neighbour. moveAutomationPoint must report where the point ended up.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { store } from '../src/state/store';
import { history } from '../src/state/history';
import { newProject } from '../src/state/project';
import {
  addAutomationPoint,
  moveAutomationPoint,
  getLane,
  snapshotAutomation,
  commitAutomationGesture,
} from '../src/state/effectEdits';

function lanePoints(trackId: string) {
  const t = store.get().project.tracks.find((x) => x.id === trackId)!;
  return getLane(t, 'gain')?.points ?? [];
}

describe('automation point editing', () => {
  let trackId: string;

  beforeEach(() => {
    store.setProject(newProject());
    history.clear();
    trackId = store.get().project.tracks[0].id;
    for (const [time, value] of [[1, -6], [2, -3], [3, 0]] as const) {
      addAutomationPoint(trackId, 'gain', { time, value, interpolation: 'linear' });
    }
  });

  it('keeps points sorted by time', () => {
    expect(lanePoints(trackId).map((p) => p.time)).toEqual([1, 2, 3]);
  });

  it('reports the new index when a dragged point crosses a neighbour', () => {
    // Drag the first point (index 0) past the second, to t=2.5.
    const next = moveAutomationPoint(trackId, 'gain', 0, 2.5, -6);
    expect(next).toBe(1);
    expect(lanePoints(trackId).map((p) => p.time)).toEqual([2, 2.5, 3]);
    // The moved point is the one carrying the original value.
    expect(lanePoints(trackId)[1].value).toBe(-6);
  });

  it('keeps dragging the same point when the index is fed back in', () => {
    let idx = 0;
    for (const t of [1.5, 2.5, 3.5, 4]) {
      idx = moveAutomationPoint(trackId, 'gain', idx, t, -6);
    }
    const pts = lanePoints(trackId);
    expect(pts.map((p) => p.time)).toEqual([2, 3, 4]);
    // -6 is still the point we dragged, now last; the neighbours are untouched.
    expect(pts[idx].value).toBe(-6);
    expect(pts.filter((p) => p.value === -6)).toHaveLength(1);
    expect(pts.map((p) => p.value).sort()).toEqual([-6, -3, 0].sort());
  });

  it('records one undo step for a whole drag gesture', () => {
    const depthBefore = history.canUndo;
    expect(depthBefore).toBe(true); // the three adds

    const before = snapshotAutomation(trackId);
    let idx = 0;
    for (const t of [1.2, 1.4, 1.6]) idx = moveAutomationPoint(trackId, 'gain', idx, t, -6);
    commitAutomationGesture(trackId, 'Move automation point', before);

    expect(lanePoints(trackId)[0].time).toBeCloseTo(1.6);
    history.undo();
    expect(lanePoints(trackId).map((p) => p.time)).toEqual([1, 2, 3]);
    history.redo();
    expect(lanePoints(trackId)[0].time).toBeCloseTo(1.6);
  });

  it('commits nothing when a gesture does not move anything', () => {
    const before = snapshotAutomation(trackId);
    commitAutomationGesture(trackId, 'Move automation point', before);
    history.undo(); // should undo the last *add*, not a no-op move
    expect(lanePoints(trackId)).toHaveLength(2);
  });
});
