/**
 * One server's playback engine (Player) and the per-server registry (PlayerManager). Public methods return at once;
 * a detached run loop does the slow work: wait for the server's previous player to leave, join voice, then decode,
 * apply gain and captureFrame. Voice and ffmpeg are injected (src/voice.js, src/ffmpeg.js).
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
 *   Shape in src/tracks.js; the player reads only `live`, `source` and `title`.
 */
/**
 * @typedef {object} VoiceLink what connect() resolves with: src/voice.js's VoiceConnection, or a test fake
 * @property {string} channelId
 * @property {{ captureFrame: (frame: any) => Promise<void>, clearQueue?: () => void,
 *   waitForPlayout?: () => Promise<void>, queuedDuration?: number }} source queuedDuration is in ms
 * @property {(pcm: Int16Array) => any} createFrame
 * @property {() => Promise<void>} leave
 * @property {() => number|null} [participantCount]
 * @property {(event: string, fn: (...args: any[]) => void) => any} [on]
 * @property {(event: string, fn: (...args: any[]) => void) => any} [off]
 */
/**
 * Plain data for src/ui.js, tracks copied. `position` is in seconds; `next` follows once `current` ends on its own.
 * @typedef {{ serverId: string, channelId: string|null, channelName: string|null, textChannelId: string|null,
 *   state: string, current: Track|null, position: number, paused: boolean, volume: number, loop: LoopModeValue,
 *   upcoming: Track[], next: Track|null }} PlayerSnapshot
 */

export const PlayerState = Object.freeze({
  IDLE: 'idle', CONNECTING: 'connecting', PLAYING: 'playing', PAUSED: 'paused', DESTROYED: 'destroyed',
});

/** The reasons stop() takes and 'destroy' reports. */
export const STOP_REASONS = Object.freeze(['stopped', 'idle', 'alone', 'disconnected', 'error', 'shutdown']);

/** In ms; each one can be overridden through the `timings` option. */
export const PLAYER_TIMINGS = Object.freeze({
  presenceDebounceMs: 1500,
  countTimeoutMs: 5000,     // a slower countListeners() counts as "unknown"
  playoutTimeoutMs: 2000,
  exitTimeoutMs: 5000,     // ffmpeg closed its output: time to exit before it's killed
  retryBaseMs: 1000,        // a dropped live stream is retried after 1 s, 2 s, 4 s, ...
  goodStreamMs: 30000,      // the retry count starts over once a stream has played this long
  waitForTimeoutMs: 15000,  // the server's previous player gets this long to leave voice
  connectTimeoutMs: 20000,  // joining voice gets this long (the SDK can sleep through rate limits for minutes)
  stopTimeoutMs: 3000,      // stop() waits this long for the run loop to wind down
  leaveTimeoutMs: 15000,    // bounds leaving voice, and leaving a join that completed after it was given up
});

/**
 * Thrown by play() or emitted with 'connectError'; the message is fit for chat. `channelId` is where the player is
 * busy (BUSY_ELSEWHERE) or failed to join in time (CONNECT_TIMEOUT).
 */
export class PlayerError extends Error {
  /** @param {'DESTROYED'|'BUSY_ELSEWHERE'|'CONNECT_TIMEOUT'} code */
  constructor(code, message, channelId = null) {
    super(message);
    this.name = 'PlayerError';
    this.code = code;
    this.channelId = channelId;
  }
}

const KICKED = Symbol('kicked');
const TIMED_OUT = Symbol('timed out');

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
 * Events (never 'error'; a throwing listener is logged and can't break playback):
 *  - 'stateChange' (state), 'volumeChange' (volume)
 *  - 'queueUpdate' ({ reason }): 'add', 'advance', 'skip', 'shuffle', 'remove', 'clear' or 'loop'
 *  - 'trackStart' (track): first audio on its way; once per play (a loop replay is a new play, a retry isn't)
 *  - 'trackEnd' (track, { reason: 'ended'|'skipped'|'failed'|'stopped' }): pairs with 'trackStart'
 *  - 'trackError' (track, Error): unplayable, so dropped even when looping; the message is fit for chat
 *  - 'connectError' (Error): the join failed or timed out; the player then stops with 'error'
 *  - 'queueEnd' ({ idleTimeoutMs }), 'alone' ({ timeoutMs }): a countdown to leaving started (0: leaving now)
 *  - 'destroy' ({ reason, error }): exactly once, after leaving voice
 */
export class Player extends EventEmitter {
  serverId;
  /** @type {string|null} the voice channel it plays in or is joining */
  channelId = null;
  /** @type {string|null} set by the cog, for display */
  channelName = null;
  /** @type {string|null} set by the cog: where it posts about this player */
  textChannelId = null;
  /** @type {Promise<void>} resolves after 'destroy'; never rejects */
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
  #targetGain;              // the next frame ramps from #appliedGain to this
  #appliedGain;
  #state = PlayerState.IDLE;
  #paused = false;
  /** @type {VoiceLink|null} */
  #conn = null;
  #connListeners = null;
  #connecting = false;
  #looping = false;         // a run loop is live and picks up new tracks by itself
  /** @type {Promise<void>|null} */
  #running = null;
  #waitFor;                 // the previous player leaving: awaited before the first join, then cleared
  #predecessor;             // the same promise, kept for #finish to await before 'destroy'
  #moving = null;           // leaving the old channel of a move
  #play = null;             // the play in progress: { track, aborted, started, ended }
  /** @type {Decoder|null} */
  #decoder = null;
  #framesPlayed = 0;
  #seq = 0;                 // bumped on every queue move, so the run loop can tell its track was skipped
  #parked = new Set();
  #idleTimer = null;
  #presenceTimer = null;
  #aloneTimer = null;
  #alone = false;           // counting down to stop('alone'), or taking the last look
  #aloneRound = 0;          // bumped on cancel, so a confirmation already under way is ignored
  #presenceOwed = false;    // a presence check came while joining: it runs once the connection is up
  #late = null;             // leaving a connection that arrived after the join was given up
  /** @type {Promise<void>|null} */
  #stopping = null;
  #markDestroyed;

  /**
   * @param {object} opts
   * @param {string} opts.serverId
   * @param {(channelId: string, opts: { signal: AbortSignal }) => Promise<VoiceLink>} opts.connect `signal` aborts
   *   once the player gives up on the join; a rejection's message is shown in chat
   * @param {(track: Track) => Decoder} opts.spawnDecoder
   * @param {() => Promise<number|null>} [opts.countListeners] people in its channel besides the bot
   * @param {number} [opts.volume] percent, 1..200
   * @param {number} [opts.maxQueueSize]
   * @param {number} [opts.idleTimeoutMs] how long to stay once the queue runs dry (0: leave at once)
   * @param {number} [opts.aloneTimeoutMs] how long to stay alone in the channel (0: leave at once)
   * @param {Promise<unknown>|null} [opts.waitFor] the server's previous player leaving voice (its whenDestroyed)
   * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.timers]
   * @param {Logger} [opts.logger]
   * @param {number} [opts.maxStreamRetries] how often a dropped live stream is retried
   * @param {((volume: number) => void)|null} [opts.onVolumeChange]
   * @param {Partial<typeof PLAYER_TIMINGS>} [opts.timings]
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

  get state() { return this.#state; }
  /** Change it only through the player, which emits 'queueUpdate' and keeps the run loop in step. */
  get queue() { return this.#queue; }
  get current() { return this.#queue.current; }
  get paused() { return this.#paused; }
  get volume() { return this.#volume; }
  get loop() { return this.#queue.loop; }
  /** Seconds of the current track heard so far: frames sent minus what LiveKit still has queued. */
  get position() {
    if (!this.#queue.current) return 0;
    const queued = this.#conn?.source?.queuedDuration;
    const ms = this.#framesPlayed * FRAME_MS - (typeof queued === 'number' && Number.isFinite(queued) ? queued : 0);
    return Math.max(0, ms) / 1000;
  }
  /** True as soon as stop() is called, before 'destroy'. */
  get destroyed() { return this.#stopping !== null; }
  /** Playing, queued or joining, so play() for another channel is refused (BUSY_ELSEWHERE). */
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
   * Returns at once; joining (or moving from an idle channel) and decoding run detached.
   * @returns {{ position: number, startedNow: boolean }} position: 0 if it starts now, else 1-based in upcoming
   * @throws {PlayerError} DESTROYED after stop(); BUSY_ELSEWHERE when busy in another channel
   * @throws {import('./queue.js').QueueFullError}
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
    const position = this.#queue.add(track); // first: a QueueFullError must leave everything as it was
    this.#clearIdle();
    if (!busy) {
      this.channelId = target;  // idle elsewhere: the run loop moves (leave, then join here)
      this.#advance('ended');   // nothing current or queued: this track becomes current
    }
    this.#emit('queueUpdate', { reason: 'add' });
    this.#start();
    return busy ? { position, startedNow: false } : { position: 0, startedNow: true };
  }

  /** Nothing is killed (see #decode). False when nothing is playing or it's already paused. */
  pause() {
    if (this.destroyed || this.#paused || !this.#queue.current) return false;
    this.#paused = true;
    if (this.#state === PlayerState.PLAYING) this.#setState(PlayerState.PAUSED);
    return true;
  }

  /** A live stream comes back live. False when it wasn't paused. */
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

  /** Unpauses and moves on, in any state (also mid-join or mid-retry). @returns {Track|null} null if none played */
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
   * Forgets the queue and leaves voice, then emits 'destroy'; never rejects. The player is dead from the first call
   * (play() throws DESTROYED), and later calls return the same promise, so the first reason wins.
   */
  stop(reason = 'stopped') { return this.#shutdown(reason, null); }

  /**
   * Percent, rounded and clamped to 1..200, and returned as set. The next frame ramps to it, so it doesn't click.
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

  cycleLoop() { return this.setLoop(nextLoopMode(this.#queue.loop)); }

  /** Also takes parseLoopMode's aliases ('all', 'one', ...); throws a TypeError for anything else. */
  setLoop(mode) {
    const value = LOOP_MODES.includes(mode) ? mode : parseLoopMode(mode);
    if (!value) throw new TypeError(`Loop mode must be one of ${LOOP_MODES.join(', ')}`);
    this.#queue.loop = value;
    this.#emit('queueUpdate', { reason: 'loop' });
    return value;
  }

  /** @returns {number} how many upcoming tracks were shuffled */
  shuffle(random) {
    const n = this.#queue.shuffle(random);
    this.#emit('queueUpdate', { reason: 'shuffle' });
    return n;
  }

  remove(position) {
    const track = this.#queue.remove(position);
    this.#emit('queueUpdate', { reason: 'remove' });
    return track;
  }

  /** The current track plays on. @returns {number} how many were removed */
  clear() {
    const n = this.#queue.clear();
    this.#emit('queueUpdate', { reason: 'clear' });
    return n;
  }

  /**
   * Called on voice_join/voice_leave. Debounced to one check per burst, since a check can cost a rate-limited voice
   * lookup. Nobody else in the channel starts a countdown to stop('alone'); someone coming back cancels it.
   */
  checkPresence() {
    if (this.destroyed || this.#presenceTimer !== null) return;
    this.#presenceTimer = this.#timers.setTimeout(() => {
      this.#presenceTimer = null;
      this.#checkPresenceNow().catch((err) => this.#log.warn('presence check failed:', err));
    }, this.#t.presenceDebounceMs);
  }

  #start() {
    if (this.destroyed) return;
    if (this.#looping) { this.#kick(); return; } // e.g. parked in #drain: the kick lets it take the new track
    this.#looping = true;
    this.#running = this.#run();
  }

  /** At most one runs at a time. Detached (only #finish awaits it), so it must never reject. */
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

  /** The current connection, or a fresh join (leaving the old channel first on a move). Null once stopping. */
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
        // Given up (stop() or too slow), but the join may still complete. Aborting tells connect() not to disturb a
        // later session; a connection that arrives anyway is left at once, so the bot isn't stranded in voice.
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
        // Voice events came in while joining, and none will repeat now that we're in: check once.
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
      // captureFrame failed, so the call is gone. #shutdown ends this play as 'stopped'.
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

  /** One play, retrying a live stream that drops. Resolves { outcome, error }. */
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

  /** One decoder run. Resolves { frames, error (fit for chat), retry (worth another try), voiceError }. */
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
          // Live: keep reading and drop the frames, so the station doesn't stall us and resume is live.
          if (track.live) continue;
          // File: hold this frame. Unread, the pipe fills and ffmpeg blocks, so nothing is lost.
          await this.#park(null, { until: () => !this.#paused || !!play.aborted });
          if (play.aborted) break;
        }
        const target = this.#targetGain;
        applyGain(pcm, this.#appliedGain, target); // ramps across this frame: a volume change doesn't click
        this.#appliedGain = target;
        try {
          const sent = conn.source.captureFrame(conn.createFrame(pcm));
          // A hung send must not hang skip/stop: stop waiting for it once the play is aborted.
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
      // A station never ends on its own: its server closed the stream (a restart, a recycled connection), and ffmpeg
      // doesn't reconnect after a clean end, so retry it like a drop. A link may be a finite file, so it can end.
      return { frames, error: new Error('The station closed the stream'), retry: true, voiceError: null };
    }
    const error = new Error(summarizeFfmpegError(res.stderr, code), readError ? { cause: readError } : undefined);
    // Before any audio, a refusal (HTTP 4xx) or something that isn't audio (a web page) won't change on a retry.
    return { frames, error, retry: play.started || !isLastingFfmpegError(res.stderr), voiceError: null };
  }

  /** Lets the buffered tail play out (bounded); a new track or stop() cuts it short. */
  async #drain() {
    const source = this.#conn?.source;
    if (typeof source?.waitForPlayout !== 'function') return;
    const playout = Promise.resolve().then(() => source.waitForPlayout()).catch(() => {});
    await this.#park(playout, { ms: this.#t.playoutTimeoutMs, until: () => this.destroyed || !!this.#queue.current });
  }

  #finishQueue() {
    this.#looping = false; // before the 'stateChange' below, so a listener's play() starts a new run
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
    this.#kick(); // the run loop's waits all give up now, their timers with them
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
      // 'destroy' lets the server's next player join, so first finish all voice work this one started or waited
      // for, each part bounded: its own leave, the old channel of a move, a late join, and the previous player's
      // leave (this one may have been stopped before that one was out).
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

  /** Bounded; never throws. */
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

  /** Aborts and silences the play in progress. Returns it if it still has to report its end, else null. */
  #abortPlay(reason) {
    const play = this.#play && !this.#play.aborted ? this.#play : null;
    if (play) play.aborted = reason;
    try { this.#decoder?.kill(); } catch (err) { this.#log.debug('killing the decoder failed:', err); }
    // Drop the audio already queued in LiveKit (AUDIO_QUEUE_MS), so skip and stop are heard at once.
    try { this.#conn?.source?.clearQueue?.(); } catch (err) { this.#log.debug('clearQueue failed:', err); }
    return play;
  }

  #endPlay(play, reason) {
    if (play.ended) return;
    play.ended = true;
    if (play.started) this.#emit('trackEnd', play.track, { reason });
  }

  /** Every queue move goes through here: #seq tells the run loop its track was skipped. */
  #advance(reason) {
    this.#seq++;
    this.#framesPlayed = 0;
    return this.#queue.advance(reason);
  }

  async #checkPresenceNow() {
    const conn = this.#conn;
    if (this.destroyed) return;
    if (!conn) {
      // Still joining: everyone may be gone by the time we're in, and no voice event would say so. Check then.
      if (this.#connecting) this.#presenceOwed = true;
      return;
    }
    const count = await this.#countPeople(conn);
    if (this.destroyed || this.#conn !== conn || count === null) return; // unknown: change nothing
    if (count > 0) { this.#cancelAlone(); return; }
    if (this.#alone) return;
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
   * Waits for `promise` (null: nothing) for at most `ms`, giving up once `until()` holds; that's checked now and on
   * every #kick(). Resolves the promise's value, TIMED_OUT or KICKED, or rejects with the promise. The timer never
   * outlives the wait, so a kicked wait leaves no timer behind.
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

  /** Call after any change a parked wait's until() may be watching. */
  #kick() {
    for (const waiter of [...this.#parked]) if (waiter.until?.()) waiter.wake();
  }

  #setState(state) {
    if (state === this.#state || this.#state === PlayerState.DESTROYED) return;
    this.#state = state;
    this.#emit('stateChange', state);
  }

  #emit(event, ...args) {
    try { this.emit(event, ...args); } catch (err) { this.#log.error(`a '${event}' listener threw:`, err); }
  }
}

/**
 * One player per server. A stopped player is replaced on the next obtain() by a fresh one that waits until the old
 * one is out of voice. Per-server settings (the volume) outlive the players.
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

  /** @returns {Player|undefined} undefined when the server has no player or it was stopped */
  get(serverId) {
    const player = this.#players.get(String(serverId));
    return player && !player.destroyed ? player : undefined;
  }

  /**
   * The server's player, or a new one with the remembered volume. While the previous player is still stopping, the
   * new one gets its whenDestroyed as `waitFor`, so the old leave can't race the new join.
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

  /** Kept for the life of the process: { volume }. */
  settings(serverId) {
    const key = String(serverId);
    let settings = this.#settings.get(key);
    if (!settings) this.#settings.set(key, (settings = { volume: this.#defaultVolume }));
    return settings;
  }

  get size() { return this.values().length; }

  /** @returns {Player[]} the players stop() hasn't been called on */
  values() { return [...this.#players.values()].filter((player) => !player.destroyed); }

  /** Stops every player, stopping ones included, and waits until all are out of voice. Never rejects. */
  async destroyAll(reason = 'shutdown') {
    await Promise.allSettled([...this.#players.values()].map((player) => player.stop(reason)));
  }
}
