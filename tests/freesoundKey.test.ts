/*
 * Key storage. Students often share edit-suite machines, so the default must
 * not outlive the browser session.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

async function freshModule() {
  vi.stubGlobal('sessionStorage', fakeStorage());
  vi.stubGlobal('localStorage', fakeStorage());
  vi.resetModules();
  return import('../src/sources/freesound');
}

describe('freesound key storage', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('keeps the key for the session only by default', async () => {
    const fs = await freshModule();
    fs.setKey('abc123');
    expect(fs.getKey()).toBe('abc123');
    expect(sessionStorage.getItem('scapemaker.freesound.key')).toBe('abc123');
    expect(localStorage.getItem('scapemaker.freesound.key')).toBeNull();
    expect(fs.keyIsRemembered()).toBe(false);
  });

  it('persists only when asked to', async () => {
    const fs = await freshModule();
    fs.setKey('abc123', true);
    expect(localStorage.getItem('scapemaker.freesound.key')).toBe('abc123');
    expect(fs.keyIsRemembered()).toBe(true);
  });

  it('stops remembering when reconnected without the box ticked', async () => {
    const fs = await freshModule();
    fs.setKey('old', true);
    expect(fs.keyIsRemembered()).toBe(true);
    fs.setKey('new');
    expect(fs.keyIsRemembered()).toBe(false);
    expect(fs.getKey()).toBe('new');
  });

  it('forgets from both stores', async () => {
    const fs = await freshModule();
    fs.setKey('abc123', true);
    fs.forgetKey();
    expect(fs.getKey()).toBeNull();
    expect(sessionStorage.getItem('scapemaker.freesound.key')).toBeNull();
    expect(localStorage.getItem('scapemaker.freesound.key')).toBeNull();
  });

  it('finds a key a previous version left in localStorage', async () => {
    vi.stubGlobal('sessionStorage', fakeStorage());
    const local = fakeStorage();
    local.setItem('scapemaker.freesound.key', 'legacy');
    vi.stubGlobal('localStorage', local);
    vi.resetModules();
    const fs = await import('../src/sources/freesound');
    expect(fs.getKey()).toBe('legacy');
  });

  it('survives storage being blocked entirely', async () => {
    const blocked = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    } as unknown as Storage;
    vi.stubGlobal('sessionStorage', blocked);
    vi.stubGlobal('localStorage', blocked);
    vi.resetModules();
    const fs = await import('../src/sources/freesound');
    expect(() => fs.setKey('abc')).not.toThrow();
    expect(fs.getKey()).toBe('abc');       // in memory for this tab
    expect(() => fs.forgetKey()).not.toThrow();
  });
});
