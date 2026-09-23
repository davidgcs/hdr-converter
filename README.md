# HDR Converter

Turn an HDR image (typically a 10-bit BT.2020 PQ AVIF from a phone) into an SDR
image that looks right everywhere: crop it, convert it, download it. Everything
runs locally in the browser — no upload, no server.

**Live version: <https://davidgcs.github.io/hdr-converter/>**

## Features

- Preview, crop and convert HDR images to SDR, side by side.
- Crop ratio locked to the original aspect ratio by default, so the result keeps
  the proportions of the source. Free, 1:1, 16:9, 4:3 and 3:2 are also available.
- Tone mapping curves ported from FFmpeg's `tonemap` filter.
- Automatic exposure so HDR photos look right on ordinary screens and in
  messaging apps, instead of coming out dark.
- An adjust panel behind the pencil icon: exposure, contrast, highlights,
  shadows, white point, black point and saturation, previewing live on a copy
  of the image inside the panel. Every one is neutral by default, a
  double-click resets any slider, and converting again starts from the
  faithful result.
- A before/after view with a draggable wipe, comparing the converted file
  against the way your device already renders the HDR original. The drag is
  pointer-based and works the same with a finger as with a mouse.
- Every setting has an **i** button explaining what it changes.
- Sensible defaults for a normal HDR AVIF; every knob is optional.
- JPEG, PNG or WebP output with a quality slider and an optional size limit.
- The result preview *is* the encoded file, so downloading it, right-clicking it
  or opening it in a new tab all give you the same image.
- English and Spanish interface with a persistent light/dark theme.
- Multi-file queue: load several images, convert them all with the same
  settings and download them individually or in one go.

## How the conversion works

The pipeline mirrors the filter chain FFmpeg recommends for HDR to SDR:

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
3. **Adapt.** The scene's diffuse white is measured and the image is
   exposed around it. This is the one step the FFmpeg chain above does *not*
   do, and it is why that chain leaves so many HDR photos looking dark — see
   [Brightness](#brightness) below.
4. **Gamut.** Linear BT.2020 is converted to BT.709 with a matrix built from the
   primaries, exactly like `zscale=p=bt709`.
5. **Tone map.** A port of `libavfilter/vf_tonemap.c`: highlight desaturation,
   then the selected curve applied to the brightest component so hues stay put.
6. **Encode.** Back to sRGB, then the display-referred adjustments from the
   pencil panel if any are set, cropped, optionally resized, then
   JPEG/PNG/WebP.

The ported maths is covered by a reference test: a plain sRGB PNG round-trips
pixel-exact, and an 8-bit AVIF decodes within ~0.6/255 mean difference of
Chrome's own renderer.

## Brightness

HDR encodes *absolute* luminance: `zscale=npl=100` says "1.0 is 100 nits" and
`tonemap` only compresses what is brighter than that. Everything below is
passed straight through, so a scene that was graded to look good on a 1000-nit
display keeps its original, genuinely low nit values. On an HDR screen that is
exactly right; on a phone, a laptop or WhatsApp it lands in the display's black
floor and the picture looks far darker than the original did.

A real photo of a lamp-lit room measures a median of **0.56 nits**. Reproduced
faithfully, that is a median of 17/255 — a correct answer to the wrong
question.

So the tool adds the step FFmpeg deliberately skips, and exposes the picture
the way a photographer would before the curve runs. FFmpeg omits it because
measuring per frame makes video flicker, which cannot happen for a single
still.

The measurement anchors on the scene's **diffuse white**: the level the
brightest *ordinary* surfaces sit at, as opposed to speculars and light
sources, estimated as the 90th percentile of the lit pixels and mapped to 75
nits. That leaves the top of the scene room to roll off into white instead of
clipping there.

Reinhard's log-average key is the textbook estimator for this, and it was the
first thing tried here, but it is not robust for the job: it weighs every pixel
equally, so a letterboxed frame reports a far lower average than the same
picture without the bars. One real 2560×1440 screenshot is **29% pure black**,
which dragged its log-average below that of a much darker photo and demanded a
64× correction — a badly blown-out result. A high percentile of the lit pixels
measures the same quantity, ignores matte borders entirely, and barely moves
when the bars are cropped away (3.65× versus 3.49× on that file).

| Mode | What it does |
| --- | --- |
| **Auto exposure** (default) | Finds the scene's diffuse white and puts it just below SDR white. The room above becomes a median of 84/255 with 0.03% clipping; the letterboxed screenshot lands at 62/255 with none. |
| HDR reference white (203 nits) | Maps BT.2408 diffuse white to SDR white. Standards-correct, still dark for dim scenes. |
| Absolute (FFmpeg, 100 nits) | The `npl=100` behaviour of the command line above, for matching FFmpeg output exactly. |

Auto exposure only runs on genuine PQ and HLG sources. An SDR file has already
been graded for SDR, so re-exposing it would fight the grade it arrived with;
those files convert identically in every mode. The **Exposure** slider still
composes on top, so `+1` is one stop above whichever mode is selected.

### Adjusting it by eye

The pencil icon under the result opens the adjust panel, which carries its own
copy of the preview so the sliders can be judged against the picture rather
than by their numbers. Both it and the result pane are painted from the same
frame, so they cannot drift apart.

`prepareScene` caches the image after the transfer function has been inverted
— the expensive part, and the part that does not depend on any of these
controls — so `renderPreview` only has to redo the gain, the gamut matrix, the
curve, the sRGB encode and the grade: around 50 ms for a 2560×1440 image.
While you drag, the pane shows that canvas; when you let go the file is
re-encoded at full resolution and the preview becomes the real file again.

**Double-click any slider to reset it** — to 0 for the adjustments, and to its
own default for settings like quality. The neutral position is read from the
control's `value` attribute, so there is no second list to keep in sync.

Both paths share `resolveAdaptation`, `resolvePeak`, `createCurve`,
`tonemapPixel` and `encodePixel`, and the release reuses the measurement the
preview exposed from, so nothing can shift under you when you stop dragging.

| Control | Where it acts |
| --- | --- |
| Exposure | Linear light, *before* the tone curve — a stop is a stop, and the curve is rebuilt around the new peak. |
| Contrast | An S-curve about mid grey that fixes both endpoints, so it cannot clip either end. |
| Highlights / Shadows | One weighted lobe each, peaking at 25% and 75%. |
| White / black point | The endpoints of the displayed range. |
| Saturation | Distance from grey, around the graded luminance. |

Everything except exposure is display-referred and runs *after* tone mapping,
on the sRGB-encoded signal, because that is the domain those controls are
named for: "shadows" and a black point are statements about where tones land
on the final display, not about scene light.

Two properties are enforced by `src/grade.js` and checked by the tests. The
curve is **monotonic** over the whole parameter space — all 59,048 slider
combinations — so no setting can invert tones or posterise a gradient. And the
highlight and shadow lobes vanish *with zero slope* at both ends, so no amount
of shadow lift can raise pure black: an intentionally dark scene stays dark.
The lobe width is what makes those two controls honest. A gentle
`x²(1-x)³` is still at 38% strength in the highlights, which would make
"shadows" a midtone control wearing a disguise; `x²(1-x)⁶` leaks about 1/255
there, while still moving its own zone by 38/255 at the extreme.

These adjust the result you are looking at rather than being settings, so
pressing **Convert** returns them all to neutral. **Restore defaults**, at the
end of the settings row, puts every control back to the recommended baseline.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Brightness | Auto exposure | How HDR luminance is mapped to SDR. See [Brightness](#brightness). |
| Tone mapping | `mobius` | FFmpeg curve. Mobius leaves everything below 30 nits untouched and rolls off the highlights, which keeps photos looking natural. `hable` reproduces the classic FFmpeg one-liner but renders noticeably darker. |
| Source peak brightness | Auto | Browsers do not expose mastering metadata, so the peak is measured from the image. `Format standard` uses 10000 nits for PQ and 1000 for HLG; `Custom` lets you type a value. |
| Highlight desaturation | `2` | FFmpeg's `desat`. Pixels brighter than 200 nits are pulled towards their luma so specular highlights do not turn into odd colours. |
| Crop ratio | Original | Keeps the source aspect ratio while cropping. |
| Output format / quality | JPEG, 92 | PNG keeps alpha and skips the quality slider. |
| Read source as | Auto | Override when a file has wrong or missing HDR tagging. |
| Curve parameter | FFmpeg default | `tonemap`'s `param` (0.3 for mobius, 1.8 for gamma, …). |
| Limit longest side | Original | Optional downscale; the aspect ratio is preserved. |

The pencil icon under the result opens the per-image adjustments — exposure,
contrast, highlights, shadows, white point, black point and saturation. All are
neutral by default, so they change nothing until you move them, and **Convert**
returns them to neutral. See [Adjusting it by eye](#adjusting-it-by-eye).

## Browser support

Accurate conversion needs WebCodecs `ImageDecoder`, available in Chrome and
Edge. Other browsers fall back to the image the browser already converted, and
the app says so in the note under the preview.

## Run locally

```sh
git clone https://github.com/davidgcs/hdr-converter.git
cd hdr-converter
python3 -m http.server 8000
```

Then open <http://localhost:8000>. There is no build step and no dependency.

## Bulk editing

`src/pipeline.js` is stateless and exposes `convertAll(items, settings)`, and the
app already holds images in a queue, so a full bulk mode only needs UI work.

## Credits

Colour and tone mapping maths ported from [FFmpeg](https://git.ffmpeg.org/ffmpeg.git)
(`libavfilter/vf_tonemap.c`, `libavfilter/colorspace.c`,
`libavfilter/opencl/colorspace_common.cl`, `libavutil/csp.c`), which is
licensed LGPL-2.1-or-later. Each ported function notes its origin in the source.

The creator banner is shared with [Safe Layer](https://github.com/davidgcs/safelayer):
copy the `.github-brand` element from `index.html` plus `github-brand.css` to
reuse it.

## License

GPL-3.0. See [LICENSE](./LICENSE).
