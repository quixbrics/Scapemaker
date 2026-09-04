/*
 * Sources CSV (Build Plan §10). Columns, in order:
 *   title, author, source, source_url, licence, licence_url, restricted,
 *   used_on_track, imported_at
 * Plus the non-distribution notice as a comment header, and the specific list
 * of restricted assets is implied by the `restricted` column.
 */

import type { Project } from '../state/project';
import { isRestrictive } from '../licence/model';
import { NON_DISTRIBUTION_NOTICE } from '../licence/warnings';

function csvCell(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function buildSourcesCsv(project: Project): string {
  const usage = new Map<string, Set<string>>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!usage.has(clip.assetId)) usage.set(clip.assetId, new Set());
      usage.get(clip.assetId)!.add(track.name);
    }
  }

  const header = [
    'title',
    'author',
    'source',
    'source_url',
    'licence',
    'licence_url',
    'restricted',
    'used_on_track',
    'imported_at',
  ];

  const rows: string[][] = [];
  for (const [assetId, tracks] of usage) {
    const ref = project.assets[assetId];
    if (!ref) continue;
    const restricted =
      ref.licence.id === 'unknown'
        ? 'unknown-licence'
        : isRestrictive(ref.licence)
          ? [!ref.licence.allowsCommercial ? 'NonCommercial' : '', !ref.licence.allowsDerivatives ? 'NoDerivatives' : '']
              .filter(Boolean)
              .join('+')
          : 'no';
    rows.push([
      ref.title,
      ref.author,
      ref.source,
      ref.sourceUrl ?? '',
      ref.licence.name,
      ref.licence.url ?? '',
      restricted,
      [...tracks].join('; '),
      ref.importedAt,
    ]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));

  const lines: string[] = [];
  lines.push(`# ScapeMaker sources — ${project.name}`);
  lines.push(`# Exported ${new Date().toISOString()}`);
  const anyRestricted = rows.some((r) => r[6] !== 'no');
  if (anyRestricted) {
    lines.push('#');
    for (const seg of NON_DISTRIBUTION_NOTICE.match(/.{1,90}(\s|$)/g) ?? [NON_DISTRIBUTION_NOTICE]) {
      lines.push(`# ${seg.trim()}`);
    }
    lines.push('# Assets with a value in the "restricted" column below triggered this notice.');
  }
  lines.push(header.map(csvCell).join(','));
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return lines.join('\n') + '\n';
}
