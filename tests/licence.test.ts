import { describe, expect, it } from 'vitest';
import { parseLicence, isRestrictive, licenceTone, licenceShort } from '../src/licence/model';
import { importWarningFor, restrictedAssetsInUse } from '../src/licence/warnings';
import { newProject, makeClip, type AssetRef } from '../src/state/project';

describe('parseLicence', () => {
  it('parses CC0 from the publicdomain/zero URL', () => {
    const l = parseLicence('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(l.id).toBe('cc0');
    expect(l.allowsCommercial).toBe(true);
    expect(l.allowsDerivatives).toBe(true);
    expect(isRestrictive(l)).toBe(false);
  });

  it('parses each CC combination from licenses/ URLs', () => {
    const cases: Array<[string, string]> = [
      ['http://creativecommons.org/licenses/by/4.0/', 'by'],
      ['http://creativecommons.org/licenses/by-sa/3.0/', 'by-sa'],
      ['http://creativecommons.org/licenses/by-nc/3.0/', 'by-nc'],
      ['http://creativecommons.org/licenses/by-nd/3.0/', 'by-nd'],
      ['http://creativecommons.org/licenses/by-nc-sa/4.0/', 'by-nc-sa'],
      ['http://creativecommons.org/licenses/by-nc-nd/3.0/', 'by-nc-nd'],
    ];
    for (const [url, id] of cases) expect(parseLicence(url).id).toBe(id);
  });

  it('classifies NC and ND as restrictive, BY/BY-SA/CC0 as not', () => {
    expect(isRestrictive(parseLicence('licenses/by-nc/3.0'))).toBe(true);
    expect(isRestrictive(parseLicence('licenses/by-nd/3.0'))).toBe(true);
    expect(isRestrictive(parseLicence('licenses/by-nc-nd/3.0'))).toBe(true);
    expect(isRestrictive(parseLicence('licenses/by/4.0'))).toBe(false);
    expect(isRestrictive(parseLicence('licenses/by-sa/4.0'))).toBe(false);
  });

  it('falls back to unknown for junk, with the cautious classification', () => {
    const l = parseLicence('all rights reserved');
    expect(l.id).toBe('unknown');
    expect(licenceTone(l)).toBe('unknown');
    expect(l.allowsRedistribution).toBe(false);
  });

  it('reads free-text licence names', () => {
    expect(parseLicence('Attribution NonCommercial NoDerivatives').id).toBe('by-nc-nd');
    expect(parseLicence('CC BY 3.0').id).toBe('by');
  });

  it('short chip labels', () => {
    expect(licenceShort(parseLicence('licenses/by-nd/3.0'))).toBe('ND');
    expect(licenceShort(parseLicence('publicdomain/zero/1.0'))).toBe('CC0');
  });
});

describe('importWarningFor', () => {
  it('no warning for permissive licences', () => {
    expect(importWarningFor(parseLicence('licenses/by/4.0')).needed).toBe(false);
  });
  it('ND raises a derivative-conflict warning', () => {
    const w = importWarningFor(parseLicence('licenses/by-nc-nd/3.0'));
    expect(w.needed).toBe(true);
    expect(w.derivativeConflict).toBe(true);
    expect(w.title).toMatch(/NoDerivatives/);
  });
  it('NC (with derivatives allowed) warns without the derivative conflict', () => {
    const w = importWarningFor(parseLicence('licenses/by-nc/3.0'));
    expect(w.needed).toBe(true);
    expect(w.derivativeConflict).toBe(false);
  });
});

describe('restrictedAssetsInUse', () => {
  it('lists only restricted assets that are actually placed, with track names', () => {
    const p = newProject();
    const mkRef = (id: string, lic: string): AssetRef => ({
      id,
      title: id,
      source: 'archive',
      author: 'x',
      licence: parseLicence(lic),
      duration: 3,
      sampleRate: 48000,
      channels: 2,
      importedAt: new Date().toISOString(),
      cached: false,
    });
    p.assets['a'] = mkRef('a', 'licenses/by/4.0');
    p.assets['b'] = mkRef('b', 'licenses/by-nc-nd/3.0');
    p.assets['c'] = mkRef('c', 'all rights reserved'); // unknown, unused
    p.tracks[0].name = 'Ambience';
    p.tracks[0].clips.push(makeClip('a', 0, 3));
    p.tracks[1].name = 'Detail';
    p.tracks[1].clips.push(makeClip('b', 0, 3));

    const restricted = restrictedAssetsInUse(p);
    expect(restricted.map((r) => r.ref.id).sort()).toEqual(['b']);
    expect(restricted[0].tracks).toEqual(['Detail']);
  });
});
