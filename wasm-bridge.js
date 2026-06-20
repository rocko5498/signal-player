// ============================================================
// wasm-bridge.js — Rust (compiled to WebAssembly) decoder hook.
//
// Why this exists:
//   Browsers natively decode FLAC, ALAC, WAV, AIFF, MP3, OGG, OPUS.
//   They do NOT decode DSD (.dsf/.dff) or, in some cases, APE/WavPack.
//   To stay 100% client-side without a server, we use a Rust decoder
//   compiled to WebAssembly. This module loads it lazily and only
//   when an unsupported format is opened.
//
// Drop-in target:
//   Place a wasm-bindgen build at /wasm/dsd_decoder_bg.wasm with
//   accompanying dsd_decoder.js (the wasm-bindgen JS glue).
//
//   The Rust crate is expected to expose:
//
//     #[wasm_bindgen]
//     pub fn decode_dsd_to_pcm(bytes: &[u8], target_rate: u32) -> Float32Array;
//
//   Built with Symphonia (https://crates.io/crates/symphonia) which
//   already supports DSD demuxing, plus a DSD→PCM SDM filter (e.g.
//   8th-order FIR low-pass at 24 kHz, decimation to 88.2/96 kHz).
//
//   Build: wasm-pack build --target web --release
//
// If the WASM module is absent, this bridge fails gracefully and
// the UI shows a clear "no decoder" message — the player remains
// fully functional for all natively-supported formats.
// ============================================================

const WASM_PATH = './wasm/dsd_decoder.js';

let wasmReady = null;     // promise once loading begins
let wasmModule = null;    // loaded module, or null if unavailable

async function loadWasm() {
  if (wasmReady) return wasmReady;
  wasmReady = (async () => {
    try {
      const mod = await import(WASM_PATH);
      // wasm-bindgen default export is the init function
      await mod.default();
      wasmModule = mod;
      return mod;
    } catch (e) {
      console.info('[wasm-bridge] DSD decoder not present:', e.message);
      return null;
    }
  })();
  return wasmReady;
}

export const wasmDecoder = {
  /**
   * Attempt to play a DSD file.
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async tryPlayDsd(file, audioCtx, destNode) {
    const mod = await loadWasm();
    if (!mod || typeof mod.decode_dsd_to_pcm !== 'function') {
      return { ok: false, reason: 'wasm-unavailable' };
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Decode to PCM at the AudioContext's native rate (no further resample)
      const pcm = mod.decode_dsd_to_pcm(bytes, audioCtx.sampleRate);
      // pcm layout: interleaved stereo Float32Array
      const channels = 2;
      const frames = pcm.length / channels;
      const buf = audioCtx.createBuffer(channels, frames, audioCtx.sampleRate);
      const l = buf.getChannelData(0);
      const r = buf.getChannelData(1);
      for (let i = 0, j = 0; i < frames; i++, j += 2) {
        l[i] = pcm[j];
        r[i] = pcm[j+1];
      }
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(destNode);
      src.start();
      // Note: caller is responsible for tracking this source for stop/pause.
      // For brevity in this build the DSD path is play-only; transport
      // controls will fall back to native engine on next track change.
      return { ok: true };
    } catch (e) {
      console.error('[wasm-bridge] DSD decode failed:', e);
      return { ok: false, reason: e.message };
    }
  },

  async available() {
    const mod = await loadWasm();
    return !!mod;
  },
};
