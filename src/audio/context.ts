/*
 * Singleton AudioContext. Browsers require a user gesture before audio can
 * start, so the context is created lazily and resumed on the first gesture.
 */

import { SAMPLE_RATE } from '../state/project';

let ctx: AudioContext | null = null;
const resumeHandlers: Array<() => void> = [];

export function getAudioContext(): AudioContext {
  if (!ctx) {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  }
  return ctx;
}

/** Wire once at boot: any pointer/key gesture resumes a suspended context. */
export function installResumeOnGesture(): void {
  const resume = () => {
    const c = getAudioContext();
    if (c.state === 'suspended') {
      void c.resume().then(() => {
        for (const h of resumeHandlers.splice(0)) h();
      });
    }
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
    window.addEventListener(ev, resume, { passive: true });
  }
}

export function onFirstResume(fn: () => void): void {
  const c = getAudioContext();
  if (c.state === 'running') fn();
  else resumeHandlers.push(fn);
}

export function now(): number {
  return getAudioContext().currentTime;
}
