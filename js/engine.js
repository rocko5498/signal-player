// ============================================================
// engine.js — the audio brain.
//
// Goals:
//   1. Match AudioContext sample rate to the source file when
//      possible (only on first track, or when explicitly rebuilt).
//      Web Audio doesn't allow changing sampleRate of a live
//      context, so we close+reopen between tracks when the rate
//      changes AND the user has opted in to "match source rate".
//   2. Gapless: pre-decode the next track 5s before current ends
//      and schedule it precisely after the current finishes.
//   3. Real-time meters (L/R) and spectrum analyser taps.
//   4. ReplayGain applied at the gain node (optional).
//   5. Expose hooks for: signal measurement, full-track audio
//      analysis (DR, hi-res).
// ============================================================

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.gainNode = null;
    this.analyser = null;
    this.analyserL = null;
    this.analyserR = null;
    this.splitter = null;

    this.currentSource = null;
    this.currentBuffer = null;
    this.currentStartTime = 0;     // ctx.currentTime when playback started
    this.currentStartOffset = 0;   // offset within buffer when playback started
    this.currentDuration = 0;
    this.currentSampleRate = null;
    this.currentTrackId = null;

    this.nextSource = null;
    this.nextBuffer = null;
    this.nextScheduledAt = 0;
    this.nextTrackId = null;

    this.playing = false;
    this.pausedAt = 0;             // offset to resume from

    this.volume = 0.85;
    this.replayGainDb = 0;
    this.useReplayGain = false;
    this.matchSourceRate = true;

    this.onTrackEnd = null;        // callback when a track ends naturally
    this.onTimeUpdate = null;
    this.timeUpdateRaf = null;
  }

  async ensure(targetSampleRate) {
    // Reuse existing context unless we need a different rate
    if (this.ctx && (!targetSampleRate || this.ctx.sampleRate === targetSampleRate || !this.matchSourceRate)) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    }
    // Need a new context
    if (this.ctx) {
      try { await this.ctx.close(); } catch {}
    }
    const opts = { latencyHint: 'playback' };
    if (targetSampleRate && this.matchSourceRate) opts.sampleRate = targetSampleRate;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)(opts);
    } catch (e) {
      // Browser refused requested sample rate — fall back to default
      console.warn('AudioContext rejected sampleRate', targetSampleRate, e);
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    }
    this._buildGraph();
    return this.ctx;
  }

  _buildGraph() {
    const ctx = this.ctx;
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = this._effectiveGain();

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.78;

    this.splitter = ctx.createChannelSplitter(2);
    this.analyserL = ctx.createAnalyser();
    this.analyserR = ctx.createAnalyser();
    this.analyserL.fftSize = 1024;
    this.analyserR.fftSize = 1024;
    this.analyserL.smoothingTimeConstant = 0;
    this.analyserR.smoothingTimeConstant = 0;

    this.gainNode.connect(this.analyser);
    this.gainNode.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);
    this.gainNode.connect(ctx.destination);
  }

  _effectiveGain() {
    const rgLinear = this.useReplayGain && isFinite(this.replayGainDb)
      ? Math.pow(10, this.replayGainDb / 20) : 1;
    return this.volume * rgLinear;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gainNode) this.gainNode.gain.setTargetAtTime(this._effectiveGain(), this.ctx.currentTime, 0.01);
  }

  setReplayGain(db, enabled) {
    this.replayGainDb = db;
    this.useReplayGain = !!enabled;
    if (this.gainNode) this.gainNode.gain.setTargetAtTime(this._effectiveGain(), this.ctx.currentTime, 0.01);
  }

  // Decode a file to AudioBuffer at our context rate.
  // Note: decodeAudioData may resample if source rate != ctx rate; that's
  // why we try to match rates upstream via ensure(sampleRate).
  async decode(file) {
    const ab = await file.arrayBuffer();
    return await this.ctx.decodeAudioData(ab.slice(0));
  }

  // Play a freshly-decoded buffer; replaces any current source.
  async playBuffer(buffer, trackId, sourceSampleRate) {
    if (!this.ctx) await this.ensure(sourceSampleRate);
    this._stopCurrent();
    this._cancelNext();

    this.currentBuffer = buffer;
    this.currentDuration = buffer.duration;
    this.currentSampleRate = sourceSampleRate || buffer.sampleRate;
    this.currentTrackId = trackId;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gainNode);
    src.onended = () => {
      // Only fire if this is still the current source
      if (src === this.currentSource) {
        this.currentSource = null;
        if (this.onTrackEnd) this.onTrackEnd(trackId);
      }
    };
    this.currentStartTime = this.ctx.currentTime;
    this.currentStartOffset = 0;
    src.start(0);
    this.currentSource = src;
    this.playing = true;
    this._startTimeUpdates();
  }

  // Schedule the next buffer for gapless transition.
  // Called when ~5s remain on current track. Decoded buffer must already exist.
  scheduleNext(buffer, trackId) {
    if (!this.ctx || !this.currentSource) return;
    this._cancelNext();
    const endTime = this.currentStartTime + (this.currentDuration - this.currentStartOffset);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gainNode);
    src.start(endTime);
    src.onended = () => {
      if (src === this.currentSource) {
        this.currentSource = null;
        if (this.onTrackEnd) this.onTrackEnd(trackId);
      }
    };
    this.nextSource = src;
    this.nextBuffer = buffer;
    this.nextScheduledAt = endTime;
    this.nextTrackId = trackId;

    // When current finishes, the "next" becomes "current"
    // This handler runs slightly before src.onended of the old current
    const promoteHandler = () => {
      this.currentSource = this.nextSource;
      this.currentBuffer = this.nextBuffer;
      this.currentDuration = this.nextBuffer.duration;
      this.currentSampleRate = this.nextBuffer.sampleRate;
      this.currentTrackId = this.nextTrackId;
      this.currentStartTime = this.nextScheduledAt;
      this.currentStartOffset = 0;
      this.nextSource = null;
      this.nextBuffer = null;
      this.nextTrackId = null;
      // Note: onended of the new currentSource will fire when it ends
    };
    // Schedule promotion at exactly endTime
    const delay = Math.max(0, (endTime - this.ctx.currentTime) * 1000);
    setTimeout(promoteHandler, delay);
  }

  pause() {
    if (!this.playing || !this.ctx) return;
    this.pausedAt = this.getCurrentTime();
    this._stopCurrent();
    this._cancelNext();
    this.playing = false;
    this._stopTimeUpdates();
  }

  async resume() {
    if (this.playing || !this.currentBuffer) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const offset = this.pausedAt;
    const src = this.ctx.createBufferSource();
    src.buffer = this.currentBuffer;
    src.connect(this.gainNode);
    src.onended = () => {
      if (src === this.currentSource) {
        this.currentSource = null;
        if (this.onTrackEnd) this.onTrackEnd(this.currentTrackId);
      }
    };
    this.currentStartTime = this.ctx.currentTime;
    this.currentStartOffset = offset;
    src.start(0, offset);
    this.currentSource = src;
    this.playing = true;
    this._startTimeUpdates();
  }

  seek(offsetSeconds) {
    if (!this.currentBuffer) return;
    const wasPlaying = this.playing;
    this._stopCurrent();
    this._cancelNext();
    this.pausedAt = Math.max(0, Math.min(this.currentDuration, offsetSeconds));
    if (wasPlaying) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.currentBuffer;
      src.connect(this.gainNode);
      const trackId = this.currentTrackId;
      src.onended = () => {
        if (src === this.currentSource) {
          this.currentSource = null;
          if (this.onTrackEnd) this.onTrackEnd(trackId);
        }
      };
      this.currentStartTime = this.ctx.currentTime;
      this.currentStartOffset = this.pausedAt;
      src.start(0, this.pausedAt);
      this.currentSource = src;
      this.playing = true;
    }
  }

  getCurrentTime() {
    if (!this.playing || !this.currentSource) return this.pausedAt;
    return this.currentStartOffset + (this.ctx.currentTime - this.currentStartTime);
  }

  getDuration() { return this.currentDuration; }

  _stopCurrent() {
    if (this.currentSource) {
      try { this.currentSource.onended = null; this.currentSource.stop(); } catch {}
      try { this.currentSource.disconnect(); } catch {}
      this.currentSource = null;
    }
  }
  _cancelNext() {
    if (this.nextSource) {
      try { this.nextSource.onended = null; this.nextSource.stop(); } catch {}
      try { this.nextSource.disconnect(); } catch {}
      this.nextSource = null;
      this.nextBuffer = null;
      this.nextTrackId = null;
    }
  }

  _startTimeUpdates() {
    if (this.timeUpdateRaf) return;
    const tick = () => {
      this.timeUpdateRaf = requestAnimationFrame(tick);
      if (this.onTimeUpdate) this.onTimeUpdate(this.getCurrentTime(), this.currentDuration);
    };
    this.timeUpdateRaf = requestAnimationFrame(tick);
  }
  _stopTimeUpdates() {
    if (this.timeUpdateRaf) cancelAnimationFrame(this.timeUpdateRaf);
    this.timeUpdateRaf = null;
  }
}
