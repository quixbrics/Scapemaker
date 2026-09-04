/*
 * Multi-resolution peak pyramid for waveform drawing.
 *
 * NON-NEGOTIABLE #2: never paint a waveform from raw sample data. Every pixel
 * comes from this pyramid. Stored as Int8Array (−128..127) — one byte per
 * extreme, ~1% of the decoded buffer size.
 */

export const BUCKET_SIZES = [256, 1024, 4096, 16384] as const;
export type BucketSize = (typeof BUCKET_SIZES)[number];

export interface PeakLevel {
  bucketSize: number;
  /** interleaved [min0, max0, min1, max1, ...], values −128..127 */
  data: Int8Array;
  buckets: number;
}

export interface PeakPyramid {
  sampleRate: number;
  length: number; // samples
  levels: PeakLevel[]; // ascending bucketSize
}

function quantise(v: number): number {
  // clamp to [-1,1] then scale to signed byte
  const c = v < -1 ? -1 : v > 1 ? 1 : v;
  return Math.max(-128, Math.min(127, Math.round(c * 127)));
}

/** Build the base (finest) level directly from channel data, mono-summed. */
function buildBase(buffer: AudioBuffer, bucketSize: number): PeakLevel {
  const len = buffer.length;
  const buckets = Math.ceil(len / bucketSize);
  const data = new Int8Array(buckets * 2);
  const chans: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const inv = 1 / buffer.numberOfChannels;

  for (let b = 0; b < buckets; b++) {
    const start = b * bucketSize;
    const end = Math.min(start + bucketSize, len);
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = start; i < end; i++) {
      let s = 0;
      for (let c = 0; c < chans.length; c++) s += chans[c][i];
      s *= inv;
      if (s < mn) mn = s;
      if (s > mx) mx = s;
    }
    if (mn === Infinity) {
      mn = 0;
      mx = 0;
    }
    data[b * 2] = quantise(mn);
    data[b * 2 + 1] = quantise(mx);
  }
  return { bucketSize, data, buckets };
}

/** Downsample a finer level into a coarser one (factor must be integer). */
function downsample(fine: PeakLevel, coarseBucketSize: number): PeakLevel {
  const factor = coarseBucketSize / fine.bucketSize;
  const buckets = Math.ceil(fine.buckets / factor);
  const data = new Int8Array(buckets * 2);
  for (let b = 0; b < buckets; b++) {
    const start = b * factor;
    const end = Math.min(start + factor, fine.buckets);
    let mn = 127;
    let mx = -128;
    for (let i = start; i < end; i++) {
      const lo = fine.data[i * 2];
      const hi = fine.data[i * 2 + 1];
      if (lo < mn) mn = lo;
      if (hi > mx) mx = hi;
    }
    data[b * 2] = mn;
    data[b * 2 + 1] = mx;
  }
  return { bucketSize: coarseBucketSize, data, buckets };
}

export function buildPeakPyramid(buffer: AudioBuffer): PeakPyramid {
  const base = buildBase(buffer, BUCKET_SIZES[0]);
  const levels: PeakLevel[] = [base];
  for (let i = 1; i < BUCKET_SIZES.length; i++) {
    levels.push(downsample(levels[i - 1], BUCKET_SIZES[i]));
  }
  return { sampleRate: buffer.sampleRate, length: buffer.length, levels };
}

/**
 * Choose the level whose bucket maps to at least one pixel at the given
 * pixels-per-second zoom. Guarantees a bucket is never sub-pixel (Build Plan §6.2).
 */
export function pickLevel(pyramid: PeakPyramid, pixelsPerSecond: number): PeakLevel {
  const samplesPerPixel = pyramid.sampleRate / Math.max(pixelsPerSecond, 0.001);
  let chosen = pyramid.levels[0];
  for (const level of pyramid.levels) {
    if (level.bucketSize <= samplesPerPixel) chosen = level;
    else break;
  }
  return chosen;
}

/**
 * Read min/max envelope over a source time window into `out` (length = width*2,
 * interleaved min,max in −1..1). Cheap enough to call per animation frame.
 */
export function readEnvelope(
  pyramid: PeakPyramid,
  level: PeakLevel,
  sourceStart: number, // seconds into the asset
  sourceDuration: number,
  width: number,
  out: Float32Array,
): void {
  const sr = pyramid.sampleRate;
  const startSample = sourceStart * sr;
  const spanSamples = sourceDuration * sr;
  for (let px = 0; px < width; px++) {
    const s0 = startSample + (px / width) * spanSamples;
    const s1 = startSample + ((px + 1) / width) * spanSamples;
    let b0 = Math.floor(s0 / level.bucketSize);
    let b1 = Math.ceil(s1 / level.bucketSize);
    if (b0 < 0) b0 = 0;
    if (b1 > level.buckets) b1 = level.buckets;
    let mn = 1;
    let mx = -1;
    for (let b = b0; b < b1; b++) {
      const lo = level.data[b * 2] / 127;
      const hi = level.data[b * 2 + 1] / 127;
      if (lo < mn) mn = lo;
      if (hi > mx) mx = hi;
    }
    if (b1 <= b0) {
      mn = 0;
      mx = 0;
    }
    out[px * 2] = mn;
    out[px * 2 + 1] = mx;
  }
}

/** Approximate byte size of a pyramid — for the asset budget meter. */
export function pyramidBytes(pyramid: PeakPyramid): number {
  return pyramid.levels.reduce((n, l) => n + l.data.byteLength, 0);
}
