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

const envScratch = new Map<number, Float32Array>();
function scratch(width: number): Float32Array {
  let a = envScratch.get(width);
  if (!a) {
    a = new Float32Array(width * 2);
    envScratch.set(width, a);
  }
  return a;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.trim().replace('#', '');
  if (m.length === 3) {
    return [parseInt(m[0] + m[0], 16), parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16)];
  }
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
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
  const cssW = canvas.clientWidth || 1;
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

  const [r, g, b] = hexToRgb(token(style.hueToken) || '#7b8b9c');
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

  const [r, g, b] = hexToRgb(token('--text-faint') || '#7f90a1');
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
