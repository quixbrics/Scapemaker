/*
 * Reflection panel (concept §9) — the five prompts students answer about their
 * soundscape: atmosphere, narrative intention, emotional intent, location and
 * creative decisions. Stored in the project file, exported as markdown.
 *
 * Writes are debounced rather than per-keystroke: every project mutation wakes
 * the top bar's full rebuild, and rebuilding it sixty times a sentence is
 * pointless. `flushReflectionEdits()` forces the pending write out, and is
 * called before anything that reads the project off the store (save, export).
 */

import { store } from '../state/store';
import { REFLECTION_SECTIONS } from '../export/reflection';
import type { Reflection } from '../state/project';
import { h } from './dom';
import { tt } from './tooltip';

const WRITE_DELAY = 450;

let pending: { key: keyof Reflection; text: string } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function write(key: keyof Reflection, text: string): void {
  const current = store.get().project.reflection[key] ?? '';
  if (current === text) return;
  store.mutateProject((p) => {
    p.reflection[key] = text;
  });
}

/** Push any debounced keystrokes into the store now. */
export function flushReflectionEdits(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending) {
    write(pending.key, pending.text);
    pending = null;
  }
}

function queue(key: keyof Reflection, text: string): void {
  // A different field means the previous one is finished — don't lose it.
  if (pending && pending.key !== key) flushReflectionEdits();
  pending = { key, text };
  if (timer) clearTimeout(timer);
  timer = setTimeout(flushReflectionEdits, WRITE_DELAY);
}

function words(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export class ReflectionPanel {
  readonly el: HTMLElement;
  private lastProjectId = '';
  private countEls = new Map<keyof Reflection, HTMLElement>();

  constructor() {
    this.el = h('div', { class: 'reflection scroll' });
    this.render();
    store.subscribe((s, changed) => {
      // Only rebuild when the project underneath us was replaced (new / open /
      // autosave recovery). Rebuilding on our own keystrokes would replace the
      // textarea the student is typing into.
      if (changed.has('project') && s.project.id !== this.lastProjectId) this.render();
    });
  }

  private render(): void {
    const project = store.get().project;
    this.lastProjectId = project.id;
    this.countEls.clear();
    this.el.replaceChildren();

    this.el.append(
      h(
        'p',
        { class: 'reflection-intro' },
        'Describe what you made and why. This is saved in the project and exported as markdown alongside your mixdown.',
      ),
    );

    for (const section of REFLECTION_SECTIONS) {
      const value = project.reflection[section.key] ?? '';
      const count = h('span', { class: 'reflection-count mono' }, countLabel(value));
      this.countEls.set(section.key, count);

      const area = h('textarea', {
        class: 'reflection-input',
        rows: 4,
        placeholder: section.prompt,
        'aria-label': `${section.label} — ${section.prompt}`,
        oninput: (e) => {
          const text = (e.target as HTMLTextAreaElement).value;
          count.textContent = countLabel(text);
          queue(section.key, text);
        },
        onblur: () => flushReflectionEdits(),
      }) as HTMLTextAreaElement;
      area.value = value;

      this.el.append(
        h(
          'div',
          { class: 'reflection-field' },
          h(
            'div',
            { class: 'reflection-head' },
            h('label', { class: 'section-label', ...tt(section.label, section.prompt) }, section.label),
            count,
          ),
          area,
        ),
      );
    }
  }
}

function countLabel(text: string): string {
  const n = words(text);
  return n === 0 ? '—' : `${n} word${n === 1 ? '' : 's'}`;
}

/** How many of the five prompts have been answered — used by the export dialog. */
export function reflectionProgress(reflection: Reflection): { written: number; total: number } {
  const total = REFLECTION_SECTIONS.length;
  const written = REFLECTION_SECTIONS.filter((s) => (reflection[s.key] ?? '').trim().length > 0).length;
  return { written, total };
}
