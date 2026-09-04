import { describe, expect, it } from 'vitest';
import { encodeWav } from '../src/audio/wav';
import { makeTone } from './helpers/fakeAudioBuffer';

async function bytes(blob: Blob): Promise<DataView> {
  const ab = await blob.arrayBuffer();
  return new DataView(ab);
}
function str(v: DataView, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint8(off + i));
  return s;
}

describe('encodeWav', () => {
  it('writes a valid RIFF/WAVE header for 24-bit stereo at 48 kHz', async () => {
    const buf = makeTone(440, 0.25, 48000, 0.5, 2) as unknown as AudioBuffer;
    const v = await bytes(encodeWav(buf, 24));
    expect(str(v, 0, 4)).toBe('RIFF');
    expect(str(v, 8, 4)).toBe('WAVE');
    expect(str(v, 12, 4)).toBe('fmt ');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(2); // channels
    expect(v.getUint32(24, true)).toBe(48000); // sample rate
    expect(v.getUint16(34, true)).toBe(24); // bit depth
    expect(str(v, 36, 4)).toBe('data');
  });

  it('data chunk size matches frames × channels × bytesPerSample', async () => {
    const seconds = 0.1;
    const sr = 48000;
    const buf = makeTone(220, seconds, sr, 0.3, 2) as unknown as AudioBuffer;
    const v = await bytes(encodeWav(buf, 16));
    const frames = Math.floor(seconds * sr);
    expect(v.getUint32(40, true)).toBe(frames * 2 * 2);
    expect(v.byteLength).toBe(44 + frames * 2 * 2);
  });

  it('clamps out-of-range samples instead of wrapping', async () => {
    const buf = makeTone(100, 0.02, 48000, 2.0, 1) as unknown as AudioBuffer; // amp 2.0 → clip
    const v = await bytes(encodeWav(buf, 16));
    let sawMax = false;
    for (let off = 44; off < v.byteLength; off += 2) {
      const s = v.getInt16(off, true);
      expect(s).toBeGreaterThanOrEqual(-32768);
      expect(s).toBeLessThanOrEqual(32767);
      if (s === 32767 || s === -32768) sawMax = true;
    }
    expect(sawMax).toBe(true);
  });

  it('32-bit float export sets format tag 3', async () => {
    const buf = makeTone(440, 0.05) as unknown as AudioBuffer;
    const v = await bytes(encodeWav(buf, 32));
    expect(v.getUint16(20, true)).toBe(3);
    expect(v.getUint16(34, true)).toBe(32);
  });
});
