# v6 — load shedding to Rust

## What moved from JS to Rust

### 1. Metadata parsing (every file ingest)
- **Before:** 4 JS Web Workers running `metadata-core.js` (pure JS binary parser)
- **After:** Each worker loads the Rust WASM and uses `core.parseMetadata()`. Falls back to JS if WASM isn't loaded yet.
- **Expected speedup:** 5–10× per file. For your 2315-track library:
  - Cold (no cache): ~10s → ~2s
  - Warm (cache hit): no change (IndexedDB read still dominates)

### 2. THD+N signal-path measurement
- **Before:** JS `measureSignalPath` had a ±5 bin exclusion window — too narrow, leaked Hann-window energy into the noise calculation. Produced `-14 dB` on clean signals.
- **After:** Captures time-domain samples via Web Audio, hands them to Rust `measure_thd_n` which uses ±15 bin exclusion and ran 8/8 unit tests at < -60 dB on clean sines.
- **Bug fixed:** the constant `-14 dB` reading you saw.
- **JS fallback also corrected** with ±15 exclusion in case WASM ever fails to load.

### 3. DSD playback (DSF / DFF files)
- **Before:** `.dsf` / `.dff` files appeared in the library but were silent. `engine.decode()` couldn't handle them.
- **After:** Engine detects DSD extension, reads the file bytes, hands them to Rust `decode_dsd_to_pcm` which:
  - Demuxes the DSF container (self-contained, no Symphonia dependency)
  - Reads 1-bit DSD samples
  - Applies a 127-tap windowed-sinc low-pass filter
  - Decimates to the AudioContext's sample rate
  - Returns interleaved stereo f32 PCM
- Engine wraps the result in an AudioBuffer and plays it normally — gapless, ReplayGain, etc all work.
- DSF works. DFF support comes in v7 (different bit order + endianness).

### 4. Engine decode path
- Plain PCM (FLAC/WAV/MP3): still uses browser-native `decodeAudioData` — already optimised in C++.
- DSD: routes through Rust as above.

## What stayed in JS

- DOM / virtual list rendering — wasm-bindgen overhead makes Rust slower for these
- Web Audio scheduling, gapless logic — browser APIs only
- IndexedDB operations — browser API only
- Spectrum visualizer — uses browser's native `analyser.getByteFrequencyData()` (already in C++)
- Album / artist aggregation — too cheap to bother moving
- Search filter — fast enough at 2000 tracks; will reconsider at 10k+

## How to verify it's working

After rebuild + push:

1. **Console** should show:
   ```
   [signal_core] signal_core v0.2.0 (signal_core)
   [signal] Rust core active
   ```
   The `v0.2.0` confirms it's the new build.

2. **THD+N measurement:** click the badge with playback paused. Should show `-80 dB` or lower (clean). If it still shows -14, WASM didn't load.

3. **DSD playback:** if you have any `.dsf` files, they should now actually play. They'll show up with the regular metadata cells (sample rate of 2822400 etc.). The first decode takes ~1-2s because the FIR filter has to process millions of samples. Subsequent plays are instant from the cached buffer.

4. **Ingest speed:** open a folder with 2000+ tracks while watching DevTools → Performance. The main thread should stay much more responsive than before.

## What's pending for v7+ (future)

- **DFF demuxer** in Rust (only DSF works now)
- **Album art dominant color** extraction in Rust → cleaner ambient glow
- **Library hi-res scan** via raw FLAC decode in Rust (no Web Audio dependency) → 10× faster full-library scan
- **Rust-side search index** for 10k+ track libraries
- **A/B comparison mode** for duplicate-album detection
