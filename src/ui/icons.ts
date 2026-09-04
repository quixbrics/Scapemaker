/* SVG symbol sheet — glyphs lifted from the reference mockups. Injected once. */

const SYMBOLS = `
<symbol id="c-play" viewBox="0 0 20 20"><path d="M6 4.2 15.2 10 6 15.8Z" fill="currentColor"/></symbol>
<symbol id="c-stop" viewBox="0 0 20 20"><rect x="5.8" y="5.8" width="8.4" height="8.4" fill="currentColor"/></symbol>
<symbol id="c-start" viewBox="0 0 20 20"><path d="M6 5v10M15 5.2 7.6 10 15 14.8Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
<symbol id="c-loop" viewBox="0 0 20 20"><path d="M4.5 8.5a4 4 0 0 1 4-4h6M15.5 11.5a4 4 0 0 1-4 4h-6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M12.6 2.6 15.2 4.5l-2.6 1.9M7.4 13.6 4.8 15.5l2.6 1.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="c-cursor" viewBox="0 0 20 20"><path d="M5 3.5 15 10.4l-4.2.7 2.4 4.6-1.9 1-2.4-4.6-2.9 3Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></symbol>
<symbol id="c-trim" viewBox="0 0 20 20"><path d="M5 4v12M15 4v12M8 10h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>
<symbol id="c-split" viewBox="0 0 20 20"><path d="M10 3v14M6 7l4-4 4 4M6 13l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="c-fade" viewBox="0 0 20 20"><path d="M3 15 17 5v10Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></symbol>
<symbol id="c-search" viewBox="0 0 20 20"><circle cx="9" cy="9" r="5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m12.8 12.8 3.4 3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>
<symbol id="c-pin" viewBox="0 0 20 20"><path d="M10 17.5s5.4-5.3 5.4-8.8A5.4 5.4 0 0 0 4.6 8.7c0 3.5 5.4 8.8 5.4 8.8Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="8.7" r="2" fill="currentColor"/></symbol>
<symbol id="c-file" viewBox="0 0 20 20"><path d="M5 3h6l4 4v10H5Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M11 3v4h4" fill="none" stroke="currentColor" stroke-width="1.3"/></symbol>
<symbol id="c-down" viewBox="0 0 20 20"><path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="c-warn" viewBox="0 0 20 20"><path d="M10 3.4 17.6 16H2.4Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M10 8v3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="10" cy="13.6" r=".85" fill="currentColor"/></symbol>
<symbol id="c-sun" viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10 2.4v2M10 15.6v2M2.4 10h2M15.6 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M15.4 4.6 14 6M6 14l-1.4 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>
<symbol id="c-moon" viewBox="0 0 20 20"><path d="M16 12.4A6.8 6.8 0 0 1 7.6 4a6.9 6.9 0 1 0 8.4 8.4Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
<symbol id="c-wave" viewBox="0 0 20 20"><path d="M3 10h1.6M6.4 6.2v7.6M9.2 3.6v12.8M12 7.4v5.2M14.8 5v10M17.4 8.6v2.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
<symbol id="c-plus" viewBox="0 0 20 20"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
<symbol id="c-trash" viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="c-dup" viewBox="0 0 20 20"><rect x="4" y="4" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 16h9V7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></symbol>
`;

export function installIconSheet(): void {
  if (document.getElementById('sm-icons')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'sm-icons';
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('style', 'position:absolute');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = SYMBOLS;
  svg.append(defs);
  document.body.prepend(svg);
}
