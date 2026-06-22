// ============================================================
// metadata-worker.js — runs metadata parsing off main thread.
//
// Tries Rust/WASM first (5-10x faster). Falls back to pure JS
// if WASM isn't available (during first load before built, or
// in incompatible browsers).
//
// Each worker has its own WASM instance.
// ============================================================

import { sniffMetadata } from './metadata-core.js';

// --- Try to load the Rust core ---
let wasmReady = false;
let wasmModule = null;

(async () => {
  try {
    const mod = await import('../wasm/signal_core.js');
    if (typeof mod.default === 'function') await mod.default();
    wasmModule = mod;
    wasmReady = true;
  } catch {
    // No WASM in this worker → JS fallback
    wasmReady = false;
  }
})();

self.onmessage = async (e) => {
  const { id, file, wantArt } = e.data;
  try {
    const ext = file.name.split('.').pop().toLowerCase();

    // Read header bytes from the file
    const headSize = Math.min(file.size, wantArt ? 1024 * 1024 : 256 * 1024);
    const headBuf = await file.slice(0, headSize).arrayBuffer();
    const headBytes = new Uint8Array(headBuf);

    let meta = null;
    let artBlob = null;

    // --- WASM path ---
    if (wasmReady && wasmModule && wasmModule.parse_metadata) {
      try {
        meta = wasmModule.parse_metadata(headBytes, ext, !!wantArt);
        // After parse, retrieve any embedded art bytes
        if (wantArt && meta && meta.hasArt && wasmModule.take_last_picture) {
          const picBytes = wasmModule.take_last_picture();
          if (picBytes && picBytes.length > 0) {
            artBlob = new Blob([picBytes], { type: meta.pictureMime || 'image/jpeg' });
          }
        }
      } catch (err) {
        // WASM call failed — fall through to JS
        meta = null;
      }
    }

    // --- JS fallback path ---
    if (!meta) {
      const jsResult = await sniffMetadata(file, ext, { wantArt: !!wantArt });
      meta = jsResult;
      if (meta.picture && meta.picture.data) {
        artBlob = new Blob([meta.picture.data], { type: meta.picture.mime });
        delete meta.picture;
        meta.hasArt = true;
      } else if (meta.picture === null || meta.picture === undefined) {
        delete meta.picture;
      }
    }

    self.postMessage({ id, meta, artBlob });
  } catch (err) {
    self.postMessage({ id, meta: { error: String(err) }, artBlob: null });
  }
};
