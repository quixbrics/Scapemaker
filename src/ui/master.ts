/*
 * Master strip (UI spec §4.6): MASTER · Peak / RMS / Integrated, then the summed
 * waveform with the clipping heatmap and the clipping banner at the worst
 * offence. NON-NEGOTIABLE: the Peak readout and the banner must agree — both
 * come from the same analysis.
 */

import { store } from '../state/store';
import { transport } from '../audio/transport';
import { renderProject } from '../audio/render';
import { analyseBuffer, readLiveMeter, type BufferAnalysis } from '../audio/analysis';
import { drawMasterWaveform } from './waveform';
import { clear, h, timecode } from './dom';
import { tt } from './tooltip';
import { tokenAlpha } from './theme';
import { contentEnd } from '../state/project';

const HEAD_W = 178;

export class MasterStrip {
  readonly el: HTMLElement;
  private headEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private raf = 0;
  private analysis: BufferAnalysis | null = null;
  private analysing = false;
  private lastSig = '';

  constructor() {
    this.el = h('div', { class: 'master' });
    this.headEl = h('div', { class: 'master-head' });
    this.bodyEl = h('div', { class: 'master-body' });
    this.canvas = h('canvas') as HTMLCanvasElement;
    this.bodyEl.append(this.canvas);
    this.el.append(this.headEl, this.bodyEl);
    this.renderHead(-Infinity, -Infinity, null);
    store.subscribe((_s, changed) => {
      if (changed.has('project')) this.scheduleAnalysis();
    });
    this.scheduleAnalysis();
    this.loop();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }

  private scheduleAnalysis(): void {
    const p = store.get().project;
    const sig = JSON.stringify(p.tracks.map((t) => ({ g: t.gain, m: t.muted, s: t.solo, c: t.clips })));
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    if (contentEnd(p) < 0.1) {
      this.analysis = null;
      this.renderHead(-Infinity, -Infinity, null);
      this.paintHeat();
      return;
    }
    if (this.analysing) return;
    this.analysing = true;
    window.setTimeout(async () => {
      try {
        const buf = await renderProject(store.get().project, {});
        this.analysis = analyseBuffer(buf);
        this.paintOffline(buf);
      } catch {
        /* leave last analysis */
      } finally {
        this.analysing = false;
      }
    }, 250);
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
    );
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
