/*
 * The archive has to be readable by whatever the student's machine unzips
 * with, so this writes a real file and checks a real unzip can test and
 * extract it — not just that our own reader agrees with our own writer.
 *
 * Every name the exporter puts in an archive has been through `safeName`,
 * which strips anything outside [A-Za-z0-9_- ], so entry names are ASCII in
 * practice. buildZip still sets the UTF-8 name flag and is verified against a
 * non-ASCII name structurally, because macOS's bundled Info-ZIP mangles such
 * names on extraction even when the archive itself is sound.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip, crc32 } from '../src/export/zip';
import { safeName } from '../src/export/download';

const textBytes = (s: string) => new TextEncoder().encode(s);
const zipToBuffer = async (blob: Blob) => Buffer.from(await blob.arrayBuffer());

/** Never let a prompting unzip block the run waiting on stdin. */
const run = (args: string[]) =>
  execFileSync('unzip', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'scapemaker-zip-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    // The canonical CRC-32 check value for "123456789".
    expect(crc32(textBytes('123456789'))).toBe(0xcbf43926);
  });

  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('buildZip', () => {
  it('produces an archive a real unzip verifies and extracts byte for byte', async () => {
    const entries = [
      { name: 'Rainy_Street_Final.wav', data: new Uint8Array(4096).fill(7) },
      { name: 'Rainy_Street_stem_Traffic.wav', data: new Uint8Array(512).fill(3) },
      { name: 'Rainy_Street_sources.csv', data: textBytes('title,licence\n"Rain",CC0\n') },
      { name: 'Rainy_Street_reflection.md', data: textBytes('# Rainy Street — reflection\n') },
      { name: 'empty.txt', data: new Uint8Array(0) },
    ];
    const buf = await zipToBuffer(buildZip(entries, new Date('2026-09-17T10:30:00')));

    withTempDir((dir) => {
      const path = join(dir, 'export.zip');
      writeFileSync(path, buf);

      // `unzip -t` checks every CRC and exits non-zero on a malformed archive.
      expect(run(['-t', path])).toMatch(/No errors detected/);

      run(['-o', '-q', path, '-d', dir]);
      for (const entry of entries) {
        const got = readFileSync(join(dir, entry.name));
        expect(Buffer.compare(got, Buffer.from(entry.data))).toBe(0);
      }
    });
  });

  it('stays structurally valid with a UTF-8 entry name', async () => {
    const name = 'Café_Ørsted.wav';
    const buf = await zipToBuffer(buildZip([{ name, data: textBytes('x') }]));

    // The name is stored as UTF-8 bytes with the UTF-8 flag (bit 11) set.
    expect(buf.includes(Buffer.from(name, 'utf8'))).toBe(true);
    expect(buf.readUInt16LE(6) & 0x800).toBe(0x800);

    withTempDir((dir) => {
      const path = join(dir, 'utf8.zip');
      writeFileSync(path, buf);
      expect(run(['-t', path])).toMatch(/No errors detected/);
    });
  });

  it('only ever sees ASCII names from the exporter', () => {
    // Guard on the assumption above: safeName is what builds every entry name.
    expect(safeName('Café terrace')).toMatch(/^[\w-]+$/);
    expect(safeName('Ørsted/park')).toMatch(/^[\w-]+$/);
  });

  it('handles an empty archive', async () => {
    const buf = await zipToBuffer(buildZip([]));
    expect(buf.length).toBe(22); // EOCD only
    expect(buf.readUInt32LE(0)).toBe(0x06054b50);
  });

  it('refuses an entry too large for a zip32 archive', () => {
    const huge = { name: 'big.wav', data: { length: 0x1_0000_0000 } as unknown as Uint8Array };
    expect(() => buildZip([huge])).toThrow(/too large/);
  });
});
