import { h, clear } from '../dom';

let host: HTMLElement | null = null;

function getHost(): HTMLElement {
  if (!host) {
    host = h('div');
    document.body.append(host);
  }
  return host;
}

export interface DialogHandle {
  close(): void;
  root: HTMLElement;
}

export function openDialog(build: (close: () => void) => HTMLElement): DialogHandle {
  const hostEl = getHost();
  const close = () => clear(hostEl);
  const dialog = build(close);
  const overlay = h(
    'div',
    {
      class: 'overlay',
      onpointerdown: (e) => {
        if (e.target === e.currentTarget) close();
      },
    },
    dialog,
  );
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
      window.removeEventListener('keydown', onKey);
    }
  };
  window.addEventListener('keydown', onKey);
  clear(hostEl);
  hostEl.append(overlay);
  return { close, root: dialog };
}
