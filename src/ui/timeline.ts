/*
 * Timeline: toolbar, ruler (tick spacing DERIVED from project.duration, never
 * hardcoded — UI spec §4.4), canvas track lanes with contour waveforms, and
 * pointer interaction: select, move, trim, split, duplicate, delete, with snap.
 */

import { store, type AppState, type PendingImport } from '../state/store';
import { transport } from '../audio/transport';
import { assetStore } from '../audio/assetStore';
import { drawWaveform } from './waveform';
import { clear, h, svgIcon, timecode, fmtDb, fmtCoord } from './dom';
import { tt } from './tooltip';
import { onThemeChange } from './theme';
import { licenceShort, licenceTone } from '../licence/model';
import {
  moveClip,
  moveClipWithCrossfade,
  trimClip,
  splitClipAtPlayhead,
  setTrackGain,
  toggleMute,
  toggleSolo,
  renameTrack,
  addTrack,
  placeAsset,
} from '../state/edits';
import {
  getLane,
  setAutomationView,
  toggleLane,
  addAutomationPoint,
  moveAutomationPoint,
  removeAutomationPoint,
} from '../state/effectEdits';
import { evaluateAt } from '../audio/automation';
import { AUTOMATION_PARAMS, AUTOMATION_PARAM_LIST, toUnit, fromUnit } from './automationParams';
import type { AutomationParam, Clip, Track } from '../state/project';

const HEAD_W = 178;
const CLIP_HEAD_H = 15;

export class Timeline {
  readonly el: HTMLElement;
  private lanesScroll!: HTMLElement;
  private rulerTrack!: HTMLElement;
  private playheadEl!: HTMLElement;
  private zoomInput!: HTMLInputElement;
  private countEl!: HTMLElement;
  private rafPlayhead = 0;
  private unsubTheme: () => void;

  constructor() {
    this.el = h('div', { class: 'centre' });
    this.buildToolbar();
    this.buildRuler();
    this.buildLanes();
    this.unsubTheme = onThemeChange(() => this.renderLanes(store.get()));
    store.subscribe((s, changed) => {
      if (changed.has('project') || changed.has('ui')) {
        this.renderToolbar(s);
        this.renderRuler(s);
        this.renderLanes(s);
      } else if (changed.has('pendingImports')) {
        // progress ticks arrive rapidly during a fetch — just the lanes, not
        // the toolbar/ruler too.
        this.renderLanes(s);
      }
      if (changed.has('transport')) this.positionPlayhead(s);
    });
    this.loopPlayhead();
  }

  dispose(): void {
    this.unsubTheme();
    cancelAnimationFrame(this.rafPlayhead);
  }

  // ---- toolbar ----
  private toolbar!: HTMLElement;
  private buildToolbar(): void {
    this.toolbar = h('div', { class: 'tl-toolbar' });
    this.el.append(this.toolbar);
    this.renderToolbar(store.get());
  }

  private renderToolbar(s: AppState): void {
    clear(this.toolbar);
    const tool = s.ui.tool;
    const mk = (id: string, icon: string, title: string, sub: string) =>
      h(
        'button',
        {
          class: `tool${tool === id ? ' active' : ''}`,
          ...tt(title, sub),
          onclick: () => store.patchUi({ tool: id as AppState['ui']['tool'] }),
        },
        svgIcon(icon, 15),
      );

    const group = h(
      'div',
      { class: 'toolgroup' },
      mk('select', 'c-cursor', 'Select', 'V'),
      mk('trim', 'c-trim', 'Trim', 'Drag a clip edge — T'),
      mk('split', 'c-split', 'Split at playhead', 'Cmd/Ctrl + K'),
      mk('crossfade', 'c-fade', 'Crossfade', 'Overlap two clips to blend them — F'),
    );

    const snap = h(
      'button',
      {
        class: `toggle${s.ui.snap ? ' on' : ''}`,
        ...tt('Snap to grid', 'Clips land on ruler divisions while dragging.'),
        onclick: () => store.patchUi({ snap: !s.ui.snap }),
      },
      h('span', { class: 'knob' }),
    );

    const nEmpty = s.project.tracks.filter((t) => t.clips.length).length;
    const nClips = s.project.tracks.reduce((n, t) => n + t.clips.length, 0);
    this.countEl = h('span', { class: 'mono-cap' }, `${nEmpty} OF ${s.project.tracks.length} TRACKS · ${nClips} CLIPS`);

    this.zoomInput = h('input', {
      type: 'range',
      min: '2',
      max: '40',
      step: '1',
      value: String(s.project.view.zoom),
      oninput: (e) => {
        const zoom = Number((e.target as HTMLInputElement).value);
        store.mutateProject((p) => (p.view.zoom = zoom), { markDirty: false });
      },
    }) as HTMLInputElement;

    this.toolbar.append(
      group,
      h('div', { class: 'vrule' }),
      snap,
      h('span', { class: 'mini-label' }, 'Snap'),
      h('div', { class: 'spacer' }),
      this.countEl,
      h('div', { class: 'zoom' }, h('span', { class: 'mono-cap' }, 'ZOOM'), this.zoomInput),
      h(
        'button',
        { class: 'tool', ...tt('Add track', `Up to 8 tracks`), onclick: () => addTrack() },
        svgIcon('c-plus', 14),
      ),
    );
  }

  // ---- ruler ----
  private buildRuler(): void {
    this.rulerTrack = h('div', { class: 'ruler-track', onpointerdown: (e) => this.scrubFromRuler(e as PointerEvent) });
    this.el.append(h('div', { class: 'ruler' }, h('div', { class: 'ruler-gutter' }), this.rulerTrack));
    this.renderRuler(store.get());
  }

  private tickInterval(duration: number): number {
    // aim for ~10-14 labels across the span
    const targets = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    for (const t of targets) if (duration / t <= 14) return t;
    return 900;
  }

  private renderRuler(s: AppState): void {
    clear(this.rulerTrack);
    const dur = s.project.duration;
    const step = this.tickInterval(dur);
    for (let t = 0; t <= dur + 0.001; t += step) {
      const pct = (t / dur) * 100;
      this.rulerTrack.append(
        h('div', { class: 'tick', style: `left:${pct}%` }),
        h('div', { class: 'tick-label', style: `left:${pct}%` }, timecode(t, false)),
      );
    }
    this.playheadEl = h('div', { class: 'playhead', style: 'left:0%' });
    this.rulerTrack.append(this.playheadEl);
    this.positionPlayhead(s);
  }

  private scrubFromRuler(e: PointerEvent): void {
    const rect = this.rulerTrack.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    transport.seek(frac * store.get().project.duration);
  }

  // ---- lanes ----
  private buildLanes(): void {
    this.lanesScroll = h('div', { class: 'lanes-scroll' });
    const wrap = h('div', { class: 'lanes-wrap' }, this.lanesScroll);
    this.el.append(wrap);
    this.buildMasterPlaceholder();
    this.renderLanes(store.get());
  }

  private masterHost!: HTMLElement;
  private buildMasterPlaceholder(): void {
    this.masterHost = h('div');
    this.el.append(this.masterHost);
  }
  getMasterHost(): HTMLElement {
    return this.masterHost;
  }

  private renderLanes(s: AppState): void {
    const scrollTop = this.lanesScroll.scrollTop;
    clear(this.lanesScroll);
    const pxPerSec = s.project.view.zoom;
    const bodyWidth = () => this.lanesScroll.clientWidth - HEAD_W;

    for (const track of s.project.tracks) {
      this.lanesScroll.append(this.renderLane(s, track, pxPerSec, bodyWidth()));
    }

    // playhead across lanes
    const ph = h('div', { class: 'playhead', style: `left:${HEAD_W}px` });
    ph.dataset.lanes = '1';
    this.lanesScroll.append(ph);
    this.lanesScroll.scrollTop = scrollTop;
    this.positionPlayhead(s);
  }

  private renderLane(s: AppState, track: Track, pxPerSec: number, bodyW: number): HTMLElement {
    const selected = s.ui.selection.trackId === track.id;
    const hue = `var(--track-${track.index + 1})`;
    const auto = s.ui.automationView?.trackId === track.id ? s.ui.automationView : null;

    const autoToggle = h(
      'button',
      {
        class: 'ms',
        ...tt('Automation', 'Draw a curve for gain, pan, EQ or reverb over time'),
        onclick: () => setAutomationView(track.id, 'gain'),
      },
      'A',
    );

    const head = h(
      'div',
      { class: 'lane-head', style: `--track-hue:${hue}` },
      h(
        'div',
        { class: 'h-top' },
        h('span', { class: 'h-num' }, String(track.index + 1).padStart(2, '0')),
        h('input', {
          class: 'h-name',
          value: track.name,
          onchange: (e) => renameTrack(track.id, (e.target as HTMLInputElement).value),
          onpointerdown: (e) => e.stopPropagation(),
        }),
      ),
      auto
        ? this.automationHeadRow(track, auto.param)
        : h(
            'div',
            { class: 'h-ctl' },
            h(
              'button',
              { class: `ms${track.muted ? ' on' : ''}`, ...tt('Mute'), onclick: () => toggleMute(track.id) },
              'M',
            ),
            h(
              'button',
              { class: `ms solo${track.solo ? ' on' : ''}`, ...tt('Solo'), onclick: () => toggleSolo(track.id) },
              'S',
            ),
            autoToggle,
            this.gainSlider(track),
            h('span', { class: 'h-db' }, fmtDb(track.gain)),
          ),
    );

    const body = h('div', { class: 'lane-body' });
    body.addEventListener('pointerdown', (e) => this.onLaneBodyDown(e, track));
    body.addEventListener('dragover', (e) => e.preventDefault());
    body.addEventListener('drop', (e) => this.onLaneDrop(e as DragEvent, track));

    for (const clip of track.clips) {
      body.append(this.renderClip(s, track, clip, pxPerSec, bodyW));
    }
    for (const pending of s.pendingImports) {
      if (pending.trackId === track.id) body.append(this.renderPendingClip(s, pending));
    }
    if (auto) body.append(this.automationOverlay(s, track, auto.param));

    const lane = h(
      'div',
      { class: `lane${selected ? ' sel-track' : ''}`, 'data-track': track.id },
      head,
      body,
    );
    lane.addEventListener('pointerdown', () => {
      if (s.ui.selection.trackId !== track.id) {
        store.patchUi({ selection: { trackId: track.id, clipId: s.ui.selection.clipId } });
      }
    });
    return lane;
  }

  private automationHeadRow(track: Track, param: AutomationParam): HTMLElement {
    const lane = getLane(track, param);
    const meta = AUTOMATION_PARAMS[param];
    return h(
      'div',
      { class: 'h-ctl auto-row' },
      h('span', { class: 'mono-cap' }, 'AUTOMATION'),
      h(
        'select',
        {
          class: 'auto-select',
          onchange: (e) => setAutomationView(track.id, (e.target as HTMLSelectElement).value as AutomationParam),
        },
        ...AUTOMATION_PARAM_LIST.map((p) => h('option', { value: p, selected: p === param }, AUTOMATION_PARAMS[p].label)),
      ),
      h(
        'button',
        {
          class: `toggle${lane?.enabled ? ' on' : ''}`,
          ...tt('Enable', lane?.enabled ? 'Curve is applied on playback and export' : `Draw a point to enable — range ${meta.format(meta.min)} to ${meta.format(meta.max)}`),
          onclick: () => toggleLane(track.id, param),
        },
        h('span', { class: 'knob' }),
      ),
      h('button', { class: 'linkish', style: 'margin-left:auto;font-size:10px', onclick: () => setAutomationView(track.id, null) }, 'close'),
    );
  }

  private automationOverlay(s: AppState, track: Track, param: AutomationParam): HTMLElement {
    const dur = s.project.duration || 1;
    const meta = AUTOMATION_PARAMS[param];
    const lane = getLane(track, param);
    const points = lane?.points ?? [];

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 1000 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'auto-svg');

    if (points.length > 0) {
      const N = 200;
      const pts: string[] = [];
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * dur;
        const v = evaluateAt(points, t);
        const x = (t / dur) * 1000;
        const y = 100 - toUnit(param, v) * 100;
        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly.setAttribute('points', pts.join(' '));
      poly.setAttribute('class', 'auto-poly');
      poly.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(poly);
    }

    const overlay = h('div', { class: `auto-overlay${lane?.enabled === false ? ' dim' : ''}` }, svg);

    // click empty overlay space to add a point
    overlay.addEventListener('dblclick', (e) => {
      const rect = overlay.getBoundingClientRect();
      const time = ((e.clientX - rect.left) / rect.width) * dur;
      const unit = 1 - (e.clientY - rect.top) / rect.height;
      addAutomationPoint(track.id, param, {
        time: Math.max(0, time),
        value: fromUnit(param, unit),
        interpolation: 'linear',
      });
    });

    // handles
    points.forEach((p, i) => {
      const x = (p.time / dur) * 100;
      const y = 100 - toUnit(param, p.value) * 100;
      const handle = h('div', {
        class: 'auto-handle',
        style: `left:${x}%;top:${y}%`,
        ...tt(meta.format(p.value), `${timecode(p.time, false)} — drag to move, double-click to remove`),
      });
      handle.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        removeAutomationPoint(track.id, param, i);
      });
      handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const rect = overlay.getBoundingClientRect();
        const move = (ev: PointerEvent) => {
          const time = Math.max(0, ((ev.clientX - rect.left) / rect.width) * dur);
          const unit = 1 - (ev.clientY - rect.top) / rect.height;
          moveAutomationPoint(track.id, param, i, time, fromUnit(param, unit));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      overlay.append(handle);
    });

    return overlay;
  }

  private gainSlider(track: Track): HTMLElement {
    const pct = ((track.gain + 60) / 66) * 100; // -60..+6 dB
    const wrap = h(
      'div',
      { class: 'h-slider' },
      h('span', { class: 'fill', style: `width:${Math.max(0, Math.min(100, pct))}%` }),
      h('input', {
        type: 'range',
        min: '-60',
        max: '6',
        step: '0.5',
        value: String(track.gain),
        oninput: (e) => setTrackGain(track.id, Number((e.target as HTMLInputElement).value)),
        onpointerdown: (e) => e.stopPropagation(),
      }),
    );
    return wrap;
  }

  /**
   * Placeholder shown where an import will land while it resolves, fetches
   * and decodes — so a slow file reads as "in progress here", not "did my
   * click even register". Removed the instant the real clip appears.
   */
  private renderPendingClip(s: AppState, pending: PendingImport): HTMLElement {
    const dur = s.project.duration || 1;
    const leftPct = (pending.start / dur) * 100;
    const widthPct = (pending.duration / dur) * 100;

    const phaseLabel =
      pending.phase === 'resolving' ? 'Locating file…' : pending.phase === 'decoding' ? 'Decoding…' : 'Fetching…';
    const pct = pending.fraction >= 0 ? Math.round(pending.fraction * 100) : null;

    const fill = h('div', {
      class: `pending-fill${pct == null ? ' indeterminate' : ''}`,
      style: pct != null ? `width:${pct}%` : '',
    });

    return h(
      'div',
      { class: 'clip pending', style: `left:${leftPct}%;width:${Math.max(widthPct, 6)}%` },
      h('div', { class: 'clip-head' }, h('span', { class: 'c-name' }, pending.title)),
      h('div', { class: 'pending-track' }, fill),
      h('div', { class: 'pending-label' }, pct != null ? `${phaseLabel} ${pct}%` : phaseLabel),
    );
  }

  private renderClip(
    s: AppState,
    track: Track,
    clip: Clip,
    pxPerSec: number,
    bodyW: number,
  ): HTMLElement {
    const dur = s.project.duration;
    const leftPct = (clip.start / dur) * 100;
    const widthPct = (clip.duration / dur) * 100;
    const ref = s.project.assets[clip.assetId];
    const hue = track.index + 1;
    const tone = ref ? licenceTone(ref.licence) : 'unknown';
    const restricted = tone !== 'ok';

    const style =
      `left:${leftPct}%;width:${widthPct}%;` +
      `--clip-bg:color-mix(in srgb, var(--track-${hue}) 8%, transparent);` +
      `--clip-border:color-mix(in srgb, var(--track-${hue}) 45%, var(--bg));` +
      `--clip-head:color-mix(in srgb, var(--track-${hue}) 14%, transparent);` +
      `--clip-label:var(--track-${hue}-label)`;

    const selected = s.ui.selection.clipId === clip.id;
    const canvas = h('canvas') as HTMLCanvasElement;

    const headBits: (HTMLElement | string)[] = [h('span', { class: 'c-name' }, ref?.title ?? 'Clip')];
    if (restricted && ref) {
      headBits.push(
        h(
          'span',
          {
            class: 'c-lic',
            style: `color:var(--${tone === 'warn' ? 'warn' : 'text-muted'})`,
            ...tt(
              tone === 'warn' ? `${ref.licence.name} — restricted` : 'Licence unknown',
              'You can hand this in, but a soundscape built from it cannot be published publicly.',
            ),
          },
          licenceShort(ref.licence),
        ),
      );
    }
    if (ref?.location) {
      headBits.push(h('span', { class: 'c-coord' }, fmtCoord(ref.location.lat, ref.location.lon)));
    }

    const fadeWedges: HTMLElement[] = [];
    if (clip.fadeIn.duration > 0) {
      const w = Math.min(100, (clip.fadeIn.duration / clip.duration) * 100);
      fadeWedges.push(
        h('div', {
          class: 'fade-wedge in',
          style: `width:${w}%;background:linear-gradient(90deg, var(--bg), transparent)`,
          ...tt('Fade in', `${clip.fadeIn.curve === 'equalPower' ? 'Equal-power' : 'Linear'} — ${clip.fadeIn.duration.toFixed(2)}s`),
        }),
      );
    }
    if (clip.fadeOut.duration > 0) {
      const w = Math.min(100, (clip.fadeOut.duration / clip.duration) * 100);
      fadeWedges.push(
        h('div', {
          class: 'fade-wedge out',
          style: `width:${w}%;background:linear-gradient(270deg, var(--bg), transparent)`,
          ...tt('Fade out', `${clip.fadeOut.curve === 'equalPower' ? 'Equal-power' : 'Linear'} — ${clip.fadeOut.duration.toFixed(2)}s`),
        }),
      );
    }

    const el = h(
      'div',
      { class: `clip${selected ? ' sel' : ''}`, style, 'data-clip': clip.id },
      h('div', { class: 'clip-head' }, ...headBits),
      canvas,
      ...fadeWedges,
      h('div', { class: 'trim-handle l', 'data-edge': 'start' }),
      h('div', { class: 'trim-handle r', 'data-edge': 'end' }),
    );

    // paint waveform after layout
    requestAnimationFrame(() => {
      const peaks = assetStore.getPeaks(clip.assetId);
      if (!peaks) return;
      canvas.style.width = '100%';
      canvas.style.height = `calc(100% - ${CLIP_HEAD_H}px)`;
      drawWaveform(canvas, peaks, clip.sourceOffset, clip.duration, pxPerSec, {
        hueToken: `--track-${hue}`,
        fillAlpha: 0.2,
        strokeAlpha: 0.8,
      });
    });

    el.addEventListener('pointerdown', (e) => this.onClipDown(e, track, clip, bodyW));
    return el;
  }

  // ---- interaction ----
  private onLaneBodyDown(e: PointerEvent, track: Track): void {
    if ((e.target as HTMLElement).closest('.clip')) return;
    // click empty lane space: seek + select track
    const body = e.currentTarget as HTMLElement;
    const rect = body.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    transport.seek(frac * store.get().project.duration);
    store.patchUi({ selection: { trackId: track.id, clipId: null } });
  }

  private onLaneDrop(e: DragEvent, track: Track): void {
    e.preventDefault();
    const assetId = e.dataTransfer?.getData('application/x-scapemaker-asset');
    if (!assetId) return;
    const ref = store.get().project.assets[assetId] ?? assetStore.peek(assetId)?.ref;
    if (!ref) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    placeAsset(ref, track.id, this.snap(frac * store.get().project.duration));
  }

  private snap(seconds: number): number {
    if (!store.get().ui.snap) return Math.max(0, seconds);
    const step = this.tickInterval(store.get().project.duration) / 4;
    return Math.max(0, Math.round(seconds / step) * step);
  }

  private onClipDown(e: PointerEvent, track: Track, clip: Clip, bodyW: number): void {
    e.stopPropagation();
    store.patchUi({ selection: { trackId: track.id, clipId: clip.id } });

    const tool = store.get().ui.tool;
    const edge = (e.target as HTMLElement).dataset.edge as 'start' | 'end' | undefined;
    const dur = store.get().project.duration;
    const pxPerSec = bodyW / dur;
    const startX = e.clientX;
    const originStart = clip.start;

    if (tool === 'split') {
      transport.seek(originStart + clip.duration / 2);
      splitClipAtPlayhead();
      return;
    }

    const mode: 'move' | 'trim-start' | 'trim-end' =
      tool === 'crossfade'
        ? 'move'
        : edge === 'start' || (tool === 'trim' && this.nearLeft(e))
          ? 'trim-start'
          : edge === 'end' || tool === 'trim'
            ? 'trim-end'
            : 'move';

    const clipEl = e.currentTarget as HTMLElement;
    const move = (ev: PointerEvent) => {
      const dxSec = (ev.clientX - startX) / pxPerSec;
      if (mode === 'move') {
        if (Math.abs(ev.clientX - startX) >= 3) clipEl.classList.add('dragging');
        clipEl.style.left = `${((this.snap(originStart + dxSec) / dur) * 100).toFixed(3)}%`;
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      clipEl.classList.remove('dragging');
      const dxSec = (ev.clientX - startX) / pxPerSec;
      if (Math.abs(ev.clientX - startX) < 3 && mode === 'move') return; // pure click
      if (mode === 'move' && tool === 'crossfade') {
        moveClipWithCrossfade(track.id, clip.id, this.snap(originStart + dxSec));
      } else if (mode === 'move') {
        // possible cross-track move
        const overLane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.lane') as HTMLElement | null;
        const targetTrackId = overLane?.dataset.track ?? track.id;
        moveClip(track.id, clip.id, this.snap(originStart + dxSec), targetTrackId);
      } else {
        trimClip(track.id, clip.id, mode === 'trim-start' ? 'start' : 'end', dxSec);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private nearLeft(e: PointerEvent): boolean {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX - r.left < r.width / 2;
  }

  // ---- playhead ----
  private positionPlayhead(s: AppState): void {
    const dur = s.project.duration || 1;
    const frac = Math.min(1, Math.max(0, s.transport.playhead / dur));
    if (this.playheadEl) this.playheadEl.style.left = `${(frac * 100).toFixed(4)}%`;
    if (!this.lanesScroll) return;
    const laneHead = this.lanesScroll.querySelector<HTMLElement>('.playhead[data-lanes]');
    if (laneHead) {
      const bodyW = this.lanesScroll.clientWidth - HEAD_W;
      laneHead.style.left = `${HEAD_W + frac * bodyW}px`;
    }
  }

  private loopPlayhead(): void {
    const step = () => {
      this.positionPlayhead(store.get());
      this.rafPlayhead = requestAnimationFrame(step);
    };
    this.rafPlayhead = requestAnimationFrame(step);
  }
}
