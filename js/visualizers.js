// ============================================================
// visualizers.js — meters + spectrum, drawn cheaply.
//
// Optimizations vs first version:
//   - Cache canvas size; only re-measure on resize event
//   - Pre-allocated buffers
//   - Single fillRect call per channel meter row
//   - Spectrum: gradient cached once, reused every frame
//   - Pause RAF when document is hidden
// ============================================================

const COLOR_GREEN = '#58c27d';
const COLOR_AMBER = '#ffb454';
const COLOR_RED = '#ff5a3c';

export class Visualizers {
  constructor({ meterL, meterR, spectrum, engine }) {
    this.meterL = meterL;
    this.meterR = meterR;
    this.spectrum = spectrum;
    this.engine = engine;

    this.gL = meterL.getContext('2d', { alpha: false });
    this.gR = meterR.getContext('2d', { alpha: false });
    this.gS = spectrum.getContext('2d', { alpha: false });
    this.spectrumGradient = null;

    this.bufL = null;
    this.bufR = null;
    this.fftBuf = null;

    this.sizesL = null;
    this.sizesR = null;
    this.sizesS = null;

    this.peakHold = { L: -80, R: -80, ttlL: 0, ttlR: 0 };

    this.running = false;
    this.rafId = null;

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
      else this.start();
    });
  }

  _onResize() {
    this.sizesL = this.sizesR = this.sizesS = null;
    this.spectrumGradient = null;
  }

  _ensureSize(canvas, sizes) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!sizes || sizes.w !== w || sizes.h !== h || sizes.dpr !== dpr) {
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      const g = canvas.getContext('2d', { alpha: false });
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h, dpr };
    }
    return sizes;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(tick);
      this._draw();
    };
    this.rafId = requestAnimationFrame(tick);
  }
  pause() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  _draw() {
    const e = this.engine;
    if (!e.analyser || !e.analyserL || !e.analyserR) {
      this._drawEmpty();
      return;
    }

    // Lazy buf alloc / size match
    if (!this.bufL || this.bufL.length !== e.analyserL.fftSize) {
      this.bufL = new Float32Array(e.analyserL.fftSize);
      this.bufR = new Float32Array(e.analyserR.fftSize);
    }
    if (!this.fftBuf || this.fftBuf.length !== e.analyser.frequencyBinCount) {
      this.fftBuf = new Uint8Array(e.analyser.frequencyBinCount);
    }

    e.analyserL.getFloatTimeDomainData(this.bufL);
    e.analyserR.getFloatTimeDomainData(this.bufR);
    e.analyser.getByteFrequencyData(this.fftBuf);

    this.sizesL = this._ensureSize(this.meterL, this.sizesL);
    this.sizesR = this._ensureSize(this.meterR, this.sizesR);
    this.sizesS = this._ensureSize(this.spectrum, this.sizesS);

    this._drawMeter(this.gL, this.sizesL, this.bufL, 'L');
    this._drawMeter(this.gR, this.sizesR, this.bufR, 'R');
    this._drawSpectrum(this.gS, this.sizesS, this.fftBuf, e.ctx ? e.ctx.sampleRate : 48000);
  }

  _drawEmpty() {
    this.sizesL = this._ensureSize(this.meterL, this.sizesL);
    this.sizesR = this._ensureSize(this.meterR, this.sizesR);
    this.sizesS = this._ensureSize(this.spectrum, this.sizesS);
    this.gL.fillStyle = '#050505';
    this.gR.fillStyle = '#050505';
    this.gS.fillStyle = '#050505';
    this.gL.fillRect(0, 0, this.sizesL.w, this.sizesL.h);
    this.gR.fillRect(0, 0, this.sizesR.w, this.sizesR.h);
    this.gS.fillRect(0, 0, this.sizesS.w, this.sizesS.h);
  }

  _drawMeter(g, size, buf, ch) {
    const { w, h } = size;
    g.fillStyle = '#050505';
    g.fillRect(0, 0, w, h);

    // RMS + peak
    let sumSq = 0, peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = buf[i];
      sumSq += a*a;
      const aa = a < 0 ? -a : a;
      if (aa > peak) peak = aa;
    }
    const rms = Math.sqrt(sumSq / buf.length);
    const rmsDb = toDb(rms);
    const peakDb = toDb(peak);

    const dbToX = (db) => {
      const min = -60, max = 3;
      const t = (Math.max(min, Math.min(max, db)) - min) / (max - min);
      return Math.pow(t, 0.85) * w;
    };

    const xRms = dbToX(rmsDb);

    // Single-pass segmented bar — fewer fillRect calls
    const segW = 3, segGap = 1;
    let xGreenEnd = Math.min(xRms, w * 0.62);
    let xAmberEnd = Math.min(xRms, w * 0.82);
    let xRedEnd = xRms;

    g.fillStyle = COLOR_GREEN;
    for (let x = 0; x < xGreenEnd; x += segW + segGap) g.fillRect(x, 4, segW, h - 8);
    g.fillStyle = COLOR_AMBER;
    for (let x = xGreenEnd; x < xAmberEnd; x += segW + segGap) g.fillRect(x, 4, segW, h - 8);
    g.fillStyle = COLOR_RED;
    for (let x = xAmberEnd; x < xRedEnd; x += segW + segGap) g.fillRect(x, 4, segW, h - 8);

    // Peak hold
    const key = ch;
    if (peakDb > this.peakHold[key]) {
      this.peakHold[key] = peakDb;
      this.peakHold['ttl' + key] = 45;
    } else {
      this.peakHold['ttl' + key]--;
      if (this.peakHold['ttl' + key] < 0) this.peakHold[key] -= 0.5;
    }
    if (this.peakHold[key] > -60) {
      const xp = dbToX(this.peakHold[key]);
      g.fillStyle = this.peakHold[key] >= 0 ? COLOR_RED : COLOR_AMBER;
      g.fillRect(xp - 2, 2, 2, h - 4);
    }

    // Tick marks
    g.fillStyle = '#262624';
    const ticks = [-60,-40,-20,-12,-6,0,3];
    for (const t of ticks) {
      const x = dbToX(t);
      g.fillRect(x, h - 2, 1, 2);
    }
  }

  _drawSpectrum(g, size, fft, sampleRate) {
    const { w, h } = size;
    g.fillStyle = '#050505';
    g.fillRect(0, 0, w, h);

    if (!this.spectrumGradient) {
      const grad = g.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, '#3a2a14');
      grad.addColorStop(0.6, '#ffb454');
      grad.addColorStop(1, '#fff0d4');
      this.spectrumGradient = grad;
    }

    const nyquist = sampleRate / 2;
    const fftBins = fft.length;
    const minF = 20, maxF = Math.min(20000, nyquist);
    const logMin = Math.log10(minF), logMax = Math.log10(maxF);
    const cols = Math.max(64, Math.floor(w / 4));
    const colW = w / cols;

    // Gridlines
    g.strokeStyle = '#121211';
    g.lineWidth = 1;
    g.beginPath();
    for (const f of [100, 1000, 10000]) {
      const t = (Math.log10(f) - logMin) / (logMax - logMin);
      g.moveTo(t * w, 0);
      g.lineTo(t * w, h);
    }
    g.stroke();

    g.fillStyle = this.spectrumGradient;
    g.beginPath();
    for (let c = 0; c < cols; c++) {
      const f0 = Math.pow(10, logMin + (c / cols) * (logMax - logMin));
      const f1 = Math.pow(10, logMin + ((c + 1) / cols) * (logMax - logMin));
      const b0 = Math.floor((f0 / nyquist) * fftBins);
      const b1 = Math.max(b0 + 1, Math.floor((f1 / nyquist) * fftBins));
      let sum = 0, n = 0;
      for (let b = b0; b < b1 && b < fftBins; b++) { sum += fft[b]; n++; }
      const v = n ? sum / n : 0;
      const amp = v / 255;
      const barH = Math.pow(amp, 0.8) * (h - 6);
      const x = c * colW;
      g.rect(x + 0.5, h - barH, colW - 1, barH);
    }
    g.fill();
  }
}

function toDb(linear) {
  if (linear <= 0.00001) return -80;
  return Math.max(-80, 20 * Math.log10(linear));
}
