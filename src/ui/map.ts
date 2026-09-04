/*
 * Leaflet map for geographic discovery (concept §5). OpenStreetMap tiles,
 * Nominatim geocoding, drop-a-pin, radius chips, clustered-ish result pins,
 * a mono coordinate readout. 78k items will not render individually, so we only
 * ever show the current radius search's results.
 *
 * mountMap() is called ONCE per visit to the Map tab (Discovery guards
 * against remounting on unrelated state changes — see discovery.ts). All
 * per-row state (which result is importing, which is previewing) therefore
 * lives in this closure and repaints only the results list, never the map.
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { h, clear, svgIcon, timecode } from './dom';
import { tt } from './tooltip';
import type { SoundResult } from '../sources/types';
import type { LatLon } from '../sources/geo';

export interface MapOptions {
  radii: number[];
  onSearch(centre: LatLon, radiusKm: number): Promise<SoundResult[]>;
  onPreview(r: SoundResult): void;
  onImport(r: SoundResult): Promise<void>;
  /** shared with the rest of Discovery so only one thing ever plays at once */
  previewAudio: HTMLAudioElement;
}

export function mountMap(host: HTMLElement, opts: MapOptions): void {
  clear(host);
  let radiusKm = opts.radii.includes(5) ? 5 : opts.radii[0];
  let centre: LatLon = { lat: 53.4808, lon: -2.2426 }; // Manchester
  let currentResults: SoundResult[] = [];
  const importingIds = new Set<string>();

  const searchInput = h('input', {
    type: 'text',
    placeholder: 'Place — Manchester, Berlin, Tokyo…',
    onkeydown: (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void geocode((e.target as HTMLInputElement).value);
    },
  }) as HTMLInputElement;

  const mapEl = h('div', { style: 'height:184px;margin:0 14px;border:1px solid var(--border);border-radius:4px;overflow:hidden' });
  const coordEl = h('div', {
    class: 'mono',
    style: 'position:absolute;left:8px;bottom:7px;font-size:9px;color:var(--text-faint);background:var(--map-bg);padding:2px 5px;border-radius:2px;z-index:500',
  }, coordText());

  const radiusRow = h('div', { class: 'radius-row' });
  const countEl = h('span', { class: 'count' }, '');
  const resultsEl = h('div', { class: 'scroll', style: 'flex:1' });

  host.append(
    h('div', { class: 'pad' }, h('div', { class: 'field' }, h('span', {}, '⌕'), searchInput)),
    h('div', { style: 'position:relative' }, mapEl, coordEl),
    radiusRow,
    resultsEl,
  );

  const map = L.map(mapEl, { attributionControl: false, zoomControl: true }).setView([centre.lat, centre.lon], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

  let pin = L.marker([centre.lat, centre.lon], { draggable: true }).addTo(map);
  let circle = L.circle([centre.lat, centre.lon], { radius: radiusKm * 1000, color: '#5ee0c0', weight: 1, dashArray: '3 3', fillOpacity: 0.05 }).addTo(map);
  let resultLayer = L.layerGroup().addTo(map);

  function coordText(): string {
    return `${Math.abs(centre.lat).toFixed(4)} ${centre.lat >= 0 ? 'N' : 'S'} · ${Math.abs(centre.lon).toFixed(4)} ${centre.lon >= 0 ? 'E' : 'W'}`;
  }
  function refreshCentre(latlng: L.LatLng): void {
    centre = { lat: latlng.lat, lon: latlng.lng };
    circle.setLatLng(latlng);
    coordEl.textContent = coordText();
  }

  pin.on('dragend', () => {
    refreshCentre(pin.getLatLng());
    void doSearch();
  });
  map.on('click', (e: L.LeafletMouseEvent) => {
    pin.setLatLng(e.latlng);
    refreshCentre(e.latlng);
    void doSearch();
  });

  function renderRadii(): void {
    clear(radiusRow);
    for (const r of opts.radii) {
      radiusRow.append(
        h(
          'button',
          {
            class: `radius-chip${r === radiusKm ? ' active' : ''}`,
            ...tt('Search radius', `Recordings within ${r} km of the pin. 78,000 field recordings are mapped worldwide.`),
            onclick: () => {
              radiusKm = r;
              circle.setRadius(r * 1000);
              renderRadii();
              void doSearch();
            },
          },
          String(r),
        ),
      );
    }
    radiusRow.append(countEl);
  }
  renderRadii();

  async function geocode(q: string): Promise<void> {
    if (!q.trim()) return;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
        headers: { 'Accept-Language': 'en' },
      });
      const arr = (await res.json()) as Array<{ lat: string; lon: string }>;
      if (!arr.length) return;
      const ll = L.latLng(parseFloat(arr[0].lat), parseFloat(arr[0].lon));
      map.setView(ll, 12);
      pin.setLatLng(ll);
      refreshCentre(ll);
      void doSearch();
    } catch {
      /* ignore geocode failure */
    }
  }

  function isPreviewing(r: SoundResult): boolean {
    return !opts.previewAudio.paused && !!r.previewUrl && opts.previewAudio.src === r.previewUrl;
  }

  function renderResultsList(): void {
    clear(resultsEl);
    if (currentResults.length === 0) {
      resultsEl.append(
        h('div', { class: 'empty' }, 'No field recordings within that radius. Try a wider radius or a different place.'),
      );
      return;
    }
    for (const r of currentResults.slice(0, 80)) {
      const importing = importingIds.has(r.id);
      const previewing = isPreviewing(r);
      const durChip = r.duration
        ? h('span', { class: 'dur-chip mono', ...tt('Duration') }, timecode(r.duration, false))
        : null;

      resultsEl.append(
        h(
          'div',
          { class: `result${importing ? ' importing' : ''}` },
          h(
            'button',
            {
              class: `play-sq${previewing ? ' playing' : ''}`,
              ...tt(previewing ? 'Stop preview' : 'Preview'),
              onclick: (e) => { e.stopPropagation(); opts.onPreview(r); },
            },
            svgIcon(previewing ? 'c-stop' : 'c-play', 10),
          ),
          h(
            'div',
            {
              class: 'r-main',
              onclick: async () => {
                if (importingIds.has(r.id)) return;
                importingIds.add(r.id);
                renderResultsList();
                try {
                  await opts.onImport(r);
                } finally {
                  importingIds.delete(r.id);
                  renderResultsList();
                }
              },
            },
            h('div', { class: 'r-title' }, r.title),
            h(
              'div',
              { class: 'r-meta' },
              importing
                ? 'Importing…'
                : `${r.location ? `${Math.abs(r.location.lat).toFixed(4)} ${r.location.lat >= 0 ? 'N' : 'S'} ${Math.abs(r.location.lon).toFixed(4)} ${r.location.lon >= 0 ? 'E' : 'W'}` : ''} · ${(r.distanceKm ?? 0).toFixed(1)} KM`,
            ),
          ),
          durChip ?? document.createComment('no-dur'),
          h('span', { class: 'lic ' + (r.licence.id === 'unknown' ? 'unknown' : 'warn') }, r.licence.id === 'unknown' ? '?' : 'NC-ND'),
        ),
      );
    }
  }
  // Repaint play/pause state when the shared preview element changes — no
  // full remount, so this never touches the pin, radius or search results.
  opts.previewAudio.addEventListener('play', renderResultsList);
  opts.previewAudio.addEventListener('pause', renderResultsList);
  opts.previewAudio.addEventListener('ended', renderResultsList);

  async function doSearch(): Promise<void> {
    countEl.textContent = '…';
    clear(resultsEl);
    resultsEl.append(h('div', { class: 'empty' }, 'Searching…'));
    let results: SoundResult[];
    try {
      results = await opts.onSearch(centre, radiusKm);
    } catch (err) {
      countEl.textContent = '';
      clear(resultsEl);
      resultsEl.append(
        h('div', { class: 'empty', style: 'color:var(--warn)' }, err instanceof Error ? err.message : 'Map search failed.'),
      );
      resultLayer.clearLayers();
      currentResults = [];
      return;
    }
    currentResults = results;
    countEl.textContent = `${results.length} FOUND`;
    resultLayer.clearLayers();
    for (const r of results) {
      if (!r.location) continue;
      const m = L.circleMarker([r.location.lat, r.location.lon], {
        radius: 4,
        color: '#6ba8ff',
        weight: 1,
        fillOpacity: 0.6,
      });
      m.on('click', () => opts.onPreview(r));
      resultLayer.addLayer(m);
    }
    renderResultsList();
  }

  setTimeout(() => map.invalidateSize(), 50);
  void doSearch();
}
