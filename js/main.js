// ============================================================
// main.js — orchestration. Owns the state, wires up everything.
// ============================================================

import { SUPPORTED } from './metadata-core.js';
import { metadataPool } from './worker-pool.js';
import { cache, fileKey } from './db.js';
import { AudioEngine } from './engine.js';
import { Visualizers } from './visualizers.js';
import { VirtualList } from './virtual-list.js';
import { computeDR, analyzeHiRes, measureSignalPath } from './analysis.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);

const els = {
  app: $('app'),
  emptyScreen: $('emptyScreen'),
  filePicker: $('filePicker'),
  toasts: $('toasts'),

  signalChain: $('signalChain'),
  chainFile: $('chainFile'),
  chainEngine: $('chainEngine'),
  chainOutput: $('chainOutput'),
  badgeMeasured: $('badgeMeasured'),
  badgeMeasuredLabel: $('badgeMeasuredLabel'),

  btnView: $('btnView'),
  viewLabel: $('viewLabel'),
  btnScan: $('btnScan'),
  btnOpen: $('btnOpen'),
  btnOpenFolder: $('btnOpenFolder'),
  emptyOpenFolder: $('emptyOpenFolder'),
  emptyOpenFiles: $('emptyOpenFiles'),

  viewLibrary: $('viewLibrary'),
  viewVinyl: $('viewVinyl'),

  libCount: $('libCount'),
  libStatus: $('libStatus'),
  searchInput: $('searchInput'),
  libScroller: $('libScroller'),
  libSpacer: $('libSpacer'),
  libRows: $('libRows'),

  statusDot: $('statusDot'),
  statusText: $('statusText'),
  npTitle: $('npTitle'),
  npArtist: $('npArtist'),
  npAlbum: $('npAlbum'),
  rFormat: $('rFormat'),
  rRate: $('rRate'),
  rBits: $('rBits'),
  rChans: $('rChans'),
  verdicts: $('verdicts'),

  meterL: $('meterL'),
  meterR: $('meterR'),
  spectrum: $('spectrum'),

  btnPlay: $('btnPlay'),
  iconPlay: $('iconPlay'),
  iconPause: $('iconPause'),
  btnPrev: $('btnPrev'),
  btnNext: $('btnNext'),
  btnShuffle: $('btnShuffle'),
  btnRepeat: $('btnRepeat'),
  btnGapless: $('btnGapless'),
  btnRG: $('btnRG'),
  vol: $('vol'),
  volPct: $('volPct'),
  scrub: $('scrub'),
  scrubFill: $('scrubFill'),
  scrubKnob: $('scrubKnob'),
  timeCur: $('timeCur'),
  timeTot: $('timeTot'),

  platter: $('platter'),
  record: $('record'),
  recordLabel: $('recordLabel'),
  labelArt: $('labelArt'),
  vinylTitle: $('vinylTitle'),
  vinylArtist: $('vinylArtist'),
  tonearm: $('tonearm'),
  sleeve: $('sleeve'),
  sleeveFront: $('sleeveFront'),
  linerTitle: $('linerTitle'),
  linerArtist: $('linerArtist'),
  linerAlbum: $('linerAlbum'),
  linerYear: $('linerYear'),
  linerFormat: $('linerFormat'),
  linerSample: $('linerSample'),
  linerBits: $('linerBits'),
  linerChans: $('linerChans'),
  linerDR: $('linerDR'),
  linerHiRes: $('linerHiRes'),
  linerEncoder: $('linerEncoder'),
  linerRG: $('linerRG'),
};

// ---------- State ----------
const state = {
  tracks: [],         // { id, file, name, ext, meta?, art? (objectURL), drValue?, hiRes? }
  filtered: [],       // sorted indices
  view: 'library',    // 'library' | 'vinyl'
  currentIdx: -1,
  shuffle: false,
  repeat: 'off',
  shuffleBag: [],
  measured: null,     // { thdnDb, clean, timestamp } | null
  ingestActive: false,
  ingestBatchTimer: null,
  artUrls: new Set(), // for cleanup
  gapless: true,
  useReplayGain: false,
};

const engine = new AudioEngine();
let visualizers = null;
let virtualList = null;

// ---------- Toast ----------
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  els.toasts.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3500);
  setTimeout(() => t.remove(), 3900);
}

// ---------- File ingestion ----------
els.btnOpen.addEventListener('click', () => els.filePicker.click());
els.emptyOpenFiles.addEventListener('click', () => els.filePicker.click());
els.filePicker.addEventListener('change', (e) => onFilesChosen(e.target.files));

async function openFolder() {
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
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.webkitdirectory = true;
    inp.multiple = true;
    inp.addEventListener('change', e => onFilesChosen(e.target.files));
    inp.click();
  }
}
els.btnOpenFolder.addEventListener('click', openFolder);
els.emptyOpenFolder.addEventListener('click', openFolder);

async function* walkDir(dirHandle, path = '') {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      yield file;
    } else if (handle.kind === 'directory') {
      yield* walkDir(handle, path + name + '/');
    }
  }
}

async function onFilesChosen(fileList) {
  const incoming = [...fileList].filter(f => SUPPORTED.includes(f.name.split('.').pop().toLowerCase()));
  if (!incoming.length) {
    toast('No supported audio files in selection', 'warn');
    return;
  }
  els.emptyScreen.hidden = true;
  state.ingestActive = true;
  els.libStatus.textContent = `Reading ${incoming.length} files…`;

  const before = state.tracks.length;
  for (const file of incoming) {
    const ext = file.name.split('.').pop().toLowerCase();
    state.tracks.push({
      id: cryptoId(),
      file,
      name: file.name,
      ext,
      meta: null,
      art: null,
      drValue: null,
      hiRes: null,
    });
  }

  applyFilter();
  scheduleRender();

  // Parse metadata in parallel via worker pool
  let done = 0;
  const total = incoming.length;
  await Promise.all(incoming.map(async (file, i) => {
    const trackIdx = before + i;
    const t = state.tracks[trackIdx];

    // Check cache first
    const cachedMeta = await cache.getMeta(file);
    if (cachedMeta) {
      t.meta = cachedMeta;
      const cachedArt = await cache.getArt(file);
      if (cachedArt) {
        const url = URL.createObjectURL(cachedArt);
        t.art = url;
        state.artUrls.add(url);
      }
    } else {
      const result = await metadataPool.parse(file);
      t.meta = result.meta;
      if (result.artBlob) {
        const url = URL.createObjectURL(result.artBlob);
        t.art = url;
        state.artUrls.add(url);
        await cache.setArt(file, result.artBlob);
      }
      await cache.setMeta(file, result.meta);
    }
    done++;
    if (done % 25 === 0 || done === total) {
      els.libStatus.textContent = `Indexed ${done} of ${total}`;
      scheduleRender();
    }
  }));

  state.ingestActive = false;
  els.libStatus.textContent = `${state.tracks.length} tracks loaded`;
  applyFilter();
  scheduleRender();
  toast(`Added ${incoming.length} file${incoming.length>1?'s':''}`, 'ok');
}

// ---------- Library rendering ----------
function applyFilter() {
  const q = els.searchInput.value.trim().toLowerCase();
  if (!q) {
    state.filtered = state.tracks.map((_, i) => i);
  } else {
    state.filtered = state.tracks
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => {
        const m = t.meta || {};
        return (
          (m.title && m.title.toLowerCase().includes(q)) ||
          (m.artist && m.artist.toLowerCase().includes(q)) ||
          (m.album && m.album.toLowerCase().includes(q)) ||
          t.name.toLowerCase().includes(q)
        );
      })
      .map(({ i }) => i);
  }
  els.libCount.textContent = `${state.tracks.length} track${state.tracks.length===1?'':'s'}`;
}

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (virtualList) {
      virtualList.setItems(state.filtered);
    }
  });
}

function renderTrackRow(el, trackIdx, listPos) {
  const t = state.tracks[trackIdx];
  if (!t) return;
  const m = t.meta || {};
  const title = m.title || stripExt(t.name);
  const artist = m.artist || '';
  const album = m.album || '';
  const fmt = (m.format || t.ext).toUpperCase();
  const sr = m.sampleRate ? formatSR(m.sampleRate) : '';
  const bd = m.bitDepth ? `${m.bitDepth}-bit` : (m.isDsd ? `DSD${m.dsdRate||''}` : '');

  el.classList.toggle('playing', trackIdx === state.currentIdx);

  // Reuse children if present, else create
  if (!el.firstChild) {
    el.innerHTML = `
      <span class="idx"></span>
      <div class="art"></div>
      <div class="meta">
        <div class="title"></div>
        <div class="sub"></div>
      </div>
      <div class="badges-mini"></div>
    `;
    el.addEventListener('click', (e) => {
      const idx = parseInt(el.dataset.idx);
      const realIdx = state.filtered[idx];
      if (realIdx === state.currentIdx) togglePlay();
      else playIndex(realIdx);
    });
  }
  el.querySelector('.idx').textContent = String(listPos + 1).padStart(3, '0');
  const art = el.querySelector('.art');
  art.style.backgroundImage = t.art ? `url(${t.art})` : '';
  el.querySelector('.title').textContent = title;
  const sub = [artist, album].filter(Boolean).join(' · ') || stripExt(t.name);
  el.querySelector('.sub').textContent = sub;

  const badges = el.querySelector('.badges-mini');
  let html = `<span class="pill">${fmt}</span>`;
  if (sr || bd) html += `<span class="pill">${[sr,bd].filter(Boolean).join(' · ')}</span>`;
  if (t.hiRes) {
    if (t.hiRes.verdict === 'fake') html += `<span class="pill fake">UPSAMPLED</span>`;
    else if (t.hiRes.verdict === 'true') html += `<span class="pill hires">HI-RES ✓</span>`;
  }
  if (t.drValue != null) {
    const cls = t.drValue >= 14 ? 'drhi' : t.drValue >= 8 ? 'drmid' : 'drlow';
    html += `<span class="pill ${cls}">DR${t.drValue}</span>`;
  }
  badges.innerHTML = html;
}

els.searchInput.addEventListener('input', () => {
  applyFilter();
  scheduleRender();
});

function stripExt(name) { return name.replace(/\.[^.]+$/, ''); }
function formatSR(hz) {
  if (hz >= 1000) return (hz/1000).toFixed(hz % 1000 === 0 ? 0 : 1) + ' kHz';
  return hz + ' Hz';
}

// ---------- Playback ----------
async function playIndex(idx) {
  if (idx < 0 || idx >= state.tracks.length) return;
  const t = state.tracks[idx];
  if (!t) return;

  // Wait for metadata if needed
  if (!t.meta) {
    toast('Metadata still loading, try again in a moment', 'warn');
    return;
  }

  els.libStatus.textContent = `Decoding ${t.name}…`;
  setStatus('decoding', 'DECODING');

  try {
    // Ensure context at the source sample rate
    await engine.ensure(t.meta.sampleRate || null);

    // Build visualizers + measurement hook on first context
    if (!visualizers) {
      visualizers = new Visualizers({
        meterL: els.meterL,
        meterR: els.meterR,
        spectrum: els.spectrum,
        engine,
      });
      visualizers.start();
      engine.onTrackEnd = onTrackEnded;
      engine.onTimeUpdate = onTimeUpdate;
    }

    // Apply ReplayGain if available
    const rg = t.meta.rgTrackGain;
    engine.setReplayGain(rg ?? 0, !!state.useReplayGain && rg != null);

    const buffer = await engine.decode(t.file);
    await engine.playBuffer(buffer, t.id, t.meta.sampleRate || buffer.sampleRate);

    state.currentIdx = idx;
    updateNowPlaying(t, buffer);
    updateSignalChain(t);
    updatePlayButton(true);
    setStatus('playing', 'PLAYING');
    els.libStatus.textContent = `${state.tracks.length} tracks loaded`;

    // Async analyses on the buffer
    runAnalyses(t, buffer);

    // Schedule next track for gapless if available
    scheduleGapless(idx, buffer);

    scheduleRender();
  } catch (e) {
    console.error(e);
    toast(`Playback failed: ${e.message}`, 'warn');
    setStatus('error', 'ERROR');
    updatePlayButton(false);
  }
}

async function scheduleGapless(idx, currentBuffer) {
  if (!state.gapless) return;
  const remaining = currentBuffer.duration;
  if (remaining < 6) return; // too short
  // Wait until ~5s before end
  const wait = (remaining - 5) * 1000;
  setTimeout(async () => {
    if (state.currentIdx !== idx) return; // user changed track
    const nextIdx = computeNextIdx(idx);
    if (nextIdx === idx || nextIdx < 0) return;
    const nt = state.tracks[nextIdx];
    if (!nt || !nt.meta) return;
    // Only gapless if same sample rate (else we'd need ctx rebuild = not gapless)
    if (nt.meta.sampleRate && nt.meta.sampleRate !== engine.ctx.sampleRate) return;
    try {
      const nb = await engine.decode(nt.file);
      if (state.currentIdx !== idx) return; // user changed since
      engine.scheduleNext(nb, nt.id);
      // When gapless triggers, the engine's onTrackEnd will fire for the OLD track,
      // but currentTrackId already changed via the promote handler. We update UI here.
      const delay = Math.max(0, (engine.nextScheduledAt - engine.ctx.currentTime) * 1000);
      setTimeout(() => {
        if (engine.currentTrackId === nt.id) {
          state.currentIdx = nextIdx;
          updateNowPlaying(nt, nb);
          updateSignalChain(nt);
          runAnalyses(nt, nb);
          scheduleRender();
          // chain next-next gapless
          scheduleGapless(nextIdx, nb);
        }
      }, delay + 10);
    } catch (e) {
      console.warn('gapless decode failed', e);
    }
  }, wait);
}

function onTrackEnded(trackId) {
  // If gapless promoted, currentSource is the new buffer and currentTrackId already updated.
  // This fires for tracks that ended without gapless succession.
  if (engine.currentSource) return; // gapless promoted, ignore
  if (state.repeat === 'one') {
    playIndex(state.currentIdx);
    return;
  }
  playNext();
}

function onTimeUpdate(cur, dur) {
  if (!isFinite(dur)) return;
  const pct = cur / dur;
  els.scrubFill.style.width = (pct * 100) + '%';
  els.scrubKnob.style.left = (pct * 100) + '%';
  els.timeCur.textContent = fmtTime(cur);
  els.timeTot.textContent = fmtTime(dur);

  // tonearm rotation: -30deg (rest) → +18deg (end)
  if (state.view === 'vinyl' && els.tonearm) {
    const angle = -30 + pct * 48;
    els.tonearm.style.transform = `rotate(${angle}deg)`;
  }
}

function computeNextIdx(fromIdx) {
  if (state.shuffle) {
    if (!state.shuffleBag.length) state.shuffleBag = makeShuffleBag(fromIdx);
    return state.shuffleBag.shift() ?? -1;
  }
  let n = fromIdx + 1;
  if (n >= state.tracks.length) {
    if (state.repeat === 'all') n = 0;
    else return -1;
  }
  return n;
}
function makeShuffleBag(excludeIdx) {
  const all = state.tracks.map((_, i) => i).filter(i => i !== excludeIdx);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

function playNext() {
  if (!state.tracks.length) return;
  const next = computeNextIdx(state.currentIdx);
  if (next < 0) {
    engine.pause();
    setStatus('idle', 'END');
    updatePlayButton(false);
    return;
  }
  playIndex(next);
}
function playPrev() {
  if (!state.tracks.length) return;
  if (engine.getCurrentTime() > 3) { engine.seek(0); return; }
  let p = state.currentIdx - 1;
  if (p < 0) p = state.tracks.length - 1;
  playIndex(p);
}

function togglePlay() {
  if (state.currentIdx < 0) {
    if (state.tracks.length) playIndex(state.filtered[0] ?? 0);
    return;
  }
  if (engine.playing) {
    engine.pause();
    updatePlayButton(false);
    setStatus('paused', 'PAUSED');
  } else {
    engine.resume();
    updatePlayButton(true);
    setStatus('playing', 'PLAYING');
  }
}

function updatePlayButton(playing) {
  els.iconPlay.style.display = playing ? 'none' : '';
  els.iconPause.style.display = playing ? '' : 'none';
  els.app.dataset.playing = String(playing);
}
function setStatus(kind, label) {
  els.statusDot.classList.toggle('idle', kind !== 'playing');
  els.statusText.textContent = label;
}
function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

els.btnPlay.addEventListener('click', () => togglePlay());
els.btnPrev.addEventListener('click', () => playPrev());
els.btnNext.addEventListener('click', () => playNext());
els.btnShuffle.addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  els.btnShuffle.setAttribute('aria-pressed', state.shuffle);
  els.btnShuffle.classList.toggle('on', state.shuffle);
  state.shuffleBag = state.shuffle ? makeShuffleBag(state.currentIdx) : [];
});
els.btnRepeat.addEventListener('click', () => {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  els.btnRepeat.classList.toggle('on', state.repeat !== 'off');
  els.btnRepeat.title = `Repeat: ${state.repeat}`;
});
els.btnGapless.addEventListener('click', () => {
  state.gapless = !state.gapless;
  els.btnGapless.setAttribute('aria-pressed', state.gapless);
});
els.btnRG.addEventListener('click', () => {
  state.useReplayGain = !state.useReplayGain;
  els.btnRG.setAttribute('aria-pressed', state.useReplayGain);
  const t = state.tracks[state.currentIdx];
  if (t && t.meta && t.meta.rgTrackGain != null) {
    engine.setReplayGain(t.meta.rgTrackGain, state.useReplayGain);
  }
});

els.scrub.addEventListener('click', (e) => {
  const dur = engine.getDuration();
  if (!isFinite(dur) || dur <= 0) return;
  const rect = els.scrub.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  engine.seek(pct * dur);
});

els.vol.addEventListener('input', () => {
  const v = els.vol.value / 100;
  engine.setVolume(v);
  els.volPct.textContent = els.vol.value;
});

// ---------- Now-playing UI ----------
function updateNowPlaying(t, buffer) {
  const m = t.meta || {};
  const title = m.title || stripExt(t.name);
  const artist = m.artist || '—';
  const album = m.album || '';

  els.npTitle.textContent = title;
  els.npArtist.textContent = artist;
  els.npAlbum.textContent = album;

  els.rFormat.textContent = (m.format || t.ext).toUpperCase();
  els.rFormat.classList.remove('dim');
  els.rRate.textContent = m.sampleRate ? formatSR(m.sampleRate) : (buffer ? formatSR(buffer.sampleRate) : '—');
  els.rRate.classList.toggle('dim', !m.sampleRate && !buffer);
  els.rBits.textContent = m.bitDepth ? `${m.bitDepth}-bit` : (m.isDsd ? '1-bit DSD' : '—');
  els.rBits.classList.toggle('dim', !m.bitDepth && !m.isDsd);
  els.rChans.textContent = (m.channels || (buffer ? buffer.numberOfChannels : null)) ? `${m.channels || buffer.numberOfChannels} ch` : '—';
  els.rChans.classList.toggle('dim', !m.channels && !buffer);

  // Verdicts panel
  renderVerdicts(t);

  // Vinyl view
  els.vinylTitle.textContent = title;
  els.vinylArtist.textContent = artist;
  if (t.art) {
    els.labelArt.style.backgroundImage = `url(${t.art})`;
    els.sleeveFront.style.backgroundImage = `url(${t.art})`;
    els.recordLabel.classList.remove('no-art');
  } else {
    els.labelArt.style.backgroundImage = '';
    els.sleeveFront.style.backgroundImage = '';
    els.recordLabel.classList.add('no-art');
  }
  // Liner notes
  els.linerTitle.textContent = title;
  els.linerArtist.textContent = artist;
  els.linerAlbum.textContent = album || '—';
  els.linerYear.textContent = m.originalYear || m.year || '—';
  els.linerFormat.textContent = (m.format || t.ext).toUpperCase();
  els.linerSample.textContent = m.sampleRate ? formatSR(m.sampleRate) : '—';
  els.linerBits.textContent = m.bitDepth ? `${m.bitDepth}-bit` : (m.isDsd ? '1-bit DSD' : '—');
  els.linerChans.textContent = m.channels ? `${m.channels}` : '—';
  els.linerEncoder.textContent = m.encoder || m.encodedBy || '—';
  els.linerRG.textContent = (m.rgTrackGain != null) ? `${m.rgTrackGain.toFixed(2)} dB (track)` : '—';
}

function renderVerdicts(t) {
  const out = [];
  if (t.hiRes) {
    if (t.hiRes.verdict === 'true') out.push({ cls: 'ok', label: 'HI-RES ✓' });
    else if (t.hiRes.verdict === 'fake') out.push({ cls: 'bad', label: t.hiRes.label });
  }
  if (t.drValue != null) {
    const cls = t.drValue >= 14 ? 'ok' : t.drValue >= 8 ? 'warn' : 'bad';
    out.push({ cls, label: `DR ${t.drValue}` });
  }
  els.verdicts.innerHTML = out.map(v => `<span class="verdict ${v.cls}">${v.label}</span>`).join('');
}

function updateSignalChain(t) {
  const m = t.meta || {};
  const fileRate = m.sampleRate;
  const engineRate = engine.ctx ? engine.ctx.sampleRate : null;

  els.chainFile.textContent = fileRate ? formatSR(fileRate) : '—';
  els.chainEngine.textContent = engineRate ? formatSR(engineRate) : '—';
  els.chainOutput.textContent = engineRate ? formatSR(engineRate) + '*' : '—';
  els.chainOutput.title = 'OS output rate cannot be read from browser — assumed equal to engine. If different, OS resamples after our chain.';

  els.signalChain.classList.remove('match-ok', 'match-warn', 'match-bad');
  els.signalChain.removeAttribute('data-mismatch');
  if (fileRate && engineRate) {
    if (fileRate === engineRate) {
      els.signalChain.classList.add('match-ok');
    } else {
      els.signalChain.classList.add('match-warn');
      els.signalChain.setAttribute('data-mismatch', 'engine');
    }
  }

  // Update liner DR/hi-res
  els.linerDR.textContent = t.drValue != null ? `DR${t.drValue}` : 'computing…';
  els.linerHiRes.textContent = t.hiRes ? t.hiRes.label : 'computing…';
}

// ---------- Async analyses ----------
async function runAnalyses(t, buffer) {
  // Skip if already cached on track
  if (t.drValue == null) {
    // Run in idle/next microtask to not block UI
    setTimeout(() => {
      try {
        const channels = [];
        for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
        const dr = computeDR(channels, buffer.sampleRate);
        t.drValue = dr;
        if (t === state.tracks[state.currentIdx]) {
          renderVerdicts(t);
          els.linerDR.textContent = `DR${dr}`;
        }
        scheduleRender();
        if (t.meta) {
          t.meta._dr = dr;
          cache.setMeta(t.file, t.meta);
        }
      } catch (e) { console.warn('DR failed', e); }
    }, 50);
  }
  if (t.hiRes == null) {
    setTimeout(() => {
      try {
        const channels = [];
        for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
        const v = analyzeHiRes(channels, buffer.sampleRate, t.meta?.bitDepth || 16, t.meta?.sampleRate || buffer.sampleRate);
        t.hiRes = v;
        if (t === state.tracks[state.currentIdx]) {
          renderVerdicts(t);
          els.linerHiRes.textContent = v.label + (v.reason ? ` — ${v.reason}` : '');
        }
        scheduleRender();
        if (t.meta) {
          t.meta._hiRes = v;
          cache.setMeta(t.file, t.meta);
        }
      } catch (e) { console.warn('hi-res failed', e); }
    }, 150);
  }
}

// ---------- Measured-clean badge ----------
els.badgeMeasured.addEventListener('click', async () => {
  if (!engine.ctx) {
    toast('Play something first so the engine is initialized', 'warn');
    return;
  }
  els.badgeMeasured.classList.add('measuring');
  els.badgeMeasuredLabel.textContent = 'MEASURING…';
  try {
    const r = await measureSignalPath(engine.ctx);
    state.measured = r;
    els.badgeMeasured.classList.remove('measuring');
    if (r.clean) {
      els.badgeMeasured.classList.add('measured');
      els.badgeMeasured.classList.remove('failed');
      els.badgeMeasuredLabel.textContent = `CLEAN · ${r.thdnDb.toFixed(0)} dB`;
    } else {
      els.badgeMeasured.classList.remove('measured');
      els.badgeMeasured.classList.add('failed');
      els.badgeMeasuredLabel.textContent = `THD+N ${r.thdnDb.toFixed(0)} dB`;
    }
    toast(`Signal path measured: THD+N ${r.thdnDb.toFixed(1)} dB`, r.clean ? 'ok' : 'warn');
  } catch (e) {
    els.badgeMeasured.classList.remove('measuring');
    toast('Measurement failed: ' + e.message, 'warn');
  }
});

// ---------- View toggle ----------
els.btnView.addEventListener('click', toggleView);
function toggleView() {
  state.view = state.view === 'library' ? 'vinyl' : 'library';
  els.app.dataset.view = state.view;
  els.viewLibrary.hidden = state.view !== 'library';
  els.viewVinyl.hidden = state.view !== 'vinyl';
  els.viewLabel.textContent = state.view === 'library' ? 'VINYL' : 'LIBRARY';
  if (state.view === 'library' && virtualList) virtualList.refresh();
}

els.sleeve.addEventListener('click', () => {
  els.sleeve.classList.toggle('flipped');
});

// ---------- Library scan ----------
els.btnScan.addEventListener('click', async () => {
  if (!state.tracks.length) { toast('Open a folder first', 'warn'); return; }
  toast(`Scanning ${state.tracks.length} tracks for DR & hi-res — this may take a while`, 'ok');
  let done = 0;
  const work = state.tracks.slice();
  // Sequential to avoid blowing up memory; decodeAudioData is expensive
  for (const t of work) {
    if (t.drValue != null && t.hiRes != null) { done++; continue; }
    if (!t.meta) { done++; continue; }
    try {
      // Decode at default ctx if possible (no rate match for scanning)
      if (!engine.ctx) await engine.ensure(t.meta.sampleRate || null);
      const buffer = await engine.decode(t.file);
      runAnalyses(t, buffer);
    } catch (e) {
      console.warn('scan decode failed', t.name, e);
    }
    done++;
    if (done % 5 === 0) els.libStatus.textContent = `Scanned ${done}/${work.length}`;
  }
  els.libStatus.textContent = `${state.tracks.length} tracks loaded`;
  toast('Scan complete', 'ok');
});

// ---------- Keyboard ----------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'KeyM') toggleView();
  else if (e.code === 'KeyS') els.btnShuffle.click();
  else if (e.code === 'KeyR') els.btnRepeat.click();
  else if (e.code === 'ArrowRight' && e.shiftKey) playNext();
  else if (e.code === 'ArrowLeft' && e.shiftKey) playPrev();
  else if (e.code === 'ArrowRight') engine.seek(Math.min(engine.getDuration(), engine.getCurrentTime() + 5));
  else if (e.code === 'ArrowLeft') engine.seek(Math.max(0, engine.getCurrentTime() - 5));
  else if (e.code === 'Slash') { e.preventDefault(); els.searchInput.focus(); }
});

// ---------- Init ----------
function init() {
  virtualList = new VirtualList({
    scroller: els.libScroller,
    spacer: els.libSpacer,
    rows: els.libRows,
    renderRow: (el, idx, listPos) => renderTrackRow(el, idx, listPos),
  });
  virtualList.setItems([]);

  // Show empty state until library has content
  if (!state.tracks.length) {
    els.emptyScreen.hidden = false;
  }

  // PWA registration
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

function cryptoId() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

init();
