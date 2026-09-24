# HDR Converter

Turn an HDR image (typically a 10-bit BT.2020 PQ AVIF from a phone) into an SDR
image that looks right everywhere: crop it, convert it, download it. Everything
runs locally in the browser — no upload, no server.

**Live version: <https://davidgcs.github.io/hdr-converter/>**

## Features

- Preview, crop and convert HDR images to SDR, side by side. A crop applies as
  soon as you press **Done**, with no need to convert again, and stays visible
  on the source as the kept area.
- Crop ratio locked to the original aspect ratio by default, so the result keeps
  the proportions of the source. Free, 1:1, 16:9, 4:3 and 3:2 are also available.
- Faithful by default: every tone that an SDR screen can show is reproduced at
  the same light level it had in the HDR file, and only what is brighter is
  rolled off, with the ITU-R BT.2390 curve. A dark scene stays as dark as it
  was made; shadow detail is kept above the SDR screen's black.
- FFmpeg's `tonemap` curves (Mobius, Hable, Reinhard, …) and an auto-exposure
  mode are there as alternatives.
- An adjust panel behind the pencil icon, previewing live on a copy of the
  image inside the panel, with the tools photo editors lead with:
  - **Light**: exposure, contrast, highlights, shadows, white point, black point
  - **Color**: temperature, tint, vibrance, saturation
  - **Detail**: noise reduction, clarity, sharpness
  - **Effects**: vignette

  Edits belong to each image: a new image starts from the defaults, and every
  image keeps its own values, and its own history, however often you switch
  between them or convert again. Every control is neutral by default, and an
  untouched conversion is byte-for-byte what it was without the panel. A
  double-click resets any slider.

  Click the panel's picture to see it without your edits for a moment, or
  hold it to keep it that way until you let go (Space or Enter work too).
  It is the same conversion, at full size, with only the edits taken away.
- Undo and redo for each image's edits and crops, with buttons and with
  Ctrl+Z / Ctrl+Y (⌘Z / ⇧⌘Z on a Mac). A slider drag is one step.
- Zoom in the editor and in the before/after view, up to 800% of actual size:
  scroll or pinch to zoom where you point, drag to move around, or use the
  bar under the picture (the percentage switches between fit and 100%). See
  [Zoom](#zoom).
- A before/after view with a draggable wipe, comparing the converted file
  against the way your device already renders the HDR original. The drag is
  pointer-based and works the same with a finger as with a mouse, and it only
  moves composited layers, so it never repaints the pictures while you drag.
- While a dialog is open the page behind it stays still.
- Every setting has an **i** button explaining what it changes.
- Sensible defaults for a normal HDR AVIF; every knob is optional.
- JPEG, PNG or WebP output with an optional size limit. JPEG is 8-bit sRGB with
  an embedded sRGB profile, for WhatsApp, Instagram and the web; PNG is 16-bit
  sRGB, uncompressed, for archiving everything the tone curve produced.
- The picture you edit is kept lossless and full size. The format, quality
  and size limit are applied only when you download it (or open it in a new
  tab), so editing never compresses anything and there is no generational
  loss however many changes you make.
- English and Spanish interface with a persistent light/dark theme.
- Multi-file queue: load several images, convert them all with the same
  settings and download them individually or in one go. The round trash
  button on each thumbnail takes that one image out of the list. Conversions
  run in parallel in background workers, so the page never freezes (see
  [Performance](#performance)).

## How the conversion works

The pipeline follows the filter chain FFmpeg recommends for HDR to SDR, with
the ITU's BT.2390 curve in place of FFmpeg's default:

```sh
ffmpeg -i input.avif -vf "zscale=t=linear:npl=100,format=gbrpf32le,\
zscale=p=bt709,tonemap=tonemap=mobius:desat=2,zscale=t=bt709:m=bt709:r=tv" output.jpg
```

1. **Decode.** WebCodecs `ImageDecoder` hands back the raw planar samples
   (for example 10-bit `I420P10`), so the real HDR data is used. Drawing an HDR
   image on a canvas would let the browser clip it to SDR first.
   The colour tags come from the file's own `colr`/`nclx` box rather than from
   `VideoFrame.colorSpace`, which cannot express every CICP value: an AVIF coded
   with `matrix_coefficients = 0` (identity, so the planes carry G, B and R
   instead of Y, Cb and Cr — common in HDR game screenshots) is reported as
   `matrix: null`, and assuming a YUV matrix for it turns the picture green.
2. **Linearise.** The source transfer function (PQ / HLG / sRGB / BT.709) is
   inverted, with HLG also getting its OOTF. `1.0` means 100 nits, the same
   reference white FFmpeg uses.
3. **Adapt.** Nothing, by default: absolute light is kept, with 100 cd/m² as
   SDR white. The optional brightness modes re-expose here — see
   [Brightness](#brightness).
4. **Gamut.** Linear BT.2020 is converted to BT.709 with a matrix built from the
   primaries, like `zscale=p=bt709`. The few colours BT.709 cannot show are
   moved toward grey at constant luminance, just far enough to fit, instead of
   having their negative channel clipped — which keeps their hue and
   brightness and gives up only the saturation that does not exist in BT.709.
5. **Tone map.** ITU-R BT.2390 by default (below), or a port of
   `libavfilter/vf_tonemap.c`. Either way the curve is applied to the brightest
   component and the others are scaled with it, so hues stay put.
6. **Encode.** Back to sRGB, then the display-referred adjustments from the
   pencil panel if any are set. That is the working picture, kept lossless and
   full size. Only on download is it resized, if a limit is set, and written
   as JPEG, PNG or WebP. PNG is written at 16 bits per channel straight from the
   pipeline; JPEG and WebP go through the browser's 8-bit encoder.

The ported maths is covered by a reference test: a plain sRGB PNG round-trips
pixel-exact, and an 8-bit AVIF decodes within ~0.6/255 mean difference of
Chrome's own renderer.

## Brightness

HDR encodes *absolute* luminance. `zscale=npl=100` says "1.0 is 100 nits", and
an SDR reference display is a 100 cd/m² screen, so the faithful conversion
shows every tone at the light level it was mastered at and only has to deal
with what is brighter than the SDR screen can go. That is the default.

### Why not re-expose automatically

Earlier versions re-exposed every image so that its diffuse white landed near
SDR white. That makes all scenes the same brightness, which is exactly wrong
for a scene that is dark on purpose. A reported Resident Evil 4 screenshot
shows what it does:

| measured from the file | value |
| --- | --- |
| encoding (`colr`/`nclx`, and the AV1 sequence header agrees) | BT.2020, PQ, identity matrix, full range, 10-bit 4:4:4 |
| `clli` box | MaxCLL 80, MaxFALL 80 cd/m² |
| actual MaxCLL / frame-average (CTA-861.3, maxRGB) | **251 / 1.77 cd/m²** |
| luminance P10 / P50 / P90 / P99 | 0.02 / 0.25 / 1.78 / 25.5 cd/m² |
| share of pixels below 1 cd/m² | 82% |

The `clli` tag is a placeholder — 80 is scRGB's 1.0 — and is ignored; the peak
is measured. The scene really is that dark: a torch-lit corridor, code 0 used
as full-range black, nothing clipping. Auto exposure multiplied it by 29×,
five stops, and turned it into a bright blue daylight shot (median 76/255).
The faithful mapping gives a median of 13/255 with the torch-lit subject as
the brightest thing in the frame, which is what the original looks like.

For reference, macOS (ColorSync) and Chrome both put SDR white at BT.2408's
203 cd/m² when they show a PQ file on an SDR screen — half the 100 cd/m²
target used here — which is why HDR screenshots look so dark when shared
as-is.

### The tone curve

ITU-R BT.2390's EETF was chosen on this data, not by habit. Per luminance band
of that screenshot, how each curve reproduces the faithful level (1.00 is
exact):

| curve | < 1 | 1–30 | 30–100 (the lit subject) | > 100 (the lights) |
| --- | --- | --- | --- | --- |
| **BT.2390** | 1.00 | 1.00 | 1.00 | 0.67, 18 distinct levels |
| Mobius (FFmpeg) | 1.00 | 1.00 | 0.94 | 0.58 |
| Hable | 0.65 | 0.65 | 0.58 | 0.47 |
| Reinhard | 1.36 | 1.34 | 0.92 | 0.56 |
| Clip | 1.00 | 1.00 | 1.00 | 0.70, 1 level (clipped) |

BT.2390 works in the PQ domain and puts its knee where the measured peak
needs it — here about 60 cd/m² — so 99.7% of the pixels are untouched and only
the lights are rolled off. Content that already fits under 100 cd/m² gets no
knee at all.

Its second half, black point adaptation, maps source black onto the SDR
display's black (1000:1, so 0.1 cd/m²) along a curve that has faded out by the
midtones: ×1.36 at 1 cd/m², ×1.05 at 10, ×1.00 at 60. Without it, 99% of this
image's darkest band and 8% of the next rounded into code 0 — detail the HDR
display shows. Pure black stays at code 0. SDR sources skip it, since they
were graded for an SDR display already.

The implementation follows libplacebo's (`bt2390()` in
`src/tone_mapping.c`) with the Recommendation's knee offset of 0.5, and the
browser output matches an independent Python/libavif implementation to within
0.02/255 on all three test files.

| Mode | What it does |
| --- | --- |
| **Faithful** (default) | Absolute light, 100 cd/m² = SDR white. The screenshot above: median 13/255; a lamp-lit room 22/255; an overcast street 32/255. |
| HDR reference white (203 nits) | BT.2408 alignment, the way macOS and Chrome show PQ on an SDR screen. Half as bright. |
| Auto exposure | Re-exposes every scene to the same level (the 90th percentile of the lit pixels to 75 cd/m²). Brightens dark scenes, and changes their look. |

The **Exposure** slider composes on top of any mode, so `+1` is one stop above
it.

### Zoom

Both the editor and the before/after view zoom from fit to the window up to
800% of actual size, where **100% is one image pixel per device pixel** — on a
Retina screen that is half as many CSS pixels — so it shows what sharpening
and noise reduction really do. Scroll or pinch over the picture to zoom about
the point you are on, drag to move around, use the bar under the picture
(−, the percentage, +), or the keys + and −, 0 (fit) and 1 (100%). The picture
can never be dragged off into empty space, and it opens fit every time.

Zooming only sets a transform: nothing is laid out or repainted, the
compositor scales the full-size picture as a texture. A 20-step pan measures
0 layouts and 0 raster tasks. The zoom is kept in image terms, so it does not
jump when the editor swaps its half-size live frame for the full-size picture,
or when the window is resized.

In the **editor**, pressing the picture still shows it without your edits, and
now also pans. Holding still shows the unedited picture; moving pans. Zoomed
in, a press waits 150 ms before showing the unedited picture, so that a pan
never flashes it; so does a finger on a touch screen, in case a second finger
joins it for a pinch.

In the **comparison** both pictures take the very same transform, while the
line and the labels do not zoom, so the line stays where it is on screen and
the two pictures move under it together. Measured, they stay aligned to within
0.0001 px, and left of the line is exactly the original and right of it
exactly the result, at 91%, after panning and at 800%. Not zoomed, it works as
it always has. Zoomed in, drag the line to compare, drag anywhere else to move
around, and click to move the line there. A pinch that starts with one finger
on the picture puts the line back where that finger found it.

### Adjusting it by eye

The pencil icon under the result opens the adjust panel, which carries its own
copy of the preview so the sliders can be judged against the picture rather
than by their numbers. Both it and the result pane are painted from the same
frame, so they cannot drift apart.

`prepareScene` caches the image after the transfer function has been inverted
— the expensive part, and the part that does not depend on any of these
controls — so `renderPreview` only has to redo the gain, the gamut matrix, the
curve, the sRGB encode and the grade: around 50 ms for a 2560×1440 image.
While you drag, the pane shows that canvas; when you let go, a worker renders
the full-size working picture and it replaces the preview. Nothing is
compressed at that point: the file is only written when you download.

**Click or hold the picture to compare.** A click shows the image without
the edits for a moment; clicking again during that time returns at once,
and holding keeps the unedited image for as long as the press lasts. It is the
conversion the result on screen was made with — the settings are recorded with
the result, so changing the tone curve afterwards, without converting, does not
change what the comparison shows — rendered at full size, because a reduced
"before" would look softer than the full-size result and credit a Sharpness or
Clarity edit with detail that is really resolution. That render runs in a
worker when the panel opens, once per conversion and crop, at the lowest
priority, so it never delays an edit; until it is ready a press shows a
stand-in from the preview buffer.

**Undo and redo** are per image. A step is everything about the image you
can change — its edits and its crop — captured when a change starts and
recorded when it ends: a slider drag, a double-click reset, "Reset
adjustments", applying, resetting or re-fitting a crop. A double-click folds
the first click's move into the reset, so one Undo brings the old value
back. In crop mode, an unapplied selection is undone first. The shortcuts
are left alone inside text fields, and on a Mac ⌘Y keeps opening the
browser's history when there is nothing to redo.

**Double-click any slider to reset it** — to 0 for the adjustments, and to its
own default for settings like quality. The neutral position is read from the
control's `value` attribute, so there is no second list to keep in sync.

Both paths share `resolveAdaptation`, `resolvePeak`, `createCurve`,
`tonemapPixel`, `encodePixel` and the grade itself, and the release reuses
the measurement the preview exposed from, so nothing can shift under you when
you stop dragging. The preview takes two shortcuts the file does not: it
encodes with a tabulated sRGB curve (within about 0.005/255 of the exact one,
and three powers per pixel had been over half the cost of a frame), and it
runs noise reduction, clarity and sharpening at its own, smaller scale, so they
are approximate while you drag. Letting go renders the exact full-size picture
and shows that.

| Control | Where it acts |
| --- | --- |
| Exposure | Linear light, *before* the tone curve — a stop is a stop, and the curve is rebuilt around the new peak. |
| Temperature / Tint | Linear light, before the tone curve, as per-channel gains: the picture is treated as lit by a blackbody warmer or cooler than D65 and corrected for it (von Kries). ±100 is ±50 mired along the Planckian locus, the scale on which equal steps look equal; tint scales green across it. Normalised so a grey keeps its luminance, and the curve's peak widens with the largest gain so a warmed highlight rolls off instead of clipping. |
| Contrast | An S-curve about mid grey that fixes both endpoints, so it cannot clip either end. |
| Highlights / Shadows | One weighted lobe each, peaking at 25% and 75%. |
| White / black point | The endpoints of the displayed range. |
| Vibrance | Saturation weighted by how muted a colour is (1 − HSV saturation): a dull sky gains colour long before a vivid sign turns garish. |
| Saturation | Distance from grey, around the graded luminance. |
| Vignette | Linear display light, as a smooth falloff that follows the frame (crop included). Darkening multiplies, as a lens does; lightening mixes toward white so it cannot clip. |
| Noise reduction | A guided filter (He, Sun and Tang) on luminance and on the two colour-difference channels, at the saved resolution, before clarity and sharpening so they do not sharpen the noise back. Luminance is its own guide, so variations under ~9/255 at 100 are flattened while edges and texture pass through; colour is guided by luminance, so a colour edge that lines up with a brightness edge stays put while blotchy colour noise over flat areas is averaged away. Brightness is preserved exactly. On a synthetic noisy grey at 100: luminance noise ×0.17, colour noise ×0.08. |
| Clarity | Edge-aware local contrast in the midtones: the detail above a guided-filter base layer (He and Sun's fast guided filter, radius 1.2% of the diagonal), weighted away from black and white. Strong outlines barely move — a hard edge that a plain unsharp mask of the same radius would halo by ~89/255 moves by 4/255. |
| Sharpness | An unsharp mask on luminance (σ = 1 px, up to 150%) applied last, at the saved resolution — before a downscale it would mostly be averaged away. Differences under 0.5/255 are left alone, so 8-bit steps in a dark gradient are not turned into texture. |

Temperature and tint act on light, so they sit with exposure ahead of the tone
curve. The tonal and colour controls are display-referred and run *after* tone
mapping, on the sRGB-encoded signal, because that is the domain they are
named for: "shadows" and a black point are statements about where tones land
on the final display, not about scene light. Noise reduction, clarity and
sharpness need their neighbours, so they run last, over the finished image.

Clarity and sharpness change brightness locally but add the same amount to
all three channels, so they do not shift colours or draw coloured fringes.

Two properties are enforced by `src/grade.js` and checked by the tests. The
curve is **monotonic** over the whole parameter space — all 59,048 slider
combinations — so no setting can invert tones or posterise a gradient. And the
highlight and shadow lobes vanish *with zero slope* at both ends, so no amount
of shadow lift can raise pure black: an intentionally dark scene stays dark.
The lobe width is what makes those two controls honest. A gentle
`x²(1-x)³` is still at 38% strength in the highlights, which would make
"shadows" a midtone control wearing a disguise; `x²(1-x)⁶` leaks about 1/255
there, while still moving its own zone by 38/255 at the extreme.

These belong to the image, not to the settings: **Convert** changes the
conversion underneath them and keeps them, and **Restore defaults**, at the
end of the settings row, resets the shared settings and leaves every image's
edits alone. **Reset adjustments** in the panel puts one image back to
neutral.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Brightness | Faithful | How HDR luminance is mapped to SDR. See [Brightness](#brightness). |
| Tone mapping | BT.2390 | The ITU-R curve: leaves every tone that fits untouched, rolls off only what is brighter, keeps shadow detail above the SDR screen's black. The FFmpeg curves are also available — `mobius` compresses from 30 nits up, `hable` renders noticeably darker. |
| Source peak brightness | Auto | Measured from every pixel, after the conversion to BT.709 — not taken from the file's `clli` box, which HDR screenshots often fill with a placeholder. `Format standard` uses 10000 nits for PQ and 1000 for HLG; `Custom` lets you type a value. |
| Highlight desaturation | `0` | FFmpeg's `desat`: pulls pixels brighter than `desat × 100` nits towards their luma. `0` keeps every colour's chromaticity as measured; FFmpeg's own default is `2`. |
| Crop ratio | Original | Keeps the source aspect ratio while cropping. |
| Output format / quality | JPEG, 92 | JPEG: 8-bit sRGB with an embedded sRGB profile. PNG: 16-bit sRGB (`sRGB` chunk), uncompressed, keeps alpha — about 22 MB for 2560×1440. |
| Read source as | Auto | Override when a file has wrong or missing HDR tagging. |
| Curve parameter | Standard value | BT.2390's knee offset (0.5), or `tonemap`'s `param` (0.3 for mobius, 1.8 for gamma, …). |
| Limit longest side | Original | Optional downscale, applied to the downloaded file; the picture you edit stays full size. The aspect ratio is preserved. |

The pencil icon under the result opens the per-image adjustments: light
(exposure, contrast, highlights, shadows, white and black point), colour
(temperature, tint, vibrance, saturation), detail (noise reduction, clarity,
sharpness) and a vignette. All are neutral by default, so they change nothing
until you move them, and each image keeps its own. See
[Adjusting it by eye](#adjusting-it-by-eye).

## Browser support

Accurate conversion needs WebCodecs `ImageDecoder`, available in Chrome and
Edge. Other browsers fall back to the image the browser already converted, and
the app says so in the note under the preview.

Conversions run in module Web Workers where the browser has them. Where it does
not, or if the worker script cannot load (the page opened from `file://`, say),
the same code runs on the main thread instead and produces identical files,
only without the parallelism.

## Run locally

```sh
git clone https://github.com/davidgcs/hdr-converter.git
cd hdr-converter
python3 -m http.server 8000
```

Then open <http://localhost:8000>. There is no build step and no dependency.

## Performance

Measured with twelve 2560×1440 10-bit AVIFs, against the previous release:

| | before | now |
| --- | --- | --- |
| Load 12 images | 4.1 s | 1.5 s (three decode at once) |
| Switch between images | 290–350 ms, page frozen | 33 ms, never frozen |
| Convert all 12 | 4.5 s, page frozen 1.2 s | 1.1–1.4 s, never frozen |
| Apply an edit (full size) | 340 ms, page frozen | ~260 ms, in the background |
| Live preview frame | 51 ms | 51 ms |

Switching was slow because the list was rebuilt on every click, and each
thumbnail was an `<img>` of the full-size file: the browser decoded about two
seconds' worth of 2560×1440 AVIFs per click to draw 84 px thumbnails. Each image
now has one small thumbnail canvas, drawn once, and the list is updated in
place. The source pane's picture is decoded before it is swapped in, rather
than decoded synchronously in the middle of a frame.

Conversions and full-size edit renders run in a pool of workers (`src/pool.js`,
`src/worker.js`), several images at once, with the edit you just made always
ahead of batch and background work. Each worker keeps the source it last
worked on, so repeated renders of the image being edited do not copy its
22 MB of samples again. Full-size working pictures are kept within a memory
budget (about twenty such images), least recently viewed dropped first, and
the editor-only caches are kept for the selected image alone; overall memory
is within a few percent of the previous release.

`src/pipeline.js` is stateless, and `src/jobs.js` holds the work a job does, so
the main-thread fallback and the workers run the very same code.

## Credits

Colour and tone mapping maths ported from [FFmpeg](https://git.ffmpeg.org/ffmpeg.git)
(`libavfilter/vf_tonemap.c`, `libavfilter/colorspace.c`,
`libavfilter/opencl/colorspace_common.cl`, `libavutil/csp.c`), which is
licensed LGPL-2.1-or-later. Each ported function notes its origin in the source.

The BT.2390 curve implements ITU-R BT.2390's EETF, including its black point
adaptation, and was checked against [libplacebo](https://code.videolan.org/videolan/libplacebo)'s
`bt2390()` (`src/tone_mapping.c`, LGPL-2.1-or-later).

The creator banner is shared with [Safe Layer](https://github.com/davidgcs/safelayer):
copy the `.github-brand` element from `index.html` plus `github-brand.css` to
reuse it.

## License

GPL-3.0. See [LICENSE](./LICENSE).
