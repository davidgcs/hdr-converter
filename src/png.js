/**
 * A 16-bit, sRGB-tagged PNG writer.
 *
 * The browser's canvas encoder can only write 8 bits per channel, which throws
 * away most of the precision a tone-mapped HDR image has in its shadows. This
 * writes the pipeline's 16-bit output directly.
 *
 * Colour: an `sRGB` chunk (rendering intent perceptual) declares the file as
 * IEC 61966-2-1, with the `gAMA` and `cHRM` values the PNG specification gives
 * for sRGB so that decoders which predate the `sRGB` chunk still read it
 * correctly. PNG does not allow `iCCP` alongside `sRGB`, and `sRGB` is the
 * standard's own way to say it.
 *
 * Compression: none. The image data is wrapped in stored (uncompressed)
 * deflate blocks, which is valid zlib, so the file is lossless and any decoder
 * reads it, at the cost of size.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts) {
  let c = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) c = CRC_TABLE[(c ^ part[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(data) {
  let a = 1;
  let b = 0;
  // 5552 is the largest run that cannot overflow before the modulo.
  for (let i = 0; i < data.length; ) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
}

function chunk(type, parts) {
  const name = new TextEncoder().encode(type);
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  return [u32(length), name, ...parts, u32(crc32([name, ...parts]))];
}

/** Stored deflate blocks hold at most 65535 bytes each. */
const STORED_BLOCK = 65535;
/** Split the image data into IDAT chunks of about 1 MiB. */
const IDAT_TARGET = 1 << 20;

/**
 * @param {Uint16Array} pixels RGBA, 16 bits per channel, row-major
 * @param {number} width
 * @param {number} height
 * @returns {Blob}
 */
export function encodePng16(pixels, width, height) {
  let opaque = true;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 65535) {
      opaque = false;
      break;
    }
  }
  const channels = opaque ? 3 : 4;

  // Filter type 0 (None) on every row, then big-endian samples.
  const stride = 1 + width * channels * 2;
  const raw = new Uint8Array(stride * height);
  for (let y = 0, o = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0, p = y * width * 4; x < width; x++, p += 4) {
      for (let c = 0; c < channels; c++) {
        const value = pixels[p + c];
        raw[o++] = value >>> 8;
        raw[o++] = value & 0xff;
      }
    }
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 16;
  header[9] = opaque ? 2 : 6;

  const gamma = u32(45455);
  const chrm = new Uint8Array(32);
  const chrmView = new DataView(chrm.buffer);
  [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000].forEach((value, i) => chrmView.setUint32(i * 4, value));

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunk("IHDR", [header]),
    ...chunk("sRGB", [new Uint8Array([0])]),
    ...chunk("gAMA", [gamma]),
    ...chunk("cHRM", [chrm])
  ];

  // zlib: CMF 0x78 / FLG 0x01 (no preset dictionary, fastest), stored blocks,
  // then the Adler-32 of the uncompressed data.
  let pending = [new Uint8Array([0x78, 0x01])];
  let pendingSize = 2;
  for (let offset = 0; offset < raw.length; offset += STORED_BLOCK) {
    const end = Math.min(offset + STORED_BLOCK, raw.length);
    const length = end - offset;
    const block = new Uint8Array(5);
    block[0] = end === raw.length ? 1 : 0;
    block[1] = length & 0xff;
    block[2] = length >>> 8;
    block[3] = ~length & 0xff;
    block[4] = (~length >>> 8) & 0xff;
    pending.push(block, raw.subarray(offset, end));
    pendingSize += 5 + length;
    if (end === raw.length) pending.push(u32(adler32(raw)));
    if (pendingSize >= IDAT_TARGET || end === raw.length) {
      parts.push(...chunk("IDAT", pending));
      pending = [];
      pendingSize = 0;
    }
  }
  parts.push(...chunk("IEND", []));

  return new Blob(parts, { type: "image/png" });
}

/** One-dimensional area weights: how much of each source sample a target covers. */
function areaWeights(source, target) {
  const scale = source / target;
  const spans = [];
  for (let i = 0; i < target; i++) {
    const start = i * scale;
    const end = start + scale;
    const taps = [];
    for (let j = Math.floor(start); j < Math.min(source, Math.ceil(end)); j++) {
      const weight = Math.min(end, j + 1) - Math.max(start, j);
      if (weight > 0) taps.push(j, weight / scale);
    }
    spans.push(taps);
  }
  return spans;
}

/**
 * Downscales 16-bit RGBA by area averaging, with premultiplied alpha so that
 * transparent pixels cannot bleed their colour into their neighbours.
 */
export function resize16(pixels, width, height, targetWidth, targetHeight) {
  const columns = areaWeights(width, targetWidth);
  const rows = areaWeights(height, targetHeight);

  const across = new Float32Array(targetWidth * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const taps = columns[x];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let t = 0; t < taps.length; t += 2) {
        const p = (y * width + taps[t]) * 4;
        const w = taps[t + 1];
        const alpha = pixels[p + 3] * w;
        r += pixels[p] * alpha;
        g += pixels[p + 1] * alpha;
        b += pixels[p + 2] * alpha;
        a += alpha;
      }
      const q = (y * targetWidth + x) * 4;
      across[q] = r;
      across[q + 1] = g;
      across[q + 2] = b;
      across[q + 3] = a;
    }
  }

  const out = new Uint16Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y++) {
    const taps = rows[y];
    for (let x = 0; x < targetWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let t = 0; t < taps.length; t += 2) {
        const q = (taps[t] * targetWidth + x) * 4;
        const w = taps[t + 1];
        r += across[q] * w;
        g += across[q + 1] * w;
        b += across[q + 2] * w;
        a += across[q + 3] * w;
      }
      const o = (y * targetWidth + x) * 4;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a);
    }
  }
  return out;
}
