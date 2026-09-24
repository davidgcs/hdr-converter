/**
 * The adjust panel's controls.
 *
 * They act at three points in the pipeline, each where its name makes sense:
 *
 *  - White balance (temperature, tint) is light, like exposure, so it runs in
 *    linear light ahead of the tone curve: `whiteBalanceGains`.
 *  - The tonal and colour controls are statements about where tones land on
 *    the final display — "shadows", a black point, how vivid a colour looks —
 *    so they run after tone mapping, on the sRGB-encoded signal: `createGrade`
 *    and `applyGrade`. The vignette runs just before, on linear display light,
 *    because darkening a corner is a change in how much light it gives off.
 *  - Noise reduction, clarity and sharpness look at neighbouring pixels, so they
 *    run last, over the finished image at the size it is saved at, in that
 *    order — sharpening before denoising would sharpen the noise too:
 *    `createDetail` and `applyDetail`.
 *
 * Every control is neutral at 0, and each stage is skipped outright (its
 * factory returns null) when all of its controls are, so an unedited
 * conversion runs exactly the code it did before this module existed and
 * produces identical bytes.
 *
 * The tone curve is monotonic across the whole parameter space, so no
 * combination of settings can invert tones or posterise a gradient. See the
 * constants below for why the amplitudes are what they are.
 */

import { COLOR_PRIMARIES, invert3x3, rgb2xyzMatrix } from "./colorspace.js";

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
  /** White balance along the blackbody locus, cool..warm, -100..100. */
  temperature: 0,
  /** White balance across it, green..magenta, -100..100. */
  tint: 0,
  /** Saturation weighted toward muted colours, -100..100. */
  vibrance: 0,
  /** Distance from grey, -100..100. */
  saturation: 0,
  /** Edge-preserving smoothing of luminance and colour noise, 0..100. */
  noise: 0,
  /** Edge-aware local contrast in the midtones, -100..100. */
  clarity: 0,
  /** Unsharp mask at the saved resolution, 0..100. */
  sharpness: 0,
  /** Darker (-) or lighter (+) corners, -100..100. */
  vignette: 0
});

export const GRADE_KEYS = Object.freeze(Object.keys(GRADE_DEFAULTS));

const CURVE_KEYS = ["contrast", "highlights", "shadows", "whites", "blacks"];

function amount(options, key, min = -1) {
  return Math.max(min, Math.min(1, Number(options[key]) / 100 || 0));
}

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

/**
 * The display-referred part of the grade: tone curve, vibrance, saturation
 * and vignette.
 *
 * @returns {{lut: Float32Array|null, saturation: number, vibrance: number,
 *   vignette: number} | null} null when nothing would change, so callers can
 *   skip the work entirely.
 */
export function createGrade(settings) {
  const options = { ...GRADE_DEFAULTS, ...settings };
  const saturation = amount(options, "saturation");
  const vibrance = amount(options, "vibrance");
  const vignette = amount(options, "vignette");
  const curved = CURVE_KEYS.some((key) => Number(options[key]));
  if (!curved && !saturation && !vibrance && !vignette) return null;
  // No table at all when only the colour controls moved, so the tones pass
  // through untouched rather than through an identity curve.
  const lut = curved ? buildCurve(options) : null;
  return { lut, saturation, vibrance, vignette };
}

/**
 * Builds the tone curve as a lookup table over the encoded range.
 *
 * Order follows the usual editing order: contrast sets the overall shape,
 * the weighted controls recover what that cost at either end, and the black
 * and white points trim the result to the range that will be displayed.
 */
function buildCurve(options) {
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

  return lut;
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
 * users expect it to. Vibrance and saturation are applied afterwards around
 * the graded luminance, which is how to put back any change in vividness the
 * tone curve brought with it.
 *
 * @param {{lut: Float32Array|null, saturation: number, vibrance: number}} grade
 * @param {Float32Array} rgb Encoded 0..1 values, overwritten with the result.
 */
export function applyGrade(grade, rgb) {
  let r = rgb[0];
  let g = rgb[1];
  let b = rgb[2];
  if (grade.lut) {
    r = lookup(grade.lut, r);
    g = lookup(grade.lut, g);
    b = lookup(grade.lut, b);
  }

  if (grade.vibrance) {
    // Weighted by how muted the colour already is (1 - HSV saturation), so a
    // dull sky gains colour long before a vivid sign turns garish. Negative
    // values mute the dull colours first and leave the vivid ones.
    const max = Math.max(r, g, b);
    const muted = max > 1e-6 ? 1 - (max - Math.min(r, g, b)) / max : 1;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const scale = 1 + grade.vibrance * muted;
    r = luma + (r - luma) * scale;
    g = luma + (g - luma) * scale;
    b = luma + (b - luma) * scale;
  }

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

/* ------------------------------------------------------------- vignette */

/** Where the falloff starts, as a fraction of the centre-to-corner distance. */
const VIGNETTE_START = 0.3;
/** At -100 the corners give off a fifth of their light (about -2.3 stops). */
const VIGNETTE_DEPTH = 0.8;

/**
 * Darkens (negative) or lightens (positive) the edges of one pixel of linear
 * display light, in place. `u` and `v` are its position in the frame, 0..1,
 * so the falloff follows the frame's own shape — crop included — and looks
 * the same at any resolution.
 */
export function applyVignette(grade, rgb, u, v) {
  const dx = 2 * u - 1;
  const dy = 2 * v - 1;
  const d = Math.sqrt((dx * dx + dy * dy) / 2);
  if (d <= VIGNETTE_START) return;
  const t = Math.min(1, (d - VIGNETTE_START) / (1 - VIGNETTE_START));
  const falloff = t * t * (3 - 2 * t) * VIGNETTE_DEPTH * grade.vignette;
  if (falloff < 0) {
    // Less light from the corners, as a lens gives.
    const keep = 1 + falloff;
    rgb[0] *= keep;
    rgb[1] *= keep;
    rgb[2] *= keep;
  } else {
    // A light vignette mixes toward white instead: multiplying would clip.
    rgb[0] += (1 - rgb[0]) * falloff;
    rgb[1] += (1 - rgb[1]) * falloff;
    rgb[2] += (1 - rgb[2]) * falloff;
  }
}

/* -------------------------------------------------------- white balance */

const XYZ_TO_BT709 = invert3x3(rgb2xyzMatrix(COLOR_PRIMARIES.bt709));

/** D65's correlated colour temperature: the neutral end of the slider. */
const NEUTRAL_CCT = 6504;
/**
 * ±100 on the slider moves the white point ±50 mired along the blackbody
 * locus (to 9640 K / 4910 K). Mired, 10^6/K, is the scale on which equal steps
 * look like equal shifts, which is why camera filters are rated in it.
 */
const MIRED_SPAN = 50;
/** ±100 of tint scales green by ∓20% before normalising. */
const TINT_SPAN = 0.2;

/** Kim et al. (2002) cubic fit to the Planckian locus, 1667–25000 K, CIE 1931 xy. */
function planckianXY(kelvin) {
  const t = 1e3 / kelvin;
  const t2 = t * t;
  const t3 = t2 * t;
  const x = kelvin <= 4000
    ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.17991
    : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  const y = kelvin <= 2222
    ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
    : kelvin <= 4000
      ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

/** Linear BT.709 RGB of the blackbody white at `kelvin`, luminance 1. */
function blackbodyRgb(kelvin) {
  const [x, y] = planckianXY(kelvin);
  const X = x / y;
  const Z = (1 - x - y) / y;
  return XYZ_TO_BT709.map((row) => row[0] * X + row[1] + row[2] * Z);
}

/**
 * Per-channel gains for linear BT.709 light, or null when white balance is
 * untouched.
 *
 * Temperature treats the picture as if it had been lit by a blackbody warmer
 * or cooler than D65 and corrects for it, von Kries style: dividing by a
 * bluish white warms the picture, dividing by a yellowish one cools it. Both
 * whites are taken from the same locus fit, so at 0 the gains are exactly 1.
 * The gains are then normalised so a neutral grey keeps its luminance: white
 * balance changes the colour of the light, not how much there is of it.
 */
export function whiteBalanceGains(settings) {
  const options = { ...GRADE_DEFAULTS, ...settings };
  const temperature = amount(options, "temperature");
  const tint = amount(options, "tint");
  if (!temperature && !tint) return null;

  const neutral = blackbodyRgb(NEUTRAL_CCT);
  const target = blackbodyRgb(1e6 / (1e6 / NEUTRAL_CCT - temperature * MIRED_SPAN));
  const gains = neutral.map((value, i) => value / target[i]);
  gains[1] *= 1 - tint * TINT_SPAN;
  const luminance = 0.2126 * gains[0] + 0.7152 * gains[1] + 0.0722 * gains[2];
  return Float32Array.from(gains, (gain) => gain / luminance);
}

/* --------------------------------------------------------------- detail */

/**
 * Unsharp mask: sigma in pixels of the saved file, and the strength at 100.
 * The radius is set by the output so the look does not depend on how large
 * the preview happens to be.
 */
const SHARP_SIGMA = 1;
const SHARP_MAX = 1.5;
/**
 * Differences below this, in encoded units, are not sharpened at all, and the
 * mask ramps up to full strength over the next step. It keeps the 8-bit steps
 * of a smooth dark gradient, and fine noise, from being turned into texture.
 */
const SHARP_THRESHOLD = 0.5 / 255;
const SHARP_RAMP = 1 / 255;

/** Clarity's radius as a fraction of the image diagonal: a local, not global, contrast. */
const CLARITY_RADIUS = 0.012;
/**
 * The guided filter's regulariser. Neighbourhoods whose local contrast is well
 * above sqrt(eps) = 0.1 count as edges and are left as they are, which is
 * what keeps clarity from drawing halos along strong outlines.
 */
const CLARITY_EPS = 0.01;
const CLARITY_MAX = 1;

/**
 * Scratch space reused from one call to the next. The live preview runs the
 * detail pass on every frame of a drag, and allocating fresh multi-megabyte
 * buffers each time leaves the garbage collector a frame's worth of work.
 *
 * Only preview-sized buffers are kept (previews are capped at 2.2 MP, see
 * prepareScene). A full-size save allocates its own and lets them go, so a
 * large photo does not leave hundreds of megabytes behind.
 */
const SCRATCH_LIMIT = 2.5e6;
const scratch = new Map();
function buffer(name, length) {
  if (length > SCRATCH_LIMIT) return new Float32Array(length);
  let array = scratch.get(name);
  if (!array || array.length < length) {
    array = new Float32Array(length);
    scratch.set(name, array);
  }
  return array;
}

/** @returns {{sharpness: number, clarity: number} | null} */
export function createDetail(settings) {
  const options = { ...GRADE_DEFAULTS, ...settings };
  const sharpness = amount(options, "sharpness", 0);
  const clarity = amount(options, "clarity");
  const noise = amount(options, "noise", 0);
  return sharpness || clarity || noise ? { sharpness, clarity, noise } : null;
}

/**
 * Horizontal then vertical pass of a normalised, edge-clamped Gaussian. Only
 * the few pixels within `radius` of an edge need clamping; the rest run a
 * plain dot product.
 */
function gaussianBlur(src, width, height, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const taps = radius * 2 + 1;
  const kernel = new Float32Array(taps);
  let total = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = w;
    total += w;
  }
  for (let i = 0; i < taps; i++) kernel[i] /= total;

  const n = width * height;
  const temp = buffer("blur-temp", n);
  const out = buffer("blur-out", n);
  const clampX = (x) => (x < 0 ? 0 : x >= width ? width - 1 : x);
  const clampY = (y) => (y < 0 ? 0 : y >= height ? height - 1 : y);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      if (x >= radius && x < width - radius) {
        const start = row + x - radius;
        for (let k = 0; k < taps; k++) sum += src[start + k] * kernel[k];
      } else {
        for (let k = 0; k < taps; k++) sum += src[row + clampX(x + k - radius)] * kernel[k];
      }
      temp[row + x] = sum;
    }
  }
  for (let y = 0; y < height; y++) {
    const interior = y >= radius && y < height - radius;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      if (interior) {
        let at = (y - radius) * width + x;
        for (let k = 0; k < taps; k++, at += width) sum += temp[at] * kernel[k];
      } else {
        for (let k = 0; k < taps; k++) sum += temp[clampY(y + k - radius) * width + x] * kernel[k];
      }
      out[y * width + x] = sum;
    }
  }
  return out;
}

/** Mean over a (2r+1)² window, via running sums; windows shrink at the edges. */
function boxMean(src, width, height, r) {
  const temp = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = 0; x < Math.min(r, width - 1) + 1; x++) sum += src[row + x];
    for (let x = 0; x < width; x++) {
      const lo = Math.max(0, x - r);
      const hi = Math.min(width - 1, x + r);
      temp[row + x] = sum / (hi - lo + 1);
      if (x + r + 1 < width) sum += src[row + x + r + 1];
      if (x - r >= 0) sum -= src[row + x - r];
    }
  }
  const out = new Float32Array(src.length);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < Math.min(r, height - 1) + 1; y++) sum += temp[y * width + x];
    for (let y = 0; y < height; y++) {
      const lo = Math.max(0, y - r);
      const hi = Math.min(height - 1, y + r);
      out[y * width + x] = sum / (hi - lo + 1);
      if (y + r + 1 < height) sum += temp[(y + r + 1) * width + x];
      if (y - r >= 0) sum -= temp[(y - r) * width + x];
    }
  }
  return out;
}

/**
 * The fast guided filter (He & Sun, 2015) of `luma` guided by itself: an
 * edge-preserving base layer, from which clarity takes the detail.
 *
 * The coefficients are solved on a copy shrunk by `step` and interpolated
 * back up, which for a radius this large is indistinguishable from the full
 * filter and far cheaper. The step is chosen so the shrunk radius is always
 * about 4 pixels, so a half-size preview and the full-size file solve the
 * same small problem and agree.
 */
function guidedBase(luma, width, height) {
  const radius = Math.max(2, Math.round(CLARITY_RADIUS * Math.hypot(width, height)));
  const step = Math.max(1, Math.floor(radius / 4));
  const w = Math.max(1, Math.ceil(width / step));
  const h = Math.max(1, Math.ceil(height / step));
  const r = Math.max(1, Math.round(radius / step));

  const small = new Float32Array(w * h);
  const squares = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let sum2 = 0;
      let count = 0;
      for (let yy = y * step; yy < Math.min(height, (y + 1) * step); yy++) {
        for (let xx = x * step; xx < Math.min(width, (x + 1) * step); xx++) {
          const value = luma[yy * width + xx];
          sum += value;
          sum2 += value * value;
          count++;
        }
      }
      small[y * w + x] = sum / count;
      squares[y * w + x] = sum2 / count;
    }
  }

  const mean = boxMean(small, w, h, r);
  const meanSquares = boxMean(squares, w, h, r);
  const a = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) {
    const variance = Math.max(0, meanSquares[i] - mean[i] * mean[i]);
    a[i] = variance / (variance + CLARITY_EPS);
    b[i] = mean[i] - a[i] * mean[i];
  }
  return { a: boxMean(a, w, h, r), b: boxMean(b, w, h, r), w, h, step };
}

/**
 * Where full-resolution pixel `i` falls between two samples of a map shrunk
 * by `step`: the lower index, the upper one, and the weight of the upper.
 */
function upsampleAxis(size, small, step) {
  const lower = new Int32Array(size);
  const upper = new Int32Array(size);
  const weight = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const f = Math.min(small - 1, Math.max(0, (i + 0.5) / step - 0.5));
    lower[i] = f | 0;
    upper[i] = Math.min(small - 1, lower[i] + 1);
    weight[i] = f - lower[i];
  }
  return { lower, upper, weight };
}

/* ---------------------------------------------------------- noise reduction */

/**
 * Radii in pixels of the saved file. Luminance noise is fine-grained, so a
 * small window is enough and keeps texture; colour noise comes in blotches
 * several pixels across, and the eye resolves colour far more coarsely than
 * brightness, so it can be averaged over a wider one.
 */
const NOISE_LUMA_RADIUS = 2;
const NOISE_CHROMA_RADIUS = 4;
/**
 * Luminance variations with a local standard deviation below about this many
 * encoded units (x the slider) count as noise; stronger ones are texture or
 * edges and are kept. 0.035 is ~9/255 at 100.
 */
const NOISE_LUMA_SIGMA = 0.035;
/**
 * Regulariser for the colour filter. Small, so that even a faint brightness
 * edge under a colour edge (red against blue differs by only ~0.05 in
 * luminance) is enough to hold the colours apart. Over a flat area colour and
 * luminance noise are uncorrelated, so the colour still flattens there.
 */
const NOISE_CHROMA_EPS = 0.0001;

/** 1 / (window size) for each position along an axis, windows shrinking at the ends. */
const inverseCounts = new Map();
function inverseCount(size, r) {
  const key = `${size}:${r}`;
  let table = inverseCounts.get(key);
  if (!table) {
    table = new Float32Array(size);
    for (let i = 0; i < size; i++) table[i] = 1 / (Math.min(size - 1, i + r) - Math.max(0, i - r) + 1);
    if (inverseCounts.size > 16) inverseCounts.clear();
    inverseCounts.set(key, table);
  }
  return table;
}

/**
 * Mean over a (2r+1)^2 window into `out`, via running sums, with windows that
 * shrink at the edges. `temp` is scratch of the same size, and `column` of
 * one row. Nothing is allocated, which matters here: a full-size denoise makes
 * fourteen of these passes over 3.7 million pixels.
 *
 * Both passes walk memory in order. The vertical one keeps a running sum per
 * column and slides it down a row at a time, rather than walking each column
 * top to bottom, which would jump a whole row of memory per step.
 */
function boxMeanInto(src, width, height, r, temp, out, column) {
  const invX = inverseCount(width, r);
  const invY = inverseCount(height, r);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    const first = Math.min(r, width - 1);
    for (let x = 0; x <= first; x++) sum += src[row + x];
    for (let x = 0; x < width; x++) {
      temp[row + x] = sum * invX[x];
      if (x + r + 1 < width) sum += src[row + x + r + 1];
      if (x - r >= 0) sum -= src[row + x - r];
    }
  }
  column.fill(0, 0, width);
  const firstRow = Math.min(r, height - 1);
  for (let y = 0; y <= firstRow; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) column[x] += temp[row + x];
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const inv = invY[y];
    for (let x = 0; x < width; x++) out[row + x] = column[x] * inv;
    if (y + r + 1 < height) {
      const add = (y + r + 1) * width;
      for (let x = 0; x < width; x++) column[x] += temp[add + x];
    }
    if (y - r >= 0) {
      const sub = (y - r) * width;
      for (let x = 0; x < width; x++) column[x] -= temp[sub + x];
    }
  }
  return out;
}

/**
 * Edge-preserving noise reduction, in place, on encoded values.
 *
 * The picture is split into luminance and two colour-difference channels
 * (B - Y, R - Y) and each is smoothed with a guided filter (He, Sun & Tang):
 *
 *  - Luminance is its own guide. Where its local variance is well below the
 *    noise level the window is flattened to its mean; where it is above — an
 *    edge, a texture — the filter passes it through. The threshold grows with
 *    the slider, and so does the mix, so the control is continuous from 0.
 *  - The colour channels are guided by luminance. Their output follows the
 *    local luminance linearly, so a colour edge that coincides with a
 *    brightness edge stays sharp, while colour speckle over a flat area — the
 *    blotchy kind most visible in dark scenes — is averaged away.
 *
 * Recombining keeps the pixel's luminance exactly what the luminance filter
 * made it, so colour noise reduction cannot shift brightness.
 */
function applyDenoise(amount, data8, data16, width, height, scale) {
  const n = width * height;
  const Y = buffer("dn-y", n);
  const Cb = buffer("dn-cb", n);
  const Cr = buffer("dn-cr", n);
  const unit = data16 ? 1 / 65535 : 1 / 255;
  const src = data16 || data8;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = src[p] * unit;
    const g = src[p + 1] * unit;
    const b = src[p + 2] * unit;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    Y[i] = y;
    Cb[i] = b - y;
    Cr[i] = r - y;
  }

  const temp = buffer("dn-temp", n);
  const product = buffer("dn-product", n);
  const meanI = buffer("dn-mean-i", n);
  const meanII = buffer("dn-mean-ii", n);
  const coefA = buffer("dn-a", n);
  const coefB = buffer("dn-b", n);
  const meanA = buffer("dn-mean-a", n);
  const meanB = buffer("dn-mean-b", n);
  const meanP = buffer("dn-mean-p", n);
  const column = buffer("dn-column", width);

  // Luminance, self-guided.
  const rL = Math.max(1, Math.round(NOISE_LUMA_RADIUS * scale));
  const epsL = (NOISE_LUMA_SIGMA * amount) ** 2;
  for (let i = 0; i < n; i++) product[i] = Y[i] * Y[i];
  boxMeanInto(Y, width, height, rL, temp, meanI, column);
  boxMeanInto(product, width, height, rL, temp, meanII, column);
  for (let i = 0; i < n; i++) {
    const variance = Math.max(0, meanII[i] - meanI[i] * meanI[i]);
    coefA[i] = variance / (variance + epsL);
    coefB[i] = meanI[i] - coefA[i] * meanI[i];
  }
  boxMeanInto(coefA, width, height, rL, temp, meanA, column);
  boxMeanInto(coefB, width, height, rL, temp, meanB, column);
  const Yout = buffer("dn-y-out", n);
  for (let i = 0; i < n; i++) {
    const q = meanA[i] * Y[i] + meanB[i];
    Yout[i] = Y[i] + (q - Y[i]) * amount;
  }

  // Colour, guided by luminance. The guide's statistics are the same for both
  // channels, so its variance is computed once.
  const rC = Math.max(1, Math.round(NOISE_CHROMA_RADIUS * scale));
  for (let i = 0; i < n; i++) product[i] = Y[i] * Y[i];
  boxMeanInto(Y, width, height, rC, temp, meanI, column);
  boxMeanInto(product, width, height, rC, temp, meanII, column);
  for (let i = 0; i < n; i++) {
    const variance = meanII[i] - meanI[i] * meanI[i];
    meanII[i] = 1 / ((variance > 0 ? variance : 0) + NOISE_CHROMA_EPS);
  }
  for (const P of [Cb, Cr]) {
    for (let i = 0; i < n; i++) product[i] = Y[i] * P[i];
    boxMeanInto(P, width, height, rC, temp, meanP, column);
    boxMeanInto(product, width, height, rC, temp, coefB, column);   // mean of I*p, reused as scratch
    for (let i = 0; i < n; i++) {
      const covariance = coefB[i] - meanI[i] * meanP[i];
      coefA[i] = covariance * meanII[i];
      coefB[i] = meanP[i] - coefA[i] * meanI[i];
    }
    boxMeanInto(coefA, width, height, rC, temp, meanA, column);
    boxMeanInto(coefB, width, height, rC, temp, meanB, column);
    for (let i = 0; i < n; i++) {
      const q = meanA[i] * Y[i] + meanB[i];
      P[i] += (q - P[i]) * amount;
    }
  }

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const y = Yout[i];
    let r = y + Cr[i];
    let b = y + Cb[i];
    let g = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
    r = r < 0 ? 0 : r > 1 ? 1 : r;
    g = g < 0 ? 0 : g > 1 ? 1 : g;
    b = b < 0 ? 0 : b > 1 ? 1 : b;
    // A Uint8ClampedArray rounds to nearest on assignment; a Uint16Array
    // truncates, so only the 16-bit values need the half added.
    data8[p] = r * 255;
    data8[p + 1] = g * 255;
    data8[p + 2] = b * 255;
    if (data16) {
      data16[p] = r * 65535 + 0.5;
      data16[p + 1] = g * 65535 + 0.5;
      data16[p + 2] = b * 65535 + 0.5;
    }
  }
}

/**
 * Applies noise reduction, clarity and sharpness to a finished image, in place.
 *
 * Both work on luminance, as editors do, and add the same amount to all three
 * channels, which changes brightness locally without shifting colour or
 * drawing coloured fringes. They share one pass over the untouched luminance,
 * so neither sharpens the other's result.
 *
 * @param {{sharpness: number, clarity: number}} detail from `createDetail`
 * @param {Uint8ClampedArray} data8 RGBA, always updated
 * @param {Uint16Array|null} data16 RGBA; when given it is updated too, and
 *   the luminance is read from it, at full precision
 * @param {number} scale pixels of this image per pixel of the saved file:
 *   below 1 for a reduced live preview, so the sharpening radius shrinks
 *   with it and the preview approximates the file
 */
export function applyDetail(detail, data8, data16, width, height, scale = 1) {
  if (detail.noise) applyDenoise(detail.noise, data8, data16, width, height, scale);
  if (!detail.sharpness && !detail.clarity) return;
  const n = width * height;
  const luma = buffer("luma", n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    luma[i] = data16
      ? (0.2126 * data16[p] + 0.7152 * data16[p + 1] + 0.0722 * data16[p + 2]) / 65535
      : (0.2126 * data8[p] + 0.7152 * data8[p + 1] + 0.0722 * data8[p + 2]) / 255;
  }

  const blurred = detail.sharpness ? gaussianBlur(luma, width, height, Math.max(0.3, SHARP_SIGMA * scale)) : null;
  const base = detail.clarity ? guidedBase(luma, width, height) : null;
  const sharpen = detail.sharpness * SHARP_MAX;
  const clarity = detail.clarity * CLARITY_MAX;

  const across = base && upsampleAxis(width, base.w, base.step);
  const down = base && upsampleAxis(height, base.h, base.step);

  for (let y = 0, i = 0; y < height; y++) {
    let top = 0;
    let bottom = 0;
    let ty = 0;
    if (base) {
      top = down.lower[y] * base.w;
      bottom = down.upper[y] * base.w;
      ty = down.weight[y];
    }
    for (let x = 0; x < width; x++, i++) {
      const value = luma[i];
      let delta = 0;
      if (blurred) {
        const d = value - blurred[i];
        const magnitude = d < 0 ? -d : d;
        if (magnitude > SHARP_THRESHOLD) {
          const t = Math.min(1, (magnitude - SHARP_THRESHOLD) / SHARP_RAMP);
          delta += sharpen * d * t * t * (3 - 2 * t);
        }
      }
      if (base) {
        const x0 = across.lower[x];
        const x1 = across.upper[x];
        const tx = across.weight[x];
        const { a, b } = base;
        const aTop = a[top + x0] + (a[top + x1] - a[top + x0]) * tx;
        const aBottom = a[bottom + x0] + (a[bottom + x1] - a[bottom + x0]) * tx;
        const bTop = b[top + x0] + (b[top + x1] - b[top + x0]) * tx;
        const bBottom = b[bottom + x0] + (b[bottom + x1] - b[bottom + x0]) * tx;
        const q = (aTop + (aBottom - aTop) * ty) * value + bTop + (bBottom - bTop) * ty;
        // Weighted toward the midtones, so blacks do not crush and whites do
        // not clip as local contrast rises.
        const mid = 1 - (2 * value - 1) * (2 * value - 1);
        delta += clarity * (value - q) * mid;
      }
      if (!delta) continue;
      const p = i * 4;
      const d8 = delta * 255;
      data8[p] += d8;
      data8[p + 1] += d8;
      data8[p + 2] += d8;
      if (data16) {
        const d16 = delta * 65535;
        for (let c = 0; c < 3; c++) {
          const next = Math.round(data16[p + c] + d16);
          data16[p + c] = next < 0 ? 0 : next > 65535 ? 65535 : next;
        }
      }
    }
  }
}
