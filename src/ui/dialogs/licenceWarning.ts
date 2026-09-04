/*
 * Import warning — badge, WARN, allow (concept §6.2). Importing NC/ND material
 * raises this unmissable warning; the student may proceed and the decision is
 * recorded (`restrictionAcknowledged`).
 */

import { openDialog } from './base';
import { h } from '../dom';
import { importWarningFor, NON_DISTRIBUTION_NOTICE } from '../../licence/warnings';
import type { Licence } from '../../state/project';

export function confirmRestrictedImport(licence: Licence, title: string): Promise<boolean> {
  const warn = importWarningFor(licence);
  if (!warn.needed) return Promise.resolve(true);

  return new Promise((resolve) => {
    openDialog((close) => {
      const done = (ok: boolean) => {
        close();
        resolve(ok);
      };
      return h(
        'div',
        { class: 'dialog' },
        h('h3', {}, warn.title),
        h('p', {}, `“${title}”`),
        h('div', { class: 'warn-box' }, warn.body),
        warn.derivativeConflict
          ? h('p', { style: 'font-size:12px' },
              'Creative Commons NoDerivatives forbids derivative works — and layering a recording into a soundscape ' +
                'is a derivative. This is the sharp case: you can study with it and hand it in, but you cannot publish the result.')
          : document.createComment('nd-only'),
        h('div', { class: 'danger-box' }, NON_DISTRIBUTION_NOTICE),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', onclick: () => done(false) }, 'Don’t import'),
          h('button', { class: 'btn primary', onclick: () => done(true) }, 'I understand — import anyway'),
        ),
      );
    });
  });
}
