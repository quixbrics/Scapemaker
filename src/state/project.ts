/*
 * Core data model — everything follows from it. The `.scapemaker` file is this
 * object serialised as JSON and contains NO audio: assets are referenced by
 * source URL and resolved from the IndexedDB cache (or re-downloaded) on load.
 */

export const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export const MAX_TRACKS = 8;
export const SAMPLE_RATE = 48_000 as const;

export type AssetId = string; // stable, content-derived where possible

export type LicenceId =
  | 'cc0'
  | 'by'
  | 'by-sa'
  | 'by-nc'
  | 'by-nd'
  | 'by-nc-sa'
  | 'by-nc-nd'
  | 'pd'
  | 'sampling+'
  | 'unknown';

export interface Licence {
  id: LicenceId;
  name: string; // "CC BY-NC-ND 3.0"
  url?: string;
  requiresAttribution: boolean;
  allowsDerivatives: boolean; // false for any -nd
  allowsCommercial: boolean; // false for any -nc
  allowsRedistribution: boolean;
}

export type SourcePlatform = 'local' | 'freesound' | 'archive' | 'aporee';

export interface GeoLocation {
  lat: number;
  lon: number;
  place?: string;
}

export interface AssetRef {
  // metadata only — never audio, never a buffer
  id: AssetId;
  title: string;
  source: SourcePlatform;
  sourceId?: string; // Freesound sound id, IA identifier
  sourceUrl?: string; // canonical page URL, for attribution
  downloadUrl?: string; // direct media URL, may rot
  author: string;
  licence: Licence;
  duration: number;
  sampleRate: number;
  channels: number;
  location?: GeoLocation;
  recordedAt?: string;
  importedAt: string;
  cached: boolean; // present in IndexedDB
  /** true once the user has seen and accepted a restrictive-licence warning */
  restrictionAcknowledged?: boolean;
}

export type FadeCurve = 'linear' | 'equalPower';

export interface Fade {
  duration: number;
  curve: FadeCurve;
}

export interface ClipLoop {
  enabled: boolean;
  count: number;
  crossfade: number; // seconds of loop-boundary crossfade
}

export interface Clip {
  id: string;
  assetId: AssetId; // a VIEW onto the asset — never owns audio
  start: number; // position on the timeline, seconds
  sourceOffset: number; // offset into the asset, seconds
  duration: number; // played length, seconds
  gain: number; // dB
  fadeIn: Fade;
  fadeOut: Fade;
  loop?: ClipLoop;
}

export type AutomationParam =
  | 'gain'
  | 'pan'
  | 'eq.low'
  | 'eq.lowMid'
  | 'eq.mid'
  | 'eq.highMid'
  | 'eq.high'
  | 'reverb.wet';

export type Interpolation = 'linear' | 'smooth' | 'bezier';

export interface AutomationPoint {
  time: number;
  value: number;
  interpolation: Interpolation;
  cp?: { x: number; y: number }; // bezier control point
}

export interface AutomationLane {
  param: AutomationParam;
  points: AutomationPoint[]; // sorted by time — invariant enforced on write
  enabled: boolean;
}

export interface EqBand {
  frequency: number;
  gain: number; // dB
  q: number;
}

export interface EqSettings {
  enabled: boolean;
  bands: [EqBand, EqBand, EqBand, EqBand, EqBand]; // lowShelf, peaking x3, highShelf
}

export type ReverbPreset =
  | 'forest'
  | 'tunnel'
  | 'hall'
  | 'street'
  | 'cathedral'
  | 'industrial'
  | 'custom';

export interface ReverbSettings {
  enabled: boolean;
  preset: ReverbPreset;
  size: number; // 0..1
  decay: number; // seconds
  wet: number; // 0..1
  dry: number; // 0..1
}

export interface Track {
  id: string;
  index: number; // 0-7, drives the fixed colour
  name: string;
  clips: Clip[];
  gain: number; // dB
  pan: number; // -1..1
  muted: boolean;
  solo: boolean;
  eq?: EqSettings;
  reverb?: ReverbSettings;
  automation: AutomationLane[];
}

export interface Reflection {
  atmosphere: string;
  narrative: string;
  emotional: string;
  location: string;
  decisions: string;
}

export interface ProjectView {
  zoom: number; // pixels per second
  scrollX: number; // seconds
  theme: 'dark' | 'light';
}

export interface Project {
  schemaVersion: SchemaVersion;
  id: string;
  name: string;
  createdAt: string; // ISO
  modifiedAt: string;
  duration: number; // seconds — drives the ruler; never hardcode tick spacing
  sampleRate: typeof SAMPLE_RATE;
  tracks: Track[]; // max 8
  assets: Record<AssetId, AssetRef>;
  reflection: Reflection;
  view: ProjectView;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function uid(prefix = 'id'): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rnd}`;
}

const DEFAULT_TRACK_NAMES = [
  'Track 1',
  'Track 2',
  'Track 3',
  'Track 4',
  'Track 5',
  'Track 6',
  'Track 7',
  'Track 8',
];

export function emptyReflection(): Reflection {
  return { atmosphere: '', narrative: '', emotional: '', location: '', decisions: '' };
}

export function defaultEq(): EqSettings {
  return {
    enabled: false,
    bands: [
      { frequency: 80, gain: 0, q: 0.7 }, // low shelf
      { frequency: 250, gain: 0, q: 1.0 }, // low mid
      { frequency: 1000, gain: 0, q: 1.0 }, // mid
      { frequency: 4000, gain: 0, q: 1.0 }, // upper mid
      { frequency: 12000, gain: 0, q: 0.7 }, // high shelf
    ],
  };
}

export function defaultReverb(): ReverbSettings {
  return { enabled: false, preset: 'street', size: 0.34, decay: 0.9, wet: 0.18, dry: 1 };
}

export function makeTrack(index: number, name?: string): Track {
  return {
    id: uid('trk'),
    index,
    name: name ?? DEFAULT_TRACK_NAMES[index] ?? `Track ${index + 1}`,
    clips: [],
    gain: 0,
    pan: 0,
    muted: false,
    solo: false,
    automation: [],
  };
}

export function makeClip(assetId: AssetId, start: number, duration: number): Clip {
  return {
    id: uid('clp'),
    assetId,
    start,
    sourceOffset: 0,
    duration,
    gain: 0,
    fadeIn: { duration: 0, curve: 'equalPower' },
    fadeOut: { duration: 0, curve: 'equalPower' },
  };
}

export function newProject(name = 'Untitled soundscape'): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uid('prj'),
    name,
    createdAt: now,
    modifiedAt: now,
    duration: 180, // 3:00 default; grows as clips are added
    sampleRate: SAMPLE_RATE,
    tracks: Array.from({ length: 4 }, (_, i) => makeTrack(i)),
    assets: {},
    reflection: emptyReflection(),
    view: { zoom: 6, scrollX: 0, theme: 'dark' },
  };
}

// ---------------------------------------------------------------------------
// Migration hook — from day one, even though there is only one version.
// ---------------------------------------------------------------------------

export interface MigrationResult {
  project: Project;
  migratedFrom?: number;
  warnings: string[];
}

export function migrate(raw: unknown): MigrationResult {
  const warnings: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Not a ScapeMaker project file.');
  }
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 0;

  if (version > SCHEMA_VERSION) {
    warnings.push(
      `This project was saved by a newer version of ScapeMaker (schema ${version}). ` +
        `Some settings may not load correctly.`,
    );
  }

  // No prior versions exist yet. When schema 2 lands, transform here:
  // if (version < 2) { ...; obj.schemaVersion = 2; }

  const project = obj as unknown as Project;
  // Defensive backfill for fields added after initial authoring.
  project.schemaVersion = SCHEMA_VERSION;
  for (const track of project.tracks ?? []) {
    track.automation ??= [];
    for (const clip of track.clips ?? []) {
      clip.fadeIn ??= { duration: 0, curve: 'equalPower' };
      clip.fadeOut ??= { duration: 0, curve: 'equalPower' };
    }
  }
  project.reflection ??= emptyReflection();
  project.view ??= { zoom: 6, scrollX: 0, theme: 'dark' };

  return { project, migratedFrom: version === SCHEMA_VERSION ? undefined : version, warnings };
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** Latest clip end across all tracks, in seconds. */
export function contentEnd(project: Project): number {
  let end = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.start + clip.duration);
    }
  }
  return end;
}

/** Project duration is at least the content end, rounded up to a tidy value. */
export function fitDuration(project: Project): number {
  const end = contentEnd(project);
  const min = Math.max(60, Math.ceil((end + 15) / 30) * 30);
  return Math.max(project.duration, min);
}
