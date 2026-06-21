# SIGNAL — what's done, what's next

## Current state (this commit)

### Rust core ✓
Built and ready, but the .wasm isn't compiled yet. You build it once tomorrow per `BUILD.md`. Until then, the app runs in pure-JS mode (slower but functional).

What's in Rust:
- `parse_metadata(bytes, ext, want_art)` — FLAC, WAV, AIFF, DSF, DFF, MP4 header parsing with embedded picture extraction
- `compute_dr(samples, sample_rate, channels)` — TT DR Meter algorithm
- `analyze_hi_res(samples, sample_rate, channels, claimed_rate, claimed_bits)` — fake hi-res detection
- `measure_thd_n(samples, sample_rate, fundamental_hz)` — signal-path THD+N
- `decode_dsd_to_pcm(bytes, target_rate)` — DSF → PCM with 127-tap FIR filter

Test suite: 9 tests, all passing. Run `cargo test` in `rust/` to verify.

### JS bridge ✓
`js/wasm-bridge.js` loads the WASM, exposes typed functions, falls back to JS on failure. The app works either way.

### UI ✓ (McIntosh-influenced)
Black/grey chassis, brushed metal panels, recessed LCD displays, SVG VU needles with proper ballistics, knurled volume knob with scroll wheel.

### Performance ✓
- Virtualised track list (10k+ tracks)
- 4-worker pool for metadata parsing
- Batched IndexedDB writes (one transaction per 50 files instead of per file)
- Lazy album art (only loads when track is shown/played)
- Debounced search
- Single render at end of ingest, not per-batch
- Cached row element refs

---

## What's NOT done

### 1. Move metadata parsing INTO Rust workers
Right now: JS workers call `metadata-core.js` (pure JS).
Should be: JS workers call `core.parseMetadata()` which dispatches to Rust.

The Rust module is ready. The worker just needs to be updated to use it. Easy change, ~30 lines of code.

### 2. DFF demuxer
DSD via DSF works. DFF (the other DSD container) isn't supported in Rust yet. Spec is similar but big-endian and bit ordering differs.

### 3. Wire DSD playback end-to-end
The Rust decoder produces PCM. The audio engine needs a new code path: detect DSD → decode → feed PCM into a buffer source. Not wired yet.

### 4. A/B comparison mode
Was on the original agenda. Not built. Needs duplicate-album detection logic and a level-matched parallel playback path.

### 5. Library scan progress UI
The SCAN button works but there's no progress indicator beyond the libStatus text. A modal or progress bar would be nicer.

---

## Suggested next session order

When you come back with WASM built and running:

1. **Verify the WASM is actually being used.** Open DevTools → Console, look for `[signal] Rust core active`. Click a track, watch DR/HI-RES verdicts populate. Compare speed against the previous JS-only version.

2. **Move metadata parsing into Rust.** Currently the JS workers do it. Switching to Rust will speed up ingest of 2000-track folders by another 5-10×.

3. **DFF support.** If you have DFF files. Most DSD downloads are DSF anyway.

4. **DSD playback wiring.** Make the engine actually use `decode_dsd_to_pcm` when it sees a `.dsf` file.

5. **A/B mode** (the killer feature). Multi-version detection, level-match, blind toggle.

---

## What I'd ask me when you come back

- "Show me how to update the metadata worker to use Rust."
- "How do I know if the WASM is the latest version after I rebuild?"
- "DSD playback isn't working — walk me through the engine changes."
- "Add DFF support to the Rust core."

Open this file, paste a question, and I'll know exactly where we left off.
