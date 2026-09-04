/*
 * Web Audio graph builder — shared by live playback (graph.ts consumer:
 * transport.ts) and the offline render (render.ts). NON-NEGOTIABLE #8: any
 * parameter that affects sound is applied HERE, once, so playback and export
 * cannot diverge.
 *
 * Per track:  clip sources → clip gain (fades) → track gain → EQ → panner
 *             → reverb (wet/dry) → master
 * Master:     sum → master gain → [analyser] → destination
 */

import type { Clip, Project, Track } from '../state/project';
import { buildEqChain } from './effects/eq';
import { buildReverb } from './effects/reverb';
import { scheduleAutomation } from './automation';

/** Band order matches EqSettings.bands: low shelf, low mid, mid, upper mid, high shelf. */
const EQ_BAND_INDEX: Record<string, number> = {
  'eq.low': 0,
  'eq.lowMid': 1,
  'eq.mid': 2,
  'eq.highMid': 3,
  'eq.high': 4,
};

export function dbToGain(db: number): number {
  return db <= -120 ? 0 : Math.pow(10, db / 20);
}
export function gainToDb(g: number): number {
  return g <= 0 ? -Infinity : 20 * Math.log10(g);
}

export interface BuildOptions {
  /** context time that timeline t=0 maps to */
  timeOrigin: number;
  /** timeline position (seconds) playback/render starts from */
  playFrom: number;
  /** timeline position to stop at (for export); omitted = play to project end */
  playTo?: number;
  /** connect master here; defaults to ctx.destination */
  destination?: AudioNode;
  /** attach an AnalyserNode on the master bus (live only) */
  withAnalyser?: boolean;
  /** restrict to a single track id (stems export) */
  onlyTrackId?: string;
}

export interface LiveGraph {
  master: GainNode;
  analyser: AnalyserNode | null;
  sources: AudioBufferSourceNode[];
  trackChains: Map<string, TrackChain>;
  stop(): void;
}

interface TrackChain {
  gain: GainNode;
  panner: StereoPannerNode;
  reverbWet: GainNode;
  /** low-shelf, 3x peaking, high-shelf — present only when track.eq exists */
  eqBands?: BiquadFilterNode[];
}

type BufferResolver = (assetId: string) => AudioBuffer | undefined;

export function buildGraph(
  ctx: BaseAudioContext,
  project: Project,
  resolve: BufferResolver,
  opts: BuildOptions,
): LiveGraph {
  const dest = opts.destination ?? (ctx as AudioContext).destination;
  const master = ctx.createGain();
  master.gain.value = 1;

  let analyser: AnalyserNode | null = null;
  if (opts.withAnalyser) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    master.connect(analyser);
    analyser.connect(dest);
  } else {
    master.connect(dest);
  }

  const anySolo = project.tracks.some((t) => t.solo);
  const sources: AudioBufferSourceNode[] = [];
  const trackChains = new Map<string, TrackChain>();

  for (const track of project.tracks) {
    if (opts.onlyTrackId && track.id !== opts.onlyTrackId) continue;

    const audible = !track.muted && (!anySolo || track.solo);

    const trackGain = ctx.createGain();
    trackGain.gain.value = audible ? dbToGain(track.gain) : 0;

    const panner = ctx.createStereoPanner();
    panner.pan.value = track.pan;

    // EQ (optional)
    let headNode: AudioNode = trackGain;
    let tailNode: AudioNode = trackGain;
    let eqBands: BiquadFilterNode[] | undefined;
    if (track.eq) {
      const eq = buildEqChain(ctx, track.eq);
      tailNode.connect(eq.input);
      tailNode = eq.output;
      eqBands = eq.filters;
    }
    tailNode.connect(panner);

    // Reverb (optional) — panner → reverb → master
    let reverbWet: GainNode;
    if (track.reverb) {
      const rv = buildReverb(ctx, track.reverb);
      panner.connect(rv.input);
      rv.output.connect(master);
      reverbWet = rv.wet;
    } else {
      panner.connect(master);
      reverbWet = ctx.createGain(); // detached placeholder for automation targets
    }

    const chain: TrackChain = { gain: trackGain, panner, reverbWet, eqBands };
    trackChains.set(track.id, chain);

    // Automation — same scheduler as the offline path.
    if (audible) scheduleTrackAutomation(track, chain, opts);

    // Clips
    for (const clip of track.clips) {
      const buffer = resolve(clip.assetId);
      if (!buffer) continue;
      scheduleClip(ctx, clip, buffer, headNode, sources, opts);
    }
  }

  const stop = () => {
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
  };

  return { master, analyser, sources, trackChains, stop };
}

function scheduleTrackAutomation(
  track: Track,
  chain: TrackChain,
  opts: BuildOptions,
): void {
  for (const lane of track.automation) {
    if (!lane.enabled || lane.points.length === 0) continue;
    const common = {
      timeOrigin: opts.timeOrigin,
      windowStart: opts.playFrom,
      windowEnd: opts.playTo,
    };
    if (lane.param === 'gain') {
      scheduleAutomation(chain.gain.gain, lane, { ...common, transform: dbToGain });
    } else if (lane.param === 'pan') {
      scheduleAutomation(chain.panner.pan, lane, { ...common, transform: (v) => Math.max(-1, Math.min(1, v)) });
    } else if (lane.param === 'reverb.wet') {
      scheduleAutomation(chain.reverbWet.gain, lane, { ...common, transform: (v) => Math.max(0, Math.min(1, v)) });
    } else if (lane.param.startsWith('eq.')) {
      const band = chain.eqBands?.[EQ_BAND_INDEX[lane.param]];
      if (band) scheduleAutomation(band.gain, lane, common); // BiquadFilterNode.gain is already dB
    }
  }
}

function scheduleClip(
  ctx: BaseAudioContext,
  clip: Clip,
  buffer: AudioBuffer,
  chainInput: AudioNode,
  sources: AudioBufferSourceNode[],
  opts: BuildOptions,
): void {
  const repeats = clip.loop?.enabled ? Math.max(1, clip.loop.count) : 1;
  const xfade = clip.loop?.enabled ? Math.max(0, clip.loop.crossfade) : 0;

  for (let r = 0; r < repeats; r++) {
    const clipStart = clip.start + r * (clip.duration - xfade);
    const clipEnd = clipStart + clip.duration;
    if (opts.playTo !== undefined && clipStart >= opts.playTo) break;
    if (clipEnd <= opts.playFrom) continue;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const g = ctx.createGain();
    src.connect(g).connect(chainInput);

    // Portion of this clip repeat that actually plays.
    const audibleStart = Math.max(clipStart, opts.playFrom);
    const into = audibleStart - clipStart; // seconds already elapsed in the clip
    const playDur =
      Math.min(clipEnd, opts.playTo ?? clipEnd) - audibleStart;
    if (playDur <= 0) continue;

    const when = opts.timeOrigin + audibleStart;
    const offset = clip.sourceOffset + into;

    // Clip gain + fades, all in linear gain.
    const base = dbToGain(clip.gain);
    const fi = clip.fadeIn.duration;
    const fo = clip.fadeOut.duration;
    g.gain.setValueAtTime(fi > into ? 0 : base, when);

    if (fi > into) {
      const remain = fi - into;
      if (clip.fadeIn.curve === 'equalPower') {
        const curve = equalPowerCurve(64, 0, base);
        g.gain.setValueCurveAtTime(curve, when, remain);
      } else {
        g.gain.linearRampToValueAtTime(base, when + remain);
      }
    }
    if (fo > 0) {
      const foStart = clipEnd - fo;
      const foStartAudible = Math.max(foStart, audibleStart);
      if (foStartAudible < clipEnd) {
        g.gain.setValueAtTime(base, opts.timeOrigin + foStartAudible);
        if (clip.fadeOut.curve === 'equalPower') {
          const curve = equalPowerCurve(64, base, 0);
          g.gain.setValueCurveAtTime(
            curve,
            opts.timeOrigin + foStartAudible,
            clipEnd - foStartAudible,
          );
        } else {
          g.gain.linearRampToValueAtTime(0, opts.timeOrigin + clipEnd);
        }
      }
    }

    try {
      src.start(when, offset, playDur);
    } catch {
      continue;
    }
    sources.push(src);
  }
}

/** Equal-power ramp between two linear gains, `n` samples. */
export function equalPowerCurve(n: number, from: number, to: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // cos/sin quarter-wave crossfade
    const a = Math.cos((1 - t) * 0.5 * Math.PI);
    out[i] = from + (to - from) * a;
  }
  return out;
}
