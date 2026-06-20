// ============================================================
// metadata.js — read source-of-truth specs from file headers.
//
// We deliberately parse the *binary* header rather than trust
// extensions or ask the audio engine. The readout you see is
// what the file claims, not what the engine resampled to.
//
// Supports: FLAC, WAV (PCM/float), AIFF, DSF, DFF (DSDIFF).
// For ALAC/MP4, ID3-tagged MP3, OGG — we fall back to the
// HTMLAudioElement once it's loaded.
// ============================================================

export async function sniffMetadata(file, ext) {
  const e = ext.toLowerCase();
  const blob = file;

  // Read first 256 KB — enough for all headers we care about
  const head = await readSlice(blob, 0, Math.min(blob.size, 262144));

  switch (e) {
    case 'flac':           return parseFlac(head, blob.size);
    case 'wav':
    case 'wave':           return parseWav(head, blob.size);
    case 'aif':
    case 'aiff':
    case 'aifc':           return parseAiff(head, blob.size);
    case 'dsf':            return parseDsf(head, blob.size);
    case 'dff':
    case 'dsd':            return parseDff(head, blob.size);
    case 'mp3':            return { format: 'MP3', sampleRate: null, bitDepth: null, channels: 2 };
    case 'ogg':
    case 'oga':            return { format: 'OGG', sampleRate: null, bitDepth: null, channels: 2 };
    case 'opus':           return { format: 'OPUS', sampleRate: 48000, bitDepth: null, channels: 2 };
    case 'm4a':
    case 'mp4':
    case 'alac':           return parseMp4(head, blob.size);
    case 'ape':            return { format: 'APE', sampleRate: null, bitDepth: null, channels: 2 };
    case 'wv':             return { format: 'WAVPACK', sampleRate: null, bitDepth: null, channels: 2 };
    default:               return { format: e.toUpperCase() };
  }
}

function readSlice(blob, start, end) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(new DataView(r.result));
    r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(blob.slice(start, end));
  });
}

// ============== FLAC ==============
// Spec: "fLaC" magic, then METADATA_BLOCKs. STREAMINFO is first.
// STREAMINFO body (34 bytes) layout we need:
//   bytes 10..13: sample_rate (20 bits) | channels (3) | bits_per_sample-1 (5)
//                 actually: 20+3+5 = 28 bits across bytes 10-13 ish
// Reference: https://xiph.org/flac/format.html
function parseFlac(dv, size) {
  // magic
  if (dv.getUint32(0, false) !== 0x664c6143) return { format: 'FLAC', error: 'no magic' };
  let p = 4;
  // first metadata block must be STREAMINFO
  const blockHeader = dv.getUint32(p, false);
  const blockType = (blockHeader >>> 24) & 0x7f;
  if (blockType !== 0) return { format: 'FLAC', error: 'no streaminfo' };
  p += 4;
  // STREAMINFO is 34 bytes
  // skip min/max block size (4), min/max frame size (6)
  const off = p + 10;
  // bytes at off..off+3 contain packed: sampleRate(20) | channels(3) | bps(5) | totalSamples high 4
  const b0 = dv.getUint8(off);
  const b1 = dv.getUint8(off+1);
  const b2 = dv.getUint8(off+2);
  const b3 = dv.getUint8(off+3);
  const sampleRate = (b0 << 12) | (b1 << 4) | (b2 >> 4);
  const channels = ((b2 >> 1) & 0x07) + 1;
  const bitDepth = (((b2 & 0x01) << 4) | (b3 >> 4)) + 1;
  // total samples (36 bits)
  const tsHigh = b3 & 0x0f;
  const tsLow =
    (dv.getUint8(off+4) << 24) |
    (dv.getUint8(off+5) << 16) |
    (dv.getUint8(off+6) << 8)  |
    (dv.getUint8(off+7));
  // JS bitwise is 32-bit; combine via *2^32
  const totalSamples = tsHigh * Math.pow(2,32) + (tsLow >>> 0);
  const duration = totalSamples / sampleRate;

  // Try to find VORBIS_COMMENT block for tags
  const tags = readFlacTags(dv, 4);

  return {
    format: 'FLAC',
    sampleRate, bitDepth, channels,
    duration: isFinite(duration) ? duration : null,
    title: tags.title, artist: tags.artist, album: tags.album,
  };
}

function readFlacTags(dv, start) {
  let p = start;
  const out = {};
  try {
    while (p < dv.byteLength - 4) {
      const h = dv.getUint32(p, false);
      const isLast = (h & 0x80000000) !== 0;
      const type = (h >>> 24) & 0x7f;
      const len = h & 0x00ffffff;
      p += 4;
      if (type === 4) { // VORBIS_COMMENT
        let q = p;
        const vendorLen = dv.getUint32(q, true); q += 4;
        q += vendorLen;
        const cnt = dv.getUint32(q, true); q += 4;
        for (let i = 0; i < cnt; i++) {
          if (q + 4 > dv.byteLength) break;
          const l = dv.getUint32(q, true); q += 4;
          if (q + l > dv.byteLength) break;
          const s = utf8(dv, q, l); q += l;
          const eq = s.indexOf('=');
          if (eq < 0) continue;
          const k = s.slice(0, eq).toLowerCase();
          const v = s.slice(eq+1);
          if (k === 'title') out.title = v;
          else if (k === 'artist') out.artist = v;
          else if (k === 'album') out.album = v;
        }
        break;
      }
      p += len;
      if (isLast) break;
    }
  } catch {}
  return out;
}

// ============== WAV ==============
function parseWav(dv, size) {
  if (dv.getUint32(0, false) !== 0x52494646) return { format: 'WAV', error: 'no RIFF' };
  if (dv.getUint32(8, false) !== 0x57415645) return { format: 'WAV', error: 'no WAVE' };
  let p = 12;
  let fmtFound = null, dataLen = 0;
  while (p < dv.byteLength - 8) {
    const id = dv.getUint32(p, false); p += 4;
    const len = dv.getUint32(p, true); p += 4;
    if (id === 0x666d7420) { // 'fmt '
      const format = dv.getUint16(p, true);
      const channels = dv.getUint16(p+2, true);
      const sampleRate = dv.getUint32(p+4, true);
      const byteRate = dv.getUint32(p+8, true);
      const blockAlign = dv.getUint16(p+12, true);
      const bitDepth = dv.getUint16(p+14, true);
      let formatLabel = 'WAV';
      if (format === 3) formatLabel = 'WAV·float';
      else if (format === 0xfffe) formatLabel = 'WAV·ext';
      else if (format === 1) formatLabel = 'WAV·PCM';
      fmtFound = { format: formatLabel, sampleRate, bitDepth, channels, byteRate };
    } else if (id === 0x64617461) { // 'data'
      dataLen = len;
      break;
    }
    p += len + (len & 1);
  }
  if (!fmtFound) return { format: 'WAV', error: 'no fmt chunk' };
  const duration = dataLen / (fmtFound.byteRate || 1);
  return { ...fmtFound, duration };
}

// ============== AIFF / AIFC ==============
function parseAiff(dv, size) {
  if (dv.getUint32(0, false) !== 0x464f524d) return { format: 'AIFF', error: 'no FORM' };
  const type = dv.getUint32(8, false);
  const aifc = type === 0x41494643;
  let p = 12;
  let info = null;
  while (p < dv.byteLength - 8) {
    const id = dv.getUint32(p, false); p += 4;
    const len = dv.getUint32(p, false); p += 4;
    if (id === 0x434f4d4d) { // 'COMM'
      const channels = dv.getUint16(p, false);
      const numFrames = dv.getUint32(p+2, false);
      const bitDepth = dv.getUint16(p+6, false);
      const sampleRate = read80BitFloat(dv, p+8);
      info = {
        format: aifc ? 'AIFC' : 'AIFF',
        sampleRate, bitDepth, channels,
        duration: numFrames / sampleRate,
      };
      break;
    }
    p += len + (len & 1);
  }
  return info || { format: 'AIFF', error: 'no COMM' };
}

function read80BitFloat(dv, off) {
  // IEEE 754 80-bit extended precision
  const expon = (dv.getUint8(off) << 8) | dv.getUint8(off+1);
  const hi = (dv.getUint8(off+2) << 24) | (dv.getUint8(off+3) << 16) |
             (dv.getUint8(off+4) << 8) | dv.getUint8(off+5);
  const lo = (dv.getUint8(off+6) << 24) | (dv.getUint8(off+7) << 16) |
             (dv.getUint8(off+8) << 8) | dv.getUint8(off+9);
  const sign = expon & 0x8000 ? -1 : 1;
  const e = (expon & 0x7fff) - 16383;
  const mantissa = (hi >>> 0) * Math.pow(2, 32) + (lo >>> 0);
  return sign * mantissa * Math.pow(2, e - 63);
}

// ============== DSF (Sony DSD Stream File) ==============
// Header: 'DSD ' chunk (28 bytes), then 'fmt ' chunk (52 bytes)
function parseDsf(dv, size) {
  if (dv.getUint32(0, false) !== 0x44534420) return { format: 'DSF', isDsd: true, error: 'no DSD ' };
  // fmt chunk starts at offset 28
  const p = 28;
  if (dv.getUint32(p, false) !== 0x666d7420) return { format: 'DSF', isDsd: true, error: 'no fmt ' };
  const channels = dv.getUint32(p+20, true);
  const sampleRate = dv.getUint32(p+28, true);  // DSD rate, e.g. 2822400 (DSD64), 5644800 (DSD128)
  const bitsPerSample = dv.getUint32(p+32, true); // 1 or 8
  const sampleCount = readU64LE(dv, p+36);
  const duration = sampleCount / sampleRate;
  const dsdRate = sampleRate / 44100; // DSD64=64x, DSD128=128x, etc.
  return {
    format: 'DSF',
    isDsd: true,
    sampleRate,
    dsdRate: Math.round(dsdRate),
    bitDepth: bitsPerSample,
    channels,
    duration,
  };
}

// ============== DFF (DSDIFF) ==============
// FRM8 container, looks for FS  (sample rate) and CHNL chunks
function parseDff(dv, size) {
  if (dv.getUint32(0, false) !== 0x46524d38) return { format: 'DFF', isDsd: true, error: 'no FRM8' };
  if (dv.getUint32(12, false) !== 0x44534420) return { format: 'DFF', isDsd: true, error: 'no DSD ' };
  let p = 16;
  let sr = null, ch = null;
  while (p < dv.byteLength - 12) {
    const id = dv.getUint32(p, false); p += 4;
    const sizeHi = dv.getUint32(p, false); p += 4;
    const sizeLo = dv.getUint32(p, false); p += 4;
    const csize = sizeHi * Math.pow(2,32) + sizeLo;
    if (id === 0x50524f50) { // 'PROP'
      // children inside PROP — scan for FS and CHNL
      let q = p + 4; // skip 'SND '
      const end = Math.min(p + csize, dv.byteLength);
      while (q < end - 12) {
        const cid = dv.getUint32(q, false); q += 4;
        const cSzHi = dv.getUint32(q, false); q += 4;
        const cSzLo = dv.getUint32(q, false); q += 4;
        const cSz = cSzHi * Math.pow(2,32) + cSzLo;
        if (cid === 0x46532020) { // 'FS  '
          sr = dv.getUint32(q, false);
        } else if (cid === 0x43484e4c) { // 'CHNL'
          ch = dv.getUint16(q, false);
        }
        q += cSz + (cSz & 1n? 1:0);
        if (cSz > 1e7) break; // sanity
      }
      break;
    }
    p += csize + (csize & 1);
    if (csize > 1e9) break;
  }
  return {
    format: 'DFF',
    isDsd: true,
    sampleRate: sr,
    dsdRate: sr ? Math.round(sr/44100) : null,
    bitDepth: 1,
    channels: ch || 2,
  };
}

// ============== MP4 / ALAC ==============
function parseMp4(dv, size) {
  // Very light — find moov/trak/mdia/minf/stbl/stsd and read codec FourCC
  // Most users will rely on the audio engine for full metadata.
  // Returning a reasonable default; the engine fills sample rate post-load.
  // (Full MP4 atom walk would double the file, omitted here.)
  let p = 0;
  let isAlac = false;
  while (p < dv.byteLength - 8) {
    const sz = dv.getUint32(p, false);
    const tp = dv.getUint32(p+4, false);
    if (tp === 0x616c6163) { isAlac = true; break; }
    if (sz < 8) break;
    p += sz === 1 ? 16 : sz;
    if (sz > 1e8) break;
  }
  return { format: isAlac ? 'ALAC' : 'AAC/M4A', sampleRate: null, bitDepth: null, channels: 2 };
}

// ============== utils ==============
function readU64LE(dv, off) {
  const lo = dv.getUint32(off, true) >>> 0;
  const hi = dv.getUint32(off+4, true) >>> 0;
  return hi * Math.pow(2,32) + lo;
}
function utf8(dv, off, len) {
  const a = new Uint8Array(dv.buffer, dv.byteOffset + off, len);
  return new TextDecoder('utf-8').decode(a);
}
