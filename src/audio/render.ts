/*
 * Offline render — mixdown + stems (concept §10, Build Plan §6.6).
 * Rebuilds the ENTIRE graph inside an OfflineAudioContext from the SAME
 * builder used for live playback (non-negotiable #8). S4 / tests/render-null
 * is the guard that these two paths agree.
 */

import type { Project } from '../state/project';
import { contentEnd, SAMPLE_RATE } from '../state/project';
import { assetStore } from './assetStore';
import { buildGraph } from './graph';

export interface RenderOptions {
  /** seconds; defaults to content end + 1 s tail */
  duration?: number;
  onProgress?: (fraction: number) => void;
  onlyTrackId?: string;
  sampleRate?: number;
}

function OfflineCtor(): typeof OfflineAudioContext {
  return (
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext
  );
}

export async function renderProject(
  project: Project,
  opts: RenderOptions = {},
): Promise<AudioBuffer> {
  const sr = opts.sampleRate ?? SAMPLE_RATE;
  const duration = opts.duration ?? Math.max(contentEnd(project) + 1, 1);
  const frames = Math.ceil(duration * sr);
  const Ctor = OfflineCtor();
  const ctx = new Ctor(2, frames, sr);

  buildGraph(ctx, project, (id) => assetStore.getBuffer(id), {
    timeOrigin: 0,
    playFrom: 0,
    playTo: duration,
    destination: ctx.destination,
    withAnalyser: false,
    onlyTrackId: opts.onlyTrackId,
  });

  // OfflineAudioContext has no progress event; approximate with a timer that we
  // clear when rendering resolves.
  let done = false;
  if (opts.onProgress) {
    const started = performance.now();
    const estMs = Math.max(400, duration * 120); // rough
    const poll = () => {
      if (done) return;
      opts.onProgress!(Math.min(0.98, (performance.now() - started) / estMs));
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }

  const rendered = await ctx.startRendering();
  done = true;
  opts.onProgress?.(1);
  return rendered;
}

export interface StemRender {
  trackId: string;
  trackName: string;
  buffer: AudioBuffer;
}

export async function renderStems(
  project: Project,
  opts: RenderOptions = {},
): Promise<StemRender[]> {
  const out: StemRender[] = [];
  const tracks = project.tracks.filter((t) => t.clips.length > 0);
  let i = 0;
  for (const track of tracks) {
    const buffer = await renderProject(project, {
      ...opts,
      onlyTrackId: track.id,
      onProgress: (f) => opts.onProgress?.((i + f) / tracks.length),
    });
    out.push({ trackId: track.id, trackName: track.name, buffer });
    i++;
  }
  return out;
}
