/*
 * Freesound APIv2 — OPTIONAL, called directly from the browser with the
 * student's own key (concept §4.1). No proxy, no app key.
 *
 * NON-NEGOTIABLE #4: the app is fully usable with no key.
 * NON-NEGOTIABLE #5: never cache or persist Freesound responses. The key lives
 * in localStorage; results live in memory for the session only.
 *
 * Quota efficiency (§6.8): one search returns up to 150 results WITH preview
 * URLs. Always request the fields we need and import from results — never fetch
 * sounds one at a time except for paste-a-URL.
 */

import { parseLicence } from '../licence/model';
import type { SearchPage, SoundResult } from './types';

const API = 'https://freesound.org/apiv2';
const KEY_STORAGE = 'scapemaker.freesound.key';
const FIELDS = 'id,name,username,duration,license,previews,url,tags,created';

export class FreesoundRateLimitError extends Error {
  constructor() {
    super(
      "Freesound's rate limit reached — wait a minute, or download the file " +
        'from freesound.org and drag it in.',
    );
    this.name = 'FreesoundRateLimitError';
  }
}

// --- key storage (localStorage, try/catch — lab machines may block it) -------

let memKey: string | null = null;

export function getKey(): string | null {
  if (memKey) return memKey;
  try {
    memKey = localStorage.getItem(KEY_STORAGE);
  } catch {
    memKey = null;
  }
  return memKey;
}

export function hasKey(): boolean {
  return !!getKey();
}

export function setKey(key: string): void {
  memKey = key.trim();
  try {
    localStorage.setItem(KEY_STORAGE, memKey);
  } catch {
    /* session-only fallback */
  }
}

export function forgetKey(): void {
  memKey = null;
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

// --- requests --------------------------------------------------------------

interface RawSound {
  id: number;
  name: string;
  username: string;
  duration: number;
  license: string;
  url: string;
  previews?: {
    'preview-hq-mp3'?: string;
    'preview-lq-mp3'?: string;
    'preview-hq-ogg'?: string;
    'preview-lq-ogg'?: string;
  };
  tags?: string[];
  created?: string;
}

function authHeaders(): HeadersInit {
  const key = getKey();
  if (!key) throw new Error('No Freesound key set.');
  return { Authorization: `Token ${key}` };
}

async function apiGet(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: authHeaders(), signal });
  if (res.status === 429) throw new FreesoundRateLimitError();
  if (res.status === 401 || res.status === 403) {
    throw new Error('Freesound rejected the key. Re-check it in the Freesound tab.');
  }
  if (!res.ok) throw new Error(`Freesound request failed (${res.status}).`);
  return res;
}

function toResult(s: RawSound): SoundResult {
  const preview =
    s.previews?.['preview-hq-mp3'] ??
    s.previews?.['preview-hq-ogg'] ??
    s.previews?.['preview-lq-mp3'] ??
    s.previews?.['preview-lq-ogg'];
  return {
    id: `freesound:${s.id}`,
    source: 'freesound',
    title: s.name,
    author: s.username,
    duration: s.duration ?? 0,
    licence: parseLicence(s.license),
    sourceUrl: s.url,
    previewUrl: preview,
    nativeId: String(s.id),
    recordedAt: s.created,
    notes: s.tags?.slice(0, 8).join(', '),
  };
}

/** Validate a key with one trivial search (concept §4.1.2). */
export async function validateKey(key: string, signal?: AbortSignal): Promise<boolean> {
  const prev = memKey;
  memKey = key.trim();
  try {
    const res = await fetch(`${API}/search/text/?query=rain&page_size=1&fields=id`, {
      headers: { Authorization: `Token ${memKey}` },
      signal,
    });
    if (res.status === 429) throw new FreesoundRateLimitError();
    return res.ok;
  } finally {
    memKey = prev;
  }
}

export interface FreesoundSearchOptions {
  page?: number;
  pageSize?: number;
  signal?: AbortSignal;
}

export async function searchFreesound(
  query: string,
  opts: FreesoundSearchOptions = {},
): Promise<SearchPage> {
  const page = opts.page ?? 1;
  const pageSize = Math.min(opts.pageSize ?? 30, 150);
  const res = await apiGet(
    '/search/text/',
    {
      query,
      page: String(page),
      page_size: String(pageSize),
      fields: FIELDS,
      filter: 'type:(wav OR aiff OR flac OR mp3 OR ogg)',
    },
    opts.signal,
  );
  const json = (await res.json()) as { count: number; results: RawSound[] };
  const results = json.results.map(toResult);
  return {
    results,
    total: json.count,
    page,
    pageSize,
    hasMore: page * pageSize < json.count,
  };
}

// --- paste-a-URL ----------------------------------------------------------

export interface ParsedFreesoundUrl {
  soundId: string;
  username?: string;
}

/** Parse `/people/<username>/sounds/<id>/` or `/s/<id>/` (concept §4.5). */
export function parseFreesoundUrl(input: string): ParsedFreesoundUrl | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)freesound\.org$/.test(u.hostname)) return null;

  const people = u.pathname.match(/\/people\/([^/]+)\/sounds\/(\d+)/);
  if (people) return { username: decodeURIComponent(people[1]), soundId: people[2] };

  const short = u.pathname.match(/\/s\/(\d+)/);
  if (short) return { soundId: short[1] };

  const generic = u.pathname.match(/\/sounds\/(\d+)/);
  if (generic) return { soundId: generic[1] };

  return null;
}

/**
 * Resolve a pasted URL. If a key is present we fetch full metadata (1 request).
 * If not, we still recover author + id + source URL from the URL itself with
 * ZERO API calls — the download-and-drag path (concept §4.5). The caller then
 * asks the student to pick a licence from a dropdown.
 */
export interface ResolvedPaste {
  result: SoundResult;
  needsLicenceChoice: boolean;
  usedApi: boolean;
}

export async function resolveFreesoundUrl(
  input: string,
  signal?: AbortSignal,
): Promise<ResolvedPaste> {
  const parsed = parseFreesoundUrl(input);
  if (!parsed) throw new Error('That does not look like a Freesound sound URL.');

  if (hasKey()) {
    const res = await apiGet(`/sounds/${parsed.soundId}/`, { fields: FIELDS }, signal);
    const s = (await res.json()) as RawSound;
    return { result: toResult(s), needsLicenceChoice: false, usedApi: true };
  }

  const result: SoundResult = {
    id: `freesound:${parsed.soundId}`,
    source: 'freesound',
    title: `Freesound sound ${parsed.soundId}`,
    author: parsed.username ?? 'Unknown',
    duration: 0,
    licence: parseLicence(undefined), // unknown until the student chooses
    sourceUrl: parsed.username
      ? `https://freesound.org/people/${encodeURIComponent(parsed.username)}/sounds/${parsed.soundId}/`
      : `https://freesound.org/s/${parsed.soundId}/`,
    previewUrl: undefined,
    nativeId: parsed.soundId,
  };
  return { result, needsLicenceChoice: true, usedApi: false };
}
