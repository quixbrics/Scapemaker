/*
 * Timeline: toolbar, ruler (tick spacing DERIVED from project.duration, never
 * hardcoded — UI spec §4.4), canvas track lanes with contour waveforms, and
 * pointer interaction: select, move, trim, razor, duplicate, delete, with snap.
 *
 * Every drag leaves the clip where it is (dimmed) and draws a GHOST where it
 * will land — in whichever lane the pointer is over — with a readout of the
 * new time or length. Nothing is committed until the pointer comes up, and
 * Escape throws the whole gesture away.
 */

import { store, type AppState, type PendingImport } from '../state/store';
import { isInteracting, onGestureEnd } from './interaction';
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
  duplicateClipTo,
  trimClip,
  splitClipAt,
  splitAllAt,
  setTrackGain,
  toggleMute,
  toggleSolo,
  renameTrack,
  addTrack,
  removeTrack,
  placeAsset,
} from '../state/edits';
import {
  getLane,
  setAutomationView,
  toggleLane,
  addAutomationPoint,
  moveAutomationPoint,
  removeAutomationPoint,
  snapshotAutomation,
  commitAutomationGesture,
} from '../state/effectEdits';
import { evaluateAt } from '../audio/automation';
import { AUTOMATION_PARAMS, AUTOMATION_PARAM_LIST, toUnit, fromUnit } from './automationParams';
import { contentEnd, loopSpan, type AutomationParam, type Clip, type Track } from '../state/project';
import { dragLoopClip, loopCountForSpan } from '../state/edits';
import { importResultToTimeline, cancelImport, placeLibraryAsset } from '../sources/importResult';
import { importFiles } from '../sources/local';
import { registerDropTarget, type DragMods, type LibraryPayload } from './dnd';
import { MemoryMeter } from './memoryMeter';
import { openShortcutSheet } from './dialogs/shortcuts';

const HEAD_W = 178;
const CLIP_HEAD_H = 15;

/** Pixels per second at either end of the zoom range. */
export const ZOOM_MIN = 2;
export const ZOOM_MAX = 120;
/** The zoom slider is logarithmic: every step looks like the same amount of zoom. */
const SLIDER_STEPS = 1000;
const zoomToSlider = (z: number) =>
  Math.round((Math.log(z / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * SLIDER_STEPS);
const sliderToZoom = (v: number) => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, v / SLIDER_STEPS);
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** How close (px) an edge has to come to another before it clicks onto it. */
const SNAP_PX = 8;
/** Movement (px) before a press on a clip becomes a drag. */
const DRAG_THRESHOLD = 3;
/** Width (px) of the band at each side of the lanes that scrolls during a drag. */
const EDGE_SCROLL_PX = 48;

/** Tools that only appear in Advanced. */
const ADVANCED_TOOLS = new Set(['crossfade', 'loop']);

export class Timeline {
  readonly el: HTMLElement;
  private lanesScroll!: HTMLElement;
  private lanesInner!: HTMLElement;
  private rulerTrack!: HTMLElement;
  private rulerViewport!: HTMLElement;
  private playheadEl!: HTMLElement;
  private zoomInput!: HTMLInputElement;
  private countEl!: HTMLElement;
  private rafPlayhead = 0;
  private unsubTheme: () => void;
  private lastSig = '';
  private lastProjectId = '';

  constructor() {
    this.el = h('div', { class: 'centre' });
    this.buildToolbar();
    this.buildRuler();
    this.buildLanes();
    registerDropTarget({
      hover: (x, y, payload, mods) => this.libraryHover(x, y, payload, mods),
      leave: () => this.hideGuides(),
      drop: (x, y, payload, mods) => this.libraryDrop(x, y, payload, mods),
    });
    this.unsubTheme = onThemeChange(() => this.renderLanes(store.get()));
    this.lastSig = this.laneSignature(store.get());
    this.lastProjectId = store.get().project.id;
    assetStore.subscribe(() => {
      for (const paint of this.unpainted) if (paint()) this.unpainted.delete(paint);
    });
    store.subscribe((s, changed) => {
      if (changed.has('project') && s.project.id !== this.lastProjectId) {
        this.lastProjectId = s.project.id;
        // A different project: put the view back where it was saved.
        requestAnimationFrame(() => {
          this.lanesScroll.scrollLeft = s.project.view.scrollX * this.pxPerSec(s);
        });
      }
      if (changed.has('project') || changed.has('ui')) {
        this.renderToolbar(s);
        // Only tear the lanes down when their STRUCTURE actually changed.
        // Rebuilding on every ui patch detached the clip element mid-drag —
        // onClipDown patches the selection on its first line, so the drag
        // preview was updating a node that was no longer in the document
        // (the move still landed on release, which is why it looked like
        // "the outline doesn't work" rather than "dragging is broken").
        const sig = this.laneSignature(s);
        if (sig !== this.lastSig && !isInteracting()) {
          this.lastSig = sig;
          this.renderRuler(s);
          this.renderLanes(s);
        } else if (sig !== this.lastSig) {
          // mid-gesture (a fader drag): the control updates its own readout;
          // rebuild once the pointer is released.
          onGestureEnd('timeline:lanes', () => {
            const now = store.get();
            this.lastSig = this.laneSignature(now);
            this.renderRuler(now);
            this.renderLanes(now);
          });
        } else {
          this.applySelection(s);
        }
      } else if (changed.has('pendingImports')) {
        this.lastSig = this.laneSignature(s);
        this.renderLanes(s);
      }
      if (changed.has('transport')) this.positionPlayhead(s);
    });
    this.loopPlayhead();
  }

  /**
   * Everything a lane's DOM depends on EXCEPT the selection — if this is
   * unchanged, a selection change is just a class swap.
   */
  private laneSignature(s: AppState): string {
    return JSON.stringify({
      d: s.project.duration,
      z: s.project.view.zoom,
      // Basic hides the automation button, so the lanes must rebuild on a
      // mode switch.
      m: s.ui.mode,
      av: s.ui.automationView,
      p: s.pendingImports.map((x) => [x.trackId, x.start, x.duration, x.phase, Math.round(x.fraction * 50)]),
      t: s.project.tracks.map((t) => [
        t.id,
        t.name,
        t.gain,
        t.muted,
        t.solo,
        t.automation,
        t.clips.map((c) => [c.id, c.assetId, c.start, c.duration, c.gain, c.fadeIn, c.fadeOut, c.loop]),
      ]),
    });
  }

  /** Selection-only update: swap classes in place, keep every node alive. */
  private applySelection(s: AppState): void {
    const { trackId, clipId } = s.ui.selection;
    for (const lane of this.lanesScroll.querySelectorAll<HTMLElement>('.lane')) {
      lane.classList.toggle('sel-track', lane.dataset.track === trackId);
    }
    for (const clipEl of this.lanesScroll.querySelectorAll<HTMLElement>('.clip')) {
      clipEl.classList.toggle('sel', clipEl.dataset.clip === clipId);
    }
  }

  dispose(): void {
    this.unsubTheme();
    cancelAnimationFrame(this.rafPlayhead);
  }

  // ---- toolbar ----
  // Built ONCE. Rebuilding it on every store change replaced the zoom slider
  // on its own first input event, so a zoom drag died after one step.
  private toolbar!: HTMLElement;
  private toolButtons = new Map<string, HTMLElement>();
  private snapBtn!: HTMLElement;

  private buildToolbar(): void {
    this.toolbar = h('div', { class: 'tl-toolbar' });
    this.el.append(this.toolbar);

    const s = store.get();
    const mk = (id: string, icon: string, title: string, sub: string) => {
      const btn = h(
        'button',
        {
          class: 'tool',
          ...tt(title, sub),
          onclick: () => store.patchUi({ tool: id as AppState['ui']['tool'] }),
        },
        svgIcon(icon, 15),
      );
      this.toolButtons.set(id, btn);
      return btn;
    };

    const group = h(
      'div',
      { class: 'toolgroup' },
      mk('select', 'c-cursor', 'Select — V', 'Drag to move · Option/Alt-drag to copy · drag an edge to trim'),
      mk('trim', 'c-trim', 'Trim — T', 'Drag either half of a clip to trim that edge'),
      mk('split', 'c-razor', 'Razor — C', 'Click a clip to cut it there · Shift-click cuts every track'),
      mk('crossfade', 'c-fade', 'Crossfade — F', 'Overlap two clips to blend them'),
      mk('loop', 'c-loop', 'Loop — R', 'Drag a clip’s edge to repeat it for as long as you drag'),
    );

    this.snapBtn = h(
      'button',
      {
        class: 'toggle',
        ...tt('Snap — S', 'Edges click onto other clips, the playhead and the ruler. Hold Cmd/Ctrl while dragging to ignore it.'),
        onclick: () => store.patchUi({ snap: !store.get().ui.snap }),
      },
      h('span', { class: 'knob' }),
    );

    this.countEl = h('span', { class: 'mono-cap' });

    this.zoomInput = h('input', {
      type: 'range',
      min: '0',
      max: String(SLIDER_STEPS),
      step: '1',
      value: String(zoomToSlider(clampZoom(s.project.view.zoom))),
      ...tt('Zoom', 'Option/Alt + scroll over the lanes, or = and −. Backslash fits the whole piece.'),
      oninput: (e) => {
        this.setZoom(sliderToZoom(Number((e.target as HTMLInputElement).value)));
      },
    }) as HTMLInputElement;

    this.toolbar.append(
      group,
      h('div', { class: 'vrule' }),
      this.snapBtn,
      h('span', { class: 'mini-label' }, 'Snap'),
      h('div', { class: 'spacer' }),
      this.countEl,
      new MemoryMeter().el,
      h('div', { class: 'zoom' }, h('span', { class: 'mono-cap' }, 'ZOOM'), this.zoomInput),
      h(
        'button',
        { class: 'tool', ...tt('Add track', `Up to 8 tracks`), onclick: () => addTrack() },
        svgIcon('c-plus', 14),
      ),
      h(
        'button',
        { class: 'tool kbd-btn', ...tt('Keyboard shortcuts', 'Press ? at any time'), onclick: () => openShortcutSheet() },
        '?',
      ),
    );
    this.renderToolbar(s);
  }

  /** In-place patch only — never replaces a node. */
  private renderToolbar(s: AppState): void {
    for (const [id, btn] of this.toolButtons) {
      btn.classList.toggle('active', s.ui.tool === id);
      // Basic keeps the three tools a first soundscape needs. Crossfade and
      // loop are the ones that need explaining before they are useful.
      btn.hidden = s.ui.mode === 'basic' && ADVANCED_TOOLS.has(id);
    }
    this.snapBtn.classList.toggle('on', s.ui.snap);
    const nEmpty = s.project.tracks.filter((t) => t.clips.length).length;
    const nClips = s.project.tracks.reduce((n, t) => n + t.clips.length, 0);
    this.countEl.textContent = `${nEmpty} OF ${s.project.tracks.length} TRACKS · ${nClips} CLIPS`;
    // don't fight the user's own drag
    if (document.activeElement !== this.zoomInput && !isInteracting()) {
      this.zoomInput.value = String(zoomToSlider(clampZoom(s.project.view.zoom)));
    }
    // Lets CSS give each tool its own cursor.
    this.el.dataset.tool = s.ui.tool;
  }

  // ---- geometry ----
  /** Pixels per second — the zoom slider's actual unit. */
  private pxPerSec(s: AppState): number {
    return Math.max(0.5, s.project.view.zoom);
  }
  /** Width of the scrollable time content, in px. */
  private contentWidth(s: AppState): number {
    return Math.max(240, s.project.duration * this.pxPerSec(s));
  }
  /**
   * Pixels per second as actually drawn. Differs from the zoom only when a
   * short project is stretched to the 240px minimum width.
   */
  private effPps(s: AppState): number {
    return this.contentWidth(s) / (s.project.duration || 1);
  }
  /** Timeline seconds under a client x, measured against a lane body (which scrolls). */
  private timeAt(body: HTMLElement, clientX: number): number {
    return (clientX - body.getBoundingClientRect().left) / this.effPps(store.get());
  }

  // ---- zoom ----
  private zoomRaf = 0;
  private zoomWanted: { zoom: number; anchorT?: number; anchorPx?: number } | null = null;

  /**
   * Change zoom, optionally keeping timeline second `anchorT` under the same
   * on-screen x (`anchorPx`, from the left of the time area) — so zooming
   * with the pointer over a clip zooms INTO that clip rather than toward 0:00.
   * Coalesced to one rebuild per frame; a trackpad sends dozens of events.
   */
  setZoom(zoom: number, anchorT?: number, anchorPx?: number): void {
    this.zoomWanted = { zoom: clampZoom(zoom), anchorT, anchorPx };
    if (this.zoomRaf) return;
    this.zoomRaf = requestAnimationFrame(() => {
      this.zoomRaf = 0;
      const want = this.zoomWanted;
      this.zoomWanted = null;
      if (!want) return;
      const s = store.get();
      if (Math.abs(want.zoom - s.project.view.zoom) < 1e-3) return;
      const visibleW = Math.max(1, this.lanesScroll.clientWidth - HEAD_W);
      const anchorPx = want.anchorPx ?? visibleW / 2;
      const anchorT = want.anchorT ?? (this.lanesScroll.scrollLeft + anchorPx) / this.effPps(s);
      store.mutateProject((p) => (p.view.zoom = want.zoom), { markDirty: false });
      this.lanesScroll.scrollLeft = Math.max(0, anchorT * this.effPps(store.get()) - anchorPx);
    });
  }

  /** `=` / `−`: zoom around the playhead if it is on screen, else the middle. */
  zoomBy(factor: number): void {
    const s = store.get();
    const visibleW = this.lanesScroll.clientWidth - HEAD_W;
    const phPx = s.transport.playhead * this.effPps(s) - this.lanesScroll.scrollLeft;
    const base = this.zoomWanted?.zoom ?? s.project.view.zoom;
    if (phPx >= 0 && phPx <= visibleW) this.setZoom(base * factor, s.transport.playhead, phPx);
    else this.setZoom(base * factor);
  }

  /** Backslash: the whole piece, edge to edge. */
  zoomToFit(): void {
    const s = store.get();
    const end = Math.max(contentEnd(s.project), 10);
    const visibleW = Math.max(100, this.lanesScroll.clientWidth - HEAD_W - 24);
    this.setZoom(visibleW / end, 0, 0);
  }

  private onWheel(e: WheelEvent): void {
    // Option/Alt + scroll zooms (as in Premiere and Audition). A trackpad
    // pinch arrives as a wheel event with ctrlKey set; without catching it
    // here the browser zooms the whole page instead.
    if (!e.altKey && !e.ctrlKey) return;
    e.preventDefault();
    const s = store.get();
    const delta = e.deltaY || e.deltaX;
    const rate = e.ctrlKey && !e.altKey ? 0.01 : 0.0015;
    const rect = this.lanesScroll.getBoundingClientRect();
    const anchorPx = Math.max(0, e.clientX - rect.left - HEAD_W);
    const base = this.zoomWanted?.zoom ?? s.project.view.zoom;
    const anchorT = (this.lanesScroll.scrollLeft + anchorPx) / this.effPps(s);
    this.setZoom(base * Math.exp(-delta * rate), anchorT, anchorPx);
  }

  // ---- ruler ----
  private buildRuler(): void {
    this.rulerTrack = h('div', { class: 'ruler-track', onpointerdown: (e) => this.scrubFromRuler(e as PointerEvent) });
    this.rulerViewport = h('div', { class: 'ruler-viewport' }, this.rulerTrack);
    this.el.append(h('div', { class: 'ruler' }, h('div', { class: 'ruler-gutter' }), this.rulerViewport));
    this.renderRuler(store.get());
  }

  /**
   * Aim for ~10–14 labels across the VISIBLE span so ticks stay readable at any
   * zoom, but never emit more than MAX_TICKS across the whole duration — at high
   * zoom on a long project that would be thousands of nodes.
   */
  private tickInterval(s: AppState): number {
    const MAX_TICKS = 240;
    const visibleSeconds = (this.rulerViewport?.clientWidth || 800) / this.pxPerSec(s);
    const targets = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    for (const t of targets) {
      if (visibleSeconds / t <= 14 && s.project.duration / t <= MAX_TICKS) return t;
    }
    return Math.max(900, s.project.duration / MAX_TICKS);
  }

  private renderRuler(s: AppState): void {
    clear(this.rulerTrack);
    const dur = s.project.duration;
    const w = this.contentWidth(s);
    this.rulerTrack.style.width = `${w}px`;
    const step = this.tickInterval(s);
    for (let t = 0; t <= dur + 0.001; t += step) {
      const px = (t / dur) * w;
      this.rulerTrack.append(
        h('div', { class: 'tick', style: `left:${px}px` }),
        h('div', { class: 'tick-label', style: `left:${px}px` }, timecode(t, false)),
      );
    }
    this.playheadEl = h('div', { class: 'playhead', style: 'left:0px' });
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
    this.lanesInner = h('div', { class: 'lanes-inner' });
    this.lanesScroll = h('div', { class: 'lanes-scroll' }, this.lanesInner);
    // keep the ruler locked to the lanes' horizontal scroll
    this.lanesScroll.addEventListener('scroll', () => {
      if (this.rulerViewport) this.rulerViewport.scrollLeft = this.lanesScroll.scrollLeft;
      // Remember where the student was looking. `view.scrollX` was in the
      // schema and saved to every project file, but nothing ever wrote or read
      // it. Not an undoable edit and not a reason to mark the file dirty.
      const seconds = this.lanesScroll.scrollLeft / this.pxPerSec(store.get());
      if (Math.abs(seconds - store.get().project.view.scrollX) > 0.01) {
        store.mutateProject((p) => (p.view.scrollX = seconds), { markDirty: false });
      }
    });
    this.lanesScroll.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.lanesScroll.addEventListener('pointermove', (e) => this.razorHover(e));
    this.lanesScroll.addEventListener('pointerleave', () => this.hideRazor());
    window.addEventListener('keydown', (e) => e.key === 'Shift' && this.razorHover(null, true));
    window.addEventListener('keyup', (e) => e.key === 'Shift' && this.razorHover(null, false));
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

  /**
   * Clips drawn before their audio had decoded — every clip of a reopened
   * session, which is restored before its sounds are. They are painted when
   * the asset store says something new has arrived; before, they stayed
   * blank until some unrelated edit happened to rebuild the lanes.
   */
  private unpainted = new Set<() => boolean>();

  private renderLanes(s: AppState): void {
    this.unpainted.clear();
    const scrollTop = this.lanesScroll.scrollTop;
    const scrollLeft = this.lanesScroll.scrollLeft;
    clear(this.lanesInner);
    const pxPerSec = this.pxPerSec(s);
    const bodyW = this.contentWidth(s);
    this.lanesInner.style.width = `${HEAD_W + bodyW}px`;

    for (const track of s.project.tracks) {
      this.lanesInner.append(this.renderLane(s, track, pxPerSec, bodyW));
    }

    // playhead across lanes
    const ph = h('div', { class: 'playhead', style: `left:${HEAD_W}px` });
    ph.dataset.lanes = '1';
    this.snapLine = h('div', { class: 'snap-line', hidden: true });
    this.razorGuide = h('div', { class: 'razor-guide', hidden: true }, h('span', { class: 'razor-label' }));
    this.lanesInner.append(ph, this.snapLine, this.razorGuide);
    this.lanesScroll.scrollTop = scrollTop;
    this.lanesScroll.scrollLeft = scrollLeft;
    if (this.rulerViewport) this.rulerViewport.scrollLeft = scrollLeft;
    this.positionPlayhead(s);
  }

  private renderLane(s: AppState, track: Track, pxPerSec: number, bodyW: number): HTMLElement {
    const selected = s.ui.selection.trackId === track.id;
    const hue = `var(--track-${track.index + 1})`;
    const auto = s.ui.automationView?.trackId === track.id ? s.ui.automationView : null;

    const autoToggle =
      s.ui.mode === 'advanced'
        ? h(
            'button',
            {
              class: 'ms',
              ...tt('Automation', 'Draw a curve for gain, pan, EQ or reverb over time'),
              onclick: () => setAutomationView(track.id, 'gain'),
            },
            'A',
          )
        : null;

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
          'aria-label': `Track ${track.index + 1} name`,
          onchange: (e) => renameTrack(track.id, (e.target as HTMLInputElement).value),
          onpointerdown: (e) => e.stopPropagation(),
        }),
        h(
          'button',
          {
            class: 'h-del',
            ...tt(
              'Delete track',
              track.clips.length > 0
                ? `Removes this track and its ${track.clips.length} clip${track.clips.length === 1 ? '' : 's'}. Undoable.`
                : 'Removes this track. Undoable.',
            ),
            onpointerdown: (e) => e.stopPropagation(),
            onclick: (e) => {
              e.stopPropagation();
              removeTrack(track.id);
            },
          },
          '×',
        ),
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
            ...(() => {
              const db = h('span', { class: 'h-db' }, fmtDb(track.gain));
              return [this.gainSlider(track, db), db];
            })(),
          ),
    );

    const body = h('div', { class: 'lane-body', style: `width:${bodyW}px` });
    body.addEventListener('pointerdown', (e) => this.onLaneBodyDown(e, track));
    // Files straight from the desktop. Sounds from the library use pointer
    // drags (see dnd.ts), not native drag-and-drop.
    body.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.highlightLane(body.parentElement);
    });
    body.addEventListener('dragleave', () => this.highlightLane(null));
    body.addEventListener('drop', (e) => void this.onFileDrop(e as DragEvent, track));

    for (const clip of track.clips) {
      body.append(this.renderClip(s, track, clip, pxPerSec));
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
        // The lane re-sorts its points by time on every write, so `i` is only
        // valid for the first move — track the index the point moves to.
        let idx = i;
        const before = snapshotAutomation(track.id);
        const move = (ev: PointerEvent) => {
          const time = Math.max(0, ((ev.clientX - rect.left) / rect.width) * dur);
          const unit = 1 - (ev.clientY - rect.top) / rect.height;
          idx = moveAutomationPoint(track.id, param, idx, time, fromUnit(param, unit));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          commitAutomationGesture(track.id, 'Move automation point', before);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      overlay.append(handle);
    });

    return overlay;
  }

  private gainSlider(track: Track, dbReadout: HTMLElement): HTMLElement {
    const toPct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 66) * 100)); // -60..+6 dB
    const fill = h('span', { class: 'fill', style: `width:${toPct(track.gain)}%` });
    return h(
      'div',
      { class: 'h-slider' },
      fill,
      h('input', {
        type: 'range',
        min: '-60',
        max: '6',
        step: '0.5',
        value: String(track.gain),
        'aria-label': `${track.name} gain, decibels`,
        // A bare "-6" is meaningless read aloud; say the unit.
        'aria-valuetext': `${fmtDb(track.gain)} dB`,
        oninput: (e) => {
          const input = e.target as HTMLInputElement;
          const db = Number(input.value);
          // update our own readout so the lane doesn't need rebuilding mid-drag
          fill.style.width = `${toPct(db)}%`;
          dbReadout.textContent = fmtDb(db);
          input.setAttribute('aria-valuetext', `${fmtDb(db)} dB`);
          setTrackGain(track.id, db);
        },
        onpointerdown: (e) => e.stopPropagation(),
      }),
    );
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
      h(
        'div',
        { class: 'clip-head' },
        h('span', { class: 'c-name' }, pending.title),
        h(
          'button',
          {
            class: 'pending-cancel',
            ...tt('Cancel import', 'Stops the download and removes this placeholder.'),
            onpointerdown: (e) => e.stopPropagation(),
            onclick: (e) => {
              e.stopPropagation();
              cancelImport(pending.id);
            },
          },
          '×',
        ),
      ),
      h('div', { class: 'pending-track' }, fill),
      h('div', { class: 'pending-label' }, pct != null ? `${phaseLabel} ${pct}%` : phaseLabel),
    );
  }

  private renderClip(
    s: AppState,
    track: Track,
    clip: Clip,
    pxPerSec: number,
  ): HTMLElement {
    const dur = s.project.duration;
    const leftPct = (clip.start / dur) * 100;
    const widthPct = (loopSpan(clip) / dur) * 100;
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
    const span = loopSpan(clip);
    if (clip.fadeIn.duration > 0) {
      const w = Math.min(100, (clip.fadeIn.duration / span) * 100);
      fadeWedges.push(
        h('div', {
          class: 'fade-wedge in',
          style: `width:${w}%;background:linear-gradient(90deg, var(--bg), transparent)`,
          ...tt('Fade in', `${clip.fadeIn.curve === 'equalPower' ? 'Equal-power' : 'Linear'} — ${clip.fadeIn.duration.toFixed(2)}s`),
        }),
      );
    }
    if (clip.fadeOut.duration > 0) {
      const w = Math.min(100, (clip.fadeOut.duration / span) * 100);
      fadeWedges.push(
        h('div', {
          class: 'fade-wedge out',
          style: `width:${w}%;background:linear-gradient(270deg, var(--bg), transparent)`,
          ...tt('Fade out', `${clip.fadeOut.curve === 'equalPower' ? 'Equal-power' : 'Linear'} — ${clip.fadeOut.duration.toFixed(2)}s`),
        }),
      );
    }

    const loopTicks: HTMLElement[] = [];
    if (clip.loop?.enabled && clip.loop.count > 1) {
      const iter = Math.max(0.01, clip.duration - clip.loop.crossfade);
      for (let i = 1; i < clip.loop.count; i++) {
        const at = clip.duration + (i - 1) * iter;
        loopTicks.push(
          h('div', {
            class: 'loop-tick',
            style: `left:${((at / span) * 100).toFixed(3)}%`,
            ...tt(`Repeat ${i + 1}`, 'This clip loops its own content — drag the edge with the loop tool to change how many times.'),
          }),
        );
      }
    }

    const el = h(
      'div',
      { class: `clip${selected ? ' sel' : ''}${clip.loop?.enabled && clip.loop.count > 1 ? ' looping' : ''}`, style, 'data-clip': clip.id },
      h('div', { class: 'clip-head' }, ...headBits),
      canvas,
      ...fadeWedges,
      ...loopTicks,
      h('div', { class: 'trim-handle l', 'data-edge': 'start' }),
      h('div', { class: 'trim-handle r', 'data-edge': 'end' }),
    );

    // paint waveform after layout
    const paint = (): boolean => {
      const peaks = assetStore.getPeaks(clip.assetId);
      if (!peaks) return false;
      canvas.style.width = '100%';
      canvas.style.height = `calc(100% - ${CLIP_HEAD_H}px)`;
      drawWaveform(canvas, peaks, clip.sourceOffset, clip.duration, pxPerSec, {
        hueToken: `--track-${hue}`,
        fillAlpha: 0.2,
        strokeAlpha: 0.8,
      });
      return true;
    };
    requestAnimationFrame(() => {
      if (!paint()) this.unpainted.add(paint);
    });

    el.addEventListener('pointerdown', (e) => this.onClipDown(e, track, clip));
    return el;
  }

  // ---- interaction ----
  private onLaneBodyDown(e: PointerEvent, track: Track): void {
    if ((e.target as HTMLElement).closest('.clip')) return;
    // click empty lane space: seek + select track
    transport.seek(Math.max(0, this.timeAt(e.currentTarget as HTMLElement, e.clientX)));
    store.patchUi({ selection: { trackId: track.id, clipId: null } });
  }

  /** Audio files dragged straight from the desktop onto a lane. */
  private async onFileDrop(e: DragEvent, track: Track): Promise<void> {
    this.highlightLane(null);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    let at = this.snapAt(this.timeAt(e.currentTarget as HTMLElement, e.clientX), { grid: true }).time;
    store.toast('info', `Decoding ${files.length} file${files.length > 1 ? 's' : ''}…`, 60_000);
    const { imported, errors } = await importFiles(files);
    // Several files go end to end from the drop point, not stacked.
    for (const ref of imported) {
      placeAsset(ref, track.id, at);
      at += ref.duration;
    }
    if (errors.length) store.toast('error', `${errors.length} file${errors.length > 1 ? 's' : ''} skipped: ${errors[0].reason}`, 7000);
    else store.toast('info', `Added ${imported.length} file${imported.length > 1 ? 's' : ''}.`, 2500);
  }

  // ---- guides: ghost clip, snap line, lane highlight, razor ----
  private ghostEl: HTMLElement | null = null;
  private snapLine: HTMLElement | null = null;
  private razorGuide: HTMLElement | null = null;
  private highlighted: HTMLElement | null = null;

  /**
   * The outline of where a clip will be once the pointer comes up. A separate
   * element from the clip itself, so the original stays put — you can see
   * where it came from and where it is going at the same time.
   */
  private showGhost(body: HTMLElement, start: number, span: number, label: string, kind: string): void {
    const dur = store.get().project.duration || 1;
    if (!this.ghostEl) this.ghostEl = h('div', { class: 'clip-ghost' }, h('span', { class: 'ghost-label' }));
    const g = this.ghostEl;
    // Lanes can be rebuilt under a long drag (a download finishing, say).
    if (g.parentElement !== body) body.append(g);
    g.className = `clip-ghost ${kind}`;
    g.style.left = `${((start / dur) * 100).toFixed(4)}%`;
    g.style.width = `${((Math.max(0, span) / dur) * 100).toFixed(4)}%`;
    (g.firstChild as HTMLElement).textContent = label;
  }

  /** A line through every lane at `t` while an edge is clicked onto something. */
  private showSnapLine(t: number | null): void {
    if (!this.snapLine) return;
    this.snapLine.hidden = t == null;
    if (t != null) this.snapLine.style.left = `${(HEAD_W + t * this.effPps(store.get())).toFixed(1)}px`;
  }

  private highlightLane(lane: HTMLElement | null): void {
    if (this.highlighted === lane) return;
    this.highlighted?.classList.remove('drop-target');
    this.highlighted = lane;
    lane?.classList.add('drop-target');
  }

  private hideGuides(): void {
    this.ghostEl?.remove();
    this.showSnapLine(null);
    this.highlightLane(null);
  }

  /** The lane under a client y, or (with `clamp`) the nearest one. */
  private laneAt(clientY: number, clamp: boolean): { trackId: string; body: HTMLElement; lane: HTMLElement } | null {
    const lanes = [...this.lanesInner.querySelectorAll<HTMLElement>('.lane')];
    if (lanes.length === 0) return null;
    const pack = (lane: HTMLElement) => ({
      trackId: lane.dataset.track!,
      body: lane.querySelector<HTMLElement>('.lane-body')!,
      lane,
    });
    for (const lane of lanes) {
      const r = lane.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return pack(lane);
    }
    if (!clamp) return null;
    return pack(clientY < lanes[0].getBoundingClientRect().top ? lanes[0] : lanes[lanes.length - 1]);
  }

  /** Every edge worth snapping to: other clips' ends, the playhead, zero. */
  private snapTargets(exclude?: string): number[] {
    const s = store.get();
    const pts = [0, s.transport.playhead];
    for (const t of s.project.tracks) {
      for (const c of t.clips) if (c.id !== exclude) pts.push(c.start, c.start + loopSpan(c));
    }
    return pts;
  }

  /**
   * Snap time `t`. `offsets` are the edges being dragged, relative to `t` (a
   * moved clip snaps by its start OR its end). Edges within SNAP_PX of a clip
   * edge or the playhead click onto it — the line shows which. Failing that,
   * with `grid`, `t` rounds to a quarter ruler division. Trims and cuts skip
   * the grid: a quarter division is seconds wide when zoomed out.
   */
  private snapAt(
    t: number,
    opts: { offsets?: number[]; exclude?: string; grid?: boolean; bypass?: boolean } = {},
  ): { time: number; line: number | null } {
    const s = store.get();
    if (!s.ui.snap || opts.bypass) return { time: Math.max(0, t), line: null };
    const threshold = SNAP_PX / this.effPps(s);
    let best: { d: number; line: number } | null = null;
    for (const target of this.snapTargets(opts.exclude)) {
      for (const off of opts.offsets ?? [0]) {
        const d = target - (t + off);
        if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: target };
      }
    }
    if (best && t + best.d >= 0) return { time: t + best.d, line: best.line };
    if (opts.grid) {
      const step = this.tickInterval(s) / 4;
      return { time: Math.max(0, Math.round(t / step) * step), line: null };
    }
    return { time: Math.max(0, t), line: null };
  }

  /**
   * One step of scrolling when a drag is held near either side of the lanes.
   * Returns true if the view moved, so the caller can redraw its ghost.
   */
  private edgeScroll(clientX: number): boolean {
    const r = this.lanesScroll.getBoundingClientRect();
    const left = r.left + HEAD_W;
    let v = 0;
    if (clientX < left + EDGE_SCROLL_PX) v = -(left + EDGE_SCROLL_PX - clientX);
    else if (clientX > r.right - EDGE_SCROLL_PX) v = clientX - (r.right - EDGE_SCROLL_PX);
    if (v === 0) return false;
    const before = this.lanesScroll.scrollLeft;
    this.lanesScroll.scrollLeft += Math.sign(v) * Math.min(24, Math.ceil(Math.abs(v) / 3));
    return this.lanesScroll.scrollLeft !== before;
  }

  // ---- library drops (see dnd.ts) ----
  private libraryTarget: { trackId: string; start: number } | null = null;

  private libraryHover(x: number, y: number, payload: LibraryPayload, mods: DragMods): boolean {
    const r = this.lanesScroll.getBoundingClientRect();
    const inside = x >= r.left + HEAD_W && x <= r.right && y >= r.top && y <= r.bottom;
    const lane = inside ? this.laneAt(y, false) : null;
    if (!lane) {
      this.libraryTarget = null;
      this.hideGuides();
      return false;
    }
    this.edgeScroll(x);
    const span = payload.duration > 0 ? payload.duration : 8;
    const snapped = this.snapAt(this.timeAt(lane.body, x), { offsets: [0, span], grid: true, bypass: mods.bypassSnap });
    const label = `${payload.title}  ·  ${timecode(snapped.time)}${payload.duration > 0 ? '' : '  ·  length unknown'}`;
    this.showGhost(lane.body, snapped.time, span, label, 'drop');
    this.showSnapLine(snapped.line);
    this.highlightLane(lane.lane);
    this.libraryTarget = { trackId: lane.trackId, start: snapped.time };
    return true;
  }

  private libraryDrop(x: number, y: number, payload: LibraryPayload, mods: DragMods): boolean {
    this.libraryHover(x, y, payload, mods);
    const at = this.libraryTarget;
    this.libraryTarget = null;
    this.hideGuides();
    if (!at) return false;
    if (payload.kind === 'asset') {
      void placeLibraryAsset(payload.ref, at.trackId, at.start);
      return true;
    }
    const result = payload.result;
    void importResultToTimeline(result, at).then((res) => {
      if (!res.ok && res.reason !== 'cancelled') store.toast('warn', res.reason ?? 'Import failed.');
      else if (res.ok) store.toast('info', `Added “${result.title}”.`, 2500);
    });
    return true;
  }

  // ---- razor ----
  private razorLast: PointerEvent | null = null;
  private razorShift = false;

  /** Where a razor click at `clientX` on a clip would cut. */
  private razorTime(body: HTMLElement, clientX: number, clipId: string, bypass: boolean): number {
    return this.snapAt(this.timeAt(body, clientX), { exclude: clipId, bypass }).time;
  }

  /**
   * With the razor, a line follows the pointer across the clip under it —
   * across every lane when Shift is held — so you can see the cut before you
   * make it.
   */
  private razorHover(e: PointerEvent | null, shift?: boolean): void {
    if (e) this.razorLast = e;
    this.razorShift = shift ?? e?.shiftKey ?? this.razorShift;
    const ev = this.razorLast;
    const guide = this.razorGuide;
    if (!guide || !ev || store.get().ui.tool !== 'split' || ev.buttons & 1) return this.hideRazor();
    const clipEl = (ev.target as HTMLElement | null)?.closest?.<HTMLElement>('.clip:not(.pending)');
    const body = clipEl?.parentElement;
    const lane = body?.parentElement;
    if (!clipEl || !body || !lane?.isConnected) return this.hideRazor();
    const t = this.razorTime(body, ev.clientX, clipEl.dataset.clip!, ev.metaKey || ev.ctrlKey);
    guide.hidden = false;
    guide.classList.toggle('all', this.razorShift);
    guide.style.left = `${(HEAD_W + t * this.effPps(store.get())).toFixed(1)}px`;
    guide.style.top = this.razorShift ? '0px' : `${lane.offsetTop + 7}px`;
    guide.style.height = this.razorShift ? `${this.lanesInner.scrollHeight}px` : `${lane.offsetHeight - 14}px`;
    (guide.firstChild as HTMLElement).textContent = `${this.razorShift ? 'Cut all · ' : ''}${timecode(t)}`;
  }

  private hideRazor(): void {
    if (this.razorGuide) this.razorGuide.hidden = true;
  }

  // ---- clip gestures ----
  private onClipDown(e: PointerEvent, track: Track, clip: Clip): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault(); // stop the browser starting a native text/image drag
    const tool = store.get().ui.tool;
    const clipEl = e.currentTarget as HTMLElement;
    const body = clipEl.parentElement as HTMLElement;

    if (tool === 'split') {
      const at = this.razorTime(body, e.clientX, clip.id, e.metaKey || e.ctrlKey);
      this.hideRazor();
      if (e.shiftKey) splitAllAt(at);
      else splitClipAt(track.id, clip.id, at);
      return;
    }

    store.patchUi({ selection: { trackId: track.id, clipId: clip.id } });

    const edge = (e.target as HTMLElement).dataset.edge as 'start' | 'end' | undefined;
    const mode: 'move' | 'trim-start' | 'trim-end' | 'loop' =
      tool === 'loop'
        ? 'loop'
        : tool === 'crossfade'
          ? 'move'
          : edge === 'start' || (tool === 'trim' && this.nearLeft(e))
            ? 'trim-start'
            : edge === 'end' || tool === 'trim'
              ? 'trim-end'
              : 'move';

    const originStart = clip.start;
    const originSpan = loopSpan(clip);
    const originOffset = clip.sourceOffset;
    const looping = !!clip.loop?.enabled && clip.loop.count > 1;
    // How far each edge can travel: into the asset at the head, and up to the
    // asset's end at the tail. Matches the clamps in edits.trimClip, so the
    // preview cannot promise a trim the commit will refuse.
    const assetDuration = assetStore.peek(clip.assetId)?.buffer.duration ?? originOffset + clip.duration;
    const downT = this.timeAt(body, e.clientX);
    const trackName = (id: string) => store.get().project.tracks.find((t) => t.id === id)?.name ?? 'track';

    let dragging = false;
    let last = { x: e.clientX, y: e.clientY };
    // Modifiers are tracked apart from the pointer: pressing or releasing
    // Option mid-drag has to flip move/copy without the mouse moving.
    const mods = { copy: e.altKey, bypass: e.metaKey || e.ctrlKey };
    let commit: (() => void) | null = null;
    let raf = 0;

    const update = () => {
      if (!dragging) {
        if (Math.abs(last.x - e.clientX) < DRAG_THRESHOLD && Math.abs(last.y - e.clientY) < DRAG_THRESHOLD) return;
        dragging = true;
        clipEl.classList.add('drag-src');
        this.el.classList.add('tl-dragging');
      }
      const dxSec = this.timeAt(body, last.x) - downT;

      if (mode === 'move') {
        const copy = mods.copy && tool !== 'crossfade';
        // The crossfade tool works within one track; select moves between them.
        const target =
          tool === 'crossfade'
            ? { trackId: track.id, body, lane: body.parentElement as HTMLElement }
            : this.laneAt(last.y, true)!;
        const snapped = this.snapAt(originStart + dxSec, {
          offsets: [0, originSpan],
          exclude: copy ? undefined : clip.id,
          grid: true,
          bypass: mods.bypass,
        });
        const at = snapped.time;
        const elsewhere = target.trackId !== track.id;
        this.showGhost(
          target.body,
          at,
          originSpan,
          `${copy ? '+ Copy  ·  ' : ''}${timecode(at)}${elsewhere ? `  →  ${trackName(target.trackId)}` : ''}`,
          copy ? 'copy' : 'move',
        );
        this.showSnapLine(snapped.line);
        this.highlightLane(elsewhere ? target.lane : null);
        this.el.classList.toggle('tl-copying', copy);
        if (copy) commit = () => duplicateClipTo(track.id, clip.id, at, target.trackId);
        else if (at === originStart && !elsewhere) commit = null;
        else if (tool === 'crossfade') commit = () => moveClipWithCrossfade(track.id, clip.id, at);
        else commit = () => moveClip(track.id, clip.id, at, target.trackId);
      } else if (mode === 'loop') {
        const xfade = clip.loop?.crossfade ?? 0.05;
        const wanted = Math.max(clip.duration, originSpan + dxSec);
        const count = loopCountForSpan(clip.duration, xfade, wanted);
        const span = count === 1 ? clip.duration : clip.duration + (count - 1) * (clip.duration - xfade);
        this.showGhost(body, originStart, span, `× ${count}  ·  ${span.toFixed(1)} s`, 'trim');
        commit = count === (clip.loop?.enabled ? clip.loop.count : 1) ? null : () => dragLoopClip(track.id, clip.id, wanted);
      } else if (mode === 'trim-start') {
        const snapped = this.snapAt(originStart + dxSec, { exclude: clip.id, bypass: mods.bypass || looping });
        const d = Math.max(-originOffset, Math.min(snapped.time - originStart, clip.duration - 0.05));
        const newDur = clip.duration - d;
        const atLimit = d <= -originOffset + 1e-6;
        this.showGhost(
          body,
          originStart + d,
          loopSpan({ ...clip, duration: newDur }),
          `${timecode(originStart + d)}  ·  ${newDur.toFixed(2)} s${atLimit ? '  ·  start of recording' : ''}`,
          `trim${atLimit ? ' limit' : ''}`,
        );
        this.showSnapLine(Math.abs(originStart + d - snapped.time) < 1e-6 ? snapped.line : null);
        commit = Math.abs(d) < 1e-6 ? null : () => trimClip(track.id, clip.id, 'start', d);
      } else {
        const originEnd = originStart + clip.duration;
        const snapped = this.snapAt(originEnd + dxSec, { exclude: clip.id, bypass: mods.bypass || looping });
        const room = assetDuration - (originOffset + clip.duration);
        const d = Math.max(-(clip.duration - 0.05), Math.min(snapped.time - originEnd, room));
        const newDur = clip.duration + d;
        const atLimit = d >= room - 1e-6;
        this.showGhost(
          body,
          originStart,
          loopSpan({ ...clip, duration: newDur }),
          `${newDur.toFixed(2)} s${atLimit ? '  ·  end of recording' : ''}`,
          `trim${atLimit ? ' limit' : ''}`,
        );
        this.showSnapLine(Math.abs(originEnd + d - snapped.time) < 1e-6 ? snapped.line : null);
        commit = Math.abs(d) < 1e-6 ? null : () => trimClip(track.id, clip.id, 'end', d);
      }
    };

    const frame = () => {
      if (dragging && this.edgeScroll(last.x)) update();
      raf = requestAnimationFrame(frame);
    };
    const move = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      mods.copy = ev.altKey;
      mods.bypass = ev.metaKey || ev.ctrlKey;
      update();
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        // Throw the gesture away; don't also let Escape clear the selection.
        ev.preventDefault();
        ev.stopImmediatePropagation();
        commit = null;
        finish();
        return;
      }
      mods.copy = ev.altKey;
      mods.bypass = ev.metaKey || ev.ctrlKey;
      if (dragging) update();
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', key, true);
      cancelAnimationFrame(raf);
      clipEl.classList.remove('drag-src');
      this.el.classList.remove('tl-dragging', 'tl-copying');
      this.hideGuides();
    };
    const up = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      mods.copy = ev.altKey;
      mods.bypass = ev.metaKey || ev.ctrlKey;
      if (dragging) update();
      const run = dragging ? commit : null;
      finish();
      run?.();
    };
    const cancel = () => {
      commit = null;
      finish();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', key, true);
    raf = requestAnimationFrame(frame);
  }

  private nearLeft(e: PointerEvent): boolean {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX - r.left < r.width / 2;
  }

  // ---- playhead ----
  private positionPlayhead(s: AppState): void {
    const dur = s.project.duration || 1;
    const frac = Math.min(1, Math.max(0, s.transport.playhead / dur));
    const bodyW = this.contentWidth(s);
    if (this.playheadEl) this.playheadEl.style.left = `${(frac * bodyW).toFixed(1)}px`;
    if (!this.lanesInner) return;
    const laneHead = this.lanesInner.querySelector<HTMLElement>('.playhead[data-lanes]');
    if (laneHead) laneHead.style.left = `${(HEAD_W + frac * bodyW).toFixed(1)}px`;
    if (s.transport.playing) this.followPlayhead(frac * bodyW);
  }

  /**
   * Keep the playhead on screen while the mix runs. Zoomed in, it used to walk
   * straight off the right-hand edge and the student lost sight of it for the
   * rest of the take.
   *
   * Only while playing, and only when the playhead actually leaves the visible
   * band: scrolling on every frame would fight the student's own scrolling.
   */
  private followPlayhead(xPx: number): void {
    const view = this.lanesScroll;
    const width = view.clientWidth - HEAD_W;
    if (width <= 0) return;
    const left = view.scrollLeft;
    const margin = Math.min(120, width * 0.12);

    if (xPx > left + width - margin) {
      // Jump a page rather than creep, so the picture is stable to read.
      view.scrollLeft = Math.max(0, xPx - margin);
    } else if (xPx < left) {
      // Looped back, or seeked behind the viewport.
      view.scrollLeft = Math.max(0, xPx - margin);
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
