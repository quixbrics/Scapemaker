/*
 * Licence parsing and classification. Built in Phase 3 as a data-model concern
 * (Build Plan §8) — every source adapter normalises to `Licence`, and the
 * badge/warn/allow logic in warnings.ts reads only this shape.
 */

import type { Licence, LicenceId } from '../state/project';

interface LicenceSpec {
  name: string;
  short: string; // chip label
  requiresAttribution: boolean;
  allowsDerivatives: boolean;
  allowsCommercial: boolean;
  allowsRedistribution: boolean;
}

const SPECS: Record<LicenceId, LicenceSpec> = {
  cc0: {
    name: 'CC0 1.0',
    short: 'CC0',
    requiresAttribution: false,
    allowsDerivatives: true,
    allowsCommercial: true,
    allowsRedistribution: true,
  },
  pd: {
    name: 'Public Domain',
    short: 'PD',
    requiresAttribution: false,
    allowsDerivatives: true,
    allowsCommercial: true,
    allowsRedistribution: true,
  },
  by: {
    name: 'CC BY',
    short: 'BY',
    requiresAttribution: true,
    allowsDerivatives: true,
    allowsCommercial: true,
    allowsRedistribution: true,
  },
  'by-sa': {
    name: 'CC BY-SA',
    short: 'BY-SA',
    requiresAttribution: true,
    allowsDerivatives: true,
    allowsCommercial: true,
    allowsRedistribution: true,
  },
  'sampling+': {
    name: 'Sampling Plus',
    short: 'S+',
    requiresAttribution: true,
    allowsDerivatives: true,
    allowsCommercial: false,
    allowsRedistribution: true,
  },
  'by-nc': {
    name: 'CC BY-NC',
    short: 'NC',
    requiresAttribution: true,
    allowsDerivatives: true,
    allowsCommercial: false,
    allowsRedistribution: true,
  },
  'by-nd': {
    name: 'CC BY-ND',
    short: 'ND',
    requiresAttribution: true,
    allowsDerivatives: false,
    allowsCommercial: true,
    allowsRedistribution: true,
  },
  'by-nc-sa': {
    name: 'CC BY-NC-SA',
    short: 'NC-SA',
    requiresAttribution: true,
    allowsDerivatives: true,
    allowsCommercial: false,
    allowsRedistribution: true,
  },
  'by-nc-nd': {
    name: 'CC BY-NC-ND',
    short: 'NC-ND',
    requiresAttribution: true,
    allowsDerivatives: false,
    allowsCommercial: false,
    allowsRedistribution: true,
  },
  unknown: {
    name: 'Licence unknown',
    short: '?',
    requiresAttribution: true,
    allowsDerivatives: false,
    allowsCommercial: false,
    allowsRedistribution: false,
  },
};

export function makeLicence(id: LicenceId, url?: string, versionName?: string): Licence {
  const spec = SPECS[id];
  return {
    id,
    name: versionName ?? spec.name,
    url,
    requiresAttribution: spec.requiresAttribution,
    allowsDerivatives: spec.allowsDerivatives,
    allowsCommercial: spec.allowsCommercial,
    allowsRedistribution: spec.allowsRedistribution,
  };
}

export function licenceShort(licence: Licence): string {
  return SPECS[licence.id].short;
}

export const ALL_LICENCE_IDS = Object.keys(SPECS) as LicenceId[];
export function licenceName(id: LicenceId): string {
  return SPECS[id].name;
}

/**
 * Parse a licence URL (Creative Commons, Freesound, Archive `licenseurl`) or a
 * free-text licence string into a normalised Licence.
 */
export function parseLicence(input: string | undefined | null): Licence {
  if (!input) return makeLicence('unknown');
  const s = input.toLowerCase();

  // Creative Commons URLs: /licenses/by-nc-nd/3.0/ , /publicdomain/zero/1.0/
  if (s.includes('publicdomain/zero') || /\bcc0\b/.test(s)) return makeLicence('cc0', urlOf(input));
  if (s.includes('publicdomain/mark') || s.includes('public domain')) return makeLicence('pd', urlOf(input));

  const m = s.match(/licenses\/(by(?:-nc)?(?:-nd|-sa)?)(?:\/([0-9.]+))?/);
  if (m) {
    const id = normaliseCcToken(m[1]);
    const version = m[2] ? `CC ${m[1].toUpperCase()} ${m[2]}` : undefined;
    return makeLicence(id, urlOf(input), version);
  }

  // free text
  if (s.includes('sampling+')) return makeLicence('sampling+', urlOf(input));
  const textId = normaliseFreeText(s);
  if (textId) return makeLicence(textId, urlOf(input));

  return makeLicence('unknown', urlOf(input));
}

function urlOf(input: string): string | undefined {
  return /^https?:\/\//.test(input.trim()) ? input.trim() : undefined;
}

function normaliseCcToken(tok: string): LicenceId {
  const parts = tok.split('-');
  const has = (p: string) => parts.includes(p);
  if (has('nc') && has('nd')) return 'by-nc-nd';
  if (has('nc') && has('sa')) return 'by-nc-sa';
  if (has('nc')) return 'by-nc';
  if (has('nd')) return 'by-nd';
  if (has('sa')) return 'by-sa';
  return 'by';
}

function normaliseFreeText(s: string): LicenceId | null {
  const clean = s
    .replace(/creative commons/g, '')
    .replace(/attribution/g, 'by')
    .replace(/non[-\s]?commercial/g, 'nc')
    .replace(/no[-\s]?deriv(ative)?s?/g, 'nd')
    .replace(/share[-\s]?alike/g, 'sa');
  const has = (tok: string) => new RegExp(`\\b${tok}\\b`).test(clean);
  if (has('by') && has('nc') && has('nd')) return 'by-nc-nd';
  if (has('by') && has('nc') && has('sa')) return 'by-nc-sa';
  if (has('by') && has('nc')) return 'by-nc';
  if (has('by') && has('nd')) return 'by-nd';
  if (has('by') && has('sa')) return 'by-sa';
  if (has('nc') && has('nd')) return 'by-nc-nd';
  if (has('nd')) return 'by-nd';
  if (has('nc')) return 'by-nc';
  if (has('by')) return 'by';
  return null;
}

/** Restrictive = NonCommercial or NoDerivatives. These trigger the warning. */
export function isRestrictive(licence: Licence): boolean {
  return !licence.allowsCommercial || !licence.allowsDerivatives;
}

/** For the chip colour: 'ok' | 'warn' | 'unknown'. */
export function licenceTone(licence: Licence): 'ok' | 'warn' | 'unknown' {
  if (licence.id === 'unknown') return 'unknown';
  return isRestrictive(licence) ? 'warn' : 'ok';
}
