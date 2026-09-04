/*
 * Left panel — Discovery (UI spec §4.2). Tabs: Freesound · Archive · Map · Mine.
 * The whole panel is a drop target for local files (the primary import path).
 * A paste-a-URL field sits under Freesound.
 *
 * Every tab's pane is built ONCE and kept mounted forever, just shown/hidden
 * with `hidden` — switching tabs used to clear()+rebuild the content area,
 * which discarded whatever you'd typed or found (and, for the map, reset the
 * pin to Manchester and re-ran the search). Search results now persist per
 * source until that source is searched again.
 */

import { store, type AppState, type DiscoveryTab } from '../state/store';
import { transport } from '../audio/transport';
import { clear, h, svgIcon, timecode } from './dom';
import { tt } from './tooltip';
import { licenceShort, licenceTone, makeLicence, ALL_LICENCE_IDS } from '../licence/model';
import type { SoundResult } from '../sources/types';
import { searchArchive } from '../sources/archive';
import { searchAporee, RADIUS_CHOICES_KM } from '../sources/aporee';
import {
  searchFreesound,
  hasKey,
  setKey,
  forgetKey,
  validateKey,
  resolveFreesoundUrl,
  FreesoundRateLimitError,
} from '../sources/freesound';
import { importResultToTimeline, placeLocalAsset } from '../sources/importResult';
import { importFiles, filesFromDataTransfer, FILE_PICKER_ACCEPT } from '../sources/local';
import { assetStore } from '../audio/assetStore';
import type { AssetRef } from '../state/project';
import { ASSET_DND_TYPE, SEARCH_RESULT_DND_TYPE } from './dnd';

const TABS: [DiscoveryTab, string][] = [
  ['freesound', 'Freesound'],
  ['archive', 'Archive'],
  ['map', 'Map'],
  ['mine', 'Mine'],
];

interface SearchState {
  resultsHost: HTMLElement;
  results: SoundResult[];
  busy: boolean;
  error: string | null;
}

export class Discovery {
  readonly el: HTMLElement;
  private tabsEl!: HTMLElement;
  private panesEl!: HTMLElement;
  private panes: Partial<Record<DiscoveryTab, HTMLElement>> = {};
  private previewAudio = new Audio();
  private mapModule: typeof import('./map') | null = null;
  private mapMounted = false;
  private importingIds = new Set<string>();
  private previewingId: string | null = null;

  private freesound: SearchState = { resultsHost: h('div'), results: [], busy: false, error: null };
  private archive: SearchState = { resultsHost: h('div'), results: [], busy: false, error: null };

  constructor() {
    this.el = h('div', { class: 'panel-left' });
    this.tabsEl = h('div', { class: 'tabs' });
    this.panesEl = h('div', { class: 'scroll', style: 'display:flex;flex-direction:column;min-height:0;flex:1' });
    const drop = h(
      'div',
      { class: 'dropzone', onclick: () => this.pickFiles() },
      svgIcon('c-file', 14),
      h('span', {}, 'Drop your own recordings here'),
    );
    this.el.append(this.tabsEl, this.panesEl, drop);
    this.wireDrop();

    const clearPreview = () => {
      this.previewingId = null;
      this.paintFreesound();
      this.paintArchive();
    };
    this.previewAudio.addEventListener('ended', clearPreview);
    this.previewAudio.addEventListener('pause', clearPreview);

    this.panes.freesound = this.buildFreesoundPane();
    this.panes.archive = this.buildArchivePane();
    this.panes.mine = h('div', { style: 'display:flex;flex-direction:column;min-height:0;flex:1' });
    this.panes.map = h('div', { style: 'display:flex;flex-direction:column;min-height:0;flex:1' });
    for (const [id] of TABS) {
      const pane = this.panes[id]!;
      pane.hidden = true;
      this.panesEl.append(pane);
    }
    this.renderMine();

    this.renderTabs(store.get());
    this.showTab(store.get().ui.discoveryTab);

    store.subscribe((s, changed) => {
      if (changed.has('ui')) {
        this.renderTabs(s);
        this.showTab(s.ui.discoveryTab);
      }
      if (changed.has('project')) this.renderMine();
    });
  }

  // ---- tabs ----
  private renderTabs(s: AppState): void {
    clear(this.tabsEl);
    for (const [id, label] of TABS) {
      this.tabsEl.append(
        h(
          'button',
          {
            class: s.ui.discoveryTab === id ? 'active' : '',
            onclick: () => store.patchUi({ discoveryTab: id }),
          },
          label,
        ),
      );
    }
  }

  private showTab(tab: DiscoveryTab): void {
    for (const [id] of TABS) {
      const pane = this.panes[id];
      if (pane) pane.hidden = id !== tab;
    }
    if (tab === 'map' && !this.mapMounted) void this.mountMapPane();
  }

  // ---- Mine (imported bin) ----
  private renderMine(): void {
    const pane = this.panes.mine;
    if (!pane) return;
    clear(pane);
    const refs = Object.values(store.get().project.assets);
    if (refs.length === 0) {
      pane.append(
        h(
          'div',
          { class: 'empty' },
          'Nothing imported yet. Drag in your own recordings, or search Freesound, the Internet Archive and the map. ',
          h('br'),
          h('br'),
          'Local files work with no account and no rate limit — it is the tool’s floor.',
        ),
      );
      return;
    }
    const list = h('div', { class: 'scroll', style: 'padding:4px 6px' });
    for (const ref of refs) list.append(this.assetRow(ref));
    pane.append(list);
  }

  private assetRow(ref: AssetRef): HTMLElement {
    const tone = licenceTone(ref.licence);
    const entry = assetStore.peek(ref.id);
    const dur = entry?.buffer.duration ?? ref.duration;
    return h(
      'div',
      {
        class: 'result',
        draggable: 'true',
        ondragstart: (e) => {
          (e as DragEvent).dataTransfer?.setData(ASSET_DND_TYPE, ref.id);
        },
        onclick: () => placeLocalAsset(ref),
        ...tt('Add to timeline', 'Click to drop on the first empty track, or drag onto a lane.'),
      },
      h('div', { class: 'play-sq' }, svgIcon('c-plus', 10)),
      h(
        'div',
        { class: 'r-main' },
        h('div', { class: 'r-title' }, ref.title),
        h('div', { class: 'r-meta' }, ref.author),
      ),
      dur ? h('span', { class: 'dur-chip mono' }, timecode(dur, false)) : document.createComment('no-dur'),
      h('span', { class: `lic ${tone}` }, licenceShort(ref.licence)),
    );
  }

  // ---- Archive ----
  private buildArchivePane(): HTMLElement {
    const input = h('input', {
      type: 'text',
      placeholder: 'Search the Internet Archive…',
      onkeydown: (e) => {
        if ((e as KeyboardEvent).key === 'Enter') this.runArchiveSearch((e.target as HTMLInputElement).value);
      },
    }) as HTMLInputElement;
    this.archive.resultsHost = h('div', { class: 'scroll', style: 'flex:1' });
    this.paintArchive();
    return h(
      'div',
      { style: 'display:flex;flex-direction:column;min-height:0;flex:1' },
      h('div', { class: 'pad' }, h('div', { class: 'field' }, svgIcon('c-search', 14), input)),
      this.archive.resultsHost,
    );
  }

  private async runArchiveSearch(query: string): Promise<void> {
    if (!query.trim()) return;
    this.archive.busy = true;
    this.paintArchive();
    try {
      const page = await searchArchive(query, { pageSize: 40 });
      this.archive.results = page.results;
      this.archive.error = null;
    } catch (err) {
      this.archive.error = err instanceof Error ? err.message : 'Search failed.';
      this.archive.results = [];
    } finally {
      this.archive.busy = false;
      this.paintArchive();
    }
  }

  private paintArchive(): void {
    this.paintSearchPane(this.archive);
  }

  // ---- Freesound ----
  private buildFreesoundPane(): HTMLElement {
    const pane = h('div', { style: 'display:flex;flex-direction:column;min-height:0;flex:1' });
    this.renderFreesoundInner(pane);
    return pane;
  }

  private renderFreesoundInner(pane: HTMLElement): void {
    clear(pane);
    if (!hasKey()) {
      pane.append(this.freesoundKeyPanel(pane));
      return;
    }
    const input = h('input', {
      type: 'text',
      placeholder: 'Search Freesound…',
      onkeydown: (e) => {
        if ((e as KeyboardEvent).key === 'Enter') this.runFreesoundSearch((e.target as HTMLInputElement).value);
      },
    }) as HTMLInputElement;

    const pasteInput = h('input', {
      type: 'text',
      placeholder: 'or paste a freesound.org sound URL',
      onkeydown: (e) => {
        if ((e as KeyboardEvent).key === 'Enter') this.runPaste((e.target as HTMLInputElement).value);
      },
    }) as HTMLInputElement;

    this.freesound.resultsHost = h('div', { class: 'scroll', style: 'flex:1' });
    this.paintFreesound();

    pane.append(
      h(
        'div',
        { class: 'pad' },
        h('div', { class: 'field' }, svgIcon('c-search', 14), input),
        h('div', { class: 'field', style: 'margin-top:8px' }, svgIcon('c-file', 14), pasteInput),
        h(
          'button',
          { class: 'linkish', style: 'margin-top:8px;font-size:11px', onclick: () => { forgetKey(); this.renderFreesoundInner(pane); } },
          'Forget key on this machine',
        ),
      ),
      this.freesound.resultsHost,
    );
  }

  private freesoundKeyPanel(pane: HTMLElement): HTMLElement {
    const key = h('input', { type: 'text', placeholder: 'paste your API key here' }) as HTMLInputElement;
    const status = h('div', { class: 'muted', style: 'margin-top:6px' }, '');
    const connect = async () => {
      const v = key.value.trim();
      if (!v) return;
      status.textContent = 'Checking…';
      try {
        const ok = await validateKey(v);
        if (ok) {
          setKey(v);
          store.toast('info', 'Freesound connected.');
          this.renderFreesoundInner(pane);
        } else {
          status.textContent = 'That key was rejected. Check you copied the “Client secret/Api key” value.';
        }
      } catch (err) {
        status.textContent = err instanceof FreesoundRateLimitError ? err.message : 'Could not reach Freesound.';
      }
    };
    return h(
      'div',
      { class: 'keypanel' },
      h('h4', {}, 'Freesound — optional'),
      h('p', {}, 'Freesound is a library of over 500,000 sounds shared by people around the world. Connecting it adds keyword search across all of them, directly inside ScapeMaker.'),
      h('p', {}, 'It’s free, and it takes about three minutes. You’ll need your own key — that way your searches are yours, and nobody else’s usage slows you down.'),
      h(
        'ol',
        {},
        h('li', {}, 'Create a free account at ', h('a', { href: 'https://freesound.org', target: '_blank', rel: 'noreferrer' }, 'freesound.org')),
        h('li', {}, 'Go to ', h('a', { href: 'https://freesound.org/apiv2/apply', target: '_blank', rel: 'noreferrer' }, 'freesound.org/apiv2/apply'), ' and request new credentials'),
        h('li', {}, 'Copy the value under “Client secret/Api key”'),
        h('li', {}, 'Paste it below'),
      ),
      h('div', { class: 'field' }, key),
      h('button', { class: 'btn primary', style: 'margin-top:8px', onclick: connect }, 'Connect'),
      status,
      h('p', { class: 'muted', style: 'margin-top:12px' }, 'Your key is stored only in this browser and is sent only to Freesound. We never see it. On a shared or lab machine it stays until you remove it.'),
      h('hr', { style: 'border:none;border-top:1px solid var(--line);margin:14px 0' }),
      h('p', {}, h('strong', {}, 'Don’t want an account? '), 'You don’t need one. Find a sound on freesound.org, download it, and drag it into ScapeMaker — then paste the sound’s page URL in the Freesound tab so the credit is recorded properly. Everything else works without a key.'),
    );
  }

  private async runFreesoundSearch(query: string): Promise<void> {
    if (!query.trim()) return;
    this.freesound.busy = true;
    this.paintFreesound();
    try {
      const page = await searchFreesound(query, { pageSize: 40 });
      this.freesound.results = page.results;
      this.freesound.error = null;
    } catch (err) {
      this.freesound.error = err instanceof Error ? err.message : 'Search failed.';
      this.freesound.results = [];
    } finally {
      this.freesound.busy = false;
      this.paintFreesound();
    }
  }

  private async runPaste(url: string): Promise<void> {
    if (!url.trim()) return;
    this.freesound.busy = true;
    this.paintFreesound();
    try {
      const resolved = await resolveFreesoundUrl(url);
      if (resolved.needsLicenceChoice) {
        const id = window.prompt(
          `No key set, so the licence can't be read automatically.\nType the licence id for "${resolved.result.title}":\n${ALL_LICENCE_IDS.join(', ')}`,
          'by',
        );
        if (id && ALL_LICENCE_IDS.includes(id as never)) {
          resolved.result.licence = makeLicence(id as never);
        }
      }
      this.freesound.results = [resolved.result, ...this.freesound.results];
      this.freesound.error = resolved.needsLicenceChoice
        ? 'Imported from URL with no API call. Download the file from Freesound and drag it in to add the audio.'
        : null;
    } catch (err) {
      this.freesound.error = err instanceof Error ? err.message : 'Could not resolve that URL.';
    } finally {
      this.freesound.busy = false;
      this.paintFreesound();
    }
  }

  private paintFreesound(): void {
    this.paintSearchPane(this.freesound);
  }

  // ---- Map ----
  private async mountMapPane(): Promise<void> {
    this.mapMounted = true;
    const host = this.panes.map!;
    if (!this.mapModule) this.mapModule = await import('./map');
    this.mapModule.mountMap(host, {
      radii: [...RADIUS_CHOICES_KM],
      // The map owns its own results list entirely (see map.ts) — this just
      // does the network call. Errors propagate so the map can show them
      // inline without Discovery's tab-level state getting involved.
      onSearch: (centre, radiusKm) => searchAporee(centre, radiusKm, { pageSize: 60 }).then((p) => p.results),
      onPreview: (r) => this.preview(r),
      onImport: (r) => this.doImport(r),
      previewAudio: this.previewAudio,
    });
  }

  // ---- shared search-results rendering (Freesound + Archive) ----
  private paintSearchPane(state: SearchState): void {
    const host = state.resultsHost;
    if (!host.isConnected) return;
    clear(host);
    if (state.busy) {
      host.append(h('div', { class: 'empty' }, 'Searching…'));
      return;
    }
    if (state.error) host.append(h('div', { class: 'empty', style: 'color:var(--warn)' }, state.error));
    if (state.results.length === 0 && !state.error) {
      host.append(h('div', { class: 'empty' }, 'No results yet.'));
      return;
    }
    host.append(h('div', { class: 'radius-row' }, h('span', { class: 'count' }, `${state.results.length} FOUND`)));
    for (const r of state.results) host.append(this.resultRow(r));
  }

  private resultRow(r: SoundResult): HTMLElement {
    const tone = licenceTone(r.licence);
    const importing = this.importingIds.has(r.id);
    const previewing = this.previewingId === r.id;
    const meta =
      r.distanceKm != null && r.location
        ? `${r.location.lat.toFixed(4)} ${r.location.lat >= 0 ? 'N' : 'S'} ${Math.abs(r.location.lon).toFixed(4)} ${r.location.lon >= 0 ? 'E' : 'W'} · ${r.distanceKm.toFixed(1)} KM`
        : r.author;

    const licChip = h(
      'span',
      {
        class: `lic ${tone}`,
        ...(tone === 'warn'
          ? tt('NoDerivatives / NonCommercial licence', 'You can use this to study and to hand in coursework, but a soundscape built from it cannot be published or shared publicly.')
          : {}),
      },
      licenceShort(r.licence),
    );

    const durChip = r.duration
      ? h('span', { class: 'dur-chip mono', ...tt('Duration') }, timecode(r.duration, false))
      : null;

    return h(
      'div',
      {
        class: `result${importing ? ' importing' : ''}`,
        draggable: importing ? 'false' : 'true',
        ...tt('Drag onto a track', 'Drop it where you want the clip to start.'),
        ondragstart: (e) => {
          const dt = (e as DragEvent).dataTransfer;
          if (!dt || importing) return;
          dt.effectAllowed = 'copy';
          dt.setData(SEARCH_RESULT_DND_TYPE, JSON.stringify(r));
        },
      },
      h(
        'button',
        {
          class: `play-sq${previewing ? ' playing' : ''}`,
          ...tt(previewing ? 'Stop preview' : 'Preview'),
          onclick: (e) => { e.stopPropagation(); this.preview(r); },
        },
        svgIcon(previewing ? 'c-stop' : 'c-play', 10),
      ),
      h(
        'div',
        { class: 'r-main' },
        h('div', { class: 'r-title' }, r.title),
        h('div', { class: 'r-meta' }, importing ? 'Importing…' : meta),
      ),
      durChip ?? document.createComment('no-dur'),
      licChip,
    );
  }

  /** Public so the transport can silence any preview the moment the mix starts playing. */
  stopPreview(): void {
    if (!this.previewAudio.paused) this.previewAudio.pause();
  }

  private preview(r: SoundResult): void {
    if (!r.previewUrl) {
      store.toast('info', 'No preview for this item — drag it onto a track to hear it.');
      return;
    }
    const alreadyPlaying = this.previewingId === r.id && !this.previewAudio.paused;
    if (alreadyPlaying) {
      this.previewAudio.pause();
      return;
    }
    if (store.get().transport.playing) transport.stop(); // never two things playing at once
    this.previewAudio.src = r.previewUrl;
    this.previewingId = r.id;
    this.paintFreesound();
    this.paintArchive();
    void this.previewAudio.play().catch(() => {
      store.toast('warn', 'Could not play preview.');
      this.previewingId = null;
      this.paintFreesound();
      this.paintArchive();
    });
  }

  /** Import at an unspecified track/position (used by the Map tab's row click, and available for programmatic use). */
  private async doImport(r: SoundResult): Promise<void> {
    if (this.importingIds.has(r.id)) return; // already on its way — the timeline placeholder shows progress
    this.importingIds.add(r.id);
    this.paintFreesound();
    this.paintArchive();
    try {
      const res = await importResultToTimeline(r);
      if (!res.ok && res.reason !== 'cancelled') store.toast('warn', res.reason ?? 'Import failed.');
      else if (res.ok) store.toast('info', `Added “${r.title}”.`, 2500);
    } finally {
      this.importingIds.delete(r.id);
      this.paintFreesound();
      this.paintArchive();
    }
  }

  // ---- local file drop / pick ----
  private wireDrop(): void {
    const on = (e: Event) => {
      e.preventDefault();
      this.el.classList.add('drag');
    };
    const off = () => this.el.classList.remove('drag');
    this.el.addEventListener('dragover', on);
    this.el.addEventListener('dragenter', on);
    this.el.addEventListener('dragleave', off);
    this.el.addEventListener('drop', async (e) => {
      e.preventDefault();
      off();
      const dt = (e as DragEvent).dataTransfer;
      if (!dt) return;
      if (dt.getData(ASSET_DND_TYPE) || dt.getData(SEARCH_RESULT_DND_TYPE)) return; // internal drag
      const files = await filesFromDataTransfer(dt);
      if (files.length) await this.ingest(files);
    });
  }

  private pickFiles(): void {
    const input = h('input', { type: 'file', accept: FILE_PICKER_ACCEPT, multiple: true }) as HTMLInputElement;
    input.onchange = () => {
      if (input.files?.length) void this.ingest(Array.from(input.files));
    };
    input.click();
  }

  private async ingest(files: File[]): Promise<void> {
    store.toast('info', `Decoding ${files.length} file${files.length > 1 ? 's' : ''}…`, 60_000);
    const { imported, errors } = await importFiles(files, {
      onProgress: (done, total, name) => {
        if (done < total) store.toast('info', `Decoding ${done + 1}/${total}: ${name}`, 60_000);
      },
    });
    for (const ref of imported) {
      store.mutateProject((p) => {
        p.assets[ref.id] = ref;
      });
    }
    store.patchUi({ discoveryTab: 'mine' });
    if (errors.length) {
      store.toast('error', `${errors.length} file${errors.length > 1 ? 's' : ''} skipped: ${errors[0].reason}`, 7000);
    } else {
      store.toast('info', `Imported ${imported.length} file${imported.length > 1 ? 's' : ''}. They’re in “Mine” — drag onto a track.`);
    }
  }
}
