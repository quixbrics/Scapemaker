/* Display metadata for automatable parameters — value range and formatting for the timeline lane editor and the inspector. */

import type { AutomationParam } from '../state/project';

export interface ParamMeta {
  label: string;
  min: number;
  max: number;
  default: number;
  format(v: number): string;
}

const dbFmt = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

export const AUTOMATION_PARAMS: Record<AutomationParam, ParamMeta> = {
  gain: { label: 'Gain', min: -60, max: 6, default: 0, format: dbFmt },
  pan: { label: 'Pan', min: -1, max: 1, default: 0, format: (v) => (Math.abs(v) < 0.02 ? 'C' : `${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}`) },
  'eq.low': { label: 'EQ — Low', min: -18, max: 18, default: 0, format: dbFmt },
  'eq.lowMid': { label: 'EQ — Low mid', min: -18, max: 18, default: 0, format: dbFmt },
  'eq.mid': { label: 'EQ — Mid', min: -18, max: 18, default: 0, format: dbFmt },
  'eq.highMid': { label: 'EQ — High mid', min: -18, max: 18, default: 0, format: dbFmt },
  'eq.high': { label: 'EQ — High', min: -18, max: 18, default: 0, format: dbFmt },
  'reverb.wet': { label: 'Reverb wet', min: 0, max: 1, default: 0.2, format: (v) => `${Math.round(v * 100)}%` },
};

export const AUTOMATION_PARAM_LIST = Object.keys(AUTOMATION_PARAMS) as AutomationParam[];

/** value (min..max) -> normalised 0 (min) .. 1 (max) */
export function toUnit(param: AutomationParam, value: number): number {
  const m = AUTOMATION_PARAMS[param];
  return (value - m.min) / (m.max - m.min || 1);
}
/** normalised 0..1 -> value (min..max) */
export function fromUnit(param: AutomationParam, unit: number): number {
  const m = AUTOMATION_PARAMS[param];
  return m.min + Math.max(0, Math.min(1, unit)) * (m.max - m.min);
}
