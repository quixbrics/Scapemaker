/*
 * The keyboard sheet (? or the ? button on the timeline toolbar). Bindings
 * follow Premiere Pro / Audition where there is an obvious equivalent, so
 * what students learn here carries over.
 */

import { h } from '../dom';
import { openDialog } from './base';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';
const ALT = isMac ? '⌥' : 'Alt';

const GROUPS: Array<[string, Array<[string, string]>]> = [
  [
    'Tools',
    [
      ['V', 'Select'],
      ['C', 'Razor — click a clip to cut it'],
      ['T', 'Trim'],
      ['F', 'Crossfade (Advanced)'],
      ['R', 'Loop (Advanced)'],
      ['S', 'Snap on / off'],
    ],
  ],
  [
    'Editing',
    [
      [`${ALT} + drag`, 'Copy a clip instead of moving it'],
      [`${MOD} + drag`, 'Ignore snap for this drag'],
      ['Esc (while dragging)', 'Cancel the drag'],
      [`Shift + razor click`, 'Cut every track at that point'],
      [`${MOD} + K`, 'Split the selected clip at the playhead'],
      [`${MOD} + Shift + K`, 'Split every track at the playhead'],
      [`${MOD} + C / X / V`, 'Copy / cut / paste at the playhead'],
      ['D', 'Duplicate the selected clip'],
      ['Delete', 'Delete the selected clip'],
      ['← →', 'Nudge the selected clip 0.1 s (Shift: 1 s)'],
      [`${MOD} + Z / Shift + ${MOD} + Z`, 'Undo / redo'],
    ],
  ],
  [
    'Playback and view',
    [
      ['Space', 'Play / stop'],
      ['L', 'Loop playback on / off'],
      ['Home / End', 'Go to the start / end'],
      ['↑ ↓', 'Previous / next clip edge'],
      ['← →', 'Move the playhead (no clip selected)'],
      [`${ALT} + scroll`, 'Zoom the timeline around the pointer'],
      ['= / −', 'Zoom in / out'],
      ['\\', 'Zoom to fit the whole piece'],
      ['`', 'Hide both side panels — timeline only'],
      ['?', 'This sheet'],
    ],
  ],
  [
    'Files',
    [
      [`${MOD} + S`, 'Save (Shift: save a copy)'],
      [`${MOD} + O`, 'Open'],
      [`${MOD} + E`, 'Export'],
    ],
  ],
];

export function openShortcutSheet(): void {
  openDialog((close) =>
    h(
      'div',
      { class: 'dialog shortcut-sheet', role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
      h('h3', {}, 'Keyboard shortcuts'),
      h('p', {}, 'Borrowed from Premiere Pro and Audition wherever there is an equivalent.'),
      ...GROUPS.map(([title, rows]) =>
        h(
          'section',
          { class: 'sc-group' },
          h('h4', {}, title),
          h('dl', {}, ...rows.flatMap(([keys, what]) => [h('dt', {}, h('kbd', {}, keys)), h('dd', {}, what)])),
        ),
      ),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: close }, 'Close')),
    ),
  );
}
