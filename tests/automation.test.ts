import { describe, expect, it } from 'vitest';
import { evaluateAt, sampleCurve, sortPoints, CURVE_SAMPLE_HZ } from '../src/audio/automation';
import type { AutomationPoint } from '../src/state/project';

const P = (time: number, value: number, interpolation: AutomationPoint['interpolation'] = 'linear'): AutomationPoint => ({
  time,
  value,
  interpolation,
});

describe('evaluateAt', () => {
  it('clamps before the first and after the last point', () => {
    const pts = [P(1, 0.2), P(3, 0.8)];
    expect(evaluateAt(pts, 0)).toBe(0.2);
    expect(evaluateAt(pts, 5)).toBe(0.8);
  });

  it('linear interpolation hits the midpoint', () => {
    const pts = [P(0, 0), P(2, 1, 'linear')];
    expect(evaluateAt(pts, 1)).toBeCloseTo(0.5, 6);
  });

  it('smooth interpolation is monotonic and symmetric around the midpoint', () => {
    const pts = [P(0, 0), P(1, 1, 'smooth')];
    const a = evaluateAt(pts, 0.25);
    const b = evaluateAt(pts, 0.5);
    const c = evaluateAt(pts, 0.75);
    expect(b).toBeCloseTo(0.5, 6);
    expect(a).toBeLessThan(b);
    expect(c).toBeGreaterThan(b);
    expect(a + c).toBeCloseTo(1, 6); // symmetry of smoothstep
  });

  it('bezier stays within the segment value range', () => {
    const pts = [P(0, 0.2, 'bezier'), P(1, 0.9)];
    pts[0].cp = { x: 0.5, y: 0.1 };
    for (let t = 0; t <= 1; t += 0.1) {
      const v = evaluateAt(pts, t);
      expect(v).toBeGreaterThanOrEqual(0.2 - 1e-9);
      expect(v).toBeLessThanOrEqual(0.9 + 1e-9);
    }
  });

  it('empty lane evaluates to 0', () => {
    expect(evaluateAt([], 3)).toBe(0);
  });
});

describe('sampleCurve', () => {
  it('produces a Float32Array at ~CURVE_SAMPLE_HZ with matching endpoints', () => {
    const pts = [P(0, 0), P(1, 1, 'linear')];
    const s = sampleCurve(pts, 0, 1);
    expect(s.values.length).toBeGreaterThanOrEqual(CURVE_SAMPLE_HZ);
    expect(s.values[0]).toBeCloseTo(0, 5);
    expect(s.values[s.values.length - 1]).toBeCloseTo(1, 5);
    expect(s.duration).toBeCloseTo(1, 6);
  });

  it('is deterministic — same input, identical output (non-negotiable #8)', () => {
    const pts = [P(0, 0.1, 'bezier'), P(2, 0.7)];
    pts[0].cp = { x: 0.3, y: 0.8 };
    const a = sampleCurve(pts, 0, 2);
    const b = sampleCurve(pts, 0, 2);
    expect(Array.from(a.values)).toEqual(Array.from(b.values));
  });

  it('guards against a zero-length window', () => {
    const s = sampleCurve([P(0, 0), P(1, 1)], 0.5, 0.5);
    expect(s.duration).toBeGreaterThan(0);
    expect(s.values.length).toBeGreaterThanOrEqual(2);
  });
});

describe('sortPoints', () => {
  it('orders by time and does not mutate the input', () => {
    const input = [P(3, 0), P(1, 0), P(2, 0)];
    const sorted = sortPoints(input);
    expect(sorted.map((p) => p.time)).toEqual([1, 2, 3]);
    expect(input.map((p) => p.time)).toEqual([3, 1, 2]);
  });
});
