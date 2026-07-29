# Pixora Studio 🎨

A beautiful, **fully client-side** image SaaS — crop, resize the canvas, compress, edit metadata and download. Every pixel is processed in your browser; nothing is ever uploaded to a server.

## ✨ Features

### Upload — every way you'd expect
- 🖱️ **Drag & drop** anywhere on the page (full-window drop overlay)
- 📋 **Ctrl+C → Ctrl+V** paste from the clipboard (plus a Paste button using the async Clipboard API)
- 📁 Classic **file picker** (click the dropzone, `Browse files`, or `Ctrl+O`)
- 🔗 **From URL** (CORS-permitting)

### Format support
- Opens **JPG, PNG, WebP, GIF, SVG, TIFF, BMP, AVIF** and **HEIC/HEIF (iPhone)** — HEIC is converted on-device with `heic2any` (libheif compiled to JS)
- GIFs are flattened to their first frame for editing; SVGs are rasterised at high resolution so crops stay sharp
- Exports **PNG (lossless)**, **JPG** and **WebP**

### 📏 Resize-first for exams & forms (default)
- Right below the image, tick between **Resize** (default) and **Crop** (optional, manual)
- Resize mode scales the whole photo to an exact size (e.g. **120 × 150 px under 50 KB**) with one-click presets, a KB limit, and a fit strategy (auto-trim centre / pad with white / stretch) — no cropping required
- Cropping is a secondary feature: tick **✂️ Crop** to select an area manually

### Crop & aspect ratio
- Preset ratios (Free, 1:1, 4:5, 3:4, 4:3, 3:2, 16:9, 9:16, 21:9, 2:3) + **custom W:H**
- Numeric width / height / offset inputs in **px, %, in, cm, mm** with a configurable **DPI**
- Rotate ±90°, flip, zoom, reset

### Canvas size
- Grow (**Extend**) or shrink (**Trim**) the canvas so the final image matches any target aspect ratio — without distorting the photo
- Backgrounds: transparent, white, black, custom colour, or a **blurred image fill**
- 9-point image alignment on the new canvas

### Compress & download
- **Maximum (no quality loss)** or **Compress** mode with a quality **slider + numeric input** (1–100 %)
- Live output preview, original → output size comparison with a % badge
- The **file size is shown inside the download button** and updates live as you tweak settings
- `Ctrl+S` downloads too

### Metadata (EXIF)
- Accordion listing **every tag** found in the file — EXIF IFD0/Exif/GPS/thumbnail (editable), plus XMP, ICC, IPTC, JFIF and PNG header segments (informational)
- Edit any editable value (or add Artist, Copyright, DateTime… to images that have none) — edits are embedded on JPG export
- One-click **Strip all** for privacy

### History
- Every export is saved to a **localStorage-only** history with thumbnail, format, size and settings; small outputs stay re-downloadable
- Survives reloads, capped and quota-safe, clearable at any time

## 🚀 Running it

It's a static site — no build step, no server-side code.

```bash
# any static file server works
npx http-server .        # or: python3 -m http.server
```

…then open the printed URL. Opening `index.html` directly from disk works too.

## 🧱 Stack

| Piece | Library (vendored in `vendor/`) |
|---|---|
| Crop UI | [Cropper.js](https://github.com/fengyuanchen/cropperjs) 1.6.2 |
| HEIC decode | [heic2any](https://github.com/alexcorvi/heic2any) 0.0.4 |
| EXIF read/write (JPEG) | [piexifjs](https://github.com/hMatoba/piexifjs) 1.0.6 |
| Metadata parsing (all formats) | [exifr](https://github.com/MikeKovarik/exifr) 7.1.3 |
| Everything else | Vanilla HTML/CSS/JS |

All dependencies are vendored, so the app works fully offline.
