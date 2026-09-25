/*
 * Canvas contour waveform (UI spec principle 4: "waveforms are contours, not
 * blocks" — filled at low opacity with a 1px full-colour stroke). Painted from
 * the peak pyramid ONLY (non-negotiable #2), re-read from tokens on theme
 * change (never cache resolved colours).
 */

import { pickLevel, readEnvelope, type PeakPyramid } from '../audio/peaks';
import { token } from './theme';

export interface WaveformStyle {
  /** CSS token name for the hue, e.g. '--track-3' */
  hueToken: string;
  fillAlpha: number;
  strokeAlpha: number;
}

const MAX_CANVAS_PX = 16_384;

const envScratch = new Map<number, Float32Array>();
function scratch(width: number): Float32Array {
  let a = envScratch.get(width);
  if (!a) {
    a = new Float32Array(width * 2);
    envScratch.set(width, a);
  }
  return a;
}

/**
 * Every colour token is hex today, but a token that ever becomes rgb() or
 * oklch() would otherwise turn every waveform into NaN — silently, since
 * canvas just refuses the fill. Fall back to letting the browser parse it.
 */
function parseColour(value: string, fallback: [number, number, number]): [number, number, number] {
  const hex = value.trim().replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)];
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const m = value.match(/(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return fallback;
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  pyramid: PeakPyramid,
  sourceStart: number,
  sourceDuration: number,
  pixelsPerSecond: number,
  style: WaveformStyle,
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // A canvas wider than the browser's limit (~32k px) silently draws nothing.
  // Zoomed right in on a long clip the element can be far wider than that,
  // so draw at most MAX_CANVAS_PX and let CSS stretch it.
  const cssW = Math.min(canvas.clientWidth || 1, MAX_CANVAS_PX / dpr);
  const cssH = canvas.clientHeight || 1;
  const w = Math.max(1, Math.floor(cssW * dpr));
  const hgt = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== w || canvas.height !== hgt) {
    canvas.width = w;
    canvas.height = hgt;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, hgt);

  const cols = Math.max(2, Math.floor(cssW));
  const level = pickLevel(pyramid, pixelsPerSecond);
  const env = scratch(cols);
  readEnvelope(pyramid, level, sourceStart, sourceDuration, cols, env);

  const [r, g, b] = parseColour(token(style.hueToken), [123, 139, 156]);
  const mid = hgt / 2;
  const amp = mid * 0.92;
  const sx = w / cols;

  ctx.beginPath();
  ctx.moveTo(0, mid - (env[1] ?? 0) * amp);
  for (let i = 0; i < cols; i++) {
    ctx.lineTo(i * sx, mid - env[i * 2 + 1] * amp);
  }
  for (let i = cols - 1; i >= 0; i--) {
    ctx.lineTo(i * sx, mid - env[i * 2] * amp);
  }
  ctx.closePath();

  ctx.fillStyle = `rgba(${r},${g},${b},${style.fillAlpha})`;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = `rgba(${r},${g},${b},${style.strokeAlpha})`;
  ctx.stroke();
}

/** Master summed waveform — neutral hue, higher fill. */
export function drawMasterWaveform(
  canvas: HTMLCanvasElement,
  samples: Float32Array, // interleaved min,max per column, −1..1
  cols: number,
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 1;
  const cssH = canvas.clientHeight || 1;
  const w = Math.floor(cssW * dpr);
  const hgt = Math.floor(cssH * dpr);
  if (canvas.width !== w || canvas.height !== hgt) {
    canvas.width = w;
    canvas.height = hgt;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, hgt);

  const [r, g, b] = parseColour(token('--text-faint'), [127, 144, 161]);
  const mid = hgt / 2;
  const amp = mid * 0.92;
  const sx = w / cols;
  ctx.beginPath();
  ctx.moveTo(0, mid - (samples[1] ?? 0) * amp);
  for (let i = 0; i < cols; i++) ctx.lineTo(i * sx, mid - (samples[i * 2 + 1] ?? 0) * amp);
  for (let i = cols - 1; i >= 0; i--) ctx.lineTo(i * sx, mid - (samples[i * 2] ?? 0) * amp);
  ctx.closePath();
  ctx.fillStyle = `rgba(${r},${g},${b},0.35)`;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = `rgba(${r},${g},${b},0.8)`;
  ctx.stroke();
}
