/**
 * The work a render job does, shared by the worker and the main-thread
 * fallback so both produce exactly the same pixels.
 *
 * Everything here is DOM-free: the pipeline, the grade and the PNG writer
 * only use typed arrays, ImageData and Blob, which workers have too.
 */

import { convert, prepareScene } from "./pipeline.js";
import { applyDetail, createDetail } from "./grade.js";
import { encodePng16, resize16 } from "./png.js";

function outputSize(width, height, maxDimension) {
  const longest = Math.max(width, height);
  if (!maxDimension || longest <= maxDimension) return { width, height };
  const scale = maxDimension / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * `render`: converts a source at full resolution.
 *
 * With `detail`, clarity, sharpness and noise reduction are applied too, at
 * the full size — this is the lossless working image the app shows and edits.
 * Without, the pixels come back before them, for `encodeResult` to finish at
 * whatever size the file is saved at.
 */
async function render({ source, settings, crop, scene, detail }, progress, cooperative) {
  const converted = await convert(source, settings, crop, { scene, onProgress: progress, cooperative });
  const { imageData, pixels16 } = converted;
  if (detail) {
    const plan = createDetail(settings);
    if (plan) applyDetail(plan, imageData.data, pixels16, imageData.width, imageData.height, 1);
  }
  const result = {
    width: imageData.width,
    height: imageData.height,
    data: imageData.data,
    data16: pixels16 || null,
    peak: converted.peak,
    scene: converted.scene
  };
  return { result, transfer: [result.data.buffer, ...(result.data16 ? [result.data16.buffer] : [])] };
}

/**
 * `png`: the whole 16-bit PNG export — convert, resize in 16 bits, apply
 * the detail tools at the saved size, and write the file — so an export
 * leaves the page responsive. The same steps, in the same order, as
 * `encodeResult` takes for PNG, so the bytes are identical.
 */
async function png({ source, settings, crop, scene }, progress, cooperative) {
  const converted = await convert(source, { ...settings, outputFormat: "image/png" }, crop, { scene, onProgress: progress, cooperative });
  const { imageData, pixels16 } = converted;
  const size = outputSize(imageData.width, imageData.height, settings.maxDimension);
  const resized = size.width === imageData.width && size.height === imageData.height
    ? pixels16
    : resize16(pixels16, imageData.width, imageData.height, size.width, size.height);
  const plan = createDetail(settings);
  if (plan) {
    // The 16-bit pixels are what the file holds; the 8-bit copy only has to exist.
    applyDetail(plan, new Uint8ClampedArray(size.width * size.height * 4), resized, size.width, size.height);
  }
  return { result: { blob: encodePng16(resized, size.width, size.height), width: size.width, height: size.height }, transfer: [] };
}

/** `prepare`: the reduced linear buffer the live preview renders from. */
async function prepare({ source, settings, crop }) {
  const prepared = prepareScene(source, settings, crop);
  return { result: prepared, transfer: [prepared.linear.buffer, prepared.alpha.buffer] };
}

export const handlers = { render, png, prepare };
