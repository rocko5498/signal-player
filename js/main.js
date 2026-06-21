// ============================================================
// main.js — SIGNAL v5 orchestrator
//
// Views: tracks | albums | artists | queue | now
// Plus: side panel for album detail
// Plus: persistent queue
// ============================================================

import { SUPPORTED } from './metadata-core.js';
import { metadataPool } from './worker-pool.js';
import { cache, fileKey } from './db.js';
import { AudioEngine } from './engine.js';
import { VirtualList } from './virtual-list.js';
import { computeDR, analyzeHiRes, measureSignalPath } from './analysis.js';
import { core } from './wasm-bridge.js';

const $ = (id) => document.getElementById(id);

// ============ DOM refs ============
const els = {
  app: $('app'),
  emptyScreen: $('emptyScreen'),
  filePicker: $('filePicker'),
  toasts: $('toasts'),
  ctxMenu: $('ctxMenu'),

  // sidebar / nav
  navItems: document.querySelectorAll('.nav-item'),
  navCountTracks: $('navCountTracks'),
  navCountAlbums: $('navCountAlbums'),
  navCountArtists: $('navCountArtists'),
  navCountQueue: $('navCountQueue'),
  btnOpen: $('btnOpen'),
  btnOpenFolder: $('btnOpenFolder'),
  btnScan: $('btnScan'),
  emptyOpenFolder: $('emptyOpenFolder'),
  emptyOpenFiles: $('emptyOpenFiles'),

  // topbar
  viewTitle: $('viewTitle'),
  viewSub: $('viewSub'),
  searchInput: $('searchInput'),
  signalChain: $('signalChain'),
  chainFile: $('chainFile'),
  chainEngine: $('chainEngine'),
  chainOutput: $('chainOutput'),
  badgeMeasured: $('badgeMeasured'),
  badgeMeasuredLabel: $('badgeMeasuredLabel'),

  // views
  viewTracks: $('viewTracks'),
  viewAlbums: $('viewAlbums'),
  viewArtists: $('viewArtists'),
  viewQueue: $('viewQueue'),
  viewNow: $('viewNow'),

  // tracks
  libScroller: $('libScroller'),
  libSpacer: $('libSpacer'),
  libRows: $('libRows'),

  // albums / artists
  albumGrid: $('albumGrid'),
  artistGrid: $('artistGrid'),

  // queue
  queueTitle: $('queueTitle'),
  queueSub: $('queueSub'),
  queueList: $('queueList'),
  queueEmpty: $('queueEmpty'),
  btnQueueShuffle: $('btnQueueShuffle'),
  btnQueueClear: $('btnQueueClear'),

  // now playing
  nowArt: $('nowArt'),
  nowArtGlow: $('nowArtGlow'),
  nowEyebrow: $('nowEyebrow'),
  nowTitle: $('nowTitle'),
  nowArtist: $('nowArtist'),
  nowAlbum: $('nowAlbum'),
  nsFormat: $('nsFormat'),
  nsRate: $('nsRate'),
  nsBits: $('nsBits'),
  nsChans: $('nsChans'),
  nsDR: $('nsDR'),
  nsHiRes: $('nsHiRes'),
  nowVerdicts: $('nowVerdicts'),
  spectrum: $('spectrum'),

  // side panel
  sidePanel: $('sidePanel'),
  sidePanelClose: $('sidePanelClose'),
  spArt: $('spArt'),
  spEyebrow: $('spEyebrow'),
  spTitle: $('spTitle'),
  spArtist: $('spArtist'),
  spInfo: $('spInfo'),
  spPlay: $('spPlay'),
  spAddQueue: $('spAddQueue'),
  spTracks: $('spTracks'),

  // footer
  npArt: $('npArt'),
  npTitle: $('npTitle'),
  npArtist: $('npArtist'),
  btnPlay: $('btnPlay'),
  iconPlay: $('iconPlay'),
  iconPause: $('iconPause'),
  btnPrev: $('btnPrev'),
  btnNext: $('btnNext'),
  btnShuffle: $('btnShuffle'),
  btnRepeat: $('btnRepeat'),
  btnGapless: $('btnGapless'),
  btnRG: $('btnRG'),
  volSlider: $('volSlider'),
  volPct: $('volPct'),
  scrubBar: $('scrubBar'),
  scrubFill: $('scrubFill'),
  scrubKnob: $('scrubKnob'),
  timeCur: $('timeCur'),
  timeTot: $('timeTot'),
};

// ============ State ============
const state = {
  tracks: [],
  filtered: [],           // indices into state.tracks (for tracks view + search)
  albums: [],             // [{key, title, artist, year, art, trackIndices, dr}]
  artists: [],            // [{name, art, albumKeys, trackIndices}]
  queue: [],              // array of track ids
  view: 'tracks',
  currentIdx: -1,
  currentSpAlbumKey: null,
  shuffle: false,
  repeat: 'off',
  shuffleBag: [],
  measured: null,
  gapless: true,
  useReplayGain: false,
  artUrls: new Set(),
};

const engine = new AudioEngine();
let virtualList = null;
let spectrumAnim = null;

// ============ Toast ============
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  els.toasts.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .25s'; }, 3500);
  setTimeout(() => t.remove(), 3800);
}

// ============ View routing ============
els.navItems.forEach(btn => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});
function setView(view) {
  state.view = view;
  els.app.dataset.view = view;
  els.navItems.forEach(b => b.classList.toggle('active', b.dataset.view === view));
  els.viewTracks.hidden = view !== 'tracks';
  els.viewAlbums.hidden = view !== 'albums';
  els.viewArtists.hidden = view !== 'artists';
  els.viewQueue.hidden = view !== 'queue';
  els.viewNow.hidden = view !== 'now';

  const titles = {
    tracks: ['Tracks', 'All tracks in your library'],
    albums: ['Albums', `${state.albums.length} albums`],
    artists: ['Artists', `${state.artists.length} artists`],
    queue: ['Queue', state.queue.length ? `${state.queue.length} tracks queued` : 'Empty'],
    now: ['Now Playing', state.currentIdx >= 0 ? state.tracks[state.currentIdx]?.meta?.title || '' : 'Nothing playing'],
  };
  const [t, s] = titles[view] || ['', ''];
  els.viewTitle.textContent = t;
  els.viewSub.textContent = s;

  if (view === 'albums') renderAlbums();
  else if (view === 'artists') renderArtists();
  else if (view === 'queue') renderQueue();
  else if (view === 'now') updateNowView();
}

// ============ File ingest ============
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

async function* walkDir(dirHandle) {
  for await (const [, handle] of dirHandle.entries()) {
    if (handle.kind === 'file') yield await handle.getFile();
    else if (handle.kind === 'directory') yield* walkDir(handle);
  }
}

async function onFilesChosen(fileList) {
  const incoming = [...fileList].filter(f => SUPPORTED.includes(f.name.split('.').pop().toLowerCase()));
  if (!incoming.length) { toast('No supported audio files', 'warn'); return; }
  els.emptyScreen.hidden = true;

  const before = state.tracks.length;
  for (const file of incoming) {
    state.tracks.push({
      id: cryptoId(),
      file,
      name: file.name,
      ext: file.name.split('.').pop().toLowerCase(),
      meta: null, art: null, drValue: null, hiRes: null,
    });
  }
  applyFilter();
  scheduleRender();
  updateCounts();

  // Bulk cache lookup
  const keys = incoming.map(f => fileKey(f));
  const cached = await cache.getMetaBatch(keys);
  let cachedHits = 0;
  for (let i = 0; i < incoming.length; i++) {
    const m = cached.get(keys[i]);
    if (m) {
      state.tracks[before + i].meta = m;
      cachedHits++;
    }
  }

  let done = cachedHits;
  const total = incoming.length;
  const CONCURRENCY = 6;
  const BATCH_FLUSH = 50;
  const pendingWrites = [];

  const flushWrites = async () => {
    if (!pendingWrites.length) return;
    const batch = pendingWrites.splice(0, pendingWrites.length);
    await cache.setMetaBatch(batch);
  };

  const queue = [];
  for (let i = 0; i < incoming.length; i++) {
    if (state.tracks[before + i].meta) continue;
    queue.push(i);
  }

  let next = 0;
  const work = async () => {
    while (next < queue.length) {
      const i = queue[next++];
      const file = incoming[i];
      const t = state.tracks[before + i];
      try {
        const result = await metadataPool.parse(file, false);
        t.meta = result.meta;
        pendingWrites.push([keys[i], result.meta]);
      } catch {
        t.meta = { format: file.name.split('.').pop().toUpperCase() };
      }
      done++;
      if (pendingWrites.length >= BATCH_FLUSH) flushWrites();
    }
  };
  const workers = [];
  for (let w = 0; w < CONCURRENCY; w++) workers.push(work());
  await Promise.all(workers);
  await flushWrites();

  rebuildAggregations();
  applyFilter();
  scheduleRender();
  updateCounts();
  toast(`Added ${incoming.length} track${incoming.length>1?'s':''}`, 'ok');
}

// ============ Aggregations (albums + artists) ============
function rebuildAggregations() {
  const albumMap = new Map();
  for (let i = 0; i < state.tracks.length; i++) {
    const t = state.tracks[i];
    const m = t.meta || {};
    const album = m.album || 'Unknown Album';
    const artist = m.albumArtist || m.artist || 'Unknown Artist';
    const key = `${album}|${artist}`;
    let a = albumMap.get(key);
    if (!a) {
      a = { key, title: album, artist, year: m.year || m.originalYear || '', trackIndices: [], art: null };
      albumMap.set(key, a);
    }
    a.trackIndices.push(i);
    if (!a.art && t.art) a.art = t.art;
  }
  state.albums = [...albumMap.values()].sort((a, b) => {
    if (a.artist !== b.artist) return a.artist.localeCompare(b.artist);
    return a.title.localeCompare(b.title);
  });

  const artistMap = new Map();
  for (const a of state.albums) {
    let ar = artistMap.get(a.artist);
    if (!ar) {
      ar = { name: a.artist, albumKeys: [], trackIndices: [], art: null };
      artistMap.set(a.artist, ar);
    }
    ar.albumKeys.push(a.key);
    ar.trackIndices.push(...a.trackIndices);
    if (!ar.art && a.art) ar.art = a.art;
  }
  state.artists = [...artistMap.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function updateCounts() {
  els.navCountTracks.textContent = state.tracks.length;
  els.navCountAlbums.textContent = state.albums.length;
  els.navCountArtists.textContent = state.artists.length;
  els.navCountQueue.textContent = state.queue.length;
}

// ============ Tracks (virtualized) ============
function applyFilter() {
  const q = els.searchInput.value.trim().toLowerCase();
  if (!q) state.filtered = state.tracks.map((_, i) => i);
  else {
    state.filtered = [];
    for (let i = 0; i < state.tracks.length; i++) {
      const t = state.tracks[i];
      const m = t.meta || {};
      const hay = `${m.title||''} ${m.artist||''} ${m.album||''} ${t.name}`.toLowerCase();
      if (hay.includes(q)) state.filtered.push(i);
    }
  }
}

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (virtualList) virtualList.setItems(state.filtered);
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
  const sr = m.sampleRate ? formatSRShort(m.sampleRate) : '';
  const dur = m.duration ? formatTime(m.duration) : '';

  el.classList.toggle('playing', trackIdx === state.currentIdx);

  if (!el._refs) {
    el.innerHTML = `
      <span class="t-num"></span>
      <div class="t-art"></div>
      <div class="t-title"></div>
      <div class="t-artist"></div>
      <div class="t-album"></div>
      <div class="t-fmt"></div>
      <div class="t-sr"></div>
      <div class="t-dr"></div>
      <div class="t-dur"></div>
    `;
    el._refs = {
      num: el.querySelector('.t-num'),
      art: el.querySelector('.t-art'),
      title: el.querySelector('.t-title'),
      artist: el.querySelector('.t-artist'),
      album: el.querySelector('.t-album'),
      fmt: el.querySelector('.t-fmt'),
      sr: el.querySelector('.t-sr'),
      dr: el.querySelector('.t-dr'),
      dur: el.querySelector('.t-dur'),
    };
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      const realIdx = state.filtered[idx];
      if (realIdx === state.currentIdx) togglePlay();
      else playIndex(realIdx);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const idx = parseInt(el.dataset.idx);
      const realIdx = state.filtered[idx];
      openContextMenu(e.clientX, e.clientY, realIdx);
    });
  }
  const r = el._refs;
  r.num.textContent = String(listPos + 1).padStart(3, '0');
  r.art.style.backgroundImage = t.art ? `url(${t.art})` : '';
  if (!t.art && !t._artTried && m.hasArt) queueArtLoad(t);
  r.title.textContent = title;
  r.artist.textContent = artist;
  r.album.textContent = album;
  r.fmt.textContent = fmt;
  r.fmt.className = 't-fmt' + (t.hiRes?.verdict === 'true' ? ' hires' : t.hiRes?.verdict === 'fake' ? ' fake' : '');
  r.sr.textContent = sr;
  if (t.drValue != null) {
    r.dr.textContent = `DR${t.drValue}`;
    r.dr.className = 't-dr ' + (t.drValue >= 14 ? 'drhi' : t.drValue >= 8 ? 'drmid' : 'drlow');
  } else {
    r.dr.textContent = '';
    r.dr.className = 't-dr';
  }
  r.dur.textContent = dur;
}

// ============ Lazy art ============
const artQueue = [];
let artWorkerRunning = false;
function queueArtLoad(t) {
  if (t._artTried || t._artQueued) return;
  t._artQueued = true;
  artQueue.push(t);
  if (!artWorkerRunning) runArtWorker();
}
async function runArtWorker() {
  artWorkerRunning = true;
  while (artQueue.length) {
    const t = artQueue.shift();
    if (t.art || t._artTried) continue;
    t._artTried = true;
    try {
      const cachedArt = await cache.getArt(t.file);
      if (cachedArt) {
        const url = URL.createObjectURL(cachedArt);
        t.art = url;
        state.artUrls.add(url);
        scheduleRender();
        propagateArtToAggregations(t);
        continue;
      }
      const result = await metadataPool.parse(t.file, true);
      if (result.artBlob) {
        const url = URL.createObjectURL(result.artBlob);
        t.art = url;
        state.artUrls.add(url);
        cache.setArt(t.file, result.artBlob);
        scheduleRender();
        propagateArtToAggregations(t);
      }
    } catch {}
  }
  artWorkerRunning = false;
}

function propagateArtToAggregations(t) {
  const m = t.meta || {};
  const albumKey = `${m.album||'Unknown Album'}|${m.albumArtist||m.artist||'Unknown Artist'}`;
  const album = state.albums.find(a => a.key === albumKey);
  if (album && !album.art) {
    album.art = t.art;
    const tile = els.albumGrid.querySelector(`[data-key="${CSS.escape(albumKey)}"] .album-cover`);
    if (tile) tile.style.backgroundImage = `url(${t.art})`;
  }
  const artistName = m.albumArtist || m.artist || 'Unknown Artist';
  const artist = state.artists.find(a => a.name === artistName);
  if (artist && !artist.art) {
    artist.art = t.art;
    const tile = els.artistGrid.querySelector(`[data-name="${CSS.escape(artistName)}"] .artist-circle`);
    if (tile) tile.style.backgroundImage = `url(${t.art})`;
  }
}

// ============ Albums view ============
function renderAlbums() {
  els.albumGrid.innerHTML = '';
  if (!state.albums.length) {
    els.albumGrid.innerHTML = '<div style="color:var(--ink-mute);padding:40px;">No albums yet — open a folder.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const album of state.albums) {
    const tile = document.createElement('div');
    tile.className = 'album-tile';
    tile.dataset.key = album.key;
    tile.innerHTML = `
      <div class="album-cover" style="${album.art ? `background-image:url(${album.art})` : ''}">
        <div class="album-play">
          <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4 20,12 7,20"/></svg>
        </div>
      </div>
      <div class="album-title"></div>
      <div class="album-artist"></div>
    `;
    tile.querySelector('.album-title').textContent = album.title;
    tile.querySelector('.album-artist').textContent = album.artist;
    tile.addEventListener('click', (e) => {
      if (e.target.closest('.album-play')) {
        playAlbum(album);
      } else {
        openAlbumPanel(album);
      }
    });
    // Lazy-load art for first track if not yet loaded
    if (!album.art && album.trackIndices.length) {
      const firstTrack = state.tracks[album.trackIndices[0]];
      if (firstTrack && !firstTrack._artTried) queueArtLoad(firstTrack);
    }
    frag.appendChild(tile);
  }
  els.albumGrid.appendChild(frag);
}

function openAlbumPanel(album) {
  state.currentSpAlbumKey = album.key;
  els.sidePanel.hidden = false;
  els.spArt.style.backgroundImage = album.art ? `url(${album.art})` : '';
  els.spTitle.textContent = album.title;
  els.spArtist.textContent = album.artist;
  const totalDur = album.trackIndices.reduce((s, i) => s + (state.tracks[i]?.meta?.duration || 0), 0);
  els.spInfo.textContent = `${album.trackIndices.length} tracks · ${formatTime(totalDur)}${album.year ? ` · ${album.year}` : ''}`;
  els.spTracks.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let n = 0; n < album.trackIndices.length; n++) {
    const trackIdx = album.trackIndices[n];
    const t = state.tracks[trackIdx];
    if (!t) continue;
    const m = t.meta || {};
    const row = document.createElement('div');
    row.className = 'sp-track' + (trackIdx === state.currentIdx ? ' playing' : '');
    row.innerHTML = `
      <span class="sp-track-num">${m.trackNo || (n+1)}</span>
      <span class="sp-track-title"></span>
      <span class="sp-track-fmt">${(m.format||t.ext).toUpperCase()}</span>
      <span class="sp-track-dur">${m.duration ? formatTime(m.duration) : ''}</span>
    `;
    row.querySelector('.sp-track-title').textContent = m.title || stripExt(t.name);
    row.addEventListener('click', () => playIndex(trackIdx));
    frag.appendChild(row);
  }
  els.spTracks.appendChild(frag);
  els.spPlay.onclick = () => playAlbum(album);
  els.spAddQueue.onclick = () => { addToQueue(album.trackIndices); toast(`Added ${album.trackIndices.length} tracks to queue`, 'ok'); };
}
els.sidePanelClose.addEventListener('click', () => { els.sidePanel.hidden = true; state.currentSpAlbumKey = null; });

function playAlbum(album) {
  if (!album.trackIndices.length) return;
  playIndex(album.trackIndices[0]);
  // queue the rest
  state.queue = album.trackIndices.slice(1).map(i => state.tracks[i].id);
  saveQueue();
  updateCounts();
}

// ============ Artists view ============
function renderArtists() {
  els.artistGrid.innerHTML = '';
  if (!state.artists.length) {
    els.artistGrid.innerHTML = '<div style="color:var(--ink-mute);padding:40px;">No artists yet.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const artist of state.artists) {
    const tile = document.createElement('div');
    tile.className = 'artist-tile';
    tile.dataset.name = artist.name;
    tile.innerHTML = `
      <div class="artist-circle" style="${artist.art ? `background-image:url(${artist.art})` : ''}"></div>
      <div class="artist-name"></div>
      <div class="artist-sub">${artist.albumKeys.length} album${artist.albumKeys.length===1?'':'s'}</div>
    `;
    tile.querySelector('.artist-name').textContent = artist.name;
    tile.addEventListener('click', () => filterToArtist(artist));
    frag.appendChild(tile);
  }
  els.artistGrid.appendChild(frag);
}
function filterToArtist(artist) {
  els.searchInput.value = artist.name;
  applyFilter();
  scheduleRender();
  setView('tracks');
}

// ============ Queue ============
async function loadQueue() {
  try {
    const q = await cache.getMeta({ name: '__queue__', size: 0, lastModified: 0 });
    if (Array.isArray(q)) state.queue = q;
  } catch {}
}
async function saveQueue() {
  try {
    await cache.setMeta({ name: '__queue__', size: 0, lastModified: 0 }, state.queue);
  } catch {}
}
function addToQueue(trackIndicesOrIds) {
  const items = Array.isArray(trackIndicesOrIds) ? trackIndicesOrIds : [trackIndicesOrIds];
  for (const it of items) {
    const id = typeof it === 'number' ? state.tracks[it]?.id : it;
    if (id) state.queue.push(id);
  }
  saveQueue();
  updateCounts();
}

function renderQueue() {
  if (!state.queue.length) {
    els.queueList.style.display = 'none';
    els.queueEmpty.hidden = false;
    els.queueSub.textContent = 'No tracks queued';
    return;
  }
  els.queueList.style.display = '';
  els.queueEmpty.hidden = true;
  els.queueSub.textContent = `${state.queue.length} track${state.queue.length===1?'':'s'} queued`;
  els.queueList.innerHTML = '';
  const frag = document.createDocumentFragment();
  const idMap = new Map(state.tracks.map((t, i) => [t.id, i]));
  for (let n = 0; n < state.queue.length; n++) {
    const trackIdx = idMap.get(state.queue[n]);
    if (trackIdx == null) continue;
    const t = state.tracks[trackIdx];
    const m = t.meta || {};
    const row = document.createElement('div');
    row.className = 'sp-track';
    row.innerHTML = `
      <span class="sp-track-num">${n+1}</span>
      <span class="sp-track-title"></span>
      <span class="sp-track-fmt">${(m.format||t.ext).toUpperCase()}</span>
      <span class="sp-track-dur">${m.duration ? formatTime(m.duration) : ''}</span>
    `;
    row.querySelector('.sp-track-title').textContent = (m.title || stripExt(t.name)) + (m.artist ? ` — ${m.artist}` : '');
    row.addEventListener('click', () => playIndex(trackIdx));
    frag.appendChild(row);
  }
  els.queueList.appendChild(frag);
}
els.btnQueueClear.addEventListener('click', () => { state.queue = []; saveQueue(); renderQueue(); updateCounts(); });
els.btnQueueShuffle.addEventListener('click', () => {
  for (let i = state.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
  }
  saveQueue();
  renderQueue();
});

// ============ Context menu ============
let ctxTrackIdx = -1;
function openContextMenu(x, y, trackIdx) {
  ctxTrackIdx = trackIdx;
  els.ctxMenu.hidden = false;
  els.ctxMenu.style.left = x + 'px';
  els.ctxMenu.style.top = y + 'px';
}
els.ctxMenu.addEventListener('click', (e) => {
  const action = e.target.closest('.cm-item')?.dataset?.action;
  if (!action || ctxTrackIdx < 0) { els.ctxMenu.hidden = true; return; }
  const t = state.tracks[ctxTrackIdx];
  if (action === 'play') playIndex(ctxTrackIdx);
  else if (action === 'queue') { addToQueue(ctxTrackIdx); toast('Added to queue', 'ok'); }
  else if (action === 'queue-next') {
    state.queue.unshift(t.id);
    saveQueue();
    updateCounts();
    toast('Will play next', 'ok');
  }
  else if (action === 'album') {
    const m = t.meta || {};
    const key = `${m.album||'Unknown Album'}|${m.albumArtist||m.artist||'Unknown Artist'}`;
    const album = state.albums.find(a => a.key === key);
    if (album) { setView('albums'); openAlbumPanel(album); }
  }
  else if (action === 'artist') {
    const m = t.meta || {};
    const artist = state.artists.find(a => a.name === (m.albumArtist || m.artist));
    if (artist) filterToArtist(artist);
  }
  els.ctxMenu.hidden = true;
});
document.addEventListener('click', (e) => {
  if (!els.ctxMenu.contains(e.target) && !els.ctxMenu.hidden) els.ctxMenu.hidden = true;
});

// ============ Playback ============
async function playIndex(idx) {
  if (idx < 0 || idx >= state.tracks.length) return;
  const t = state.tracks[idx];
  if (!t) return;
  if (!t.meta) {
    try {
      const result = await metadataPool.parse(t.file, false);
      t.meta = result.meta;
    } catch {
      t.meta = { format: t.ext.toUpperCase() };
    }
  }
  if (!t.art && !t._artTried) queueArtLoad(t);

  try {
    await engine.ensure(t.meta.sampleRate || null);
    if (!engine.onTrackEnd) {
      engine.onTrackEnd = onTrackEnded;
      engine.onTimeUpdate = onTimeUpdate;
      startSpectrum();
    }
    const rg = t.meta.rgTrackGain;
    engine.setReplayGain(rg ?? 0, !!state.useReplayGain && rg != null);
    const buffer = await engine.decode(t.file);
    await engine.playBuffer(buffer, t.id, t.meta.sampleRate || buffer.sampleRate);

    state.currentIdx = idx;
    updateNowPlaying(t, buffer);
    updateSignalChain(t);
    updatePlayButton(true);
    runAnalyses(t, buffer);
    scheduleGapless(idx, buffer);
    scheduleRender();
    if (state.view === 'now') updateNowView();
  } catch (e) {
    console.error(e);
    toast(`Playback failed: ${e.message}`, 'warn');
    updatePlayButton(false);
  }
}

async function scheduleGapless(idx, buffer) {
  if (!state.gapless) return;
  if (buffer.duration < 6) return;
  const wait = (buffer.duration - 5) * 1000;
  setTimeout(async () => {
    if (state.currentIdx !== idx) return;
    const nextIdx = computeNextIdx(idx);
    if (nextIdx < 0 || nextIdx === idx) return;
    const nt = state.tracks[nextIdx];
    if (!nt || !nt.meta) return;
    if (nt.meta.sampleRate && nt.meta.sampleRate !== engine.ctx.sampleRate) return;
    try {
      const nb = await engine.decode(nt.file);
      if (state.currentIdx !== idx) return;
      engine.scheduleNext(nb, nt.id);
      const delay = Math.max(0, (engine.nextScheduledAt - engine.ctx.currentTime) * 1000);
      setTimeout(() => {
        if (engine.currentTrackId === nt.id) {
          state.currentIdx = nextIdx;
          updateNowPlaying(nt, nb);
          updateSignalChain(nt);
          runAnalyses(nt, nb);
          scheduleRender();
          scheduleGapless(nextIdx, nb);
        }
      }, delay + 10);
    } catch {}
  }, wait);
}

function onTrackEnded() {
  if (engine.currentSource) return;
  if (state.repeat === 'one') { playIndex(state.currentIdx); return; }
  playNext();
}

function onTimeUpdate(cur, dur) {
  if (!isFinite(dur)) return;
  const pct = cur / dur;
  els.scrubFill.style.width = (pct * 100) + '%';
  els.scrubKnob.style.left = (pct * 100) + '%';
  els.timeCur.textContent = formatTime(cur);
  els.timeTot.textContent = formatTime(dur);
}

function computeNextIdx(fromIdx) {
  if (state.queue.length) {
    const idMap = new Map(state.tracks.map((t, i) => [t.id, i]));
    const next = state.queue.shift();
    saveQueue();
    updateCounts();
    return idMap.get(next) ?? -1;
  }
  if (state.shuffle) {
    if (!state.shuffleBag.length) state.shuffleBag = makeShuffleBag(fromIdx);
    return state.shuffleBag.shift() ?? -1;
  }
  let n = fromIdx + 1;
  if (n >= state.tracks.length) return state.repeat === 'all' ? 0 : -1;
  return n;
}
function makeShuffleBag(exclude) {
  const all = state.tracks.map((_, i) => i).filter(i => i !== exclude);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

function playNext() {
  if (!state.tracks.length) return;
  const next = computeNextIdx(state.currentIdx);
  if (next < 0) { engine.pause(); updatePlayButton(false); return; }
  playIndex(next);
}
function playPrev() {
  if (engine.getCurrentTime() > 3) { engine.seek(0); return; }
  let p = state.currentIdx - 1;
  if (p < 0) p = state.tracks.length - 1;
  playIndex(p);
}
function togglePlay() {
  if (state.currentIdx < 0) {
    if (state.filtered.length) playIndex(state.filtered[0]);
    return;
  }
  if (engine.playing) { engine.pause(); updatePlayButton(false); }
  else { engine.resume(); updatePlayButton(true); }
}
function updatePlayButton(playing) {
  els.iconPlay.style.display = playing ? 'none' : '';
  els.iconPause.style.display = playing ? '' : 'none';
}

els.btnPlay.addEventListener('click', togglePlay);
els.btnPrev.addEventListener('click', playPrev);
els.btnNext.addEventListener('click', playNext);
els.btnShuffle.addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  els.btnShuffle.setAttribute('aria-pressed', state.shuffle);
  state.shuffleBag = state.shuffle ? makeShuffleBag(state.currentIdx) : [];
});
els.btnRepeat.addEventListener('click', () => {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  els.btnRepeat.setAttribute('aria-pressed', state.repeat !== 'off');
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
  if (t?.meta?.rgTrackGain != null) engine.setReplayGain(t.meta.rgTrackGain, state.useReplayGain);
});
els.scrubBar.addEventListener('click', (e) => {
  const dur = engine.getDuration();
  if (!isFinite(dur) || dur <= 0) return;
  const rect = els.scrubBar.getBoundingClientRect();
  engine.seek(((e.clientX - rect.left) / rect.width) * dur);
});
els.volSlider.addEventListener('input', () => {
  const v = els.volSlider.value / 100;
  engine.setVolume(v);
  els.volPct.textContent = els.volSlider.value;
});

// ============ Now playing UI ============
function updateNowPlaying(t, buffer) {
  const m = t.meta || {};
  const title = m.title || stripExt(t.name);
  const artist = m.artist || '—';
  els.npTitle.textContent = title;
  els.npArtist.textContent = artist;
  els.npArt.style.backgroundImage = t.art ? `url(${t.art})` : '';
  updateNowView();
}

function updateNowView() {
  const idx = state.currentIdx;
  if (idx < 0) {
    els.nowTitle.textContent = 'Nothing playing';
    els.nowArtist.textContent = '—';
    els.nowAlbum.textContent = '—';
    els.nsFormat.textContent = '—';
    els.nsRate.textContent = '—';
    els.nsBits.textContent = '—';
    els.nsChans.textContent = '—';
    els.nsDR.textContent = '—';
    els.nsHiRes.textContent = '—';
    els.nowArt.style.backgroundImage = '';
    els.nowArtGlow.style.backgroundImage = '';
    return;
  }
  const t = state.tracks[idx];
  const m = t.meta || {};
  els.nowTitle.textContent = m.title || stripExt(t.name);
  els.nowArtist.textContent = m.artist || '—';
  els.nowAlbum.textContent = (m.album || '').toUpperCase();
  els.nsFormat.textContent = (m.format || t.ext).toUpperCase();
  els.nsRate.textContent = m.sampleRate ? formatSR(m.sampleRate) : '—';
  els.nsBits.textContent = m.bitDepth ? `${m.bitDepth}-bit` : (m.isDsd ? '1-bit DSD' : '—');
  els.nsChans.textContent = m.channels || '—';
  els.nsDR.textContent = t.drValue != null ? `DR${t.drValue}` : '—';
  els.nsHiRes.textContent = t.hiRes ? t.hiRes.label : '—';
  if (t.art) {
    els.nowArt.style.backgroundImage = `url(${t.art})`;
    els.nowArtGlow.style.backgroundImage = `url(${t.art})`;
  } else {
    els.nowArt.style.backgroundImage = '';
    els.nowArtGlow.style.backgroundImage = '';
  }
  renderVerdicts(t, els.nowVerdicts);
}

function renderVerdicts(t, container) {
  const out = [];
  if (t.hiRes) {
    if (t.hiRes.verdict === 'true') out.push({ cls: 'ok', label: 'HI-RES VERIFIED' });
    else if (t.hiRes.verdict === 'fake') out.push({ cls: 'bad', label: t.hiRes.label });
  }
  if (t.drValue != null) {
    const cls = t.drValue >= 14 ? 'ok' : t.drValue >= 8 ? 'warn' : 'bad';
    out.push({ cls, label: `DR ${t.drValue}` });
  }
  container.innerHTML = out.map(v => `<span class="verdict ${v.cls}">${v.label}</span>`).join('');
}

function updateSignalChain(t) {
  const m = t.meta || {};
  const fileRate = m.sampleRate;
  const engineRate = engine.ctx ? engine.ctx.sampleRate : null;
  els.chainFile.textContent = fileRate ? formatSRShort(fileRate) : '—';
  els.chainEngine.textContent = engineRate ? formatSRShort(engineRate) : '—';
  els.chainOutput.textContent = engineRate ? formatSRShort(engineRate) : '—';
  els.signalChain.classList.remove('match-ok', 'match-warn');
  if (fileRate && engineRate) {
    els.signalChain.classList.add(fileRate === engineRate ? 'match-ok' : 'match-warn');
  }
}

// ============ Spectrum ============
function startSpectrum() {
  if (spectrumAnim) return;
  const canvas = els.spectrum;
  const g = canvas.getContext('2d', { alpha: false });
  let grad = null;
  let lastW = 0, lastH = 0;
  let fftBuf = null;

  const draw = () => {
    spectrumAnim = requestAnimationFrame(draw);
    if (state.view !== 'now') return;
    if (!engine.analyser) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w !== lastW || h !== lastH) {
      canvas.width = w * dpr; canvas.height = h * dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      grad = g.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, '#3a2a14');
      grad.addColorStop(0.6, '#ffb454');
      grad.addColorStop(1, '#ffd278');
      lastW = w; lastH = h;
    }
    if (!fftBuf || fftBuf.length !== engine.analyser.frequencyBinCount) {
      fftBuf = new Uint8Array(engine.analyser.frequencyBinCount);
    }
    engine.analyser.getByteFrequencyData(fftBuf);
    g.fillStyle = '#141414'; g.fillRect(0, 0, w, h);
    const sampleRate = engine.ctx ? engine.ctx.sampleRate : 48000;
    const nyquist = sampleRate / 2;
    const minF = 20, maxF = Math.min(20000, nyquist);
    const logMin = Math.log10(minF), logMax = Math.log10(maxF);
    const cols = Math.max(60, Math.floor(w / 4));
    const colW = w / cols;
    g.fillStyle = grad;
    g.beginPath();
    for (let c = 0; c < cols; c++) {
      const f0 = Math.pow(10, logMin + (c/cols)*(logMax-logMin));
      const f1 = Math.pow(10, logMin + ((c+1)/cols)*(logMax-logMin));
      const b0 = Math.floor((f0 / nyquist) * fftBuf.length);
      const b1 = Math.max(b0+1, Math.floor((f1 / nyquist) * fftBuf.length));
      let sum = 0, n = 0;
      for (let b = b0; b < b1 && b < fftBuf.length; b++) { sum += fftBuf[b]; n++; }
      const amp = (n ? sum/n : 0) / 255;
      const barH = Math.pow(amp, 0.85) * (h - 4);
      g.rect(c*colW + 0.5, h - barH, colW - 1, barH);
    }
    g.fill();
  };
  draw();
}

// ============ Analyses (DR + hi-res) ============
async function runAnalyses(t, buffer) {
  if (t.drValue == null) {
    setTimeout(() => {
      try {
        let dr = null;
        if (core.available) {
          const inter = interleave(buffer);
          dr = core.computeDR(inter, buffer.sampleRate, buffer.numberOfChannels);
        }
        if (dr == null) {
          const ch = [];
          for (let i = 0; i < buffer.numberOfChannels; i++) ch.push(buffer.getChannelData(i));
          dr = computeDR(ch, buffer.sampleRate);
        }
        t.drValue = dr;
        if (t === state.tracks[state.currentIdx]) updateNowView();
        scheduleRender();
        if (t.meta) { t.meta._dr = dr; cache.setMeta(t.file, t.meta); }
      } catch (e) { console.warn('DR failed', e); }
    }, 50);
  }
  if (t.hiRes == null) {
    setTimeout(() => {
      try {
        let v = null;
        if (core.available) {
          const inter = interleave(buffer);
          v = core.analyzeHiRes(inter, buffer.sampleRate, buffer.numberOfChannels, t.meta?.sampleRate || buffer.sampleRate, t.meta?.bitDepth || 16);
        }
        if (v == null) {
          const ch = [];
          for (let i = 0; i < buffer.numberOfChannels; i++) ch.push(buffer.getChannelData(i));
          v = analyzeHiRes(ch, buffer.sampleRate, t.meta?.bitDepth || 16, t.meta?.sampleRate || buffer.sampleRate);
        }
        t.hiRes = v;
        if (t === state.tracks[state.currentIdx]) updateNowView();
        scheduleRender();
        if (t.meta) { t.meta._hiRes = v; cache.setMeta(t.file, t.meta); }
      } catch (e) { console.warn('hi-res failed', e); }
    }, 150);
  }
}
function interleave(buffer) {
  const ch = buffer.numberOfChannels, len = buffer.length;
  const out = new Float32Array(ch * len);
  if (ch === 1) { out.set(buffer.getChannelData(0)); return out; }
  const c0 = buffer.getChannelData(0), c1 = buffer.getChannelData(1);
  for (let i = 0; i < len; i++) { out[i*2] = c0[i]; out[i*2+1] = c1[i]; }
  return out;
}

// ============ Measurement ============
els.badgeMeasured.addEventListener('click', async () => {
  if (!engine.ctx) { toast('Play something first', 'warn'); return; }
  els.badgeMeasured.classList.add('measuring');
  els.badgeMeasuredLabel.textContent = 'Measuring…';
  try {
    const r = await measureSignalPath(engine.ctx);
    state.measured = r;
    els.badgeMeasured.classList.remove('measuring');
    if (r.clean) {
      els.badgeMeasured.classList.add('measured');
      els.badgeMeasuredLabel.textContent = `Clean ${r.thdnDb.toFixed(0)}dB`;
    } else {
      els.badgeMeasured.classList.add('failed');
      els.badgeMeasuredLabel.textContent = `THD+N ${r.thdnDb.toFixed(0)}dB`;
    }
  } catch (e) {
    els.badgeMeasured.classList.remove('measuring');
    toast('Measurement failed', 'warn');
  }
});

// ============ Scan ============
els.btnScan.addEventListener('click', async () => {
  if (!state.tracks.length) { toast('Open a folder first', 'warn'); return; }
  toast(`Scanning ${state.tracks.length} tracks — this takes a while`, 'ok');
  for (const t of state.tracks.slice()) {
    if (t.drValue != null && t.hiRes != null) continue;
    if (!t.meta) continue;
    try {
      if (!engine.ctx) await engine.ensure(t.meta.sampleRate || null);
      const buffer = await engine.decode(t.file);
      await new Promise(r => setTimeout(r, 0));
      runAnalyses(t, buffer);
    } catch {}
  }
  toast('Scan complete', 'ok');
});

// ============ Search ============
let searchDebounce = null;
els.searchInput.addEventListener('input', () => {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => { applyFilter(); scheduleRender(); }, 120);
});

// ============ Keyboard ============
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'KeyS') els.btnShuffle.click();
  else if (e.code === 'KeyR') els.btnRepeat.click();
  else if (e.code === 'ArrowRight' && e.shiftKey) playNext();
  else if (e.code === 'ArrowLeft' && e.shiftKey) playPrev();
  else if (e.code === 'ArrowRight') engine.seek(Math.min(engine.getDuration(), engine.getCurrentTime() + 5));
  else if (e.code === 'ArrowLeft') engine.seek(Math.max(0, engine.getCurrentTime() - 5));
  else if (e.code === 'Slash') { e.preventDefault(); els.searchInput.focus(); }
  else if (e.code === 'Digit1') setView('tracks');
  else if (e.code === 'Digit2') setView('albums');
  else if (e.code === 'Digit3') setView('artists');
  else if (e.code === 'Digit4') setView('queue');
  else if (e.code === 'Digit5') setView('now');
});

// ============ Helpers ============
function cryptoId() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2); }
function stripExt(name) { return name.replace(/\.[^.]+$/, ''); }
function formatSR(hz) {
  if (!hz) return '—';
  if (hz >= 1000) return (hz/1000).toFixed(hz%1000 === 0 ? 0 : 1) + ' kHz';
  return hz + ' Hz';
}
function formatSRShort(hz) {
  if (!hz) return '—';
  if (hz >= 1000) return (hz/1000).toFixed(hz%1000 === 0 ? 0 : 1) + 'k';
  return String(hz);
}
function formatTime(s) {
  if (!isFinite(s)) return '0:00';
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s/60);
  return `${m}:${String(s%60).padStart(2,'0')}`;
}

// ============ Init ============
function init() {
  virtualList = new VirtualList({
    scroller: els.libScroller,
    spacer: els.libSpacer,
    rows: els.libRows,
    renderRow: (el, idx, listPos) => renderTrackRow(el, idx, listPos),
  });
  virtualList.setItems([]);
  setView('tracks');

  els.navItems[0].classList.add('active');

  core.ready.then(() => {
    if (core.available) console.info('[signal] Rust core active');
    else console.info('[signal] Rust core unavailable, JS-only');
  });

  if (!state.tracks.length) els.emptyScreen.hidden = false;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  loadQueue().then(() => updateCounts());
}
init();
