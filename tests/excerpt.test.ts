/*
 * Keeping part of a recording too long for audio memory: the cut itself, the
 * asset record it becomes, and how long a section fits.
 */

import { describe, expect, it } from 'vitest';
import { sliceBuffer, bytesPerSecond, cacheKey } from '../src/audio/assetStore';
import { excerptRef, maxExcerptSeconds } from '../src/sources/excerpt';
import { makeLicence } from '../src/licence/model';
import type { AssetRef } from '../src/state/project';
import { FakeAudioBuffer } from './helpers/fakeAudioBuffer';

const make = (c: number, l: number, r: number) => new FakeAudioBuffer(c, l, r);

describe('sliceBuffer', () => {
  it('copies exactly the requested samples from every channel', () => {
    const src = new FakeAudioBuffer(2, 100, 10); // 10 s at 10 Hz
    for (let c = 0; c < 2; c++) src.getChannelData(c).forEach((_, i, a) => (a[i] = i + c * 1000));
    const out = sliceBuffer(src, 3, 2, make);
    expect(out.length).toBe(20);
    expect(out.numberOfChannels).toBe(2);
    expect(out.sampleRate).toBe(10);
    expect(out.getChannelData(0)[0]).toBe(30);
    expect(out.getChannelData(0)[19]).toBe(49);
    expect(out.getChannelData(1)[0]).toBe(1030);
  });

  it('stops at the end of the recording rather than running past it', () => {
    const out = sliceBuffer(new FakeAudioBuffer(1, 100, 10), 8, 5, make);
    expect(out.length).toBe(20);
  });
});

const original: AssetRef = {
  id: 'archive:field-walk',
  title: 'Harbour walk',
  source: 'archive',
  sourceId: 'field-walk',
  sourceUrl: 'https://archive.org/details/field-walk',
  downloadUrl: 'https://archive.org/download/field-walk/walk.mp3',
  author: 'A. Recordist',
  licence: makeLicence('by-nc'),
  duration: 4320,
  sampleRate: 48000,
  channels: 2,
  importedAt: '2026-09-25T00:00:00Z',
  cached: true,
};

describe('excerptRef', () => {
  it('keeps the credit and licence, and says which part it is', () => {
    const ex = excerptRef(original, 720, 600);
    expect(ex).toMatchObject({
      author: original.author,
      licence: original.licence,
      source: 'archive',
      sourceUrl: original.sourceUrl,
      downloadUrl: original.downloadUrl,
      duration: 600,
      excerpt: { of: original.id, start: 720, duration: 600 },
    });
    expect(ex.title).toBe('Harbour walk (12:00–22:00)');
    expect(ex.id).toBe('archive:field-walk@720.0+600.0');
  });

  it('is cached under the original, so the file is stored once', () => {
    expect(cacheKey(excerptRef(original, 0, 60))).toBe(original.id);
    expect(cacheKey(original)).toBe(original.id);
  });

  it('two different sections are two different assets', () => {
    expect(excerptRef(original, 0, 60).id).not.toBe(excerptRef(original, 60, 60).id);
  });
});

describe('maxExcerptSeconds', () => {
  it('turns free memory into a length, leaving slack for the peaks', () => {
    const perSec = bytesPerSecond(48000, 2); // 384 000 B/s
    expect(perSec).toBe(384_000);
    // 600 MB free: 1638 s of samples, 1572 s once 4 % is left for the peaks.
    expect(maxExcerptSeconds(600 * 2 ** 20, 48000, 2)).toBe(1572);
  });

  it('a mono recording gets twice as long', () => {
    expect(maxExcerptSeconds(100 * 2 ** 20, 48000, 2)).toBe(262);
    expect(maxExcerptSeconds(100 * 2 ** 20, 48000, 1)).toBe(524);
  });

  it('no room means no excerpt', () => {
    expect(maxExcerptSeconds(0, 48000, 2)).toBe(0);
  });
});
