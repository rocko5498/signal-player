//! Audio analysis: DR meter, hi-res authenticity, signal-path THD+N.
//!
//! All functions take interleaved or planar samples as `&[f32]`.
//! Channel layout is specified by the `channels` argument.

use wasm_bindgen::prelude::*;
use serde::Serialize;
use crate::fft::magnitude_spectrum;

/// Compute Dynamic Range using the TT DR Meter algorithm.
/// `samples` is interleaved (L,R,L,R,...). Returns an integer DR value.
///
/// Per channel:
///   1. Split into 3-second non-overlapping blocks
///   2. Compute RMS of each block
///   3. Sort RMS values descending, take top 20%
///   4. DR_channel = peak_dB - mean(top 20% RMS)_dB
/// Track DR = round(mean of channel DRs)
#[wasm_bindgen]
pub fn compute_dr(samples: &[f32], sample_rate: u32, channels: u32) -> i32 {
    if samples.is_empty() || channels == 0 || sample_rate == 0 { return 0; }
    let block_size = (3 * sample_rate) as usize;
    let ch_count = channels as usize;
    let frames = samples.len() / ch_count;
    if frames < block_size { return 0; }

    let mut channel_drs: Vec<f32> = Vec::with_capacity(ch_count);

    for ch in 0..ch_count {
        let mut peak = 0.0f32;
        // First pass: peak
        for f in 0..frames {
            let s = samples[f * ch_count + ch].abs();
            if s > peak { peak = s; }
        }
        let peak_db = to_db(peak);

        // Second pass: per-block RMS
        let mut blocks: Vec<f32> = Vec::with_capacity(frames / block_size);
        let mut b = 0;
        while b + block_size <= frames {
            let mut sum_sq = 0.0f64;
            for f in 0..block_size {
                let s = samples[(b + f) * ch_count + ch] as f64;
                sum_sq += s * s;
            }
            blocks.push((sum_sq / block_size as f64).sqrt() as f32);
            b += block_size;
        }
        if blocks.is_empty() { continue; }

        blocks.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        let top = (blocks.len() as f32 * 0.2).ceil() as usize;
        let top = top.max(1).min(blocks.len());
        let mean_top: f32 = blocks[..top].iter().sum::<f32>() / top as f32;
        let mean_top_db = to_db(mean_top);

        channel_drs.push(peak_db - mean_top_db);
    }

    if channel_drs.is_empty() { return 0; }
    let avg = channel_drs.iter().sum::<f32>() / channel_drs.len() as f32;
    avg.round() as i32
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HiResVerdict {
    pub verdict: String,           // "true" | "fake" | "cd" | "unknown"
    pub label: String,             // human-readable
    pub max_freq: f32,             // Hz
    pub effective_bits: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Analyze whether a file's claimed hi-res spec matches its actual content.
/// `samples` is interleaved; we only look at channel 0.
#[wasm_bindgen]
pub fn analyze_hi_res(
    samples: &[f32],
    sample_rate: u32,
    channels: u32,
    claimed_rate: u32,
    claimed_bits: u32,
) -> JsValue {
    let v = analyze_hi_res_inner(samples, sample_rate, channels, claimed_rate, claimed_bits);
    serde_wasm_bindgen::to_value(&v).unwrap_or(JsValue::NULL)
}

fn analyze_hi_res_inner(
    samples: &[f32],
    sample_rate: u32,
    channels: u32,
    claimed_rate: u32,
    claimed_bits: u32,
) -> HiResVerdict {
    let ch_count = channels.max(1) as usize;
    let frames = samples.len() / ch_count;
    if frames < 1024 {
        return HiResVerdict { verdict: "unknown".into(), label: "TOO SHORT".into(), ..Default::default() };
    }

    // Extract channel 0 as a contiguous Vec (FFT wants that)
    // De-interleave only the windows we need.
    const WIN: usize = 16384;
    if frames < WIN {
        return HiResVerdict { verdict: "unknown".into(), label: "TOO SHORT".into(), ..Default::default() };
    }

    let positions = [
        ((frames - WIN) as f32 * 0.25) as usize,
        ((frames - WIN) as f32 * 0.50) as usize,
        ((frames - WIN) as f32 * 0.75) as usize,
    ];

    let mut max_bin = 0usize;
    let nyquist = sample_rate as f32 / 2.0;
    let bins_per_window = WIN / 2;

    for &pos in &positions {
        let mut win = vec![0.0f32; WIN];
        for i in 0..WIN {
            win[i] = samples[(pos + i) * ch_count];
        }
        let mags = magnitude_spectrum(&win);

        // Noise floor = median of upper 10% of spectrum
        let tail_start = (mags.len() as f32 * 0.9) as usize;
        let mut tail: Vec<f32> = mags[tail_start..].to_vec();
        tail.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let noise_floor = tail.get(tail.len() / 2).copied().unwrap_or(1e-10).max(1e-10);
        let threshold = noise_floor * 31.6; // ~30 dB above floor

        // Sliding-band scan from top — find highest freq with sustained energy
        const BAND: usize = 32;
        if mags.len() < BAND { continue; }
        for i in (0..=mags.len() - BAND).rev() {
            let mut sum = 0.0f32;
            for j in 0..BAND { sum += mags[i + j]; }
            if sum / (BAND as f32) > threshold {
                let edge = i + BAND;
                if edge > max_bin { max_bin = edge; }
                break;
            }
        }
    }
    let max_freq = (max_bin as f32 / bins_per_window as f32) * nyquist;

    // Effective bit depth check (only when 24-bit is claimed)
    let mut effective_bits = claimed_bits;
    if claimed_bits >= 24 {
        let sample_count = (samples.len() / ch_count).min(100_000);
        let mut bucket_seen = [false; 256];
        let mut bucket_count = 0u32;
        for f in 0..sample_count {
            let s = samples[f * ch_count];
            let int24 = (s * 8388607.0).round() as i32;
            let lsb = (int24 & 0xff) as usize;
            if !bucket_seen[lsb] {
                bucket_seen[lsb] = true;
                bucket_count += 1;
                if bucket_count >= 200 { break; } // already plenty of variation
            }
        }
        if bucket_count < 16 {
            effective_bits = 16;
        } else if bucket_count < 64 {
            effective_bits = 20;
        }
    }

    let claims_hi_res = claimed_rate >= 48_000 || claimed_bits >= 24;
    if !claims_hi_res {
        return HiResVerdict {
            verdict: "cd".into(), label: "CD".into(),
            max_freq, effective_bits, reason: None,
        };
    }

    if claimed_rate >= 48_000 && max_freq < 22_000.0 {
        return HiResVerdict {
            verdict: "fake".into(),
            label: "UPSAMPLED".into(),
            max_freq, effective_bits,
            reason: Some(format!(
                "Claims {:.1} kHz but content ends at {:.1} kHz",
                claimed_rate as f32 / 1000.0,
                max_freq / 1000.0,
            )),
        };
    }
    if claimed_bits >= 24 && effective_bits < 20 {
        return HiResVerdict {
            verdict: "fake".into(),
            label: "BIT-PADDED".into(),
            max_freq, effective_bits,
            reason: Some(format!(
                "Claims {}-bit but effective ≈ {}-bit",
                claimed_bits, effective_bits,
            )),
        };
    }
    HiResVerdict {
        verdict: "true".into(),
        label: "TRUE HI-RES".into(),
        max_freq, effective_bits, reason: None,
    }
}

/// Measure THD+N from a captured signal containing a known tone.
/// Returns the THD+N ratio in dB (more negative = cleaner).
#[wasm_bindgen]
pub fn measure_thd_n(samples: &[f32], sample_rate: u32, fundamental_hz: f32) -> f32 {
    if samples.is_empty() || sample_rate == 0 { return 0.0; }

    // Pad/trim to nearest power of 2
    let mut n = 1usize;
    while n < samples.len() { n <<= 1; }
    n >>= 1; // largest power of 2 that fits
    if n < 1024 { return 0.0; }

    let mags = magnitude_spectrum(&samples[..n]);

    let bin_hz = sample_rate as f32 / n as f32;
    let fund_bin = (fundamental_hz / bin_hz).round() as usize;
    if fund_bin >= mags.len() { return 0.0; }

    // Fundamental energy: max in ±3 bins
    let lo = fund_bin.saturating_sub(3);
    let hi = (fund_bin + 3).min(mags.len() - 1);
    let mut fund_amp = 0.0f32;
    for i in lo..=hi {
        if mags[i] > fund_amp { fund_amp = mags[i]; }
    }
    if fund_amp <= 0.0 { return 0.0; }

    // Noise + distortion: everything outside fundamental ±15 bins (and not DC).
    // The wide exclusion is necessary because Hann windowing spreads fundamental
    // energy into adjacent bins. Without this, even a perfectly clean sine
    // shows ~-50 dB THD+N from window leakage alone.
    const EXCL: usize = 15;
    let mut n_power = 0.0f64;
    for i in EXCL..mags.len() - EXCL {
        if i >= fund_bin.saturating_sub(EXCL) && i <= fund_bin + EXCL { continue; }
        let v = mags[i] as f64;
        n_power += v * v;
    }
    let n_amp = n_power.sqrt() as f32;
    let ratio = n_amp / fund_amp;
    if ratio <= 0.0 { -120.0 } else { 20.0 * ratio.log10() }
}

fn to_db(linear: f32) -> f32 {
    if linear <= 1e-10 { -120.0 } else { 20.0 * linear.log10() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_sine(freq: f32, sr: u32, duration_s: f32, amp: f32, channels: usize) -> Vec<f32> {
        let n = (sr as f32 * duration_s) as usize;
        let mut out = Vec::with_capacity(n * channels);
        for i in 0..n {
            let v = amp * (2.0 * std::f32::consts::PI * freq * (i as f32) / (sr as f32)).sin();
            for _ in 0..channels { out.push(v); }
        }
        out
    }

    #[test]
    fn dr_of_pure_sine() {
        let s = make_sine(1000.0, 48000, 10.0, 0.7, 2);
        let dr = compute_dr(&s, 48000, 2);
        // Pure sine: peak = 0.7, RMS = 0.7/√2 ≈ 0.495, DR ≈ 20log10(0.7/0.495) ≈ 3
        assert!((dr - 3).abs() <= 1, "expected DR≈3, got {}", dr);
    }

    #[test]
    fn hi_res_band_limited_is_flagged() {
        // 14kHz tone in a "96kHz/24bit" container — should be flagged as UPSAMPLED
        let s = make_sine(14000.0, 96000, 2.0, 0.5, 1);
        let v = analyze_hi_res_inner(&s, 96000, 1, 96000, 24);
        assert_eq!(v.verdict, "fake");
    }

    #[test]
    fn hi_res_true_content_passes() {
        // 35 kHz tone in 96/24 — that's real hi-res
        let s = make_sine(35000.0, 96000, 2.0, 0.5, 1);
        let v = analyze_hi_res_inner(&s, 96000, 1, 96000, 24);
        assert_eq!(v.verdict, "true");
    }

    #[test]
    fn thd_n_of_clean_sine_is_low() {
        let s = make_sine(1000.0, 48000, 1.0, 0.7, 1);
        let thd = measure_thd_n(&s, 48000, 1000.0);
        assert!(thd < -60.0, "expected clean signal, got {} dB", thd);
    }
}
