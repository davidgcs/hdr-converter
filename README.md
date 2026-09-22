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
3. **Adapt.** The scene's log-average luminance is measured and the image is
   exposed around it. This is the one step the FFmpeg chain above does *not*
   do, and it is why that chain leaves so many HDR photos looking dark — see
   [Brightness](#brightness) below.
4. **Gamut.** Linear BT.2020 is converted to BT.709 with a matrix built from the
   primaries, exactly like `zscale=p=bt709`.
5. **Tone map.** A port of `libavfilter/vf_tonemap.c`: highlight desaturation,
   then the selected curve applied to the brightest component so hues stay put.
6. **Encode.** Back to sRGB, cropped, optionally resized, then JPEG/PNG/WebP.

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

A real photo of a lamp-lit room measures a median of **0.56 nits**, with a
log-average of 0.57. Reproduced faithfully, that is a median of 17/255 — a
correct answer to the wrong question.

So the tool restores the step Reinhard's *Photographic Tone Reproduction*
starts with and FFmpeg deliberately skips: scaling the scene so its log-average
lands on a target key before the curve runs. FFmpeg omits it because measuring
per frame makes video flicker, which is not a concern for a single still.

| Mode | What it does |
| --- | --- |
| **Auto exposure** (default) | Measures the scene's log-average luminance and exposes around it, with the key nudged by where the scene sits between its own shadow and highlight ends. The room above becomes a median of 88/255 with 0.04% clipping. |
| HDR reference white (203 nits) | Maps BT.2408 diffuse white to SDR white. Standards-correct, still dark for dim scenes. |
| Absolute (FFmpeg, 100 nits) | The `npl=100` behaviour of the command line above, for matching FFmpeg output exactly. |

Auto exposure only runs on genuine PQ and HLG sources. An SDR file has already
been graded for SDR, so re-exposing it would fight the grade it arrived with;
those files convert identically in every mode. The **Exposure** slider still
composes on top, so `+1` is one stop above whichever mode is selected.

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
| Exposure | `0` | Extra stops applied in linear light, on top of the Brightness mode. |
| Limit longest side | Original | Optional downscale; the aspect ratio is preserved. |

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
