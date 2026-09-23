/**
 * Tone mapping operators ported from FFmpeg's `tonemap` filter.
 *
 * Source (FFmpeg, LGPL-2.1-or-later): libavfilter/vf_tonemap.c
 *  - hable(), mobius(), the per-pixel `tonemap()` routine (desaturation,
 *    brightest-component scaling) and the default parameters declared in
 *    `tonemap_options[]`.
 *
 * Plus the ITU-R BT.2390 EETF, which FFmpeg's filter does not have; see
 * `bt2390Curve`.
 *
 * All inputs/outputs are linear light in FFmpeg units (1.0 == 100 nits).
 */

import { eotfSt2084, inverseEotfSt2084 } from "./colorspace.js";

export const TONEMAP_ALGORITHMS = ["none", "linear", "gamma", "clip", "reinhard", "hable", "mobius", "bt2390"];

/**
 * Contrast of the SDR display the BT.2390 curve targets. 1000:1 is the usual
 * SDR reference (libplacebo's PL_COLOR_SDR_CONTRAST uses the same figure), so
 * with a 100 cd/m2 white the display's black sits at 0.1 cd/m2.
 */
export const SDR_CONTRAST = 1000;

/** libavfilter/vf_tonemap.c -> init() default parameters. */
export function defaultParam(algorithm) {
  switch (algorithm) {
    case "gamma":
      return 1.8;
    case "mobius":
      return 0.3;
    case "bt2390":
      // BT.2390's own knee: KS = 1.5 * maxLum - 0.5.
      return 0.5;
    default:
      return 1.0;
  }
}

/**
 * libavfilter/vf_tonemap.c -> init().
 * Reinhard remaps an explicit `param` to (1 - p) / p, but an unset param is
 * left alone and falls through to the generic 1.0 default.
 */
export function normalizeParam(algorithm, param) {
  const explicit = Number.isFinite(param);
  if (algorithm === "reinhard") {
    if (!explicit) return 1.0;
    return param > 0 ? (1.0 - param) / param : 0;
  }
  return explicit ? param : defaultParam(algorithm);
}

/** libavfilter/vf_tonemap.c -> hable() */
export function hable(x) {
  const a = 0.15;
  const b = 0.5;
  const c = 0.1;
  const d = 0.2;
  const e = 0.02;
  const f = 0.3;
  return (x * (x * a + b * c) + d * e) / (x * (x * a + b) + d * f) - e / f;
}

/** libavfilter/vf_tonemap.c -> mobius() */
export function mobius(x, j, peak) {
  if (x <= j) return x;
  const a = (-j * j * (peak - 1.0)) / (j * j - 2.0 * j + peak);
  const b = (j * j - 2.0 * j * peak + peak) / Math.max(peak - 1.0, 1e-6);
  return (((b * b + 2.0 * b * j + j * j) / (b - a)) * (x + a)) / (x + b);
}

/**
 * ITU-R BT.2390 EETF, mapping a PQ master onto a 100 cd/m2 SDR display.
 *
 * Works in the PQ domain, which is perceptually uniform, so both ends of the
 * range are shaped by how visible a change is rather than by raw light:
 *
 *  - Below the knee (KS = (1 + offset) * maxLum - offset, offset 0.5 in the
 *    Recommendation) the signal is left exactly as mastered. With a measured
 *    peak of 273 cd/m2 that knee is ~60 cd/m2, so every tone up to there is
 *    reproduced at its absolute level; only what is brighter is rolled off, by
 *    a Hermite spline, into the headroom that is left. Content that already
 *    fits under 100 cd/m2 has no knee at all and passes through untouched.
 *  - Black point adaptation then maps source black onto the display's black
 *    (1 / SDR_CONTRAST of white) along `minLum * (1 - x)^bp`, which fades out
 *    well before the midtones. Without it, shadow detail that an HDR display
 *    shows is rounded into code 0 on an SDR one.
 *
 * Follows the current revision as implemented by libplacebo (bt2390() in
 * src/tone_mapping.c): the black-point exponent min(1 / minLum, 4) and the
 * gain that keeps the top of the range on target after the lift.
 *
 * The result is relative to the display's range — its black is 0, its white
 * is 1 — which is what an SDR signal encodes. The display adds its own black
 * back when it shows the file.
 *
 * @param {number} peak  source peak, REFERENCE_WHITE units
 * @param {number} offset  knee offset
 * @param {{adaptBlack?: boolean}} options  black point adaptation is for HDR
 *   masters; an SDR source is already graded for an SDR display's black
 * @returns {(sig: number) => number}
 */
export function bt2390Curve(peak, offset = defaultParam("bt2390"), { adaptBlack = true } = {}) {
  const black = adaptBlack ? 1 / SDR_CONTRAST : 0;
  const inMin = inverseEotfSt2084(0);
  const inMax = inverseEotfSt2084(Math.max(peak, 1e-6));
  const span = inMax - inMin;
  const rescale = (value) => (inverseEotfSt2084(value) - inMin) / span;
  const minLum = rescale(black);
  const maxLum = rescale(1);
  const ks = (1 + offset) * maxLum - offset;
  const bp = minLum > 0 ? Math.min(1 / minLum, 4) : 4;
  const gain = maxLum < 1 ? 1 / (1 + (minLum / maxLum) * Math.pow(1 - maxLum, bp)) : 1;

  const exact = (sig) => {
    let x = Math.min(Math.max(rescale(sig), 0), 1);
    if (ks < 1 && x >= ks) {
      const t = (x - ks) / (1 - ks);
      const t2 = t * t;
      const t3 = t2 * t;
      x = (2 * t3 - 3 * t2 + 1) * ks + (t3 - 2 * t2 + t) * (1 - ks) + (-2 * t3 + 3 * t2) * maxLum;
    }
    if (x < 1) {
      x += minLum * Math.pow(1 - x, bp);
      x = gain * (x - minLum) + minLum;
    }
    const shown = eotfSt2084(x * span + inMin);
    return Math.min(Math.max((shown - black) / (1 - black), 0), 1);
  };

  // Five powers per pixel would dominate the live preview, so tabulate. The
  // table is indexed by sqrt(sig / peak), which spends its resolution near
  // black, where the black-point lift bends the curve hardest.
  const size = 4096;
  const table = new Float32Array(size + 1);
  for (let i = 0; i <= size; i++) {
    const u = i / size;
    table[i] = exact(u * u * peak);
  }
  const curve = (sig) => {
    if (!(sig > 0)) return table[0];
    const position = Math.min(Math.sqrt(sig / peak), 1) * size;
    const index = Math.min(position | 0, size - 1);
    const fraction = position - index;
    return table[index] + (table[index + 1] - table[index]) * fraction;
  };
  curve.exact = exact;
  return curve;
}

/**
 * Returns the scalar curve used by `tonemap`, matching the switch in
 * libavfilter/vf_tonemap.c -> tonemap(), plus BT.2390.
 *
 * `hdr` is false for SDR sources, which BT.2390 then leaves untouched: its
 * black point adaptation compensates for an SDR display, and an SDR file was
 * made for one already.
 */
export function createCurve(algorithm, param, peak, { hdr = true } = {}) {
  const p = normalizeParam(algorithm, param);
  switch (algorithm) {
    case "linear":
      return (sig) => (sig * p) / peak;
    case "gamma":
      return (sig) =>
        sig > 0.05
          ? Math.pow(sig / peak, 1.0 / p)
          : (sig * Math.pow(0.05 / peak, 1.0 / p)) / 0.05;
    case "clip":
      return (sig) => Math.min(Math.max(sig * p, 0), 1.0);
    case "hable": {
      const scale = hable(peak);
      return (sig) => hable(sig) / scale;
    }
    case "reinhard":
      return (sig) => ((sig / (sig + p)) * (peak + p)) / peak;
    case "mobius":
      return (sig) => mobius(sig, p, peak);
    case "bt2390":
      return bt2390Curve(peak, p, { adaptBlack: hdr });
    case "none":
    default:
      return (sig) => sig;
  }
}

/**
 * Tone maps a linear-light RGB triplet in place.
 * Direct port of libavfilter/vf_tonemap.c -> tonemap().
 *
 * @param {Float32Array|number[]} rgb   three linear components, modified in place
 * @param {(sig: number) => number} curve  scalar curve from {@link createCurve}
 * @param {number} desat  desaturation strength (FFmpeg default: 2)
 * @param {{cr: number, cg: number, cb: number}} coeffs source luma coefficients
 * @param {number} offset index of the red component inside `rgb`
 */
export function tonemapPixel(rgb, curve, desat, coeffs, offset = 0) {
  const rIn = rgb[offset];
  const gIn = rgb[offset + 1];
  const bIn = rgb[offset + 2];

  let r = rIn;
  let g = gIn;
  let b = bIn;

  // desaturate to prevent unnatural colors
  if (desat > 0) {
    const luma = coeffs.cr * rIn + coeffs.cg * gIn + coeffs.cb * bIn;
    const overbright = Math.max(luma - desat, 1e-6) / Math.max(luma, 1e-6);
    r = rIn * (1 - overbright) + luma * overbright;
    g = gIn * (1 - overbright) + luma * overbright;
    b = bIn * (1 - overbright) + luma * overbright;
  }

  // pick the brightest component and reduce the whole triplet by the same
  // factor, which keeps hue stable instead of clipping channels independently
  const sigOrig = Math.max(Math.max(r, g, b), 1e-6);
  const sig = curve(sigOrig);
  const scale = sig / sigOrig;

  rgb[offset] = r * scale;
  rgb[offset + 1] = g * scale;
  rgb[offset + 2] = b * scale;
}
