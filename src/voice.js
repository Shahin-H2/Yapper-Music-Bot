/**
 * Voice for Music Bot: joining a channel through yapper.js and @livekit/rtc-node, and knowing who is in voice.
 * connectVoice wraps bot.connectVoice, which leaves a half-failed join connected and gives its AudioSource LiveKit's
 * default 1000 ms queue (pause and volume would lag by a second).
 */
import { EventEmitter } from 'node:events';
import { createLogger } from './log.js';

/** @typedef {import('./log.js').Logger} Logger */
/** @typedef {{ room?: any, source: any, track?: any, e2ee?: boolean, leave: () => Promise<void> }} VoiceCall */
/** @typedef {{ channel_id: string, user_ids: string[] }} VoiceChannelState */

// What the player feeds and yapper.js publishes: 48 kHz stereo in 10 ms frames.
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const SAMPLES_PER_CHANNEL = 480;
const FRAME_SAMPLES = SAMPLES_PER_CHANNEL * CHANNELS;
const LEAVE_TIMEOUT_MS = 5000;

// Runs `work`, waiting at most `ms`. Resolves { ok, error } and never rejects; a timeout doesn't stop `work`.
function settle(work, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: new Error(`timed out after ${ms} ms`) }), ms);
    const done = (result) => { clearTimeout(timer); resolve(result); };
    Promise.resolve().then(work).then(() => done({ ok: true, error: null }), (error) => done({ ok: false, error }));
  });
}

function positiveMs(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number of milliseconds, got ${value}`);
  }
  return value;
}

function positiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer, got ${value}`);
  return value;
}

const messageOf = (e) => (e instanceof Error ? e.message : String(e));

// Finishes LiveKit's cleanup of a room the server dropped: @livekit/rtc-node 1.2.1 takes a room off its global FFI
// event feed only in disconnect(), a no-op once disconnected, so each dropped room would stay in memory and handle
// every FFI event (one per frame sent) for the life of the process. A still-connected room is released when it drops.
function releaseRoom(room) {
  if (typeof room?.removeAllListeners !== 'function') return;
  const release = () => {
    try {
      const feed = globalThis._ffiClientInstance; // rtc-node's FfiClient
      if (typeof room.onFfiEvent === 'function') feed?.off?.('ffi_event', room.onFfiEvent);
      room.removeAllListeners();
    } catch { /* LiveKit internals changed: best effort only */ }
  };
  if (room.isConnected === false) release();
  else room.once?.('disconnected', release);
}

/** Text for the person who ran /play when a join fails; reads bot.api's `.status` and `.retryAfter` (seconds). */
export function voiceErrorMessage(err) {
  const e = /** @type {any} */ (err);
  switch (Number(e?.status)) {
    case 403: return "I don't have permission to join that voice channel.";
    case 404: return "That voice channel doesn't exist anymore.";
    case 429: {
      const wait = Math.ceil(Number(e.retryAfter));
      return `Yapin’ is rate-limiting my voice joins right now. Try again in ${wait > 0 ? `${wait} s` : 'a minute'}.`;
    }
    default: break;
  }
  if (e?.name === 'TimeoutError') return 'Yapin’ took too long to answer. Try again in a moment.';
  if (typeof e?.message === 'string' && e.message) return e.message;
  if (typeof err === 'string' && err) return err;
  return 'Something went wrong while joining voice.';
}

/**
 * Joins a voice channel through bot.connectVoice. A failed join is torn down (room, track, the bot's voice state on
 * Yapin’) and rethrown as Error(voiceErrorMessage(e), { cause: e }) with e's `.status` and `.retryAfter`.
 * Aborting `signal` means the caller gave up and the server may already have a newer session: an unconnected room
 * never connects, and a join that lands or fails later is torn down without POST /voice/leave, which would take that
 * newer session out of voice. The promise then rejects with `signal.reason`.
 * @param {{ bot: any, rtc: any, serverId: string, channelId: string, queueMs?: number, bitrate?: number,
 *   logger?: Logger, leaveTimeoutMs?: number, signal?: AbortSignal|null }} opts
 *   rtc: the @livekit/rtc-node module; queueMs: native audio queue length, a multiple of 10; leaveTimeoutMs: bound
 *   on each cleanup step, here and in VoiceConnection#leave
 * @returns {Promise<VoiceConnection>}
 */
export async function connectVoice({
  bot, rtc, serverId, channelId, queueMs = 200, bitrate = 128000, logger, leaveTimeoutMs = LEAVE_TIMEOUT_MS,
  signal = null,
} = /** @type {any} */ ({})) {
  if (typeof bot?.connectVoice !== 'function') throw new TypeError('connectVoice needs the yapper.js bot');
  if (![rtc?.Room, rtc?.AudioSource, rtc?.AudioFrame].every((c) => typeof c === 'function')) {
    throw new TypeError("connectVoice needs the @livekit/rtc-node module (import * as rtc from '@livekit/rtc-node')");
  }
  if (!serverId || !channelId) throw new TypeError('connectVoice needs a serverId and a channelId');
  positiveInt(queueMs, 'queueMs');
  // LiveKit panics on any other queue size, and a native panic aborts the whole process (no try/catch helps).
  if (queueMs % 10 !== 0) throw new RangeError(`queueMs must be a multiple of 10, got ${queueMs}`);
  positiveInt(bitrate, 'bitrate');
  positiveMs(leaveTimeoutMs, 'leaveTimeoutMs');
  if (signal !== null && typeof signal?.aborted !== 'boolean') throw new TypeError('signal must be an AbortSignal');
  const log = logger ?? createLogger('voice');
  const cancelled = () => signal?.aborted === true;
  const cancel = () => signal?.reason ?? Object.assign(new Error('The join was called off'), { name: 'AbortError' });
  if (cancelled()) throw cancel();

  // Whatever the SDK builds through our copy of the module, so a half-finished join can be torn down.
  const built = { room: null, source: null, track: null };
  const mod = {
    ...rtc,
    // A short native queue: pause, skip and volume are heard within ~queueMs instead of a whole second.
    AudioSource: class QueuedAudioSource extends rtc.AudioSource {
      constructor(sampleRate, numChannels) { super(sampleRate, numChannels, queueMs); built.source = this; }
    },
    Room: class TrackedRoom extends rtc.Room {
      constructor(...args) { super(...args); built.room = this; }
      // A join given up on goes no further: connecting now (same identity) could knock out a newer session.
      connect(...args) { return cancelled() ? Promise.reject(cancel()) : super.connect(...args); }
    },
  };
  const Track = rtc.LocalAudioTrack;
  if (typeof Track === 'function' && typeof Track.createAudioTrack === 'function') {
    mod.LocalAudioTrack = class TrackedAudioTrack extends Track {
      static createAudioTrack(name, source) { return (built.track = super.createAudioTrack(name, source)); }
    };
  }

  let call = null;
  try {
    call = await bot.connectVoice(mod, serverId, channelId, { sampleRate: SAMPLE_RATE, channels: CHANNELS, bitrate });
    if (!call?.source) throw new Error('Joined voice but got no audio source back');
    if (cancelled()) throw cancel(); // joined after all, but the caller has given up
    const conn = new VoiceConnection({ bot, rtc, call, serverId, channelId, logger: log, leaveTimeoutMs });
    log.debug(`joined voice channel ${channelId} in ${serverId}${conn.e2ee ? ' (end-to-end encrypted)' : ''}`);
    return conn;
  } catch (e) {
    log.debug(`joining voice channel ${channelId} in ${serverId} failed:`, e);
    const room = built.room ?? call?.room;
    const track = built.track ?? call?.track;
    const source = built.source ?? call?.source;
    const teardown = async () => {
      if (room) await settle(() => room.disconnect(), leaveTimeoutMs);
      releaseRoom(room);
      // track.close() closes its source too; a source without a track (it failed before that) closes alone.
      await settle(() => (track ? track.close() : source?.close()), leaveTimeoutMs);
    };
    // Called off: a newer session may be in voice by now, and the server-wide leave would take it out too.
    const leave = cancelled() ? null : settle(() => bot.leaveVoice(serverId), leaveTimeoutMs);
    const [, left] = await Promise.all([teardown(), leave]);
    if (left && !left.ok) {
      log.debug(`leaveVoice(${serverId}) after the failed join didn't work: ${messageOf(left.error)}`);
    }
    if (cancelled()) throw cancel(); // the caller gave up, so how the join failed no longer matters
    const err = new Error(voiceErrorMessage(e), { cause: e });
    err.status = e?.status;
    if (e?.retryAfter !== undefined) err.retryAfter = e.retryAfter;
    throw err;
  }
}

/**
 * One live voice call (what connectVoice returns). Events:
 *  - 'disconnected' (reason): the room dropped us. Never emitted for a disconnect leave() started.
 *  - 'participantsChanged' (count|null): someone joined or left the room.
 */
export class VoiceConnection extends EventEmitter {
  channelId;
  serverId;
  e2ee;
  #bot;
  #rtc;
  #call;
  #room;
  #log;
  #timeoutMs;
  #listeners = [];
  #leaving = null;
  #hangingUp = false;
  #lost = false;

  /**
   * @param {{ bot: any, rtc: any, call: VoiceCall, serverId: string, channelId: string, logger?: Logger,
   *   leaveTimeoutMs?: number }} opts call: what bot.connectVoice returned; leaveTimeoutMs bounds each leave() step
   */
  constructor({
    bot, rtc, call, serverId, channelId, logger, leaveTimeoutMs = LEAVE_TIMEOUT_MS,
  } = /** @type {any} */ ({})) {
    super();
    if (!call?.source) throw new TypeError('VoiceConnection needs the call from bot.connectVoice');
    if (typeof rtc?.AudioFrame !== 'function') throw new TypeError('VoiceConnection needs the rtc module');
    this.#bot = bot;
    this.#rtc = rtc;
    this.#call = call;
    this.#room = call.room ?? null;
    this.#log = logger ?? createLogger('voice');
    this.#timeoutMs = positiveMs(leaveTimeoutMs, 'leaveTimeoutMs');
    this.serverId = serverId;
    this.channelId = channelId;
    this.e2ee = !!call.e2ee;
    const ev = rtc.RoomEvent ?? {};
    this.#listen(ev.Disconnected ?? 'disconnected', (reason) => this.#dropped(reason));
    this.#listen(ev.ParticipantConnected ?? 'participantConnected', () => this.#participantsChanged());
    this.#listen(ev.ParticipantDisconnected ?? 'participantDisconnected', () => this.#participantsChanged());
    // Gone before we could listen: still say so, once the caller has had a chance to subscribe.
    if (this.#room?.isConnected === false) setImmediate(() => this.#dropped(null));
  }

  get source() { return this.#call.source; }

  /** True once leave() was called or the room dropped us. */
  get closed() { return this.#lost || this.#hangingUp; }

  /**
   * 10 ms of interleaved 48 kHz stereo s16 (960 samples) as an rtc.AudioFrame. LiveKit reads the frame's whole
   * ArrayBuffer from offset 0, so a view into a bigger buffer is copied first.
   */
  createFrame(pcm) {
    if (!(pcm instanceof Int16Array)) throw new TypeError('createFrame needs an Int16Array');
    if (pcm.length !== FRAME_SAMPLES) throw new RangeError(`a frame is ${FRAME_SAMPLES} samples, got ${pcm.length}`);
    const own = pcm.byteOffset === 0 && pcm.buffer.byteLength === pcm.byteLength;
    return new this.#rtc.AudioFrame(own ? pcm : pcm.slice(), SAMPLE_RATE, CHANNELS, SAMPLES_PER_CHANNEL);
  }

  /** People in the room besides the bot, or null when unknown (no room info, or the call is over). */
  participantCount() {
    if (this.closed) return null;
    const size = this.#room?.remoteParticipants?.size;
    return Number.isInteger(size) && size >= 0 ? size : null;
  }

  /**
   * Hangs up: call.leave() (bounded), close the track, and if call.leave() failed or timed out, ask Yapin’ to take
   * the bot out of voice. Returns the same promise on every call; it never rejects.
   */
  leave() {
    if (!this.#leaving) {
      // Set before call.leave(): room.disconnect() reports our own hang-up to our 'disconnected' listener too.
      this.#hangingUp = true;
      this.#leaving = this.#hangUp();
    }
    return this.#leaving;
  }

  async #hangUp() {
    this.#detach();
    const call = this.#call;
    const ms = this.#timeoutMs;
    const left = await settle(() => call.leave(), ms);
    releaseRoom(this.#room); // after a server-side drop, room.disconnect() (in call.leave) leaves this undone
    if (!left.ok) {
      this.#log.warn(`leaving voice in ${this.serverId} failed (${messageOf(left.error)}); asking Yapin’ instead`);
    }
    const [closed, kicked] = await Promise.all([
      settle(() => (call.track ? call.track.close() : call.source.close()), ms),
      left.ok ? null : settle(() => this.#bot.leaveVoice(this.serverId), ms),
    ]);
    if (!closed.ok) this.#log.debug(`closing the audio track failed: ${messageOf(closed.error)}`);
    if (kicked && !kicked.ok) this.#log.warn(`couldn't leave voice in ${this.serverId}: ${messageOf(kicked.error)}`);
  }

  #listen(event, fn) {
    if (typeof this.#room?.on !== 'function') return;
    this.#room.on(event, fn);
    this.#listeners.push([event, fn]);
  }

  #detach() {
    const room = this.#room;
    for (const [event, fn] of this.#listeners.splice(0)) {
      try { (room.off ?? room.removeListener).call(room, event, fn); } catch { /* room already torn down */ }
    }
  }

  #dropped(reason) {
    if (this.#hangingUp || this.#lost) return; // our own leave(), or already reported
    this.#lost = true;
    this.#detach();
    // LiveKit reasons are numeric enum values; the enum maps them back to names for the log.
    const name = typeof reason === 'number' ? this.#rtc.DisconnectReason?.[reason] ?? reason : reason;
    const why = name === null || name === undefined ? '' : ` (${name})`;
    this.#log.info(`voice in ${this.serverId} was disconnected${why}`);
    this.#emit('disconnected', reason);
  }

  #participantsChanged() {
    if (!this.closed) this.#emit('participantsChanged', this.participantCount());
  }

  #emit(event, ...args) {
    // We're inside the room's own emit: a throwing listener must not break LiveKit's event handling.
    try { this.emit(event, ...args); } catch (e) { this.#log.error(`a '${event}' listener threw:`, e); }
  }
}

function keyOf(serverId) {
  if (serverId === undefined || serverId === null || serverId === '') throw new TypeError('A server id is needed');
  return String(serverId);
}

/**
 * Who is in which voice channel of a server, from GET /servers/:id/voice without the SDK's long 429 retries.
 * Answers are cached for ttlMs per server and concurrent lookups share one request (60 lookups a minute per bot).
 */
export class VoiceDirectory {
  #bot;
  #ttlMs;
  #absentMs;
  #timeoutMs;
  #now;
  #cache = new Map();
  #inflight = new Map();
  // server -> (user id -> when a fresh lookup found them outside voice), oldest first
  #absent = new Map();

  /**
   * @param {any} bot the yapper.js bot (only bot.api is used)
   * @param {{ ttlMs?: number, absentMs?: number, timeoutMs?: number, now?: () => number }} [opts]
   *   ttlMs: how long an answer is reused (0 = never); absentMs: how long channelOf remembers someone it found
   *   outside voice (0 = never); timeoutMs: per request
   */
  constructor(bot, { ttlMs = 5000, absentMs = 15000, timeoutMs = 2500, now = Date.now } = {}) {
    if (typeof bot?.api !== 'function') throw new TypeError('VoiceDirectory needs the yapper.js bot');
    if (typeof ttlMs !== 'number' || !(ttlMs >= 0)) throw new RangeError(`ttlMs must be >= 0, got ${ttlMs}`);
    if (typeof absentMs !== 'number' || !(absentMs >= 0)) {
      throw new RangeError(`absentMs must be >= 0, got ${absentMs}`);
    }
    if (typeof now !== 'function') throw new TypeError('VoiceDirectory: now must be a function');
    this.#bot = bot;
    this.#ttlMs = ttlMs;
    this.#absentMs = absentMs;
    this.#timeoutMs = positiveMs(timeoutMs, 'timeoutMs');
    this.#now = now;
  }

  /**
   * A copy of every voice channel of the server and who is in it. Rejects with the API's error (with `.status`).
   * @param {{ fresh?: boolean }} [opts] fresh: skip the cache (a request already on its way is still shared)
   * @returns {Promise<VoiceChannelState[]>}
   */
  async snapshot(serverId, { fresh = false } = {}) {
    const { channels } = await this.#get(keyOf(serverId), fresh);
    return channels.map((c) => ({ ...c, user_ids: [...c.user_ids] }));
  }

  /**
   * The voice channel `userId` is in, or null. A cached "not in voice" is checked once more with a fresh lookup
   * (they may have joined since). A fresh "not in voice" is then reused for absentMs unless the cache shows them in a
   * channel or invalidate() runs, so repeating /play or clicking a button can't spend the bot's 60 lookups a minute,
   * which every server shares.
   * @param {{ fresh?: boolean }} [opts] fresh: skip the cache and that memory
   */
  async channelOf(serverId, userId, { fresh = false } = {}) {
    if (userId === undefined || userId === null || userId === '') return null;
    const key = keyOf(serverId);
    const want = String(userId);
    const find = (channels) => channels.find((c) => c.user_ids.some((id) => String(id) === want))?.channel_id ?? null;
    let absent = this.#absent.get(key);
    if (!absent) this.#absent.set(key, (absent = new Map()));
    const since = this.#now() - (absent.get(want) ?? NaN);
    if (!fresh && since >= 0 && since < this.#absentMs) return find(this.#cached(key) ?? []);
    const first = await this.#get(key, fresh);
    let found = find(first.channels);
    if (found === null && first.cached) found = find((await this.#get(key, true)).channels);
    if (found !== null) absent.delete(want);
    else if (this.#absent.get(key) === absent) this.#remember(absent, want); // not if invalidate() came meanwhile
    return found;
  }

  /**
   * Who is in that channel now (always a fresh lookup), minus `excludeIds` (such as the bot) and duplicates.
   * @param {Iterable<string>|string} [excludeIds]
   */
  async othersIn(serverId, channelId, excludeIds = []) {
    const { channels } = await this.#get(keyOf(serverId), true);
    const many = typeof excludeIds !== 'string' && typeof excludeIds?.[Symbol.iterator] === 'function';
    const skip = new Set((many ? [...excludeIds] : excludeIds == null ? [] : [excludeIds]).map(String));
    const channel = channels.find((c) => String(c.channel_id) === String(channelId));
    const others = [];
    for (const id of channel?.user_ids ?? []) {
      if (!skip.has(String(id))) { skip.add(String(id)); others.push(id); } // also drops duplicates
    }
    return others;
  }

  /**
   * Forgets a server's voice state (call on voice_join and voice_leave); a lookup already on its way is neither cached
   * nor shared afterwards. Without a server id, which voice events may lack, forgets every server.
   */
  invalidate(serverId) {
    if (serverId === undefined || serverId === null || serverId === '') {
      this.#cache.clear();
      this.#inflight.clear();
      this.#absent.clear();
      return;
    }
    this.#cache.delete(String(serverId));
    this.#inflight.delete(String(serverId));
    this.#absent.delete(String(serverId));
  }

  // The server's cached channels while they are fresh, else null.
  #cached(key) {
    const hit = this.#cache.get(key);
    const age = hit ? this.#now() - hit.at : NaN;
    return age >= 0 && age < this.#ttlMs ? hit.channels : null;
  }

  // Notes `userId` as outside voice now; re-insertion keeps the map oldest first, so pruning can stop early.
  #remember(absent, userId) {
    const now = this.#now();
    absent.delete(userId);
    absent.set(userId, now);
    for (const [id, at] of absent) {
      if (now - at < this.#absentMs) break;
      absent.delete(id);
    }
  }

  async #get(key, fresh) {
    const cached = fresh ? null : this.#cached(key);
    if (cached) return { channels: cached, cached: true };
    let entry = this.#inflight.get(key);
    if (!entry) {
      const at = this.#now();
      const current = { promise: null };
      // Only the request still registered may fill the cache: invalidate() orphans the one on its way.
      const mine = () => this.#inflight.get(key) === current && this.#inflight.delete(key);
      current.promise = this.#fetch(key).then(
        (channels) => { if (mine()) this.#cache.set(key, { at, channels }); return channels; },
        (e) => { mine(); throw e; },
      );
      this.#inflight.set(key, current);
      entry = current;
    }
    return { channels: await entry.promise, cached: false };
  }

  async #fetch(key) {
    const out = await this.#bot.api('GET', `/servers/${encodeURIComponent(key)}/voice`, undefined,
      { timeout: this.#timeoutMs, retries: 0 });
    if (!Array.isArray(out?.voice)) throw new Error('Yapin’ sent an unexpected voice state');
    return Object.freeze(out.voice
      .filter((c) => c && typeof c === 'object' && c.channel_id !== undefined && c.channel_id !== null)
      .map((c) => Object.freeze({ ...c, user_ids: Object.freeze(Array.isArray(c.user_ids) ? [...c.user_ids] : []) })));
  }
}
