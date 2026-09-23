import { createTranslator, translations } from "./src/i18n.js";
import { decodeFile, supportsWebCodecs } from "./src/decode.js";
import {
  DEFAULT_SETTINGS,
  convert,
  encodeResult,
  normalizeCrop,
  prepareScene,
  renderPreview
} from "./src/pipeline.js";
import { REFERENCE_WHITE } from "./src/colorspace.js";
import { GRADE_DEFAULTS, GRADE_KEYS } from "./src/grade.js";

const STORAGE_KEYS = {
  language: "hdr-converter-language",
  theme: "hdr-converter-theme",
  settings: "hdr-converter-settings"
};

const MIN_CROP_PX = 16;
const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const elements = {
  metaDescription: document.querySelector("#meta-description"),
  language: document.querySelector("#language"),
  theme: document.querySelector("#theme"),
  file: document.querySelector("#file"),
  addFiles: document.querySelector("#add-files"),
  convert: document.querySelector("#convert"),
  crop: document.querySelector("#crop"),
  cropReset: document.querySelector("#crop-reset"),
  clear: document.querySelector("#clear"),
  status: document.querySelector("#status"),
  progress: document.querySelector(".progress"),
  bar: document.querySelector("#bar"),
  sourceEmpty: document.querySelector("#source-empty"),
  sourcePage: document.querySelector("#source-page"),
  sourceImage: document.querySelector("#source-image"),
  sourceNote: document.querySelector("#source-note"),
  overlay: document.querySelector("#crop-overlay"),
  resultEmpty: document.querySelector("#result-empty"),
  resultPage: document.querySelector("#result-page"),
  resultImage: document.querySelector("#result-image"),
  resultPreview: document.querySelector("#result-preview"),
  resultNote: document.querySelector("#result-note"),
  stageActions: document.querySelector("#stage-actions"),
  adjust: document.querySelector("#adjust"),
  adjustDialog: document.querySelector("#adjust-dialog"),
  adjustClose: document.querySelector("#adjust-close"),
  adjustReset: document.querySelector("#adjust-reset"),
  adjustCanvas: document.querySelector("#adjust-canvas"),
  compare: document.querySelector("#compare"),
  compareDialog: document.querySelector("#compare-dialog"),
  compareClose: document.querySelector("#compare-close"),
  compareViewport: document.querySelector("#compare-viewport"),
  compareBefore: document.querySelector("#compare-before"),
  compareAfter: document.querySelector("#compare-after"),
  compareDivider: document.querySelector("#compare-divider"),
  queue: document.querySelector("#queue"),
  brightness: document.querySelector("#brightness"),
  openTab: document.querySelector("#open-tab"),
  download: document.querySelector("#download"),
  downloadAll: document.querySelector("#download-all"),
  algorithm: document.querySelector("#algorithm"),
  peakMode: document.querySelector("#peak-mode"),
  peakNitsField: document.querySelector("#peak-nits-field"),
  peakNits: document.querySelector("#peak-nits"),
  desat: document.querySelector("#desat"),
  desatValue: document.querySelector("#desat-value"),
  format: document.querySelector("#format"),
  qualityField: document.querySelector("#quality-field"),
  quality: document.querySelector("#quality"),
  qualityValue: document.querySelector("#quality-value"),
  aspect: document.querySelector("#aspect"),
  inputOverride: document.querySelector("#input-override"),
  param: document.querySelector("#param"),
  exposure: document.querySelector("#exposure"),
  exposureValue: document.querySelector("#exposure-value"),
  contrast: document.querySelector("#contrast"),
  highlights: document.querySelector("#highlights"),
  shadows: document.querySelector("#shadows"),
  whites: document.querySelector("#whites"),
  blacks: document.querySelector("#blacks"),
  saturation: document.querySelector("#saturation"),
  maxDimension: document.querySelector("#max-dimension"),
  resetSettings: document.querySelector("#reset-settings")
};

const state = {
  language: "en",
  theme: "light",
  status: { key: "INITIAL_STATUS", params: {} },
  items: [],
  activeId: null,
  cropMode: false,
  processing: false,
  aspect: "original"
};

const translate = createTranslator(() => state.language);
let selection = null;
let nextId = 1;

/* ---------------------------------------------------------------- tooltips */

/** Which explanation belongs to which control. */
const TIPS = {
  algorithm: "TIP_TONEMAP",
  brightness: "TIP_BRIGHTNESS",
  "peak-mode": "TIP_PEAK",
  "peak-nits": "TIP_PEAK_NITS",
  desat: "TIP_DESAT",
  format: "TIP_FORMAT",
  quality: "TIP_QUALITY",
  aspect: "TIP_ASPECT",
  "input-override": "TIP_INPUT",
  param: "TIP_PARAM",
  exposure: "TIP_EXPOSURE",
  contrast: "TIP_CONTRAST",
  highlights: "TIP_HIGHLIGHTS",
  shadows: "TIP_SHADOWS",
  whites: "TIP_WHITES",
  blacks: "TIP_BLACKS",
  saturation: "TIP_SATURATION",
  "max-dimension": "TIP_MAXDIM"
};

const tip = document.createElement("div");
tip.className = "tip";
tip.setAttribute("role", "tooltip");
tip.hidden = true;
document.body.append(tip);

let tipAnchor = null;

function showTip(button) {
  tipAnchor = button;
  tip.textContent = translate(button.dataset.tip);
  // A modal dialog renders in the top layer, above everything in the document,
  // so a tooltip left on <body> would be hidden behind it. Position is fixed
  // either way, so moving it keeps the coordinates below valid.
  (button.closest("dialog") || document.body).append(tip);
  tip.hidden = false;

  const anchor = button.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  const margin = 8;
  // Keep the bubble on screen: prefer above the icon, flip below when there is
  // no room, and never let it run off either edge.
  const left = Math.min(
    Math.max(margin, anchor.left + anchor.width / 2 - box.width / 2),
    window.innerWidth - box.width - margin
  );
  const above = anchor.top - box.height - margin;
  tip.style.left = `${left}px`;
  tip.style.top = `${above < margin ? anchor.bottom + margin : above}px`;
}

function hideTip() {
  tip.hidden = true;
  if (tipAnchor) tipAnchor.setAttribute("aria-expanded", "false");
  tipAnchor = null;
}

/**
 * Adds an "i" button to every labelled control listed in TIPS.
 *
 * Generated rather than written into the markup so a control and its
 * explanation cannot drift apart, and so adding a setting only means adding
 * one entry above plus one translation.
 */
function decorateSettings() {
  for (const [id, key] of Object.entries(TIPS)) {
    const label = document.querySelector(`#${id}`)?.closest(".setting")?.querySelector(".field-label");
    if (!label) continue;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "info";
    button.dataset.tip = key;
    button.setAttribute("aria-expanded", "false");
    button.textContent = "i";
    button.addEventListener("pointerenter", () => showTip(button));
    button.addEventListener("pointerleave", hideTip);
    button.addEventListener("focus", () => showTip(button));
    button.addEventListener("blur", hideTip);
    button.addEventListener("click", (event) => {
      // The button lives inside a <label>, so a bare click would focus the
      // control instead of toggling the explanation.
      event.preventDefault();
      const open = button.getAttribute("aria-expanded") === "true";
      hideTip();
      if (!open) {
        button.setAttribute("aria-expanded", "true");
        showTip(button);
      }
    });

    // The label itself carries the translation key, and translating sets
    // textContent — which would wipe the button straight back out. Move the
    // key onto an inner span so label text and icon can coexist.
    const text = document.createElement("span");
    text.dataset.i18n = label.dataset.i18n;
    text.textContent = label.textContent;
    delete label.dataset.i18n;
    label.replaceChildren(text, button);
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideTip();
  });
  window.addEventListener("scroll", hideTip, true);
}

/* ---------------------------------------------------------------- language */

function getInitialLanguage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.language);
    if (saved && translations[saved]) return saved;
  } catch {
    // Some file:// contexts disable storage. Browser language remains a safe fallback.
  }
  return navigator.language.toLowerCase().startsWith("es") ? "es" : "en";
}

function getInitialTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.theme);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // Theme persistence is optional.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  state.theme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  updateThemeControl();
  try {
    localStorage.setItem(STORAGE_KEYS.theme, state.theme);
  } catch {
    // Theme persistence is optional.
  }
}

function updateThemeControl() {
  const isDark = state.theme === "dark";
  elements.theme.setAttribute("aria-checked", String(isDark));
  elements.theme.setAttribute("aria-label", translate(isDark ? "LIGHT_THEME_LABEL" : "DARK_THEME_LABEL"));
}

function applyLanguage(language) {
  state.language = translations[language] ? language : "en";
  document.documentElement.lang = state.language;
  document.title = translate("PAGE_TITLE");
  elements.metaDescription.content = translate("META_DESCRIPTION");
  elements.language.value = state.language;

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = translate(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", translate(element.dataset.i18nAriaLabel));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    element.title = translate(element.dataset.i18nTitle);
  });
  if (tipAnchor) showTip(tipAnchor);

  updateThemeControl();
  updateControls();
  updateSourceNote();
  setStatus(state.status.key, state.status.params);

  try {
    localStorage.setItem(STORAGE_KEYS.language, state.language);
  } catch {
    // Language persistence is optional.
  }
}

/* ------------------------------------------------------------------ status */

function setStatus(key, params = {}) {
  state.status = { key, params };
  elements.status.textContent = translate(key, params);
}

function setProgress(value) {
  const percentage = Math.round(Math.max(0, Math.min(1, value)) * 100);
  elements.bar.style.width = `${percentage}%`;
  elements.progress.setAttribute("aria-valuenow", String(percentage));
}

function setBusy(isBusy) {
  state.processing = isBusy;
  updateControls();
}

/* ---------------------------------------------------------------- settings */

/** The adjust panel's controls, keyed exactly as the pipeline expects them. */
function readGrade() {
  return Object.fromEntries(GRADE_KEYS.map((key) => [key, Number(elements[key].value)]));
}

function readSettings() {
  const param = elements.param.value.trim();
  return {
    algorithm: elements.algorithm.value,
    param: param === "" ? null : Number(param),
    desat: Number(elements.desat.value),
    brightness: elements.brightness.value,
    peakMode: elements.peakMode.value,
    peakNits: Number(elements.peakNits.value) || DEFAULT_SETTINGS.peakNits,
    exposure: Number(elements.exposure.value),
    ...readGrade(),
    inputOverride: elements.inputOverride.value,
    outputFormat: elements.format.value,
    quality: Number(elements.quality.value) / 100,
    maxDimension: Number(elements.maxDimension.value)
  };
}

function writeSettings(settings) {
  elements.algorithm.value = settings.algorithm;
  elements.param.value = settings.param === null || settings.param === undefined ? "" : settings.param;
  elements.desat.value = settings.desat;
  elements.brightness.value = settings.brightness;
  elements.peakMode.value = settings.peakMode;
  elements.peakNits.value = settings.peakNits;
  elements.exposure.value = settings.exposure;
  for (const key of GRADE_KEYS) elements[key].value = settings[key] ?? 0;
  elements.inputOverride.value = settings.inputOverride;
  elements.format.value = settings.outputFormat;
  elements.quality.value = Math.round(settings.quality * 100);
  elements.maxDimension.value = String(settings.maxDimension);
  updateSettingVisibility();
}

/**
 * Bumped whenever a tone default changes. Settings saved by an older version
 * only keep the preferences that are still meaningful — the output format,
 * quality, size limit and crop ratio — because a stored tone curve or
 * brightness mode from back when it was the default is indistinguishable from
 * a deliberate choice, and restoring it would silently keep the old look.
 */
const SETTINGS_VERSION = 2;
const RETIRED_ON_UPGRADE = ["algorithm", "param", "desat", "brightness", "exposure"];

function persistSettings() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({ ...readSettings(), aspect: state.aspect, version: SETTINGS_VERSION })
    );
  } catch {
    // Settings persistence is optional.
  }
}

function restoreSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || "null");
  } catch {
    saved = null;
  }
  if (saved && saved.version !== SETTINGS_VERSION) {
    for (const key of RETIRED_ON_UPGRADE) delete saved[key];
  }
  const settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  writeSettings(settings);
  state.aspect = saved?.aspect || "original";
  elements.aspect.value = state.aspect;
}

function updateSettingVisibility() {
  elements.peakNitsField.classList.toggle("setting--hidden", elements.peakMode.value !== "custom");
  elements.qualityField.classList.toggle("setting--hidden", elements.format.value === "image/png");
  elements.desatValue.textContent = elements.desat.value;
  elements.qualityValue.textContent = elements.quality.value;
  elements.exposureValue.textContent = Number(elements.exposure.value).toFixed(2);
  for (const key of GRADE_KEYS) {
    document.querySelector(`#${key}-value`).textContent = elements[key].value;
  }
  elements.adjustReset.disabled = isNeutralAdjust();
}

/** True when the adjust panel would not change the conversion at all. */
function isNeutralAdjust() {
  return !Number(elements.exposure.value) && GRADE_KEYS.every((key) => !Number(elements[key].value));
}

/** Puts the adjust panel back to the neutral, faithful conversion. */
function resetAdjust() {
  elements.exposure.value = "0";
  for (const key of GRADE_KEYS) elements[key].value = String(GRADE_DEFAULTS[key]);
  updateSettingVisibility();
}

/* ------------------------------------------------------------------- items */

function activeItem() {
  return state.items.find((item) => item.id === state.activeId) || null;
}

function aspectRatio(item) {
  if (state.aspect === "free") return null;
  if (state.aspect === "original") return item ? item.source.width / item.source.height : null;
  const [w, h] = state.aspect.split(":").map(Number);
  return w && h ? w / h : null;
}

function fitCropToRatio(item, rect, ratio) {
  if (!ratio) return rect;
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const maxWidth = Math.min(rect.width, item.source.width);
  const maxHeight = Math.min(rect.height, item.source.height);

  let width = maxWidth;
  let height = width / ratio;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * ratio;
  }

  const x = Math.min(Math.max(centerX - width / 2, 0), item.source.width - width);
  const y = Math.min(Math.max(centerY - height / 2, 0), item.source.height - height);
  return { x, y, width, height };
}

function fullCrop(item) {
  return { x: 0, y: 0, width: item.source.width, height: item.source.height };
}

function currentCrop(item) {
  return item?.crop ? item.crop : item ? fullCrop(item) : null;
}

/* ------------------------------------------------------------------ layout */

function overlayScale(item) {
  const rect = elements.sourceImage.getBoundingClientRect();
  if (!rect.width || !item) return 1;
  return rect.width / item.source.width;
}

function renderSelection() {
  const item = activeItem();
  if (!item || !state.cropMode) {
    selection?.root.remove();
    selection = null;
    elements.overlay.classList.remove("crop-mode");
    return;
  }

  elements.overlay.classList.add("crop-mode");
  if (!selection) selection = createSelection();

  const scale = overlayScale(item);
  const crop = currentCrop(item);
  Object.assign(selection.root.style, {
    left: `${crop.x * scale}px`,
    top: `${crop.y * scale}px`,
    width: `${crop.width * scale}px`,
    height: `${crop.height * scale}px`
  });
}

function createSelection() {
  const root = document.createElement("div");
  root.className = "crop-selection";
  const handles = {};
  ["nw", "ne", "se", "sw"].forEach((direction) => {
    const handle = document.createElement("div");
    handle.className = `crop-handle crop-handle--${direction}`;
    handle.dataset.direction = direction;
    root.append(handle);
    handles[direction] = handle;
  });
  elements.overlay.append(root);
  return { root, handles };
}

function renderQueue() {
  elements.queue.replaceChildren();
  elements.queue.hidden = state.items.length < 2;
  if (state.items.length < 2) return;

  state.items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "queue-item";
    button.setAttribute("aria-current", String(item.id === state.activeId));
    const thumb = document.createElement("img");
    thumb.src = item.resultUrl || item.previewUrl;
    thumb.alt = "";
    const label = document.createElement("span");
    label.textContent = item.file.name;
    button.append(thumb, label);
    button.addEventListener("click", () => setActiveItem(item.id));
    elements.queue.append(button);
  });
}

function renderSource() {
  const item = activeItem();
  elements.sourceEmpty.hidden = Boolean(item);
  elements.sourcePage.hidden = !item;
  if (!item) {
    elements.sourceImage.removeAttribute("src");
    renderSelection();
    return;
  }
  if (elements.sourceImage.getAttribute("src") !== item.previewUrl) {
    elements.sourceImage.src = item.previewUrl;
    elements.sourceImage.alt = item.file.name;
  }
  renderSelection();
}

function renderResult() {
  const item = activeItem();
  const result = item?.result || null;
  const ready = Boolean(result) && !state.processing;
  elements.resultEmpty.hidden = Boolean(result);
  elements.resultPage.hidden = !result;
  elements.download.disabled = !ready;
  elements.openTab.disabled = !ready;
  elements.compare.disabled = !ready;
  elements.adjust.disabled = !ready;

  if (!result) {
    elements.resultNote.textContent = "";
    elements.resultImage.removeAttribute("src");
    return;
  }

  // Show the encoded file itself, so "Save image as" and the Download button
  // hand over exactly the same bytes, format and dimensions.
  elements.resultImage.hidden = false;
  elements.resultPreview.hidden = true;
  elements.resultImage.src = item.resultUrl;
  elements.resultImage.alt = outputName(item);
  elements.resultNote.textContent = `${result.canvas.width}×${result.canvas.height} · ${Math.round(
    result.blob.size / 1024
  )} kB`;
}

function formatRatio(width, height) {
  const divisor = (a, b) => (b < 1 ? a : divisor(b, a % b));
  const factor = divisor(Math.round(width), Math.round(height)) || 1;
  const w = Math.round(width / factor);
  const h = Math.round(height / factor);
  return w <= 50 && h <= 50 ? `${w}:${h}` : (width / height).toFixed(2);
}

function updateSourceNote() {
  const item = activeItem();
  if (!item) {
    elements.sourceNote.textContent = "";
    elements.sourceNote.classList.remove("warning");
    return;
  }

  const crop = currentCrop(item);
  const parts = [
    `${item.source.width}×${item.source.height} · ${item.source.bitDepth}-bit · ${item.source.colorSpace.transfer.toUpperCase()} ${item.source.colorSpace.primaries.toUpperCase()}`,
    translate("CROP_SUMMARY", {
      width: Math.round(crop.width),
      height: Math.round(crop.height),
      ratio: formatRatio(crop.width, crop.height)
    })
  ];

  let warning = false;
  // Only flag colour-management problems for files that can actually carry HDR;
  // a plain PNG or JPEG has nothing to lose.
  const transfer = item.source.colorSpace.transfer;
  const couldBeHdr =
    transfer === "pq" || transfer === "hlg" || /avif|heic|heif/i.test(item.file.type || item.file.name);

  if (!item.source.accurate && couldBeHdr) {
    parts.push(translate("NO_HDR_DATA"));
    warning = true;
  } else if (couldBeHdr && !item.source.colorSpace.tagged) {
    parts.push(translate("UNTAGGED_SOURCE"));
    warning = true;
  }

  elements.sourceNote.textContent = parts.join(" — ");
  elements.sourceNote.classList.toggle("warning", warning);
}

function updateControls() {
  const item = activeItem();
  const busy = state.processing;
  const hasItems = state.items.length > 0;
  const converted = state.items.filter((entry) => entry.result);

  elements.convert.disabled = !hasItems || busy;
  elements.crop.disabled = !item || busy;
  elements.cropReset.disabled = !item || busy || !item.crop;
  elements.clear.disabled = !hasItems || busy;
  elements.file.disabled = busy;
  elements.addFiles.disabled = busy;
  elements.download.disabled = !item?.result || busy;
  elements.openTab.disabled = !item?.result || busy;
  elements.compare.disabled = !item?.result || busy;
  elements.adjust.disabled = !item?.result || busy;
  elements.downloadAll.hidden = converted.length < 2;
  elements.downloadAll.disabled = converted.length < 2 || busy;

  elements.crop.textContent = translate(state.cropMode ? "CROP_DISABLE" : "CROP_ENABLE");
  elements.crop.setAttribute("aria-pressed", String(state.cropMode));
}

function setActiveItem(id) {
  state.activeId = id;
  renderSource();
  renderResult();
  renderQueue();
  updateSourceNote();
  updateControls();
}

/* ------------------------------------------------------------------ loading */

async function loadFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.size > 0);
  if (!files.length) return;

  setBusy(true);
  setStatus("LOADING");
  setProgress(0);

  let loaded = 0;
  for (const file of files) {
    try {
      const source = await decodeFile(file);
      const item = {
        id: nextId++,
        file,
        source,
        previewUrl: URL.createObjectURL(file),
        crop: null,
        result: null,
        resultUrl: null
      };
      state.items.push(item);
      state.activeId = item.id;
      loaded += 1;
      setProgress(loaded / files.length);
    } catch (error) {
      setStatus("DECODE_ERROR", { message: error?.message || String(error) });
    }
  }

  setBusy(false);
  setActiveItem(state.activeId);

  if (loaded === 1 && state.items.length === 1) {
    const item = activeItem();
    setStatus("IMAGE_LOADED", {
      name: item.file.name,
      width: item.source.width,
      height: item.source.height,
      depth: item.source.bitDepth,
      transfer: item.source.colorSpace.transfer.toUpperCase()
    });
  } else if (loaded > 0) {
    setStatus("IMAGES_LOADED", { count: state.items.length });
  }
  setProgress(0);
}

function clearItems() {
  state.items.forEach((item) => {
    URL.revokeObjectURL(item.previewUrl);
    if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
  });
  state.items = [];
  state.activeId = null;
  state.cropMode = false;
  setActiveItem(null);
  setStatus("INITIAL_STATUS");
  setProgress(0);
}

/* --------------------------------------------------------------- conversion */

/**
 * Caches the linearised scene an item was last previewed from.
 *
 * Only the crop and the input interpretation change what `prepareScene`
 * produces, so the buffer survives every other settings change — which is
 * what makes the exposure slider live.
 */
function ensurePrepared(item, settings) {
  const key = `${JSON.stringify(item.crop)}|${settings.inputOverride}`;
  if (item.prepared?.key !== key) {
    item.prepared = { key, data: prepareScene(item.source, settings, item.crop) };
  }
  return item.prepared.data;
}

async function convertItem(item, settings, onProgress) {
  const converted = await convert(item.source, settings, item.crop, {
    onProgress,
    // Reuse the measurement the preview exposed from, so releasing the slider
    // can never shift the brightness the user just dialled in.
    scene: item.prepared?.key === `${JSON.stringify(item.crop)}|${settings.inputOverride}`
      ? item.prepared.data.scene
      : undefined
  });

  const { canvas, blob } = await encodeResult(converted, settings);
  if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);

  item.result = { canvas, blob, peak: converted.peak };
  item.resultUrl = URL.createObjectURL(blob);
}

async function convertAllItems() {
  if (!state.items.length) return;
  // The adjust panel tweaks the result you are looking at, so a new conversion
  // starts from the faithful, unedited one again.
  resetAdjust();
  const settings = readSettings();
  persistSettings();

  setBusy(true);
  setStatus("CONVERTING");
  setProgress(0);

  try {
    for (let index = 0; index < state.items.length; index++) {
      const item = state.items[index];
      await convertItem(item, settings, (ratio) =>
        setProgress((index + ratio) / state.items.length)
      );
      if (item.id === state.activeId) renderResult();
    }

    const item = activeItem();
    setStatus("CONVERTED", {
      width: item.result.canvas.width,
      height: item.result.canvas.height,
      nits: Math.round(item.result.peak * REFERENCE_WHITE)
    });
  } catch (error) {
    setStatus("CONVERT_ERROR", { message: error?.message || String(error) });
  } finally {
    setBusy(false);
    renderResult();
    renderQueue();
    setProgress(0);
    // Warm the live-exposure buffer now rather than on the first drag, so
    // scrubbing starts smoothly.
    const ready = activeItem();
    if (ready?.result) setTimeout(() => ensurePrepared(ready, settings), 0);
  }
}

/* -------------------------------------------------------- live adjustments */

let scrubFrame = 0;

/**
 * Redraws the preview from the cached scene, without re-encoding a file.
 *
 * Only the cheap tail of the pipeline re-runs — everything up to the transfer
 * function is cached by `prepareScene` — so dragging any of the adjust sliders
 * stays interactive even on a full-resolution image.
 */
/**
 * Mirrors a preview frame into the dialog, so the sliders can be judged
 * against the picture rather than by their numbers.
 *
 * `source` is whatever already holds the current pixels — the ImageData a
 * scrub just produced, or the result canvas when the dialog opens — so the
 * dialog never runs the pipeline itself and cannot disagree with the pane.
 */
function paintAdjustPreview(source) {
  const canvas = elements.adjustCanvas;
  if (!source) return;

  const width = source.width;
  const height = source.height;
  if (!width || !height) return;

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (source instanceof ImageData) context.putImageData(source, 0, 0);
  else context.drawImage(source, 0, 0);
}

function scrubAdjust() {
  updateSettingVisibility();

  const item = activeItem();
  if (!item?.result || state.processing) return;

  cancelAnimationFrame(scrubFrame);
  scrubFrame = requestAnimationFrame(() => {
    const settings = readSettings();
    const imageData = renderPreview(ensurePrepared(item, settings), settings);
    const canvas = elements.resultPreview;
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext("2d").putImageData(imageData, 0, 0);
    // Swap the encoded file out for the live canvas only while scrubbing.
    canvas.hidden = false;
    elements.resultImage.hidden = true;
    paintAdjustPreview(imageData);
  });
}

/** Re-encodes the active item so the preview is a real file again. */
/**
 * Re-encodes the active item so the preview is a real file again.
 *
 * Edits can arrive faster than a full-resolution encode takes — a
 * double-click reset lands two in a row, since the first press moves the
 * slider before the second one resets it. Dropping the later edit would leave
 * the file showing a value the controls no longer say, so an edit that
 * arrives mid-encode is remembered and re-run once the current one finishes.
 * Only the most recent is kept: the intermediate states are not worth
 * encoding.
 */
let commitQueued = false;

async function commitAdjust() {
  const item = activeItem();
  if (!item?.result) return;
  if (state.processing) {
    commitQueued = true;
    return;
  }

  const settings = readSettings();
  persistSettings();
  setBusy(true);
  setStatus("CONVERTING");
  try {
    await convertItem(item, settings, setProgress);
  } catch (error) {
    setStatus("CONVERT_ERROR", { message: error?.message || String(error) });
  } finally {
    setBusy(false);
    setProgress(0);
    renderResult();
    renderQueue();
    const result = item.result;
    if (result) {
      // Replace the scrub frame with the pixels that were actually encoded.
      paintAdjustPreview(result.canvas);
      setStatus("CONVERTED", {
        width: result.canvas.width,
        height: result.canvas.height,
        nits: Math.round(result.peak * REFERENCE_WHITE)
      });
    }
    if (commitQueued) {
      commitQueued = false;
      await commitAdjust();
    }
  }
}

/* ------------------------------------------------------------ modal dialogs */

/**
 * Opens a dialog modally and stops the page behind it from scrolling.
 *
 * A modal dialog makes the page inert but not still: a wheel or touch scroll
 * that starts on the backdrop, or runs past the end of the dialog, still moves
 * the document underneath. The lock is `overflow: hidden` on the root (see
 * `html.scroll-locked`), which keeps the scroll position where it was. Hiding
 * a classic scrollbar widens the page, so its width is held as padding to stop
 * everything shifting sideways; overlay scrollbars measure 0 and need none.
 */
function openModal(dialog) {
  const root = document.documentElement;
  if (!root.classList.contains("scroll-locked")) {
    const gap = Math.max(0, window.innerWidth - root.clientWidth);
    root.style.setProperty("--scrollbar-gap", `${gap}px`);
    root.classList.add("scroll-locked");
  }
  dialog.showModal();
}

/** Releases the lock once no dialog is left open, however the last one closed. */
function releaseScrollLock() {
  if (document.querySelector("dialog[open]")) return;
  const root = document.documentElement;
  root.classList.remove("scroll-locked");
  root.style.removeProperty("--scrollbar-gap");
}

/* --------------------------------------------------------------- comparison */

/**
 * Paints the before side of the comparison from the browser's own rendering
 * of the source file, in the same framing as the result, so the halves line up.
 *
 * That rendering is exactly what the user already sees everywhere else: the
 * HDR file squashed into SDR by the display pipeline, which is the thing the
 * conversion is meant to improve on.
 *
 * It is drawn straight into the canvas the dialog shows, and kept until the
 * result changes. It used to be encoded into a PNG data URL on every open —
 * 7 MB of text for a 2560×1440 image, with the page frozen for 300–800 ms
 * each time before the dialog could appear.
 */
let beforePaintedFor = null;

function paintBeforeImage(item) {
  // Keyed on the result's object URL, which is new for every conversion, so
  // this never holds on to a result that has since been replaced or cleared.
  if (beforePaintedFor === item.resultUrl) return;
  const crop = normalizeCrop(item.source, item.crop);
  const target = item.result.canvas;
  const canvas = elements.compareBefore;
  const image = elements.sourceImage;
  canvas.width = target.width;
  canvas.height = target.height;
  canvas.getContext("2d").drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
  // Only remembered when the source had actually loaded, so an early open is
  // redrawn next time rather than left blank.
  beforePaintedFor = image.complete && image.naturalWidth ? item.resultUrl : null;
}

/** The wipe position, 0–100. */
let wipePercent = 50;

/**
 * Moves the wipe. Writes a single number: the transforms that place the three
 * wipe layers are computed from it in CSS, and moving composited layers needs
 * no layout or paint, so this is cheap enough to run on every pointer event.
 */
function setWipe(percent) {
  wipePercent = Math.min(100, Math.max(0, percent));
  elements.compareViewport.style.setProperty("--wipe", String(wipePercent / 100));
  const rounded = String(Math.round(wipePercent));
  if (elements.compareDivider.getAttribute("aria-valuenow") !== rounded) {
    elements.compareDivider.setAttribute("aria-valuenow", rounded);
  }
}

function openCompare() {
  const item = activeItem();
  if (!item?.result) return;
  elements.compareAfter.src = item.resultUrl;
  elements.compareAfter.alt = translate("COMPARE_AFTER");
  paintBeforeImage(item);
  elements.compareBefore.setAttribute("aria-label", translate("COMPARE_BEFORE"));
  setWipe(50);
  openModal(elements.compareDialog);
}

/**
 * Drag state for the compare wipe.
 *
 * Moves are applied as they arrive rather than batched into an animation
 * frame: `setWipe` is too cheap to be worth deferring, and deferring can only
 * add latency. The viewport rectangle is read once per drag, because reading
 * it on every move would force a synchronous layout per event.
 */
let wipeDrag = null;

function wipeTo(clientX) {
  const { left, width } = wipeDrag.rect;
  setWipe(((clientX - left) / width) * 100);
}

function beginWipe(event) {
  if (event.button !== undefined && event.button !== 0) return;
  // A second finger during a pinch would otherwise yank the divider across.
  if (wipeDrag) return;
  event.preventDefault();
  // Plain focus() can scroll the dialog to bring the whole divider into view,
  // which jolts the picture just as the drag starts.
  elements.compareDivider.focus({ preventScroll: true });

  wipeDrag = { pointerId: event.pointerId, rect: elements.compareViewport.getBoundingClientRect() };
  // Capture keeps the drag alive when the finger leaves the viewport and
  // guarantees the matching pointerup even if it lands off-element. It throws
  // when the id is not an active pointer, and the window listeners below
  // already handle the movement, so a failure must not abort the drag.
  try {
    elements.compareViewport.setPointerCapture?.(event.pointerId);
  } catch {
    /* not capturable; the drag still works through the window listeners */
  }
  wipeTo(event.clientX);

  const move = (moveEvent) => {
    if (moveEvent.pointerId === wipeDrag?.pointerId) wipeTo(moveEvent.clientX);
  };
  const stop = (endEvent) => {
    if (!wipeDrag || (endEvent && endEvent.pointerId !== wipeDrag.pointerId)) return;
    try {
      elements.compareViewport.releasePointerCapture?.(wipeDrag.pointerId);
    } catch {
      /* already released, or never captured */
    }
    wipeDrag = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  };

  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerup", stop);
  // Without this the divider stays stuck to the finger if the browser decides
  // to take the gesture over.
  window.addEventListener("pointercancel", stop);
}

function nudgeWipe(event) {
  const step = event.shiftKey ? 10 : 2;
  if (event.key === "ArrowLeft") setWipe(wipePercent - step);
  else if (event.key === "ArrowRight") setWipe(wipePercent + step);
  else if (event.key === "Home") setWipe(0);
  else if (event.key === "End") setWipe(100);
  else return;
  event.preventDefault();
}

function outputName(item) {
  const extension = EXTENSIONS[item.result.blob.type] || "jpg";
  const baseName = item.file.name.replace(/\.[^.]+$/, "");
  return `${baseName}-sdr.${extension}`;
}

function downloadItem(item) {
  if (!item?.resultUrl) return;
  const link = document.createElement("a");
  link.href = item.resultUrl;
  link.download = outputName(item);
  link.click();
}

function openItemInTab(item) {
  if (!item?.resultUrl) return;
  window.open(item.resultUrl, "_blank", "noopener");
}

/* --------------------------------------------------------------------- crop */

function pointerToSource(event, item) {
  const rect = elements.sourceImage.getBoundingClientRect();
  const scale = overlayScale(item);
  return {
    x: Math.min(Math.max((event.clientX - rect.left) / scale, 0), item.source.width),
    y: Math.min(Math.max((event.clientY - rect.top) / scale, 0), item.source.height)
  };
}

function resizeFromAnchor(item, anchor, pointer, ratio) {
  const dirX = pointer.x >= anchor.x ? 1 : -1;
  const dirY = pointer.y >= anchor.y ? 1 : -1;
  const limitX = dirX > 0 ? item.source.width - anchor.x : anchor.x;
  const limitY = dirY > 0 ? item.source.height - anchor.y : anchor.y;

  let width = Math.min(Math.abs(pointer.x - anchor.x), limitX);
  let height = Math.min(Math.abs(pointer.y - anchor.y), limitY);

  if (ratio) {
    if (width / height > ratio) width = height * ratio;
    else height = width / ratio;
    const scale = Math.min(1, limitX / Math.max(width, 1e-6), limitY / Math.max(height, 1e-6));
    width *= scale;
    height *= scale;
  }

  width = Math.max(width, MIN_CROP_PX);
  height = Math.max(height, ratio ? MIN_CROP_PX / ratio : MIN_CROP_PX);
  if (ratio) height = width / ratio;

  return {
    x: dirX > 0 ? anchor.x : anchor.x - width,
    y: dirY > 0 ? anchor.y : anchor.y - height,
    width,
    height
  };
}

function setCrop(item, rect) {
  item.crop = normalizeCrop(item.source, rect);
  renderSelection();
  updateSourceNote();
  updateControls();
}

function beginDrag(event) {
  const item = activeItem();
  if (!item || !state.cropMode || event.button !== 0) return;

  const handle = event.target.closest?.(".crop-handle");
  const insideSelection = Boolean(event.target.closest?.(".crop-selection"));
  const start = pointerToSource(event, item);
  const startCrop = { ...currentCrop(item) };
  const ratio = aspectRatio(item);

  let mode = "create";
  let anchor = start;
  if (handle) {
    mode = "resize";
    const direction = handle.dataset.direction;
    anchor = {
      x: direction.includes("w") ? startCrop.x + startCrop.width : startCrop.x,
      y: direction.includes("n") ? startCrop.y + startCrop.height : startCrop.y
    };
  } else if (insideSelection) {
    mode = "move";
  }

  event.preventDefault();
  elements.overlay.setPointerCapture(event.pointerId);

  const onMove = (moveEvent) => {
    const pointer = pointerToSource(moveEvent, item);
    if (mode === "move") {
      const x = Math.min(Math.max(startCrop.x + pointer.x - start.x, 0), item.source.width - startCrop.width);
      const y = Math.min(Math.max(startCrop.y + pointer.y - start.y, 0), item.source.height - startCrop.height);
      setCrop(item, { ...startCrop, x, y });
      return;
    }
    setCrop(item, resizeFromAnchor(item, anchor, pointer, ratio));
  };

  const onUp = () => {
    elements.overlay.releasePointerCapture(event.pointerId);
    elements.overlay.removeEventListener("pointermove", onMove);
    elements.overlay.removeEventListener("pointerup", onUp);
    elements.overlay.removeEventListener("pointercancel", onUp);
  };

  elements.overlay.addEventListener("pointermove", onMove);
  elements.overlay.addEventListener("pointerup", onUp);
  elements.overlay.addEventListener("pointercancel", onUp);
}

function toggleCropMode() {
  const item = activeItem();
  if (!item) return;
  state.cropMode = !state.cropMode;
  if (state.cropMode) {
    if (!item.crop) item.crop = fitCropToRatio(item, fullCrop(item), aspectRatio(item));
    setStatus("CROP_INSTRUCTION");
  }
  renderSelection();
  updateSourceNote();
  updateControls();
}

function resetCrop() {
  const item = activeItem();
  if (!item) return;
  item.crop = state.cropMode ? fitCropToRatio(item, fullCrop(item), aspectRatio(item)) : null;
  renderSelection();
  updateSourceNote();
  updateControls();
  setStatus("CROP_RESET_DONE");
}

function applyAspectChange() {
  state.aspect = elements.aspect.value;
  persistSettings();
  const item = activeItem();
  if (!item) return;
  if (item.crop || state.cropMode) {
    item.crop = fitCropToRatio(item, currentCrop(item), aspectRatio(item));
    renderSelection();
    updateSourceNote();
  }
}

/* ------------------------------------------------------------------- events */

elements.language.addEventListener("change", () => applyLanguage(elements.language.value));
elements.theme.addEventListener("click", () => applyTheme(state.theme === "dark" ? "light" : "dark"));
elements.file.addEventListener("change", (event) => {
  clearItems();
  loadFiles(event.target.files);
  event.target.value = "";
});
elements.addFiles.addEventListener("change", (event) => {
  loadFiles(event.target.files);
  event.target.value = "";
});
elements.convert.addEventListener("click", convertAllItems);
elements.crop.addEventListener("click", toggleCropMode);
elements.cropReset.addEventListener("click", resetCrop);
elements.clear.addEventListener("click", clearItems);
elements.download.addEventListener("click", () => downloadItem(activeItem()));
elements.openTab.addEventListener("click", () => openItemInTab(activeItem()));
elements.downloadAll.addEventListener("click", () => {
  state.items.filter((item) => item.result).forEach((item, index) => {
    setTimeout(() => downloadItem(item), index * 250);
  });
});
elements.aspect.addEventListener("change", applyAspectChange);
elements.overlay.addEventListener("pointerdown", beginDrag);
elements.sourceImage.addEventListener("load", renderSelection);
window.addEventListener("resize", renderSelection);

for (const key of ["exposure", ...GRADE_KEYS]) {
  elements[key].addEventListener("input", scrubAdjust);
  elements[key].addEventListener("change", commitAdjust);
}

elements.adjust.addEventListener("click", () => {
  openModal(elements.adjustDialog);
  // Seed from the current result so the dialog is never blank before the
  // first drag; afterwards every scrub keeps it in step.
  paintAdjustPreview(activeItem()?.result?.canvas);
});
elements.adjustClose.addEventListener("click", () => elements.adjustDialog.close());
elements.adjustReset.addEventListener("click", () => {
  resetAdjust();
  scrubAdjust();
  commitAdjust();
});

/**
 * Double-click resets a slider, the way most editors behave.
 *
 * Range inputs never emit `dblclick` — the browser consumes those mouse
 * events to drag the thumb — so the second press is detected through the
 * click counter on `mousedown` instead. That press is also what would jump
 * the value to wherever the pointer is, so it has to be cancelled.
 *
 * The neutral position comes from `defaultValue`, i.e. the HTML `value`
 * attribute, so this needs no second list to keep in sync: adjustments return
 * to 0 and settings return to their own default. Assigning `.value` fires no
 * events, so both are dispatched by hand.
 */
document.addEventListener("mousedown", (event) => {
  if (event.detail !== 2 || event.button !== 0) return;
  const slider = event.target.closest?.('input[type="range"]');
  if (!slider || slider.disabled) return;

  event.preventDefault();
  if (slider.value === slider.defaultValue) return;
  slider.value = slider.defaultValue;
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.dispatchEvent(new Event("change", { bubbles: true }));
});

elements.compare.addEventListener("click", openCompare);
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("close", releaseScrollLock);
}
elements.compareClose.addEventListener("click", () => elements.compareDialog.close());
elements.compareViewport.addEventListener("pointerdown", beginWipe);
elements.compareDivider.addEventListener("keydown", nudgeWipe);

[
  elements.algorithm,
  elements.brightness,
  elements.peakMode,
  elements.peakNits,
  elements.desat,
  elements.format,
  elements.quality,
  elements.inputOverride,
  elements.param,
  elements.maxDimension
].forEach((control) => {
  control.addEventListener("input", () => {
    updateSettingVisibility();
    persistSettings();
  });
});

elements.resetSettings.addEventListener("click", () => {
  writeSettings(DEFAULT_SETTINGS);
  state.aspect = "original";
  elements.aspect.value = state.aspect;
  persistSettings();
  applyAspectChange();
});

["dragover", "drop"].forEach((type) => {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === "drop" && !state.processing) loadFiles(event.dataTransfer?.files);
  });
});

/* --------------------------------------------------------------------- boot */

decorateSettings();
applyTheme(getInitialTheme());
restoreSettings();
updateSettingVisibility();
applyLanguage(getInitialLanguage());
setStatus("INITIAL_STATUS");

if (!supportsWebCodecs()) {
  elements.sourceNote.textContent = translate("NO_HDR_DATA");
  elements.sourceNote.classList.add("warning");
}
