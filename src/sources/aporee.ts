/*
 * Radio Aporee — geographic discovery via the Internet Archive mirror
 * (concept §4.3). Aporee has no API and asks not to be scripted; the whole map
 * mirrors daily to the `radio-aporee-maps` collection (~79,600 items).
 *
 * Query = an ABSOLUTE-VALUE bounding box (archive sign-strips lat/lon and
 * rejects negative literals — see the note on `absRanges` in geo.ts), then a
 * SIGNED haversine filter client-side to produce a true circle and drop
 * mirror-hemisphere false matches.
 */

import { parseLicence } from '../licence/model';
import { absRanges, boundingBox, haversineKm, type LatLon } from './geo';
import { _fetchWithRetry as fetchWithRetry } from './archive';
import type { SearchPage, SoundResult } from './types';

const ADVANCED_SEARCH = 'https://archive.org/advancedsearch.php';
const COLLECTION = 'radio-aporee-maps';
export const RADIUS_CHOICES_KM = [1, 5, 10, 50, 100] as const;

interface RawDoc {
  identifier: string;
  title?: string | string[];
  creator?: string | string[];
  latitude?: string;
  longitude?: string;
  licenseurl?: string;
  date?: string;
  description?: string | string[];
  subject?: string | string[];
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export interface AporeeSearchOptions {
  page?: number;
  pageSize?: number;
  signal?: AbortSignal;
  /** hard cap on candidates pulled from the box before filtering */
  maxCandidates?: number;
}

export async function searchAporee(
  centre: LatLon,
  radiusKm: number,
  opts: AporeeSearchOptions = {},
): Promise<SearchPage> {
  const pageSize = opts.pageSize ?? 40;
  const page = opts.page ?? 1;
  const maxCandidates = opts.maxCandidates ?? 600;

  const box = boundingBox(centre, radiusKm);
  const r = absRanges(box);

  const q =
    `collection:${COLLECTION}` +
    ` AND latitude:[${fmt(r.latLo)} TO ${fmt(r.latHi)}]` +
    ` AND longitude:[${fmt(r.lonLo)} TO ${fmt(r.lonHi)}]`;

  const candidates: RawDoc[] = [];
  let archivePage = 1;
  const rows = 200;
  while (candidates.length < maxCandidates) {
    const params = new URLSearchParams();
    params.set('q', q);
    for (const f of [
      'identifier',
      'title',
      'creator',
      'latitude',
      'longitude',
      'licenseurl',
      'date',
      'description',
      'subject',
    ]) {
      params.append('fl[]', f);
    }
    params.set('rows', String(rows));
    params.set('page', String(archivePage));
    params.set('output', 'json');

    const res = await fetchWithRetry(`${ADVANCED_SEARCH}?${params}`, opts.signal);
    const json = (await res.json()) as {
      response?: { numFound: number; docs: RawDoc[] };
      error?: string;
    };
    if (json.error) throw new Error(`Aporee/Archive: ${json.error}`);
    const docs = json.response?.docs ?? [];
    candidates.push(...docs);
    const numFound = json.response?.numFound ?? 0;
    if (docs.length < rows || archivePage * rows >= numFound) break;
    archivePage++;
  }

  // SIGNED haversine against the real centre; abs-box also matched the mirror
  // hemisphere, so this is required, not a nicety.
  const withDistance = candidates
    .filter((d) => d.latitude != null && d.longitude != null)
    .map((d) => {
      const loc: LatLon = { lat: parseFloat(d.latitude!), lon: parseFloat(d.longitude!) };
      return { d, loc, km: haversineKm(centre, loc) };
    })
    .filter((x) => x.km <= radiusKm)
    .sort((a, b) => a.km - b.km);

  const total = withDistance.length;
  const start = (page - 1) * pageSize;
  const slice = withDistance.slice(start, start + pageSize);

  const results: SoundResult[] = slice.map(({ d, loc, km }) => ({
    id: `aporee:${d.identifier}`,
    source: 'aporee',
    title: first(d.title) ?? d.identifier,
    author: first(d.creator) ?? 'Unknown',
    duration: 0,
    licence: parseLicence(d.licenseurl),
    sourceUrl: `https://archive.org/details/${d.identifier}`,
    previewUrl: undefined, // resolved on import via resolveArchiveAudio
    waveformImageUrl: `https://archive.org/download/${d.identifier}/__ia_thumb.jpg`,
    location: { lat: loc.lat, lon: loc.lon, place: first(d.description) },
    distanceKm: km,
    nativeId: d.identifier,
    recordedAt: first(d.date),
    notes: Array.isArray(d.subject) ? d.subject.slice(0, 6).join(', ') : d.subject,
  }));

  return { results, total, page, pageSize, hasMore: start + pageSize < total };
}

function fmt(n: number): string {
  return n.toFixed(6);
}
