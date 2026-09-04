/*
 * Export dialog (concept §10). Four exports: mixdown, stems, sources CSV,
 * reflection. Repeats the non-distribution notice and LISTS the specific
 * assets that triggered it (Build Plan §10 gate).
 */

import { openDialog } from './base';
import { h, clear } from '../dom';
import { store } from '../../state/store';
import { runExport, type ExportSelection } from '../../export';
import { restrictedAssetsInUse, NON_DISTRIBUTION_NOTICE } from '../../licence/warnings';
import { contentEnd } from '../../state/project';

export function openExportDialog(): void {
  openDialog((close) => {
    const project = store.get().project;
    const restricted = restrictedAssetsInUse(project);
    const hasAudio = contentEnd(project) > 0.1;

    const sel: ExportSelection = { mixdown: hasAudio, stems: false, sources: true, reflection: true };
    const status = h('p', { style: 'min-height:18px;color:var(--text-faint)' }, '');
    const bar = h('div', { style: 'height:3px;background:var(--border);margin:6px 0;overflow:hidden' },
      h('div', { style: 'height:3px;width:0%;background:var(--accent);transition:width .2s' }));

    const check = (key: keyof ExportSelection, label: string, hint: string, disabled = false) =>
      h(
        'label',
        {},
        h('input', {
          type: 'checkbox',
          checked: sel[key],
          disabled,
          onchange: (e) => (sel[key] = (e.target as HTMLInputElement).checked),
        }),
        h('span', {}, label),
        h('span', { style: 'color:var(--text-faint);font-size:11px' }, ` — ${hint}`),
      );

    const doExport = async () => {
      const btn = dialog.querySelector<HTMLButtonElement>('.btn.primary')!;
      btn.disabled = true;
      try {
        const report = await runExport(project, sel, (label, frac) => {
          status.textContent = `${label}…`;
          (bar.firstChild as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
        });
        status.textContent = `Done — ${report.files.length} file${report.files.length === 1 ? '' : 's'} downloaded.` +
          (report.clipped ? `  ⚠ mixdown peaks at ${report.peakDb.toFixed(1)} dB (clipping).` : '');
        (bar.firstChild as HTMLElement).style.width = '100%';
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : 'Export failed.';
      } finally {
        btn.disabled = false;
      }
    };

    const dialog = h(
      'div',
      { class: 'dialog' },
      h('h3', {}, 'Export'),
      h('p', {}, `“${project.name}”`),
      h(
        'div',
        { class: 'check-list' },
        check('mixdown', 'Mixdown', `${project.name}_Final.wav (24-bit)`, !hasAudio),
        check('stems', 'Stems', 'one WAV per non-empty track', !hasAudio),
        check('sources', 'Sources CSV', 'every asset, licence and restriction'),
        check('reflection', 'Reflection', 'markdown'),
      ),
      restricted.length > 0
        ? h(
            'div',
            { class: 'danger-box' },
            h('div', { style: 'margin-bottom:8px' }, NON_DISTRIBUTION_NOTICE),
            h('div', { style: 'font-weight:600;margin-bottom:4px' }, 'Assets that triggered this:'),
            h(
              'ul',
              { style: 'margin:0;padding-left:18px' },
              ...restricted.map((r) =>
                h('li', {}, `${r.ref.title} — ${r.ref.licence.name} (on ${r.tracks.join(', ')})`),
              ),
            ),
          )
        : document.createComment('no-restricted'),
      status,
      bar,
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn', onclick: close }, 'Close'),
        h('button', { class: 'btn primary', onclick: doExport }, 'Export selected'),
      ),
    );
    void clear;
    return dialog;
  });
}
