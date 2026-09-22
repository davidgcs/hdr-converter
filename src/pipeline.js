/**
 * HDR -> SDR conversion pipeline.
 *
 * Mirrors the filter chain FFmpeg recommends for this job:
 *
 *   zscale=t=linear:npl=100, format=gbrpf32le, zscale=p=bt709,
 *   tonemap=tonemap=...:desat=..., zscale=t=bt709:m=bt709:r=tv
 *
 * i.e. linearise the source transfer, convert the gamut to BT.709, tone map in
 * linear light, then re-encode with an SDR transfer function.
 *
 * The API is deliberately stateless and file-at-a-time so that bulk editing
 * only needs to loop over items (see `convertAll`).
 */

import {
  COLOR_PRIMARIES,
  LUMA_COEFFICIENTS,
  REFERENCE_WHITE,
  delinearizeValue,
  hlgOotfFactor,
  linearizeValue,
  rgb2rgbMatrix,
  yuv2rgbMatrix
} from "./colorspace.js";
import { createCurve, tonemapPixel } from "./tonemap.js";

export const DEFAULT_SETTINGS = Object.freeze({
  /** Tone curve from libavfilter/vf_tonemap.c. */
  algorithm: "mobius",
  /** `null` keeps the FFmpeg default for the selected curve. */
  param: null,
  /** Desaturation strength, FFmpeg default. */
  desat: 2,
  /** "auto" measures the peak, "standard" uses the transfer nominal peak. */
  peakMode: "auto",
  peakNits: 1000,
  /** Exposure compensation in stops, applied in linear light. */
  exposure: 0,
  /** "auto" trusts the file tagging. */
  inputOverride: "auto",
  outputFormat: "image/jpeg",
  quality: 0.92,
  /** 0 keeps the cropped resolution. */
  maxDimension: 0
});

const LUT_SIZE = 4096;
const BAND_ROWS = 96;

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
function measurePeak(source, crop, transfer, matrixName, lut, coeffs) {
  const sample = createSampler(source, matrixName);
  const pixel = new Float32Array(4);
  const step = Math.max(1, Math.round(Math.min(crop.width, crop.height) / 720));
  const isHlg = transfer === "hlg";
  let peak = 0;

  for (let y = 0; y < crop.height; y += step) {
    for (let x = 0; x < crop.width; x += step) {
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
      const value = Math.max(r, g, b);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

export function resolvePeak(source, crop, settings, context) {
  if (settings.peakMode === "custom" || settings.peakMode === "standard") {
    const nits =
      settings.peakMode === "custom"
        ? settings.peakNits
        : context.transfer === "pq"
          ? 10000
          : context.transfer === "hlg"
            ? 1000
            : REFERENCE_WHITE;
    return Math.max(1, nits / REFERENCE_WHITE);
  }
  const measured = measurePeak(source, crop, context.transfer, context.matrix, context.lut, context.coeffs);
  return Math.max(1, measured);
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Converts one decoded source into 8-bit sRGB pixels.
 *
 * @returns {Promise<{imageData: ImageData, peak: number, transfer: string, primaries: string}>}
 */
export async function convert(source, settings, crop, { onProgress, signal } = {}) {
  const options = { ...DEFAULT_SETTINGS, ...settings };
  const area = normalizeCrop(source, crop);
  const { transfer, primaries, matrix } = transferOf(source, options);
  const matrixName = source.kind === "rgba" ? "rgb" : matrix;
  // With the identity matrix there is no signalled luma matrix, so highlight
  // desaturation uses the coefficients that belong to the primaries.
  const coeffs = LUMA_COEFFICIENTS[matrix]
    || LUMA_COEFFICIENTS[primaries === "bt2020" ? "bt2020-ncl" : "bt709"];
  const lut = buildLut(transfer);

  const peak = resolvePeak(source, area, options, { transfer, matrix: matrixName, lut, coeffs });
  const curve = createCurve(options.algorithm, options.param, peak);
  const gamut = rgb2rgbMatrix(primaries in COLOR_PRIMARIES ? primaries : "bt709", "bt709");
  const gain = Math.pow(2, options.exposure || 0);
  const isHlg = transfer === "hlg";

  const sample = createSampler(source, matrixName);
  const output = new ImageData(area.width, area.height);
  const out = output.data;
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
          const factor = hlgOotfFactor(coeffs.cr * r + coeffs.cg * g + coeffs.cb * b, peak);
          r *= factor;
          g *= factor;
          b *= factor;
        }

        // 3. optional exposure compensation, still in linear light
        if (gain !== 1) {
          r *= gain;
          g *= gain;
          b *= gain;
        }

        // 4. gamut conversion (zscale=p=bt709)
        if (gamut) {
          const lr = r;
          const lg = g;
          const lb = b;
          r = gamut[0][0] * lr + gamut[0][1] * lg + gamut[0][2] * lb;
          g = gamut[1][0] * lr + gamut[1][1] * lg + gamut[1][2] * lb;
          b = gamut[2][0] * lr + gamut[2][1] * lg + gamut[2][2] * lb;
          if (r < 0) r = 0;
          if (g < 0) g = 0;
          if (b < 0) b = 0;
        }

        // 5. tone map (libavfilter/vf_tonemap.c)
        rgb[0] = r;
        rgb[1] = g;
        rgb[2] = b;
        tonemapPixel(rgb, curve, options.desat, coeffs);

        // 6. encode with the SDR transfer function
        out[index] = Math.round(delinearizeValue("iec61966-2-1", Math.min(rgb[0], 1)) * 255);
        out[index + 1] = Math.round(delinearizeValue("iec61966-2-1", Math.min(rgb[1], 1)) * 255);
        out[index + 2] = Math.round(delinearizeValue("iec61966-2-1", Math.min(rgb[2], 1)) * 255);
        out[index + 3] = Math.round(Math.min(Math.max(pixel[3], 0), 1) * 255);
        index += 4;
      }
    }

    onProgress?.(bandEnd / area.height);
    await yieldToBrowser();
  }

  return { imageData: output, peak, transfer, primaries };
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
