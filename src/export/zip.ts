/*
 * Minimal ZIP writer — store method only, no compression, no dependency.
 *
 * Export used to fire one download per file: a mixdown, up to eight stems, a
 * CSV and a markdown file is eleven separate downloads. Chrome puts a
 * "Download multiple files?" permission bar in front of that, and a student who
 * misses it loses their stems silently. One archive, one download, one prompt.
 *
 * Compression is deliberately off: WAV audio is the bulk of the payload and
 * does not deflate meaningfully, so storing costs nothing and keeps this small
 * enough to read in one sitting.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** Bit 11: filename is UTF-8. */
const FLAG_UTF8 = 0x800;
const ZIP32_LIMIT = 0xffffffff;

let crcTable: Uint32Array | null = null;
function table(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  crcTable = t;
  return t;
}

export function crc32(bytes: Uint8Array): number {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, which is what ZIP stores. Seconds have 2-second resolution. */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

class Writer {
  private parts: Uint8Array[] = [];
  private length = 0;

  get offset(): number {
    return this.length;
  }

  push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  /** Little-endian record built from [byteWidth, value] pairs. */
  record(fields: Array<[2 | 4, number]>): void {
    const size = fields.reduce((n, [w]) => n + w, 0);
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    let at = 0;
    for (const [width, value] of fields) {
      if (width === 2) view.setUint16(at, value & 0xffff, true);
      else view.setUint32(at, value >>> 0, true);
      at += width;
    }
    this.push(buf);
  }

  collect(): Uint8Array[] {
    return this.parts;
  }
}

/**
 * Build a ZIP archive from `entries`. Names may contain forward slashes to
 * create folders; the archive is laid out flat otherwise.
 */
export function buildZip(entries: ZipEntry[], now = new Date()): Blob {
  const { time, date } = dosDateTime(now);
  const encoder = new TextEncoder();
  const out = new Writer();
  const central: Array<{ name: Uint8Array; crc: number; size: number; offset: number }> = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const offset = out.offset;
    // Checked before hashing: CRC over an oversized entry is a long walk to an
    // answer we already know we cannot use.
    if (entry.data.length > ZIP32_LIMIT || offset > ZIP32_LIMIT) {
      throw new Error(
        'This export is too large to package as a single archive. Export the stems separately.',
      );
    }
    const crc = crc32(entry.data);

    out.record([
      [4, LOCAL_SIG],
      [2, 20], // version needed
      [2, FLAG_UTF8],
      [2, 0], // stored
      [2, time],
      [2, date],
      [4, crc],
      [4, entry.data.length], // compressed
      [4, entry.data.length], // uncompressed
      [2, name.length],
      [2, 0], // extra field length
    ]);
    out.push(name);
    out.push(entry.data);

    central.push({ name, crc, size: entry.data.length, offset });
  }

  const centralOffset = out.offset;
  for (const e of central) {
    out.record([
      [4, CENTRAL_SIG],
      [2, 20], // version made by
      [2, 20], // version needed
      [2, FLAG_UTF8],
      [2, 0], // stored
      [2, time],
      [2, date],
      [4, e.crc],
      [4, e.size],
      [4, e.size],
      [2, e.name.length],
      [2, 0], // extra
      [2, 0], // comment
      [2, 0], // disk number start
      [2, 0], // internal attributes
      [4, 0], // external attributes
      [4, e.offset],
    ]);
    out.push(e.name);
  }
  const centralSize = out.offset - centralOffset;

  out.record([
    [4, EOCD_SIG],
    [2, 0], // this disk
    [2, 0], // disk with central directory
    [2, central.length],
    [2, central.length],
    [4, centralSize],
    [4, centralOffset],
    [2, 0], // comment length
  ]);

  return new Blob(out.collect() as BlobPart[], { type: 'application/zip' });
}
