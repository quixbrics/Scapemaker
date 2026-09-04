/*
 * Internet Archive — archive material (concept §4.2). No key, no proxy.
 *  search:   advancedsearch.php
 *  detail:   /metadata/<identifier>
 *  audio:    direct file URLs under https://archive.org/download/<id>/<file>
 */

import { parseLicence } from '../licence/model';
import { emptyPage, type SearchPage, type SoundResult } from './types';

const ADVANCED_SEARCH = 'https://archive.org/advancedsearch.php';
const METADATA = 'https://archive.org/metadata/';
const DOWNLOAD = 'https://archive.org/download/';

const AUDIO_EXT = /\.(mp3|ogg|oga|flac|wav|m4a|aif|aiff)$/i;

interface RawDoc {
  identifier: string;
  title?: string | string[];
  creator?: string | string[];
  licenseurl?: string;
  date?: string;
  year?: string;
  subject?: string | string[];
  mediatype?: string;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export interface ArchiveSearchOptions {
  page?: number;
  pageSize?: number;
  /** restrict to the radio-aporee collection (used by aporee.ts) */
  collection?: string;
  /** raw extra query clause, already safe/encoded-free */
  extraQuery?: string;
  signal?: AbortSignal;
}

export async function searchArchive(
  text: string,
  opts: ArchiveSearchOptions = {},
): Promise<SearchPage> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 30;
  const clauses: string[] = [];
  if (opts.collection) clauses.push(`collection:${opts.collection}`);
  else clauses.push('mediatype:audio');
  if (text.trim()) clauses.push(`(${sanitiseText(text)})`);
  if (opts.extraQuery) clauses.push(opts.extraQuery);

  const params = new URLSearchParams();
  params.set('q', clauses.join(' AND '));
  for (const f of [
    'identifier',
    'title',
    'creator',
    'licenseurl',
    'date',
    'year',
    'subject',
    'mediatype',
  ]) {
    params.append('fl[]', f);
  }
  params.set('rows', String(pageSize));
  params.set('page', String(page));
  params.set('output', 'json');
  params.set('sort[]', 'downloads desc');

  const res = await fetchWithRetry(`${ADVANCED_SEARCH}?${params}`, opts.signal);
  const json = (await res.json()) as {
    response?: { numFound: number; docs: RawDoc[] };
    error?: string;
  };
  if (json.error) throw new Error(`Internet Archive: ${json.error}`);
  const docs = json.response?.docs ?? [];
  const total = json.response?.numFound ?? docs.length;

  const results: SoundResult[] = docs.map((d) => ({
    id: `archive:${d.identifier}`,
    source: 'archive',
    title: first(d.title) ?? d.identifier,
    author: first(d.creator) ?? 'Unknown',
    duration: 0,
    licence: parseLicence(d.licenseurl),
    sourceUrl: `https://archive.org/details/${d.identifier}`,
    nativeId: d.identifier,
    recordedAt: first(d.date) ?? d.year,
    notes: Array.isArray(d.subject) ? d.subject.slice(0, 6).join(', ') : d.subject,
  }));

  return {
    results,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
}

export interface ArchiveFile {
  name: string;
  url: string;
  format?: string;
  length?: number; // seconds
  size?: number;
}

/** Resolve the best playable audio file for an item. */
export async function resolveArchiveAudio(
  identifier: string,
  signal?: AbortSignal,
): Promise<ArchiveFile | null> {
  const res = await fetchWithRetry(`${METADATA}${identifier}`, signal);
  const json = (await res.json()) as {
    files?: Array<{ name: string; format?: string; length?: string; size?: string }>;
  };
  const files = json.files ?? [];
  const audio = files
    .filter((f) => AUDIO_EXT.test(f.name))
    .map((f) => ({
      name: f.name,
      url: `${DOWNLOAD}${identifier}/${encodeURIComponent(f.name)}`,
      format: f.format,
      length: f.length ? parseFloat(f.length) : undefined,
      size: f.size ? parseInt(f.size, 10) : undefined,
    }));
  if (audio.length === 0) return null;

  // Prefer VBR/derived MP3 (smallest to fetch), else the first audio file.
  const pref =
    audio.find((f) => /vbr mp3|mp3/i.test(f.format ?? '')) ??
    audio.find((f) => /\.mp3$/i.test(f.name)) ??
    audio[0];
  return pref;
}

function sanitiseText(text: string): string {
  // strip Lucene control characters that would break the query
  return text.replace(/[:[\]{}()^"~*?\\/]/g, ' ').replace(/\s+AND\s+|\s+OR\s+/gi, ' ').trim();
}

async function fetchWithRetry(url: string, signal?: AbortSignal, tries = 2): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error('Internet Archive request failed');
}

export { fetchWithRetry as _fetchWithRetry };
export function _emptyArchivePage(): SearchPage {
  return emptyPage();
}
