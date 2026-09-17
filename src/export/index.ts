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
import { buildZip, type ZipEntry } from './zip';
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
  /** the single archive the files were delivered in, when more than one was made */
  archive: string | null;
  peakDb: number;
  clipped: boolean;
  restricted: Array<{ title: string; licence: string; tracks: string[] }>;
  notice: string | null;
}

async function toBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export async function runExport(
  project: Project,
  selection: ExportSelection,
  onProgress?: (label: string, fraction: number) => void,
): Promise<ExportReport> {
  const base = safeName(project.name);
  const files: string[] = [];
  // Collected, then delivered as ONE download. Firing downloadBlob per file
  // put Chrome's "Download multiple files?" bar in front of an eleven-file
  // export, and a missed prompt lost the stems silently.
  const bundle: Array<ZipEntry & { blob: Blob }> = [];
  let peakDb = -Infinity;
  let clipped = false;

  const add = async (name: string, blob: Blob): Promise<void> => {
    bundle.push({ name, data: await toBytes(blob), blob });
    files.push(name);
  };

  if (selection.mixdown || selection.stems) {
    onProgress?.('Rendering mixdown', 0);
    const mix = await renderProject(project, {
      onProgress: (f) => onProgress?.('Rendering mixdown', f * 0.5),
    });
    const analysis = analyseBuffer(mix);
    peakDb = analysis.peakDb;
    clipped = analysis.clipped;

    if (selection.mixdown) {
      await add(`${base}_Final.wav`, encodeWav(mix, 24));
    }

    if (selection.stems) {
      onProgress?.('Rendering stems', 0.5);
      const stems = await renderStems(project, {
        onProgress: (f) => onProgress?.('Rendering stems', 0.5 + f * 0.5),
      });
      for (const stem of stems) {
        await add(`${base}_stem_${safeName(stem.trackName)}.wav`, encodeWav(stem.buffer, 24));
      }
    }
  }

  if (selection.sources) {
    await add(`${base}_sources.csv`, new Blob([buildSourcesCsv(project)], { type: 'text/csv' }));
  }

  if (selection.reflection) {
    await add(
      `${base}_reflection.md`,
      new Blob([buildReflectionMarkdown(project)], { type: 'text/markdown' }),
    );
  }

  // One file goes out as itself — wrapping a lone reflection in an archive
  // would be ceremony. Anything more is bundled.
  let archive: string | null = null;
  if (bundle.length === 1) {
    downloadBlob(bundle[0].blob, bundle[0].name);
  } else if (bundle.length > 1) {
    onProgress?.('Packaging', 1);
    archive = `${base}_export.zip`;
    downloadBlob(buildZip(bundle), archive);
  }

  const restrictedList = restrictedAssetsInUse(project).map((r) => ({
    title: r.ref.title,
    licence: r.ref.licence.name,
    tracks: r.tracks,
  }));

  return {
    files,
    archive,
    peakDb,
    clipped,
    restricted: restrictedList,
    notice: restrictedList.length > 0 ? NON_DISTRIBUTION_NOTICE : null,
  };
}
