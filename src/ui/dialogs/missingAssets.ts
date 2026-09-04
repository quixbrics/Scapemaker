/*
 * Missing-asset report (concept §8): on load, report assets that could not be
 * resolved from IndexedDB or their downloadUrl — never fail silently, never
 * half-open a project without saying so.
 */

import { openDialog } from './base';
import { h } from '../dom';
import type { AssetRef } from '../../state/project';

export function showMissingAssets(missing: AssetRef[], warnings: string[]): Promise<void> {
  if (missing.length === 0 && warnings.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    openDialog((close) => {
      const done = () => {
        close();
        resolve();
      };
      return h(
        'div',
        { class: 'dialog' },
        h('h3', {}, missing.length > 0 ? 'Some sources are missing' : 'Project loaded with a note'),
        warnings.length > 0
          ? h('div', { class: 'warn-box' }, warnings.join(' '))
          : document.createComment('no-warnings'),
        missing.length > 0
          ? h(
              'div',
              {},
              h(
                'p',
                {},
                `The project opened, but ${missing.length} source${missing.length > 1 ? 's' : ''} ` +
                  `could not be found — not cached on this machine, and no working link to fetch from. ` +
                  `The clips are still on the timeline; re-import the file to relink it.`,
              ),
              h(
                'ul',
                { style: 'margin:0;padding-left:18px;font-size:12px;color:var(--text-2)' },
                ...missing.map((r) =>
                  h('li', {}, `${r.title} — ${r.source}${r.sourceUrl ? ` (${r.sourceUrl})` : ''}`),
                ),
              ),
            )
          : document.createComment('none-missing'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: done }, 'OK')),
      );
    });
  });
}
