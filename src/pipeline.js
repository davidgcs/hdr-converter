/**
 * HDR -> SDR conversion pipeline.
 *
 * Follows the chain FFmpeg recommends for this job:
 *
 *   zscale=t=linear:npl=100, format=gbrpf32le, zscale=p=bt709,
 *   tonemap=tonemap=...:desat=..., zscale=t=bt709:m=bt709:r=tv
 *
 * i.e. linearise the source transfer to absolute light with 100 cd/m2 as SDR
 * white, convert the gamut to BT.709, tone map in linear light, then re-encode
 * with an SDR transfer function. The default curve is the ITU-R BT.2390 EETF
 * rather than one of FFmpeg's, because it is the one designed to reproduce a
 * PQ master on a smaller display without changing what already fits.
 *
 * The API is deliberately stateless and file-at-a-time so that bulk editing
 * only needs to loop over items (see `convertAll`).
 */

import {
  COLOR_PRIMARIES,
  LUMA_COEFFICIENTS,
  REFERENCE_WHITE,
  hlgOotfFactor,
  inverseEotfSrgb,
  linearizeValue,
  rgb2rgbMatrix,
  yuv2rgbMatrix
} from "./colorspace.js";
import { createCurve, tonemapPixel } from "./tonemap.js";
import {
  GRADE_DEFAULTS,
  applyDetail,
  applyGrade,
  applyVignette,
  createDetail,
  createGrade,
  whiteBalanceGains
} from "./grade.js";
import { encodePng16, resize16 } from "./png.js";

export const DEFAULT_SETTINGS = Object.freeze({
  /**
   * Tone curve. "bt2390" is the ITU-R BT.2390 EETF (tonemap.js); the others are
   * ported from libavfilter/vf_tonemap.c.
   */
  algorithm: "bt2390",
  /** `null` keeps the default parameter for the selected curve. */
  param: null,
  /**
   * Highlight desaturation. FFmpeg defaults to 2, which pulls anything above
   * 200 cd/m2 toward grey; 0 keeps every colour's chromaticity as measured.
   */
  desat: 0,
  /** "auto" measures the peak, "standard" uses the transfer nominal peak. */
  peakMode: "auto",
  peakNits: 1000,
  /**
   * Luminance adaptation before the tone curve:
   * "standard"  — absolute light, 100 cd/m2 is SDR white (FFmpeg's npl=100);
   *               the faithful mapping, and the default,
   * "reference" — BT.2408, HDR reference white (203 cd/m2) is SDR white,
   * "auto"      — re-expose from the scene statistics (see resolveAdaptation).
   */
  brightness: "standard",
  /** Exposure compensation in stops, applied in linear light. */
  exposure: 0,
  /**
   * Display-referred tonal controls, applied after the tone curve. All are
   * neutral at 0, and the whole stage is skipped when they are (see grade.js).
   */
  ...GRADE_DEFAULTS,
  /** "auto" trusts the file tagging. */
  inputOverride: "auto",
  outputFormat: "image/jpeg",
  quality: 0.92,
  /** 0 keeps the cropped resolution. */
  maxDimension: 0
});

const LUT_SIZE = 4096;
const BAND_ROWS = 96;

/** ITU-R BT.2408 HDR reference (graphics) white, in nits. */
const HDR_REFERENCE_WHITE = 203;

/** Luminance histogram used by the scene measurement, in log2 space. */
const HISTOGRAM_BINS = 512;
const HISTOGRAM_MIN_LOG2 = -24;
const HISTOGRAM_MAX_LOG2 = 8;
const LUMA_EPSILON = 1e-6;

/**
 * Pixels below this (0.1 nits) are treated as black and left out of the scene
 * statistics. Letterbox bars, matte borders and crushed shadows carry no
 * tonal information, but there can be enough of them to dominate an average.
 */
const BLACK_FLOOR = 0.001;

/**
 * The adaptive mode anchors on the scene's diffuse white: the luminance the
 * brightest *ordinary* surfaces sit at, as opposed to speculars and light
 * sources. The 90th percentile of the lit pixels estimates it well, and
 * mapping it to 75 nits leaves the top of the scene room to roll off into
 * white instead of clipping there.
 */
const DIFFUSE_PERCENTILE = 0.9;
const DIFFUSE_TARGET = 0.75;
const MIN_ADAPTATION = 1 / 2;
const MAX_ADAPTATION = 32;

function transferOf(source, settings) {
  switch (settings.inputOverride) {
    case "pq":
      return { transfer: "pq", primaries: "bt2020", matrix: source.colorSpace.matrix };
    case "hlg":
      return { transfer: "hlg", primaries: "bt2020", matrix: source.colorSpace.matrix };
    case "sdr":
      return { transfer: "iec61966-2-1", primaries: "bt709", matrix: source.colorSpace.matrix };
    default:
      return {
        transfer: source.colorSpace.transfer,
        primaries: source.colorSpace.primaries,
        matrix: source.colorSpace.matrix
      };
  }
}

function buildLut(transfer) {
  const lut = new Float32Array(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) lut[i] = linearizeValue(transfer, i / LUT_SIZE);
  return lut;
}

function lutLookup(lut, transfer, value) {
  if (value <= 0) return 0;
  if (value >= 1) return linearizeValue(transfer, value);
  const position = value * LUT_SIZE;
  const index = position | 0;
  const fraction = position - index;
  return lut[index] + (lut[index + 1] - lut[index]) * fraction;
}

/** PQ and HLG carry HDR; everything else was graded for an SDR display. */
function isHdrTransfer(transfer) {
  return transfer === "pq" || transfer === "hlg";
}

/** The BT.2020 -> BT.709 matrix for a source, or null when none is needed. */
function gamutFor(primaries) {
  return rgb2rgbMatrix(primaries in COLOR_PRIMARIES ? primaries : "bt709", "bt709");
}

/**
 * Converts one linear pixel to BT.709 primaries, in place.
 *
 * Colours outside BT.709 come out of the matrix with a negative component.
 * Clipping that to zero, channel by channel, shifts both the hue and the
 * luminance of exactly the most saturated colours. Instead the colour is
 * mixed with the neutral grey of the same luminance, just far enough to bring
 * the negative component to zero: that moves its chromaticity straight toward
 * the white point, which keeps the dominant wavelength (the hue) and the
 * luminance unchanged and removes only the saturation BT.709 cannot show.
 */
function toBt709(gamut, rgb) {
  if (!gamut) return;
  const r = rgb[0];
  const g = rgb[1];
  const b = rgb[2];
  let r2 = gamut[0][0] * r + gamut[0][1] * g + gamut[0][2] * b;
  let g2 = gamut[1][0] * r + gamut[1][1] * g + gamut[1][2] * b;
  let b2 = gamut[2][0] * r + gamut[2][1] * g + gamut[2][2] * b;

  const low = Math.min(r2, g2, b2);
  if (low < 0) {
    const y = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
    if (y > 0) {
      const t = y / (y - low);
      r2 = y + t * (r2 - y);
      g2 = y + t * (g2 - y);
      b2 = y + t * (b2 - y);
    } else {
      r2 = g2 = b2 = 0;
    }
  }
  rgb[0] = r2 < 0 ? 0 : r2;
  rgb[1] = g2 < 0 ? 0 : g2;
  rgb[2] = b2 < 0 ? 0 : b2;
}

export function normalizeCrop(source, crop) {
  const full = { x: 0, y: 0, width: source.width, height: source.height };
  if (!crop) return full;
  const x = Math.max(0, Math.min(source.width - 1, Math.round(crop.x)));
  const y = Math.max(0, Math.min(source.height - 1, Math.round(crop.y)));
  const width = Math.max(1, Math.min(source.width - x, Math.round(crop.width)));
  const height = Math.max(1, Math.min(source.height - y, Math.round(crop.height)));
  return { x, y, width, height };
}

/**
 * Builds a reader that returns non-linear R'G'B' for one source pixel.
 * Handles both planar Y'CbCr (the HDR path) and interleaved RGBA.
 */
function createSampler(source, matrixName) {
  if (source.kind === "rgba") {
    const { data } = source;
    return (x, y, out) => {
      const index = (y * source.width + x) * 4;
      out[0] = data[index] / 255;
      out[1] = data[index + 1] / 255;
      out[2] = data[index + 2] / 255;
      out[3] = data[index + 3] / 255;
    };
  }

  const { y: planeY, u: planeU, v: planeV, a: planeA, bitDepth, subX, subY } = source;
  const maxValue = (1 << bitDepth) - 1;
  const shift = bitDepth - 8;
  const fullRange = source.colorSpace.fullRange;

  // Identity matrix: the planes already hold R, G and B, so no matrix applies.
  if (matrixName === "rgb") {
    const offset = fullRange ? 0 : 16 << shift;
    const scale = fullRange ? 1 / maxValue : 1 / (219 << shift);
    return (x, y, out) => {
      out[0] = (planeY.data[y * planeY.stride + x] - offset) * scale;
      out[1] = (planeU.data[y * planeU.stride + x] - offset) * scale;
      out[2] = (planeV.data[y * planeV.stride + x] - offset) * scale;
      out[3] = planeA ? planeA.data[y * planeA.stride + x] / maxValue : 1;
    };
  }

  const lumaOffset = fullRange ? 0 : 16 << shift;
  const lumaScale = fullRange ? 1 / maxValue : 1 / (219 << shift);
  const chromaOffset = fullRange ? 1 << (bitDepth - 1) : 128 << shift;
  const chromaScale = fullRange ? 1 / maxValue : 1 / (224 << shift);
  const { rv, gu, gv, bu } = yuv2rgbMatrix(matrixName);
  const subsampled = subX > 1 || subY > 1;

  /** Bilinear chroma upsampling with centred siting, as most decoders do. */
  const sampleChroma = (plane, x, y) => {
    const fx = (x + 0.5) / subX - 0.5;
    const fy = (y + 0.5) / subY - 0.5;
    const x0 = Math.max(0, Math.min(plane.width - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(plane.height - 1, Math.floor(fy)));
    const x1 = Math.min(plane.width - 1, x0 + 1);
    const y1 = Math.min(plane.height - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    const row0 = y0 * plane.stride;
    const row1 = y1 * plane.stride;
    const top = plane.data[row0 + x0] * (1 - tx) + plane.data[row0 + x1] * tx;
    const bottom = plane.data[row1 + x0] * (1 - tx) + plane.data[row1 + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  };

  return (x, y, out) => {
    const luma = (planeY.data[y * planeY.stride + x] - lumaOffset) * lumaScale;
    const rawCb = subsampled ? sampleChroma(planeU, x, y) : planeU.data[y * planeU.stride + x];
    const rawCr = subsampled ? sampleChroma(planeV, x, y) : planeV.data[y * planeV.stride + x];
    const cb = (rawCb - chromaOffset) * chromaScale;
    const cr = (rawCr - chromaOffset) * chromaScale;

    out[0] = luma + rv * cr;
    out[1] = luma + gu * cb + gv * cr;
    out[2] = luma + bu * cb;
    out[3] = planeA ? planeA.data[y * planeA.stride + x] / maxValue : 1;
  };
}

/**
 * Measures the signal peak of the (cropped) image in REFERENCE_WHITE units,
 * the role `ff_determine_signal_peak` plays when HDR metadata is available.
 * Browsers do not expose mastering metadata, so the content is measured
 * instead, on a subsampled grid to keep it cheap.
 */
/**
 * Measures the (cropped) image in one pass: the signal peak plus the
 * statistics needed to expose it.
 *
 * The peak alone plays the role of `ff_determine_signal_peak`, which
 * browsers cannot answer because they expose no mastering metadata. The
 * luminance histogram on top of it feeds the adaptation stage below.
 */
function measureScene(source, crop, transfer, matrixName, lut, coeffs, gamut) {
  const sample = createSampler(source, matrixName);
  const pixel = new Float32Array(4);
  const mapped = new Float32Array(3);
  const step = Math.max(1, Math.round(Math.min(crop.width, crop.height) / 720));
  const isHlg = transfer === "hlg";
  const counts = new Uint32Array(HISTOGRAM_BINS);
  const span = HISTOGRAM_MAX_LOG2 - HISTOGRAM_MIN_LOG2;
  let peak = 0;
  let signalPeak = 0;
  let logSum = 0;
  let lit = 0;

  // Every pixel is visited for the peaks, because the tone curve is built
  // around the brightest one: a peak taken from the sample grid can miss it,
  // and whatever lies above the curve's peak is clipped. The histogram only
  // needs the grid.
  for (let y = 0; y < crop.height; y++) {
    const onGridRow = y % step === 0;
    for (let x = 0; x < crop.width; x++) {
      sample(crop.x + x, crop.y + y, pixel);
      let r = lutLookup(lut, transfer, pixel[0]);
      let g = lutLookup(lut, transfer, pixel[1]);
      let b = lutLookup(lut, transfer, pixel[2]);
      if (isHlg) {
        const factor = hlgOotfFactor(coeffs.cr * r + coeffs.cg * g + coeffs.cb * b, 10);
        r *= factor;
        g *= factor;
        b *= factor;
      }
      // The source's own brightest component, as CTA-861.3 defines MaxCLL.
      const value = Math.max(r, g, b);
      if (value > peak) peak = value;

      // And the brightest component the tone curve will actually see, after
      // the conversion to BT.709 — saturated colours can come out of the
      // matrix brighter than they went in.
      mapped[0] = r;
      mapped[1] = g;
      mapped[2] = b;
      toBt709(gamut, mapped);
      const signal = Math.max(mapped[0], mapped[1], mapped[2]);
      if (signal > signalPeak) signalPeak = signal;

      if (!onGridRow || x % step !== 0) continue;
      const luma = Math.max(0, coeffs.cr * r + coeffs.cg * g + coeffs.cb * b);
      // Black pixels are excluded so that letterbox bars cannot move the
      // exposure: cropping them away has to leave the result unchanged.
      if (luma <= BLACK_FLOOR) continue;
      const log2Luma = Math.log2(luma + LUMA_EPSILON);
      logSum += log2Luma;
      lit++;
      const bin = Math.floor(((log2Luma - HISTOGRAM_MIN_LOG2) / span) * HISTOGRAM_BINS);
      counts[Math.max(0, Math.min(HISTOGRAM_BINS - 1, bin))]++;
    }
  }

  const percentile = (fraction) => {
    if (!lit) return 0;
    const target = lit * fraction;
    let seen = 0;
    for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
      seen += counts[bin];
      if (seen >= target) {
        return Math.pow(2, HISTOGRAM_MIN_LOG2 + ((bin + 0.5) / HISTOGRAM_BINS) * span);
      }
    }
    return Math.pow(2, HISTOGRAM_MAX_LOG2);
  };

  return {
    peak,
    /** The brightest BT.709 component, which is what the tone curve maps. */
    signalPeak,
    lit,
    logAverage: lit ? Math.pow(2, logSum / lit) : 0,
    /** Estimated diffuse white, in REFERENCE_WHITE units. */
    diffuse: percentile(DIFFUSE_PERCENTILE)
  };
}

export function resolvePeak(settings, scene, transfer) {
  if (settings.peakMode === "custom" || settings.peakMode === "standard") {
    const nits =
      settings.peakMode === "custom"
        ? settings.peakNits
        : transfer === "pq"
          ? 10000
          : transfer === "hlg"
            ? 1000
            : REFERENCE_WHITE;
    return Math.max(1, nits / REFERENCE_WHITE);
  }
  return Math.max(1, scene.signalPeak ?? scene.peak);
}

/**
 * Luminance adaptation — the stage that makes an HDR picture readable on an
 * SDR screen.
 *
 * FFmpeg's `tonemap` filter maps absolute luminance: `npl=100` pins 100 nits
 * to 1.0 and the curve only rolls off what sits above that. For video that is
 * the right call, because re-exposing every frame would flicker. For a single
 * picture it means a dim scene stays at its true handful of nits, which an HDR
 * screen renders beautifully and an SDR screen buries in its black floor.
 *
 * So the image is exposed before the curve runs, the way a photographer sets
 * exposure: find the scene's diffuse white — the level the brightest ordinary
 * surfaces sit at, ignoring speculars and light sources — and put it just
 * below SDR white, leaving the rest of the range to roll off into the
 * highlights.
 *
 * Reinhard's log-average key is the textbook estimator here, but it is not
 * robust for this job: it weighs every pixel equally, so a letterboxed frame
 * (29% pure black in one real case) reports a far lower average than the same
 * picture cropped, and the correction explodes. A high percentile of the lit
 * pixels measures the same thing without that failure mode, and is invariant
 * to how much matte surrounds the image.
 */
export function resolveAdaptation(settings, scene, transfer) {
  if (settings.brightness === "standard") return 1;
  // An SDR source is already graded for an SDR screen: there is nothing to
  // adapt, and re-exposing it would only fight the grade it arrived with.
  if (!isHdrTransfer(transfer)) return 1;
  if (settings.brightness === "reference") return REFERENCE_WHITE / HDR_REFERENCE_WHITE;

  const diffuse = scene.diffuse;
  if (!(diffuse > 0)) return 1;
  return Math.max(MIN_ADAPTATION, Math.min(MAX_ADAPTATION, DIFFUSE_TARGET / diffuse));
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Scratch for the encode below; single-threaded, so one instance is enough. */
const ENCODED = new Float32Array(3);

/**
 * The sRGB transfer function tabulated, for the live preview only.
 *
 * Three powers per pixel were well over half the cost of a preview frame.
 * Interpolated over 4096 steps the table is within about 0.005/255 of the
 * exact curve — below what 8 bits can show — and the downloadable file is
 * always encoded with the exact function, so it is unaffected.
 */
const SRGB_TABLE_SIZE = 4096;
const SRGB_TABLE = (() => {
  const table = new Float32Array(SRGB_TABLE_SIZE + 1);
  for (let i = 0; i <= SRGB_TABLE_SIZE; i++) table[i] = inverseEotfSrgb(i / SRGB_TABLE_SIZE);
  return table;
})();

function srgbPreview(value) {
  if (!(value > 0)) return 0;
  if (value >= 1) return 1;
  const position = value * SRGB_TABLE_SIZE;
  const index = position | 0;
  return SRGB_TABLE[index] + (SRGB_TABLE[index + 1] - SRGB_TABLE[index]) * (position - index);
}

/**
 * Encodes one tone-mapped pixel with the SDR transfer function and writes it
 * out, applying the display-referred grade if there is one.
 *
 * Shared by `renderPreview` and `convert` so the live canvas and the file that
 * gets downloaded cannot disagree about the last step of the pipeline.
 *
 * `out16`, when given, receives the same pixel at 16 bits per channel for the
 * PNG encoder; both are rounded from the same float, so they never disagree
 * by more than the 8-bit rounding itself. `u` and `v` are the pixel's place in
 * the frame, 0..1, for the vignette.
 */
function encodePixel(out, index, rgb, alpha, grade, out16, u, v, preview = false) {
  ENCODED[0] = Math.min(rgb[0], 1);
  ENCODED[1] = Math.min(rgb[1], 1);
  ENCODED[2] = Math.min(rgb[2], 1);
  if (grade?.vignette) applyVignette(grade, ENCODED, u, v);
  if (preview) {
    ENCODED[0] = srgbPreview(ENCODED[0]);
    ENCODED[1] = srgbPreview(ENCODED[1]);
    ENCODED[2] = srgbPreview(ENCODED[2]);
  } else {
    // The exact curve, called directly: the same function delinearizeValue
    // dispatches to, without comparing transfer names three times a pixel.
    ENCODED[0] = inverseEotfSrgb(ENCODED[0]);
    ENCODED[1] = inverseEotfSrgb(ENCODED[1]);
    ENCODED[2] = inverseEotfSrgb(ENCODED[2]);
  }
  if (grade) applyGrade(grade, ENCODED);
  const a = Math.min(Math.max(alpha, 0), 1);
  out[index] = Math.round(ENCODED[0] * 255);
  out[index + 1] = Math.round(ENCODED[1] * 255);
  out[index + 2] = Math.round(ENCODED[2] * 255);
  out[index + 3] = Math.round(a * 255);
  if (out16) {
    out16[index] = Math.round(Math.min(Math.max(ENCODED[0], 0), 1) * 65535);
    out16[index + 1] = Math.round(Math.min(Math.max(ENCODED[1], 0), 1) * 65535);
    out16[index + 2] = Math.round(Math.min(Math.max(ENCODED[2], 0), 1) * 65535);
    out16[index + 3] = Math.round(a * 65535);
  }
}

/**
 * Linearises the (cropped) source once so the exposure slider can be live.
 *
 * Everything up to and including the transfer-function inversion is fixed for
 * a given file and crop: unpacking the samples, upsampling chroma, the YUV
 * matrix and the LUT are by far the expensive part of a conversion, and none
 * of them depend on exposure. Caching the result lets `renderPreview` redraw
 * from a slider with only the cheap per-pixel maths left to do.
 *
 * The buffer is box-filtered down to `maxPixels` because it only feeds the
 * on-screen preview; the downloadable file is always rendered by `convert`
 * at full resolution.
 *
 * Scene statistics are measured from the *source*, not from this reduced
 * buffer, so the preview and the final render always resolve the same
 * exposure and cannot disagree about brightness.
 */
export function prepareScene(source, settings, crop, { maxPixels = 2.2e6 } = {}) {
  const options = { ...DEFAULT_SETTINGS, ...settings };
  const area = normalizeCrop(source, crop);
  const { transfer, primaries, matrix } = transferOf(source, options);
  const matrixName = source.kind === "rgba" ? "rgb" : matrix;
  const coeffs = LUMA_COEFFICIENTS[matrix]
    || LUMA_COEFFICIENTS[primaries === "bt2020" ? "bt2020-ncl" : "bt709"];
  const lut = buildLut(transfer);
  const scene = measureScene(source, area, transfer, matrixName, lut, coeffs, gamutFor(primaries));

  const step = Math.max(1, Math.ceil(Math.sqrt((area.width * area.height) / maxPixels)));
  const width = Math.max(1, Math.floor(area.width / step));
  const height = Math.max(1, Math.floor(area.height / step));

  const sample = createSampler(source, matrixName);
  const linear = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height);
  const pixel = new Float32Array(4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let taken = 0;
      // Box filter, so downscaling the preview does not alias the highlights
      // into something the full-resolution render will not reproduce.
      for (let dy = 0; dy < step; dy++) {
        const sy = area.y + y * step + dy;
        if (sy >= area.y + area.height) break;
        for (let dx = 0; dx < step; dx++) {
          const sx = area.x + x * step + dx;
          if (sx >= area.x + area.width) break;
          sample(sx, sy, pixel);
          r += lutLookup(lut, transfer, pixel[0]);
          g += lutLookup(lut, transfer, pixel[1]);
          b += lutLookup(lut, transfer, pixel[2]);
          a += pixel[3];
          taken++;
        }
      }
      const index = (y * width + x) * 3;
      linear[index] = r / taken;
      linear[index + 1] = g / taken;
      linear[index + 2] = b / taken;
      alpha[y * width + x] = a / taken;
    }
  }

  return { width, height, sourceWidth: area.width, sourceHeight: area.height, linear, alpha, scene, transfer, primaries, coeffs };
}

/**
 * Renders a cached scene at the requested settings.
 *
 * Runs the same decisions and the same maths as `convert` — it shares
 * `resolveAdaptation`, `resolvePeak`, `createCurve` and `tonemapPixel` — so a
 * live preview cannot drift away from the file that is finally encoded.
 */
export function renderPreview(prepared, settings) {
  const options = { ...DEFAULT_SETTINGS, ...settings };
  const { width, height, linear, alpha, scene, transfer, primaries, coeffs } = prepared;
  const gain = resolveAdaptation(options, scene, transfer) * Math.pow(2, options.exposure || 0);
  const lightPeak = Math.max(1, resolvePeak(options, scene, transfer) * gain);
  const balance = whiteBalanceGains(options);
  const peak = balancedPeak(lightPeak, balance);
  const curve = createCurve(options.algorithm, options.param, peak, { hdr: isHdrTransfer(transfer) });
  const gamut = gamutFor(primaries);
  const isHlg = transfer === "hlg";
  const grade = createGrade(options);

  const output = new ImageData(width, height);
  const out = output.data;
  const rgb = new Float32Array(3);

  for (let y = 0, i = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++, i++) {
      const p = i * 3;
      let r = linear[p];
      let g = linear[p + 1];
      let b = linear[p + 2];

      if (isHlg) {
        const factor = hlgOotfFactor(coeffs.cr * r + coeffs.cg * g + coeffs.cb * b, lightPeak);
        r *= factor;
        g *= factor;
        b *= factor;
      }

      rgb[0] = r * gain;
      rgb[1] = g * gain;
      rgb[2] = b * gain;
      toBt709(gamut, rgb);
      if (balance) balanceWhite(rgb, balance);
      tonemapPixel(rgb, curve, options.desat, coeffs);

      encodePixel(out, i * 4, rgb, alpha[i], grade, null, (x + 0.5) / width, v, true);
    }
  }

  // Clarity and sharpness are defined on the saved file, so a reduced preview
  // runs them at its own scale to look the way the file will.
  const detail = createDetail(options);
  if (detail) applyDetail(detail, out, null, width, height, width / outputSize(prepared, options).width);

  return output;
}

/** The size `encodeResult` will save a crop of this size at. */
function outputSize({ sourceWidth, sourceHeight }, { maxDimension }) {
  const longest = Math.max(sourceWidth, sourceHeight);
  if (!maxDimension || longest <= maxDimension) return { width: sourceWidth, height: sourceHeight };
  const scale = maxDimension / longest;
  return { width: Math.max(1, Math.round(sourceWidth * scale)), height: Math.max(1, Math.round(sourceHeight * scale)) };
}

/**
 * White balance can push one channel of the brightest pixel above the peak
 * the scene was measured at; the tone curve is built around the larger value
 * so it rolls that channel off rather than clipping it.
 */
function balancedPeak(peak, balance) {
  return balance ? peak * Math.max(balance[0], balance[1], balance[2], 1) : peak;
}

function balanceWhite(rgb, balance) {
  rgb[0] *= balance[0];
  rgb[1] *= balance[1];
  rgb[2] *= balance[2];
}

/**
 * Converts one decoded source into sRGB pixels: 8-bit always, and 16-bit as
 * well when the output format can carry it (PNG).
 *
 * @returns {Promise<{imageData: ImageData, pixels16: Uint16Array|null, peak: number, transfer: string, primaries: string}>}
 */
export async function convert(source, settings, crop, { onProgress, signal, scene: measured } = {}) {
  const options = { ...DEFAULT_SETTINGS, ...settings };
  const area = normalizeCrop(source, crop);
  const { transfer, primaries, matrix } = transferOf(source, options);
  const matrixName = source.kind === "rgba" ? "rgb" : matrix;
  // With the identity matrix there is no signalled luma matrix, so highlight
  // desaturation uses the coefficients that belong to the primaries.
  const coeffs = LUMA_COEFFICIENTS[matrix]
    || LUMA_COEFFICIENTS[primaries === "bt2020" ? "bt2020-ncl" : "bt709"];
  const lut = buildLut(transfer);
  const gamut = gamutFor(primaries);

  const scene = measured || measureScene(source, area, transfer, matrixName, lut, coeffs, gamut);
  // Adaptation happens in linear light before the curve, so the peak the curve
  // is built around has to move with it.
  const gain = resolveAdaptation(options, scene, transfer) * Math.pow(2, options.exposure || 0);
  const lightPeak = Math.max(1, resolvePeak(options, scene, transfer) * gain);
  const balance = whiteBalanceGains(options);
  const peak = balancedPeak(lightPeak, balance);
  const curve = createCurve(options.algorithm, options.param, peak, { hdr: isHdrTransfer(transfer) });
  const isHlg = transfer === "hlg";
  const grade = createGrade(options);

  const sample = createSampler(source, matrixName);
  const output = new ImageData(area.width, area.height);
  const out = output.data;
  const out16 = options.outputFormat === "image/png" ? new Uint16Array(area.width * area.height * 4) : null;
  const pixel = new Float32Array(4);
  const rgb = new Float32Array(3);

  for (let bandStart = 0; bandStart < area.height; bandStart += BAND_ROWS) {
    if (signal?.aborted) throw new DOMException("Conversion cancelled", "AbortError");
    const bandEnd = Math.min(area.height, bandStart + BAND_ROWS);

    for (let y = bandStart; y < bandEnd; y++) {
      let index = y * area.width * 4;
      for (let x = 0; x < area.width; x++) {
        sample(area.x + x, area.y + y, pixel);

        // 1. linearise the source transfer characteristics
        let r = lutLookup(lut, transfer, pixel[0]);
        let g = lutLookup(lut, transfer, pixel[1]);
        let b = lutLookup(lut, transfer, pixel[2]);

        // 2. HLG needs the OOTF to reach display light
        if (isHlg) {
          const factor = hlgOotfFactor(coeffs.cr * r + coeffs.cg * g + coeffs.cb * b, lightPeak);
          r *= factor;
          g *= factor;
          b *= factor;
        }

        // 3. optional exposure compensation, still in linear light
        rgb[0] = r * gain;
        rgb[1] = g * gain;
        rgb[2] = b * gain;

        // 4. gamut conversion (zscale=p=bt709), mapping rather than clipping
        //    what BT.709 cannot show, then white balance on that light
        toBt709(gamut, rgb);
        if (balance) balanceWhite(rgb, balance);

        // 5. tone map (tonemap.js)
        tonemapPixel(rgb, curve, options.desat, coeffs);

        // 6. encode with the SDR transfer function, then the display-referred
        //    tonal controls, if the user has touched any (src/grade.js)
        encodePixel(out, index, rgb, pixel[3], grade, out16, (x + 0.5) / area.width, (y + 0.5) / area.height);
        index += 4;
      }
    }

    onProgress?.(bandEnd / area.height);
    await yieldToBrowser();
  }

  return {
    imageData: output,
    pixels16: out16,
    // The measured content peak, in REFERENCE_WHITE units, for reporting.
    // Unclamped: content that never reaches SDR white should say so.
    peak: scene.peak,
    // What the curve was actually built around, after adaptation.
    curvePeak: peak,
    gain,
    transfer,
    primaries
  };
}

/** Draws converted pixels into a canvas, applying the optional size limit. */
export function toCanvas(imageData, maxDimension) {
  const source = document.createElement("canvas");
  source.width = imageData.width;
  source.height = imageData.height;
  source.getContext("2d").putImageData(imageData, 0, 0);

  const longestSide = Math.max(imageData.width, imageData.height);
  if (!maxDimension || longestSide <= maxDimension) return source;

  // Downscaling keeps the aspect ratio of the converted (cropped) image.
  const scale = maxDimension / longestSide;
  const target = document.createElement("canvas");
  target.width = Math.max(1, Math.round(imageData.width * scale));
  target.height = Math.max(1, Math.round(imageData.height * scale));
  const context = target.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, target.width, target.height);
  return target;
}

export function canvasToBlob(canvas, format, quality) {
  const opaque = format === "image/jpeg";
  let surface = canvas;

  if (opaque) {
    // JPEG has no alpha: flatten over white instead of the canvas default black.
    surface = document.createElement("canvas");
    surface.width = canvas.width;
    surface.height = canvas.height;
    const context = surface.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, surface.width, surface.height);
    context.drawImage(canvas, 0, 0);
  }

  return new Promise((resolve, reject) => {
    surface.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Encoding failed"))),
      format,
      format === "image/png" ? undefined : quality
    );
  });
}

/**
 * Encodes a conversion into the downloadable file, and the canvas the app
 * previews it with.
 *
 * JPEG and WebP go through the browser's encoder, which is 8-bit only; its
 * JPEG carries an embedded sRGB profile. PNG is written here instead, at
 * 16 bits per channel from the pipeline's own output, so the file keeps the
 * precision the tone curve produced rather than the canvas's 8 bits — which
 * matters most in exactly the dark gradients HDR scenes are full of.
 */
export async function encodeResult({ imageData, pixels16 }, settings) {
  const canvas = toCanvas(imageData, settings.maxDimension);
  const png = settings.outputFormat === "image/png" && pixels16;
  const resized = png && (canvas.width !== imageData.width || canvas.height !== imageData.height)
    ? resize16(pixels16, imageData.width, imageData.height, canvas.width, canvas.height)
    : pixels16;

  // Clarity and sharpness run last, on the image at the size it is saved at:
  // sharpening before a downscale would mostly be averaged away again.
  const detail = createDetail({ ...DEFAULT_SETTINGS, ...settings });
  if (detail) {
    const context = canvas.getContext("2d");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    applyDetail(detail, pixels.data, png ? resized : null, canvas.width, canvas.height);
    context.putImageData(pixels, 0, 0);
  }

  if (png) return { canvas, blob: encodePng16(resized, canvas.width, canvas.height) };
  return { canvas, blob: await canvasToBlob(canvas, settings.outputFormat, settings.quality) };
}

/**
 * Bulk entry point: converts every queued item with the same settings.
 * The single-image UI calls it with one item; a future bulk mode can pass many.
 */
export async function convertAll(items, settings, { onItemProgress, signal } = {}) {
  const results = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const result = await convert(item.source, settings, item.crop, {
      signal,
      onProgress: (ratio) => onItemProgress?.(index, ratio)
    });
    results.push({ item, result });
  }
  return results;
}
