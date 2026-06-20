// ============================================================
// SIGNAL — Lossless Player
// 100% client-side. No backend. No upload.
//
// Audio path:
//   1. Native <audio>/Web Audio decode for FLAC, ALAC (Safari),
//      WAV, AIFF, MP3, OGG, OPUS, M4A — modern browsers handle these.
//   2. For DSD (.dsf/.dff), the browser cannot natively decode.
//      We parse the header (sample rate, bit-depth, channels) for
//      readout and route the data to the WASM decoder hook below.
//   3. Bit-depth / sample-rate are read from file headers, never
//      guessed. The readout reflects the *source*, not the engine.
// ============================================================

import { sniffMetadata } from './metadata.js';
import { wasmDecoder } from './wasm-bridge.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const tracklistEl = $('tracklist');
const emptyEl = $('emptyState');
const libCount = $('libCount');
const searchInput = $('searchInput');

const npTitle = $('npTitle');
const npArtist = $('npArtist');
const statusDot = $('statusDot');
const statusText = $('statusText');
const rFormat = $('rFormat');
const rRate = $('rRate');
const rBits = $('rBits');
const rChans = $('rChans');

const meterL = $('meterL');
const meterR = $('meterR');
const spectrum = $('spectrum');

const btnPlay = $('btnPlay');
const iconPlay = $('iconPlay');
const iconPause = $('iconPause');
const btnPrev = $('btnPrev');
const btnNext = $('btnNext');
const btnShuffle = $('btnShuffle');
const btnRepeat = $('btnRepeat');
const vol = $('vol');
const volPct = $('volPct');
const scrub = $('scrub');
const scrubFill = $('scrubFill');
const scrubKnob = $('scrubKnob');
const timeCur = $('timeCur');
const timeTot = $('timeTot');

const btnOpen = $('btnOpen');
const btnOpenFolder = $('btnOpenFolder');
const filePicker = $('filePicker');

const statEngine = $('statEngine');
const statCtx = $('statCtx');
const toasts = $('toasts');

// ---------- State ----------
const state = {
  tracks: [],          // { id, file, name, sizeBytes, ext, meta?: {format,sampleRate,bitDepth,channels,duration,title,artist} }
  filtered: [],        // ids visible in tracklist after search
  currentIdx: -1,      // index in state.tracks
  playing: false,
  shuffle: false,
  repeat: 'off',       // off | all | one
  shuffleBag: [],
  volume: 0.85,
};

let ctx = null;            // AudioContext
let audioEl = null;        // HTMLAudioElement
let srcNode = null;        // MediaElementAudioSourceNode
let gainNode = null;
let analyser = null;
let splitter = null;
let analyserL = null;
let analyserR = null;
let rafId = null;
let currentObjectUrl = null;

// ---------- Toast ----------
function toast(msg, kind='') {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  toasts.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition='opacity .3s'; }, 3500);
  setTimeout(() => t.remove(), 3900);
}

// ---------- Audio context init (created on first user gesture) ----------
function ensureContext() {
  if (ctx) return ctx;
  // Request the device's preferred sample rate — bit-perfect when possible.
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
  statCtx.textContent = `${ctx.sampleRate/1000}kHz`;

  audioEl = new Audio();
  audioEl.crossOrigin = 'anonymous';
  audioEl.preload = 'auto';

  audioEl.addEventListener('ended', onTrackEnd);
  audioEl.addEventListener('timeupdate', onTimeUpdate);
  audioEl.addEventListener('loadedmetadata', onLoadedMeta);
  audioEl.addEventListener('error', onAudioError);

  srcNode = ctx.createMediaElementSource(audioEl);
  gainNode = ctx.createGain();
  gainNode.gain.value = state.volume;

  // Spectrum analyser (sum of channels)
  analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.78;

  // Per-channel meters
  splitter = ctx.createChannelSplitter(2);
  analyserL = ctx.createAnalyser();
  analyserR = ctx.createAnalyser();
  analyserL.fftSize = 1024;
  analyserR.fftSize = 1024;
  analyserL.smoothingTimeConstant = 0;
  analyserR.smoothingTimeConstant = 0;

  // Graph: src -> gain -> [analyser, splitter -> (L,R analysers)] -> destination
  srcNode.connect(gainNode);
  gainNode.connect(analyser);
  gainNode.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);
  gainNode.connect(ctx.destination);

  startVisualLoop();
  return ctx;
}

// ---------- File ingestion ----------
btnOpen.addEventListener('click', () => filePicker.click());
filePicker.addEventListener('change', (e) => onFilesChosen(e.target.files));

btnOpenFolder.addEventListener('click', async () => {
  if ('showDirectoryPicker' in window) {
    try {
      const dir = await window.showDirectoryPicker();
      const files = [];
      for await (const f of walkDir(dir)) files.push(f);
      onFilesChosen(files);
    } catch (e) {
      if (e.name !== 'AbortError') toast('Folder access denied', 'warn');
    }
  } else {
    // Safari / others — fall back to file picker with webkitdirectory
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.webkitdirectory = true;
    inp.multiple = true;
    inp.addEventListener('change', e => onFilesChosen(e.target.files));
    inp.click();
  }
});

async function* walkDir(dirHandle, path='') {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      // attach a synthetic path for display
      Object.defineProperty(file, 'relativePath', { value: path + name, configurable: true });
      yield file;
    } else if (handle.kind === 'directory') {
      yield* walkDir(handle, path + name + '/');
    }
  }
}

const SUPPORTED = ['flac','wav','wave','aif','aiff','aifc','alac','m4a','mp3','ogg','opus','oga','dsf','dff','dsd','ape','wv','mp4'];

async function onFilesChosen(fileList) {
  const incoming = [...fileList].filter(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    return SUPPORTED.includes(ext);
  });
  if (!incoming.length) {
    toast('No supported audio files in selection', 'warn');
    return;
  }

  // Quick add — show in list immediately, parse metadata async
  const before = state.tracks.length;
  for (const file of incoming) {
    const ext = file.name.split('.').pop().toLowerCase();
    state.tracks.push({
      id: cryptoId(),
      file,
      name: file.name,
      sizeBytes: file.size,
      ext,
      meta: null,
    });
  }
  refreshLibrary();
  toast(`Added ${incoming.length} file${incoming.length>1?'s':''}`);

  // Parse metadata in background
  for (let i = before; i < state.tracks.length; i++) {
    const t = state.tracks[i];
    try {
      t.meta = await sniffMetadata(t.file, t.ext);
    } catch (e) {
      t.meta = { format: t.ext.toUpperCase(), error: String(e) };
    }
    // Re-render only the affected row if visible
    refreshLibrary(true);
  }
}

function cryptoId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}

// ---------- Library rendering ----------
function refreshLibrary(meta=false) {
  const q = searchInput.value.trim().toLowerCase();
  state.filtered = state.tracks
    .map((t, i) => ({ t, i }))
    .filter(({t}) => {
      if (!q) return true;
      const hay = `${t.name} ${t.meta?.title||''} ${t.meta?.artist||''}`.toLowerCase();
      return hay.includes(q);
    })
    .map(({i}) => i);

  libCount.textContent = `${state.tracks.length} track${state.tracks.length===1?'':'s'}`;

  if (!state.tracks.length) {
    emptyEl.style.display = 'block';
    [...tracklistEl.querySelectorAll('.track')].forEach(n => n.remove());
    return;
  }
  emptyEl.style.display = 'none';

  // Rebuild — simple, sufficient for libraries of a few thousand
  const frag = document.createDocumentFragment();
  state.filtered.forEach((idx, listPos) => {
    const t = state.tracks[idx];
    const el = document.createElement('div');
    el.className = 'track' + (idx === state.currentIdx ? ' playing' : '');
    el.dataset.idx = idx;

    const title = t.meta?.title || stripExt(t.name);
    const artist = t.meta?.artist || '';
    const fmt = (t.meta?.format || t.ext).toUpperCase();
    const sr = t.meta?.sampleRate ? formatSR(t.meta.sampleRate) : '';
    const bd = t.meta?.bitDepth ? `${t.meta.bitDepth}-bit` : (t.meta?.isDsd ? `DSD${t.meta.dsdRate||''}` : '');
    const sub = [artist, sr, bd].filter(Boolean).join(' · ');

    el.innerHTML = `
      <span class="idx">${String(listPos+1).padStart(2,'0')}</span>
      <div class="meta">
        <div class="title"></div>
        <div class="sub"></div>
      </div>
      <span class="format-pill">${fmt}</span>
    `;
    el.querySelector('.title').textContent = title;
    el.querySelector('.sub').textContent = sub || stripExt(t.name);

    el.addEventListener('dblclick', () => playIndex(idx));
    el.addEventListener('click', (e) => {
      // single click selects but doesn't play unless already current
      if (idx === state.currentIdx) togglePlay();
      else playIndex(idx);
    });
    frag.appendChild(el);
  });

  [...tracklistEl.querySelectorAll('.track')].forEach(n => n.remove());
  tracklistEl.appendChild(frag);
}

searchInput.addEventListener('input', () => refreshLibrary());

function stripExt(name) { return name.replace(/\.[^.]+$/, ''); }
function formatSR(hz) {
  if (hz >= 1000) return (hz/1000).toFixed(hz % 1000 === 0 ? 0 : 1) + ' kHz';
  return hz + ' Hz';
}

// ---------- Playback ----------
async function playIndex(idx) {
  if (idx < 0 || idx >= state.tracks.length) return;
  ensureContext();
  if (ctx.state === 'suspended') await ctx.resume();

  const t = state.tracks[idx];
  state.currentIdx = idx;

  // Free previous URL
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);

  // DSD path: browsers cannot decode DSD natively. Route through WASM bridge.
  const isDsd = ['dsf','dff','dsd'].includes(t.ext);
  if (isDsd) {
    const res = await wasmDecoder.tryPlayDsd(t.file, ctx, gainNode);
    if (!res.ok) {
      toast('DSD decoder not loaded — install WASM module (see /wasm/README)', 'warn');
      statEngine.textContent = 'DSD·UNSUPPORTED';
      // still show readout from header
      applyReadout(t);
      setStatus(false, 'NO DECODER');
      return;
    }
    statEngine.textContent = 'WASM·DSD';
  } else {
    currentObjectUrl = URL.createObjectURL(t.file);
    audioEl.src = currentObjectUrl;
    try {
      await audioEl.play();
    } catch (e) {
      toast('Playback failed: ' + e.message, 'warn');
      return;
    }
    statEngine.textContent = 'NATIVE·' + (t.meta?.format || t.ext).toUpperCase();
  }

  state.playing = true;
  updatePlayButton();
  applyReadout(t);
  setStatus(true, 'PLAYING');
  refreshLibrary();
}

function applyReadout(t) {
  const m = t.meta || {};
  npTitle.textContent = m.title || stripExt(t.name);
  npArtist.textContent = m.artist || '—';
  rFormat.textContent = (m.format || t.ext).toUpperCase();
  rFormat.classList.toggle('dim', false);

  if (m.isDsd) {
    rRate.textContent = `DSD${m.dsdRate||''}`;
    rBits.textContent = '1-bit';
    rChans.textContent = m.channels ? `${m.channels} ch` : '—';
  } else {
    rRate.textContent = m.sampleRate ? formatSR(m.sampleRate) : '—';
    rBits.textContent = m.bitDepth ? `${m.bitDepth}-bit` : '—';
    rChans.textContent = m.channels ? `${m.channels} ch` : '—';
  }
  [rRate, rBits, rChans].forEach(el => el.classList.toggle('dim', el.textContent === '—'));

  // Sample-rate mismatch warning (engine resampling = not bit-perfect)
  if (ctx && m.sampleRate && m.sampleRate !== ctx.sampleRate) {
    statCtx.textContent = `${ctx.sampleRate/1000}k → resample`;
    statCtx.style.color = 'var(--red)';
  } else if (ctx) {
    statCtx.textContent = `${ctx.sampleRate/1000}kHz`;
    statCtx.style.color = '';
  }
}

function setStatus(playing, label) {
  statusDot.classList.toggle('idle', !playing);
  statusText.textContent = label;
}

function togglePlay() {
  if (!audioEl || state.currentIdx < 0) {
    if (state.tracks.length) playIndex(0);
    return;
  }
  if (audioEl.paused) {
    audioEl.play();
    state.playing = true;
    setStatus(true, 'PLAYING');
  } else {
    audioEl.pause();
    state.playing = false;
    setStatus(false, 'PAUSED');
  }
  updatePlayButton();
}

function updatePlayButton() {
  iconPlay.style.display = state.playing ? 'none' : '';
  iconPause.style.display = state.playing ? '' : 'none';
}

btnPlay.addEventListener('click', () => {
  ensureContext();
  if (ctx.state === 'suspended') ctx.resume();
  togglePlay();
});
btnNext.addEventListener('click', () => playNext());
btnPrev.addEventListener('click', () => playPrev());

function playNext() {
  if (!state.tracks.length) return;
  let next;
  if (state.shuffle) {
    if (!state.shuffleBag.length) state.shuffleBag = shuffleBag();
    next = state.shuffleBag.shift();
  } else {
    next = state.currentIdx + 1;
    if (next >= state.tracks.length) {
      if (state.repeat === 'all') next = 0;
      else { setStatus(false, 'END'); state.playing = false; updatePlayButton(); return; }
    }
  }
  playIndex(next);
}
function playPrev() {
  if (!state.tracks.length) return;
  if (audioEl && audioEl.currentTime > 3) { audioEl.currentTime = 0; return; }
  let p = state.currentIdx - 1;
  if (p < 0) p = state.tracks.length - 1;
  playIndex(p);
}
function shuffleBag() {
  const all = state.tracks.map((_,i) => i).filter(i => i !== state.currentIdx);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

function onTrackEnd() {
  if (state.repeat === 'one') {
    audioEl.currentTime = 0;
    audioEl.play();
    return;
  }
  playNext();
}

function onLoadedMeta() {
  if (!audioEl) return;
  timeTot.textContent = fmtTime(audioEl.duration);
}
function onTimeUpdate() {
  if (!audioEl || isNaN(audioEl.duration)) return;
  const pct = audioEl.currentTime / audioEl.duration;
  scrubFill.style.width = (pct*100) + '%';
  scrubKnob.style.left = (pct*100) + '%';
  timeCur.textContent = fmtTime(audioEl.currentTime);
}
function onAudioError() {
  const code = audioEl.error?.code;
  toast(`Decode failed (code ${code}) — format may not be supported by this browser`, 'warn');
  setStatus(false, 'ERROR');
  state.playing = false; updatePlayButton();
}
function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s);
  const m = Math.floor(s/60);
  const ss = String(s%60).padStart(2,'0');
  return `${m}:${ss}`;
}

scrub.addEventListener('click', (e) => {
  if (!audioEl || !isFinite(audioEl.duration)) return;
  const rect = scrub.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  audioEl.currentTime = pct * audioEl.duration;
});

vol.addEventListener('input', () => {
  state.volume = vol.value / 100;
  volPct.textContent = vol.value;
  if (gainNode) gainNode.gain.value = state.volume;
});

btnShuffle.addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  btnShuffle.classList.toggle('on', state.shuffle);
  state.shuffleBag = state.shuffle ? shuffleBag() : [];
});
btnRepeat.addEventListener('click', () => {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  btnRepeat.classList.toggle('on', state.repeat !== 'off');
  btnRepeat.title = `Repeat: ${state.repeat}`;
});

// Keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowRight' && e.shiftKey) playNext();
  else if (e.code === 'ArrowLeft' && e.shiftKey) playPrev();
  else if (e.code === 'ArrowRight' && audioEl) audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime+5);
  else if (e.code === 'ArrowLeft' && audioEl) audioEl.currentTime = Math.max(0, audioEl.currentTime-5);
});

// ---------- Visualization ----------
// Peak-hold meters + log-scale spectrum
const peakHold = { L: -80, R: -80, ttlL: 0, ttlR: 0 };

function startVisualLoop() {
  const meterLCtx = meterL.getContext('2d');
  const meterRCtx = meterR.getContext('2d');
  const specCtx = spectrum.getContext('2d');

  // hi-DPI sharpening
  function fitCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w*dpr || c.height !== h*dpr) {
      c.width = w*dpr; c.height = h*dpr;
      c.getContext('2d').setTransform(dpr,0,0,dpr,0,0);
    }
  }

  const bufL = new Float32Array(analyserL.fftSize);
  const bufR = new Float32Array(analyserR.fftSize);
  const fftBuf = new Uint8Array(analyser.frequencyBinCount);

  const draw = () => {
    rafId = requestAnimationFrame(draw);
    fitCanvas(meterL); fitCanvas(meterR); fitCanvas(spectrum);

    analyserL.getFloatTimeDomainData(bufL);
    analyserR.getFloatTimeDomainData(bufR);
    analyser.getByteFrequencyData(fftBuf);

    drawMeter(meterLCtx, meterL, rms(bufL), peakOf(bufL), 'L');
    drawMeter(meterRCtx, meterR, rms(bufR), peakOf(bufR), 'R');
    drawSpectrum(specCtx, spectrum, fftBuf);
  };
  draw();
}

function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]*buf[i];
  return Math.sqrt(s/buf.length);
}
function peakOf(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}
function toDb(amp) {
  if (amp <= 0.00001) return -80;
  return Math.max(-80, 20 * Math.log10(amp));
}

function drawMeter(g, canvas, rmsAmp, peakAmp, ch) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  g.clearRect(0, 0, w, h);

  // Background grid ticks
  const ticks = [-60,-40,-20,-12,-6,0,3];
  g.fillStyle = '#0a0a0a';
  g.fillRect(0,0,w,h);

  // dB → x: map -80..+3 to 0..w (slightly compressed top)
  const dbToX = (db) => {
    const min = -60, max = 3;
    const t = (Math.max(min, Math.min(max, db)) - min) / (max - min);
    // emphasize loud range
    return Math.pow(t, 0.85) * w;
  };

  // Bar — segmented, hardware look
  const rmsDb = toDb(rmsAmp);
  const peakDb = toDb(peakAmp);
  const xRms = dbToX(rmsDb);
  const segW = 3, segGap = 1;
  for (let x = 0; x < xRms; x += segW + segGap) {
    const fract = x / w;
    let color;
    if (fract < 0.62) color = '#58c27d';        // green
    else if (fract < 0.82) color = '#ffb454';   // amber
    else color = '#ff5a3c';                     // red
    g.fillStyle = color;
    g.fillRect(x, 4, segW, h - 8);
  }

  // Peak hold dot
  const key = ch;
  if (peakDb > peakHold[key]) { peakHold[key] = peakDb; peakHold['ttl'+key] = 60; }
  else { peakHold['ttl'+key]--; if (peakHold['ttl'+key] < 0) peakHold[key] -= 0.5; }
  if (peakHold[key] > -60) {
    const xp = dbToX(peakHold[key]);
    g.fillStyle = peakHold[key] >= 0 ? '#ff5a3c' : '#ffb454';
    g.fillRect(xp - 2, 2, 2, h - 4);
  }

  // Tick marks
  g.fillStyle = '#262624';
  for (const t of ticks) {
    const x = dbToX(t);
    g.fillRect(x, h-2, 1, 2);
  }
}

function drawSpectrum(g, canvas, fft) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  g.fillStyle = '#050505';
  g.fillRect(0,0,w,h);

  // log-scale bins from 20 Hz to 20 kHz mapped to canvas width
  if (!ctx) return;
  const sr = ctx.sampleRate;
  const nyquist = sr / 2;
  const fftBins = fft.length;
  const minF = 20, maxF = Math.min(20000, nyquist);
  const logMin = Math.log10(minF), logMax = Math.log10(maxF);

  const cols = Math.max(64, Math.floor(w / 4));
  const colW = w / cols;

  // Octave grid
  g.strokeStyle = '#121211';
  g.lineWidth = 1;
  for (const f of [100, 1000, 10000]) {
    const t = (Math.log10(f) - logMin) / (logMax - logMin);
    g.beginPath();
    g.moveTo(t*w, 0);
    g.lineTo(t*w, h);
    g.stroke();
  }

  for (let c = 0; c < cols; c++) {
    const f0 = Math.pow(10, logMin + (c / cols) * (logMax - logMin));
    const f1 = Math.pow(10, logMin + ((c+1) / cols) * (logMax - logMin));
    const b0 = Math.floor((f0 / nyquist) * fftBins);
    const b1 = Math.max(b0+1, Math.floor((f1 / nyquist) * fftBins));
    let sum = 0, n = 0;
    for (let b = b0; b < b1 && b < fftBins; b++) { sum += fft[b]; n++; }
    const v = n ? sum/n : 0;
    const amp = v / 255;
    const barH = Math.pow(amp, 0.8) * (h - 6);

    // gradient amber, brighter at top
    const x = c * colW;
    const grad = g.createLinearGradient(0, h, 0, h - barH);
    grad.addColorStop(0, '#3a2a14');
    grad.addColorStop(0.6, '#ffb454');
    grad.addColorStop(1, '#fff0d4');
    g.fillStyle = grad;
    g.fillRect(x + 0.5, h - barH, colW - 1, barH);
  }
}

// ---------- Init ----------
function detectEngineSupport() {
  const a = document.createElement('audio');
  const can = (mime) => a.canPlayType(mime) !== '';
  const supports = {
    flac: can('audio/flac') || can('audio/x-flac'),
    alac: can('audio/mp4; codecs="alac"'),
    wav:  can('audio/wav'),
    aiff: can('audio/aiff'),
    mp3:  can('audio/mpeg'),
    ogg:  can('audio/ogg; codecs=vorbis'),
    opus: can('audio/ogg; codecs=opus'),
  };
  const yes = Object.entries(supports).filter(([k,v]) => v).map(([k]) => k.toUpperCase());
  statEngine.textContent = yes.length ? 'WEB-AUDIO·READY' : 'LIMITED';
  return supports;
}

const support = detectEngineSupport();
if (!support.flac) {
  toast('This browser may not decode FLAC natively. Try Chrome, Firefox, or Edge.', 'warn');
}

// PWA registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
