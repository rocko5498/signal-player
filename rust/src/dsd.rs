//! DSD to PCM conversion.
//!
//! Self-contained DSF demuxer (no Symphonia dependency) + 127-tap windowed-sinc
//! lowpass filter + integer decimation.
//!
//! DSF spec: https://dsd-guide.com/sites/default/files/white-papers/DSFFileFormatSpec_E.pdf
//!
//! Output is interleaved stereo f32 in [-1.0, 1.0].

use wasm_bindgen::prelude::*;

/// Decode a DSF file's bytes to PCM at the target sample rate.
/// Returns interleaved f32 samples (L,R,L,R,...).
/// Returns an empty Vec on any error (the JS side then falls back).
#[wasm_bindgen]
pub fn decode_dsd_to_pcm(bytes: &[u8], target_rate: u32) -> Vec<f32> {
    match decode_dsf(bytes, target_rate) {
        Ok(v) => v,
        Err(_) => Vec::new(),
    }
}

#[derive(Debug)]
struct DsfHeader {
    channels: u32,
    sample_rate: u32,          // DSD bit rate (e.g. 2,822,400)
    bits_per_sample: u32,      // 1 or 8
    sample_count: u64,         // per channel
    block_size: u32,           // typically 4096
    data_offset: u64,          // start of audio payload
    data_size: u64,            // bytes of audio
}

fn parse_dsf_header(b: &[u8]) -> Result<DsfHeader, String> {
    if b.len() < 92 { return Err("file too small".into()); }
    if &b[0..4] != b"DSD " { return Err("no DSD magic".into()); }

    // DSD chunk (28 bytes): size=28, total_size=u64, metadata_offset=u64
    // Then fmt chunk starting at byte 28
    let p = 28;
    if &b[p..p+4] != b"fmt " { return Err("no fmt chunk".into()); }
    // chunk_size at p+4 (u64), format version at p+12, etc.
    let format_version = read_u32_le(b, p+12);
    if format_version != 1 { return Err(format!("unsupported DSF version {format_version}")); }
    let channel_type     = read_u32_le(b, p+20);
    let channels         = read_u32_le(b, p+24);
    let sample_rate      = read_u32_le(b, p+28);
    let bits_per_sample  = read_u32_le(b, p+32);
    let sample_count     = read_u64_le(b, p+36);
    let block_size       = read_u32_le(b, p+44);

    let _ = channel_type; // 1=mono, 2=stereo, 3=stereo, 4=quad, ...

    // The data chunk follows at byte 80
    let data_pos = 80;
    if data_pos + 12 > b.len() { return Err("no data chunk".into()); }
    if &b[data_pos..data_pos+4] != b"data" {
        return Err(format!("expected 'data' chunk at offset {data_pos}"));
    }
    let data_size_raw = read_u64_le(b, data_pos+4);
    // data_size includes the 12-byte chunk header
    let data_size = data_size_raw.saturating_sub(12);
    let data_offset = (data_pos + 12) as u64;

    Ok(DsfHeader {
        channels, sample_rate, bits_per_sample, sample_count, block_size,
        data_offset, data_size,
    })
}

fn decode_dsf(b: &[u8], target_rate: u32) -> Result<Vec<f32>, String> {
    let h = parse_dsf_header(b)?;
    if h.channels < 1 || h.channels > 8 { return Err(format!("bad channels: {}", h.channels)); }
    if h.bits_per_sample != 1 && h.bits_per_sample != 8 {
        return Err(format!("bad bits_per_sample: {}", h.bits_per_sample));
    }
    if h.block_size == 0 { return Err("zero block size".into()); }
    if target_rate == 0 { return Err("zero target rate".into()); }

    let decim = (h.sample_rate / target_rate).max(1) as usize;
    let taps = generate_lowpass_taps(127, target_rate, h.sample_rate);

    // Per-channel filter state
    let ch_count = h.channels as usize;
    let mut filters: Vec<ChannelFilter> = (0..ch_count)
        .map(|_| ChannelFilter::new(&taps, decim))
        .collect();

    // Estimate output size: bits per channel / decim
    let bits_per_ch = h.sample_count;
    let approx_out_frames = (bits_per_ch as usize) / decim.max(1);
    let mut out: Vec<f32> = Vec::with_capacity(approx_out_frames * 2);

    // DSF data layout:
    //   Interleaved blocks of `block_size` bytes per channel.
    //   For 2-channel stereo: [block_L][block_R][block_L][block_R]...
    //   Within a block, bytes are samples; bits within a byte are LSB-first
    //   (per DSF spec — careful: DFF is MSB-first, DSF is LSB-first).
    let data_start = h.data_offset as usize;
    let data_end = (data_start + h.data_size as usize).min(b.len());
    let bs = h.block_size as usize;

    let mut pos = data_start;
    let mut samples_emitted_per_ch = 0u64;
    let max_samples = h.sample_count;

    while pos + bs * ch_count <= data_end {
        for byte_in_block in 0..bs {
            if samples_emitted_per_ch + 8 > max_samples { break; }
            // Each channel contributes 8 bits at this byte offset
            // Output: pairs of stereo samples
            for bit_in_byte in 0..8 {
                let mut sample_results: Vec<Option<f32>> = Vec::with_capacity(ch_count);
                for ch in 0..ch_count {
                    let byte = b[pos + ch * bs + byte_in_block];
                    // DSF: LSB first
                    let bit = (byte >> bit_in_byte) & 1;
                    let v = if bit == 1 { 1.0f32 } else { -1.0 };
                    sample_results.push(filters[ch].feed(v));
                }
                // Emit when filter produces (all channels in lockstep)
                if let Some(l) = sample_results[0] {
                    let r = if ch_count > 1 { sample_results[1].unwrap_or(l) } else { l };
                    out.push(l.clamp(-1.0, 1.0));
                    out.push(r.clamp(-1.0, 1.0));
                }
            }
            samples_emitted_per_ch += 8;
        }
        pos += bs * ch_count;
    }

    Ok(out)
}

// ---------- helpers ----------
#[inline]
fn read_u32_le(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off+1], b[off+2], b[off+3]])
}
#[inline]
fn read_u64_le(b: &[u8], off: usize) -> u64 {
    let lo = read_u32_le(b, off) as u64;
    let hi = read_u32_le(b, off+4) as u64;
    (hi << 32) | lo
}

/// Generate a windowed-sinc low-pass filter.
/// `n` taps (forced to odd), cutoff ~0.4 of target Nyquist relative to source rate.
fn generate_lowpass_taps(n: usize, target_rate: u32, src_rate: u32) -> Vec<f32> {
    let n = if n % 2 == 0 { n + 1 } else { n };
    let mid = (n / 2) as i32;
    let cutoff = (target_rate as f32 * 0.4) / (src_rate as f32);
    let mut taps = vec![0.0f32; n];
    let mut sum = 0.0f32;
    for i in 0..n {
        let k = i as i32 - mid;
        let s = if k == 0 {
            2.0 * cutoff
        } else {
            let x = 2.0 * std::f32::consts::PI * cutoff * (k as f32);
            x.sin() / (std::f32::consts::PI * (k as f32))
        };
        let w = 0.54 - 0.46 * (2.0 * std::f32::consts::PI * (i as f32) / ((n - 1) as f32)).cos();
        taps[i] = s * w;
        sum += taps[i];
    }
    if sum > 0.0 {
        for t in &mut taps { *t /= sum; }
    }
    taps
}

struct ChannelFilter {
    taps: Vec<f32>,
    delay: Vec<f32>,
    head: usize,
    decim: usize,
    count: usize,
}
impl ChannelFilter {
    fn new(taps: &[f32], decim: usize) -> Self {
        Self {
            taps: taps.to_vec(),
            delay: vec![0.0; taps.len()],
            head: 0,
            decim,
            count: 0,
        }
    }
    fn feed(&mut self, x: f32) -> Option<f32> {
        let n = self.taps.len();
        self.delay[self.head] = x;
        self.head = (self.head + 1) % n;
        self.count += 1;
        if self.count % self.decim != 0 { return None; }
        let mut acc = 0.0f32;
        let mut idx = self.head;
        for &t in &self.taps {
            acc += t * self.delay[idx];
            idx = (idx + 1) % n;
        }
        Some(acc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsf_header_minimal() {
        // Build a minimal DSF: DSD chunk (28) + fmt chunk (52) + data chunk header (12) + tiny payload
        let mut b = Vec::new();
        b.extend_from_slice(b"DSD ");
        b.extend_from_slice(&28u64.to_le_bytes());
        b.extend_from_slice(&100u64.to_le_bytes()); // total_size
        b.extend_from_slice(&0u64.to_le_bytes());   // metadata offset

        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&52u64.to_le_bytes());   // chunk size
        b.extend_from_slice(&1u32.to_le_bytes());    // format version
        b.extend_from_slice(&0u32.to_le_bytes());    // format id (DSD raw)
        b.extend_from_slice(&2u32.to_le_bytes());    // channel type (stereo)
        b.extend_from_slice(&2u32.to_le_bytes());    // channels
        b.extend_from_slice(&2_822_400u32.to_le_bytes()); // SR (DSD64)
        b.extend_from_slice(&1u32.to_le_bytes());    // bits per sample
        b.extend_from_slice(&0u64.to_le_bytes());    // sample count
        b.extend_from_slice(&4096u32.to_le_bytes()); // block size
        b.extend_from_slice(&0u32.to_le_bytes());    // reserved

        b.extend_from_slice(b"data");
        b.extend_from_slice(&12u64.to_le_bytes());   // data size

        let h = parse_dsf_header(&b).expect("parse should succeed");
        assert_eq!(h.channels, 2);
        assert_eq!(h.sample_rate, 2_822_400);
        assert_eq!(h.bits_per_sample, 1);
        assert_eq!(h.block_size, 4096);
    }
}
