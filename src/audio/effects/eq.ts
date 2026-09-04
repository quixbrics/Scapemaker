/*
 * Five-band equaliser: low shelf, three peaking, high shelf. A plain
 * BiquadFilterNode chain. The same builder runs in the live graph and the
 * offline render (non-negotiable #8).
 */

import type { EqBand, EqSettings } from '../../state/project';

export interface EqChain {
  input: AudioNode;
  output: AudioNode;
  filters: BiquadFilterNode[];
}

const BAND_TYPES: BiquadFilterType[] = [
  'lowshelf',
  'peaking',
  'peaking',
  'peaking',
  'highshelf',
];

export function buildEqChain(ctx: BaseAudioContext, settings: EqSettings): EqChain {
  const filters = settings.bands.map((band, i) => {
    const f = ctx.createBiquadFilter();
    f.type = BAND_TYPES[i];
    f.frequency.value = band.frequency;
    f.gain.value = settings.enabled ? band.gain : 0;
    f.Q.value = band.q;
    return f;
  });
  for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
  return { input: filters[0], output: filters[filters.length - 1], filters };
}

/** Push new band values onto an existing chain without a rebuild. */
export function updateEqChain(chain: EqChain, settings: EqSettings): void {
  settings.bands.forEach((band: EqBand, i) => {
    const f = chain.filters[i];
    if (!f) return;
    f.frequency.value = band.frequency;
    f.Q.value = band.q;
    f.gain.value = settings.enabled ? band.gain : 0;
  });
}

export const EQ_BAND_LABELS = ['Low', 'Low mid', 'Mid', 'High mid', 'High'] as const;
