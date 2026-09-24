/**
 * Zoom and pan for a picture shown inside a viewport.
 *
 * The picture element keeps its normal layout — "fit" is simply how it is laid
 * out — and zooming only sets three custom properties on the viewport, which
 * the stylesheet turns into a transform:
 *
 *   transform: translate3d(var(--pan-x), var(--pan-y), 0) scale(var(--zoom));
 *
 * so zooming and panning never lay anything out or repaint the picture: the
 * compositor scales a texture it already has. Anything else that uses the
 * same properties in the same order moves exactly with it, which is how the
 * two halves of the comparison stay aligned pixel for pixel.
 *
 * The state is kept in image terms — CSS pixels per image pixel, and which
 * image point is at the centre of the viewport — rather than as a scale of
 * the element, so it survives the element changing size (a window resize, or
 * the live preview swapping a half-size frame for the full-size picture).
 */

/** The deepest zoom, as a percentage of actual size (one image pixel per device pixel). */
const MAX_PERCENT = 800;
/** Zoom-in/out buttons and keys step by this factor; two steps double the size. */
export const ZOOM_STEP = Math.SQRT2;

function pixelRatio() {
  return window.devicePixelRatio || 1;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.viewport element that clips the picture; carries the custom properties
 * @param {HTMLElement} options.target the picture element whose layout box is "fit"
 * @param {() => ({width: number, height: number} | null)} options.imageSize full-size picture, in image pixels
 * @param {(state: object) => void} [options.onChange]
 */
export function createZoom({ viewport, target, imageSize, onChange }) {
  let fit = true;
  /** CSS pixels per image pixel, when not fit. */
  let z = 1;
  /** The image point at the centre of the viewport, when not fit. */
  let cx = 0;
  let cy = 0;
  let geometry = null;
  let lastSize = "";
  let pinch = null;
  /** The transform last written, so the untransformed box can be recovered exactly. */
  let applied = { s: 1, tx: 0, ty: 0 };

  /**
   * Reads the layout: the viewport, and the picture's "fit" box.
   *
   * offsetWidth and friends are rounded to whole pixels, which put 100% out
   * by a pixel or two. The transformed rectangle is exact, and since the
   * transform is a translation plus a uniform scale about the box centre,
   * undoing the last one written gives the box: width = rect.width / s,
   * centre = rect centre − translation.
   */
  function measure() {
    const size = imageSize();
    const key = size ? `${size.width}x${size.height}` : "";
    // A different picture — another crop, say — starts again from fit.
    if (key !== lastSize) {
      lastSize = key;
      fit = true;
    }
    const box = target.getBoundingClientRect();
    if (!size?.width || !size?.height || !box.width || !box.height) {
      geometry = null;
      return null;
    }
    const bw = box.width / applied.s;
    const bh = box.height / applied.s;
    const view = viewport.getBoundingClientRect();
    const vw = view.width - 2 * viewport.clientLeft;
    const vh = view.height - 2 * viewport.clientTop;
    // With object-fit: contain the picture can be letterboxed inside its box.
    const contentWidth = Math.min(bw, bh * (size.width / size.height));
    geometry = {
      iw: size.width,
      ih: size.height,
      vw,
      vh,
      vx: view.left + viewport.clientLeft + vw / 2,
      vy: view.top + viewport.clientTop + vh / 2,
      bx: box.left + box.width / 2 - applied.tx,
      by: box.top + box.height / 2 - applied.ty,
      fitZ: contentWidth / size.width
    };
    return geometry;
  }

  function limits(g) {
    const min = g.fitZ;
    return { min, max: Math.max(min * 4, MAX_PERCENT / 100 / pixelRatio()) };
  }

  /** Where fit puts the image centre, and what image point sits at the viewport centre then. */
  function fitCentre(g) {
    return { x: g.iw / 2 + (g.vx - g.bx) / g.fitZ, y: g.ih / 2 + (g.vy - g.by) / g.fitZ };
  }

  /**
   * Keeps the picture covering the viewport along any axis where it is larger
   * than the viewport, and centred along any axis where it is not, so it can
   * never be dragged off into empty space.
   */
  function clampCentre(g) {
    if (g.iw * z <= g.vw) cx = g.iw / 2 + (g.vx - g.bx) / z;
    else cx = Math.min(Math.max(cx, g.vw / 2 / z), g.iw - g.vw / 2 / z);
    if (g.ih * z <= g.vh) cy = g.ih / 2 + (g.vy - g.by) / z;
    else cy = Math.min(Math.max(cy, g.vh / 2 / z), g.ih - g.vh / 2 / z);
  }

  function state() {
    const g = geometry;
    const current = fit || !g ? g?.fitZ ?? 0 : z;
    const max = g ? limits(g).max : 0;
    return {
      fit,
      zoomed: !fit,
      percent: Math.round(current * pixelRatio() * 100),
      canZoomIn: Boolean(g) && current < max * 0.999,
      canZoomOut: !fit
    };
  }

  /*
   * With the transform origin at the box centre B, an image point p lands at
   *   B + t + s·fitZ·(p − imageCentre) = B + t + z·(p − imageCentre).
   * Wanting the image point c at the viewport centre V gives t = V − B − z·(c − imageCentre).
   */
  function render() {
    let s = 1;
    let tx = 0;
    let ty = 0;
    if (!fit && geometry) {
      const g = geometry;
      s = z / g.fitZ;
      tx = g.vx - g.bx - z * (cx - g.iw / 2);
      ty = g.vy - g.by - z * (cy - g.ih / 2);
    }
    applied = { s, tx, ty };
    viewport.style.setProperty("--zoom", String(s));
    viewport.style.setProperty("--pan-x", `${tx}px`);
    viewport.style.setProperty("--pan-y", `${ty}px`);
    if (viewport.classList.contains("is-zoomed") === fit) viewport.classList.toggle("is-zoomed", !fit);
    onChange?.(state());
  }

  /** Zooms to `next` CSS px per image px, keeping the image point under (clientX, clientY) where it is. */
  function zoomTo(next, clientX, clientY) {
    const g = measure();
    if (!g) return;
    const { min, max } = limits(g);
    const from = fit ? g.fitZ : z;
    if (fit) ({ x: cx, y: cy } = fitCentre(g));
    const qx = clientX ?? g.vx;
    const qy = clientY ?? g.vy;
    const px = cx + (qx - g.vx) / from;
    const py = cy + (qy - g.vy) / from;
    const to = Math.min(max, Math.max(min, next));
    if (to <= min * 1.0005) {
      fit = true;
    } else {
      fit = false;
      z = to;
      cx = px - (qx - g.vx) / z;
      cy = py - (qy - g.vy) / z;
      clampCentre(g);
    }
    render();
  }

  function current() {
    const g = geometry || measure();
    return fit || !g ? g?.fitZ ?? 1 : z;
  }

  const api = {
    get zoomed() {
      return !fit;
    },
    state,
    zoomTo,
    zoomBy(factor, clientX, clientY) {
      measure();
      zoomTo(current() * factor, clientX, clientY);
    },
    /** One image pixel per device pixel. */
    actualSize(clientX, clientY) {
      zoomTo(1 / pixelRatio(), clientX, clientY);
    },
    /** Fit if zoomed; otherwise actual size, or twice fit if actual size is not larger than fit. */
    toggle(clientX, clientY) {
      if (!fit) {
        api.reset();
        return;
      }
      const g = measure();
      if (!g) return;
      const actual = 1 / pixelRatio();
      zoomTo(actual > g.fitZ * 1.05 ? actual : g.fitZ * 2, clientX, clientY);
    },
    /** Moves the picture by (dx, dy) CSS px, as a drag does. */
    panBy(dx, dy) {
      if (fit || !geometry) return;
      cx -= dx / z;
      cy -= dy / z;
      clampCentre(geometry);
      render();
    },
    reset() {
      fit = true;
      measure();
      render();
    },
    /** Re-reads the layout after it changed, keeping the zoom and the image point in the middle. */
    relayout() {
      const g = measure();
      if (!fit && g) {
        const { min, max } = limits(g);
        z = Math.min(max, Math.max(min, z));
        if (z <= min * 1.0005) fit = true;
        else clampCentre(g);
      }
      render();
    },
    /**
     * A wheel or trackpad over the picture. A pinch on a trackpad arrives as a
     * wheel event with ctrlKey set and small deltas, hence the larger factor.
     */
    wheel(event) {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      const k = event.ctrlKey ? 0.01 : 0.0015;
      api.zoomBy(Math.exp(-event.deltaY * unit * k), event.clientX, event.clientY);
    },
    /** Two fingers went down: remember the image point between them and their spread. */
    pinchStart(a, b) {
      const g = measure();
      if (!g) return;
      if (fit) ({ x: cx, y: cy } = fitCentre(g));
      const from = fit ? g.fitZ : z;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      pinch = {
        from,
        spread: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        px: cx + (mx - g.vx) / from,
        py: cy + (my - g.vy) / from
      };
    },
    /** The fingers moved: scale with their spread, and keep that image point between them. */
    pinchMove(a, b) {
      const g = geometry;
      if (!pinch || !g) return;
      const { min, max } = limits(g);
      const to = Math.min(max, Math.max(min, pinch.from * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.spread)));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (to <= min * 1.0005) {
        fit = true;
      } else {
        fit = false;
        z = to;
        cx = pinch.px - (mx - g.vx) / z;
        cy = pinch.py - (my - g.vy) / z;
        clampCentre(g);
      }
      render();
    },
    pinchEnd() {
      pinch = null;
    }
  };

  const observer = new ResizeObserver(() => api.relayout());
  observer.observe(viewport);
  observer.observe(target);
  render();
  return api;
}

/**
 * Keyboard zoom: + and − step, 0 fits, 1 shows actual size. With `pan`,
 * the arrow keys move a zoomed picture by a tenth of the view.
 * Returns true when the key was used.
 */
export function zoomKey(zoom, event, { pan = false, viewport } = {}) {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  switch (event.key) {
    case "+":
    case "=":
      zoom.zoomBy(ZOOM_STEP);
      return true;
    case "-":
    case "_":
      zoom.zoomBy(1 / ZOOM_STEP);
      return true;
    case "0":
      zoom.reset();
      return true;
    case "1":
      zoom.actualSize();
      return true;
    default:
      break;
  }
  if (!pan || !zoom.zoomed) return false;
  const step = (viewport?.clientWidth || 400) / 10;
  const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  const move = moves[event.key];
  if (!move) return false;
  zoom.panBy(move[0], move[1]);
  return true;
}
