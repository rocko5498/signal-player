# SIGNAL

**The lossless music player that tells you the truth about your music.**

Browser-based. No server. No upload. 100% client-side PWA.

## What it does that other players don't

- **Reads source spec from the binary header**, not from tags or extensions. Sample rate, bit depth, channels — exactly what's in the file.
- **Matches AudioContext sample rate to the source** when possible. No silent resampling at our layer.
- **Shows a 3-stage signal chain** (`FILE → ENGINE → OUTPUT`). Green when matched, amber when the OS will downsample.
- **Measures the signal path** with a real 1 kHz null test. Earned MEASURED CLEAN badge, not assigned.
- **Detects fake hi-res files** — tells you if a "24/96" file is actually an upsampled 16/44.1 CD rip with no real signal above 22 kHz.
- **Computes Dynamic Range (DR)** per track using the TT DR Meter algorithm. Spot loudness-war casualties at a glance.
- **Two views**: a dense library/instrument panel for browsing, a turntable for listening. Toggle with `M`.
- **Gapless playback** by default (Web Audio scheduled, not `<audio>`-element gapless).
- **Album art extracted** from FLAC PICTURE blocks, cached in IndexedDB.

## Supported formats

Native (no extra build): **FLAC, WAV, AIFF, ALAC, MP3, OGG, OPUS, M4A**.
Via Rust/WASM (build required): **DSF, DFF (DSD)**.

## Run it

It's static files. Drop on GitHub Pages / Cloudflare Pages / Netlify. Open `index.html` from a local server (not `file://` — File System Access API needs HTTPS or localhost).

```bash
# quick local test
python3 -m http.server 8000
# open http://localhost:8000
```

## Build the DSD decoder (optional)

```bash
cd rust
cargo install wasm-pack
wasm-pack build --target web --release
mkdir -p ../wasm
cp pkg/dsd_decoder.js pkg/dsd_decoder_bg.wasm ../wasm/
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `→` / `←` | Seek ±5s |
| `Shift + →` / `←` | Next / previous track |
| `M` | Toggle library / vinyl view |
| `S` | Toggle shuffle |
| `R` | Cycle repeat (off / all / one) |
| `/` | Focus library search |

## Architecture

```
index.html        — shell, two views (library + vinyl)
style.css         — DAC panel + turntable styling
js/main.js        — orchestration, state
js/engine.js      — Web Audio: gapless, rate matching
js/visualizers.js — meters + spectrum, optimized canvas
js/virtual-list.js — windowed scroller (10k+ tracks)
js/metadata-core.js — binary header parsers
js/metadata-worker.js — runs parsers off main thread
js/worker-pool.js — pool of 4 workers
js/analysis.js    — DR, fake hi-res detection, signal measurement
js/db.js          — IndexedDB cache for metadata + art
rust/             — DSD decoder, compiled to WASM
sw.js             — offline app shell cache
manifest.webmanifest — PWA install metadata
```

## Privacy

Files are read via `FileReader` and the File System Access API. Nothing leaves your machine. The service worker caches the app shell only — never your music.

## Why "honest" not "perfect"

Browsers can't request WASAPI Exclusive mode or ASIO. The OS audio stack will mix and possibly resample after our chain. **SIGNAL shows you this honestly** rather than slapping a "Master" badge on top. Set your Windows audio device's default rate to match the album, and the OUTPUT stage in the chain badge turns green.

That's the same honesty Tidal and Qobuz don't give you.
