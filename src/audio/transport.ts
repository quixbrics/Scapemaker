/*
 * Transport: play / stop / seek / loop. The playhead is derived from
 * AudioContext.currentTime (Build Plan §4.5) — never setInterval. A rAF loop
 * reads the clock and pushes the position into the store for the UI.
 */

import { getAudioContext, onFirstResume } from './context';
import { buildGraph, type LiveGraph } from './graph';
import { assetStore } from './assetStore';
import { store } from '../state/store';
import { contentEnd } from '../state/project';

class Transport {
  private graph: LiveGraph | null = null;
  private startCtxTime = 0;
  private startPlayhead = 0;
  private rafId = 0;
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  get playing(): boolean {
    return store.get().transport.playing;
  }

  play(): void {
    if (this.playing) return;
    const ctx = getAudioContext();
    if (ctx.state === 'running') {
      this.startPlayback();
    } else {
      // First gesture: resume, then start once the clock is live.
      void ctx.resume().then(() => this.startPlayback());
      onFirstResume(() => {
        if (!this.playing) this.startPlayback();
      });
    }
  }

  private startPlayback(): void {
    if (this.playing) return;
    const ctx = getAudioContext();
    const { project, transport } = store.get();

    const from = transport.playhead;
    const end = transport.looping && transport.loopEnd > transport.loopStart
      ? transport.loopEnd
      : Math.max(contentEnd(project), project.duration);

    const timeOrigin = ctx.currentTime + 0.06 - from; // small lookahead
    this.graph = buildGraph(ctx, project, (id) => assetStore.getBuffer(id), {
      timeOrigin,
      playFrom: from,
      playTo: end,
      withAnalyser: true,
      destination: ctx.destination,
    });

    this.startCtxTime = ctx.currentTime + 0.06;
    this.startPlayhead = from;
    store.patchTransport({ playing: true });

    const stopAt = (end - from) * 1000;
    this.endTimer = setTimeout(() => this.onReachedEnd(), Math.max(0, stopAt));
    this.tick();
  }

  private onReachedEnd(): void {
    const { transport } = store.get();
    if (transport.looping && transport.loopEnd > transport.loopStart) {
      this.stopGraph();
      store.patchTransport({ playhead: transport.loopStart });
      this.startPlayback();
    } else {
      this.stop();
      store.patchTransport({ playhead: this.currentPosition() });
    }
  }

  stop(): void {
    this.stopGraph();
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    cancelAnimationFrame(this.rafId);
    if (this.playing) {
      store.patchTransport({ playing: false, playhead: this.currentPosition() });
    }
  }

  /** Stop and return the playhead to the loop start (or zero). */
  goToStart(): void {
    const { transport } = store.get();
    this.stop();
    store.patchTransport({
      playhead: transport.looping ? transport.loopStart : 0,
    });
  }

  seek(seconds: number): void {
    const wasPlaying = this.playing;
    this.stop();
    store.patchTransport({ playhead: Math.max(0, seconds) });
    if (wasPlaying) this.play();
  }

  toggleLoop(): void {
    const { transport, project } = store.get();
    const looping = !transport.looping;
    let { loopStart, loopEnd } = transport;
    if (looping && loopEnd <= loopStart) {
      loopStart = 0;
      loopEnd = Math.max(contentEnd(project), 8);
    }
    store.patchTransport({ looping, loopStart, loopEnd });
  }

  setLoopRegion(start: number, end: number): void {
    store.patchTransport({ loopStart: Math.max(0, start), loopEnd: Math.max(start + 0.1, end) });
  }

  getAnalyser(): AnalyserNode | null {
    return this.graph?.analyser ?? null;
  }

  private currentPosition(): number {
    if (!this.playing) return store.get().transport.playhead;
    const ctx = getAudioContext();
    return this.startPlayhead + (ctx.currentTime - this.startCtxTime);
  }

  private stopGraph(): void {
    this.graph?.stop();
    this.graph = null;
  }

  private tick = (): void => {
    if (!this.playing) return;
    const pos = this.currentPosition();
    store.patchTransport({ playhead: pos });
    this.rafId = requestAnimationFrame(this.tick);
  };
}

export const transport = new Transport();
