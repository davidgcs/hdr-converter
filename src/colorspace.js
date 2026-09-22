/**
 * Colour management helpers ported from FFmpeg.
 *
 * Sources (FFmpeg, LGPL-2.1-or-later):
 *  - libavfilter/colorspace.c        -> ff_fill_rgb2xyz_table, ff_matrix_invert_3x3, ff_matrix_mul_3x3
 *  - libavfilter/opencl/colorspace_common.cl -> eotf_st2084, inverse_oetf_hlg, ootf_hlg, oetf/eotf helpers
 *  - libavutil/csp.c                 -> primary chromaticities and luma coefficients
 *
 * Linear light is expressed in FFmpeg units: 1.0 == REFERENCE_WHITE == 100 nits.
 */

export const REFERENCE_WHITE = 100.0;
export const ST2084_MAX_LUMINANCE = 10000.0;

const ST2084_M1 = 0.1593017578125;
const ST2084_M2 = 78.84375;
const ST2084_C1 = 0.8359375;
const ST2084_C2 = 18.8515625;
const ST2084_C3 = 18.6875;

const HLG_A = 0.17883277;
const HLG_B = 0.28466892;
const HLG_C = 0.55991073;

/** libavutil/csp.c -> luma_coefficients[] */
export const LUMA_COEFFICIENTS = {
  bt709: { cr: 0.2126, cg: 0.7152, cb: 0.0722 },
  bt470bg: { cr: 0.299, cg: 0.587, cb: 0.114 },
  smpte170m: { cr: 0.299, cg: 0.587, cb: 0.114 },
  "bt2020-ncl": { cr: 0.2627, cg: 0.678, cb: 0.0593 },
  "bt2020-cl": { cr: 0.2627, cg: 0.678, cb: 0.0593 }
};

/** libavutil/csp.c -> color_primaries[] (white point + R/G/B chromaticities) */
export const COLOR_PRIMARIES = {
  bt709: { wp: [0.3127, 0.329], r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06] },
  bt470bg: { wp: [0.3127, 0.329], r: [0.64, 0.33], g: [0.29, 0.6], b: [0.15, 0.06] },
  smpte170m: { wp: [0.3127, 0.329], r: [0.63, 0.34], g: [0.31, 0.595], b: [0.155, 0.07] },
  smpte432: { wp: [0.3127, 0.329], r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06] },
  bt2020: { wp: [0.3127, 0.329], r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046] }
};

/** libavfilter/colorspace.c -> ff_matrix_invert_3x3 */
export function invert3x3(input) {
  const [m00, m01, m02] = input[0];
  const [m10, m11, m12] = input[1];
  const [m20, m21, m22] = input[2];

  const out = [
    [m11 * m22 - m21 * m12, -(m01 * m22 - m21 * m02), m01 * m12 - m11 * m02],
    [-(m10 * m22 - m20 * m12), m00 * m22 - m20 * m02, -(m00 * m12 - m10 * m02)],
    [m10 * m21 - m20 * m11, -(m00 * m21 - m20 * m01), m00 * m11 - m10 * m01]
  ];

  const det = 1.0 / (m00 * out[0][0] + m10 * out[0][1] + m20 * out[0][2]);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i][j] *= det;
  }
  return out;
}

/** libavfilter/colorspace.c -> ff_matrix_mul_3x3 */
export function multiply3x3(src1, src2) {
  const dst = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  for (let m = 0; m < 3; m++) {
    for (let n = 0; n < 3; n++) {
      dst[m][n] = src2[m][0] * src1[0][n] + src2[m][1] * src1[1][n] + src2[m][2] * src1[2][n];
    }
  }
  return dst;
}

/** libavfilter/colorspace.c -> ff_fill_rgb2xyz_table */
export function rgb2xyzMatrix(primaries) {
  const [xr, yr] = primaries.r;
  const [xg, yg] = primaries.g;
  const [xb, yb] = primaries.b;
  const [xw, yw] = primaries.wp;

  const rgb2xyz = [
    [xr / yr, xg / yg, xb / yb],
    [1.0, 1.0, 1.0],
    [(1.0 - xr - yr) / yr, (1.0 - xg - yg) / yg, (1.0 - xb - yb) / yb]
  ];

  const i = invert3x3(rgb2xyz);
  const zw = 1.0 - xw - yw;
  const scale = [
    i[0][0] * xw + i[0][1] * yw + i[0][2] * zw,
    i[1][0] * xw + i[1][1] * yw + i[1][2] * zw,
    i[2][0] * xw + i[2][1] * yw + i[2][2] * zw
  ];

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) rgb2xyz[row][col] *= scale[col];
  }
  return rgb2xyz;
}

/** Linear RGB gamut conversion matrix, e.g. BT.2020 -> BT.709 (zscale `p=bt709`). */
export function rgb2rgbMatrix(sourcePrimaries, targetPrimaries) {
  const source = COLOR_PRIMARIES[sourcePrimaries] || COLOR_PRIMARIES.bt709;
  const target = COLOR_PRIMARIES[targetPrimaries] || COLOR_PRIMARIES.bt709;
  if (source === target) return null;
  return multiply3x3(rgb2xyzMatrix(source), invert3x3(rgb2xyzMatrix(target)));
}

/**
 * Y'CbCr -> R'G'B' matrix built from luma coefficients.
 * Mirrors the inverse of libavfilter/colorspace.c -> ff_fill_rgb2yuv_table.
 */
export function yuv2rgbMatrix(matrixName) {
  const coeffs = LUMA_COEFFICIENTS[matrixName] || LUMA_COEFFICIENTS["bt2020-ncl"];
  const { cr, cg, cb } = coeffs;
  return {
    // r = y + rv * v ; g = y + gu * u + gv * v ; b = y + bu * u
    rv: 2.0 * (1.0 - cr),
    gu: (-2.0 * (1.0 - cb) * cb) / cg,
    gv: (-2.0 * (1.0 - cr) * cr) / cg,
    bu: 2.0 * (1.0 - cb)
  };
}

/** colorspace_common.cl -> eotf_st2084 (returns REFERENCE_WHITE units) */
export function eotfSt2084(x) {
  if (!(x > 0.0)) return 0.0;
  const p = Math.pow(x, 1.0 / ST2084_M2);
  const a = Math.max(p - ST2084_C1, 0.0);
  const b = Math.max(ST2084_C2 - ST2084_C3 * p, 1e-6);
  return (Math.pow(a / b, 1.0 / ST2084_M1) * ST2084_MAX_LUMINANCE) / REFERENCE_WHITE;
}

/** colorspace_common.cl -> inverse_oetf_hlg (scene linear, 0..12) */
export function inverseOetfHlg(x) {
  if (x < 0.5) return 4.0 * x * x;
  return Math.exp((x - HLG_C) / HLG_A) + HLG_B;
}

/** colorspace_common.cl -> ootf_hlg scale factor (peak in REFERENCE_WHITE units) */
export function hlgOotfFactor(luma, peak) {
  const gamma = Math.max(1.0, 1.2 + 0.42 * Math.log10((peak * REFERENCE_WHITE) / 1000.0));
  if (luma <= 0) return 0;
  return (peak * Math.pow(luma, gamma - 1.0)) / Math.pow(12.0, gamma);
}

/** colorspace_common.cl -> inverse_oetf_bt709 */
export function inverseOetfBt709(c) {
  if (c < 0) return 0;
  return c < 0.081 ? c / 4.5 : Math.pow((c + 0.099) / 1.099, 1.0 / 0.45);
}

/** colorspace_common.cl -> oetf_bt709 */
export function oetfBt709(c) {
  if (c < 0) return 0;
  return c < 0.018 ? 4.5 * c : 1.099 * Math.pow(c, 0.45) - 0.099;
}

/** IEC 61966-2-1 (sRGB) EOTF, the correct assumption for untagged still images. */
export function eotfSrgb(c) {
  if (c <= 0.04045) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

/** IEC 61966-2-1 (sRGB) inverse EOTF. */
export function inverseEotfSrgb(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055;
}

/** BT.1886 style pure 2.4 gamma display EOTF. */
export function eotfBt1886(c) {
  return c <= 0 ? 0 : Math.pow(c, 2.4);
}

/**
 * Builds a 1D lookup table that maps a coded value to linear light.
 * Used for the per-pixel hot loop so transfer functions are evaluated
 * at most `size` times instead of once per component.
 */
export function buildLinearizeLut(transfer, size) {
  const lut = new Float32Array(size);
  const maxIndex = size - 1;
  for (let i = 0; i < size; i++) {
    const value = i / maxIndex;
    lut[i] = linearizeValue(transfer, value);
  }
  return lut;
}

export function linearizeValue(transfer, value) {
  switch (transfer) {
    case "pq":
      return eotfSt2084(value);
    case "hlg":
      return inverseOetfHlg(value);
    case "linear":
      return value;
    case "bt709":
    case "smpte170m":
      return inverseOetfBt709(value);
    case "iec61966-2-1":
    default:
      return eotfSrgb(value);
  }
}

export function delinearizeValue(transfer, value) {
  switch (transfer) {
    case "bt709":
      return oetfBt709(value);
    case "linear":
      return value;
    case "iec61966-2-1":
    default:
      return inverseEotfSrgb(value);
  }
}
