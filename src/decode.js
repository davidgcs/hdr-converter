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

function readColorSpace(frame, bitDepth) {
  const source = frame.colorSpace || {};
  const primaries = source.primaries || (bitDepth > 8 ? "bt2020" : "bt709");
  const transfer = source.transfer || (bitDepth > 8 ? "pq" : "iec61966-2-1");
  const matrix = source.matrix || (primaries === "bt2020" ? "bt2020-ncl" : "bt709");
  const fullRange = source.fullRange === null || source.fullRange === undefined ? false : source.fullRange;
  return { primaries, transfer, matrix, fullRange, tagged: Boolean(source.transfer) };
}

async function decodeWithWebCodecs(file) {
  const type = file.type || "image/avif";
  if (!(await window.ImageDecoder.isTypeSupported(type))) return null;

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

      return {
        kind: "planar",
        width,
        height,
        bitDepth: layoutInfo.bitDepth,
        subX: layoutInfo.subX,
        subY: layoutInfo.subY,
        y: plane(0, width, height),
        u: plane(1, chromaWidth, chromaHeight),
        v: plane(2, chromaWidth, chromaHeight),
        a: layoutInfo.alpha && layout[3] ? plane(3, width, height) : null,
        colorSpace: readColorSpace(frame, layoutInfo.bitDepth),
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
      colorSpace: { ...readColorSpace(frame, 8), matrix: "rgb" },
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
