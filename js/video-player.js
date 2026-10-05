// Plays the original and the compressed video side by side on two canvases. Both follow one clock,
// so they always show the same moment; frames are decoded with WebCodecs through Mediabunny.
// Sound comes from one side at a time.
import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny';
import { clamp, sleep } from './ui.js';

const EPSILON = 1e-3;

/** One side of the comparison: a video file drawn onto a canvas. */
class Side {
  constructor(canvas, now) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.now = now;           // reads the shared timeline position
    this.input = null;
    this.frames = null;       // CanvasSink
    this.sound = null;        // AudioBufferSink, if the audio can be decoded
    this.offset = 0;          // timeline position of the file's time 0
    this.firstTimestamp = 0;
    this.window = null;       // [start, end] of the timeline this file covers; null for all of it
    this.covering = false;    // whether the playhead was inside `window` at the last check
    this.loadId = 0;
    this.run = 0;             // bumped to stop the frame iterator
    this.iterator = null;
    this.nextFrame = null;
    this.wanted = null;       // newest position waiting to be drawn while paused
    this.drawing = false;
  }

  covers(t) {
    return Boolean(this.frames) && (!this.window || (t >= this.window[0] - EPSILON && t < this.window[1] - EPSILON));
  }

  fileTime(t) {
    return Math.max(t - this.offset, this.firstTimestamp);
  }

  /** Opens a file (or clears the side when `blob` is null). Resolves false if a newer load replaced it. */
  async load(blob, { offset = 0, window = null } = {}) {
    const loadId = ++this.loadId;
    this.stop();
    this.input?.dispose();
    Object.assign(this, { input: null, frames: null, sound: null, offset, window, covering: false });
    if (!blob) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return false;
    }
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const [width, height, firstTimestamp, audioPlayable] = await Promise.all([
      video.getDisplayWidth(),
      video.getDisplayHeight(),
      video.getFirstTimestamp(),
      audio ? audio.canDecode() : false,
    ]);
    if (loadId !== this.loadId) {
      input.dispose();
      return false;
    }
    this.input = input;
    this.firstTimestamp = firstTimestamp;
    this.frames = new CanvasSink(video, { poolSize: 2 });
    this.sound = audioPlayable ? new AudioBufferSink(audio) : null;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    return true;
  }

  draw(frame) {
    this.ctx.drawImage(frame.canvas, 0, 0);
  }

  /** Draws the frame at timeline position t. While one is decoding, only the newest request is kept. */
  showAt(t) {
    this.covering = this.covers(t);
    this.wanted = t;
    if (this.drawing) return;
    this.drawing = true;
    (async () => {
      try {
        while (this.wanted !== null) {
          const position = this.wanted;
          this.wanted = null;
          const { frames, run } = this;
          if (!frames || !this.covers(position)) continue;
          const frame = await frames.getCanvas(this.fileTime(position) + 1e-4).catch(() => null);
          if (frame && run === this.run && frames === this.frames) this.draw(frame);
        }
      } finally {
        this.drawing = false;
      }
    })();
  }

  /** Starts streaming frames from timeline position t for playback. */
  start(t) {
    this.stop();
    this.covering = this.covers(t);
    if (!this.covering) return;
    this.iterator = this.frames.canvases(this.fileTime(t));
    this.pull(this.run);
  }

  stop() {
    this.run++;
    try { this.iterator?.return(); } catch { /* already finished */ }
    this.iterator = null;
    this.nextFrame = null;
  }

  /** Draws frames that are already due and keeps the first future one for tick(). */
  async pull(run) {
    try {
      while (run === this.run && this.iterator) {
        const { value: frame } = await this.iterator.next();
        if (run !== this.run) return;
        if (!frame) {
          this.iterator = null;
          return;
        }
        if (frame.timestamp + this.offset > this.now()) {
          this.nextFrame = frame;
          return;
        }
        this.draw(frame);
      }
    } catch { /* the file was replaced while iterating */ }
  }

  /** Called on every animation frame during playback. */
  tick(t) {
    if (this.nextFrame && this.nextFrame.timestamp + this.offset <= t) {
      this.draw(this.nextFrame);
      this.nextFrame = null;
      this.pull(this.run);
    }
  }
}

export class ComparePlayer {
  constructor(beforeCanvas, afterCanvas, { onTime, onPlayingChange, onCoverageChange }) {
    this.before = new Side(beforeCanvas, () => this.time);
    this.after = new Side(afterCanvas, () => this.time);
    this.events = { onTime, onPlayingChange, onCoverageChange };
    this.range = [0, 0];
    this.playing = false;
    this.position = 0;           // timeline position while paused
    this.startPosition = 0;      // timeline position when playback (re)started...
    this.startClock = 0;         // ...and the clock reading at that moment
    this.listen = 'before';      // which side is heard: 'before' | 'after' | 'none'
    this.audio = null;           // { context, gain }
    this.audioClock = false;     // follow the audio clock (keeps sound in sync) or the system clock
    this.soundRun = 0;
    this.soundIterator = null;
    this.soundNodes = new Set();
    this.animationFrame = 0;
  }

  get sides() {
    return [this.before, this.after];
  }

  /** The current timeline position in seconds. */
  get time() {
    return this.playing ? this.clock() - this.startClock + this.startPosition : this.position;
  }

  clock() {
    return this.audioClock ? this.audio.context.currentTime : performance.now() / 1000;
  }

  setRange(start, end) {
    this.range = [start, end];
    this.position = start;
  }

  /** Loads a file into one side ('before' or 'after'), placed on the timeline at `offset`. */
  async load(name, blob, options) {
    const side = this[name];
    if (!(await side.load(blob, options))) return;
    if (this.playing) {
      side.start(this.time);
      if (side === this.heardSide()) this.restartSound();
    } else {
      side.showAt(this.position);
    }
    this.events.onCoverageChange();
  }

  async play() {
    if (this.playing || !this.before.frames) return;
    await this.prepareAudio();
    if (this.playing) return;
    if (this.position >= this.range[1] - 0.05) this.position = this.range[0];
    this.startPosition = this.position;
    this.startClock = this.clock();
    this.playing = true;
    for (const side of this.sides) side.start(this.position);
    this.startSound();
    this.animationFrame = requestAnimationFrame(() => this.tick());
    this.events.onPlayingChange(true);
  }

  pause(at = this.time) {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.animationFrame);
    this.stopSound();
    this.position = clamp(at, ...this.range);
    for (const side of this.sides) {
      side.stop();
      side.showAt(this.position);
    }
    this.events.onPlayingChange(false);
    this.events.onTime(this.position);
    this.events.onCoverageChange();
  }

  seek(t) {
    const position = clamp(t, ...this.range);
    if (this.playing) {
      this.stopSound();
      this.startPosition = position;
      this.startClock = this.clock();
      for (const side of this.sides) side.start(position);
      this.startSound();
    } else {
      this.position = position;
      for (const side of this.sides) side.showAt(position);
    }
    this.events.onTime(position);
    this.events.onCoverageChange();
  }

  setListen(name) {
    this.listen = name;
    this.restartSound();
  }

  async reset() {
    this.pause();
    await Promise.all(this.sides.map((side) => side.load(null)));
    this.setRange(0, 0);
  }

  tick() {
    const t = this.time;
    if (t >= this.range[1]) {
      this.pause(this.range[1]);
      return;
    }
    for (const side of this.sides) {
      // The playhead entered or left the part this side has (a preview covers only a few seconds).
      if (side.covers(t) !== side.covering) {
        if (side.covering) {
          side.stop();
          side.covering = false;
        } else {
          side.start(t);
        }
        if (side === this.heardSide()) this.restartSound();
        this.events.onCoverageChange();
      }
      side.tick(t);
    }
    this.events.onTime(t);
    this.animationFrame = requestAnimationFrame(() => this.tick());
  }

  // ---------- sound

  heardSide() {
    return this.listen === 'none' ? null : this[this.listen];
  }

  /** Audio can only start after a user gesture, so it is set up on the first play. */
  async prepareAudio() {
    if (!this.audio) {
      try {
        const context = new AudioContext();
        const gain = context.createGain();
        gain.connect(context.destination);
        this.audio = { context, gain };
      } catch { /* no audio output; the video still plays */ }
    }
    try { await this.audio?.context.resume(); } catch { /* stays suspended */ }
    this.audioClock = this.audio?.context.state === 'running';
  }

  startSound() {
    const run = ++this.soundRun;
    const side = this.heardSide();
    if (!this.playing || !this.audioClock || !side?.sound || !side.covers(this.time)) return;
    const { context, gain } = this.audio;
    const iterator = side.sound.buffers(Math.max(0, this.time - side.offset));
    this.soundIterator = iterator;
    (async () => {
      try {
        for await (const { buffer, timestamp } of iterator) {
          if (run !== this.soundRun) return;
          const startAt = this.startClock + (timestamp + side.offset - this.startPosition);
          const late = context.currentTime - startAt;
          if (late < buffer.duration) {
            const node = context.createBufferSource();
            node.buffer = buffer;
            node.connect(gain);
            if (late > 0) node.start(context.currentTime, late);
            else node.start(startAt);
            this.soundNodes.add(node);
            node.onended = () => this.soundNodes.delete(node);
          }
          // Schedule about a second ahead of the playhead.
          while (run === this.soundRun && timestamp + side.offset - this.time > 1) await sleep(100);
        }
      } catch { /* the file was replaced while iterating */ }
    })();
  }

  stopSound() {
    this.soundRun++;
    try { this.soundIterator?.return(); } catch { /* already finished */ }
    this.soundIterator = null;
    for (const node of this.soundNodes) {
      try { node.stop(); } catch { /* not started yet */ }
    }
    this.soundNodes.clear();
  }

  restartSound() {
    this.stopSound();
    this.startSound();
  }
}
