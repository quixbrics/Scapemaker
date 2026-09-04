/*
 * Automation curve model + AudioParam scheduling.
 *
 * NON-NEGOTIABLE #8: the live playback graph and the offline render must apply
 * automation with the SAME code. Everything here is pure/deterministic and is
 * called from both graph.ts and render.ts. S4 (tests/render-null) is its test.
 */

import type { AutomationLane, AutomationPoint, Interpolation } from '../state/project';

export const CURVE_SAMPLE_HZ = 100; // sampling rate for non-native segments

/** Ensure points are sorted by time. Call on every write. */
export function sortPoints(points: AutomationPoint[]): AutomationPoint[] {
  return [...points].sort((a, b) => a.time - b.time);
}

function smoothstep(t: number): number {
  // classic 3t^2 - 2t^3, C1-continuous
  return t * t * (3 - 2 * t);
}

/**
 * Cubic Bezier with control point `cp` given in normalised segment space
 * (x,y in 0..1 relative to the segment box). We use a single control point
 * mirrored to both handles for a symmetrical ease, which is enough for a
 * teaching tool and keeps the UI to one draggable handle.
 */
function bezierValue(
  p0: number,
  p1: number,
  segFrac: number,
  cp: { x: number; y: number } | undefined,
): number {
  if (!cp) return p0 + (p1 - p0) * smoothstep(segFrac);
  // De Casteljau on y as a function of the Bezier parameter u, approximating
  // u ≈ segFrac (adequate at 100 Hz sampling over short segments).
  const u = segFrac;
  const mu = 1 - u;
  const c1 = cp.y; // normalised 0..1
  const c2 = cp.y;
  const yNorm = 3 * mu * mu * u * c1 + 3 * mu * u * u * c2 + u * u * u;
  return p0 + (p1 - p0) * yNorm;
}

/** Evaluate the curve value at absolute time `t` (seconds). */
export function evaluateAt(points: AutomationPoint[], t: number): number {
  if (points.length === 0) return 0;
  if (t <= points[0].time) return points[0].value;
  const last = points[points.length - 1];
  if (t >= last.time) return last.value;

  let i = 0;
  while (i < points.length - 1 && points[i + 1].time <= t) i++;
  const a = points[i];
  const b = points[i + 1];
  const span = b.time - a.time || 1e-9;
  const frac = (t - a.time) / span;

  switch (a.interpolation) {
    case 'linear':
      return a.value + (b.value - a.value) * frac;
    case 'smooth':
      return a.value + (b.value - a.value) * smoothstep(frac);
    case 'bezier':
      return bezierValue(a.value, b.value, frac, a.cp);
    default:
      return a.value + (b.value - a.value) * frac;
  }
}

export interface SampledCurve {
  values: Float32Array;
  startTime: number;
  duration: number;
}

/**
 * Sample `[t0, t1)` of the curve into a Float32Array at CURVE_SAMPLE_HZ.
 * Used for any segment that has no exact native AudioParam primitive.
 */
export function sampleCurve(
  points: AutomationPoint[],
  t0: number,
  t1: number,
  hz = CURVE_SAMPLE_HZ,
): SampledCurve {
  const duration = Math.max(t1 - t0, 1 / hz);
  const n = Math.max(2, Math.ceil(duration * hz) + 1);
  const values = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = t0 + (k / (n - 1)) * duration;
    values[k] = evaluateAt(points, t);
  }
  return { values, startTime: t0, duration };
}

export interface ScheduleOptions {
  /** map an automation value to the actual param value (e.g. dB → linear gain) */
  transform?: (v: number) => number;
  /** clamp playback window; points outside are still used for interpolation */
  windowStart?: number;
  windowEnd?: number;
  /** context time that corresponds to timeline t=0 */
  timeOrigin: number;
}

/**
 * Schedule an automation lane onto an AudioParam. IDENTICAL call path for live
 * and offline. Segment scheduling primitive is chosen per segment:
 *   linear  → linearRampToValueAtTime
 *   smooth  → setValueCurveAtTime over a sampled segment (deterministic;
 *             setTargetAtTime never settles and risks live/offline drift)
 *   bezier  → setValueCurveAtTime over a sampled segment
 */
export function scheduleAutomation(
  param: AudioParam,
  lane: AutomationLane,
  opts: ScheduleOptions,
): void {
  if (!lane.enabled || lane.points.length === 0) return;
  const pts = sortPoints(lane.points);
  const tf = opts.transform ?? ((v) => v);
  const origin = opts.timeOrigin;
  const wStart = opts.windowStart ?? pts[0].time;
  const wEnd = opts.windowEnd ?? pts[pts.length - 1].time;

  // Anchor the starting value.
  const startVal = tf(evaluateAt(pts, wStart));
  param.cancelScheduledValues(origin + Math.max(0, wStart));
  param.setValueAtTime(startVal, origin + Math.max(0, wStart));

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (b.time <= wStart) continue;
    if (a.time >= wEnd) break;

    const segStart = Math.max(a.time, wStart);
    const segEnd = Math.min(b.time, wEnd);
    const tEndCtx = origin + segEnd;

    if (a.interpolation === 'linear') {
      param.linearRampToValueAtTime(tf(evaluateAt(pts, segEnd)), tEndCtx);
    } else {
      const sampled = sampleCurve(pts, segStart, segEnd);
      const transformed = new Float32Array(sampled.values.length);
      for (let k = 0; k < transformed.length; k++) transformed[k] = tf(sampled.values[k]);
      // setValueCurveAtTime needs a strictly positive duration.
      param.setValueCurveAtTime(transformed, origin + segStart, sampled.duration);
    }
  }
}

/** Convenience: does a lane have anything to schedule? */
export function laneIsActive(lane: AutomationLane | undefined): lane is AutomationLane {
  return !!lane && lane.enabled && lane.points.length > 0;
}

export function interpolationLabel(i: Interpolation): string {
  return i === 'linear' ? 'Linear' : i === 'smooth' ? 'Smooth' : 'Bezier';
}
