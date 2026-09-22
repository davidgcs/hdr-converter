/**
 * Tone mapping operators ported from FFmpeg's `tonemap` filter.
 *
 * Source (FFmpeg, LGPL-2.1-or-later): libavfilter/vf_tonemap.c
 *  - hable(), mobius(), the per-pixel `tonemap()` routine (desaturation,
 *    brightest-component scaling) and the default parameters declared in
 *    `tonemap_options[]`.
 *
 * All inputs/outputs are linear light in FFmpeg units (1.0 == 100 nits).
 */

export const TONEMAP_ALGORITHMS = ["none", "linear", "gamma", "clip", "reinhard", "hable", "mobius"];

/** libavfilter/vf_tonemap.c -> init() default parameters. */
export function defaultParam(algorithm) {
  switch (algorithm) {
    case "gamma":
      return 1.8;
    case "mobius":
      return 0.3;
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
 * Returns the scalar curve used by `tonemap`, matching the switch in
 * libavfilter/vf_tonemap.c -> tonemap().
 */
export function createCurve(algorithm, param, peak) {
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
