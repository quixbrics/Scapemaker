/*
 * The right-hand panel is two things: the Inspector (whatever is selected) and
 * the Reflection (the whole project). Same tab pattern as Discovery on the
 * left. Both panes stay mounted — swapping `hidden` keeps a half-written
 * reflection alive while the student goes back to trimming a clip.
 */

import { store, type RightTab } from '../state/store';
import { h } from './dom';
import { tt } from './tooltip';
import { Inspector } from './inspector';
import { ReflectionPanel, reflectionProgress } from './reflection';

const TABS: Array<{ id: RightTab; label: string; sub: string }> = [
  { id: 'inspector', label: 'Inspector', sub: 'Source, gain, fades and effects for what you have selected' },
  { id: 'reflection', label: 'Reflection', sub: 'Atmosphere, intention and the decisions you made' },
];

export class RightPanel {
  readonly el: HTMLElement;
  private buttons = new Map<RightTab, HTMLElement>();
  private panes: Record<RightTab, HTMLElement>;
  private dot = h('span', { class: 'tab-dot' });

  constructor() {
    const inspector = new Inspector();
    const reflection = new ReflectionPanel();
    this.panes = { inspector: inspector.el, reflection: reflection.el };

    const tabs = h('div', { class: 'tabs' });
    for (const tab of TABS) {
      const btn = h(
        'button',
        { ...tt(tab.label, tab.sub), onclick: () => store.patchUi({ rightTab: tab.id }) },
        tab.label,
        tab.id === 'reflection' ? this.dot : null,
      );
      this.buttons.set(tab.id, btn);
      tabs.append(btn);
    }

    this.el = h('div', { class: 'panel-right' }, tabs, inspector.el, reflection.el);

    this.apply(store.get().ui.rightTab);
    this.updateDot();
    store.subscribe((s, changed) => {
      if (changed.has('ui')) this.apply(s.ui.rightTab);
      if (changed.has('project')) this.updateDot();
    });
  }

  private apply(active: RightTab): void {
    for (const [id, btn] of this.buttons) btn.classList.toggle('active', id === active);
    for (const [id, pane] of Object.entries(this.panes) as Array<[RightTab, HTMLElement]>) {
      pane.hidden = id !== active;
    }
  }

  /** A quiet mark on the tab while any prompt is still unanswered. */
  private updateDot(): void {
    const { written, total } = reflectionProgress(store.get().project.reflection);
    this.dot.hidden = written === total;
  }
}
