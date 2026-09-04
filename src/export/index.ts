/*
 * Export orchestration (concept §10):
 *   - Mixdown:     <name>_Final.wav
 *   - Stems:       one WAV per non-empty track
 *   - Sources CSV: every asset with source, licence, restrictions
 *   - Reflection:  markdown
 *
 * Export repeats the non-distribution notice and names the specific assets that
 * triggered it (Build Plan §10 gate).
 */

import type { Project } from '../state/project';
import { renderProject, renderStems } from '../audio/render';
import { analyseBuffer } from '../audio/analysis';
import { encodeWav } from '../audio/wav';
import { buildSourcesCsv } from './sourcesCsv';
import { buildReflectionMarkdown } from './reflection';
import { downloadBlob, safeName } from './download';
import { restrictedAssetsInUse, NON_DISTRIBUTION_NOTICE } from '../licence/warnings';

export type ExportKind = 'mixdown' | 'stems' | 'sources' | 'reflection';

export interface ExportSelection {
  mixdown: boolean;
  stems: boolean;
  sources: boolean;
  reflection: boolean;
}

export interface ExportReport {
  files: string[];
  peakDb: number;
  clipped: boolean;
  restricted: Array<{ title: string; licence: string; tracks: string[] }>;
  notice: string | null;
}

export async function runExport(
  project: Project,
  selection: ExportSelection,
  onProgress?: (label: string, fraction: number) => void,
): Promise<ExportReport> {
  const base = safeName(project.name);
  const files: string[] = [];
  let peakDb = -Infinity;
  let clipped = false;

  if (selection.mixdown || selection.stems) {
    onProgress?.('Rendering mixdown', 0);
    const mix = await renderProject(project, {
      onProgress: (f) => onProgress?.('Rendering mixdown', f * 0.5),
    });
    const analysis = analyseBuffer(mix);
    peakDb = analysis.peakDb;
    clipped = analysis.clipped;

    if (selection.mixdown) {
      const name = `${base}_Final.wav`;
      downloadBlob(encodeWav(mix, 24), name);
      files.push(name);
    }

    if (selection.stems) {
      onProgress?.('Rendering stems', 0.5);
      const stems = await renderStems(project, {
        onProgress: (f) => onProgress?.('Rendering stems', 0.5 + f * 0.5),
      });
      for (const stem of stems) {
        const name = `${base}_stem_${safeName(stem.trackName)}.wav`;
        downloadBlob(encodeWav(stem.buffer, 24), name);
        files.push(name);
      }
    }
  }

  if (selection.sources) {
    const csv = buildSourcesCsv(project);
    const name = `${base}_sources.csv`;
    downloadBlob(new Blob([csv], { type: 'text/csv' }), name);
    files.push(name);
  }

  if (selection.reflection) {
    const md = buildReflectionMarkdown(project);
    const name = `${base}_reflection.md`;
    downloadBlob(new Blob([md], { type: 'text/markdown' }), name);
    files.push(name);
  }

  const restrictedList = restrictedAssetsInUse(project).map((r) => ({
    title: r.ref.title,
    licence: r.ref.licence.name,
    tracks: r.tracks,
  }));

  return {
    files,
    peakDb,
    clipped,
    restricted: restrictedList,
    notice: restrictedList.length > 0 ? NON_DISTRIBUTION_NOTICE : null,
  };
}
