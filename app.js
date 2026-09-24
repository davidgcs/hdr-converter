import { createTranslator, translations } from "./src/i18n.js";
import { decodeFile, supportsWebCodecs } from "./src/decode.js";
import {
  DEFAULT_SETTINGS,
  canvasToBlob,
  encodeResult,
  normalizeCrop,
  renderPreview,
  toCanvas
} from "./src/pipeline.js";
import { REFERENCE_WHITE } from "./src/colorspace.js";
import { GRADE_DEFAULTS, GRADE_KEYS } from "./src/grade.js";
import { PRIORITY, createPool } from "./src/pool.js";
import { ZOOM_STEP, createZoom, zoomKey } from "./src/zoom.js";

const STORAGE_KEYS = {
  language: "hdr-converter-language",
  theme: "hdr-converter-theme",
  settings: "hdr-converter-settings"
};

const MIN_CROP_PX = 16;
const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const FORMAT_NAMES = { "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP" };
/** Thumbnails in the list are drawn at twice their 84 px CSS width. */
const THUMB_WIDTH = 168;
/**
 * Full-size working images are kept in memory for this many bytes in total
 * (about twenty 2560×1440 pictures). Beyond it the least recently viewed are
 * dropped and re-rendered from their source when needed again.
 */
const RENDER_BUDGET = 320e6;
const HISTORY_LIMIT = 100;

const pool = createPool();

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
  resultCanvas: document.querySelector("#result-canvas"),
  resultPreview: document.querySelector("#result-preview"),
  resultNote: document.querySelector("#result-note"),
  stageActions: document.querySelector("#stage-actions"),
  adjust: document.querySelector("#adjust"),
  adjustDialog: document.querySelector("#adjust-dialog"),
  adjustClose: document.querySelector("#adjust-close"),
  adjustReset: document.querySelector("#adjust-reset"),
  adjustCanvas: document.querySelector("#adjust-canvas"),
  adjustPreview: document.querySelector("#adjust-preview"),
  adjustPeekTag: document.querySelector("#adjust-peek-tag"),
  adjustZoom: document.querySelector("#adjust-zoom"),
  compareZoom: document.querySelector("#compare-zoom"),
  undo: document.querySelector("#undo"),
  redo: document.querySelector("#redo"),
  adjustUndo: document.querySelector("#adjust-undo"),
  adjustRedo: document.querySelector("#adjust-redo"),
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
  temperature: document.querySelector("#temperature"),
  tint: document.querySelector("#tint"),
  vibrance: document.querySelector("#vibrance"),
  noise: document.querySelector("#noise"),
  clarity: document.querySelector("#clarity"),
  sharpness: document.querySelector("#sharpness"),
  vignette: document.querySelector("#vignette"),
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
  /** The selection being drawn in crop mode; only becomes the image's crop on "Done". */
  cropDraft: null,
  statusBeforeCrop: null,
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
  temperature: "TIP_TEMPERATURE",
  tint: "TIP_TINT",
  vibrance: "TIP_VIBRANCE",
  noise: "TIP_NOISE",
  clarity: "TIP_CLARITY",
  sharpness: "TIP_SHARPNESS",
  vignette: "TIP_VIGNETTE",
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
  // The list's remove buttons are named after their files, so they are
  // re-labelled here rather than from a fixed key.
  syncQueue();
  labelHistoryButtons();
  updateZoomBar(elements.adjustZoom, editorZoom.state());
  updateZoomBar(elements.compareZoom, compareZoom.state());
  updateResultNote();
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

/*
 * Two kinds of settings live in the panel, and a third kind in the editor.
 *
 * The conversion settings — tone curve, brightness, peak, desaturation, how
 * to read the source — are shared by every image and take effect when you
 * press Convert. The export settings — format, quality, size limit — only
 * take effect when a file is written: the picture being edited stays
 * lossless and full size until then.
 *
 * The editor's adjustments are neither. They belong to one image
 * (item.edits), so the sliders always show the selected image's values, a new
 * image starts from the defaults, and each image keeps its own.
 */
const TONE_KEYS = ["algorithm", "param", "desat", "brightness", "peakMode", "peakNits", "inputOverride"];
const EDIT_KEYS = Object.freeze(["exposure", ...GRADE_KEYS]);
const EDIT_DEFAULTS = Object.freeze({ exposure: 0, ...GRADE_DEFAULTS });

function readSettings() {
  const param = elements.param.value.trim();
  return {
    algorithm: elements.algorithm.value,
    param: param === "" ? null : Number(param),
    desat: Number(elements.desat.value),
    brightness: elements.brightness.value,
    peakMode: elements.peakMode.value,
    peakNits: Number(elements.peakNits.value) || DEFAULT_SETTINGS.peakNits,
    inputOverride: elements.inputOverride.value,
    outputFormat: elements.format.value,
    quality: Number(elements.quality.value) / 100,
    maxDimension: Number(elements.maxDimension.value)
  };
}

function toneOf(settings) {
  return Object.fromEntries(TONE_KEYS.map((key) => [key, settings[key]]));
}

function exportSettings() {
  const { outputFormat, quality, maxDimension } = readSettings();
  return { outputFormat, quality, maxDimension };
}

function writeSettings(settings) {
  elements.algorithm.value = settings.algorithm;
  elements.param.value = settings.param === null || settings.param === undefined ? "" : settings.param;
  elements.desat.value = settings.desat;
  elements.brightness.value = settings.brightness;
  elements.peakMode.value = settings.peakMode;
  elements.peakNits.value = settings.peakNits;
  elements.inputOverride.value = settings.inputOverride;
  elements.format.value = settings.outputFormat;
  elements.quality.value = Math.round(settings.quality * 100);
  elements.maxDimension.value = String(settings.maxDimension);
  updateSettingVisibility();
}

/** The editor's sliders, as the selected image's edits. */
function readEdits() {
  return Object.fromEntries(EDIT_KEYS.map((key) => [key, Number(elements[key].value)]));
}

function writeEdits(edits) {
  for (const key of EDIT_KEYS) elements[key].value = String(edits[key] ?? EDIT_DEFAULTS[key]);
  updateSettingVisibility();
}

function isNeutralEdits(edits) {
  return EDIT_KEYS.every((key) => !Number(edits[key]));
}

/**
 * Bumped whenever a tone default changes. Settings saved by an older version
 * only keep the preferences that are still meaningful — the output format,
 * quality, size limit and crop ratio — because a stored tone curve or
 * brightness mode from back when it was the default is indistinguishable from
 * a deliberate choice, and restoring it would silently keep the old look.
 *
 * Edits are never saved: they belong to an image, and a new image has to
 * start from the defaults.
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
  elements.adjustReset.disabled = isNeutralEdits(readEdits());
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

/** What the source pane shows as the crop: the draft while cropping, else the applied crop. */
function currentCrop(item) {
  if (!item) return null;
  if (state.cropMode && state.cropDraft && item.id === state.activeId) return state.cropDraft;
  return item.crop || fullCrop(item);
}

function isFullCrop(item, rect) {
  return !rect || (rect.x <= 0.5 && rect.y <= 0.5 && rect.width >= item.source.width - 1 && rect.height >= item.source.height - 1);
}

function sameCrop(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

/**
 * The conversion an image was made with. Recorded when it is converted, so
 * editing it later keeps that conversion even if a shared setting has since
 * been changed without converting again.
 */
function toneSettings(item) {
  return item?.result?.settings || toneOf(readSettings());
}

/** Everything that shapes an image's working pixels: its conversion, its edits, full size. */
function renderSettings(item, edits = item.edits) {
  return { ...DEFAULT_SETTINGS, ...toneSettings(item), ...edits, outputFormat: "image/jpeg", maxDimension: 0 };
}

function renderKey(item, edits = item.edits) {
  return JSON.stringify([toneSettings(item), EDIT_KEYS.map((key) => Number(edits[key]) || 0), item.crop]);
}

/** Scene statistics and the live-preview buffer depend only on the crop and how the source is read. */
function sceneKey(item) {
  return `${JSON.stringify(item.crop)}|${toneSettings(item).inputOverride}`;
}

function sceneFor(item) {
  return item.scene?.key === sceneKey(item) ? item.scene.value : undefined;
}

function rememberScene(item, key, scene) {
  if (scene) item.scene = { key, value: scene };
}

/* ------------------------------------------------------------------ layout */

function overlayScale(item) {
  const rect = elements.sourceImage.getBoundingClientRect();
  if (!rect.width || !item) return 1;
  return rect.width / item.source.width;
}

/**
 * Crop mode shows the draft as a selection that can be dragged. Outside it,
 * an applied crop stays on screen too — the kept area clear, the rest dimmed
 * — so it is always visible what the result is made of.
 */
function renderSelection() {
  const item = activeItem();
  const editing = Boolean(item && state.cropMode);
  const applied = Boolean(item && !state.cropMode && item.crop);
  if (!editing && !applied) {
    selection?.root.remove();
    selection = null;
    elements.overlay.classList.remove("crop-mode");
    return;
  }

  elements.overlay.classList.toggle("crop-mode", editing);
  if (!selection) selection = createSelection();
  selection.root.classList.toggle("crop-applied", applied);

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

/** A trash can, drawn like the other icons: 24-unit grid, 2-unit strokes. */
const TRASH_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/>' +
  '<path d="m6 7 1 13h10l1-13"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';

const queueEntries = new Map();

function createQueueEntry(item) {
  const root = document.createElement("div");
  root.className = "queue-item";
  root.setAttribute("role", "listitem");

  const select = document.createElement("button");
  select.type = "button";
  select.className = "queue-select";
  const label = document.createElement("span");
  label.textContent = item.file.name;
  // The item's own thumbnail canvas: redrawn in place whenever its result
  // changes, never re-decoded.
  select.append(item.thumb, label);
  select.addEventListener("click", () => setActiveItem(item.id));

  // A sibling of the select button rather than a child: a button inside a
  // button is invalid HTML, and browsers then route its clicks and its
  // accessible name unpredictably.
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "queue-remove";
  remove.innerHTML = TRASH_ICON;
  remove.addEventListener("click", () => removeItem(item.id));

  root.append(select, remove);
  const entry = { root, select, remove };
  queueEntries.set(item.id, entry);
  return entry;
}

/**
 * Brings the list in line with state.items, updating entries in place.
 *
 * It used to be rebuilt on every click, and every thumbnail was an <img> of
 * the full-size file: with a dozen images, each click made the browser decode
 * about two seconds' worth of 2560×1440 AVIFs to draw 84 px thumbnails. Now
 * each image gets one small thumbnail canvas, and a click only moves the
 * "current" marker.
 */
function syncQueue() {
  for (const [id, entry] of queueEntries) {
    if (!state.items.some((item) => item.id === id)) {
      entry.root.remove();
      queueEntries.delete(id);
    }
  }
  const show = state.items.length >= 2;
  elements.queue.hidden = !show;
  if (!show) return;
  state.items.forEach((item, index) => {
    const entry = queueEntries.get(item.id) || createQueueEntry(item);
    const at = elements.queue.children[index];
    if (at !== entry.root) elements.queue.insertBefore(entry.root, at || null);
    entry.select.setAttribute("aria-current", String(item.id === state.activeId));
    entry.remove.disabled = state.processing;
    const name = translate("QUEUE_REMOVE", { name: item.file.name });
    if (entry.remove.title !== name) {
      entry.remove.title = name;
      entry.remove.setAttribute("aria-label", name);
    }
  });
}

/**
 * Resolves once the selected image's source is on screen, for anything that
 * draws from it (the compare view's "before").
 */
let sourceShown = Promise.resolve();
let sourceToken = 0;

/**
 * Shows the selected image's original in the source pane.
 *
 * The file is decoded before it is swapped in. Setting the new src directly
 * made the browser decode the full-size picture synchronously, holding up the
 * frame — about 250 ms of a frozen page per click for a 2560×1440 AVIF,
 * since the decoded-image cache only holds a few of them. Meanwhile the
 * previous picture stays, dimmed.
 */
function renderSource() {
  const item = activeItem();
  elements.sourceEmpty.hidden = Boolean(item);
  elements.sourcePage.hidden = !item;
  const token = ++sourceToken;
  if (!item) {
    elements.sourceImage.removeAttribute("src");
    elements.sourcePage.classList.remove("is-loading");
    sourceShown = Promise.resolve();
    renderSelection();
    return;
  }
  if (elements.sourceImage.getAttribute("src") === item.previewUrl) {
    elements.sourcePage.classList.remove("is-loading");
    renderSelection();
    return;
  }
  elements.sourcePage.classList.add("is-loading");
  const next = new Image();
  next.src = item.previewUrl;
  sourceShown = next
    .decode()
    .catch(() => {})
    .then(() => {
      if (token !== sourceToken) return;
      elements.sourceImage.src = item.previewUrl;
      elements.sourceImage.alt = item.file.name;
      elements.sourcePage.classList.remove("is-loading");
      renderSelection();
    });
  renderSelection();
}

/** Which render the result canvas currently holds, so it is only redrawn when that changes. */
let shownRender = null;

function renderResult() {
  const item = activeItem();
  const converted = Boolean(item?.result);
  const ready = converted && !state.processing;
  elements.resultEmpty.hidden = converted;
  elements.resultPage.hidden = !converted;
  elements.download.disabled = !ready;
  elements.openTab.disabled = !ready;
  elements.compare.disabled = !ready;
  elements.adjust.disabled = !ready;
  updateResultNote();
  if (!converted) {
    shownRender = null;
    return;
  }

  if (item.render) {
    showRender(item);
  } else if (shownRender?.item !== item) {
    // Its full-size picture was let go to save memory: show the thumbnail,
    // scaled up, until the re-render lands a moment later.
    const canvas = elements.resultCanvas;
    canvas.width = item.thumb.width;
    canvas.height = item.thumb.height;
    canvas.getContext("2d").drawImage(item.thumb, 0, 0);
    canvas.hidden = false;
    elements.resultPreview.hidden = true;
    shownRender = { item, placeholder: true };
  }
  if (item.render?.key !== renderKey(item)) requestRender(item).catch(reportError);
}

/**
 * Puts an image's working picture on the result canvas: the lossless,
 * full-size pixels, not a compressed file. Formats and quality only apply
 * when it is downloaded.
 */
function showRender(item) {
  const render = item.render;
  if (!render || item !== activeItem()) return;
  const canvas = elements.resultCanvas;
  if (shownRender?.render !== render) {
    canvas.width = render.width;
    canvas.height = render.height;
    canvas.getContext("2d").putImageData(render.imageData, 0, 0);
    shownRender = { item, render };
  }
  canvas.setAttribute("aria-label", outputName(item, exportSettings().outputFormat));
  // A live preview on top stays until the full render catches up with it.
  if (render.key === renderKey(item)) {
    canvas.hidden = false;
    elements.resultPreview.hidden = true;
    paintAdjustPreview(render.imageData);
  } else if (elements.resultPreview.hidden) {
    canvas.hidden = false;
  }
  updateResultNote();
}

function formatLabel(item) {
  const { outputFormat, quality, maxDimension } = exportSettings();
  const name = FORMAT_NAMES[outputFormat] || "JPEG";
  let label = outputFormat === "image/png" ? translate("FORMAT_PNG_16") : `${name} ${Math.round(quality * 100)}%`;
  const crop = normalizeCrop(item.source, item.crop);
  if (maxDimension && Math.max(crop.width, crop.height) > maxDimension) label += `, ${maxDimension} px`;
  return label;
}

function updateResultNote() {
  const item = activeItem();
  if (!item?.result) {
    elements.resultNote.textContent = "";
    return;
  }
  const crop = normalizeCrop(item.source, item.crop);
  elements.resultNote.textContent = translate("RESULT_NOTE", {
    width: crop.width,
    height: crop.height,
    format: formatLabel(item)
  });
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
  elements.cropReset.disabled = !item || busy || (!state.cropMode && !item.crop);
  elements.clear.disabled = !hasItems || busy;
  elements.file.disabled = busy;
  elements.addFiles.disabled = busy;
  elements.download.disabled = !item?.result || busy;
  elements.openTab.disabled = !item?.result || busy;
  elements.compare.disabled = !item?.result || busy;
  elements.adjust.disabled = !item?.result || busy;
  elements.downloadAll.hidden = converted.length < 2;
  elements.downloadAll.disabled = converted.length < 2 || busy;
  elements.queue.querySelectorAll(".queue-remove").forEach((button) => {
    button.disabled = busy;
  });

  elements.crop.textContent = translate(state.cropMode ? "CROP_DISABLE" : "CROP_ENABLE");
  elements.crop.setAttribute("aria-pressed", String(state.cropMode));
  updateHistoryButtons();
}

function setActiveItem(id) {
  const previous = activeItem();
  // Switching images while cropping keeps the selection, as "Done" would.
  if (previous && state.cropMode && previous.id !== id) applyCropDraft(previous, { quiet: true });
  if (previous) finishGesture(previous);

  state.activeId = id;
  const item = activeItem();
  if (item) touch(item);
  endPeek();
  trimCaches(item, previous);
  writeEdits(item ? item.edits : EDIT_DEFAULTS);

  renderSource();
  renderResult();
  updateRenderBusy();
  syncQueue();
  updateSourceNote();
  updateControls();
  // Have the live-preview buffer ready before the first slider moves.
  if (item?.result) requestPrepared(item, PRIORITY.background).catch(() => {});
}

/* ------------------------------------------------------------------ loading */

/**
 * A small thumbnail for the list, drawn once from the file and replaced by
 * the converted picture when there is one.
 */
function createThumb(file, source) {
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_WIDTH;
  canvas.height = Math.max(1, Math.round((THUMB_WIDTH * source.height) / source.width));
  createImageBitmap(file, { resizeWidth: canvas.width, resizeHeight: canvas.height, resizeQuality: "medium" })
    .then((bitmap) => {
      if (!canvas.dataset.converted) canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
    })
    .catch(() => {
      // The thumbnail is cosmetic; a format the browser cannot preview just stays blank.
    });
  return canvas;
}

async function refreshThumb(item, render) {
  const canvas = item.thumb;
  item.thumbFor = render;
  const height = Math.max(1, Math.round((THUMB_WIDTH * render.height) / render.width));
  try {
    const bitmap = await createImageBitmap(render.imageData, {
      resizeWidth: THUMB_WIDTH,
      resizeHeight: height,
      resizeQuality: "medium"
    });
    if (item.thumbFor === render) {
      canvas.width = THUMB_WIDTH;
      canvas.height = height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      canvas.dataset.converted = "true";
    }
    bitmap.close();
  } catch {
    // Cosmetic, as above.
  }
}

function createItem(file, source) {
  return {
    id: nextId++,
    file,
    source,
    previewUrl: URL.createObjectURL(file),
    thumb: createThumb(file, source),
    crop: null,
    // Every image starts from the defaults and keeps its own edits from then on.
    edits: { ...EDIT_DEFAULTS },
    history: { undo: [], redo: [] },
    gestureStart: null,
    result: null,
    render: null,
    pending: null,
    prepared: null,
    preparing: null,
    scene: null,
    unedited: null,
    uneditedPreview: null,
    exported: null,
    lastUsed: 0
  };
}

/** How many files decode at once. Decoding is asynchronous, so a few in flight keep the decoder busy. */
const DECODE_CONCURRENCY = 3;

async function loadFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.size > 0);
  if (!files.length) return;

  setBusy(true);
  setStatus("LOADING");
  setProgress(0);

  const decoded = new Array(files.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      try {
        decoded[index] = await decodeFile(files[index]);
      } catch (error) {
        decoded[index] = null;
        setStatus("DECODE_ERROR", { message: error?.message || String(error) });
      }
      setProgress(++done / files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DECODE_CONCURRENCY, files.length) }, worker));

  // Added in the order they were chosen, whatever order they finished in.
  let loaded = 0;
  files.forEach((file, index) => {
    if (!decoded[index]) return;
    const item = createItem(file, decoded[index]);
    state.items.push(item);
    state.activeId = item.id;
    loaded += 1;
  });

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

/** Lets go of everything an image holds: its jobs, its workers' copies, its object URLs. */
function releaseItem(item) {
  item.pending?.job.cancel();
  item.preparing?.job.cancel();
  if (peek.job?.item === item) cancelUneditedRender();
  pool.forget(item.id);
  URL.revokeObjectURL(item.previewUrl);
  if (item.exported) URL.revokeObjectURL(item.exported.url);
}

/**
 * Takes one image out of the list.
 *
 * Refused while a conversion runs: the conversion walks the list by index,
 * and removing an entry under it would skip or repeat an image. The buttons
 * are disabled then too (see updateControls).
 */
function removeItem(id) {
  if (state.processing) return;
  const index = state.items.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  const hadFocus = elements.queue.contains(document.activeElement);

  const [item] = state.items.splice(index, 1);
  if (item.id === state.activeId && state.cropMode) {
    state.cropMode = false;
    state.cropDraft = null;
  }
  releaseItem(item);

  if (!state.items.length) {
    clearItems();
    return;
  }
  if (state.activeId === id) {
    // The image that slid into its place, or the new last one.
    state.activeId = state.items[Math.min(index, state.items.length - 1)].id;
  }
  setActiveItem(state.activeId);
  setStatus("IMAGE_REMOVED", { name: item.file.name });

  // The focused button no longer exists. Hand focus to the one that took its
  // place, so a keyboard user can keep going instead of being dropped at the
  // top of the page; with one image left the list is gone, so Convert.
  if (hadFocus) {
    const buttons = elements.queue.querySelectorAll(".queue-remove");
    (buttons[Math.min(index, buttons.length - 1)] || elements.convert).focus();
  }
}

function clearItems() {
  state.items.forEach(releaseItem);
  state.items = [];
  state.activeId = null;
  state.cropMode = false;
  state.cropDraft = null;
  setActiveItem(null);
  setStatus("INITIAL_STATUS");
  setProgress(0);
}

/* --------------------------------------------------------------- conversion */

/** Reports a failed job, unless it failed only because it was superseded. */
function reportError(error) {
  if (error?.name === "AbortError") return;
  console.error(error);
  setStatus("CONVERT_ERROR", { message: error?.message || String(error) });
}

let useClock = 0;
function touch(item) {
  item.lastUsed = ++useClock;
}

/**
 * Renders an image's working picture — its conversion plus its edits, full
 * size, lossless — in a worker, and keeps it on the item.
 *
 * Only the latest request per image counts: asking for a different version
 * cancels the one in flight, so a quick run of edits never queues up renders
 * nobody will see, and a late result can never overwrite a newer one.
 */
/** Tells assistive technology (and anyone waiting) that the picture is still being rendered. */
function updateRenderBusy() {
  elements.resultPage.setAttribute("aria-busy", String(Boolean(activeItem()?.pending)));
}

function requestRender(item, { priority = PRIORITY.interactive, onProgress } = {}) {
  const key = renderKey(item);
  if (item.render?.key === key) {
    if (item.pending && item.pending.key !== key) {
      item.pending.job.cancel();
      item.pending = null;
      updateRenderBusy();
    }
    return Promise.resolve(item.render);
  }
  if (item.pending?.key === key) {
    item.pending.job.raise(priority);
    if (onProgress) item.pending.onProgress = onProgress;
    return item.pending.promise;
  }
  item.pending?.job.cancel();

  const pending = { key, onProgress };
  const forScene = sceneKey(item);
  pending.job = pool.run(
    "render",
    {
      sourceId: item.id,
      source: item.source,
      settings: renderSettings(item),
      crop: item.crop,
      scene: sceneFor(item),
      detail: true
    },
    { priority, onProgress: (value) => pending.onProgress?.(value) }
  );
  pending.promise = pending.job.promise.then((result) => {
    if (item.pending === pending) item.pending = null;
    updateRenderBusy();
    rememberScene(item, forScene, result.scene);
    const render = {
      key,
      width: result.width,
      height: result.height,
      peak: result.peak,
      imageData: new ImageData(result.data, result.width, result.height)
    };
    if (!state.items.includes(item)) return render;
    item.render = render;
    touch(item);
    refreshThumb(item, render);
    enforceBudget();
    if (item === activeItem()) showRender(item);
    return render;
  });
  // Callers that care attach their own handlers; this keeps a superseded,
  // unobserved render from being reported as an unhandled rejection.
  pending.promise.catch(() => {
    if (item.pending === pending) item.pending = null;
    updateRenderBusy();
  });
  item.pending = pending;
  updateRenderBusy();
  return pending.promise;
}

/** The reduced linear buffer the live preview draws from, built in a worker. */
function requestPrepared(item, priority = PRIORITY.interactive) {
  const key = sceneKey(item);
  if (item.prepared?.key === key) return Promise.resolve(item.prepared.data);
  if (item.preparing?.key === key) {
    item.preparing.job.raise(priority);
    return item.preparing.promise;
  }
  item.preparing?.job.cancel();

  const preparing = { key };
  preparing.job = pool.run(
    "prepare",
    { sourceId: item.id, source: item.source, settings: renderSettings(item), crop: item.crop },
    { priority }
  );
  preparing.promise = preparing.job.promise.then((data) => {
    if (item.preparing === preparing) item.preparing = null;
    rememberScene(item, key, data.scene);
    if (state.items.includes(item)) item.prepared = { key, data };
    return data;
  });
  preparing.promise.catch(() => {});
  item.preparing = preparing;
  return preparing.promise;
}

/**
 * Keeps memory bounded however many images are open. Full-size pictures are
 * dropped least-recently-viewed first once they pass RENDER_BUDGET (the
 * selected one never), and the caches only the editor needs are kept for the
 * selected image alone.
 */
function enforceBudget() {
  const active = activeItem();
  let total = 0;
  for (const item of state.items) if (item.render) total += item.render.imageData.data.length;
  if (total <= RENDER_BUDGET) return;
  const candidates = state.items
    .filter((item) => item.render && item !== active)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  for (const item of candidates) {
    if (total <= RENDER_BUDGET) break;
    total -= item.render.imageData.data.length;
    item.render = null;
  }
}

function trimCaches(active, previous) {
  for (const item of state.items) {
    if (item === active) continue;
    item.unedited = null;
    item.uneditedPreview = null;
    if (item !== previous) {
      item.preparing?.job.cancel();
      item.preparing = null;
      item.prepared = null;
    }
  }
}

/**
 * Converts every image with the shared settings, several at a time.
 *
 * Each image keeps its own edits and crop: converting again changes the
 * conversion underneath them, not the adjustments on top.
 */
async function convertAllItems() {
  if (!state.items.length) return;
  const current = activeItem();
  if (current && state.cropMode) applyCropDraft(current, { quiet: true });
  const settings = readSettings();
  persistSettings();
  const tone = toneOf(settings);

  setBusy(true);
  setStatus("CONVERTING");
  setProgress(0);

  const progress = new Map();
  const report = () => {
    let sum = 0;
    for (const value of progress.values()) sum += value;
    setProgress(sum / state.items.length);
  };
  // The image on screen first, so it is the first to appear.
  const order = current ? [current, ...state.items.filter((item) => item !== current)] : [...state.items];

  try {
    await Promise.all(
      order.map((item) => {
        item.result = { settings: tone };
        item.unedited = null;
        item.uneditedPreview = null;
        return requestRender(item, {
          priority: item === current ? PRIORITY.interactive : PRIORITY.batch,
          onProgress: (value) => {
            progress.set(item.id, value);
            report();
          }
        });
      })
    );
    const item = activeItem();
    if (item?.render) {
      setStatus("CONVERTED", {
        width: item.render.width,
        height: item.render.height,
        nits: Math.round(item.render.peak * REFERENCE_WHITE)
      });
    }
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
    setProgress(0);
    renderResult();
    syncQueue();
    const item = activeItem();
    // The workers each still hold a copy of the last image they converted;
    // only the selected one's is worth keeping for the edits to come.
    for (const other of state.items) if (other !== item) pool.forget(other.id);
    if (item?.result) requestPrepared(item, PRIORITY.background).catch(() => {});
  }
}

/* -------------------------------------------------------- live adjustments */

let scrubFrame = 0;

/**
 * Mirrors a preview frame into the dialog, so the sliders can be judged
 * against the picture rather than by their numbers.
 *
 * `source` is whatever already holds the current pixels — a live preview
 * frame, or the full-size render once it lands — so the dialog never runs
 * the pipeline itself and cannot disagree with the pane.
 *
 * While the unedited picture is being shown (see peekUnedited) the frame is
 * only remembered, and painted once the peek ends.
 */
function paintAdjustPreview(source) {
  if (!source) return;
  peek.edited = source;
  if (!peek.showing) paintAdjustCanvas(source);
}

function paintAdjustCanvas(source) {
  const canvas = elements.adjustCanvas;
  if (!source) return;

  const width = source.width;
  const height = source.height;
  if (!width || !height) return;

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    // A different resolution keeps the zoom; a different picture (another
    // crop) returns to fit. The zoom tells the two apart by the image size.
    editorZoom.relayout();
  }
  const context = canvas.getContext("2d");
  if (source instanceof ImageData) context.putImageData(source, 0, 0);
  else context.drawImage(source, 0, 0);
}

/**
 * Redraws the live preview for the selected image's current edits.
 *
 * Only the cheap tail of the pipeline runs here, on a reduced buffer that a
 * worker prepared (see requestPrepared); the exact full-size picture follows
 * from the worker when the slider is released.
 */
function schedulePreview(item) {
  if (!item?.result || state.processing) return;
  if (item.render?.key === renderKey(item)) {
    showRender(item);
    return;
  }
  if (item.prepared?.key !== sceneKey(item)) {
    requestPrepared(item)
      .then(() => {
        if (item === activeItem()) schedulePreview(item);
      })
      .catch(() => {});
    return;
  }
  cancelAnimationFrame(scrubFrame);
  scrubFrame = requestAnimationFrame(() => {
    if (item !== activeItem() || item.prepared?.key !== sceneKey(item)) return;
    if (item.render?.key === renderKey(item)) {
      showRender(item);
      return;
    }
    const imageData = renderPreview(item.prepared.data, renderSettings(item));
    const canvas = elements.resultPreview;
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext("2d").putImageData(imageData, 0, 0);
    canvas.hidden = false;
    elements.resultCanvas.hidden = true;
    paintAdjustPreview(imageData);
  });
}

/** A slider moved: the selected image's edits follow it, and the preview redraws. */
function onEditInput() {
  updateSettingVisibility();
  // Moving a slider means looking at the edit, so a peek at the unedited
  // picture ends here.
  endPeek();
  const item = activeItem();
  if (!item) return;
  beginGesture(item);
  item.edits = readEdits();
  updateHistoryButtons();
  schedulePreview(item);
}

/**
 * A slider was released: the change becomes one step of the image's history,
 * and its full-size picture is rendered again. Nothing is re-encoded — the
 * picture stays lossless until it is downloaded.
 */
/** The step the last slider release recorded, so a double-click can fold it into its reset. */
let lastSliderStep = null;

function onEditChange(event) {
  const item = activeItem();
  if (!item) return;
  item.edits = readEdits();
  const steps = item.history.undo.length;
  finishGesture(item);
  lastSliderStep = item.history.undo.length > steps && event?.target
    ? { item, id: event.target.id, at: performance.now(), step: item.history.undo.at(-1) }
    : null;
  if (item.result) requestRender(item).catch(reportError);
}

/**
 * The first click of a double-click has already moved the slider to where it
 * landed, and recorded that as a step. The reset that follows should be one
 * step from where the slider was before either click, so that one Undo
 * brings the old value back: take the first click's step back out, and start
 * the reset from the state before it.
 */
function foldIntoReset(slider) {
  const item = activeItem();
  const last = lastSliderStep;
  lastSliderStep = null;
  if (!item || !last || last.item !== item || last.id !== slider.id || performance.now() - last.at > 800) return;
  if (item.history.undo.at(-1) !== last.step) return;
  item.history.undo.pop();
  item.gestureStart = last.step;
}

/* ------------------------------------------------------------------ history */

/*
 * Undo and redo, per image.
 *
 * A step is everything the user can change about one image — its edits and
 * its crop — captured when a change starts and recorded when it ends: a
 * slider drag, a double-click reset, "Reset adjustments", applying or
 * resetting a crop. Dragging a slider is one step, not one per pixel moved.
 */
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.userAgentData?.platform || navigator.platform || "");
const SHORTCUTS = {
  undo: IS_MAC ? "⌘Z" : "Ctrl+Z",
  redo: IS_MAC ? "⇧⌘Z" : "Ctrl+Y"
};

function snapshot(item) {
  return { edits: { ...item.edits }, crop: item.crop ? { ...item.crop } : null };
}

function sameSnapshot(a, b) {
  return EDIT_KEYS.every((key) => Number(a.edits[key]) === Number(b.edits[key])) && sameCrop(a.crop, b.crop);
}

function recordStep(item, before) {
  item.history.undo.push(before);
  if (item.history.undo.length > HISTORY_LIMIT) item.history.undo.shift();
  item.history.redo = [];
  updateHistoryButtons();
}

function beginGesture(item) {
  if (!item.gestureStart) item.gestureStart = snapshot(item);
}

function finishGesture(item) {
  const before = item.gestureStart;
  item.gestureStart = null;
  if (before && !sameSnapshot(before, snapshot(item))) recordStep(item, before);
  updateHistoryButtons();
}

/** The crop the draft would become on "Done": null when it is the whole picture. */
function draftAsCommitted(item) {
  const draft = state.cropDraft;
  return !draft || isFullCrop(item, draft) ? null : normalizeCrop(item.source, draft);
}

function cropDraftChanged(item) {
  return Boolean(state.cropMode && item.id === state.activeId && !sameCrop(draftAsCommitted(item), item.crop));
}

function draftFor(item) {
  return item.crop ? { ...item.crop } : normalizeCrop(item.source, fitCropToRatio(item, fullCrop(item), aspectRatio(item)));
}

function applySnapshot(item, step) {
  item.edits = { ...EDIT_DEFAULTS, ...step.edits };
  item.crop = step.crop ? { ...step.crop } : null;
  item.gestureStart = null;
  if (item === activeItem()) {
    if (state.cropMode) state.cropDraft = draftFor(item);
    writeEdits(item.edits);
    endPeek();
    renderSelection();
    updateSourceNote();
    if (item.result) schedulePreview(item);
  }
  if (item.result) requestRender(item).catch(reportError);
  updateResultNote();
  updateControls();
}

function undo() {
  const item = activeItem();
  if (!item || state.processing) return false;
  // In crop mode an unapplied selection is the most recent change, so it goes first.
  if (cropDraftChanged(item)) {
    state.cropDraft = draftFor(item);
    renderSelection();
    updateSourceNote();
    updateHistoryButtons();
    return true;
  }
  const previous = item.history.undo.pop();
  if (!previous) return false;
  item.history.redo.push(snapshot(item));
  applySnapshot(item, previous);
  return true;
}

function redo() {
  const item = activeItem();
  if (!item || state.processing) return false;
  const next = item.history.redo.pop();
  if (!next) return false;
  item.history.undo.push(snapshot(item));
  applySnapshot(item, next);
  return true;
}

function updateHistoryButtons() {
  const item = activeItem();
  const busy = state.processing;
  const canUndo = Boolean(item && !busy && (item.history.undo.length || cropDraftChanged(item)));
  const canRedo = Boolean(item && !busy && item.history.redo.length);
  for (const button of [elements.undo, elements.adjustUndo]) button.disabled = !canUndo;
  for (const button of [elements.redo, elements.adjustRedo]) button.disabled = !canRedo;
}

function labelHistoryButtons() {
  for (const [button, action] of [
    [elements.undo, "undo"],
    [elements.adjustUndo, "undo"],
    [elements.redo, "redo"],
    [elements.adjustRedo, "redo"]
  ]) {
    const name = translate(action === "undo" ? "UNDO" : "REDO");
    button.setAttribute("aria-label", name);
    button.title = `${name} (${SHORTCUTS[action]})`;
    button.setAttribute("aria-keyshortcuts", action === "undo" ? "Control+Z Meta+Z" : "Control+Y Control+Shift+Z Meta+Shift+Z");
  }
}

/** Where typing belongs to the field itself, and Ctrl+Z must keep its native meaning. */
function isTextEntry(element) {
  if (!element) return false;
  if (element.isContentEditable || element.tagName === "TEXTAREA") return true;
  return element.tagName === "INPUT" && !["range", "button", "checkbox", "radio", "file", "submit", "reset"].includes(element.type);
}

function onHistoryShortcut(event) {
  if (event.altKey || !(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  const wantsUndo = key === "z" && !event.shiftKey;
  const wantsRedo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
  if (!wantsUndo && !wantsRedo) return;
  if (isTextEntry(event.target) || elements.compareDialog.open) return;
  // Only claim the keys when there is something to do: on a Mac, ⌘Y is the
  // browser's history window and should keep working otherwise.
  if (wantsUndo ? undo() : redo()) event.preventDefault();
}

/* ------------------------------------------------ before/after in the editor */

/** A press shorter than this is a click; longer is a hold. */
const HOLD_MS = 300;
/** How long a click shows the unedited picture for. */
const PEEK_MS = 1000;

const peek = {
  /** The unedited picture is on the canvas. */
  showing: false,
  /** Pending end of a click's peek. */
  timer: 0,
  /** When the current press began, or 0 when nothing is pressed. */
  pressAt: 0,
  pointerId: null,
  /** The press began while a click's peek was running, so it ends it. */
  toggles: false,
  /** The latest edited frame, painted back when a peek ends. */
  edited: null,
  /** The background render of the unedited picture. */
  job: null
};

/**
 * The image's own conversion — tone curve, brightness, crop — with every edit
 * taken away: what it looked like before the adjust panel was touched.
 */
function uneditedSettings(item) {
  return renderSettings(item, EDIT_DEFAULTS);
}

function uneditedKey(item) {
  return renderKey(item, EDIT_DEFAULTS);
}

/**
 * Renders the unedited picture at full size in a worker, once per
 * conversion and crop, and keeps it on the item.
 *
 * Full size matters: the result on screen is full size, and a reduced "before"
 * would look softer next to it, so the comparison would credit a Sharpness or
 * Clarity edit with detail that is really just resolution. It runs at the
 * lowest priority, so it never delays an edit.
 */
function renderUnedited(item) {
  if (!item?.result || state.processing) return;
  const key = uneditedKey(item);
  if (item.unedited?.key === key || peek.job?.key === key) return;
  // With no edits, the working picture already is the unedited one.
  if (item.render?.key === key) {
    item.unedited = { key, frame: item.render.imageData };
    return;
  }
  cancelUneditedRender();

  const job = pool.run(
    "render",
    { sourceId: item.id, source: item.source, settings: uneditedSettings(item), crop: item.crop, scene: sceneFor(item), detail: false },
    { priority: PRIORITY.background }
  );
  const entry = { key, item, job };
  peek.job = entry;
  job.promise
    .then((result) => {
      if (peek.job !== entry || !state.items.includes(item)) return;
      item.unedited = { key, frame: new ImageData(result.data, result.width, result.height) };
      // Swap the sharp version in if a peek is already showing the stand-in.
      if (peek.showing && activeItem() === item) paintAdjustCanvas(item.unedited.frame);
    })
    .catch((error) => {
      if (error?.name !== "AbortError") console.warn("Unedited render failed", error);
    })
    .finally(() => {
      if (peek.job === entry) peek.job = null;
    });
}

function cancelUneditedRender() {
  peek.job?.job.cancel();
  peek.job = null;
}

/**
 * The unedited picture to show now: the full-size render when it is ready,
 * otherwise a stand-in rendered from the preview buffer (tens of milliseconds)
 * while the full-size one is started. Null only if neither exists yet, in
 * which case whichever arrives first is shown.
 */
function uneditedFrame(item) {
  const key = uneditedKey(item);
  if (item.unedited?.key === key) return item.unedited.frame;
  if (item.render?.key === key) return item.render.imageData;
  renderUnedited(item);
  if (item.uneditedPreview?.key === key) return item.uneditedPreview.frame;
  if (item.prepared?.key === sceneKey(item)) {
    item.uneditedPreview = { key, frame: renderPreview(item.prepared.data, uneditedSettings(item)) };
    return item.uneditedPreview.frame;
  }
  requestPrepared(item)
    .then(() => {
      if (peek.showing && activeItem() === item && item.unedited?.key !== key) {
        const frame = uneditedFrame(item);
        if (frame) paintAdjustCanvas(frame);
      }
    })
    .catch(() => {});
  return null;
}

function showPeek() {
  const item = activeItem();
  if (!item?.result || peek.showing) return;
  peek.showing = true;
  const frame = uneditedFrame(item);
  if (frame) paintAdjustCanvas(frame);
  elements.adjustPeekTag.hidden = false;
  elements.adjustPreview.setAttribute("aria-pressed", "true");
}

/** Ends any peek and puts the edited picture back. */
function endPeek() {
  clearTimeout(peek.timer);
  peek.timer = 0;
  peek.pressAt = 0;
  if (!peek.showing) return;
  peek.showing = false;
  paintAdjustCanvas(peek.edited);
  elements.adjustPeekTag.hidden = true;
  elements.adjustPreview.setAttribute("aria-pressed", "false");
}

/**
 * Pressing the editor's picture shows it without the edits.
 *
 * A click shows it for PEEK_MS and then returns; holding keeps it until the
 * press is released. Clicking again while a click's peek is showing returns
 * straight away, so it can also be flicked back and forth. Both are the same
 * press seen from its two ends: it always shows on the way down, and the way
 * up decides whether it stays for a while or goes.
 */
/** `startedAt` is when the press began, which is earlier when a zoomed press waited to rule out a pan. */
function pressPeek(startedAt = performance.now()) {
  peek.toggles = peek.showing && peek.timer !== 0;
  clearTimeout(peek.timer);
  peek.timer = 0;
  peek.pressAt = startedAt;
  showPeek();
}

function releasePeek() {
  if (!peek.pressAt) return;
  const held = performance.now() - peek.pressAt;
  peek.pressAt = 0;
  if (held >= HOLD_MS || peek.toggles) endPeek();
  else if (peek.showing) peek.timer = setTimeout(endPeek, PEEK_MS);
}

/* --------------------------------------------------------------------- zoom */

/** A press that moves further than this is a drag; below it, it is still a click or a hold. */
function dragThreshold(event) {
  return event.pointerType === "mouse" ? 4 : 8;
}

/**
 * A press on the editor's picture might be the start of a pan (when zoomed
 * in) or of a pinch (a finger, which a second one may join), so the peek
 * waits this long for it to stay a plain press before it shows the unedited
 * picture. A mouse on a picture that is not zoomed can be neither, and shows
 * it at once.
 */
const PAN_WAIT_MS = 150;

const editorZoom = createZoom({
  viewport: elements.adjustPreview,
  target: elements.adjustCanvas,
  // The full-size working picture, whatever resolution the canvas holds at the moment.
  imageSize: () => {
    const item = activeItem();
    if (!item) return null;
    const crop = normalizeCrop(item.source, item.crop);
    return { width: crop.width, height: crop.height };
  },
  onChange: (zoomState) => updateZoomBar(elements.adjustZoom, zoomState)
});

let compareSize = null;
const compareZoom = createZoom({
  viewport: elements.compareViewport,
  target: elements.compareAfter,
  imageSize: () => compareSize,
  onChange: (zoomState) => updateZoomBar(elements.compareZoom, zoomState)
});

/**
 * Brings a zoom bar in line with its zoom. It runs on every pan and pinch
 * move, so it only writes what changed: rewriting the percentage text each
 * time, even with the same text, made the browser lay out the page on every
 * move of a pan.
 */
function updateZoomBar(bar, zoomState = { percent: 100, fit: true, canZoomIn: true, canZoomOut: false }) {
  if (!bar) return;
  const set = (element, property, value) => {
    if (element[property] !== value) element[property] = value;
  };
  const level = bar.querySelector('[data-zoom="toggle"]');
  const action = translate(zoomState.fit ? "ZOOM_ACTUAL" : "ZOOM_FIT");
  set(level, "textContent", translate("ZOOM_PERCENT", { n: zoomState.percent || 100 }));
  if (level.getAttribute("aria-label") !== action) level.setAttribute("aria-label", action);
  set(level, "title", `${action} (${zoomState.fit ? "1" : "0"})`);
  const zoomIn = bar.querySelector('[data-zoom="in"]');
  const zoomOut = bar.querySelector('[data-zoom="out"]');
  set(zoomIn, "disabled", !zoomState.canZoomIn);
  set(zoomOut, "disabled", !zoomState.canZoomOut);
  set(zoomIn, "title", `${translate("ZOOM_IN")} (+)`);
  set(zoomOut, "title", `${translate("ZOOM_OUT")} (−)`);
}

function wireZoomBar(bar, zoom) {
  bar.addEventListener("click", (event) => {
    const action = event.target.closest("[data-zoom]")?.dataset.zoom;
    if (action === "in") zoom.zoomBy(ZOOM_STEP);
    else if (action === "out") zoom.zoomBy(1 / ZOOM_STEP);
    else if (action === "toggle") zoom.toggle();
  });
}

/* Editor: a press shows the unedited picture, a drag pans, two fingers pinch. */

const editorPointers = new Map();
let editorGesture = null;

function firstTwo(pointers) {
  const [a, b] = pointers.values();
  return [a, b];
}

function startEditorPeek(gesture) {
  if (gesture.peeked) return;
  gesture.peeked = true;
  pressPeek(gesture.downAt);
}

function editorPointerDown(event) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  event.preventDefault();
  // Capture, so releasing off the picture still ends the hold or the pan.
  try {
    elements.adjustPreview.setPointerCapture(event.pointerId);
  } catch {
    /* not capturable; the window listeners still see it */
  }
  editorPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (editorPointers.size === 2) {
    // The first finger was the start of a pinch, not a press on the picture.
    if (editorGesture?.mode === "press") clearTimeout(editorGesture.peekTimer);
    endPeek();
    editorZoom.pinchStart(...firstTwo(editorPointers));
    editorGesture = { mode: "pinch" };
    return;
  }
  if (editorPointers.size > 2) return;

  const gesture = {
    mode: "press",
    id: event.pointerId,
    x0: event.clientX,
    y0: event.clientY,
    downAt: performance.now(),
    threshold: dragThreshold(event),
    peeked: false,
    peekTimer: 0
  };
  editorGesture = gesture;
  if (editorZoom.zoomed || event.pointerType !== "mouse") {
    gesture.peekTimer = setTimeout(() => {
      if (editorGesture === gesture && gesture.mode === "press") startEditorPeek(gesture);
    }, PAN_WAIT_MS);
  } else {
    startEditorPeek(gesture);
  }
}

function editorPointerMove(event) {
  const pointer = editorPointers.get(event.pointerId);
  if (!pointer) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  const gesture = editorGesture;
  if (!gesture) return;

  if (gesture.mode === "pinch") {
    if (editorPointers.size >= 2) editorZoom.pinchMove(...firstTwo(editorPointers));
    return;
  }
  if (gesture.id !== event.pointerId) return;
  if (gesture.mode === "press") {
    const moved = Math.hypot(event.clientX - gesture.x0, event.clientY - gesture.y0);
    if (moved <= gesture.threshold || !editorZoom.zoomed) return;
    // It is a pan after all: no peek, and the movement so far counts.
    clearTimeout(gesture.peekTimer);
    if (gesture.peeked) endPeek();
    gesture.mode = "pan";
    elements.adjustPreview.classList.add("is-panning");
    editorZoom.panBy(event.clientX - gesture.x0, event.clientY - gesture.y0);
    return;
  }
  if (gesture.mode === "pan") editorZoom.panBy(dx, dy);
}

function editorPointerUp(event) {
  if (!editorPointers.has(event.pointerId)) return;
  editorPointers.delete(event.pointerId);
  const cancelled = event.type === "pointercancel";
  const gesture = editorGesture;
  if (!gesture) return;

  if (gesture.mode === "pinch") {
    editorZoom.pinchEnd();
    if (editorPointers.size === 1) {
      // The finger left behind carries on panning, never peeking.
      const [id] = editorPointers.keys();
      editorGesture = { mode: editorZoom.zoomed ? "pan" : "idle", id };
      elements.adjustPreview.classList.toggle("is-panning", editorZoom.zoomed);
    } else if (!editorPointers.size) {
      editorGesture = null;
      elements.adjustPreview.classList.remove("is-panning");
    }
    return;
  }
  if (gesture.id !== event.pointerId) return;
  editorGesture = null;
  elements.adjustPreview.classList.remove("is-panning");
  if (gesture.mode !== "press") return;
  clearTimeout(gesture.peekTimer);
  if (cancelled) {
    endPeek();
    return;
  }
  // A quick tap while zoomed never reached the peek: it is a click, and shows it for a moment.
  if (!gesture.peeked) startEditorPeek(gesture);
  releasePeek();
}

function resetEditorGesture() {
  if (editorGesture?.mode === "press") clearTimeout(editorGesture.peekTimer);
  editorGesture = null;
  editorPointers.clear();
  editorZoom.pinchEnd();
  elements.adjustPreview.classList.remove("is-panning");
}

/* Comparison: the line compares, a zoomed picture pans, two fingers pinch. */

const comparePointers = new Map();
let compareGesture = null;

function wipeAt(rect, clientX) {
  setWipe(((clientX - rect.left) / rect.width) * 100);
}

/**
 * Not zoomed, it works as it always has: a press anywhere moves the line
 * there, and dragging carries it. Zoomed in, the line is dragged by the line
 * itself (its 44 px grab area), a drag anywhere else moves the pictures, and a
 * tap anywhere else still moves the line there. The viewport rectangle is
 * read once per gesture, since reading it on every move would force a
 * synchronous layout per event.
 */
function comparePointerDown(event) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  event.preventDefault();
  try {
    elements.compareViewport.setPointerCapture(event.pointerId);
  } catch {
    /* not capturable; the window listeners still see it */
  }
  comparePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (comparePointers.size === 2) {
    // The first finger was the start of a pinch: put the line back where it was.
    if (compareGesture?.mode === "wipe") setWipe(compareGesture.startWipe);
    compareZoom.pinchStart(...firstTwo(comparePointers));
    compareGesture = { mode: "pinch" };
    return;
  }
  if (comparePointers.size > 2) return;

  // Plain focus() can scroll the dialog to bring the whole divider into view,
  // which jolts the picture just as the drag starts.
  elements.compareDivider.focus({ preventScroll: true });
  const rect = elements.compareViewport.getBoundingClientRect();
  const onLine = Boolean(event.target.closest?.(".compare-divider"));
  if (compareZoom.zoomed && !onLine) {
    compareGesture = { mode: "press", id: event.pointerId, rect, x0: event.clientX, y0: event.clientY, threshold: dragThreshold(event) };
    return;
  }
  compareGesture = { mode: "wipe", id: event.pointerId, rect, startWipe: wipePercent };
  wipeAt(rect, event.clientX);
}

function comparePointerMove(event) {
  const pointer = comparePointers.get(event.pointerId);
  if (!pointer) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  const gesture = compareGesture;
  if (!gesture) return;

  if (gesture.mode === "pinch") {
    if (comparePointers.size >= 2) compareZoom.pinchMove(...firstTwo(comparePointers));
    return;
  }
  if (gesture.id !== event.pointerId) return;
  if (gesture.mode === "wipe") {
    wipeAt(gesture.rect, event.clientX);
    return;
  }
  if (gesture.mode === "press") {
    if (Math.hypot(event.clientX - gesture.x0, event.clientY - gesture.y0) <= gesture.threshold) return;
    gesture.mode = "pan";
    elements.compareViewport.classList.add("is-panning");
    compareZoom.panBy(event.clientX - gesture.x0, event.clientY - gesture.y0);
    return;
  }
  if (gesture.mode === "pan") compareZoom.panBy(dx, dy);
}

function comparePointerUp(event) {
  if (!comparePointers.has(event.pointerId)) return;
  comparePointers.delete(event.pointerId);
  const gesture = compareGesture;
  if (!gesture) return;

  if (gesture.mode === "pinch") {
    compareZoom.pinchEnd();
    if (comparePointers.size === 1) {
      const [id] = comparePointers.keys();
      compareGesture = { mode: compareZoom.zoomed ? "pan" : "idle", id };
      elements.compareViewport.classList.toggle("is-panning", compareZoom.zoomed);
    } else if (!comparePointers.size) {
      compareGesture = null;
      elements.compareViewport.classList.remove("is-panning");
    }
    return;
  }
  if (gesture.id !== event.pointerId) return;
  compareGesture = null;
  elements.compareViewport.classList.remove("is-panning");
  // A tap on a zoomed picture still moves the line there.
  if (gesture.mode === "press" && event.type !== "pointercancel") wipeAt(gesture.rect, event.clientX);
}

function resetCompareGesture() {
  compareGesture = null;
  comparePointers.clear();
  compareZoom.pinchEnd();
  elements.compareViewport.classList.remove("is-panning");
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

function paintBeforeImage(item, render) {
  // Keyed on the image, its crop and the size it is drawn at, so it is only
  // redrawn when one of those changes.
  const key = `${item.id}|${JSON.stringify(item.crop)}|${render.width}x${render.height}`;
  if (beforePaintedFor === key) return;
  const crop = normalizeCrop(item.source, item.crop);
  const canvas = elements.compareBefore;
  const image = elements.sourceImage;
  canvas.width = render.width;
  canvas.height = render.height;
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
  beforePaintedFor = image.complete && image.naturalWidth ? key : null;
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

async function openCompare() {
  const item = activeItem();
  if (!item?.result) return;
  let render;
  try {
    render = await requestRender(item);
  } catch (error) {
    reportError(error);
    return;
  }
  // The "before" is drawn from the source pane, so it has to be this image's.
  await sourceShown;
  if (item !== activeItem()) return;
  const after = elements.compareAfter;
  after.width = render.width;
  after.height = render.height;
  after.getContext("2d").putImageData(render.imageData, 0, 0);
  after.setAttribute("aria-label", translate("COMPARE_AFTER"));
  paintBeforeImage(item, render);
  elements.compareBefore.setAttribute("aria-label", translate("COMPARE_BEFORE"));
  setWipe(50);
  compareSize = { width: render.width, height: render.height };
  resetCompareGesture();
  openModal(elements.compareDialog);
  // Every comparison starts fit to the window.
  compareZoom.reset();
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

function outputName(item, format = exportSettings().outputFormat) {
  const extension = EXTENSIONS[format] || "jpg";
  const baseName = item.file.name.replace(/\.[^.]+$/, "");
  return `${baseName}-sdr.${extension}`;
}

/**
 * Writes an image's file, with the format, quality and size limit chosen
 * now. This is the only place anything is compressed: until here the picture
 * is kept lossless.
 *
 *  - JPEG or WebP at full size encode straight from the working picture,
 *    which already has every edit applied at that size.
 *  - With a size limit, the picture is rendered again and shrunk first, so
 *    clarity, sharpness and noise reduction are applied at the saved size.
 *  - PNG is rendered at 16 bits per channel and written in a worker.
 *
 * The last file is kept until something about it changes, so pressing
 * Download twice, or opening it in a tab after downloading, costs nothing.
 */
async function exportItem(item) {
  const output = exportSettings();
  const key = `${renderKey(item)}|${JSON.stringify(output)}`;
  if (item.exported?.key === key) return item.exported;

  const settings = { ...renderSettings(item), ...output };
  const crop = normalizeCrop(item.source, item.crop);
  const shrinks = output.maxDimension && Math.max(crop.width, crop.height) > output.maxDimension;
  const job = { sourceId: item.id, source: item.source, settings, crop: item.crop, scene: sceneFor(item) };
  let blob;
  if (output.outputFormat === "image/png") {
    ({ blob } = await pool.run("png", job, { priority: PRIORITY.export }).promise);
  } else if (!shrinks) {
    const render = await requestRender(item, { priority: PRIORITY.export });
    blob = await canvasToBlob(toCanvas(render.imageData, 0), output.outputFormat, output.quality);
  } else {
    const result = await pool.run("render", { ...job, detail: false }, { priority: PRIORITY.export }).promise;
    ({ blob } = await encodeResult({ imageData: new ImageData(result.data, result.width, result.height), pixels16: null }, settings));
  }

  if (item.exported) URL.revokeObjectURL(item.exported.url);
  item.exported = { key, blob, url: URL.createObjectURL(blob), name: outputName(item, output.outputFormat) };
  return item.exported;
}

function saveFile(exported) {
  const link = document.createElement("a");
  link.href = exported.url;
  link.download = exported.name;
  link.click();
}

async function downloadItem(item) {
  if (!item?.result) return;
  const status = { ...state.status };
  setStatus("EXPORTING", { name: outputName(item) });
  try {
    saveFile(await exportItem(item));
    setStatus(status.key, status.params);
  } catch (error) {
    setStatus("EXPORT_ERROR", { message: error?.message || String(error) });
  }
}

function openItemInTab(item) {
  if (!item?.result) return;
  // Opened now, while the click still counts as the user's: a tab opened
  // after waiting for the file would be stopped by the pop-up blocker.
  const tab = window.open("", "_blank");
  exportItem(item)
    .then((exported) => {
      if (tab) {
        tab.opener = null;
        tab.location.href = exported.url;
      } else {
        window.open(exported.url, "_blank", "noopener");
      }
    })
    .catch((error) => {
      tab?.close();
      setStatus("EXPORT_ERROR", { message: error?.message || String(error) });
    });
}

/**
 * Downloads every converted image. The files are prepared in parallel, and
 * handed to the browser a moment apart so it treats them as separate
 * downloads. Files of images not on screen are released afterwards.
 */
async function downloadAll() {
  const items = state.items.filter((item) => item.result);
  if (!items.length) return;
  const status = { ...state.status };
  setStatus("EXPORTING", { name: `${items.length} ×` });
  try {
    const files = await Promise.all(items.map(exportItem));
    files.forEach((exported, index) => setTimeout(() => saveFile(exported), index * 250));
    setTimeout(() => {
      for (const item of items) {
        if (item === activeItem() || !item.exported) continue;
        URL.revokeObjectURL(item.exported.url);
        item.exported = null;
      }
    }, files.length * 250 + 60000);
    setStatus(status.key, status.params);
  } catch (error) {
    setStatus("EXPORT_ERROR", { message: error?.message || String(error) });
  }
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
  state.cropDraft = normalizeCrop(item.source, rect);
  renderSelection();
  updateSourceNote();
  updateHistoryButtons();
}

function beginDrag(event) {
  const item = activeItem();
  if (!item || !state.cropMode || event.button !== 0) return;
  // Until this image's picture is on screen there is nothing to map the
  // pointer onto (see renderSource).
  if (elements.sourceImage.getAttribute("src") !== item.previewUrl || !elements.sourceImage.naturalWidth) return;

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
  } else if (insideSelection && !isFullCrop(item, startCrop)) {
    // Dragging inside a smaller selection moves it. A selection that covers
    // the whole picture — which is how crop mode starts — has nowhere to
    // move, and every point is "inside" it, so there a drag draws a new one.
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
  if (state.cropMode) {
    applyCropDraft(item);
    return;
  }
  state.cropMode = true;
  state.cropDraft = draftFor(item);
  state.statusBeforeCrop = { ...state.status };
  setStatus("CROP_INSTRUCTION");
  renderSelection();
  updateSourceNote();
  updateControls();
}

/**
 * "Done": the selection becomes the image's crop, straight away. The result
 * is rendered again with it — there is no need to convert again — and the
 * source keeps showing the kept area. One step of the image's history.
 */
function applyCropDraft(item, { quiet = false } = {}) {
  const next = draftAsCommitted(item);
  state.cropMode = false;
  state.cropDraft = null;
  const changed = !sameCrop(next, item.crop);
  if (changed) {
    recordStep(item, snapshot(item));
    item.crop = next;
    if (item.result) requestRender(item).catch(reportError);
  }
  if (!quiet) {
    if (next) setStatus("CROP_APPLIED", { width: next.width, height: next.height });
    else if (changed) setStatus("CROP_RESET_DONE");
    else if (state.statusBeforeCrop) setStatus(state.statusBeforeCrop.key, state.statusBeforeCrop.params);
  }
  state.statusBeforeCrop = null;
  if (item === activeItem()) {
    renderSelection();
    updateSourceNote();
    renderResult();
    updateControls();
  }
}

function resetCrop() {
  const item = activeItem();
  if (!item) return;
  if (state.cropMode) {
    state.cropDraft = normalizeCrop(item.source, fitCropToRatio(item, fullCrop(item), aspectRatio(item)));
    renderSelection();
    updateSourceNote();
    updateHistoryButtons();
    setStatus("CROP_RESET_DONE");
    return;
  }
  if (!item.crop) return;
  recordStep(item, snapshot(item));
  item.crop = null;
  if (item.result) requestRender(item).catch(reportError);
  renderSelection();
  updateSourceNote();
  renderResult();
  updateControls();
  setStatus("CROP_RESET_DONE");
}

function applyAspectChange() {
  state.aspect = elements.aspect.value;
  persistSettings();
  const item = activeItem();
  if (!item) return;
  if (state.cropMode) {
    state.cropDraft = normalizeCrop(item.source, fitCropToRatio(item, currentCrop(item), aspectRatio(item)));
    renderSelection();
    updateSourceNote();
    updateHistoryButtons();
    return;
  }
  if (!item.crop) return;
  const fitted = normalizeCrop(item.source, fitCropToRatio(item, item.crop, aspectRatio(item)));
  const next = isFullCrop(item, fitted) ? null : fitted;
  if (sameCrop(next, item.crop)) return;
  recordStep(item, snapshot(item));
  item.crop = next;
  if (item.result) requestRender(item).catch(reportError);
  renderSelection();
  updateSourceNote();
  renderResult();
  updateControls();
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
elements.downloadAll.addEventListener("click", downloadAll);
elements.aspect.addEventListener("change", applyAspectChange);
elements.overlay.addEventListener("pointerdown", beginDrag);
elements.sourceImage.addEventListener("load", renderSelection);
window.addEventListener("resize", renderSelection);

for (const key of EDIT_KEYS) {
  elements[key].addEventListener("input", onEditInput);
  elements[key].addEventListener("change", onEditChange);
}

for (const button of [elements.undo, elements.adjustUndo]) button.addEventListener("click", undo);
for (const button of [elements.redo, elements.adjustRedo]) button.addEventListener("click", redo);
document.addEventListener("keydown", onHistoryShortcut);

elements.adjust.addEventListener("click", () => {
  const item = activeItem();
  if (!item?.result) return;
  resetEditorGesture();
  openModal(elements.adjustDialog);
  // Every visit to the editor starts fit to the window.
  editorZoom.reset();
  // Seed from the current picture so the dialog is never blank before the
  // first drag; afterwards every scrub keeps it in step.
  if (item.render) paintAdjustPreview(item.render.imageData);
  requestPrepared(item).catch(() => {});
  // Have the unedited picture ready for the first press, once the dialog has
  // had a moment to appear.
  setTimeout(() => {
    if (elements.adjustDialog.open) renderUnedited(activeItem());
  }, 400);
});
elements.adjustClose.addEventListener("click", () => elements.adjustDialog.close());
elements.adjustDialog.addEventListener("close", () => {
  resetEditorGesture();
  endPeek();
  cancelUneditedRender();
});
elements.compareDialog.addEventListener("close", resetCompareGesture);

elements.adjustPreview.addEventListener("pointerdown", editorPointerDown);
elements.adjustPreview.addEventListener("wheel", (event) => editorZoom.wheel(event), { passive: false });
elements.compareViewport.addEventListener("pointerdown", comparePointerDown);
elements.compareViewport.addEventListener("wheel", (event) => compareZoom.wheel(event), { passive: false });
// On the window, so a gesture keeps going wherever the pointer goes; each
// handler ignores pointers that are not part of its own gesture.
window.addEventListener("pointermove", (event) => {
  editorPointerMove(event);
  comparePointerMove(event);
}, { passive: true });
for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, (event) => {
    editorPointerUp(event);
    comparePointerUp(event);
  });
}
wireZoomBar(elements.adjustZoom, editorZoom);
wireZoomBar(elements.compareZoom, compareZoom);
elements.adjustDialog.addEventListener("keydown", (event) => {
  if (isTextEntry(event.target)) return;
  if (zoomKey(editorZoom, event, { pan: event.target === elements.adjustPreview, viewport: elements.adjustPreview })) event.preventDefault();
});
elements.compareDialog.addEventListener("keydown", (event) => {
  // The divider keeps its arrow keys for the line.
  if (zoomKey(compareZoom, event)) event.preventDefault();
});
// A long press would otherwise open the browser's image menu on touch screens.
elements.adjustPreview.addEventListener("contextmenu", (event) => event.preventDefault());
elements.adjustPreview.addEventListener("keydown", (event) => {
  if (event.key !== " " && event.key !== "Enter") return;
  event.preventDefault();
  if (!event.repeat) pressPeek();
});
elements.adjustPreview.addEventListener("keyup", (event) => {
  if (event.key !== " " && event.key !== "Enter") return;
  event.preventDefault();
  releasePeek();
});
elements.adjustPreview.addEventListener("blur", () => {
  if (peek.pressAt) endPeek();
});
elements.adjustReset.addEventListener("click", () => {
  const item = activeItem();
  if (!item) return;
  beginGesture(item);
  item.edits = { ...EDIT_DEFAULTS };
  writeEdits(item.edits);
  schedulePreview(item);
  onEditChange();
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
  if (EDIT_KEYS.includes(slider.id)) foldIntoReset(slider);
  if (slider.value === slider.defaultValue) {
    // Already at the default, but the first click may have moved it there and
    // back; settle the history either way.
    if (EDIT_KEYS.includes(slider.id)) slider.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  slider.value = slider.defaultValue;
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.dispatchEvent(new Event("change", { bubbles: true }));
});

elements.compare.addEventListener("click", openCompare);
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("close", releaseScrollLock);
}
elements.compareClose.addEventListener("click", () => elements.compareDialog.close());
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
    // Format, quality and size limit are applied at download; say which.
    updateResultNote();
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
