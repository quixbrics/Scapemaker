/*
 * Reverb: a ConvolverNode driven by an impulse response SYNTHESISED at runtime
 * — filtered noise with per-band exponential decay. No shipped IR files: zero
 * payload, no licensing burden, and a synth IR can follow a live "Size" control
 * where a fixed file cannot (concept §7.7).
 *
 * Generated IRs are cached by (size, decay) rounded to a step so dragging a
 * slider doesn't reallocate on every frame.
 */

import type { ReverbPreset, ReverbSettings } from '../../state/project';

export interface PresetDef {
  label: string;
  size: number; // 0..1
  decay: number; // seconds
  wet: number; // 0..1
  /** plain-language description shown in the preset tooltip */
  blurb: string;
}

export const REVERB_PRESETS: Record<Exclude<ReverbPreset, 'custom'>, PresetDef> = {
  forest: {
    label: 'Forest',
    size: 0.4,
    decay: 1.6,
    wet: 0.22,
    blurb: 'soft, diffuse, no hard walls — sound scatters off leaves and trunks',
  },
  tunnel: {
    label: 'Tunnel',
    size: 0.55,
    decay: 2.4,
    wet: 0.34,
    blurb: 'a long hard cylinder — strong early echo, slow metallic tail',
  },
  hall: {
    label: 'Hall',
    size: 0.7,
    decay: 2.2,
    wet: 0.28,
    blurb: 'a concert hall — smooth, even, musical decay',
  },
  street: {
    label: 'Street',
    size: 0.34,
    decay: 0.9,
    wet: 0.18,
    blurb: 'a short, hard reflection like a narrow road between buildings',
  },
  cathedral: {
    label: 'Cathedral',
    size: 0.92,
    decay: 4.5,
    wet: 0.32,
    blurb: 'huge stone volume — very long, bright, enveloping tail',
  },
  industrial: {
    label: 'Industrial Space',
    size: 0.78,
    decay: 3.0,
    wet: 0.3,
    blurb: 'a large metal shed — bright, rattly, uneven reflections',
  },
};

export function applyPreset(settings: ReverbSettings, preset: Exclude<ReverbPreset, 'custom'>): ReverbSettings {
  const def = REVERB_PRESETS[preset];
  return { ...settings, preset, size: def.size, decay: def.decay, wet: def.wet };
}

// --- IR synthesis ----------------------------------------------------------

const irCache = new Map<string, AudioBuffer>();

function key(sampleRate: number, size: number, decay: number): string {
  const s = Math.round(size * 20) / 20;
  const d = Math.round(decay * 10) / 10;
  return `${sampleRate}:${s}:${d}`;
}

/** White noise with a per-sample exponential envelope, lightly low-passed as
 *  the tail develops so larger/longer spaces sound darker. */
export function synthesiseIR(ctx: BaseAudioContext, size: number, decay: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const k = key(sr, size, decay);
  const hit = irCache.get(k);
  if (hit) return hit;

  const seconds = Math.max(0.15, decay * (0.6 + size * 0.9));
  const len = Math.max(1, Math.floor(sr * seconds));
  const ir = ctx.createBuffer(2, len, sr);
  // predelay grows with size
  const predelay = Math.floor(sr * (0.005 + size * 0.06));
  // decay constant: bigger decay => slower falloff
  const tau = decay * (0.35 + size * 0.5);

  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    let lp = 0;
    // slightly different seed per channel for stereo width
    let seed = (ch + 1) * 0x9e3779b9;
    const rand = () => {
      // xorshift32
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0xffffffff - 0.5;
    };
    const lpCoeff = 0.2 + (1 - size) * 0.5; // darker for bigger rooms
    for (let i = 0; i < len; i++) {
      if (i < predelay) {
        data[i] = 0;
        continue;
      }
      const t = (i - predelay) / sr;
      const env = Math.exp(-t / tau);
      const n = rand();
      lp += lpCoeff * (n - lp);
      // early reflection cluster in the first ~60ms
      const early = t < 0.06 ? 1 + (0.06 - t) * 8 : 1;
      data[i] = lp * env * early * 0.9;
    }
  }
  irCache.set(k, ir);
  return ir;
}

export interface ReverbNode {
  input: GainNode;
  output: GainNode;
  wet: GainNode;
  dry: GainNode;
  convolver: ConvolverNode;
  setSettings(s: ReverbSettings): void;
}

export function buildReverb(ctx: BaseAudioContext, settings: ReverbSettings): ReverbNode {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const convolver = ctx.createConvolver();
  convolver.normalize = true;

  input.connect(dry).connect(output);
  input.connect(convolver).connect(wet).connect(output);

  const node: ReverbNode = {
    input,
    output,
    wet,
    dry,
    convolver,
    setSettings(s) {
      convolver.buffer = synthesiseIR(ctx, s.size, s.decay);
      const on = s.enabled ? 1 : 0;
      wet.gain.value = on * s.wet;
      dry.gain.value = s.enabled ? s.dry : 1;
    },
  };
  node.setSettings(settings);
  return node;
}
