/*
 * "This recording is too long to hold in memory — which part do you want?"
 * The whole recording is drawn from its peak pyramid; a window over it,
 * dragged by its body or its edges, picks the section. Its length is capped
 * at what actually fits. Preview plays the start of the selection.
 */

import { h, timecode } from '../dom';
import { openDialog } from './base';
import { drawWaveform } from '../waveform';
import { formatBytes, type AssetEntry } from '../../audio/assetStore';
import { getAudioContext } from '../../audio/context';

export interface ExcerptRequest {
  title: string;
  full: AssetEntry;
  needBytes: number;
  maxSeconds: number;
  defaultSeconds: number;
}

/** Longest stretch Preview plays: enough to judge, short enough to not wait for. */
const PREVIEW_SECONDS = 20;
const MIN_LENGTH = 1;

/** "1 h 12 min", "18 min", "45 s" — lengths read aloud, not timecodes. */
function spoken(seconds: number): string {
  if (seconds >= 3600) {
    const hrs = Math.floor(seconds / 3600);
    const min = Math.round((seconds % 3600) / 60);
    return min ? `${hrs} h ${min} min` : `${hrs} h`;
  }
  if (seconds >= 90) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds)} s`;
}

/** Accepts "12:30", "1:02:30" or plain seconds. */
function parseTime(text: string): number | null {
  const parts = text.trim().split(':').map(Number);
  if (parts.length === 0 || parts.some((n) => !isFinite(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function chooseExcerpt(req: ExcerptRequest): Promise<{ start: number; duration: number } | null> {
  const total = req.full.buffer.duration;
  let start = 0;
  let length = Math.max(MIN_LENGTH, Math.min(req.defaultSeconds, req.maxSeconds, total));
  let preview: AudioBufferSourceNode | null = null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { start: number; duration: number } | null) => {
      if (settled) return;
      settled = true;
      stopPreview();
      observer.disconnect();
      resolve(value);
    };

    const canvas = h('canvas') as HTMLCanvasElement;
    const win = h(
      'div',
      { class: 'excerpt-window', 'aria-hidden': 'true' },
      h('span', { class: 'ew-edge l', 'data-edge': 'l' }),
      h('span', { class: 'ew-edge r', 'data-edge': 'r' }),
    );
    const overview = h('div', { class: 'excerpt-overview' }, canvas, win);
    const startInput = h('input', {
      class: 'excerpt-time',
      'aria-label': 'Excerpt start (minutes:seconds)',
    }) as HTMLInputElement;
    const lengthInput = h('input', {
      class: 'excerpt-time',
      'aria-label': 'Excerpt length (minutes:seconds)',
    }) as HTMLInputElement;
    const endEl = h('span', { class: 'mono' });
    const sizeEl = h('span', { class: 'muted' });
    const previewBtn = h('button', { class: 'btn', onclick: () => togglePreview() }, 'Preview') as HTMLButtonElement;

    const bytesPerSec = req.full.buffer.sampleRate * req.full.buffer.numberOfChannels * 4;
    const clamp = () => {
      length = Math.max(MIN_LENGTH, Math.min(length, req.maxSeconds, total));
      start = Math.max(0, Math.min(start, total - length));
    };
    const paint = () => {
      clamp();
      win.style.left = `${(start / total) * 100}%`;
      win.style.width = `${(length / total) * 100}%`;
      if (document.activeElement !== startInput) startInput.value = timecode(start, false);
      if (document.activeElement !== lengthInput) lengthInput.value = timecode(length, false);
      endEl.textContent = timecode(start + length, false);
      sizeEl.textContent = `about ${formatBytes(length * bytesPerSec)} in memory`;
    };

    const stopPreview = () => {
      try {
        preview?.stop();
      } catch {
        /* already ended */
      }
      preview = null;
      previewBtn.textContent = 'Preview';
    };
    const togglePreview = () => {
      if (preview) return stopPreview();
      const ctx = getAudioContext();
      void ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = req.full.buffer;
      src.connect(ctx.destination);
      src.onended = () => {
        if (preview === src) stopPreview();
      };
      src.start(0, start, Math.min(length, PREVIEW_SECONDS));
      preview = src;
      previewBtn.textContent = 'Stop';
    };

    // Drag the window's body to move it, its edges to resize; click elsewhere to centre it there.
    overview.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      stopPreview();
      const rect = overview.getBoundingClientRect();
      const toSec = (x: number) => ((x - rect.left) / rect.width) * total;
      const edge = (e.target as HTMLElement).dataset.edge;
      const onWindow = e.target === win || !!edge;
      if (!onWindow) {
        start = toSec(e.clientX) - length / 2;
        paint();
      }
      const t0 = toSec(e.clientX);
      const s0 = start;
      const l0 = length;
      const move = (ev: PointerEvent) => {
        const d = toSec(ev.clientX) - t0;
        if (edge === 'l') {
          const end = s0 + l0;
          start = Math.max(0, Math.max(end - req.maxSeconds, Math.min(s0 + d, end - MIN_LENGTH)));
          length = end - start;
        } else if (edge === 'r') {
          length = l0 + d;
        } else {
          start = s0 + d;
        }
        paint();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    const commitInput = (input: HTMLInputElement, apply: (v: number) => void) => {
      const v = parseTime(input.value);
      if (v != null) apply(v);
      input.blur();
      paint();
    };
    startInput.addEventListener('change', () => commitInput(startInput, (v) => (start = v)));
    lengthInput.addEventListener('change', () => commitInput(lengthInput, (v) => (length = v)));

    const handle = openDialog((close) =>
      h(
        'div',
        { class: 'dialog excerpt-dialog', role: 'dialog', 'aria-label': 'Keep part of this recording' },
        h('h3', {}, 'Keep part of this recording'),
        h(
          'p',
          {},
          `“${req.title}” is ${spoken(total)} long — about ${formatBytes(req.needBytes)} once decoded — ` +
            `and there is room for ${spoken(req.maxSeconds)}. Choose the part you want; the rest stays out of memory. ` +
            `The credit and licence stay exactly as they are.`,
        ),
        overview,
        h(
          'div',
          { class: 'excerpt-fields' },
          h('label', {}, 'Start', startInput),
          h('label', {}, 'Length', lengthInput),
          h('span', {}, 'ends ', endEl),
          sizeEl,
        ),
        h(
          'p',
          { class: 'muted' },
          'Drag the highlighted window, or its edges. Nothing is lost: the whole file stays cached, so you can take another section later.',
        ),
        h(
          'div',
          { class: 'row' },
          previewBtn,
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: () => { close(); finish(null); } }, 'Cancel'),
          h(
            'button',
            {
              class: 'btn primary',
              onclick: () => {
                clamp();
                // Tenths of a second: matches the id and title, and reads cleanly.
                const tenth = (v: number) => Math.round(v * 10) / 10;
                const duration = Math.min(tenth(length), req.maxSeconds);
                const range = { start: Math.min(tenth(start), total - duration), duration };
                close();
                finish(range);
              },
            },
            'Import excerpt',
          ),
        ),
      ),
    );

    // Escape or a click on the backdrop closes the dialog without a button:
    // treat the dialog leaving the page as a cancel.
    const observer = new MutationObserver(() => {
      if (!handle.root.isConnected) finish(null);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    paint();
    requestAnimationFrame(() => {
      const pxPerSec = (canvas.clientWidth || 1) / total;
      drawWaveform(canvas, req.full.peaks, 0, total, pxPerSec, {
        hueToken: '--accent',
        fillAlpha: 0.25,
        strokeAlpha: 0.8,
      });
    });
  });
}
