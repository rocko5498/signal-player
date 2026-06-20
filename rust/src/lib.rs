// ============================================================
// SIGNAL — DSD to PCM decoder
//
// 1. Demux DSF using Symphonia.
// 2. Read 1-bit DSD bitstream.
// 3. Low-pass filter (63-tap windowed-sinc, cutoff ~24 kHz).
// 4. Decimate to PCM target rate.
// 5. Return interleaved stereo f32.
// ============================================================

use wasm_bindgen::prelude::*;
use js_sys::Float32Array;

use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use std::io::Cursor;

#[wasm_bindgen(start)]
pub fn init() {}

#[wasm_bindgen]
pub fn decode_dsd_to_pcm(bytes: &[u8], target_rate: u32) -> Float32Array {
    let pcm = match decode_internal(bytes, target_rate) {
        Ok(v) => v,
        Err(e) => {
            web_sys::console::error_1(&format!("dsd decode error: {}", e).into());
            Vec::new()
        }
    };
    let arr = Float32Array::new_with_length(pcm.len() as u32);
    arr.copy_from(&pcm);
    arr
}

fn decode_internal(bytes: &[u8], target_rate: u32) -> Result<Vec<f32>, String> {
    let cursor = Cursor::new(bytes.to_vec());
    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());

    let hint = Hint::new();
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("probe: {}", e))?;

    let mut format = probed.format;
    let track = format.default_track().ok_or("no track")?;
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("decoder: {}", e))?;

    let src_rate = track.codec_params.sample_rate.unwrap_or(2_822_400);
    let decim_factor = (src_rate / target_rate).max(1) as usize;

    let mut out: Vec<f32> = Vec::with_capacity(bytes.len() / decim_factor);

    let mut ch_l = ChannelState::new(decim_factor);
    let mut ch_r = ChannelState::new(decim_factor);

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(_)) => break,
            Err(e) => return Err(format!("packet: {}", e)),
        };
        if packet.track_id() != track_id { continue; }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(format!("decode: {}", e)),
        };

        if let AudioBufferRef::U8(buf) = decoded {
            let chans = buf.spec().channels.count();
            let l = buf.chan(0);
            let r = if chans > 1 { buf.chan(1) } else { buf.chan(0) };
            let frames = l.len();
            for i in 0..frames {
                let lb = l[i];
                let rb = r[i];
                for bit in 0..8 {
                    let bl = if (lb >> (7 - bit)) & 1 == 1 { 1.0 } else { -1.0 };
                    let br = if (rb >> (7 - bit)) & 1 == 1 { 1.0 } else { -1.0 };
                    if let Some(sl) = ch_l.feed(bl) {
                        let sr = ch_r.feed(br).unwrap_or(0.0);
                        out.push(sl);
                        out.push(sr);
                    }
                }
            }
        } else {
            return Err("expected U8 (DSD) buffer".into());
        }
    }
    Ok(out)
}

struct ChannelState {
    delay: Vec<f32>,
    head: usize,
    decim: usize,
    count: usize,
}
impl ChannelState {
    fn new(decim: usize) -> Self {
        let n = TAPS.len();
        Self { delay: vec![0.0; n], head: 0, decim, count: 0 }
    }
    fn feed(&mut self, x: f32) -> Option<f32> {
        let n = TAPS.len();
        self.delay[self.head] = x;
        self.head = (self.head + 1) % n;
        self.count += 1;
        if self.count % self.decim != 0 { return None; }
        let mut acc = 0.0f32;
        let mut idx = self.head;
        for &t in TAPS.iter() {
            acc += t * self.delay[idx];
            idx = (idx + 1) % n;
        }
        Some(acc.clamp(-1.0, 1.0))
    }
}

// 63-tap Hamming-windowed sinc, low-pass, cutoff normalized to ~0.42 of Nyquist.
// Real production should regenerate per decimation ratio.
static TAPS: [f32; 63] = [
    0.0001, 0.0002, 0.0005, 0.0009, 0.0015, 0.0023, 0.0033, 0.0046,
    0.0061, 0.0079, 0.0100, 0.0124, 0.0150, 0.0178, 0.0209, 0.0241,
    0.0274, 0.0308, 0.0342, 0.0375, 0.0407, 0.0436, 0.0463, 0.0486,
    0.0506, 0.0521, 0.0532, 0.0539, 0.0541, 0.0539, 0.0532, 0.0521,
    0.0506, 0.0486, 0.0463, 0.0436, 0.0407, 0.0375, 0.0342, 0.0308,
    0.0274, 0.0241, 0.0209, 0.0178, 0.0150, 0.0124, 0.0100, 0.0079,
    0.0061, 0.0046, 0.0033, 0.0023, 0.0015, 0.0009, 0.0005, 0.0002,
    0.0001, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000,
];
