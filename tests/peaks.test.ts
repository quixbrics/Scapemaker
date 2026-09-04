import { describe, expect, it } from 'vitest';
import { buildPeakPyramid, pickLevel, readEnvelope, BUCKET_SIZES } from '../src/audio/peaks';
import { makeTone, FakeAudioBuffer } from './helpers/fakeAudioBuffer';

describe('buildPeakPyramid', () => {
  it('creates one level per bucket size, ascending', () => {
    const py = buildPeakPyramid(makeTone(220, 1) as unknown as AudioBuffer);
    expect(py.levels.map((l) => l.bucketSize)).toEqual([...BUCKET_SIZES]);
  });

  it('captures the true amplitude of a full-scale tone (±1)', () => {
    const py = buildPeakPyramid(makeTone(440, 0.5, 48000, 1.0) as unknown as AudioBuffer);
    const base = py.levels[0];
    let mn = 127;
    let mx = -128;
    for (let i = 0; i < base.buckets; i++) {
      mn = Math.min(mn, base.data[i * 2]);
      mx = Math.max(mx, base.data[i * 2 + 1]);
    }
    expect(mx / 127).toBeGreaterThan(0.95);
    expect(mn / 127).toBeLessThan(-0.95);
  });

  it('silence produces a flat zero envelope', () => {
    const py = buildPeakPyramid(new FakeAudioBuffer(2, 48000, 48000) as unknown as AudioBuffer);
    const out = new Float32Array(100 * 2);
    readEnvelope(py, py.levels[0], 0, 1, 100, out);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it('coarser levels never exceed the finest level amplitude', () => {
    const py = buildPeakPyramid(makeTone(100, 2, 48000, 0.8) as unknown as AudioBuffer);
    const peakOf = (lvl: (typeof py.levels)[number]) => {
      let m = 0;
      for (let i = 0; i < lvl.data.length; i++) m = Math.max(m, Math.abs(lvl.data[i]));
      return m;
    };
    const fine = peakOf(py.levels[0]);
    for (const lvl of py.levels.slice(1)) expect(peakOf(lvl)).toBeLessThanOrEqual(fine);
  });
});

describe('pickLevel', () => {
  it('zooming out selects a coarser bucket', () => {
    const py = buildPeakPyramid(makeTone(200, 3) as unknown as AudioBuffer);
    const zoomedIn = pickLevel(py, 400); // 400 px/s → fine
    const zoomedOut = pickLevel(py, 2); // 2 px/s → coarse
    expect(zoomedOut.bucketSize).toBeGreaterThanOrEqual(zoomedIn.bucketSize);
  });

  it('never returns a bucket smaller than one pixel at the given zoom', () => {
    const py = buildPeakPyramid(makeTone(200, 3) as unknown as AudioBuffer);
    const pps = 50;
    const level = pickLevel(py, pps);
    const samplesPerPixel = py.sampleRate / pps;
    expect(level.bucketSize).toBeLessThanOrEqual(samplesPerPixel);
  });
});

describe('readEnvelope', () => {
  it('a mid-buffer window reads a nonzero envelope for a tone', () => {
    const py = buildPeakPyramid(makeTone(300, 2, 48000, 0.6) as unknown as AudioBuffer);
    const out = new Float32Array(200 * 2);
    readEnvelope(py, pickLevel(py, 100), 0.5, 1.0, 200, out);
    let maxAbs = 0;
    for (const v of out) maxAbs = Math.max(maxAbs, Math.abs(v));
    expect(maxAbs).toBeGreaterThan(0.4);
  });
});
