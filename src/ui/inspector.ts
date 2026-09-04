/*
 * Right panel — Inspector (UI spec §4.7). Selected clip name, source block
 * (Source, Author, Licence chip, Location), Gain + Pan with mono readouts and a
 * centre detent, then EQ (5-band curve on an inset well) and Reverb (preset +
 * Size/Decay/Wet). EQ and Reverb appear only in Advanced mode.
 */

import { store, type AppState } from '../state/store';
import { clear, h, fmtDb } from './dom';
import { tt } from './tooltip';
import { licenceName, licenceShort, licenceTone, ALL_LICENCE_IDS, makeLicence } from '../licence/model';
import {
  setClipFade,
  setClipLoop,
  updateAssetAuthor,
  updateAssetLicence,
} from '../state/edits';
import {
  toggleEq,
  toggleReverb,
  setEqBand,
  setReverbParam,
  setReverbPreset,
} from '../state/effectEdits';
import { REVERB_PRESETS } from '../audio/effects/reverb';
import type { Clip, EqSettings, Track } from '../state/project';

export class Inspector {
  readonly el: HTMLElement;

  constructor() {
    this.el = h('div', { class: 'panel-right scroll' });
    this.render(store.get());
    store.subscribe((s, changed) => {
      if (changed.has('ui') || changed.has('project')) this.render(s);
    });
  }

  private selected(s: AppState): { track: Track; clip: Clip } | null {
    const { trackId, clipId } = s.ui.selection;
    if (!trackId) return null;
    const track = s.project.tracks.find((t) => t.id === trackId);
    if (!track) return null;
    const clip = track.clips.find((c) => c.id === clipId);
    return clip ? { track, clip } : null;
  }

  private render(s: AppState): void {
    clear(this.el);
    const sel = this.selected(s);
    if (!sel) {
      this.el.append(
        h('div', { class: 'empty' },
          s.ui.selection.trackId
            ? 'Select a clip to edit its source, gain, fades and effects.'
            : 'Select a track or clip. Its properties appear here.'),
      );
      // still show track effects if a track is selected
      if (s.ui.selection.trackId) {
        const t = s.project.tracks.find((x) => x.id === s.ui.selection.trackId);
        if (t && s.ui.mode === 'advanced') {
          this.el.append(this.eqSection(t), this.reverbSection(t));
        }
      }
      return;
    }

    const { track, clip } = sel;
    const ref = s.project.assets[clip.assetId];

    // --- source block ---
    const tone = ref ? licenceTone(ref.licence) : 'unknown';
    const licenceChip = h(
      'span',
      { class: `lic ${tone}`, ...tt(ref ? licenceName(ref.licence.id) : 'Unknown', 'Change the licence below if you know it.') },
      ref ? licenceShort(ref.licence) : '?',
    );

    this.el.append(
      h(
        'div',
        { class: 'insp-section' },
        h('div', { class: 'section-label' }, 'SELECTED CLIP'),
        h('div', { class: 'insp-title', style: 'margin-top:7px' }, ref?.title ?? 'Clip'),
        h('div', { style: 'margin-top:11px' },
          kv('Source', ref?.source ?? '—'),
          this.editableAuthor(ref?.id, ref?.author ?? '—'),
          h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Licence'), licenceChip),
          this.licencePicker(ref?.id, ref?.licence.id),
          ref?.location
            ? kv('Location', `${ref.location.lat.toFixed(4)} ${ref.location.lat >= 0 ? 'N' : 'S'} ${Math.abs(ref.location.lon).toFixed(4)} ${ref.location.lon >= 0 ? 'E' : 'W'}`, true)
            : document.createComment('no-loc'),
        ),
      ),
    );

    // --- gain / pan (clip gain) ---
    this.el.append(
      h(
        'div',
        { class: 'insp-section' },
        sliderRow('Clip gain', `${fmtDb(clip.gain)} dB`, clip.gain, -40, 12, 0.5, (v) =>
          store.mutateProject((p) => {
            const c = p.tracks.find((t) => t.id === track.id)?.clips.find((x) => x.id === clip.id);
            if (c) c.gain = v;
          }),
        ),
        sliderRow('Fade in', `${clip.fadeIn.duration.toFixed(2)} s`, clip.fadeIn.duration, 0, 6, 0.05, (v) =>
          setClipFade(track.id, clip.id, 'fadeIn', v),
        ),
        this.fadeCurvePick(track.id, clip.id, 'fadeIn', clip.fadeIn.curve),
        sliderRow('Fade out', `${clip.fadeOut.duration.toFixed(2)} s`, clip.fadeOut.duration, 0, 6, 0.05, (v) =>
          setClipFade(track.id, clip.id, 'fadeOut', v),
        ),
        this.fadeCurvePick(track.id, clip.id, 'fadeOut', clip.fadeOut.curve),
        sliderRow(
          'Loop ×',
          String(clip.loop?.count ?? 1),
          clip.loop?.count ?? 1,
          1,
          16,
          1,
          (v) => setClipLoop(track.id, clip.id, v, clip.loop?.crossfade ?? 0.05),
        ),
      ),
    );

    if (s.ui.mode === 'advanced') {
      this.el.append(this.eqSection(track), this.reverbSection(track));
    }
  }

  private editableAuthor(assetId: string | undefined, value: string): HTMLElement {
    if (!assetId) return kv('Author', value);
    return h(
      'div',
      { class: 'kv' },
      h('span', { class: 'k' }, 'Author'),
      h('input', {
        class: 'v',
        style: 'text-align:right;background:none;border:none;max-width:150px',
        value,
        onchange: (e) => updateAssetAuthor(assetId, (e.target as HTMLInputElement).value),
      }),
    );
  }

  private licencePicker(assetId: string | undefined, current: string | undefined): HTMLElement {
    if (!assetId) return document.createComment('no-asset') as unknown as HTMLElement;
    return h(
      'div',
      { class: 'kv' },
      h('span', { class: 'k' }, 'Set licence'),
      h(
        'select',
        {
          style: 'font-size:11px',
          onchange: (e) => updateAssetLicence(assetId, makeLicence((e.target as HTMLSelectElement).value as never)),
        },
        ...ALL_LICENCE_IDS.map((id) =>
          h('option', { value: id, selected: id === current }, licenceName(id)),
        ),
      ),
    );
  }

  private fadeCurvePick(
    trackId: string,
    clipId: string,
    which: 'fadeIn' | 'fadeOut',
    curve: 'linear' | 'equalPower',
  ): HTMLElement {
    return h(
      'div',
      { class: 'kv', ...tt('Fade curve', 'Equal-power keeps perceived loudness steady through the blend; linear is a straight level ramp.') },
      h('span', { class: 'k' }, `${which === 'fadeIn' ? 'In' : 'Out'} curve`),
      h(
        'select',
        {
          style: 'font-size:11px',
          onchange: (e) =>
            setClipFade(trackId, clipId, which, -1, (e.target as HTMLSelectElement).value as 'linear' | 'equalPower'),
        },
        h('option', { value: 'equalPower', selected: curve === 'equalPower' }, 'Equal-power'),
        h('option', { value: 'linear', selected: curve === 'linear' }, 'Linear'),
      ),
    );
  }

  private eqSection(track: Track): HTMLElement {
    const eq = track.eq;
    const enabled = !!eq?.enabled;
    const well = h('div', { class: 'eq-well' });
    if (eq) well.append(this.eqCurve(eq));

    return h(
      'div',
      { class: 'insp-section' },
      h(
        'div',
        { class: 'insp-h' },
        h('span', { class: 'insp-title' }, 'Equaliser'),
        h('button', { class: `toggle${enabled ? ' on' : ''}`, onclick: () => toggleEq(track.id) }, h('span', { class: 'knob' })),
      ),
      well,
      h('div', { class: 'eq-scale' }, ...['60', '250', '1k', '4k', '12k'].map((f) => h('span', {}, f))),
      ...(eq
        ? eq.bands.map((b, i) =>
            sliderRow(
              ['Low', 'Low mid', 'Mid', 'High mid', 'High'][i],
              `${b.gain > 0 ? '+' : ''}${b.gain.toFixed(1)} dB`,
              b.gain,
              -18,
              18,
              0.5,
              (v) => setEqBand(track.id, i, { gain: v }),
            ),
          )
        : []),
    );
  }

  private eqCurve(eq: EqSettings): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 260 76');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%');
    const mid = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    mid.setAttribute('x1', '0');
    mid.setAttribute('y1', '38');
    mid.setAttribute('x2', '260');
    mid.setAttribute('y2', '38');
    mid.setAttribute('stroke', 'var(--border)');
    svg.append(mid);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const pts = eq.bands.map((b, i) => {
      const x = (i / (eq.bands.length - 1)) * 260;
      const y = 38 - (b.gain / 18) * 30;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    path.setAttribute('d', `M ${pts.join(' L ')}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--accent)');
    path.setAttribute('stroke-width', '1.6');
    svg.append(path);
    return svg;
  }

  private reverbSection(track: Track): HTMLElement {
    const rv = track.reverb;
    const enabled = !!rv?.enabled;
    const presetKey = (rv?.preset ?? 'street') as keyof typeof REVERB_PRESETS | 'custom';
    const def = presetKey !== 'custom' ? REVERB_PRESETS[presetKey] : null;

    return h(
      'div',
      { class: 'insp-section' },
      h(
        'div',
        { class: 'insp-h' },
        h('span', { class: 'insp-title' }, 'Reverb'),
        h('button', { class: `toggle${enabled ? ' on' : ''}`, onclick: () => toggleReverb(track.id) }, h('span', { class: 'knob' })),
      ),
      h(
        'div',
        {
          class: 'select',
          style: 'margin-bottom:13px',
          ...tt(
            `Spatial preset: ${def?.label ?? 'Custom'}`,
            def ? `Sets size ${Math.round(def.size * 100)}% and decay ${def.decay} s — ${def.blurb}.` : 'Your own settings.',
          ),
        },
        h(
          'select',
          {
            onchange: (e) => setReverbPreset(track.id, (e.target as HTMLSelectElement).value as never),
          },
          ...Object.entries(REVERB_PRESETS).map(([k, v]) =>
            h('option', { value: k, selected: k === presetKey }, v.label),
          ),
          h('option', { value: 'custom', selected: presetKey === 'custom', disabled: true }, 'Custom'),
        ),
      ),
      sliderRow('Size', `${Math.round((rv?.size ?? 0.34) * 100)}%`, rv?.size ?? 0.34, 0, 1, 0.01, (v) =>
        setReverbParam(track.id, { size: v }),
      ),
      sliderRow('Decay', `${(rv?.decay ?? 0.9).toFixed(1)} s`, rv?.decay ?? 0.9, 0.1, 6, 0.1, (v) =>
        setReverbParam(track.id, { decay: v }),
      ),
      sliderRow('Wet', `${Math.round((rv?.wet ?? 0.18) * 100)}%`, rv?.wet ?? 0.18, 0, 1, 0.01, (v) =>
        setReverbParam(track.id, { wet: v }),
      ),
    );
  }
}

function kv(k: string, v: string, mono = false): HTMLElement {
  return h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: `v${mono ? ' mono' : ''}` }, v));
}

function sliderRow(
  label: string,
  valueText: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onInput: (v: number) => void,
): HTMLElement {
  return h(
    'div',
    { class: 'slider-row' },
    h('div', { class: 'sr-h' }, h('span', {}, label), h('span', { class: 'sr-val' }, valueText)),
    h('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
      oninput: (e) => onInput(Number((e.target as HTMLInputElement).value)),
    }),
  );
}
