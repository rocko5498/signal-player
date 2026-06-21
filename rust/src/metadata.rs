//! Binary metadata parsing for FLAC, WAV, AIFF, DSF, DFF, MP4.
//!
//! Each parser takes a header slice and returns a `Metadata` struct.
//! We do not read entire files; the JS caller passes the first 256 KB
//! (or 1 MB if wanting embedded art).

use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub format: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub sample_rate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")] pub bit_depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")] pub channels: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")] pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub is_dsd: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub dsd_rate: Option<u32>,

    // Tags
    #[serde(skip_serializing_if = "Option::is_none")] pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub album_artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub year: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub original_year: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub track_no: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")] pub disc_no: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")] pub genre: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub encoder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub mastering_engineer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub producer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub mixer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub rg_track_gain: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")] pub rg_album_gain: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")] pub mb_album_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub mb_track_id: Option<String>,

    // Picture: returned separately as a Vec<u8> if wantArt is set
    #[serde(skip_serializing_if = "Option::is_none")] pub picture_mime: Option<String>,
    #[serde(skip)] pub picture_data: Option<Vec<u8>>,

    pub has_art: bool,

    #[serde(skip_serializing_if = "Option::is_none")] pub error: Option<String>,
}

/// Parse audio file headers. `bytes` is the first 256 KB (or 1 MB).
/// `ext` is the file extension (lowercase, no dot).
/// `want_art` controls whether embedded pictures are extracted.
///
/// Returns a JS object. Picture bytes (if extracted) come back via
/// `take_last_picture()` immediately after — this avoids serialising
/// megabyte-sized binary data through serde_json.
#[wasm_bindgen]
pub fn parse_metadata(bytes: &[u8], ext: &str, want_art: bool) -> JsValue {
    let m = match ext {
        "flac"                       => parse_flac(bytes, want_art),
        "wav" | "wave"               => parse_wav(bytes),
        "aif" | "aiff" | "aifc"      => parse_aiff(bytes),
        "dsf"                        => parse_dsf(bytes),
        "dff" | "dsd"                => parse_dff(bytes),
        "mp4" | "m4a" | "alac"       => parse_mp4(bytes),
        "mp3"                        => Metadata { format: "MP3".into(),  ..Default::default() },
        "ogg" | "oga"                => Metadata { format: "OGG".into(),  ..Default::default() },
        "opus"                       => Metadata { format: "OPUS".into(), sample_rate: Some(48000), ..Default::default() },
        "ape"                        => Metadata { format: "APE".into(),  ..Default::default() },
        "wv"                         => Metadata { format: "WAVPACK".into(), ..Default::default() },
        _                            => Metadata { format: ext.to_uppercase(), ..Default::default() },
    };

    // Stash any picture bytes for retrieval via take_last_picture()
    PICTURE_BUFFER.with(|p| *p.borrow_mut() = m.picture_data.clone());

    let mut clean = m;
    clean.picture_data = None;
    serde_wasm_bindgen::to_value(&clean).unwrap_or(JsValue::NULL)
}

/// Retrieve picture bytes from the last parse_metadata call.
/// Returns an empty Vec if no picture was found.
#[wasm_bindgen]
pub fn take_last_picture() -> Vec<u8> {
    PICTURE_BUFFER.with(|p| p.borrow_mut().take().unwrap_or_default())
}

thread_local! {
    static PICTURE_BUFFER: std::cell::RefCell<Option<Vec<u8>>> = const { std::cell::RefCell::new(None) };
}

// ============================================================
// FLAC
// ============================================================
fn parse_flac(b: &[u8], want_art: bool) -> Metadata {
    let mut m = Metadata { format: "FLAC".into(), ..Default::default() };

    if b.len() < 42 || &b[0..4] != b"fLaC" {
        m.error = Some("no fLaC magic".into());
        return m;
    }

    // First metadata block must be STREAMINFO (type 0)
    let block_type = b[4] & 0x7f;
    if block_type != 0 {
        m.error = Some("first block not STREAMINFO".into());
        return m;
    }

    let off = 4 + 4 + 10; // after fLaC, after block header, skip min/max block/frame sizes
    let b0 = b[off];
    let b1 = b[off + 1];
    let b2 = b[off + 2];
    let b3 = b[off + 3];

    let sample_rate = ((b0 as u32) << 12) | ((b1 as u32) << 4) | ((b2 as u32) >> 4);
    let channels    = ((b2 as u32 >> 1) & 0x07) + 1;
    let bit_depth   = ((((b2 as u32) & 1) << 4) | ((b3 as u32) >> 4)) + 1;

    let ts_high = (b3 & 0x0f) as u64;
    let ts_low  = u32::from_be_bytes([b[off + 4], b[off + 5], b[off + 6], b[off + 7]]) as u64;
    let total_samples = (ts_high << 32) | ts_low;
    let duration = if sample_rate > 0 { Some(total_samples as f64 / sample_rate as f64) } else { None };

    m.sample_rate = Some(sample_rate);
    m.channels = Some(channels);
    m.bit_depth = Some(bit_depth);
    m.duration = duration;

    // Walk remaining blocks for VORBIS_COMMENT (4) and PICTURE (6)
    let mut p = 4;
    loop {
        if p + 4 > b.len() { break; }
        let h = u32::from_be_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]);
        let is_last = (h & 0x8000_0000) != 0;
        let block_type = ((h >> 24) & 0x7f) as u8;
        let len = (h & 0x00ff_ffff) as usize;
        p += 4;
        if p + len > b.len() { break; }

        match block_type {
            4 => parse_vorbis_comment(&b[p..p + len], &mut m),
            6 if want_art => parse_flac_picture(&b[p..p + len], &mut m),
            _ => {}
        }
        p += len;
        if is_last { break; }
    }

    m.has_art = m.picture_data.is_some();
    m
}

fn parse_vorbis_comment(blob: &[u8], m: &mut Metadata) {
    if blob.len() < 4 { return; }
    let vendor_len = u32::from_le_bytes([blob[0], blob[1], blob[2], blob[3]]) as usize;
    let mut q = 4 + vendor_len;
    if q + 4 > blob.len() { return; }
    let cnt = u32::from_le_bytes([blob[q], blob[q + 1], blob[q + 2], blob[q + 3]]) as usize;
    q += 4;
    for _ in 0..cnt {
        if q + 4 > blob.len() { return; }
        let l = u32::from_le_bytes([blob[q], blob[q + 1], blob[q + 2], blob[q + 3]]) as usize;
        q += 4;
        if q + l > blob.len() { return; }
        let s = std::str::from_utf8(&blob[q..q + l]).unwrap_or("");
        q += l;
        if let Some(eq) = s.find('=') {
            let (key, val) = s.split_at(eq);
            let val = &val[1..]; // skip the =
            assign_tag(key.to_lowercase().as_str(), val, m);
        }
    }
}

fn assign_tag(key: &str, val: &str, m: &mut Metadata) {
    let v = val.to_string();
    match key {
        "title"            => m.title = Some(v),
        "artist"           => m.artist = Some(v),
        "album"            => m.album = Some(v),
        "albumartist"      => m.album_artist = Some(v),
        "date" | "year"    => m.year = Some(v),
        "originaldate" | "original_year" => m.original_year = Some(v),
        "tracknumber"      => m.track_no = v.parse().ok(),
        "discnumber"       => m.disc_no = v.parse().ok(),
        "genre"            => m.genre = Some(v),
        "encoder"          => m.encoder = Some(v),
        "mastering_engineer" | "masteringengineer" => m.mastering_engineer = Some(v),
        "producer"         => m.producer = Some(v),
        "mixer"            => m.mixer = Some(v),
        "replaygain_track_gain" => m.rg_track_gain = parse_rg(val),
        "replaygain_album_gain" => m.rg_album_gain = parse_rg(val),
        "musicbrainz_albumid"   => m.mb_album_id = Some(v),
        "musicbrainz_trackid"   => m.mb_track_id = Some(v),
        _ => {}
    }
}

fn parse_rg(s: &str) -> Option<f32> {
    // ReplayGain values look like "-7.34 dB"
    s.split_whitespace().next()?.parse().ok()
}

fn parse_flac_picture(blob: &[u8], m: &mut Metadata) {
    if blob.len() < 32 { return; }
    let pic_type = u32::from_be_bytes([blob[0], blob[1], blob[2], blob[3]]);
    let mime_len = u32::from_be_bytes([blob[4], blob[5], blob[6], blob[7]]) as usize;
    let mut q = 8;
    if q + mime_len > blob.len() { return; }
    let mime = std::str::from_utf8(&blob[q..q + mime_len]).unwrap_or("image/jpeg").to_string();
    q += mime_len;
    if q + 4 > blob.len() { return; }
    let desc_len = u32::from_be_bytes([blob[q], blob[q + 1], blob[q + 2], blob[q + 3]]) as usize;
    q += 4 + desc_len;
    q += 16; // width/height/depth/colors, 4 u32s
    if q + 4 > blob.len() { return; }
    let data_len = u32::from_be_bytes([blob[q], blob[q + 1], blob[q + 2], blob[q + 3]]) as usize;
    q += 4;
    if q + data_len > blob.len() { return; }
    // Prefer "front cover" (type 3); otherwise take any
    if pic_type == 3 || m.picture_data.is_none() {
        m.picture_mime = Some(mime);
        m.picture_data = Some(blob[q..q + data_len].to_vec());
    }
}

// ============================================================
// WAV
// ============================================================
fn parse_wav(b: &[u8]) -> Metadata {
    let mut m = Metadata { format: "WAV".into(), ..Default::default() };
    if b.len() < 44 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        m.error = Some("no RIFF/WAVE".into());
        return m;
    }
    let mut p = 12;
    let mut byte_rate = 1u32;
    let mut data_len = 0u32;
    while p + 8 <= b.len() {
        let id = &b[p..p + 4];
        let len = u32::from_le_bytes([b[p + 4], b[p + 5], b[p + 6], b[p + 7]]) as usize;
        p += 8;
        if id == b"fmt " && p + 16 <= b.len() {
            let format = u16::from_le_bytes([b[p], b[p + 1]]);
            m.channels = Some(u16::from_le_bytes([b[p + 2], b[p + 3]]) as u32);
            m.sample_rate = Some(u32::from_le_bytes([b[p + 4], b[p + 5], b[p + 6], b[p + 7]]));
            byte_rate = u32::from_le_bytes([b[p + 8], b[p + 9], b[p + 10], b[p + 11]]);
            m.bit_depth = Some(u16::from_le_bytes([b[p + 14], b[p + 15]]) as u32);
            m.format = match format {
                3      => "WAV·float".into(),
                0xfffe => "WAV·ext".into(),
                _      => "WAV·PCM".into(),
            };
        } else if id == b"data" {
            data_len = len as u32;
            break;
        }
        let step = len + (len & 1); // pad
        if p + step > b.len() { break; }
        p += step;
    }
    if byte_rate > 0 { m.duration = Some(data_len as f64 / byte_rate as f64); }
    m
}

// ============================================================
// AIFF / AIFC
// ============================================================
fn parse_aiff(b: &[u8]) -> Metadata {
    let mut m = Metadata { format: "AIFF".into(), ..Default::default() };
    if b.len() < 12 || &b[0..4] != b"FORM" {
        m.error = Some("no FORM".into());
        return m;
    }
    let aifc = &b[8..12] == b"AIFC";
    if aifc { m.format = "AIFC".into(); }
    let mut p = 12;
    while p + 8 <= b.len() {
        let id = &b[p..p + 4];
        let len = u32::from_be_bytes([b[p + 4], b[p + 5], b[p + 6], b[p + 7]]) as usize;
        p += 8;
        if id == b"COMM" && p + 18 <= b.len() {
            m.channels = Some(u16::from_be_bytes([b[p], b[p + 1]]) as u32);
            let num_frames = u32::from_be_bytes([b[p + 2], b[p + 3], b[p + 4], b[p + 5]]) as f64;
            m.bit_depth = Some(u16::from_be_bytes([b[p + 6], b[p + 7]]) as u32);
            let sr = read_80bit_float(&b[p + 8..p + 18]);
            m.sample_rate = Some(sr as u32);
            if sr > 0.0 { m.duration = Some(num_frames / sr); }
            break;
        }
        let step = len + (len & 1);
        if p + step > b.len() { break; }
        p += step;
    }
    m
}

fn read_80bit_float(b: &[u8]) -> f64 {
    let expon = u16::from_be_bytes([b[0], b[1]]);
    let hi = u32::from_be_bytes([b[2], b[3], b[4], b[5]]) as u64;
    let lo = u32::from_be_bytes([b[6], b[7], b[8], b[9]]) as u64;
    let sign = if expon & 0x8000 != 0 { -1.0 } else { 1.0 };
    let e = (expon & 0x7fff) as i32 - 16383;
    let mantissa = (hi << 32) | lo;
    sign * (mantissa as f64) * 2f64.powi(e - 63)
}

// ============================================================
// DSF
// ============================================================
fn parse_dsf(b: &[u8]) -> Metadata {
    let mut m = Metadata { format: "DSF".into(), is_dsd: Some(true), bit_depth: Some(1), ..Default::default() };
    if b.len() < 92 || &b[0..4] != b"DSD " {
        m.error = Some("no DSD ".into());
        return m;
    }
    let p = 28;
    if &b[p..p + 4] != b"fmt " {
        m.error = Some("no fmt ".into());
        return m;
    }
    m.channels = Some(u32::from_le_bytes([b[p + 20], b[p + 21], b[p + 22], b[p + 23]]));
    let sr = u32::from_le_bytes([b[p + 28], b[p + 29], b[p + 30], b[p + 31]]);
    m.sample_rate = Some(sr);
    m.dsd_rate = Some((sr as f64 / 44100.0).round() as u32);
    let sample_count_lo = u32::from_le_bytes([b[p + 36], b[p + 37], b[p + 38], b[p + 39]]) as u64;
    let sample_count_hi = u32::from_le_bytes([b[p + 40], b[p + 41], b[p + 42], b[p + 43]]) as u64;
    let sample_count = (sample_count_hi << 32) | sample_count_lo;
    if sr > 0 { m.duration = Some(sample_count as f64 / sr as f64); }
    m
}

// ============================================================
// DFF
// ============================================================
fn parse_dff(b: &[u8]) -> Metadata {
    let mut m = Metadata { format: "DFF".into(), is_dsd: Some(true), bit_depth: Some(1), ..Default::default() };
    if b.len() < 16 || &b[0..4] != b"FRM8" || &b[12..16] != b"DSD " {
        m.error = Some("no FRM8/DSD ".into());
        return m;
    }
    let mut p = 16;
    while p + 12 <= b.len() {
        let id = &b[p..p + 4];
        let size_hi = u32::from_be_bytes([b[p + 4], b[p + 5], b[p + 6], b[p + 7]]) as u64;
        let size_lo = u32::from_be_bytes([b[p + 8], b[p + 9], b[p + 10], b[p + 11]]) as u64;
        let csize = (size_hi << 32) | size_lo;
        p += 12;
        if id == b"PROP" {
            let end = (p as u64 + csize).min(b.len() as u64) as usize;
            let mut q = p + 4; // skip "SND "
            while q + 12 < end {
                let cid = &b[q..q + 4];
                let cs_hi = u32::from_be_bytes([b[q + 4], b[q + 5], b[q + 6], b[q + 7]]) as u64;
                let cs_lo = u32::from_be_bytes([b[q + 8], b[q + 9], b[q + 10], b[q + 11]]) as u64;
                let cs = (cs_hi << 32) | cs_lo;
                q += 12;
                if cid == b"FS  " && q + 4 <= end {
                    let sr = u32::from_be_bytes([b[q], b[q + 1], b[q + 2], b[q + 3]]);
                    m.sample_rate = Some(sr);
                    m.dsd_rate = Some((sr as f64 / 44100.0).round() as u32);
                } else if cid == b"CHNL" && q + 2 <= end {
                    m.channels = Some(u16::from_be_bytes([b[q], b[q + 1]]) as u32);
                }
                let step = cs + (cs & 1);
                q = q.saturating_add(step as usize);
            }
            break;
        }
        let step = csize + (csize & 1);
        p = p.saturating_add(step as usize);
    }
    if m.channels.is_none() { m.channels = Some(2); }
    m
}

// ============================================================
// MP4 / ALAC
// ============================================================
fn parse_mp4(b: &[u8]) -> Metadata {
    let mut m = Metadata { format: "AAC/M4A".into(), channels: Some(2), ..Default::default() };
    // Scan for "alac" atom type
    let mut p = 0;
    while p + 8 <= b.len() {
        let sz = u32::from_be_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) as usize;
        if &b[p + 4..p + 8] == b"alac" {
            m.format = "ALAC".into();
            break;
        }
        if sz < 8 { break; }
        p += sz;
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flac_magic_required() {
        let b = b"NOPE-this-is-not-flac";
        let m = parse_flac(b, false);
        assert_eq!(m.format, "FLAC");
        assert!(m.error.is_some());
    }

    #[test]
    fn wav_minimal() {
        // Minimal RIFF/WAVE/fmt /data
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&[0u8; 4]);   // size
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
        b.extend_from_slice(&1u16.to_le_bytes());  // PCM
        b.extend_from_slice(&2u16.to_le_bytes());  // 2 channels
        b.extend_from_slice(&44100u32.to_le_bytes()); // SR
        b.extend_from_slice(&176400u32.to_le_bytes()); // byte rate
        b.extend_from_slice(&4u16.to_le_bytes()); // block align
        b.extend_from_slice(&16u16.to_le_bytes()); // bit depth
        b.extend_from_slice(b"data");
        b.extend_from_slice(&176400u32.to_le_bytes()); // 1 second
        let m = parse_wav(&b);
        assert_eq!(m.sample_rate, Some(44100));
        assert_eq!(m.bit_depth, Some(16));
        assert_eq!(m.channels, Some(2));
    }
}
