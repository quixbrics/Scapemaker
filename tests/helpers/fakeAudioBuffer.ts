/* Minimal AudioBuffer stand-in for headless (node) tests. */

export class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(c: number): Float32Array {
    return this.channels[c];
  }
}

export function makeTone(
  freq: number,
  seconds: number,
  sampleRate = 48000,
  amp = 0.5,
  channels = 2,
): FakeAudioBuffer {
  const len = Math.floor(seconds * sampleRate);
  const buf = new FakeAudioBuffer(channels, len, sampleRate);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return buf;
}
