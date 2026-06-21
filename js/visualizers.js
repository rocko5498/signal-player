// ============================================================
// visualizers.js — VU needle meters (SVG) + spectrum (canvas).
//
// VU ballistics:
//   - Time domain RMS converted to dB
//   - Needle position lags with first-order smoothing (~300ms rise / ~1s fall)
//   - Peak lamp lights above 0 dB and stays on for 1.5s
// ============================================================

export class Visualizers {
  constructor({ needleL, needleR, peakL, peakR, scaleL, scaleR, spectrum, engine }) {
    this.needleL = needleL;
    this.needleR = needleR;
    this.peakL = peakL;
    this.peakR = peakR;
    this.spectrum = spectrum;
    this.engine = engine;
    this.gS = spectrum.getContext('2d', { alpha: false });
    this.spectrumGradient = null;

    this.bufL = null;
    this.bufR = null;
    this.fftBuf = null;
    this.sizesS = null;

    this.angleL = -50;
    this.angleR = -50;
    this.peakTtlL = 0;
    this.peakTtlR = 0;

    this.running = false;
    this.rafId = null;
    this.lastT = 0;

    // Draw scale lines into the VU faces (once)
    this._drawScale(scaleL);
    this._drawScale(scaleR);

    window.addEventListener('resize', () => { this.sizesS = null; this.spectrumGradient = null; }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
      else this.start();
    });
  }

  _drawScale(group) {
    if (!group) return;
    // Arc from -50deg to +50deg, centered at (100, 105), radius ~85
    const cx = 100, cy = 105, r = 85;
    const ns = 'http://www.w3.org/2000/svg';
    const ticks = [
      { db: -20, label: '-20' },
      { db: -10, label: '-10' },
      { db: -5,  label: '-5'  },
      { db: -3,  label: '-3'  },
      { db: 0,   label: '0'   },
      { db: 3,   label: '+3'  },
    ];
    // Major arc
    const arcStart = polar(cx, cy, r, -50);
    const arcEnd   = polar(cx, cy, r, 50);
    const arc = document.createElementNS(ns, 'path');
    arc.setAttribute('d', `M ${arcStart.x} ${arcStart.y} A ${r} ${r} 0 0 1 ${arcEnd.x} ${arcEnd.y}`);
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', '#3a2a14');
    arc.setAttribute('stroke-width', '1');
    group.appendChild(arc);

    // Red arc from 0 dB onward
    const redStart = polar(cx, cy, r, dbToAngle(0));
    const red = document.createElementNS(ns, 'path');
    red.setAttribute('d', `M ${redStart.x} ${redStart.y} A ${r} ${r} 0 0 1 ${arcEnd.x} ${arcEnd.y}`);
    red.setAttribute('fill', 'none');
    red.setAttribute('stroke', '#ff5a3c');
    red.setAttribute('stroke-width', '1.5');
    red.setAttribute('opacity', '0.7');
    group.appendChild(red);

    for (const t of ticks) {
      const a = dbToAngle(t.db);
      const inner = polar(cx, cy, r - 5, a);
      const outer = polar(cx, cy, r + 4, a);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', inner.x);
      line.setAttribute('y1', inner.y);
      line.setAttribute('x2', outer.x);
      line.setAttribute('y2', outer.y);
      line.setAttribute('stroke', t.db >= 0 ? '#ff5a3c' : '#8c5e2a');
      line.setAttribute('stroke-width', t.db === 0 ? '1.8' : '1');
      group.appendChild(line);

      const text = document.createElementNS(ns, 'text');
      const labelPos = polar(cx, cy, r - 14, a);
      text.setAttribute('x', labelPos.x);
      text.setAttribute('y', labelPos.y);
      text.setAttribute('fill', t.db >= 0 ? '#ff5a3c' : '#8c5e2a');
      text.setAttribute('font-family', 'JetBrains Mono, monospace');
      text.setAttribute('font-size', '8');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.textContent = t.label;
      group.appendChild(text);
    }

    // "VU" engraved label
    const vuText = document.createElementNS(ns, 'text');
    vuText.setAttribute('x', cx);
    vuText.setAttribute('y', cy - 50);
    vuText.setAttribute('fill', '#5a4422');
    vuText.setAttribute('font-family', 'JetBrains Mono, monospace');
    vuText.setAttribute('font-weight', '700');
    vuText.setAttribute('font-size', '7');
    vuText.setAttribute('letter-spacing', '2');
    vuText.setAttribute('text-anchor', 'middle');
    vuText.textContent = 'VU';
    group.appendChild(vuText);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    const tick = (t) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(tick);
      const dt = Math.min(64, t - this.lastT);
      this.lastT = t;
      this._draw(dt);
    };
    this.rafId = requestAnimationFrame(tick);
  }
  pause() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  _draw(dt) {
    const e = this.engine;
    if (!e.analyser || !e.analyserL || !e.analyserR) {
      this._drawSpectrumEmpty();
      this._setNeedle(this.needleL, -50);
      this._setNeedle(this.needleR, -50);
      return;
    }

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

    this._updateNeedle('L', this.bufL, dt);
    this._updateNeedle('R', this.bufR, dt);

    this.sizesS = ensureCanvasSize(this.spectrum, this.sizesS);
    this._drawSpectrum(this.sizesS, this.fftBuf, e.ctx ? e.ctx.sampleRate : 48000);
  }

  _updateNeedle(ch, buf, dt) {
    let sumSq = 0, peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = buf[i];
      sumSq += a*a;
      const aa = a < 0 ? -a : a;
      if (aa > peak) peak = aa;
    }
    const rms = Math.sqrt(sumSq / buf.length);
    const rmsDb = toDb(rms);
    const targetAngle = dbToAngle(rmsDb);

    const curKey = ch === 'L' ? 'angleL' : 'angleR';
    const cur = this[curKey];
    // VU ballistics: 300ms rise, 1000ms fall (first-order)
    const rising = targetAngle > cur;
    const tau = rising ? 300 : 1000;
    const alpha = 1 - Math.exp(-dt / tau);
    const next = cur + (targetAngle - cur) * alpha;
    this[curKey] = next;

    const needle = ch === 'L' ? this.needleL : this.needleR;
    this._setNeedle(needle, next);

    // peak lamp
    const peakDb = toDb(peak);
    const lamp = ch === 'L' ? this.peakL : this.peakR;
    if (peakDb >= 0) {
      lamp.classList.add('on');
      if (ch === 'L') this.peakTtlL = 1500; else this.peakTtlR = 1500;
    } else {
      const ttlKey = ch === 'L' ? 'peakTtlL' : 'peakTtlR';
      this[ttlKey] -= dt;
      if (this[ttlKey] <= 0) lamp.classList.remove('on');
    }
  }

  _setNeedle(el, angle) {
    if (!el) return;
    el.setAttribute('transform', `rotate(${angle} 100 105)`);
  }

  _drawSpectrum(size, fft, sampleRate) {
    const g = this.gS;
    const { w, h } = size;
    g.fillStyle = '#050605';
    g.fillRect(0, 0, w, h);

    if (!this.spectrumGradient) {
      const grad = g.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, '#3a2a14');
      grad.addColorStop(0.55, '#ffb454');
      grad.addColorStop(1, '#ffd278');
      this.spectrumGradient = grad;
    }

    const nyquist = sampleRate / 2;
    const fftBins = fft.length;
    const minF = 20, maxF = Math.min(20000, nyquist);
    const logMin = Math.log10(minF), logMax = Math.log10(maxF);
    const cols = Math.max(60, Math.floor(w / 5));
    const colW = w / cols;

    // Gridlines
    g.strokeStyle = '#0e0e0e';
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
      const barH = Math.pow(amp, 0.85) * (h - 8);
      const x = c * colW;
      g.rect(x + 0.5, h - barH, colW - 1, barH);
    }
    g.fill();
  }

  _drawSpectrumEmpty() {
    this.sizesS = ensureCanvasSize(this.spectrum, this.sizesS);
    const g = this.gS;
    g.fillStyle = '#050605';
    g.fillRect(0, 0, this.sizesS.w, this.sizesS.h);
  }
}

// ---- math helpers ----
function dbToAngle(db) {
  // -60 dB → -50deg ; +3 dB → +50deg ; log-ish but mostly linear with knee at -20
  // Standard VU: 0 VU is at 70-80% of scale.
  const clamped = Math.max(-60, Math.min(6, db));
  // Map linearly from [-60, +6] to [-50, +50] but bias so 0 dB is near the right side
  // Use piecewise: -60..-20 → -50..-20deg, -20..0 → -20..+30deg, 0..6 → +30..+50deg
  if (clamped <= -20) return -50 + ((clamped + 60) / 40) * 30;
  if (clamped <= 0)   return -20 + ((clamped + 20) / 20) * 50;
  return 30 + ((clamped) / 6) * 20;
}
function polar(cx, cy, r, angleDeg) {
  const a = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}
function toDb(linear) {
  if (linear <= 0.00001) return -80;
  return Math.max(-80, 20 * Math.log10(linear));
}
function ensureCanvasSize(canvas, prev) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!prev || prev.w !== w || prev.h !== h || prev.dpr !== dpr) {
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    const g = canvas.getContext('2d', { alpha: false });
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h, dpr };
  }
  return prev;
}
