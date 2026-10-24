/**
 * The playback engine of one server (Player) and the per-server registry (PlayerManager).
 *
 *   const player = new Player({ serverId, connect, spawnDecoder, countListeners });
 *   player.on('trackStart', (track) => …);   // the first audio of a track is on its way
 *   player.play(track, { channelId });       // synchronous → { position, startedNow }
 *   player.pause(); player.setVolume(150); player.skip();
 *   await player.stop();                     // idempotent: leaves voice, emits 'destroy' once
 *
 * Every public method returns at once; one detached run loop does the slow work: wait for the server's previous
 * player to leave, join voice (bounded: connectTimeoutMs), then per track decode → gain → captureFrame. Pausing kills
 * nothing: a file just isn't read any further (ffmpeg blocks on the full pipe, so not a frame is lost) and a live
 * stream keeps being read with its frames dropped (the station doesn't stall us and resume is live). LiveKit and
 * ffmpeg stay outside: `connect` and `spawnDecoder` are injected (src/voice.js connectVoice, src/ffmpeg.js
 * spawnDecoder).
 */
import { EventEmitter } from 'node:events';
import { FRAME_MS, applyGain, clampVolume, readFrames, volumeToGain } from './audio.js';
import { isLastingFfmpegError, summarizeFfmpegError } from './ffmpeg.js';
import { createLogger } from './log.js';
import { LOOP_MODES, Queue, nextLoopMode, parseLoopMode } from './queue.js';

/** @typedef {import('./queue.js').LoopModeValue} LoopModeValue */
/** @typedef {import('./log.js').Logger} Logger */
/** @typedef {import('./ffmpeg.js').Decoder} Decoder */
/**
 * @typedef {{ kind: 'file'|'stream', live: boolean, title: string, input: string, [key: string]: any }} Track
 *   (shape in src/tracks.js; the player itself only reads `live`, `source` and `title`)
 */
/**
 * @typedef {object} VoiceLink what connect(channelId) resolves with: src/voice.js's VoiceConnection (or a fake)
 * @property {string} channelId
 * @property {{ captureFrame: (frame: any) => Promise<void>, clearQueue?: () => void,
 *   waitForPlayout?: () => Promise<void>, queuedDuration?: number }} source
 * @property {(pcm: Int16Array) => any} createFrame
 * @property {() => Promise<void>} leave
 * @property {() => number|null} [participantCount]
 * @property {(event: string, fn: (...args: any[]) => void) => any} [on]
 * @property {(event: string, fn: (...args: any[]) => void) => any} [off]
 */
/**
 * @typedef {object} PlayerSnapshot plain data for src/ui.js; the tracks are copies, safe to keep
 * @property {string} serverId
 * @property {string|null} channelId
 * @property {string|null} channelName
 * @property {string|null} textChannelId
 * @property {string} state
 * @property {Track|null} current
 * @property {number} position seconds into the current track
 * @property {boolean} paused
 * @property {number} volume
 * @property {LoopModeValue} loop
 * @property {Track[]} upcoming
 * @property {Track|null} next what plays after the current track ends on its own
 */

/** What a player is doing. */
export const PlayerState = Object.freeze({
  IDLE: 'idle', CONNECTING: 'connecting', PLAYING: 'playing', PAUSED: 'paused', DESTROYED: 'destroyed',
});

/** Why a player stopped: what stop(reason) takes and 'destroy' reports. */
export const STOP_REASONS = Object.freeze(['stopped', 'idle', 'alone', 'disconnected', 'error', 'shutdown']);

/** How long the player waits for things, in ms. Any of them can be overridden with the `timings` option. */
export const PLAYER_TIMINGS = Object.freeze({
  presenceDebounceMs: 1500, // voice events come in bursts: one listener lookup per burst
  countTimeoutMs: 5000,     // a countListeners() slower than this counts as "unknown"
  playoutTimeoutMs: 2000,   // queue ran dry: let the buffered tail play out, but not forever
  exitTimeoutMs: 5000,      // ffmpeg closed its output: how long it may take to exit before it's killed
  retryBaseMs: 1000,        // a dropped live stream is retried after 1 s, 2 s, 4 s …
  goodStreamMs: 30000,      // … and that count starts over once the stream played this long
  waitForTimeoutMs: 15000,  // the server's previous player gets this long to leave voice
  connectTimeoutMs: 20000,  // joining voice gets this long (the SDK can sleep through rate limits for minutes)
  stopTimeoutMs: 3000,      // stop() waits this long for the run loop to wind down
  leaveTimeoutMs: 15000,    // bound on leaving voice, and on a join that only completes after it was given up
});

/**
 * Why play() refused, or (as 'connectError') why joining failed. `code` 'DESTROYED': the player was stopped (get a
 * fresh one); 'BUSY_ELSEWHERE': it is busy in another voice channel of the server, which is in `channelId`;
 * 'CONNECT_TIMEOUT': joining `channelId` took over connectTimeoutMs. The messages can be shown to people as they are.
 */
export class PlayerError extends Error {
  /**
   * @param {'DESTROYED'|'BUSY_ELSEWHERE'|'CONNECT_TIMEOUT'} code
   * @param {string} message
   * @param {string|null} [channelId] the channel the player is busy in
   */
  constructor(code, message, channelId = null) {
    super(message);
    this.name = 'PlayerError';
    this.code = code;
    this.channelId = channelId;
  }
}

const KICKED = Symbol('kicked');       // a parked wait gave up because its condition came true
const TIMED_OUT = Symbol('timed out'); // a parked wait ran out of time

const isId = (v) => v !== undefined && v !== null && v !== '';
const sameId = (a, b) => isId(a) && isId(b) && String(a) === String(b);
const isCount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const copy = (track) => (track ? { ...track } : null);
const asError = (e) => (e instanceof Error ? e : new Error(String(e)));
const isStation = (track) => track.live === true && track.source === 'station';

function msOption(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a number of milliseconds >= 0, got ${String(value)}`);
  }
  return value;
}

/**
 * One server's music: a Queue, at most one voice connection and at most one decoder at a time.
 *
 * Events (never 'error'; a listener that throws is logged, it can't break playback):
 *  - 'stateChange' (state): every PlayerState transition
 *  - 'trackStart' (track): the track's first audio is being sent. Once per play: a loop replay is a new play, a
 *    stream retry isn't. A track that fails before making a sound gets 'trackError' without 'trackStart'
 *  - 'trackEnd' (track, { reason: 'ended'|'skipped'|'failed'|'stopped' }): pairs with 'trackStart'
 *  - 'trackError' (track, Error): it couldn't be played (the message is fit for chat); it's dropped, even when looping
 *  - 'connectError' (Error): joining voice failed (message from src/voice.js) or took over connectTimeoutMs
 *    (PlayerError 'CONNECT_TIMEOUT'); then the player stops with 'error'
 *  - 'queueEnd' ({ idleTimeoutMs }): nothing left to play; it leaves after idleTimeoutMs (0: right away)
 *  - 'alone' ({ timeoutMs }): nobody else is in the channel; it leaves after timeoutMs unless someone comes back
 *  - 'queueUpdate' ({ reason }): queue or loop mode changed: 'add'|'advance'|'skip'|'shuffle'|'remove'|'clear'|'loop'
 *  - 'volumeChange' (volume)
 *  - 'destroy' ({ reason, error }): stopped and out of voice; exactly once
 */
export class Player extends EventEmitter {
  /** @type {string} */
  serverId;
  /** @type {string|null} the voice channel it plays in (or is joining) */
  channelId = null;
  /** @type {string|null} that channel's name, for display (set by the cog) */
  channelName = null;
  /** @type {string|null} where the cog posts about this player (set by the cog) */
  textChannelId = null;
  /** @type {Promise<void>} resolves after 'destroy' (stopped and out of voice); never rejects */
  whenDestroyed;

  #connect;
  #spawn;
  #countListeners;
  #timers;
  #log;
  #onVolumeChange;
  #t;
  #idleTimeoutMs;
  #aloneTimeoutMs;
  #maxStreamRetries;
  #queue;
  #volume;
  #targetGain;              // what the pump ramps to over its next frame
  #appliedGain;             // what the last frame sent ended on
  #state = PlayerState.IDLE;
  #paused = false;
  /** @type {VoiceLink|null} */
  #conn = null;
  #connListeners = null;    // { conn, list }: so they can be taken off again
  #connecting = false;
  #looping = false;         // a run loop is going and will pick up new tracks by itself
  /** @type {Promise<void>|null} */
  #running = null;
  #waitFor;                 // the previous player leaving: waited for before the first join …
  #predecessor;             // … and, kept, before 'destroy' (see #finish)
  #moving = null;           // leaving the old channel of a move
  #play = null;             // the play in progress: { track, aborted, started, ended }
  /** @type {Decoder|null} */
  #decoder = null;
  #framesPlayed = 0;
  #seq = 0;                 // bumped on every queue move: tells the loop the track it waited for was skipped
  #parked = new Set();      // the waits the run loop is blocked in (see #park)
  #idleTimer = null;
  #presenceTimer = null;
  #aloneTimer = null;
  #alone = false;           // counting down (or taking the last look) towards stop('alone')
  #aloneRound = 0;          // bumped on cancel, so a confirmation that was already under way is ignored
  #presenceOwed = false;    // a presence check came while joining: it runs once the connection is up
  #late = null;             // leaving a connection that only arrived after the join was given up
  /** @type {Promise<void>|null} */
  #stopping = null;
  #markDestroyed;

  /**
   * @param {object} opts
   * @param {string} opts.serverId
   * @param {(channelId: string, opts: { signal: AbortSignal }) => Promise<VoiceLink>} opts.connect joins voice; a
   *   rejection's message is shown to people ('connectError'). `signal` aborts when the player gives up on that join
   *   (stop(), or connectTimeoutMs): what arrives later must not disturb a newer session of the server
   * @param {(track: Track) => Decoder} opts.spawnDecoder starts the decoder for a track
   * @param {() => Promise<number|null>} [opts.countListeners] how many people besides the bot are in its channel
   * @param {number} [opts.volume] percent, 1..200
   * @param {number} [opts.maxQueueSize]
   * @param {number} [opts.idleTimeoutMs] how long to stay once the queue ran dry (0: leave right away)
   * @param {number} [opts.aloneTimeoutMs] how long to stay alone in the channel (0: leave right away)
   * @param {Promise<unknown>|null} [opts.waitFor] the previous player leaving: awaited before the first join, and
   *   before 'destroy' (so a chain of players stopped while waiting can't let the next one in early)
   * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.timers] injectable for tests
   * @param {Logger} [opts.logger]
   * @param {number} [opts.maxStreamRetries] how often a dropped live stream is retried (with backoff)
   * @param {((volume: number) => void)|null} [opts.onVolumeChange] called by setVolume (also 'volumeChange')
   * @param {Partial<typeof PLAYER_TIMINGS>} [opts.timings] overrides for PLAYER_TIMINGS
   */
  constructor({
    serverId, connect, spawnDecoder, countListeners = null, volume = 100, maxQueueSize = 100,
    idleTimeoutMs = 30000, aloneTimeoutMs = 30000, waitFor = null, timers = { setTimeout, clearTimeout },
    logger, maxStreamRetries = 3, onVolumeChange = null, timings = {},
  } = /** @type {any} */ ({})) {
    super();
    if (!isId(serverId)) throw new TypeError('Player needs a serverId');
    if (typeof connect !== 'function') throw new TypeError('Player needs connect(channelId)');
    if (typeof spawnDecoder !== 'function') throw new TypeError('Player needs spawnDecoder(track)');
    if (countListeners !== null && typeof countListeners !== 'function') {
      throw new TypeError('countListeners must be a function');
    }
    if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') {
      throw new TypeError('timers needs setTimeout and clearTimeout');
    }
    if (!Number.isInteger(maxStreamRetries) || maxStreamRetries < 0) {
      throw new RangeError(`maxStreamRetries must be a whole number >= 0, got ${String(maxStreamRetries)}`);
    }
    this.#t = { ...PLAYER_TIMINGS };
    for (const [key, value] of Object.entries(timings ?? {})) {
      if (!Object.hasOwn(PLAYER_TIMINGS, key)) throw new TypeError(`Unknown timing "${key}"`);
      this.#t[key] = msOption(value, key);
    }
    this.serverId = serverId;
    this.#connect = connect;
    this.#spawn = spawnDecoder;
    this.#countListeners = countListeners;
    this.#timers = timers;
    this.#onVolumeChange = typeof onVolumeChange === 'function' ? onVolumeChange : null;
    this.#idleTimeoutMs = msOption(idleTimeoutMs, 'idleTimeoutMs');
    this.#aloneTimeoutMs = msOption(aloneTimeoutMs, 'aloneTimeoutMs');
    this.#maxStreamRetries = maxStreamRetries;
    this.#queue = new Queue({ maxSize: maxQueueSize });
    this.#volume = clampVolume(volume);
    this.#targetGain = this.#appliedGain = volumeToGain(this.#volume);
    this.#predecessor = waitFor ? Promise.resolve(waitFor).catch(() => {}) : null;
    this.#waitFor = this.#predecessor;
    this.#log = logger ?? createLogger('player').child(String(serverId));
    this.whenDestroyed = new Promise((resolve) => { this.#markDestroyed = resolve; });
  }

  /** One of PlayerState. */
  get state() { return this.#state; }
  /** The Queue. Read it freely; change it through the player, so 'queueUpdate' fires. */
  get queue() { return this.#queue; }
  /** The track playing (or about to), or null. */
  get current() { return this.#queue.current; }
  get paused() { return this.#paused; }
  /** Percent, 1..200. */
  get volume() { return this.#volume; }
  /** 'off' | 'track' | 'queue'. */
  get loop() { return this.#queue.loop; }
  /** Seconds of the current track heard so far: what was sent minus what's still buffered. Never negative. */
  get position() {
    if (!this.#queue.current) return 0;
    const queued = this.#conn?.source?.queuedDuration;
    const ms = this.#framesPlayed * FRAME_MS - (typeof queued === 'number' && Number.isFinite(queued) ? queued : 0);
    return Math.max(0, ms) / 1000;
  }
  /** True from the moment stop() is called. */
  get destroyed() { return this.#stopping !== null; }
  /** Something is playing, queued or being joined, so play() for another channel would be refused. */
  get isBusy() {
    return !this.destroyed && (this.#queue.current !== null || this.#queue.length > 0 || this.#connecting);
  }

  /** @returns {PlayerSnapshot} */
  snapshot() {
    const q = this.#queue;
    return {
      serverId: this.serverId,
      channelId: this.channelId,
      channelName: this.channelName,
      textChannelId: this.textChannelId,
      state: this.#state,
      current: copy(q.current),
      position: this.position,
      paused: this.#paused,
      volume: this.#volume,
      loop: q.loop,
      upcoming: q.upcoming.map(copy),
      next: copy(q.peek()),
    };
  }

  /**
   * Queue a track. When nothing was playing it starts right away, after joining `channelId` (or moving there when
   * the player sits idle in another channel). The joining and decoding happen in the background.
   * @param {Track} track
   * @param {{ channelId?: string }} [opts] the voice channel to play in (default: the current one)
   * @returns {{ position: number, startedNow: boolean }} startedNow: nothing was playing, queued or joining, so this
   *   track is up now (position 0); otherwise position is its 1-based place in the upcoming list
   * @throws {PlayerError} DESTROYED after stop(); BUSY_ELSEWHERE when busy in another channel
   * @throws {import('./queue.js').QueueFullError} when the queue is full (nothing changes)
   */
  play(track, { channelId } = {}) {
    if (this.destroyed) throw new PlayerError('DESTROYED', 'This player has been stopped.');
    if (!track || typeof track !== 'object') throw new TypeError('play() needs a track');
    const target = isId(channelId) ? channelId : this.channelId;
    if (!isId(target)) throw new TypeError('play() needs the voice channel to play in');
    const busy = this.isBusy;
    if (busy && !sameId(target, this.channelId)) {
      throw new PlayerError('BUSY_ELSEWHERE', "I'm already playing in another voice channel.", this.channelId);
    }
    const position = this.#queue.add(track); // a QueueFullError leaves everything as it was
    this.#clearIdle();
    if (!busy) {
      this.channelId = target;  // idle elsewhere: the run loop moves (leave, then join here)
      this.#advance('ended');   // nothing current or queued: this track is up right away
    }
    this.#emit('queueUpdate', { reason: 'add' });
    this.#start();
    return busy ? { position, startedNow: false } : { position: 0, startedNow: true };
  }

  /** Stop sending audio; nothing is killed. → false when there's nothing to pause or it already is paused. */
  pause() {
    if (this.destroyed || this.#paused || !this.#queue.current) return false;
    this.#paused = true;
    if (this.#state === PlayerState.PLAYING) this.#setState(PlayerState.PAUSED);
    return true;
  }

  /** Carry on where pause() left off (a live stream comes back live). → false when it wasn't paused. */
  resume() {
    if (this.destroyed || !this.#paused) return false;
    this.#paused = false;
    if (this.#state === PlayerState.PAUSED) this.#setState(PlayerState.PLAYING);
    this.#kick();
    return true;
  }

  /** @returns {'paused'|'resumed'|null} null when there was nothing to pause */
  togglePause() {
    if (this.#paused) return this.resume() ? 'resumed' : null;
    return this.pause() ? 'paused' : null;
  }

  /**
   * Skip the current track: its audio stops at once (decoder killed, buffered audio dropped), the player unpauses
   * and the next track starts. Works in every state, also while joining or between stream retries.
   * @returns {Track|null} the skipped track, or null when nothing was playing
   */
  skip() {
    const track = this.#queue.current;
    if (this.destroyed || !track) return null;
    const play = this.#abortPlay('skipped');
    this.#paused = false;
    this.#advance('skipped');
    this.#kick();
    if (play) this.#endPlay(play, 'skipped');
    if (this.#state === PlayerState.PAUSED) this.#setState(PlayerState.PLAYING);
    this.#emit('queueUpdate', { reason: 'skip' });
    return track;
  }

  /**
   * Stop playing, forget the queue, leave voice, then emit 'destroy' ({ reason, error }). The player is done from
   * the first call: state 'destroyed', play() throws DESTROYED. Calling it again returns the same promise.
   * @param {string} [reason] one of STOP_REASONS
   * @returns {Promise<void>} resolves after 'destroy'; never rejects
   */
  stop(reason = 'stopped') { return this.#shutdown(reason, null); }

  /**
   * @param {number} volume percent; rounded and clamped to 1..200
   * @returns {number} the volume now set. The very next 10 ms frame ramps to it, so it doesn't click
   * @throws {RangeError} when volume isn't a finite number
   */
  setVolume(volume) {
    const v = clampVolume(volume);
    this.#volume = v;
    this.#targetGain = volumeToGain(v);
    if (this.#onVolumeChange) {
      try { this.#onVolumeChange(v); } catch (err) { this.#log.error('onVolumeChange threw:', err); }
    }
    this.#emit('volumeChange', v);
    return v;
  }

  /** off → track → queue → off. @returns {LoopModeValue} the new mode */
  cycleLoop() { return this.setLoop(nextLoopMode(this.#queue.loop)); }

  /**
   * @param {string} mode 'off' | 'track' | 'queue', or anything parseLoopMode understands ('all', 'one' …)
   * @returns {LoopModeValue}
   * @throws {TypeError} for anything else
   */
  setLoop(mode) {
    const value = LOOP_MODES.includes(mode) ? mode : parseLoopMode(mode);
    if (!value) throw new TypeError(`Loop mode must be one of ${LOOP_MODES.join(', ')}`);
    this.#queue.loop = value;
    this.#emit('queueUpdate', { reason: 'loop' });
    return value;
  }

  /** Shuffle the upcoming tracks. @param {() => number} [random] @returns {number} how many were shuffled */
  shuffle(random) {
    const n = this.#queue.shuffle(random);
    this.#emit('queueUpdate', { reason: 'shuffle' });
    return n;
  }

  /**
   * @param {number} position 1-based place in the upcoming list
   * @returns {Track} the removed track
   * @throws {RangeError} when there's no such position
   */
  remove(position) {
    const track = this.#queue.remove(position);
    this.#emit('queueUpdate', { reason: 'remove' });
    return track;
  }

  /** Empty the upcoming list; the current track plays on. @returns {number} how many were removed */
  clear() {
    const n = this.#queue.clear();
    this.#emit('queueUpdate', { reason: 'clear' });
    return n;
  }

  /**
   * Check soon (debounced) whether anyone else is still in the channel; the cog calls it on voice_join/voice_leave.
   * Nobody → 'alone' and a countdown to stop('alone'); someone back → the countdown is cancelled.
   */
  checkPresence() {
    if (this.destroyed || this.#presenceTimer !== null) return; // one lookup per burst of voice events
    this.#presenceTimer = this.#timers.setTimeout(() => {
      this.#presenceTimer = null;
      this.#checkPresenceNow().catch((err) => this.#log.warn('presence check failed:', err));
    }, this.#t.presenceDebounceMs);
  }

  #start() {
    if (this.destroyed) return;
    if (this.#looping) { this.#kick(); return; } // e.g. letting the last audio play out: it carries on instead
    this.#looping = true;
    this.#running = this.#run();
  }

  /** The run loop. Only one runs at a time, nobody awaits it but stop(), and it never rejects. */
  async #run() {
    try {
      for (;;) {
        if (this.destroyed) return;
        const track = this.#queue.current;
        if (!track) {
          await this.#drain();
          if (this.destroyed) return;
          if (this.#queue.current) continue; // play() came in while the last audio played out
          this.#finishQueue();
          return;
        }
        const seq = this.#seq;
        const conn = await this.#ensureConnected();
        if (!conn) return;               // stopped meanwhile, or the join failed (and the player is stopping)
        if (seq !== this.#seq) continue; // skipped while we were joining
        await this.#playCurrent(track, seq, conn);
      }
    } catch (err) {
      this.#looping = false;
      this.#log.error('the playback loop crashed:', err);
      void this.#shutdown('error', asError(err));
    }
  }

  /** The connection to play into: the one we have, or a fresh join (leaving another channel first). Null if stopped. */
  async #ensureConnected() {
    const want = this.channelId;
    const old = this.#conn;
    if (old && sameId(old.channelId, want)) {
      this.#setState(this.#paused ? PlayerState.PAUSED : PlayerState.PLAYING);
      return old;
    }
    this.#connecting = true;
    this.#setState(PlayerState.CONNECTING);
    try {
      if (this.#waitFor) {
        // The server's previous player must be out of voice first, or its leave could undo our join.
        const waitFor = this.#waitFor;
        this.#waitFor = null;
        await this.#park(waitFor, { ms: this.#t.waitForTimeoutMs, until: () => this.destroyed });
      }
      if (old) {
        this.#conn = null;
        this.#cancelAlone();
        this.#log.debug(`moving from voice channel ${old.channelId} to ${want}`);
        this.#moving = this.#hangUp(old); // a stop() meanwhile still waits for it before 'destroy'
        await this.#park(this.#moving, { until: () => this.destroyed });
      }
      if (this.destroyed) return null;
      const abort = new AbortController();
      const pending = Promise.resolve().then(() => this.#connect(want, { signal: abort.signal }));
      const conn = await this.#park(pending, { ms: this.#t.connectTimeoutMs, until: () => this.destroyed });
      if (conn === KICKED || conn === TIMED_OUT || this.destroyed) {
        // Given up (stop(), or too slow), but the join may still complete: it must neither leave the bot sitting in
        // voice nor disturb a later session, so connect() hears of it and a late connection is left at once.
        abort.abort();
        this.#late = pending.then((late) => this.#hangUp(late), () => {});
        if (conn !== TIMED_OUT || this.destroyed) return null;
        const s = Math.round(this.#t.connectTimeoutMs / 1000);
        throw new PlayerError('CONNECT_TIMEOUT', `It took over ${s} s, so I gave up. Try again in a minute.`, want);
      }
      if (typeof conn?.source?.captureFrame !== 'function' || typeof conn.createFrame !== 'function') {
        this.#late = this.#hangUp(conn);
        throw new TypeError('connect() gave back no usable voice connection');
      }
      this.#conn = conn;
      this.#attach(conn);
      this.#log.debug(`joined voice channel ${want}`);
      if (this.#presenceOwed) {
        // People came or went while we were joining, and nobody will say so again now that we're in: look.
        this.#presenceOwed = false;
        this.checkPresence();
      }
      return conn;
    } catch (err) {
      if (this.destroyed) return null;
      const error = asError(err);
      this.#log.warn(`couldn't join voice channel ${want}: ${error.message}`);
      this.#emit('connectError', error);
      void this.#shutdown('error', error);
      return null;
    } finally {
      this.#connecting = false;
    }
  }

  /** Plays queue.current (`track`) once, then moves the queue on unless skip()/stop() already did. */
  async #playCurrent(track, seq, conn) {
    const play = { track, aborted: null, started: false, ended: false };
    this.#play = play;
    this.#appliedGain = this.#targetGain; // a new track starts at the volume set now: nothing to ramp from
    this.#setState(this.#paused ? PlayerState.PAUSED : PlayerState.PLAYING);
    const { outcome, error } = await this.#playTrack(play, conn);
    if (outcome === 'voice') {
      // captureFrame failed: the call is gone, nothing more can be played. Ends this play as 'stopped'.
      this.#log.warn(`sending audio failed, leaving voice: ${error.message}`);
      void this.#shutdown('disconnected', error);
      return;
    }
    if (this.#play === play) this.#play = null;
    if (play.aborted) return; // skip()/stop() already moved the queue on and reported the end
    if (outcome === 'failed') {
      this.#log.warn(`couldn't play "${track.title}": ${error.message}`);
      this.#emit('trackError', track, error);
    }
    this.#endPlay(play, outcome);
    if (seq === this.#seq && !this.destroyed) {
      this.#advance(outcome); // 'failed' drops the track even when looping, so a broken one can't loop forever
      this.#emit('queueUpdate', { reason: 'advance' });
    }
  }

  /** One play of a track, retrying a live stream that drops. → { outcome, error } */
  async #playTrack(play, conn) {
    const { track } = play;
    let retries = 0;
    for (;;) {
      if (play.aborted) return { outcome: play.aborted, error: null }; // e.g. a 'stateChange' listener stopped us
      const { frames, error, retry, voiceError } = await this.#decode(play, conn);
      if (play.aborted) return { outcome: play.aborted, error: null };
      if (voiceError) return { outcome: 'voice', error: voiceError };
      if (!error) return { outcome: 'ended', error: null };
      if (!track.live || !retry) return { outcome: 'failed', error };
      if (frames * FRAME_MS >= this.#t.goodStreamMs) retries = 0; // it played fine for a while: a fresh drop
      if (retries >= this.#maxStreamRetries) return { outcome: 'failed', error };
      const delay = this.#t.retryBaseMs * 2 ** retries++;
      this.#log.info(`stream "${track.title}" dropped (${error.message}); retry ${retries} in ${delay} ms`);
      await this.#park(null, { ms: delay, until: () => !!play.aborted });
      if (play.aborted) return { outcome: play.aborted, error: null };
    }
  }

  /**
   * One decoder run: frames → gain → captureFrame until the output ends or the play is aborted.
   * → { frames: decoded, error: why it failed (fit for chat), retry: worth another try, voiceError: sending failed }
   */
  async #decode(play, conn) {
    const { track } = play;
    let dec;
    try {
      dec = this.#spawn(track);
      if (!dec?.stdout || typeof dec.kill !== 'function') throw new TypeError('spawnDecoder() gave back no decoder');
    } catch (err) {
      return { frames: 0, error: asError(err), retry: false, voiceError: null };
    }
    this.#decoder = dec;
    let frames = 0;
    let readError = null;
    let voiceError = null;
    try {
      for await (const pcm of readFrames(dec.stdout)) {
        if (play.aborted) break;
        frames++;
        if (!play.started) {
          play.started = true;
          this.#log.debug(`playing "${track.title}"`);
          this.#emit('trackStart', track);
          if (play.aborted) break;
        }
        if (this.#paused) {
          // Live: read on and drop, so the station doesn't stall us and resume is live again.
          if (track.live) continue;
          // File: hold this frame. Not reading parks ffmpeg on the full pipe, so nothing is lost.
          await this.#park(null, { until: () => !this.#paused || !!play.aborted });
          if (play.aborted) break;
        }
        const target = this.#targetGain;
        applyGain(pcm, this.#appliedGain, target); // ramps across this frame: a volume change doesn't click
        this.#appliedGain = target;
        try {
          const sent = conn.source.captureFrame(conn.createFrame(pcm));
          // A send that hangs must not hang skip/stop: stop waiting for it once the play is aborted.
          if ((await this.#park(sent, { until: () => !!play.aborted })) === KICKED) break;
        } catch (err) {
          if (!play.aborted) voiceError = asError(err);
          break;
        }
        this.#framesPlayed++;
      }
    } catch (err) {
      if (!play.aborted) readError = asError(err); // after kill() the read fails too: that one is ours
    }
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      try { dec.kill(); } catch (err) { this.#log.debug('killing the decoder failed:', err); }
    };
    // After a clean end of output ffmpeg exits by itself: killing it now could turn exit code 0 into a SIGKILL.
    if (play.aborted || readError || voiceError) kill();
    const done = Promise.resolve(dec.done).catch((err) => ({ code: null, signal: null, stderr: '', error: err }));
    let result = await this.#park(done, { ms: this.#t.exitTimeoutMs, until: () => this.destroyed });
    if (result === TIMED_OUT) {
      kill();
      result = await this.#park(done, { ms: this.#t.exitTimeoutMs, until: () => this.destroyed });
    }
    if (this.#decoder === dec) this.#decoder = null;
    if (play.aborted || voiceError) return { frames, error: null, retry: false, voiceError };
    const res = result && typeof result === 'object' ? result : {}; // no exit status: it hung and was killed
    if (res.error) return { frames, error: asError(res.error), retry: false, voiceError: null }; // never started
    const code = typeof res.code === 'number' ? res.code : null;
    const failed = readError !== null || (code !== null && code !== 0) || (!!res.signal && !killed) || frames === 0;
    if (!failed) {
      if (!isStation(track)) return { frames, error: null, retry: false, voiceError: null };
      // A radio station doesn't end: its server closed the stream (a restart, a recycled connection), and ffmpeg
      // doesn't reconnect after a clean end. Retried like a drop. (A link may be a finite file, so it can end.)
      return { frames, error: new Error('The station closed the stream'), retry: true, voiceError: null };
    }
    const error = new Error(summarizeFfmpegError(res.stderr, code), readError ? { cause: readError } : undefined);
    // Before any audio, a refusal (HTTP 4xx) or something that isn't audio (a web page) won't change on a retry.
    return { frames, error, retry: play.started || !isLastingFfmpegError(res.stderr), voiceError: null };
  }

  /** The queue ran dry: give the buffered tail a moment to play out (bounded; a new track or stop() cuts it short). */
  async #drain() {
    const source = this.#conn?.source;
    if (typeof source?.waitForPlayout !== 'function') return;
    const playout = Promise.resolve().then(() => source.waitForPlayout()).catch(() => {});
    await this.#park(playout, { ms: this.#t.playoutTimeoutMs, until: () => this.destroyed || !!this.#queue.current });
  }

  /** Nothing left to play: go idle, say so, and start the countdown to leaving. */
  #finishQueue() {
    this.#looping = false; // from here on, play() starts a new run
    this.#paused = false;
    this.#setState(PlayerState.IDLE);
    if (this.#looping || this.destroyed) return; // a 'stateChange' listener already played or stopped
    const ms = this.#idleTimeoutMs;
    if (ms > 0) {
      this.#idleTimer = this.#timers.setTimeout(() => {
        this.#idleTimer = null;
        void this.#shutdown('idle', null);
      }, ms);
    }
    this.#emit('queueEnd', { idleTimeoutMs: ms });
    if (ms === 0 && !this.#looping && !this.destroyed) void this.#shutdown('idle', null);
  }

  #shutdown(reason, error) {
    if (this.#stopping) return this.#stopping;
    let finished;
    this.#stopping = new Promise((resolve) => { finished = resolve; });
    this.#log.debug(`stopping (${reason})`);
    this.#clearIdle();
    this.#cancelAlone();
    if (this.#presenceTimer !== null) {
      this.#timers.clearTimeout(this.#presenceTimer);
      this.#presenceTimer = null;
    }
    const play = this.#abortPlay('stopped');
    this.#paused = false;
    this.#queue.reset();
    this.#seq++;
    this.#framesPlayed = 0;
    this.#kick(); // every wait of the run loop gives up now, and its timer goes with it
    this.#setState(PlayerState.DESTROYED);
    if (play) this.#endPlay(play, 'stopped');
    this.#finish(reason, error).then(finished, finished);
    return this.#stopping;
  }

  async #finish(reason, error) {
    try {
      if (this.#running) await this.#park(this.#running, { ms: this.#t.stopTimeoutMs });
      const conn = this.#conn;
      this.#conn = null;
      // 'destroy' lets this server's next player join, so all voice work this one started or waited for is over
      // first (each part bounded): leaving its channel, leaving the old one of a move, a join that came too late,
      // and the previous player's leave — it may have been stopped before that one was out.
      await Promise.all([
        conn ? this.#hangUp(conn) : null,
        this.#moving,
        this.#late ? this.#park(this.#late, { ms: this.#t.leaveTimeoutMs }) : null,
        this.#predecessor ? this.#park(this.#predecessor, { ms: this.#t.waitForTimeoutMs }) : null,
      ]);
    } catch (err) {
      this.#log.warn('stopping ran into trouble:', err);
    }
    this.#log.debug(`stopped (${reason})`);
    this.#emit('destroy', { reason, error: error ?? null });
    this.#markDestroyed();
  }

  /** Take our listeners off a connection and leave it. Bounded, never throws. */
  async #hangUp(conn) {
    this.#detach(conn);
    try {
      const left = await this.#park(Promise.resolve().then(() => conn.leave()), { ms: this.#t.leaveTimeoutMs });
      if (left === TIMED_OUT) this.#log.warn(`leaving voice channel ${conn.channelId} timed out`);
    } catch (err) {
      this.#log.warn(`leaving voice channel ${conn?.channelId} failed:`, err);
    }
  }

  #attach(conn) {
    const onDisconnected = () => { if (this.#conn === conn) void this.#shutdown('disconnected', null); };
    const onParticipants = () => { if (this.#conn === conn) this.checkPresence(); };
    const list = [['disconnected', onDisconnected], ['participantsChanged', onParticipants]];
    if (typeof conn.on === 'function') for (const [event, fn] of list) conn.on(event, fn);
    this.#connListeners = { conn, list };
  }

  #detach(conn) {
    const entry = this.#connListeners;
    if (!entry || entry.conn !== conn) return;
    this.#connListeners = null;
    const off = conn.off ?? conn.removeListener;
    for (const [event, fn] of entry.list) {
      try { off?.call(conn, event, fn); } catch { /* already torn down */ }
    }
  }

  /** Abort the play in progress and silence it at once. → that play, when it still has to report its end. */
  #abortPlay(reason) {
    const play = this.#play && !this.#play.aborted ? this.#play : null;
    if (play) play.aborted = reason;
    try { this.#decoder?.kill(); } catch (err) { this.#log.debug('killing the decoder failed:', err); }
    // Drop the ~queueMs of audio already handed to LiveKit, so skip/stop are heard right away.
    try { this.#conn?.source?.clearQueue?.(); } catch (err) { this.#log.debug('clearQueue failed:', err); }
    return play;
  }

  #endPlay(play, reason) {
    if (play.ended) return;
    play.ended = true;
    if (play.started) this.#emit('trackEnd', play.track, { reason });
  }

  /** Every queue move goes through here, so the run loop can tell that the track it waited for was skipped. */
  #advance(reason) {
    this.#seq++;
    this.#framesPlayed = 0;
    return this.#queue.advance(reason);
  }

  async #checkPresenceNow() {
    const conn = this.#conn;
    if (this.destroyed) return;
    if (!conn) {
      // Still joining: everyone may have left by the time we're in, and then no voice event comes. Look once in.
      if (this.#connecting) this.#presenceOwed = true;
      return;
    }
    const count = await this.#countPeople(conn);
    if (this.destroyed || this.#conn !== conn || count === null) return; // unknown: change nothing
    if (count > 0) { this.#cancelAlone(); return; }
    if (this.#alone) return; // already counting down
    this.#alone = true;
    const round = this.#aloneRound;
    const ms = this.#aloneTimeoutMs;
    if (ms > 0) {
      this.#aloneTimer = this.#timers.setTimeout(() => {
        this.#aloneTimer = null;
        this.#confirmAlone(conn, round).catch((err) => this.#log.warn('presence check failed:', err));
      }, ms);
    }
    this.#log.info(`alone in voice channel ${conn.channelId}; leaving in ${ms / 1000} s unless someone joins`);
    this.#emit('alone', { timeoutMs: ms });
    if (ms === 0 && !this.destroyed) void this.#shutdown('alone', null);
  }

  /** The alone countdown ran out: one last look, then leave unless someone came back. */
  async #confirmAlone(conn, round) {
    const count = await this.#countPeople(conn);
    if (this.destroyed || this.#conn !== conn || round !== this.#aloneRound) return; // cancelled meanwhile
    // Still nobody, or no way to tell any more: the last answer we had said "alone".
    if (count === null || count === 0) { void this.#shutdown('alone', null); return; }
    this.#cancelAlone();
  }

  #cancelAlone() {
    this.#alone = false;
    this.#aloneRound++;
    if (this.#aloneTimer === null) return;
    this.#timers.clearTimeout(this.#aloneTimer);
    this.#aloneTimer = null;
  }

  /** People in the channel besides the bot: countListeners(), else the room's own count. Null when unknown. */
  async #countPeople(conn) {
    let count = null;
    if (this.#countListeners) {
      try {
        count = await this.#park(Promise.resolve().then(() => this.#countListeners()),
          { ms: this.#t.countTimeoutMs, until: () => this.destroyed });
      } catch (err) {
        this.#log.debug('countListeners failed:', err);
      }
    }
    if (!isCount(count)) {
      try { count = conn.participantCount?.() ?? null; } catch { count = null; }
    }
    return isCount(count) ? count : null;
  }

  #clearIdle() {
    if (this.#idleTimer === null) return;
    this.#timers.clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  /**
   * Wait for `promise` (null: for nothing), at most `ms`, and give up as soon as `until()` holds: it's checked now
   * and on every #kick(). → the promise's value, TIMED_OUT or KICKED (rejects when the promise rejects first).
   * The timer never outlives the wait, so stop() — which kicks every wait — leaves no timers behind.
   */
  #park(promise, { ms = null, until = null } = {}) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const settle = (fn, value) => {
        if (!this.#parked.delete(waiter)) return; // settled already
        if (timer !== null) this.#timers.clearTimeout(timer);
        fn(value);
      };
      const waiter = { until, wake: () => settle(resolve, KICKED) };
      this.#parked.add(waiter);
      if (ms !== null) timer = this.#timers.setTimeout(() => { timer = null; settle(resolve, TIMED_OUT); }, ms);
      if (promise) Promise.resolve(promise).then((v) => settle(resolve, v), (e) => settle(reject, e));
      if (until?.()) waiter.wake();
    });
  }

  /** Something changed: wake every parked wait whose condition now holds. */
  #kick() {
    for (const waiter of [...this.#parked]) if (waiter.until?.()) waiter.wake();
  }

  #setState(state) {
    if (state === this.#state || this.#state === PlayerState.DESTROYED) return;
    this.#state = state;
    this.#emit('stateChange', state);
  }

  /** emit() that keeps a throwing listener from breaking playback: it's logged instead. */
  #emit(event, ...args) {
    try { this.emit(event, ...args); } catch (err) { this.#log.error(`a '${event}' listener threw:`, err); }
  }
}

/**
 * One player per server. After a player stops, the next obtain() makes a fresh one that first waits for the old one
 * to be out of voice. Per-server settings (the volume) outlive the players.
 *
 *   const players = new PlayerManager({ createPlayer: (serverId, { volume, waitFor }) => new Player({ … }) });
 *   players.obtain(serverId).play(track, { channelId });
 *   await players.destroyAll();             // shutdown
 */
export class PlayerManager {
  #create;
  #defaultVolume;
  /** @type {Map<string, Player>} each server's newest player, until its 'destroy' */
  #players = new Map();
  /** @type {Map<string, { volume: number }>} */
  #settings = new Map();

  /**
   * @param {{ createPlayer: (serverId: string, opts: { volume: number, waitFor: Promise<void>|null }) => Player,
   *   defaultVolume?: number }} opts createPlayer must pass both options on to the Player
   */
  constructor({ createPlayer, defaultVolume = 100 } = /** @type {any} */ ({})) {
    if (typeof createPlayer !== 'function') throw new TypeError('PlayerManager needs createPlayer(serverId, opts)');
    this.#create = createPlayer;
    this.#defaultVolume = clampVolume(defaultVolume);
  }

  /** The server's player, unless it has none or it was stopped. @returns {Player|undefined} */
  get(serverId) {
    const player = this.#players.get(String(serverId));
    return player && !player.destroyed ? player : undefined;
  }

  /**
   * The server's player, or a new one. A new one gets the remembered volume and, when the previous player is still
   * stopping, its whenDestroyed as `waitFor`, so the old leave can't race the new join.
   * @returns {Player}
   */
  obtain(serverId) {
    const key = String(serverId);
    const old = this.#players.get(key);
    if (old && !old.destroyed) return old;
    const settings = this.settings(key);
    const player = this.#create(serverId, { volume: settings.volume, waitFor: old ? old.whenDestroyed : null });
    this.#players.set(key, player);
    player.on('volumeChange', (volume) => { settings.volume = volume; });
    player.once('destroy', () => { if (this.#players.get(key) === player) this.#players.delete(key); });
    return player;
  }

  /** The server's settings, kept for the life of the process: { volume }. */
  settings(serverId) {
    const key = String(serverId);
    let settings = this.#settings.get(key);
    if (!settings) this.#settings.set(key, (settings = { volume: this.#defaultVolume }));
    return settings;
  }

  /** How many servers have a live (not stopped) player. */
  get size() { return this.values().length; }

  /** The live (not stopped) players. @returns {Player[]} */
  values() { return [...this.#players.values()].filter((player) => !player.destroyed); }

  /** Stop every player, stopping ones included, and wait until all are out of voice. Never rejects. */
  async destroyAll(reason = 'shutdown') {
    await Promise.allSettled([...this.#players.values()].map((player) => player.stop(reason)));
  }
}
