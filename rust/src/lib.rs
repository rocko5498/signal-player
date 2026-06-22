//! SIGNAL — Rust core

#![allow(clippy::needless_range_loop)]

use wasm_bindgen::prelude::*;

mod metadata;
mod analysis;
mod fft;
mod dsd;

pub use metadata::parse_metadata;
pub use analysis::{compute_dr, analyze_hi_res, measure_thd_n};
pub use dsd::decode_dsd_to_pcm;

#[wasm_bindgen]
pub fn build_tag() -> String {
    format!("signal_core v{} ({})", env!("CARGO_PKG_VERSION"), env!("CARGO_PKG_NAME"))
}