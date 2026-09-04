/*
 * Local file import — the primary import path (concept §4.4), not a
 * convenience. Drag-and-drop and a file picker, multi-file, format validation
 * with a message that names the format, progress on large files.
 *
 * Local files carry a full attribution record like any other asset, with the
 * student named as recordist by default.
 */

import { assetStore } from '../audio/assetStore';
import { makeLicence } from '../licence/model';
import type { AssetRef } from '../state/project';
import { uid } from '../state/project';

const ACCEPT_EXT = ['wav', 'aif', 'aiff', 'mp3', 'ogg', 'oga', 'flac', 'm4a', 'mp4', 'aac'];
const ACCEPT_MIME = /^audio\//;

export const FILE_PICKER_ACCEPT = '.wav,.aif,.aiff,.mp3,.ogg,.oga,.flac,.m4a,.aac,audio/*';

export interface LocalImportOptions {
  /** default recordist credit for files recorded by the student */
  recordistName?: string;
  onProgress?: (done: number, total: number, name: string) => void;
}

export interface LocalImportResult {
  ref: AssetRef;
  ok: true;
}
export interface LocalImportError {
  name: string;
  ok: false;
  reason: string;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function isProbablyAudio(file: File): boolean {
  return ACCEPT_MIME.test(file.type) || ACCEPT_EXT.includes(extOf(file.name));
}

async function contentHash(file: File): Promise<string> {
  try {
    const buf = await file.slice(0, 1024 * 512).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(digest).slice(0, 8);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return uid('lf').slice(3);
  }
}

/** Import one file. Decodes via the asset store so memory rules are respected. */
export async function importFile(
  file: File,
  opts: LocalImportOptions = {},
): Promise<LocalImportResult | LocalImportError> {
  if (!isProbablyAudio(file)) {
    return {
      ok: false,
      name: file.name,
      reason: `"${extOf(file.name) || file.type || 'unknown'}" is not a supported audio format. ` +
        `Use WAV, AIFF, MP3, OGG, FLAC or M4A.`,
    };
  }

  const hash = await contentHash(file);
  const id = `local:${hash}:${file.size}`;
  const now = new Date().toISOString();

  const ref: AssetRef = {
    id,
    title: file.name.replace(/\.[^.]+$/, ''),
    source: 'local',
    author: opts.recordistName?.trim() || 'You (field recording)',
    licence: makeLicence('cc0'), // the student's own recording; editable in the inspector
    duration: 0,
    sampleRate: 0,
    channels: 0,
    importedAt: now,
    cached: false,
  };

  try {
    const entry = await assetStore.acquire(ref, { kind: 'blob', blob: file });
    return { ok: true, ref: entry.ref };
  } catch (err) {
    return {
      ok: false,
      name: file.name,
      reason: err instanceof Error ? err.message : 'Could not decode this file.',
    };
  }
}

/** Import many files (a whole recording-session folder). */
export async function importFiles(
  files: FileList | File[],
  opts: LocalImportOptions = {},
): Promise<{ imported: AssetRef[]; errors: LocalImportError[] }> {
  const list = Array.from(files);
  const imported: AssetRef[] = [];
  const errors: LocalImportError[] = [];
  let done = 0;
  for (const file of list) {
    opts.onProgress?.(done, list.length, file.name);
    const res = await importFile(file, opts);
    if (res.ok) imported.push(res.ref);
    else errors.push(res);
    done++;
    opts.onProgress?.(done, list.length, file.name);
  }
  return { imported, errors };
}

/** Pull File objects out of a drop event, descending into directories where supported. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = dt.items ? Array.from(dt.items) : [];
  const hasEntryApi = items.some((it) => typeof (it as unknown as { webkitGetAsEntry?: unknown }).webkitGetAsEntry === 'function');
  if (!hasEntryApi) return Array.from(dt.files);

  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej),
      );
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const entries = await new Promise<FileSystemEntry[]>((res, rej) =>
        reader.readEntries(res, rej),
      );
      for (const e of entries) await walk(e);
    }
  };

  for (const it of items) {
    const entry = (it as unknown as { webkitGetAsEntry(): FileSystemEntry | null }).webkitGetAsEntry();
    if (entry) await walk(entry);
    else if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}
