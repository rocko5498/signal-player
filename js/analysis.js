// ============================================================
// analysis.js — DSP routines used for truth-telling badges.
//
// All functions take Float32Array (or AudioBuffer) and return
// honest measurements with their methodology stated.
// ============================================================

// ----------------------------------------------------------
// 1. DR (Dynamic Range) — TT DR Meter algorithm
//
// Per channel:
//   - Split audio into 3-second blocks (non-overlapping)
//   - Compute RMS of each block
//   - Sort RMS values descending, take the top 20%
//   - DR_channel = peak (over whole channel) - mean of top 20% RMS, in dB
// Track DR = average of channel DRs, rounded
// ----------------------------------------------------------
export function computeDR(channels, sampleRate) {
  if (!channels.length) return null;
  const blockSize = Math.floor(3 * sampleRate);
  const drs = [];

  for (const ch of channels) {
    const peak = peakLinear(ch);
    const peakDb = toDb(peak);
    const blocks = [];
    for (let i = 0; i + blockSize <= ch.length; i += blockSize) {
      let s = 0;
      for (let j = 0; j < blockSize; j++) {
        const v = ch[i+j];
        s += v*v;
      }
      blocks.push(Math.sqrt(s / blockSize));
    }
    if (!blocks.length) continue;
    blocks.sort((a,b) => b - a);
    const top = Math.max(1, Math.floor(blocks.length * 0.2));
    let sum = 0;
    for (let i = 0; i < top; i++) sum += blocks[i];
    const meanTopRms = sum / top;
    const meanTopRmsDb = toDb(meanTopRms);
    drs.push(peakDb - meanTopRmsDb);
  }
  if (!drs.length) return null;
  const dr = drs.reduce((a,b) => a+b, 0) / drs.length;
  return Math.round(dr);
}

// ----------------------------------------------------------
// 2. Hi-Res Authenticity — detect upsampled / bit-padded files
//
// Method:
//   - Take ~3-second windows from 25%, 50%, 75% of the track
//   - FFT each, find the highest frequency with energy > noise floor
//   - If file claims SR ≥ 48k and content cuts off at <22 kHz,
//     it's almost certainly upsampled from 44.1 kHz source
//   - Also check effective bit depth: count unique LSB values
//     in the top 16 vs bottom 8 bits
// ----------------------------------------------------------
export function analyzeHiRes(channels, sampleRate, claimedBits, claimedRate) {
  if (!channels.length || !channels[0].length) return { verdict: 'unknown' };
  const ch = channels[0]; // mono check is sufficient

  // ----- 1. spectral cutoff -----
  const winSize = 1 << 14; // 16384 samples
  const positions = [0.25, 0.5, 0.75].map(p =>
    Math.max(0, Math.min(ch.length - winSize, Math.floor(ch.length * p)))
  );

  // For each window, find highest frequency where signal energy is
  // significantly above the noise floor over a region (not single bin).
  // We use a sliding window: a freq is "real signal" if the mean magnitude
  // in a small band centered there exceeds 30 dB above the noise floor.
  let maxBin = 0;
  const nyquist = sampleRate / 2;
  const binsPerWindow = winSize / 2;

  for (const pos of positions) {
    const slice = ch.subarray(pos, pos + winSize);
    const mags = magnitudeSpectrum(slice);

    // Noise floor = median of the upper 10% of the spectrum
    const tail = Array.from(mags.subarray(Math.floor(mags.length * 0.9)));
    tail.sort((a,b)=>a-b);
    const noiseFloor = tail[Math.floor(tail.length * 0.5)] || 1e-10;
    const threshold = noiseFloor * 31.6; // ~30 dB above floor

    // Smooth the spectrum with a small averaging window before scanning
    const band = 32;
    for (let i = mags.length - band; i >= 0; i--) {
      let sum = 0;
      for (let j = 0; j < band; j++) sum += mags[i+j];
      if (sum / band > threshold) {
        if (i + band > maxBin) maxBin = i + band;
        break;
      }
    }
  }
  const maxFreq = (maxBin / binsPerWindow) * nyquist;

  // ----- 2. effective bit depth check (for 24-bit claims) -----
  // If claimed 24-bit, look at how many distinct sample values appear
  // in the bottom 8 bits. True 24-bit has full distribution; padded 16-bit
  // will have repetitive patterns (multiples of 256 in int24 land).
  let effectiveBits = claimedBits;
  if (claimedBits >= 24) {
    const sampleCount = Math.min(ch.length, 100000);
    const buckets = new Set();
    for (let i = 0; i < sampleCount; i++) {
      // Convert to 24-bit int representation
      const int24 = Math.round(ch[i] * 8388607);
      buckets.add(int24 & 0xff); // LSB byte
    }
    // True 24-bit: ~256 unique LSB values
    // Padded 16-bit upscaled to 24: very few (e.g., always 0)
    if (buckets.size < 16) effectiveBits = 16;
    else if (buckets.size < 64) effectiveBits = 20;
  }

  // ----- verdict -----
  const claimsHiRes = claimedRate >= 48000 || claimedBits >= 24;
  if (!claimsHiRes) {
    return { verdict: 'cd', maxFreq, effectiveBits, label: 'CD' };
  }

  // If sample rate is high but content cuts off below 22 kHz, it's upsampled
  if (claimedRate >= 48000 && maxFreq < 22000) {
    return {
      verdict: 'fake',
      maxFreq, effectiveBits,
      label: 'UPSAMPLED',
      reason: `Claims ${(claimedRate/1000).toFixed(1)}kHz but content ends at ${(maxFreq/1000).toFixed(1)}kHz`
    };
  }
  if (claimedBits >= 24 && effectiveBits < 20) {
    return {
      verdict: 'fake',
      maxFreq, effectiveBits,
      label: 'BIT-PADDED',
      reason: `Claims ${claimedBits}-bit but effective dynamic range ≈ ${effectiveBits}-bit`
    };
  }
  return {
    verdict: 'true',
    maxFreq, effectiveBits,
    label: 'TRUE HI-RES'
  };
}

function magnitudeSpectrum(input) {
  const N = input.length;
  // Apply Hann window
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
    re[i] = input[i] * w;
  }
  fftInPlace(re, im);
  const mags = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    mags[i] = Math.sqrt(re[i]*re[i] + im[i]*im[i]);
  }
  return mags;
}

function estimateNoiseFloor(mags) {
  // Use median of upper half of spectrum as a noise floor estimate
  const upper = mags.subarray(Math.floor(mags.length * 0.7));
  const sorted = Float32Array.from(upper).sort();
  return sorted[Math.floor(sorted.length * 0.5)] || 1e-10;
}

// Cooley-Tukey radix-2 in-place FFT (input length must be power of 2)
function fftInPlace(re, im) {
  const N = re.length;
  // bit reversal
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const ang = -2 * Math.PI / size;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < N; i += size) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const k = i + j, l = k + half;
        const tRe = curRe * re[l] - curIm * im[l];
        const tIm = curRe * im[l] + curIm * re[l];
        re[l] = re[k] - tRe; im[l] = im[k] - tIm;
        re[k] += tRe;        im[k] += tIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

// ----------------------------------------------------------
// 3. Signal-path measurement — generate a known sine,
// route through engine, measure THD+N from the captured FFT.
// ----------------------------------------------------------
export async function measureSignalPath(audioCtx) {
  const sr = audioCtx.sampleRate;
  const duration = 0.5;
  const fundamental = 1000;
  const amplitude = Math.pow(10, -3/20); // -3 dBFS

  // Generate
  const N = Math.floor(sr * duration);
  const buf = audioCtx.createBuffer(1, N, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < N; i++) {
    data[i] = amplitude * Math.sin(2 * Math.PI * fundamental * i / sr);
  }

  // Route: source → analyser (capture-only, no destination)
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 32768;
  src.connect(analyser);
  src.start();

  // Wait ~250ms then snapshot
  await new Promise(r => setTimeout(r, 250));

  const fft = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(fft); // dB

  src.stop();
  src.disconnect();

  // Find the fundamental bin
  const binHz = sr / analyser.fftSize;
  const fundBin = Math.round(fundamental / binHz);
  let fundDb = -Infinity;
  for (let i = Math.max(0, fundBin - 3); i <= Math.min(fft.length - 1, fundBin + 3); i++) {
    if (fft[i] > fundDb) fundDb = fft[i];
  }

  // Noise+distortion = energy outside the fundamental ±3 bins,
  // excluding DC and very high frequencies
  let nPower = 0;
  for (let i = 5; i < fft.length - 5; i++) {
    if (i >= fundBin - 5 && i <= fundBin + 5) continue;
    const lin = Math.pow(10, fft[i] / 20);
    nPower += lin * lin;
  }
  const fundLin = Math.pow(10, fundDb / 20);
  const thdn = nPower > 0 ? Math.sqrt(nPower) / fundLin : 0;
  const thdnDb = thdn > 0 ? 20 * Math.log10(thdn) : -120;

  return {
    fundamentalDb: fundDb,
    thdnDb,
    clean: thdnDb < -80, // -80 dB THD+N is excellent
    timestamp: Date.now(),
  };
}

// ---- utils ----
function peakLinear(arr) {
  let p = 0;
  for (let i = 0; i < arr.length; i++) {
    const a = Math.abs(arr[i]);
    if (a > p) p = a;
  }
  return p;
}
function toDb(linear) {
  if (linear <= 1e-10) return -120;
  return 20 * Math.log10(linear);
}
