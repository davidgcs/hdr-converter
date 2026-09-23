/**
 * Display-referred tonal controls.
 *
 * These run *after* tone mapping, on the sRGB-encoded signal, because that is
 * the domain they are named for: "shadows", "highlights" and a black point are
 * statements about where tones land on the final display, not about scene
 * light. Exposure is the exception and stays in linear light ahead of the tone
 * curve (see pipeline.js), where a stop is a stop.
 *
 * Every control is neutral at 0, and `createGrade` returns null when they all
 * are, so an unedited conversion runs exactly the code it did before this
 * module existed and produces identical bytes.
 *
 * The curve is monotonic across the whole parameter space, so no combination
 * of settings can invert tones or posterise a gradient. See the constants
 * below for why the amplitudes are what they are.
 */

const LUT_SIZE = 1024;

export const GRADE_DEFAULTS = Object.freeze({
  /** S-curve around mid grey, -100..100. */
  contrast: 0,
  /** Weighted recovery of the upper tones, -100..100. */
  highlights: 0,
  /** Weighted lift of the lower tones, -100..100. */
  shadows: 0,
  /** Input white point, -100..100. */
  whites: 0,
  /** Input black point, -100..100. */
  blacks: 0,
  /** Distance from grey, -100..100. */
  saturation: 0
});

export const GRADE_KEYS = Object.freeze(Object.keys(GRADE_DEFAULTS));

/**
 * `x^2 (1-x)^6` peaks at x = 0.25 and `x^6 (1-x)^2` at x = 0.75, both reaching
 * 0.0111237 there. Dividing by it gives basis functions with a peak of exactly
 * 1, so the slider amount below is a displacement in encoded units.
 *
 * The exponent decides how well each control earns its name. A gentler
 * `x^2 (1-x)^3` is still at 38% of full strength up in the highlights, which
 * makes "shadows" a midtone control in disguise; at this width the leak is
 * 3%, or about 1/255 — invisible.
 *
 * Both bases also vanish *with zero slope* at 0 and at 1. That is what stops
 * any amount of shadow or highlight adjustment from lifting pure black or
 * pulling down pure white, and keeps an intentionally dark scene dark.
 */
const ZONE_NORM = 0.0111237;

/**
 * The narrower the lobe the steeper it is, so the amplitude is bounded by
 * 1/max|B'| = 0.155 — past that the curve would fold over and invert tones.
 * The two lobes compose rather than add (highlights are evaluated on the
 * already-shadow-adjusted value), so the derivative factorises and the bound
 * applies to each independently rather than to their sum.
 */
const ZONE_AMOUNT = 0.15;

/** Endpoint travel for the black and white point controls, in encoded units. */
const LEVEL_RANGE = 0.15;

function shadowBasis(x) {
  const t = 1 - x;
  const t2 = t * t;
  return (x * x * t2 * t2 * t2) / ZONE_NORM;
}

function highlightBasis(x) {
  const x2 = x * x;
  const t = 1 - x;
  return (x2 * x2 * x2 * t * t) / ZONE_NORM;
}

/** Classic S-curve: fixes 0, 0.5 and 1, and steepens the midtones. */
function smoothstep(x) {
  return x * x * (3 - 2 * x);
}

/** Its exact inverse, which flattens them again. */
function inverseSmoothstep(x) {
  return 0.5 - Math.sin(Math.asin(1 - 2 * x) / 3);
}

function isNeutral(options) {
  return GRADE_KEYS.every((key) => !Number(options[key]));
}

/**
 * Builds the tone curve as a lookup table over the encoded range.
 *
 * Order follows the usual editing order: contrast sets the overall shape,
 * the weighted controls recover what that cost at either end, and the black
 * and white points trim the result to the range that will be displayed.
 *
 * @returns {{lut: Float32Array, saturation: number} | null} null when nothing
 *   would change, so callers can skip the work entirely.
 */
export function createGrade(settings) {
  const options = { ...GRADE_DEFAULTS, ...settings };
  if (isNeutral(options)) return null;

  const contrast = Math.max(-1, Math.min(1, Number(options.contrast) / 100));
  const highlights = Math.max(-1, Math.min(1, Number(options.highlights) / 100));
  const shadows = Math.max(-1, Math.min(1, Number(options.shadows) / 100));
  const blackPoint = -Math.max(-1, Math.min(1, Number(options.blacks) / 100)) * LEVEL_RANGE;
  const whitePoint = 1 - Math.max(-1, Math.min(1, Number(options.whites) / 100)) * LEVEL_RANGE;
  const span = whitePoint - blackPoint;

  const lut = new Float32Array(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) {
    let x = i / LUT_SIZE;

    if (contrast > 0) x += contrast * (smoothstep(x) - x);
    else if (contrast < 0) x += -contrast * (inverseSmoothstep(x) - x);

    if (shadows) x += shadows * ZONE_AMOUNT * shadowBasis(x);
    if (highlights) x += highlights * ZONE_AMOUNT * highlightBasis(x);

    x = (x - blackPoint) / span;

    lut[i] = x < 0 ? 0 : x > 1 ? 1 : x;
  }

  return { lut, saturation: Math.max(-1, Math.min(1, Number(options.saturation) / 100)) };
}

function lookup(lut, value) {
  if (value <= 0) return lut[0];
  if (value >= 1) return lut[LUT_SIZE];
  const position = value * LUT_SIZE;
  const index = position | 0;
  const fraction = position - index;
  return lut[index] + (lut[index + 1] - lut[index]) * fraction;
}

/**
 * Applies the grade to one encoded pixel, in place.
 *
 * The curve runs per channel. A monotonic per-channel curve cannot reorder the
 * channels, so it cannot invert a hue, and it is what every editor's contrast
 * and levels controls do — lifting the black point fades the shadows the way
 * users expect it to. Saturation is applied afterwards around the graded
 * luminance, which is how to put back any change in vividness the tone curve
 * brought with it.
 *
 * @param {{lut: Float32Array, saturation: number}} grade
 * @param {Float32Array} rgb Encoded 0..1 values, overwritten with the result.
 */
export function applyGrade(grade, rgb) {
  let r = lookup(grade.lut, rgb[0]);
  let g = lookup(grade.lut, rgb[1]);
  let b = lookup(grade.lut, rgb[2]);

  if (grade.saturation) {
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const scale = 1 + grade.saturation;
    r = luma + (r - luma) * scale;
    g = luma + (g - luma) * scale;
    b = luma + (b - luma) * scale;
  }

  rgb[0] = r < 0 ? 0 : r > 1 ? 1 : r;
  rgb[1] = g < 0 ? 0 : g > 1 ? 1 : g;
  rgb[2] = b < 0 ? 0 : b > 1 ? 1 : b;
}
