/**
 * Deterministic fakes for the player and cog tests: no LiveKit, no ffmpeg, no real timers, no network. Nothing moves
 * until the test pushes it: frames when a decoder is fed, captureFrame when a gated source is released, timers when
 * the clock is advanced.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CHANNELS, FRAME_BYTES, SAMPLE_RATE, SAMPLES_PER_CHANNEL } from '../src/audio.js';
import { FfmpegStartError } from '../src/ffmpeg.js';

/**
 * Lets queued promise callbacks, nextTicks and stream events run without real time passing. Each turn is one
 * setImmediate, which Node only reaches once those queues are empty.
 */
export async function flush(turns = 5) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Flushes until `predicate()` holds, failing the test instead of hanging once both `turns` rounds and `ms` of real
 * time are used up. The time floor is for real I/O (a directory listing, say), which a busy machine's thread pool
 * can hold up for longer than a few hundred rounds take.
 */
export async function until(predicate, { turns = 200, ms = 2000, message = 'the condition never came true' } = {}) {
  const deadline = Date.now() + ms;
  for (let i = 0; i < turns || Date.now() < deadline; i++) {
    if (predicate()) return;
    await flush(1);
  }
  assert.ok(predicate(), message);
}

/**
 * Collects unhandled promise rejections; call it once per test file. The listener stops Node from crashing on them,
 * so the test has to assert the array stays empty (in afterEach, say).
 */
export function catchUnhandledRejections() {
  const seen = [];
  process.on('unhandledRejection', (reason) => { seen.push(reason); });
  return seen;
}

/** A logger that keeps its lines as { level, text } instead of printing them. */
export function quietLogger() {
  const lines = [];
  const at = (level) => (...args) => {
    lines.push({ level, text: args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ') });
  };
  const logger = { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  logger.child = () => logger;
  return logger;
}

export const PLAYER_EVENTS = Object.freeze(['stateChange', 'trackStart', 'trackEnd', 'trackError', 'connectError',
  'queueEnd', 'alone', 'queueUpdate', 'volumeChange', 'destroy']);

export function recordEvents(emitter, names = PLAYER_EVENTS) {
  /** @type {{ name: string, args: any[] }[]} */
  const log = [];
  for (const name of names) emitter.on(name, (...args) => { log.push({ name, args }); });
  return {
    log,
    /** The names in order, optionally only those in `only`. */
    names: (only) => log.filter((e) => !only || only.includes(e.name)).map((e) => e.name),
    /** The argument lists of every `name` event. */
    of: (name) => log.filter((e) => e.name === name).map((e) => e.args),
    count: (name) => log.filter((e) => e.name === name).length,
    clear: () => { log.length = 0; },
  };
}

/** A file track like src/tracks.js makes (the path is never opened: decoders are fakes). */
export function makeFileTrack(title = 'Song', extra = {}) {
  return {
    kind: 'file', live: false, title, artist: null, input: `/music/${title}.mp3`, source: 'local',
    duration: 180, fileName: `${title}.mp3`, url: null, requestedBy: 'user-1', ...extra,
  };
}

/** A live radio track like src/tracks.js makes (never fetched: decoders are fakes). */
export function makeStreamTrack(title = 'Radio', extra = {}) {
  return {
    kind: 'stream', live: true, title, artist: null, input: 'https://radio.example/live.mp3', source: 'station',
    duration: null, stationId: 'radio', description: null, url: null, requestedBy: 'user-1', ...extra,
  };
}

/** `frames` 10 ms frames of s16le stereo PCM with every sample set to `value` (-32768..32767). */
export function pcmBytes(frames = 1, value = 1000) {
  const bytes = Buffer.alloc(frames * FRAME_BYTES);
  for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(value, i);
  return bytes;
}

/** Manual setTimeout/clearTimeout for the player: nothing fires until advance(). `now` is the fake clock in ms. */
export class FakeTimers {
  now = 0;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  #due = new Map();
  #nextId = 1;

  setTimeout = (fn, ms = 0) => {
    if (typeof fn !== 'function') throw new TypeError('setTimeout needs a function');
    const id = this.#nextId++;
    this.#due.set(id, { at: this.now + Math.max(0, Number(ms) || 0), fn });
    return id;
  };

  clearTimeout = (id) => { this.#due.delete(id); };

  get pending() { return this.#due.size; }

  get delays() { return [...this.#due.values()].map((t) => t.at - this.now).sort((a, b) => a - b); }

  /**
   * Moves the clock `ms` forward. Each timer that comes due fires in order (oldest first on ties), followed by a
   * flush, so the work it starts runs too, including timers that work sets within the window.
   */
  async advance(ms = 0) {
    const end = this.now + ms;
    await flush();
    for (;;) {
      let next = null;
      for (const [id, t] of this.#due) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
      if (!next) break;
      this.#due.delete(next.id);
      this.now = next.t.at;
      next.t.fn();
      await flush();
    }
    this.now = end;
  }
}

/**
 * Stands in for src/ffmpeg.js's Decoder. The test feeds stdout (a PassThrough) with push(); `done` settles on end(),
 * fail() or the player's kill(), or never, like a stream that keeps going.
 */
export class FakeDecoder {
  stdout = new PassThrough();
  /** @type {Promise<{ code: number|null, signal: string|null, stderr: string, error: Error|null }>} */
  done;
  track;
  pid;
  killCalls = 0;
  #killed = false;
  #settle;
  #result = null;

  constructor(track = null, { pid = 1000 } = {}) {
    this.track = track;
    this.pid = pid;
    this.done = new Promise((resolve) => { this.#settle = resolve; });
    this.stdout.on('error', () => {}); // like spawnDecoder: a destroyed pipe mustn't crash anything
  }

  get killed() { return this.#killed; }
  /** The exit `done` resolved with, or null while it runs. */
  get result() { return this.#result; }

  /** Writes `frames` frames whose samples all equal `value`. */
  push(frames = 1, value = 1000) {
    if (!this.stdout.destroyed && !this.stdout.writableEnded) this.stdout.write(pcmBytes(frames, value));
    return this;
  }

  /** Writes raw bytes (e.g. half a frame). */
  write(bytes) {
    if (!this.stdout.destroyed && !this.stdout.writableEnded) this.stdout.write(bytes);
    return this;
  }

  /** Ends the output and exits (code 0 unless told otherwise). */
  end({ code = 0, signal = null, stderr = '', error = null } = {}) {
    if (!this.stdout.destroyed && !this.stdout.writableEnded) this.stdout.end();
    this.#finish({ code, signal, stderr, error });
    return this;
  }

  /** push(frames, value), then a clean exit. */
  play(frames = 1, value = 1000) { return this.push(frames, value).end(); }

  /** Exits with an error and no output, like ffmpeg on a broken file or an unreachable stream. */
  fail(stderr = 'Invalid data found when processing input', code = 1) { return this.end({ code, stderr }); }

  /** Like spawnDecoder when ffmpeg can't start: empty output, `done.error` set (an FfmpegStartError). */
  failToStart(message = 'ffmpeg not found at "ffmpeg" — install ffmpeg or set FFMPEG_PATH') {
    return this.end({ code: null, error: new FfmpegStartError(message, { code: 'ENOENT' }) });
  }

  kill() {
    this.killCalls++;
    if (this.#killed) return;
    this.#killed = true;
    this.stdout.destroy();
    this.#finish({ code: null, signal: 'SIGKILL', stderr: '', error: null });
  }

  #finish(result) {
    if (this.#result) return;
    this.#result = result;
    this.#settle(result);
  }
}

/** Makes FakeDecoders: pass `decoders.spawn` as spawnDecoder. `script(decoder, index)` runs right after each spawn. */
export class FakeDecoders {
  /** @type {FakeDecoder[]} */
  all = [];
  #script;

  constructor(script = null) { this.#script = script; }

  spawn = (track) => {
    const decoder = new FakeDecoder(track, { pid: 1000 + this.all.length });
    this.all.push(decoder);
    this.#script?.(decoder, this.all.length - 1);
    return decoder;
  };

  get count() { return this.all.length; }
  /** @returns {FakeDecoder|null} the newest */
  get last() { return this.all.at(-1) ?? null; }
}

/**
 * A stand-in for LiveKit's AudioSource. captureFrame records each frame's samples in `frames`; after gate() every
 * capture waits for release()/open(), which is how a test paces the player (the real one paces at real time).
 */
export class FakeSource {
  /** @type {Int16Array[]} the samples of every frame sent, in order */
  frames = [];
  clearQueueCalls = 0;
  waitForPlayoutCalls = 0;
  /** ms still buffered, as LiveKit estimates it; tests set it */
  queuedDuration = 0;
  closed = false;
  #gated = false;
  /** @type {(() => void)[]} */
  #waiting = [];
  #failure = null;
  #playout = null;

  captureFrame(frame) {
    if (this.closed) return Promise.reject(new Error('AudioSource is closed'));
    if (this.#failure) {
      const err = this.#failure;
      this.#failure = null;
      return Promise.reject(err);
    }
    this.frames.push(frame.data);
    if (!this.#gated) return Promise.resolve();
    return new Promise((resolve) => { this.#waiting.push(resolve); });
  }

  /** From now on each captureFrame waits for release() or open(). */
  gate() { this.#gated = true; return this; }
  /** Finishes the `n` oldest waiting captures and returns how many it finished. */
  release(n = 1) {
    const done = this.#waiting.splice(0, n);
    for (const resolve of done) resolve();
    return done.length;
  }
  /** Ungates and finishes every waiting capture; returns how many. */
  open() {
    this.#gated = false;
    return this.release(Infinity);
  }
  /** How many captures are waiting to be released. */
  get waiting() { return this.#waiting.length; }

  /** The next captureFrame rejects with `err`. */
  failNext(err = new Error('AudioSource is closed')) { this.#failure = err; return this; }

  clearQueue() { this.clearQueueCalls++; }

  /** From now on waitForPlayout() never resolves (an audio queue that doesn't drain). */
  hangPlayout() { this.#playout = new Promise(() => {}); return this; }

  waitForPlayout() {
    this.waitForPlayoutCalls++;
    return this.#playout ?? Promise.resolve();
  }

  async close() { this.closed = true; }
}

/**
 * A stand-in for src/voice.js's VoiceConnection: same members and events ('disconnected', 'participantsChanged').
 * leave() closes the source, like the real one closing the track.
 */
export class FakeConnection extends EventEmitter {
  channelId;
  serverId;
  e2ee = false;
  source = new FakeSource();
  /** what participantCount() answers (null = unknown) */
  participants;
  leaveCalls = 0;
  #leaving = null;
  #hangLeave = false;

  constructor(channelId, { serverId = 'server-1', participants = 1 } = {}) {
    super();
    this.channelId = channelId;
    this.serverId = serverId;
    this.participants = participants;
  }

  get frames() { return this.source.frames; }
  get left() { return this.leaveCalls > 0; }

  /** Shaped like rtc.AudioFrame. */
  createFrame(pcm) {
    return { data: pcm, sampleRate: SAMPLE_RATE, channels: CHANNELS, samplesPerChannel: SAMPLES_PER_CHANNEL };
  }

  participantCount() { return this.participants; }

  leave() {
    this.leaveCalls++;
    this.source.closed = true;
    this.#leaving ??= this.#hangLeave ? new Promise(() => {}) : Promise.resolve();
    return this.#leaving;
  }

  /** From now on leave() never settles. */
  hangLeave() { this.#hangLeave = true; return this; }

  /** The room dropped us. */
  drop(reason = 1) { this.emit('disconnected', reason); }

  /** People joined or left: sets the count and emits 'participantsChanged'. */
  setParticipants(count) {
    this.participants = count;
    this.emit('participantsChanged', count);
  }
}

/**
 * Hands out FakeConnections: pass `voice.connect` as the player's connect(). In manual mode each connect() waits
 * until the test calls resolve() or reject(), which is how a test holds the player in 'connecting'.
 */
export class FakeVoice {
  /** @type {string[]} the channel ids connect() was called with */
  calls = [];
  /** @type {(AbortSignal|null)[]} the signal each connect() got (aborted: the player gave that join up) */
  signals = [];
  /** @type {FakeConnection[]} */
  connections = [];
  #manual;
  #participants;
  /** @type {{ channelId: string, resolve: (c: FakeConnection) => void, reject: (e: Error) => void }[]} */
  #pending = [];
  #failure = null;

  constructor({ manual = false, participants = 1 } = {}) {
    this.#manual = manual;
    this.#participants = participants;
  }

  // The player calls connect(channelId, { signal }); the cog's deps.connect gets (channelId, serverId, { signal }).
  connect = (channelId, ...rest) => {
    this.calls.push(channelId);
    this.signals.push(rest.find((arg) => arg?.signal)?.signal ?? null);
    if (this.#failure) {
      const err = this.#failure;
      this.#failure = null;
      return Promise.reject(err);
    }
    if (!this.#manual) return Promise.resolve(this.#make(channelId));
    return new Promise((resolve, reject) => { this.#pending.push({ channelId, resolve, reject }); });
  };

  /** Completes the oldest pending connect() and returns its FakeConnection. */
  resolve() {
    const next = this.#pending.shift();
    assert.ok(next, 'no connect() is pending');
    const conn = this.#make(next.channelId);
    next.resolve(conn);
    return conn;
  }

  /** Fails the oldest pending connect() with `err`. */
  reject(err = new Error('could not join')) {
    const next = this.#pending.shift();
    assert.ok(next, 'no connect() is pending');
    next.reject(err);
  }

  /** The next connect() rejects with `err`. */
  failNext(err) { this.#failure = err; return this; }

  /** How many connect() calls are waiting (manual mode). */
  get pending() { return this.#pending.length; }
  /** @returns {FakeConnection|null} the newest */
  get last() { return this.connections.at(-1) ?? null; }

  #make(channelId) {
    const conn = new FakeConnection(channelId, { participants: this.#participants });
    this.connections.push(conn);
    return conn;
  }
}
