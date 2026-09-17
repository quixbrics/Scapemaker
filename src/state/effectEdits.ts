/* EQ / reverb / automation edits on a track. Coalesced live; one undo step per gesture. */

import { history, coalescedEdit, endCoalescedEdit } from './history';
import { store } from './store';
import {
  defaultEq,
  defaultReverb,
  type AutomationLane,
  type AutomationParam,
  type AutomationPoint,
  type Project,
  type ReverbPreset,
  type Track,
} from './project';
import { REVERB_PRESETS, applyPreset } from '../audio/effects/reverb';
import { sortPoints } from '../audio/automation';

function track(p: Project, id: string): Track | undefined {
  return p.tracks.find((t) => t.id === id);
}

export function ensureEq(trackId: string): void {
  store.mutateProject((p) => {
    const t = track(p, trackId);
    if (t && !t.eq) t.eq = defaultEq();
  });
}
export function ensureReverb(trackId: string): void {
  store.mutateProject((p) => {
    const t = track(p, trackId);
    if (t && !t.reverb) t.reverb = defaultReverb();
  });
}

export function toggleEq(trackId: string): void {
  ensureEq(trackId);
  const next = !track(store.get().project, trackId)?.eq?.enabled;
  endCoalescedEdit(); // a discrete toggle must not join the previous sweep
  history.push({
    label: next ? 'Enable EQ' : 'Disable EQ',
    do: (p) => {
      const t = track(p, trackId);
      if (t?.eq) t.eq.enabled = next;
    },
    undo: (p) => {
      const t = track(p, trackId);
      if (t?.eq) t.eq.enabled = !next;
    },
  });
}
export function toggleReverb(trackId: string): void {
  ensureReverb(trackId);
  const next = !track(store.get().project, trackId)?.reverb?.enabled;
  endCoalescedEdit();
  history.push({
    label: next ? 'Enable reverb' : 'Disable reverb',
    do: (p) => {
      const t = track(p, trackId);
      if (t?.reverb) t.reverb.enabled = next;
    },
    undo: (p) => {
      const t = track(p, trackId);
      if (t?.reverb) t.reverb.enabled = !next;
    },
  });
}

/**
 * One field of one EQ band. Coalesced per field, so a sweep is a single undo
 * step that redoes to where the sweep ended — these were direct mutations with
 * no history entry at all, so an EQ move simply could not be undone.
 */
export function setEqBand(
  trackId: string,
  band: number,
  patch: { gain?: number; frequency?: number; q?: number },
): void {
  ensureEq(trackId);
  for (const field of ['gain', 'frequency', 'q'] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    coalescedEdit(
      `${trackId}:eq:${band}:${field}`,
      `EQ ${field}`,
      (p) => track(p, trackId)?.eq?.bands[band][field] ?? 0,
      (p, v) => {
        const b = track(p, trackId)?.eq?.bands[band];
        if (b) b[field] = v;
      },
      value,
    );
  }
}

/** As setEqBand: coalesced per field, and undoable, which it previously was not. */
export function setReverbParam(
  trackId: string,
  patch: Partial<Pick<Track['reverb'] & object, 'size' | 'decay' | 'wet' | 'dry'>>,
): void {
  ensureReverb(trackId);
  for (const field of ['size', 'decay', 'wet', 'dry'] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    coalescedEdit(
      `${trackId}:reverb:${field}`,
      `Reverb ${field}`,
      (p) => {
        const rv = track(p, trackId)?.reverb;
        // Preset is restored with the value: nudging a dial makes the reverb
        // "custom", and undoing that has to put the preset name back too.
        return { value: rv?.[field] ?? 0, preset: rv?.preset ?? 'custom' };
      },
      (p, v) => {
        const rv = track(p, trackId)?.reverb;
        if (!rv) return;
        rv[field] = v.value;
        rv.preset = v.preset;
      },
      { value, preset: 'custom' as ReverbPreset },
    );
  }
}

export function setReverbPreset(trackId: string, preset: Exclude<ReverbPreset, 'custom'>): void {
  ensureReverb(trackId);
  const before = structuredClone(track(store.get().project, trackId)?.reverb);
  history.push({
    label: `Reverb preset: ${REVERB_PRESETS[preset].label}`,
    do(p) {
      const t = track(p, trackId);
      if (t?.reverb) t.reverb = applyPreset({ ...t.reverb, enabled: true }, preset);
    },
    undo(p) {
      const t = track(p, trackId);
      if (t && before) t.reverb = structuredClone(before);
    },
  });
}

// --- automation ---------------------------------------------------------

export function getLane(t: Track, param: AutomationParam): AutomationLane | undefined {
  return t.automation.find((l) => l.param === param);
}

/** Which track's automation lane is expanded, and which param — pure UI state. */
export function setAutomationView(trackId: string, param: AutomationParam | null): void {
  store.patchUi({ automationView: param ? { trackId, param } : null });
}

export function toggleLane(trackId: string, param: AutomationParam): void {
  store.mutateProject((p) => {
    const t = track(p, trackId);
    if (!t) return;
    let lane = getLane(t, param);
    if (!lane) {
      lane = { param, points: [], enabled: true };
      t.automation.push(lane);
    } else {
      lane.enabled = !lane.enabled;
    }
  });
}

export function addAutomationPoint(trackId: string, param: AutomationParam, point: AutomationPoint): void {
  // an eq.* lane needs the EQ chain to exist in the graph for it to have any effect
  if (param.startsWith('eq.')) ensureEq(trackId);
  const before = structuredClone(track(store.get().project, trackId)?.automation ?? []);
  history.push({
    label: 'Add automation point',
    do(p) {
      const t = track(p, trackId);
      if (!t) return;
      let lane = getLane(t, param);
      if (!lane) {
        lane = { param, points: [], enabled: true };
        t.automation.push(lane);
      }
      lane.points = sortPoints([...lane.points, point]);
      lane.enabled = true;
    },
    undo(p) {
      const t = track(p, trackId);
      if (t) t.automation = structuredClone(before);
    },
  });
}

/**
 * Move one point and return the index it now occupies.
 *
 * The lane is re-sorted by time on every write, so the caller's index goes
 * stale the moment the dragged point crosses a neighbour — a drag that held
 * onto its original index silently started dragging the neighbour instead.
 * Callers must feed the returned index back in on the next move.
 *
 * Not undoable on its own: a drag emits hundreds of these. Wrap a gesture in
 * `snapshotAutomation` / `commitAutomationGesture` for one undo step.
 */
export function moveAutomationPoint(
  trackId: string,
  param: AutomationParam,
  index: number,
  time: number,
  value: number,
): number {
  let nextIndex = index;
  store.mutateProject((p) => {
    const t = track(p, trackId);
    const lane = t && getLane(t, param);
    if (!lane || !lane.points[index]) return;
    const moved = { ...lane.points[index], time: Math.max(0, time), value };
    lane.points[index] = moved;
    lane.points = sortPoints(lane.points);
    nextIndex = lane.points.indexOf(moved);
  });
  return nextIndex;
}

/** Deep copy of a track's automation, to open an undoable gesture against. */
export function snapshotAutomation(trackId: string): AutomationLane[] {
  return structuredClone(track(store.get().project, trackId)?.automation ?? []);
}

/**
 * Close a gesture opened with `snapshotAutomation` — one history entry for the
 * whole drag, or none at all if nothing actually moved.
 */
export function commitAutomationGesture(
  trackId: string,
  label: string,
  before: AutomationLane[],
): void {
  const after = snapshotAutomation(trackId);
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  history.push({
    label,
    do(p) {
      const t = track(p, trackId);
      if (t) t.automation = structuredClone(after);
    },
    undo(p) {
      const t = track(p, trackId);
      if (t) t.automation = structuredClone(before);
    },
  });
}

export function removeAutomationPoint(trackId: string, param: AutomationParam, index: number): void {
  const before = structuredClone(track(store.get().project, trackId)?.automation ?? []);
  history.push({
    label: 'Remove automation point',
    do(p) {
      const t = track(p, trackId);
      const lane = t && getLane(t, param);
      if (lane) lane.points = lane.points.filter((_, i) => i !== index);
    },
    undo(p) {
      const t = track(p, trackId);
      if (t) t.automation = structuredClone(before);
    },
  });
}
