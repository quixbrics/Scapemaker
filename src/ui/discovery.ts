/*
 * Left panel — Discovery (UI spec §4.2). Tabs: Freesound · Archive · Map · Mine.
 * The whole panel is a drop target for local files (the primary import path).
 * A paste-a-URL field sits under Freesound.
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

export class Discovery {
  readonly el: HTMLElement;
  private tabsEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private previewAudio = new Audio();
  private mapModule: typeof import('./map') | null = null;
  private results: SoundResult[] = [];
  private busy = false;
  private lastError: string | null = null;
  private currentTab!: DiscoveryTab;
  private importingIds = new Set<string>();
  private previewingId: string | null = null;

  constructor() {
    this.el = h('div', { class: 'panel-left' });
    this.tabsEl = h('div', { class: 'tabs' });
    this.contentEl = h('div', { class: 'scroll', style: 'display:flex;flex-direction:column;min-height:0;flex:1' });
    const drop = h(
      'div',
      { class: 'dropzone', onclick: () => this.pickFiles() },
      svgIcon('c-file', 14),
      h('span', {}, 'Drop your own recordings here'),
    );
    this.el.append(this.tabsEl, this.contentEl, drop);
    this.wireDrop();
    const clearPreview = () => {
      this.previewingId = null;
      this.paintResults();
    };
    this.previewAudio.addEventListener('ended', clearPreview);
    this.previewAudio.addEventListener('pause', clearPreview);
    this.renderTabs(store.get());
    this.renderContent(store.get());
    this.currentTab = store.get().ui.discoveryTab;
    store.subscribe((s, changed) => {
      if (changed.has('ui')) {
        this.renderTabs(s);
        // Only tear down and rebuild the content pane when the TAB itself
        // changes. Rebuilding on every unrelated ui change (a toast timing
        // out, a clip selection, a tool switch...) used to remount the map —
        // resetting the pin to Manchester and re-running the search — and
        // wiped in-progress search text on Archive/Freesound.
        if (s.ui.discoveryTab !== this.currentTab) {
          this.currentTab = s.ui.discoveryTab;
          this.renderContent(s);
        }
      }
      if (changed.has('project') && s.ui.discoveryTab === 'mine') this.renderContent(s);
    });
  }

  // ---- tabs ----
  private renderTabs(s: AppState): void {
    clear(this.tabsEl);
    const tabs: [DiscoveryTab, string][] = [
      ['freesound', 'Freesound'],
      ['archive', 'Archive'],
      ['map', 'Map'],
      ['mine', 'Mine'],
    ];
    for (const [id, label] of tabs) {
      this.tabsEl.append(
        h(
          'button',
          {
            class: s.ui.discoveryTab === id ? 'active' : '',
            onclick: () => {
              this.results = [];
              this.lastError = null;
              store.patchUi({ discoveryTab: id });
            },
          },
          label,
        ),
      );
    }
  }

  // ---- content dispatch ----
  private renderContent(s: AppState): void {
    clear(this.contentEl);
    switch (s.ui.discoveryTab) {
      case 'freesound':
        return this.renderFreesound();
      case 'archive':
        return this.renderTextSearch('archive');
      case 'map':
        return void this.renderMap();
      case 'mine':
        return this.renderMine(s);
    }
  }

  // ---- Mine (imported bin) ----
  private renderMine(s: AppState): void {
    const refs = Object.values(s.project.assets);
    if (refs.length === 0) {
      this.contentEl.append(
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
    const list = h('div', { style: 'padding:4px 6px' });
    for (const ref of refs) {
      list.append(this.assetRow(ref));
    }
    this.contentEl.append(list);
  }

  private assetRow(ref: AssetRef): HTMLElement {
    const tone = licenceTone(ref.licence);
    const entry = assetStore.peek(ref.id);
    const dur = entry?.buffer.duration ?? ref.duration;
    const row = h(
      'div',
      {
        class: 'result',
        draggable: 'true',
        ondragstart: (e) => {
          (e as DragEvent).dataTransfer?.setData('application/x-scapemaker-asset', ref.id);
        },
        onclick: () => placeLocalAsset(ref),
        ...tt('Add to timeline', 'Click to drop on the first empty track, or drag onto a lane.'),
      },
      h('div', { class: 'play-sq' }, svgIcon('c-plus', 10)),
      h(
        'div',
        { class: 'r-main' },
        h('div', { class: 'r-title' }, ref.title),
        h('div', { class: 'r-meta' }, `${ref.author} · ${timecode(dur, false)}`),
      ),
      h('span', { class: `lic ${tone}` }, licenceShort(ref.licence)),
    );
    return row;
  }

  // ---- text search (Archive) ----
  private renderTextSearch(_source: 'archive'): void {
    const input = h('input', {
      type: 'text',
      placeholder: 'Search the Internet Archive…',
      onkeydown: (e) => {
        if ((e as KeyboardEvent).key === 'Enter') this.runTextSearch('archive', (e.target as HTMLInputElement).value);
      },
    }) as HTMLInputElement;
    this.contentEl.append(
      h('div', { class: 'pad' }, h('div', { class: 'field' }, svgIcon('c-search', 14), input)),
      this.resultsContainer(),
    );
  }

  private async runTextSearch(_source: 'archive', query: string): Promise<void> {
    if (!query.trim()) return;
    this.setBusy(true);
    try {
      const page = await searchArchive(query, { pageSize: 40 });
      this.results = page.results;
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'Search failed.';
      this.results = [];
    } finally {
      this.setBusy(false);
      this.paintResults();
    }
  }

  // ---- Freesound ----
  private renderFreesound(): void {
    if (!hasKey()) {
      this.contentEl.append(this.freesoundKeyPanel());
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

    this.contentEl.append(
      h(
        'div',
        { class: 'pad' },
        h('div', { class: 'field' }, svgIcon('c-search', 14), input),
        h('div', { class: 'field', style: 'margin-top:8px' }, svgIcon('c-file', 14), pasteInput),
        h(
          'button',
          { class: 'linkish', style: 'margin-top:8px;font-size:11px', onclick: () => { forgetKey(); this.renderContent(store.get()); } },
          'Forget key on this machine',
        ),
      ),
      this.resultsContainer(),
    );
  }

  private freesoundKeyPanel(): HTMLElement {
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
          this.renderContent(store.get());
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
    this.setBusy(true);
    try {
      const page = await searchFreesound(query, { pageSize: 40 });
      this.results = page.results;
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'Search failed.';
      this.results = [];
    } finally {
      this.setBusy(false);
      this.paintResults();
    }
  }

  private async runPaste(url: string): Promise<void> {
    if (!url.trim()) return;
    this.setBusy(true);
    try {
      const resolved = await resolveFreesoundUrl(url);
      if (resolved.needsLicenceChoice) {
        // ask for licence via a small inline prompt
        const id = window.prompt(
          `No key set, so the licence can't be read automatically.\nType the licence id for "${resolved.result.title}":\n${ALL_LICENCE_IDS.join(', ')}`,
          'by',
        );
        if (id && ALL_LICENCE_IDS.includes(id as never)) {
          resolved.result.licence = makeLicence(id as never);
        }
      }
      this.results = [resolved.result, ...this.results];
      this.lastError = resolved.needsLicenceChoice
        ? 'Imported from URL with no API call. Download the file from Freesound and drag it in to add the audio.'
        : null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'Could not resolve that URL.';
    } finally {
      this.setBusy(false);
      this.paintResults();
    }
  }

  // ---- Map ----
  private async renderMap(): Promise<void> {
    const host = h('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0' });
    this.contentEl.append(host);
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

  // ---- results list ----
  private resultsHost: HTMLElement | null = null;
  private resultsContainer(): HTMLElement {
    this.resultsHost = h('div', { class: 'scroll', style: 'flex:1' });
    this.paintResults();
    return this.resultsHost;
  }

  private paintResults(): void {
    // Deliberately NOT falling back to a generic `.scroll` querySelector: the
    // Map tab has its own `.scroll` results list (owned entirely by map.ts)
    // and grabbing it here used to overwrite it with Discovery's stale
    // `this.results` the moment a map preview/import ran.
    const host = this.resultsHost;
    if (!host || !host.isConnected) return;
    clear(host);
    if (this.busy) {
      host.append(h('div', { class: 'empty' }, 'Searching…'));
      return;
    }
    if (this.lastError) host.append(h('div', { class: 'empty', style: 'color:var(--warn)' }, this.lastError));
    if (this.results.length === 0 && !this.lastError) {
      host.append(h('div', { class: 'empty' }, 'No results yet.'));
      return;
    }
    host.append(h('div', { class: 'radius-row' }, h('span', { class: 'count' }, `${this.results.length} FOUND`)));
    for (const r of this.results) host.append(this.resultRow(r));
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
      { class: `result${importing ? ' importing' : ''}` },
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
        { class: 'r-main', onclick: () => this.doImport(r) },
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
      store.toast('info', 'No preview for this item — import it to hear it on the timeline.');
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
    this.paintResults();
    void this.previewAudio.play().catch(() => {
      store.toast('warn', 'Could not play preview.');
      this.previewingId = null;
      this.paintResults();
    });
  }

  private async doImport(r: SoundResult): Promise<void> {
    if (this.importingIds.has(r.id)) return; // already on its way — the timeline placeholder shows progress
    this.importingIds.add(r.id);
    this.paintResults();
    try {
      const res = await importResultToTimeline(r);
      if (!res.ok && res.reason !== 'cancelled') store.toast('warn', res.reason ?? 'Import failed.');
      else if (res.ok) store.toast('info', `Added “${r.title}”.`, 2500);
    } finally {
      this.importingIds.delete(r.id);
      this.paintResults();
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
      if (dt.getData('application/x-scapemaker-asset')) return; // internal drag
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

  private setBusy(v: boolean): void {
    this.busy = v;
    if (v) this.paintResults();
  }
}
