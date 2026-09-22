/**
 * Decoding layer.
 *
 * Preferred path: WebCodecs `ImageDecoder`, which hands back the *untouched*
 * planar samples of an HDR file (for example 10-bit BT.2020 PQ from an AVIF).
 * That is what makes a real tone map possible: drawing an HDR image on a 2D
 * canvas would let the browser clip it to SDR before we ever see the pixels.
 *
 * Fallback path: `createImageBitmap` + 2D canvas. The samples are already
 * SDR-clipped by the browser, so the result is flagged as degraded.
 */

import { readFileColorTags } from "./cicp.js";

const PLANAR_FORMATS = {
  I420: { bitDepth: 8, subX: 2, subY: 2, alpha: false },
  I420A: { bitDepth: 8, subX: 2, subY: 2, alpha: true },
  I422: { bitDepth: 8, subX: 2, subY: 1, alpha: false },
  I444: { bitDepth: 8, subX: 1, subY: 1, alpha: false },
  I444A: { bitDepth: 8, subX: 1, subY: 1, alpha: true },
  I420P10: { bitDepth: 10, subX: 2, subY: 2, alpha: false },
  I420P12: { bitDepth: 12, subX: 2, subY: 2, alpha: false },
  I422P10: { bitDepth: 10, subX: 2, subY: 1, alpha: false },
  I422P12: { bitDepth: 12, subX: 2, subY: 1, alpha: false },
  I444P10: { bitDepth: 10, subX: 1, subY: 1, alpha: false },
  I444P12: { bitDepth: 12, subX: 1, subY: 1, alpha: false }
};

const DEFAULT_COLOR_SPACE = {
  primaries: "bt709",
  transfer: "iec61966-2-1",
  matrix: "rgb",
  fullRange: true
};

export function supportsWebCodecs() {
  return typeof window !== "undefined" && typeof window.ImageDecoder === "function";
}

function readColorSpace(frame, bitDepth, tags) {
  const source = frame.colorSpace || {};
  const primaries = tags?.primaries || source.primaries || (bitDepth > 8 ? "bt2020" : "bt709");
  const transfer = tags?.transfer || source.transfer || (bitDepth > 8 ? "pq" : "iec61966-2-1");
  // The container wins on the matrix: `VideoColorSpace.matrix` has no value for
  // the identity (GBR) matrix and reports null for it, which must not be
  // mistaken for "unspecified, assume a YUV matrix".
  const matrix = tags?.matrix || source.matrix || (primaries === "bt2020" ? "bt2020-ncl" : "bt709");
  const rawFullRange = tags?.fullRange ?? source.fullRange;
  const fullRange = rawFullRange === null || rawFullRange === undefined ? false : rawFullRange;
  return {
    primaries,
    transfer,
    matrix,
    fullRange,
    tagged: Boolean(tags?.transfer || source.transfer),
    matrixTagged: Boolean(tags?.matrix || source.matrix)
  };
}

/**
 * Last-resort check for untagged 4:4:4 frames: real Cb/Cr planes hover around
 * the midpoint of the range, while GBR planes follow the picture content. If
 * both "chroma" planes sit far from the midpoint the data cannot be Y'CbCr.
 */
function looksLikeGbr(planeU, planeV, bitDepth) {
  const midpoint = 1 << (bitDepth - 1);
  const limit = midpoint * 0.5;
  const mean = (plane) => {
    const stepX = Math.max(1, Math.floor(plane.width / 64));
    const stepY = Math.max(1, Math.floor(plane.height / 64));
    let total = 0;
    let count = 0;
    for (let y = 0; y < plane.height; y += stepY) {
      for (let x = 0; x < plane.width; x += stepX) {
        total += plane.data[y * plane.stride + x];
        count++;
      }
    }
    return count ? total / count : midpoint;
  };
  return Math.abs(mean(planeU) - midpoint) > limit && Math.abs(mean(planeV) - midpoint) > limit;
}

async function decodeWithWebCodecs(file) {
  const type = file.type || "image/avif";
  if (!(await window.ImageDecoder.isTypeSupported(type))) return null;

  const tags = await readFileColorTags(file);
  const decoder = new window.ImageDecoder({ data: await file.arrayBuffer(), type });
  let frame = null;
  try {
    await decoder.completed;
    const decoded = await decoder.decode({ frameIndex: 0 });
    frame = decoded.image;

    const rect = frame.visibleRect || { width: frame.codedWidth, height: frame.codedHeight };
    const width = rect.width;
    const height = rect.height;
    const layoutInfo = PLANAR_FORMATS[frame.format];

    if (layoutInfo) {
      const buffer = new Uint8Array(frame.allocationSize());
      const layout = await frame.copyTo(buffer);
      const bytes = layoutInfo.bitDepth > 8 ? 2 : 1;
      const Sample = bytes === 2 ? Uint16Array : Uint8Array;
      const chromaWidth = Math.ceil(width / layoutInfo.subX);
      const chromaHeight = Math.ceil(height / layoutInfo.subY);

      const plane = (index, planeWidth, planeHeight) => {
        const { offset, stride } = layout[index];
        const rowSamples = Math.floor(stride / bytes);
        const byteOffset = buffer.byteOffset + offset;
        const samples = rowSamples * planeHeight;
        // Uint16Array views need a 2-byte aligned offset; copy when it is not.
        const view = byteOffset % bytes === 0
          ? new Sample(buffer.buffer, byteOffset, samples)
          : new Sample(buffer.slice(offset, offset + samples * bytes).buffer);
        return { data: view, stride: rowSamples, width: planeWidth, height: planeHeight };
      };

      const planeY = plane(0, width, height);
      const planeU = plane(1, chromaWidth, chromaHeight);
      const planeV = plane(2, chromaWidth, chromaHeight);
      const colorSpace = readColorSpace(frame, layoutInfo.bitDepth, tags);

      // AV1 codes identity-matrix pictures as G, B, R in the Y, U, V planes.
      const identity = tags?.identity
        || (!colorSpace.matrixTagged
          && layoutInfo.subX === 1
          && layoutInfo.subY === 1
          && looksLikeGbr(planeU, planeV, layoutInfo.bitDepth));

      if (identity) colorSpace.matrix = "rgb";

      return {
        kind: "planar",
        width,
        height,
        bitDepth: layoutInfo.bitDepth,
        subX: layoutInfo.subX,
        subY: layoutInfo.subY,
        // Identity keeps the coded plane order G, B, R: expose it as R, G, B.
        y: identity ? planeV : planeY,
        u: identity ? planeY : planeU,
        v: identity ? planeU : planeV,
        a: layoutInfo.alpha && layout[3] ? plane(3, width, height) : null,
        colorSpace,
        decoder: "webcodecs",
        accurate: true
      };
    }

    // Interleaved or exotic layouts (NV12, RGBA, ...) are always 8-bit here,
    // so letting WebCodecs convert to RGBA loses nothing: an HDR file would
    // have been handed over as a high bit depth planar frame instead.
    const buffer = new Uint8ClampedArray(frame.allocationSize({ format: "RGBA" }));
    await frame.copyTo(buffer, { format: "RGBA" });
    return {
      kind: "rgba",
      width,
      height,
      bitDepth: 8,
      data: buffer,
      colorSpace: { ...readColorSpace(frame, 8, tags), matrix: "rgb" },
      decoder: "webcodecs",
      accurate: true
    };
  } finally {
    frame?.close();
    decoder.close();
  }
}

async function decodeWithCanvas(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      kind: "rgba",
      width: bitmap.width,
      height: bitmap.height,
      bitDepth: 8,
      data: imageData.data,
      colorSpace: { ...DEFAULT_COLOR_SPACE, tagged: false },
      decoder: "canvas",
      accurate: false
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Decodes one file into raw samples the pipeline can tone map.
 * Kept file-at-a-time on purpose so a future bulk mode can simply map over
 * a list of files without touching this module.
 */
export async function decodeFile(file) {
  if (supportsWebCodecs()) {
    try {
      const decoded = await decodeWithWebCodecs(file);
      if (decoded) return decoded;
    } catch {
      // Fall through: some builds expose ImageDecoder but fail on the codec.
    }
  }
  return decodeWithCanvas(file);
}
