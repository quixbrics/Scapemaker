/*
 * Loudness analysis + clipping heatmap (concept §7.9, Build Plan §10).
 *
 * Peak and RMS are exact and cheap. Integrated loudness (LUFS) is an
 * ITU-R BS.1770 implementation — K-weighting + 400 ms gated blocks — and is the
 * first thing to cut if the schedule tightens; peak/RMS/heatmap carry most of
 * the teaching value. It is computed off a rendered buffer, never live.
 *
 * NON-NEGOTIABLE for the UI: the master Peak readout and the clipping banner
 * must agree — both derive from `analyseBuffer(...).peakDb` and `.clipRegions`.
 */

export interface HeatBucket {
  t0: number;
  t1: number;
  peakDb: number;
  level: 'ok' | 'warn6' | 'warn3' | 'clip';
}

export interface BufferAnalysis {
  peakDb: number;
  rmsDb: number;
  integratedLufs: number | null;
  /** true if any sample reaches or exceeds 0 dBFS */
  clipped: boolean;
  /** worst offence time in seconds, or null */
  worstAt: number | null;
  heat: HeatBucket[];
  clipRegions: Array<{ start: number; end: number }>;
}

const MIN_DB = -120;

export function toDb(linear: number): number {
  return linear <= 0 ? MIN_DB : Math.max(MIN_DB, 20 * Math.log10(linear));
}

function levelFor(peakDb: number): HeatBucket['level'] {
  if (peakDb >= 0) return 'clip';
  if (peakDb >= -3) return 'warn3';
  if (peakDb >= -6) return 'warn6';
  return 'ok';
}

export function analyseBuffer(buffer: AudioBuffer, bucketMs = 100): BufferAnalysis {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const chans: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));

  let peak = 0;
  let sumSq = 0;
  let worstAt: number | null = null;

  const bucketSize = Math.max(1, Math.floor((bucketMs / 1000) * sr));
  const heat: HeatBucket[] = [];
  const clipRegions: Array<{ start: number; end: number }> = [];
  let regionOpen: { start: number; end: number } | null = null;

  for (let b = 0; b * bucketSize < n; b++) {
    const start = b * bucketSize;
    const end = Math.min(start + bucketSize, n);
    let bPeak = 0;
    for (let i = start; i < end; i++) {
      for (let c = 0; c < chans.length; c++) {
        const s = Math.abs(chans[c][i]);
        if (s > bPeak) bPeak = s;
        if (s > peak) {
          peak = s;
          worstAt = i / sr;
        }
        sumSq += chans[c][i] * chans[c][i];
      }
    }
    const bDb = toDb(bPeak);
    const level = levelFor(bDb);
    heat.push({ t0: start / sr, t1: end / sr, peakDb: bDb, level });

    if (level === 'clip') {
      if (regionOpen) regionOpen.end = end / sr;
      else regionOpen = { start: start / sr, end: end / sr };
    } else if (regionOpen) {
      clipRegions.push(regionOpen);
      regionOpen = null;
    }
  }
  if (regionOpen) clipRegions.push(regionOpen);

  const rms = Math.sqrt(sumSq / (n * chans.length || 1));

  return {
    peakDb: toDb(peak),
    rmsDb: toDb(rms),
    integratedLufs: integratedLoudness(buffer),
    clipped: peak >= 1,
    worstAt: peak >= 1 ? worstAt : null,
    heat,
    clipRegions,
  };
}

// --- ITU-R BS.1770 integrated loudness -----------------------------------

/** Two-stage K-weighting: a high-shelf "head" filter + a high-pass. Coefficients
 *  from BS.1770-4 for 48 kHz; resampling other rates is out of scope, we scale
 *  the pre-filter frequency instead (adequate for a teaching meter). */
function kWeight(samples: Float32Array, sr: number): Float32Array {
  // Stage 1: high shelf (+4 dB @ ~1681 Hz)
  const db = 3.999843853973347;
  const f0 = 1681.974450955533 * (48000 / sr);
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, db / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0_ = 1 + K / Q + K * K;
  const b0 = (Vh + (Vb * K) / Q + K * K) / a0_;
  const b1 = (2 * (K * K - Vh)) / a0_;
  const b2 = (Vh - (Vb * K) / Q + K * K) / a0_;
  const a1 = (2 * (K * K - 1)) / a0_;
  const a2 = (1 - K / Q + K * K) / a0_;

  const stage1 = biquad(samples, b0, b1, b2, a1, a2);

  // Stage 2: high-pass @ ~38 Hz
  const f0b = 38.13547087602444 * (48000 / sr);
  const Qb = 0.5003270373238773;
  const Kb = Math.tan((Math.PI * f0b) / sr);
  const a0b = 1 + Kb / Qb + Kb * Kb;
  const hb0 = 1 / a0b;
  const hb1 = -2 / a0b;
  const hb2 = 1 / a0b;
  const ha1 = (2 * (Kb * Kb - 1)) / a0b;
  const ha2 = (1 - Kb / Qb + Kb * Kb) / a0b;

  return biquad(stage1, hb0, hb1, hb2, ha1, ha2);
}

function biquad(
  x: Float32Array,
  b0: number,
  b1: number,
  b2: number,
  a1: number,
  a2: number,
): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xn = x[i];
    const yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    y[i] = yn;
    x2 = x1;
    x1 = xn;
    y2 = y1;
    y1 = yn;
  }
  return y;
}

export function integratedLoudness(buffer: AudioBuffer): number | null {
  try {
    const sr = buffer.sampleRate;
    const chW: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      chW.push(kWeight(buffer.getChannelData(c), sr));
    }
    // channel weights: L/R = 1.0 (mono duplicated)
    const blockSize = Math.floor(0.4 * sr);
    const hop = Math.floor(0.1 * sr); // 75% overlap
    const blocks: number[] = [];
    for (let start = 0; start + blockSize <= buffer.length; start += hop) {
      let sum = 0;
      for (let c = 0; c < chW.length; c++) {
        const d = chW[c];
        for (let i = start; i < start + blockSize; i++) sum += d[i] * d[i];
      }
      const meanSq = sum / (blockSize * chW.length);
      const lk = -0.691 + 10 * Math.log10(meanSq || 1e-12);
      blocks.push(lk);
    }
    if (blocks.length === 0) return null;

    // absolute gate at −70 LUFS
    const gatedAbs = blocks.filter((l) => l > -70);
    if (gatedAbs.length === 0) return null;
    const meanAbs =
      10 * Math.log10(gatedAbs.reduce((s, l) => s + Math.pow(10, l / 10), 0) / gatedAbs.length);
    // relative gate at −10 LU below the ungated mean
    const relThresh = meanAbs - 10;
    const gatedRel = gatedAbs.filter((l) => l > relThresh);
    if (gatedRel.length === 0) return null;
    const integrated =
      10 *
      Math.log10(gatedRel.reduce((s, l) => s + Math.pow(10, l / 10), 0) / gatedRel.length);
    return Math.round(integrated * 10) / 10;
  } catch {
    return null;
  }
}

// --- live meter from an AnalyserNode ------------------------------------

export interface LiveMeter {
  peakDb: number;
  rmsDb: number;
}

let scratch = new Float32Array(2048);

export function readLiveMeter(analyser: AnalyserNode): LiveMeter {
  if (scratch.length < analyser.fftSize) scratch = new Float32Array(analyser.fftSize);
  const buf = scratch;
  analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < analyser.fftSize; i++) {
    const s = buf[i];
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSq += s * s;
  }
  return { peakDb: toDb(peak), rmsDb: toDb(Math.sqrt(sumSq / analyser.fftSize)) };
}
