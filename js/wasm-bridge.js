// ============================================================
// wasm-bridge.js — loads signal_core.wasm and exposes typed
// functions, with graceful JS fallbacks if the WASM isn't built.
//
// Usage:
//   import { core } from './wasm-bridge.js';
//   await core.ready;
//   const meta = core.parseMetadata(bytes, ext, wantArt);
// ============================================================

let wasmModule = null;
let wasmStatus = 'loading';

const readyPromise = (async () => {
  try {
    // wasm-pack generates wasm/signal_core.js and wasm/signal_core_bg.wasm
    const mod = await import('../wasm/signal_core.js');
    // wasm-pack default export is an init() function that returns a promise
    if (typeof mod.default === 'function') {
      await mod.default();
    }
    wasmModule = mod;
    wasmStatus = 'ready';
    console.info('[signal_core]', mod.build_tag ? mod.build_tag() : 'loaded');
  } catch (e) {
    wasmStatus = 'unavailable';
    console.warn('[signal_core] WASM not loaded, falling back to JS:', e.message);
  }
})();

function take_picture() {
  if (!wasmModule || !wasmModule.take_last_picture) return new Uint8Array();
  return wasmModule.take_last_picture();
}

export const core = {
  ready: readyPromise,
  get status() { return wasmStatus; },
  get available() { return wasmStatus === 'ready'; },

  /**
   * Parse file headers. Returns {meta, artBytes} where artBytes is a Uint8Array
   * (empty if no art / wantArt=false / WASM unavailable).
   * On WASM failure, returns null and caller should use the JS path.
   */
  parseMetadata(bytes, ext, wantArt) {
    if (!wasmModule) return null;
    try {
      const meta = wasmModule.parse_metadata(bytes, ext, !!wantArt);
      const artBytes = wantArt && meta && meta.hasArt ? take_picture() : new Uint8Array();
      return { meta, artBytes };
    } catch (e) {
      console.warn('[signal_core] parse_metadata failed:', e);
      return null;
    }
  },

  /**
   * Compute DR value. samples is interleaved Float32Array.
   * Returns integer DR, or null if WASM unavailable.
   */
  computeDR(samples, sampleRate, channels) {
    if (!wasmModule) return null;
    try { return wasmModule.compute_dr(samples, sampleRate, channels); }
    catch (e) { console.warn('[signal_core] compute_dr failed:', e); return null; }
  },

  /**
   * Hi-res authenticity check. Returns verdict object or null.
   */
  analyzeHiRes(samples, sampleRate, channels, claimedRate, claimedBits) {
    if (!wasmModule) return null;
    try { return wasmModule.analyze_hi_res(samples, sampleRate, channels, claimedRate, claimedBits); }
    catch (e) { console.warn('[signal_core] analyze_hi_res failed:', e); return null; }
  },

  /**
   * THD+N measurement. Returns dB value or null.
   */
  measureThdN(samples, sampleRate, fundamentalHz) {
    if (!wasmModule) return null;
    try { return wasmModule.measure_thd_n(samples, sampleRate, fundamentalHz); }
    catch (e) { console.warn('[signal_core] measure_thd_n failed:', e); return null; }
  },

  /**
   * DSD → PCM. Returns interleaved Float32Array (empty on failure).
   */
  decodeDsdToPcm(bytes, targetRate) {
    if (!wasmModule) return null;
    try { return wasmModule.decode_dsd_to_pcm(bytes, targetRate); }
    catch (e) { console.warn('[signal_core] decode_dsd_to_pcm failed:', e); return null; }
  },
};
