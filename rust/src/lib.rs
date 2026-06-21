//! SIGNAL — Rust core
//!
//! Compiled to wasm32-unknown-unknown via wasm-pack. Exposes:
//!   - `parse_metadata(bytes, ext)` → JSON metadata object
//!   - `compute_dr(samples, sample_rate, channels)` → integer DR value
//!   - `analyze_hi_res(samples, sample_rate, claimed_rate, claimed_bits)` → verdict object
//!   - `measure_thd_n(samples, sample_rate, fundamental_hz)` → THD+N in dB
//!   - `decode_dsd_to_pcm(bytes, target_rate)` → interleaved f32 samples
//!
//! All functions are pure and stateless. No globals, no allocations across calls.

#![allow(clippy::needless_range_loop)]

use wasm_bindgen::prelude::*;

mod metadata;
mod analysis;
mod fft;
mod dsd;

// Re-exported for JS
pub use metadata::parse_metadata;
pub use analysis::{compute_dr, analyze_hi_res, measure_thd_n};
pub use dsd::decode_dsd_to_pcm;

/// Initialisation. Called automatically by wasm-bindgen on module load.
/// We install a panic hook so Rust panics surface in the browser console
/// rather than disappearing silently.
#[wasm_bindgen(start)]
pub fn _init() {
    std::panic::set_hook(Box::new(|info| {
        // Best-effort logging via js console
        let msg = format!("[signal_core panic] {info}");
        web_log(&msg);
    }));
}

/// Build tag — JS can query this to confirm the WASM is the version it expects.
#[wasm_bindgen]
pub fn build_tag() -> String {
    format!("signal_core v{} ({})", env!("CARGO_PKG_VERSION"), env!("CARGO_PKG_NAME"))
}

// Tiny console.log shim that doesn't pull in all of web-sys
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn web_log(s: &str);
}
