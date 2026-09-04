/* EQ / reverb / automation edits on a track. Coalesced live; one undo step per gesture. */

import { history } from './history';
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
  store.mutateProject((p) => {
    const t = track(p, trackId);
    if (t?.eq) t.eq.enabled = !t.eq.enabled;
  });
}
export function toggleReverb(trackId: string): void {
  ensureReverb(trackId);
  store.mutateProject((p) => {
    const t = track(p, trackId);
    if (t?.reverb) t.reverb.enabled = !t.reverb.enabled;
  });
}

export function setEqBand(trackId: string, band: number, patch: { gain?: number; frequency?: number; q?: number }): void {
  ensureEq(trackId);
  store.mutateProject((p) => {
    const t = track(p, trackId);
    if (!t?.eq) return;
    const b = t.eq.bands[band];
    if (patch.gain !== undefined) b.gain = patch.gain;
    if (patch.frequency !== undefined) b.frequency = patch.frequency;
    if (patch.q !== undefined) b.q = patch.q;
  });
}

export function setReverbParam(trackId: string, patch: Partial<Pick<Track['reverb'] & object, 'size' | 'decay' | 'wet' | 'dry'>>): void {
  ensureReverb(trackId);
  store.mutateProject((p) => {
    const t = track(p, trackId);
    if (!t?.reverb) return;
    Object.assign(t.reverb, patch);
    t.reverb.preset = 'custom';
  });
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

export function moveAutomationPoint(
  trackId: string,
  param: AutomationParam,
  index: number,
  time: number,
  value: number,
): void {
  store.mutateProject((p) => {
    const t = track(p, trackId);
    const lane = t && getLane(t, param);
    if (!lane || !lane.points[index]) return;
    lane.points[index] = { ...lane.points[index], time: Math.max(0, time), value };
    lane.points = sortPoints(lane.points);
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
