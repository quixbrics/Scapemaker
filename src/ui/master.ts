/*
 * Master strip (UI spec §4.6): MASTER · Peak / RMS / Integrated, then the summed
 * waveform with the clipping heatmap and the clipping banner at the worst
 * offence. NON-NEGOTIABLE: the Peak readout and the banner must agree — both
 * come from the same analysis.
 */

import { store } from '../state/store';
import { isInteracting } from './interaction';
import { transport } from '../audio/transport';
import { renderProject } from '../audio/render';
import { analyseBuffer, readLiveMeter, type BufferAnalysis } from '../audio/analysis';
import { drawMasterWaveform } from './waveform';
import { clear, h, timecode, fmtDb } from './dom';
import { tt } from './tooltip';
import { tokenAlpha } from './theme';
import { contentEnd } from '../state/project';
import { setMasterGain } from '../state/edits';

const HEAD_W = 178;
/** Long enough that a run of small edits analyses once, short enough to feel live. */
const ANALYSIS_DEBOUNCE_MS = 400;

/**
 * Run when the browser is not busy, but never later than `timeout`.
 * requestIdleCallback is absent in Safari <16.4, so fall back to a timer.
 */
function whenIdle(fn: () => void, timeout = 1500): void {
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (ric) ric(fn, { timeout });
  else setTimeout(fn, 0);
}

export class MasterStrip {
  readonly el: HTMLElement;
  private headEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private raf = 0;
  private analysis: BufferAnalysis | null = null;
  private analysing = false;
  private lastSig = '';
  /** the signature still owed an analysis, or null when the meters are current */
  private wantedSig: string | null = null;
  private queued: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.el = h('div', { class: 'master' });
    this.headEl = h('div', { class: 'master-head' });
    this.bodyEl = h('div', { class: 'master-body' });
    this.canvas = h('canvas') as HTMLCanvasElement;
    this.bodyEl.append(this.canvas);
    this.el.append(this.headEl, this.bodyEl);
    this.renderHead(-Infinity, -Infinity, null);
    store.subscribe((_s, changed) => {
      if (changed.has('project')) {
        this.scheduleAnalysis();
        this.syncFader();
      }
    });
    this.scheduleAnalysis();
    this.loop();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    if (this.queued) clearTimeout(this.queued);
  }

  /**
   * What the meters actually depend on. Anything outside this (a rename, a
   * selection, the reflection text) must not trigger a re-render of the mix.
   */
  private analysisSignature(p: ReturnType<typeof store.get>['project']): string {
    return JSON.stringify({
      master: p.masterGain,
      tracks: p.tracks.map((t) => ({
        g: t.gain,
        m: t.muted,
        s: t.solo,
        pan: t.pan,
        eq: t.eq,
        rv: t.reverb,
        a: t.automation,
        c: t.clips,
      })),
    });
  }

  /**
   * Analysing the mix means rendering the WHOLE project offline, which on a
   * three-minute eight-track piece is seconds of CPU. So: debounce, never
   * start while the transport is running or a gesture is in flight, and wait
   * for an idle moment.
   *
   * `wantedSig` is the signature still owed an analysis. The previous version
   * wrote lastSig before bailing on an in-flight render, so a change arriving
   * mid-analysis was recorded as done and never analysed — the readouts then
   * described the second-to-last state until something else was edited.
   */
  private scheduleAnalysis(): void {
    const p = store.get().project;
    const sig = this.analysisSignature(p);
    if (sig === this.lastSig) return;
    this.wantedSig = sig;

    if (contentEnd(p) < 0.1) {
      this.lastSig = sig;
      this.analysis = null;
      this.renderHead(-Infinity, -Infinity, null);
      this.paintHeat();
      return;
    }
    if (this.analysing) return; // the in-flight run will pick up wantedSig
    this.queueAnalysis();
  }

  private queueAnalysis(): void {
    if (this.queued) clearTimeout(this.queued);
    this.queued = setTimeout(() => {
      this.queued = null;
      whenIdle(() => void this.runAnalysis());
    }, ANALYSIS_DEBOUNCE_MS);
  }

  private async runAnalysis(): Promise<void> {
    if (this.analysing) return;
    // Never compete with the audio thread or a drag.
    if (store.get().transport.playing || isInteracting()) {
      this.queueAnalysis();
      return;
    }
    const sig = this.wantedSig;
    if (sig === null || sig === this.lastSig) return;

    this.analysing = true;
    try {
      const buf = await renderProject(store.get().project, {});
      this.analysis = analyseBuffer(buf);
      this.lastSig = sig;
      this.paintOffline(buf);
    } catch {
      /* leave last analysis */
    } finally {
      this.analysing = false;
    }
    // The project moved on while we were rendering; go round again.
    if (this.wantedSig !== this.lastSig) this.queueAnalysis();
  }

  private paintOffline(buf: AudioBuffer): void {
    const cols = Math.max(2, Math.floor(this.canvas.clientWidth));
    const env = new Float32Array(cols * 2);
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    const per = buf.length / cols;
    for (let i = 0; i < cols; i++) {
      let mn = 1;
      let mx = -1;
      const s0 = Math.floor(i * per);
      const s1 = Math.floor((i + 1) * per);
      for (let s = s0; s < s1; s++) {
        const v = (ch0[s] + ch1[s]) * 0.5;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      env[i * 2] = mn;
      env[i * 2 + 1] = mx;
    }
    drawMasterWaveform(this.canvas, env, cols);
    this.paintHeat();
    if (this.analysis) {
      this.renderHead(this.analysis.peakDb, this.analysis.rmsDb, this.analysis.integratedLufs);
    }
  }

  private paintHeat(): void {
    // remove old heat overlays + banner
    this.bodyEl.querySelectorAll('.heat, .clip-banner, .m-playhead').forEach((n) => n.remove());
    const a = this.analysis;
    const totalDur = Math.max(contentEnd(store.get().project), 0.001);
    if (a) {
      for (const bkt of a.heat) {
        if (bkt.level === 'ok') continue;
        const alpha = bkt.level === 'warn6' ? 0.2 : bkt.level === 'warn3' ? 0.24 : 0.3;
        const colour =
          bkt.level === 'clip' ? tokenAlpha('--danger', alpha) : tokenAlpha('--warn', alpha);
        const left = (bkt.t0 / totalDur) * 100;
        const w = ((bkt.t1 - bkt.t0) / totalDur) * 100;
        this.bodyEl.append(
          h('div', {
            class: 'heat',
            style: `position:absolute;top:13px;height:60px;left:${left}%;width:${Math.max(0.4, w)}%;background:${colour}`,
          }),
        );
      }
      if (a.clipped && a.worstAt != null) {
        const left = Math.min(72, (a.worstAt / totalDur) * 100);
        this.bodyEl.append(
          h(
            'div',
            {
              class: 'clip-banner',
              style: `left:${left}%`,
              ...tt(
                `Clipping at ${timecode(a.worstAt, false)}`,
                `The mix goes above 0 dB here and will distort. Pull down the loudest track, or lower the master.`,
              ),
            },
            h('span', {}, `Audio clipped — reduce levels`),
          ),
        );
      }
    }
    // playhead
    const frac = store.get().transport.playhead / Math.max(store.get().project.duration, 1);
    this.bodyEl.append(
      h('div', {
        class: 'm-playhead',
        style: `position:absolute;top:13px;bottom:10px;left:${(frac * 100).toFixed(3)}%;width:1px;background:var(--accent)`,
      }),
    );
  }

  /**
   * Built once and kept alive: it is a range input, so rebuilding the head
   * around it mid-drag would replace the very control under the pointer.
   */
  private masterFader(): HTMLElement {
    if (this.faderEl) return this.faderEl;
    const toPct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 66) * 100));
    const gain = () => store.get().project.masterGain ?? 0;
    const fill = h('span', { class: 'fill', style: `width:${toPct(gain())}%` });
    const readout = h('span', { class: 'h-db' }, fmtDb(gain()));
    const input = h('input', {
      type: 'range',
      min: '-60',
      max: '6',
      step: '0.5',
      value: String(gain()),
      'aria-label': 'Master gain, decibels',
      'aria-valuetext': `${fmtDb(gain())} dB`,
      oninput: (e) => {
        const target = e.target as HTMLInputElement;
        const db = Number(target.value);
        fill.style.width = `${toPct(db)}%`;
        readout.textContent = fmtDb(db);
        target.setAttribute('aria-valuetext', `${fmtDb(db)} dB`);
        setMasterGain(db);
      },
    }) as HTMLInputElement;

    this.faderInput = input;
    this.faderFill = fill;
    this.faderReadout = readout;
    this.faderEl = h(
      'div',
      {
        class: 'm-row master-fader',
        ...tt('Master', 'Trims the whole mix, after every track. Pull this down if the mix is clipping.'),
      },
      h('div', { class: 'h-slider' }, fill, input),
      readout,
    );
    return this.faderEl;
  }

  private faderEl: HTMLElement | null = null;
  private faderInput: HTMLInputElement | null = null;
  private faderFill: HTMLElement | null = null;
  private faderReadout: HTMLElement | null = null;

  /** Keep the fader in step with undo/redo, without fighting an active drag. */
  private syncFader(): void {
    if (!this.faderInput || document.activeElement === this.faderInput || isInteracting()) return;
    const db = store.get().project.masterGain ?? 0;
    this.faderInput.value = String(db);
    this.faderInput.setAttribute('aria-valuetext', `${fmtDb(db)} dB`);
    if (this.faderFill) this.faderFill.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 66) * 100))}%`;
    if (this.faderReadout) this.faderReadout.textContent = fmtDb(db);
  }

  private renderHead(peakDb: number, rmsDb: number, lufs: number | null): void {
    clear(this.headEl);
    const peakCls = peakDb >= 0 ? 'danger' : peakDb >= -3 ? 'warn' : '';
    const fmt = (v: number, unit: string) => (isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} ${unit}` : `—`);
    this.headEl.append(
      h('span', { class: 'section-label' }, 'MASTER'),
      row('Peak', fmt(peakDb, 'dB'), peakCls),
      row('RMS', fmt(rmsDb, 'dB'), ''),
      h(
        'div',
        {
          class: 'm-row',
          ...tt('Integrated loudness', 'Average perceived loudness of the whole mix. Broadcast delivery is usually −23 LUFS.'),
        },
        h('span', {}, 'Integrated'),
        h('span', { class: 'm-val mono' }, lufs == null ? '—' : `${lufs.toFixed(1)} LUFS`),
      ),
      this.masterFader(),
    );
    this.syncFader();
  }

  private loop(): void {
    const step = () => {
      const an = transport.getAnalyser();
      if (an && store.get().transport.playing) {
        const m = readLiveMeter(an);
        this.renderHead(m.peakDb, m.rmsDb, this.analysis?.integratedLufs ?? null);
      }
      // move master playhead line
      const ph = this.bodyEl.querySelector<HTMLElement>('.m-playhead');
      if (ph) {
        const frac = store.get().transport.playhead / Math.max(store.get().project.duration, 1);
        ph.style.left = `${(frac * 100).toFixed(3)}%`;
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
}

function row(label: string, value: string, cls: string): HTMLElement {
  return h('div', { class: 'm-row' }, h('span', {}, label), h('span', { class: `m-val mono ${cls}` }, value));
}

void HEAD_W;
