// ============================================================
// metadata-core.js — pure header parsers, no DOM, no globals.
// Imported by both main thread and Web Worker.
// ============================================================

const SUPPORTED = ['flac','wav','wave','aif','aiff','aifc','alac','m4a','mp3','ogg','opus','oga','dsf','dff','dsd','ape','wv','mp4'];
export { SUPPORTED };

export async function sniffMetadata(file, ext) {
  const e = (ext || file.name.split('.').pop()).toLowerCase();

  // Read first 1MB for headers + embedded art (FLAC PICTURE block can be large)
  const headSize = Math.min(file.size, 1024 * 1024);
  const buf = await file.slice(0, headSize).arrayBuffer();
  const dv = new DataView(buf);

  switch (e) {
    case 'flac':           return parseFlac(dv, buf, file.size);
    case 'wav':
    case 'wave':           return parseWav(dv, file.size);
    case 'aif':
    case 'aiff':
    case 'aifc':           return parseAiff(dv, file.size);
    case 'dsf':            return parseDsf(dv, file.size);
    case 'dff':
    case 'dsd':            return parseDff(dv, file.size);
    case 'mp3':            return { format: 'MP3', sampleRate: null, bitDepth: null, channels: 2 };
    case 'ogg':
    case 'oga':            return { format: 'OGG', sampleRate: null, bitDepth: null, channels: 2 };
    case 'opus':           return { format: 'OPUS', sampleRate: 48000, bitDepth: null, channels: 2 };
    case 'm4a':
    case 'mp4':
    case 'alac':           return parseMp4(dv, file.size);
    case 'ape':            return { format: 'APE', sampleRate: null, bitDepth: null, channels: 2 };
    case 'wv':             return { format: 'WAVPACK', sampleRate: null, bitDepth: null, channels: 2 };
    default:               return { format: e.toUpperCase() };
  }
}

// ============== FLAC ==============
// Magic "fLaC", then METADATA_BLOCKs. STREAMINFO required first.
function parseFlac(dv, buf, fileSize) {
  if (dv.getUint32(0, false) !== 0x664c6143) return { format: 'FLAC', error: 'no magic' };
  let p = 4;
  const blockHeader = dv.getUint32(p, false);
  const blockType = (blockHeader >>> 24) & 0x7f;
  if (blockType !== 0) return { format: 'FLAC', error: 'no streaminfo' };
  p += 4;
  // STREAMINFO (34 bytes), parse from offset+10:
  const off = p + 10;
  const b0 = dv.getUint8(off);
  const b1 = dv.getUint8(off+1);
  const b2 = dv.getUint8(off+2);
  const b3 = dv.getUint8(off+3);
  const sampleRate = (b0 << 12) | (b1 << 4) | (b2 >> 4);
  const channels = ((b2 >> 1) & 0x07) + 1;
  const bitDepth = (((b2 & 0x01) << 4) | (b3 >> 4)) + 1;
  const tsHigh = b3 & 0x0f;
  const tsLow =
    (dv.getUint8(off+4) << 24) |
    (dv.getUint8(off+5) << 16) |
    (dv.getUint8(off+6) << 8)  |
    (dv.getUint8(off+7));
  const totalSamples = tsHigh * Math.pow(2,32) + (tsLow >>> 0);
  const duration = sampleRate > 0 ? totalSamples / sampleRate : null;

  // Walk remaining blocks for tags + picture
  const extras = walkFlacBlocks(dv, buf, 4);

  return {
    format: 'FLAC',
    sampleRate, bitDepth, channels,
    duration: isFinite(duration) ? duration : null,
    ...extras.tags,
    picture: extras.picture, // {mime, data:Uint8Array} or null
  };
}

function walkFlacBlocks(dv, buf, start) {
  let p = start;
  const tags = {};
  let picture = null;
  try {
    while (p < dv.byteLength - 4) {
      const h = dv.getUint32(p, false);
      const isLast = (h & 0x80000000) !== 0;
      const type = (h >>> 24) & 0x7f;
      const len = h & 0x00ffffff;
      p += 4;
      if (p + len > dv.byteLength) break;

      if (type === 4) { // VORBIS_COMMENT
        let q = p;
        const vendorLen = dv.getUint32(q, true); q += 4;
        q += vendorLen;
        const cnt = dv.getUint32(q, true); q += 4;
        for (let i = 0; i < cnt && q < p + len; i++) {
          const l = dv.getUint32(q, true); q += 4;
          if (q + l > dv.byteLength) break;
          const s = utf8(buf, q, l); q += l;
          const eq = s.indexOf('=');
          if (eq < 0) continue;
          const k = s.slice(0, eq).toLowerCase();
          const v = s.slice(eq+1);
          assignTag(tags, k, v);
        }
      } else if (type === 6) { // PICTURE
        try {
          let q = p;
          const picType = dv.getUint32(q, false); q += 4;
          const mimeLen = dv.getUint32(q, false); q += 4;
          const mime = utf8(buf, q, mimeLen); q += mimeLen;
          const descLen = dv.getUint32(q, false); q += 4;
          q += descLen;
          q += 16; // width, height, depth, colors (4 each)
          const dataLen = dv.getUint32(q, false); q += 4;
          if (q + dataLen <= dv.byteLength && (picType === 3 || !picture)) {
            // type 3 = front cover, preferred
            const data = new Uint8Array(buf, q, dataLen);
            picture = { mime: mime || 'image/jpeg', data: data.slice() };
          }
        } catch {}
      }
      p += len;
      if (isLast) break;
    }
  } catch {}
  return { tags, picture };
}

function assignTag(t, k, v) {
  switch (k) {
    case 'title': t.title = v; break;
    case 'artist': t.artist = v; break;
    case 'album': t.album = v; break;
    case 'albumartist': t.albumArtist = v; break;
    case 'date': case 'year': t.year = v; break;
    case 'originaldate': case 'original_year': t.originalYear = v; break;
    case 'tracknumber': t.trackNo = parseInt(v) || null; break;
    case 'discnumber': t.discNo = parseInt(v) || null; break;
    case 'genre': t.genre = v; break;
    case 'encoder': t.encoder = v; break;
    case 'encoded_by': case 'encoded-by': t.encodedBy = v; break;
    case 'mastering_engineer': case 'masteringengineer': t.masteringEngineer = v; break;
    case 'producer': t.producer = v; break;
    case 'mixer': t.mixer = v; break;
    case 'replaygain_track_gain': t.rgTrackGain = parseFloat(v); break;
    case 'replaygain_album_gain': t.rgAlbumGain = parseFloat(v); break;
    case 'replaygain_track_peak': t.rgTrackPeak = parseFloat(v); break;
    case 'replaygain_album_peak': t.rgAlbumPeak = parseFloat(v); break;
    case 'musicbrainz_albumid': t.mbAlbumId = v; break;
    case 'musicbrainz_trackid': t.mbTrackId = v; break;
    case 'dr': case 'dynamic_range': t.drTag = parseInt(v) || null; break;
  }
}

// ============== WAV ==============
function parseWav(dv, fileSize) {
  if (dv.getUint32(0, false) !== 0x52494646) return { format: 'WAV', error: 'no RIFF' };
  if (dv.getUint32(8, false) !== 0x57415645) return { format: 'WAV', error: 'no WAVE' };
  let p = 12;
  let fmtFound = null, dataLen = 0;
  while (p < dv.byteLength - 8) {
    const id = dv.getUint32(p, false); p += 4;
    const len = dv.getUint32(p, true); p += 4;
    if (id === 0x666d7420) {
      const format = dv.getUint16(p, true);
      const channels = dv.getUint16(p+2, true);
      const sampleRate = dv.getUint32(p+4, true);
      const byteRate = dv.getUint32(p+8, true);
      const bitDepth = dv.getUint16(p+14, true);
      let formatLabel = 'WAV·PCM';
      if (format === 3) formatLabel = 'WAV·float';
      else if (format === 0xfffe) formatLabel = 'WAV·ext';
      fmtFound = { format: formatLabel, sampleRate, bitDepth, channels, byteRate };
    } else if (id === 0x64617461) {
      dataLen = len;
      break;
    }
    p += len + (len & 1);
    if (len > 1e9) break;
  }
  if (!fmtFound) return { format: 'WAV', error: 'no fmt chunk' };
  const duration = dataLen / (fmtFound.byteRate || 1);
  return { ...fmtFound, duration };
}

// ============== AIFF / AIFC ==============
function parseAiff(dv, fileSize) {
  if (dv.getUint32(0, false) !== 0x464f524d) return { format: 'AIFF', error: 'no FORM' };
  const type = dv.getUint32(8, false);
  const aifc = type === 0x41494643;
  let p = 12;
  let info = null;
  while (p < dv.byteLength - 8) {
    const id = dv.getUint32(p, false); p += 4;
    const len = dv.getUint32(p, false); p += 4;
    if (id === 0x434f4d4d) {
      const channels = dv.getUint16(p, false);
      const numFrames = dv.getUint32(p+2, false);
      const bitDepth = dv.getUint16(p+6, false);
      const sampleRate = read80BitFloat(dv, p+8);
      info = {
        format: aifc ? 'AIFC' : 'AIFF',
        sampleRate, bitDepth, channels,
        duration: sampleRate > 0 ? numFrames / sampleRate : null,
      };
      break;
    }
    p += len + (len & 1);
    if (len > 1e9) break;
  }
  return info || { format: 'AIFF', error: 'no COMM' };
}

function read80BitFloat(dv, off) {
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

// ============== DSF ==============
function parseDsf(dv, fileSize) {
  if (dv.getUint32(0, false) !== 0x44534420) return { format: 'DSF', isDsd: true, error: 'no DSD ' };
  const p = 28;
  if (dv.getUint32(p, false) !== 0x666d7420) return { format: 'DSF', isDsd: true, error: 'no fmt ' };
  const channels = dv.getUint32(p+20, true);
  const sampleRate = dv.getUint32(p+28, true);
  const bitsPerSample = dv.getUint32(p+32, true);
  const sampleCount = readU64LE(dv, p+36);
  const duration = sampleCount / sampleRate;
  return {
    format: 'DSF',
    isDsd: true,
    sampleRate,
    dsdRate: Math.round(sampleRate / 44100),
    bitDepth: bitsPerSample,
    channels,
    duration,
  };
}

// ============== DFF ==============
function parseDff(dv, fileSize) {
  if (dv.getUint32(0, false) !== 0x46524d38) return { format: 'DFF', isDsd: true, error: 'no FRM8' };
  if (dv.getUint32(12, false) !== 0x44534420) return { format: 'DFF', isDsd: true, error: 'no DSD ' };
  let p = 16;
  let sr = null, ch = null;
  while (p < dv.byteLength - 12) {
    const id = dv.getUint32(p, false); p += 4;
    const sizeHi = dv.getUint32(p, false); p += 4;
    const sizeLo = dv.getUint32(p, false); p += 4;
    const csize = sizeHi * Math.pow(2,32) + sizeLo;
    if (id === 0x50524f50) {
      let q = p + 4;
      const end = Math.min(p + csize, dv.byteLength);
      while (q < end - 12) {
        const cid = dv.getUint32(q, false); q += 4;
        const cSzHi = dv.getUint32(q, false); q += 4;
        const cSzLo = dv.getUint32(q, false); q += 4;
        const cSz = cSzHi * Math.pow(2,32) + cSzLo;
        if (cid === 0x46532020) sr = dv.getUint32(q, false);
        else if (cid === 0x43484e4c) ch = dv.getUint16(q, false);
        q += cSz + (cSz & 1 ? 1 : 0);
        if (cSz > 1e8) break;
      }
      break;
    }
    p += csize + (csize & 1 ? 1 : 0);
    if (csize > 1e10) break;
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
function parseMp4(dv, fileSize) {
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
function utf8(buf, off, len) {
  return new TextDecoder('utf-8').decode(new Uint8Array(buf, off, len));
}
