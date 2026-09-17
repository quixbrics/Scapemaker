/*
 * Audio memory meter (Build Plan §6.1: "a visible byte budget").
 *
 * Decoded audio is the one resource this app can genuinely exhaust — a few
 * long field recordings at 48 kHz stereo run to hundreds of megabytes — and
 * until now the budget existed only as a constant nothing read. A student
 * should be able to see the ceiling coming rather than meet it as a dead tab.
 *
 * Built once and patched in place: it updates whenever the asset store
 * changes, and the timeline toolbar around it must not be rebuilt under a
 * pointer.
 */

import { assetStore, formatBytes } from '../audio/assetStore';
import { ensurePersistentStorage, readStorageEstimate, storageSummary } from '../audio/storage';
import { h } from './dom';

export class MemoryMeter {
  readonly el: HTMLElement;
  private bar: HTMLElement;
  private label: HTMLElement;

  constructor() {
    this.bar = h('span', { class: 'mem-fill' });
    this.label = h('span', { class: 'mono-cap' });
    this.el = h('div', { class: 'mem' }, h('span', { class: 'mem-track' }, this.bar), this.label);
    this.update();
    assetStore.subscribe(() => {
      this.update();
      // The tooltip carries the on-disk figure too; refresh it when the set of
      // cached files has plausibly changed, not on a timer.
      void readStorageEstimate().then(() => this.update());
    });
    void ensurePersistentStorage().then(() => this.update());
  }

  private update(): void {
    const used = assetStore.usedBytes;
    const fraction = Math.min(1, assetStore.usedFraction);
    const idle = assetStore.idleBytes();

    this.bar.style.width = `${(fraction * 100).toFixed(1)}%`;
    this.el.classList.toggle('warn', fraction >= 0.8 && fraction < 0.95);
    this.el.classList.toggle('danger', fraction >= 0.95);
    this.label.textContent = `${formatBytes(used)} / ${formatBytes(assetStore.budgetBytes)}`;

    this.el.dataset.tt = 'Audio memory';
    this.el.dataset.ttSub =
      `Decoded audio held in the tab. Clips are views onto it, so copying a clip costs nothing.` +
      (idle > 0
        ? ` ${formatBytes(idle)} belongs to sounds no longer on the timeline and is reclaimed when the memory is wanted.`
        : '') +
      (fraction >= 0.8 ? ' Close to the ceiling — delete clips you are not using.' : '') +
      (storageSummary() ? ` ${storageSummary()}` : '');
  }
}
