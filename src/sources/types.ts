/*
 * SoundResult — the single shape all four sources normalise to. Written before
 * any adapter (Build Plan §8.1). The discovery UI renders SoundResult and never
 * touches a source-specific payload.
 */

import type { GeoLocation, Licence, SourcePlatform } from '../state/project';

export interface SoundResult {
  /** unique within a result set; also used as the AssetId when imported */
  id: string;
  source: SourcePlatform;
  title: string;
  author: string;
  duration: number; // seconds; 0 if unknown until decode
  licence: Licence;
  /** canonical human page for attribution */
  sourceUrl?: string;
  /** direct media URL to fetch + decode; absent means "download and drag in" */
  previewUrl?: string;
  /** pre-rendered waveform image (aporee) — instant thumbnail before fetch */
  waveformImageUrl?: string;
  location?: GeoLocation;
  /** distance from the map pin in km, when produced by a radius search */
  distanceKm?: number;
  recordedAt?: string;
  /** source id in its own system (Freesound sound id, IA identifier) */
  nativeId?: string;
  /** extra metadata for the inspector, free-form */
  notes?: string;
}

export interface SearchPage<T = SoundResult> {
  results: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export function emptyPage<T = SoundResult>(pageSize = 30): SearchPage<T> {
  return { results: [], total: 0, page: 1, pageSize, hasMore: false };
}
