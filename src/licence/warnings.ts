/*
 * Import + export warning logic. Badge, warn, allow (concept §6.2):
 *  - badge: every result shows its licence (UI concern, uses licenceTone)
 *  - warn : importing NC/ND raises an unmissable, specific warning
 *  - allow: the student may proceed; the decision is recorded
 */

import type { AssetRef, Licence, Project } from '../state/project';
import { isRestrictive } from './model';

export const NON_DISTRIBUTION_NOTICE =
  'Work produced using files under restrictive licences (NonCommercial, ' +
  'NoDerivatives) cannot legally be publicly distributed. It may be used for ' +
  'private study and assessed coursework. Publishing it — including on social ' +
  'media, streaming platforms, showreels, or a public festival submission — ' +
  'may infringe the licence.';

export interface ImportWarning {
  needed: boolean;
  title: string;
  body: string;
  /** true for ND specifically — layering IS a derivative work */
  derivativeConflict: boolean;
}

export function importWarningFor(licence: Licence): ImportWarning {
  if (!isRestrictive(licence)) {
    return { needed: false, title: '', body: '', derivativeConflict: false };
  }

  const bits: string[] = [];
  if (!licence.allowsDerivatives) {
    bits.push(
      `This recording is under ${licence.name} — a NoDerivatives licence. ` +
        `Layering it into a soundscape is itself a derivative work. You can use ` +
        `this to study and to hand in coursework, but a soundscape built from it ` +
        `cannot be published or shared publicly.`,
    );
  }
  if (!licence.allowsCommercial && licence.allowsDerivatives) {
    bits.push(
      `This recording is under ${licence.name} — a NonCommercial licence. ` +
        `You can use it for coursework, but anything built from it cannot be ` +
        `used commercially or, in practice, published publicly.`,
    );
  }
  if (!licence.allowsCommercial && !licence.allowsDerivatives) {
    // already covered by the ND branch; keep the message single and clear
  }

  return {
    needed: true,
    title: !licence.allowsDerivatives ? 'NoDerivatives licence' : 'NonCommercial licence',
    body: bits.join(' '),
    derivativeConflict: !licence.allowsDerivatives,
  };
}

export interface RestrictedAsset {
  ref: AssetRef;
  reason: 'nc' | 'nd' | 'nc-nd' | 'unknown';
  tracks: string[]; // track names the asset is used on
}

/** Every restricted asset actually placed on the timeline, with where. */
export function restrictedAssetsInUse(project: Project): RestrictedAsset[] {
  const used = new Map<string, Set<string>>(); // assetId -> track names
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!used.has(clip.assetId)) used.set(clip.assetId, new Set());
      used.get(clip.assetId)!.add(track.name);
    }
  }
  const out: RestrictedAsset[] = [];
  for (const [assetId, trackNames] of used) {
    const ref = project.assets[assetId];
    if (!ref) continue;
    const l = ref.licence;
    if (l.id === 'unknown') {
      out.push({ ref, reason: 'unknown', tracks: [...trackNames] });
    } else if (isRestrictive(l)) {
      const reason = !l.allowsCommercial && !l.allowsDerivatives ? 'nc-nd' : !l.allowsDerivatives ? 'nd' : 'nc';
      out.push({ ref, reason, tracks: [...trackNames] });
    }
  }
  return out;
}

export function restrictedCount(project: Project): number {
  return restrictedAssetsInUse(project).length;
}
