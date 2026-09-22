/**
 * Reads CICP colour tags (ISO/IEC 23091-4, the values FFmpeg calls
 * `color_primaries` / `color_trc` / `colorspace` / `color_range`) straight from
 * the file container.
 *
 * This exists because `VideoFrame.colorSpace` cannot express every tag. Its
 * `matrix` is limited to a handful of enum values, so an AVIF coded with
 * `matrix_coefficients = 0` (identity, i.e. the planes carry G, B, R rather
 * than Y, Cb, Cr) is reported as `matrix: null`. Guessing a YUV matrix for
 * those files turns the picture green, so the container is the source of truth.
 *
 * AVIF/HEIF store the tags in a `colr` box with the `nclx` colour type:
 *   'colr' 'nclx' u16 primaries, u16 transfer, u16 matrix, u1 full range.
 */

const NCLX_PAYLOAD_BYTES = 7;
const SCAN_LIMIT = 1 << 20;

const PRIMARIES = {
  1: "bt709",
  5: "bt470bg",
  6: "smpte170m",
  7: "smpte170m",
  9: "bt2020",
  11: "smpte431",
  12: "smpte432"
};

const TRANSFER = {
  1: "bt709",
  4: "gamma22",
  6: "bt709",
  8: "linear",
  13: "iec61966-2-1",
  14: "bt709",
  15: "bt709",
  16: "pq",
  18: "hlg"
};

const MATRIX = {
  0: "rgb",
  1: "bt709",
  5: "bt470bg",
  6: "smpte170m",
  7: "smpte170m",
  9: "bt2020-ncl",
  10: "bt2020-cl"
};

function indexOfBox(bytes, name, from) {
  const [a, b, c, d] = [name.charCodeAt(0), name.charCodeAt(1), name.charCodeAt(2), name.charCodeAt(3)];
  for (let i = from; i < bytes.length - 3; i++) {
    if (bytes[i] === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d) return i;
  }
  return -1;
}

/**
 * @returns {{primaries?: string, transfer?: string, matrix?: string, fullRange?: boolean, identity: boolean}|null}
 */
export function parseNclx(bytes) {
  let cursor = 0;
  while (cursor < bytes.length) {
    const at = indexOfBox(bytes, "colr", cursor);
    if (at < 0) return null;
    cursor = at + 4;
    if (at + 4 + 4 + NCLX_PAYLOAD_BYTES > bytes.length) return null;
    if (String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]) !== "nclx") continue;

    const view = new DataView(bytes.buffer, bytes.byteOffset + at + 8, NCLX_PAYLOAD_BYTES);
    const primaries = view.getUint16(0);
    const transfer = view.getUint16(2);
    const matrix = view.getUint16(4);
    const fullRange = (view.getUint8(6) & 0x80) !== 0;

    return {
      primaries: PRIMARIES[primaries],
      transfer: TRANSFER[transfer],
      matrix: MATRIX[matrix],
      fullRange,
      identity: matrix === 0,
      cicp: { primaries, transfer, matrix }
    };
  }
  return null;
}

/** Reads only the header of a file: the `colr` box lives near the front. */
export async function readFileColorTags(file) {
  try {
    const slice = file.slice(0, Math.min(file.size, SCAN_LIMIT));
    const bytes = new Uint8Array(await slice.arrayBuffer());
    return parseNclx(bytes);
  } catch {
    return null;
  }
}
