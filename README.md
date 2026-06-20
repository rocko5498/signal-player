# SIGNAL — Lossless Music Player

A 100% browser-based PWA for serious listening. No server. No upload. The browser reads files straight off your drive.

## Architecture (what's where, and why)

```
index.html        ─ shell: layout, instrument-panel UI
app.js            ─ engine: file ingest, Web Audio graph, transport, meters, spectrum
metadata.js       ─ binary header parsers (FLAC, WAV, AIFF, DSF, DFF)
wasm-bridge.js    ─ loads the Rust DSD decoder on demand
rust/             ─ Rust crate that compiles to WebAssembly
manifest.webmanifest, sw.js  ─ PWA install + offline shell
```

The "Rust backed" part: the **DSD decoder is a Rust crate (`rust/`) compiled to WebAssembly** and shipped as a static `.wasm` blob. The browser loads it lazily, only when you open a `.dsf` or `.dff` file. Everything else uses the browser's native decoder so we don't waste cycles re-implementing FLAC in WASM when Chrome and Firefox already do it natively at full speed.

## What you get out of the box

- **FLAC, ALAC, WAV, AIFF, MP3, OGG, OPUS, M4A** — native browser decode, bit-perfect when the source rate matches your device.
- **Sample rate / bit depth / channel count read from the file header**, not guessed. If your AudioContext is resampling (e.g. 96 kHz file on a 48 kHz device), the top-right CONTEXT readout turns red so you know.
- **Hardware-style dual-channel meters** with peak-hold dots: green → amber → red, segmented like a real meter bridge.
- **Log-scale spectrum** 20 Hz – 20 kHz with octave gridlines at 100/1k/10k.
- **Folder picker** via the File System Access API (Chromium); falls back to `webkitdirectory` on Firefox/Safari.
- **Keyboard**: space (play/pause), ← / → (seek 5s), Shift+← / → (prev / next track).
- **PWA installable**, works offline once loaded.

## DSD playback — building the Rust/WASM module

DSD (.dsf / .dff) cannot be played natively by any browser. To enable it, build the Rust crate:

```bash
# 1. Install Rust + wasm-pack if you don't have them
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install wasm-pack

# 2. Build the decoder
cd rust
wasm-pack build --target web --release

# 3. Move the output into the static site
mkdir -p ../wasm
cp pkg/dsd_decoder.js pkg/dsd_decoder_bg.wasm ../wasm/
```

That's it. The next time you open a DSD file, the bridge auto-loads `/wasm/dsd_decoder.js` and decodes to PCM at your AudioContext's native rate. If the WASM module isn't present, the player tells you clearly — every other format keeps working.

> **The taps in `rust/src/lib.rs` are placeholder coefficients.** For real listening, regenerate a proper 127- or 255-tap windowed-sinc low-pass for your target decimation ratio. Symphonia handles the demux; the filter is on you.

## Deploy

It's static files. Drop the folder on Cloudflare Pages, Netlify, GitHub Pages, or any CDN:

```bash
# Cloudflare Pages, for example:
npx wrangler pages deploy .
```

No build step needed unless you're rebuilding the WASM module.

## Privacy

Files are read with `FileReader` and `URL.createObjectURL`. Nothing leaves your machine. The service worker caches the app shell only — never your music.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `→` / `←` | Seek ±5 s |
| `Shift + →` / `←` | Next / previous track |

## Known limits

- Safari's FLAC support landed in 17.4; older versions fall back to a clear error toast.
- DSD transport (pause/seek mid-track) is play-only in this build; the next track switch returns control to the native engine. Full DSD transport requires routing through an `AudioWorklet` with a streaming decoder — straightforward extension of `wasm-bridge.js`.
- APE and WavPack: format pill displays, but native browsers don't decode them. Add Symphonia codec features in `Cargo.toml` and extend the bridge if you need them.
