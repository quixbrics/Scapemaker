/*
 * Autosave recovery. This is the first thing a student sees if their last
 * session ended badly, and it used to be a bare window.confirm fired before
 * the app had finished painting — no project name, no sense of how much work
 * was in there, and a "Cancel" that silently deleted the snapshot.
 */

import { openDialog } from './base';
import { h, timecode } from '../dom';
import { contentEnd, type Project } from '../../state/project';

export type RecoveryChoice = 'recover' | 'discard';

function describe(project: Project): string {
  const clips = project.tracks.reduce((n, t) => n + t.clips.length, 0);
  const tracks = project.tracks.filter((t) => t.clips.length > 0).length;
  if (clips === 0) return 'No clips yet.';
  const length = timecode(contentEnd(project), false);
  return (
    `${clips} clip${clips === 1 ? '' : 's'} across ${tracks} track${tracks === 1 ? '' : 's'}, ` +
    `${length} of material.`
  );
}

function when(savedAt: number): string {
  const mins = Math.round((Date.now() - savedAt) / 60000);
  if (mins < 1) return 'less than a minute ago';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return new Date(savedAt).toLocaleString();
}

export function askToRecoverSession(project: Project, savedAt: number): Promise<RecoveryChoice> {
  return new Promise((resolve) => {
    openDialog((close) => {
      const choose = (choice: RecoveryChoice) => () => {
        close();
        resolve(choice);
      };
      return h(
        'div',
        { class: 'dialog' },
        h('h3', {}, 'Pick up where you left off?'),
        h(
          'p',
          {},
          `ScapeMaker saved “${project.name}” automatically ${when(savedAt)}. ${describe(project)}`,
        ),
        h(
          'p',
          { style: 'color:var(--text-faint);font-size:11.5px' },
          'Audio is restored from this machine’s cache where it is still there. ' +
            'Starting fresh discards the automatic save — it does not touch any ' +
            '.scapemaker file you saved yourself.',
        ),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', onclick: choose('discard') }, 'Start fresh'),
          h('button', { class: 'btn primary', onclick: choose('recover') }, 'Recover'),
        ),
      );
    });
  });
}
