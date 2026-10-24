// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bot } from '../yapper.js';
import { VoiceConnection, VoiceDirectory, connectVoice, voiceErrorMessage } from '../src/voice.js';

// ---- fakes (no LiveKit, no network) ----

/** A logger that keeps its lines, so tests stay quiet and can check what was said. */
function quietLogger() {
  const lines = [];
  const at = (level) => (...args) => lines.push({ level, text: args.map(String).join(' ') });
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** A stand-in for @livekit/rtc-node that records what gets built; `behaviour` hooks make any step fail or hang. */
function fakeRtc(behaviour = {}) {
  const made = { rooms: [], sources: [], tracks: [], publishOptions: [] };
  class AudioSource {
    constructor(...args) { this.args = args; this.closed = false; made.sources.push(this); }
    async captureFrame() {}
    clearQueue() {}
    async close() { this.closed = true; }
  }
  class Room extends EventEmitter {
    remoteParticipants = new Map();
    isConnected = false;
    localParticipant = null;
    disconnects = 0;
    constructor() { super(); made.rooms.push(this); }
    async connect(url, token, opts) {
      this.connectArgs = [url, token, opts];
      if (behaviour.connect) await behaviour.connect(this);
      this.isConnected = true;
      this.localParticipant = {
        identity: 'bot-1',
        publishTrack: async (track, options) => {
          if (behaviour.publish) await behaviour.publish(this);
          this.published = { track, options };
        },
        setAttributes: async (attributes) => { this.attributes = attributes; },
        publishData: async () => {},
      };
    }
    // Like LiveKit: our listeners hear 'disconnected' first, then every listener is dropped.
    async disconnect() {
      this.disconnects++;
      if (behaviour.disconnect) await behaviour.disconnect(this);
      if (!this.isConnected) return;
      this.isConnected = false;
      this.emit('disconnected', 1);
      this.removeAllListeners();
    }
  }
  class LocalAudioTrack {
    // Like LiveKit: builds the base class, whatever `this` is.
    static createAudioTrack(name, source) { return new LocalAudioTrack(name, source); }
    constructor(name, source) { this.name = name; this.source = source; this.closed = false; made.tracks.push(this); }
    async close() { this.closed = true; await this.source.close(); }
  }
  class AudioFrame {
    constructor(data, sampleRate, channels, samplesPerChannel) {
      Object.assign(this, { data, sampleRate, channels, samplesPerChannel });
    }
  }
  class TrackPublishOptions {
    constructor(init) { Object.assign(this, init); made.publishOptions.push(this); }
  }
  // Frozen like a real module namespace: the adapter must copy it, never patch it.
  const rtc = Object.freeze({
    AudioSource, Room, LocalAudioTrack, AudioFrame, TrackPublishOptions,
    TrackSource: Object.freeze({ SOURCE_MICROPHONE: 2 }),
    RoomEvent: Object.freeze({
      Disconnected: 'disconnected', ParticipantConnected: 'participantConnected',
      ParticipantDisconnected: 'participantDisconnected',
    }),
    // Like a protobuf enum: maps values to names and names to values.
    DisconnectReason: Object.freeze({
      1: 'CLIENT_INITIATED', CLIENT_INITIATED: 1, 4: 'SERVER_SHUTDOWN', SERVER_SHUTDOWN: 4,
    }),
  });
  return { rtc, made };
}

/** The real yapper.js Bot (so its real connectVoice runs), with joinVoice/leaveVoice stubbed out. */
function realBot({ ticket = { url: 'wss://lk.test', token: 'lk-token', e2ee: false }, join, leave } = {}) {
  const bot = new Bot('yb_test', { log: false, gateway: false });
  const calls = { join: [], leave: [], modules: [] };
  bot.joinVoice = async (serverId, channelId) => {
    calls.join.push([serverId, channelId]);
    return join ? join(serverId, channelId) : ticket;
  };
  bot.leaveVoice = async (serverId) => {
    calls.leave.push(serverId);
    return leave ? leave(serverId) : {};
  };
  const sdkConnect = bot.connectVoice;
  bot.connectVoice = function (mod, ...rest) { calls.modules.push(mod); return sdkConnect.call(this, mod, ...rest); };
  return { bot, calls };
}

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);
const never = () => new Promise(() => {});

/** Fails the test instead of hanging when `promise` doesn't settle in time. */
async function within(promise, ms = 1000) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  try { return await Promise.race([promise, guard]); } finally { clearTimeout(timer); }
}

/** A connected VoiceConnection made through the real SDK path. */
async function connected(opts = {}) {
  const { rtc, made } = fakeRtc(opts.behaviour);
  const { bot, calls } = realBot(opts);
  const logger = quietLogger();
  const conn = await connectVoice({
    bot, rtc, serverId: 's1', channelId: 'vc1', leaveTimeoutMs: 20, logger, ...opts.connect,
  });
  return { conn, rtc, made, bot, calls, logger, room: made.rooms[0] };
}

/** A VoiceConnection around a hand-made call, for leave() edge cases. */
function manual({ leave = async () => {}, track = true, room = new EventEmitter(), bot } = {}) {
  const { rtc } = fakeRtc();
  const source = { closed: 0, async close() { this.closed++; } };
  const call = {
    room, source, e2ee: false, leaves: 0,
    async leave() { call.leaves++; return leave(); },
    track: track ? { closes: 0, async close() { this.closes++; await source.close(); } } : undefined,
  };
  const leaveVoice = [];
  const theBot = bot === undefined ? { async leaveVoice(id) { leaveVoice.push(id); } } : bot;
  const logger = quietLogger();
  const conn = new VoiceConnection({
    bot: theBot, rtc, call, serverId: 's1', channelId: 'vc1', logger, leaveTimeoutMs: 20,
  });
  return { conn, call, source, leaveVoice, logger };
}

// ---- tests ----

describe('voiceErrorMessage', () => {
  it('explains the statuses people hit', () => {
    assert.equal(voiceErrorMessage(httpError(403, 'Forbidden')), "I don't have permission to join that voice channel.");
    assert.equal(voiceErrorMessage(httpError(404, 'Not found')), "That voice channel doesn't exist anymore.");
    assert.equal(voiceErrorMessage(httpError('403', 'x')), "I don't have permission to join that voice channel.");
  });

  it('says when to retry after a 429', () => {
    assert.match(voiceErrorMessage(httpError(429, 'Too many', { retryAfter: 12.2 })), /rate-limiting.*in 13 s\.$/);
    assert.match(voiceErrorMessage(httpError(429, 'Too many')), /rate-limiting.*in a minute\.$/);
  });

  it('turns a request timeout into plain words', () => {
    assert.equal(voiceErrorMessage(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      'Yapin’ took too long to answer. Try again in a moment.');
  });

  it('otherwise uses the error message, with a fallback for odd values', () => {
    const generic = 'POST /servers/1/voice/join failed (500)';
    assert.equal(voiceErrorMessage(httpError(500, generic)), generic);
    assert.equal(voiceErrorMessage(new Error('engine: signal failure')), 'engine: signal failure');
    assert.equal(voiceErrorMessage('plain text'), 'plain text');
    for (const odd of [null, undefined, {}, new Error(''), 42]) {
      assert.equal(voiceErrorMessage(odd), 'Something went wrong while joining voice.');
    }
  });
});

describe('connectVoice', () => {
  it('hands the SDK a copy of rtc whose AudioSource forces the queue size', async () => {
    const { conn, rtc, made, calls } = await connected({ connect: { queueMs: 150, bitrate: 96000 } });
    const [mod] = calls.modules;
    assert.notEqual(mod, rtc);
    assert.equal(mod.AudioFrame, rtc.AudioFrame);
    assert.equal(mod.TrackPublishOptions, rtc.TrackPublishOptions);
    assert.equal(mod.TrackSource, rtc.TrackSource);
    assert.deepEqual(made.sources[0].args, [48000, 2, 150]);
    assert.ok(made.sources[0] instanceof rtc.AudioSource);
    assert.deepEqual(new mod.AudioSource(44100, 1, 5000).args, [44100, 1, 150], 'queue size forced even when asked');
    assert.deepEqual(new rtc.AudioSource(48000, 2).args, [48000, 2], 'the real class is untouched');
    assert.equal(made.publishOptions[0].audioEncoding.maxBitrate, 96000n);
    assert.equal(made.publishOptions[0].source, rtc.TrackSource.SOURCE_MICROPHONE);
    assert.deepEqual(calls.join, [['s1', 'vc1']]);
    assert.deepEqual(calls.leave, []);
    assert.ok(conn instanceof VoiceConnection);
    assert.equal(conn.serverId, 's1');
    assert.equal(conn.channelId, 'vc1');
    assert.equal(conn.e2ee, false);
    assert.equal(conn.source, made.sources[0]);
    assert.equal(conn.closed, false);
    assert.deepEqual(made.rooms[0].connectArgs.slice(0, 2), ['wss://lk.test', 'lk-token']);
    assert.equal(made.rooms[0].published.track, made.tracks[0]);
  });

  it('defaults to a 200 ms queue and 128 kbit/s', async () => {
    const { made } = await connected();
    assert.deepEqual(made.sources[0].args, [48000, 2, 200]);
    assert.equal(made.publishOptions[0].audioEncoding.maxBitrate, 128000n);
  });

  it('works for end-to-end encrypted calls', async () => {
    const { conn, room, made } = await connected({ ticket: { url: 'wss://lk.test', token: 't', e2ee: true } });
    assert.equal(conn.e2ee, true);
    assert.equal(room.connectArgs[2].encryption.keyProviderOptions.sharedKey.length, 32);
    assert.equal(typeof room.attributes.e2ee, 'string');
    await within(conn.leave());
    assert.equal(room.isConnected, false);
    assert.equal(made.tracks[0].closed, true);
  });

  it('a refused join (403): leaves voice server-side and throws a friendly error with cause and status', async () => {
    const original = httpError(403, 'Missing permission: Connect');
    const { rtc, made } = fakeRtc();
    const { bot, calls } = realBot({ join: () => { throw original; } });
    const err = await connectVoice({ bot, rtc, serverId: 's1', channelId: 'vc1', logger: quietLogger() }).then(
      () => assert.fail('should have thrown'), (e) => e);
    assert.ok(err instanceof Error);
    assert.equal(err.message, "I don't have permission to join that voice channel.");
    assert.equal(err.cause, original);
    assert.equal(err.status, 403);
    assert.deepEqual(calls.leave, ['s1']);
    assert.equal(made.rooms.length, 0);
  });

  it('keeps retryAfter from a 429', async () => {
    const { rtc } = fakeRtc();
    const { bot } = realBot({ join: () => { throw httpError(429, 'Too many', { retryAfter: 7 }); } });
    await assert.rejects(connectVoice({ bot, rtc, serverId: 's1', channelId: 'vc1', logger: quietLogger() }),
      (e) => e.status === 429 && e.retryAfter === 7 && /in 7 s/.test(e.message));
  });

  it('fails after the room connected: disconnects that room, closes the track and leaves voice', async () => {
    const original = new Error('publish timed out');
    const { rtc, made } = fakeRtc({ publish: () => { throw original; } });
    const { bot, calls } = realBot();
    await assert.rejects(connectVoice({ bot, rtc, serverId: 's1', channelId: 'vc1', logger: quietLogger() }),
      (e) => e.message === 'publish timed out' && e.cause === original && e.status === undefined);
    assert.equal(made.rooms[0].disconnects, 1);
    assert.equal(made.rooms[0].isConnected, false);
    assert.equal(made.tracks[0].closed, true);
    assert.equal(made.sources[0].closed, true);
    assert.deepEqual(calls.leave, ['s1']);
  });

  it('fails in room.connect: still disconnects the recorded room and leaves voice', async () => {
    const { rtc, made } = fakeRtc({ connect: () => { throw new Error('engine: signal failure'); } });
    const { bot, calls } = realBot();
    await assert.rejects(connectVoice({ bot, rtc, serverId: 's1', channelId: 'vc1', logger: quietLogger() }),
      { message: 'engine: signal failure' });
    assert.equal(made.rooms[0].disconnects, 1);
    assert.equal(made.sources.length, 0);
    assert.deepEqual(calls.leave, ['s1']);
  });

  it('swallows cleanup errors and still throws the original failure', async () => {
    const original = new Error('publish failed');
    const { rtc } = fakeRtc({
      publish: () => { throw original; },
      disconnect: () => { throw new Error('disconnect broke too'); },
    });
    const { bot } = realBot({ leave: () => { throw httpError(500, 'leave broke'); } });
    await assert.rejects(connectVoice({ bot, rtc, serverId: 's1', channelId: 'vc1', logger: quietLogger() }),
      (e) => e.message === 'publish failed' && e.cause === original);
  });

  it('bounds the cleanup by leaveTimeoutMs when it hangs', async () => {
    const { rtc } = fakeRtc({ publish: () => { throw new Error('nope'); }, disconnect: never });
    const { bot, calls } = realBot({ leave: never });
    const started = Date.now();
    await within(assert.rejects(connectVoice({
      bot, rtc, serverId: 's1', channelId: 'vc1', leaveTimeoutMs: 20, logger: quietLogger(),
    }), { message: 'nope' }));
    assert.ok(Date.now() - started < 900);
    assert.deepEqual(calls.leave, ['s1']);
  });

  it('treats a call without an audio source as a failure, and tears down what it did return', async () => {
    const { rtc } = fakeRtc();
    const room = { disconnects: 0, async disconnect() { this.disconnects++; } };
    const track = { closes: 0, async close() { this.closes++; } };
    const left = [];
    // A bot that builds nothing through our module copy, so only the returned call says what exists.
    const bot = {
      connectVoice: async () => ({ room, track, leave: async () => {} }),
      leaveVoice: async (id) => { left.push(id); },
    };
    await assert.rejects(connectVoice({ bot, rtc, serverId: 's1', channelId: 'vc1', logger: quietLogger() }),
      /no audio source/);
    assert.equal(room.disconnects, 1);
    assert.equal(track.closes, 1);
    assert.deepEqual(left, ['s1']);
  });

  it('keeps concurrent joins apart: a failing one only tears down its own room', async () => {
    let publishes = 0;
    const { rtc, made } = fakeRtc({ publish: () => { if (++publishes === 2) throw new Error('second failed'); } });
    const { bot } = realBot();
    const logger = quietLogger();
    const [a, b] = await Promise.allSettled([
      connectVoice({ bot, rtc, serverId: 's1', channelId: 'vc1', logger }),
      connectVoice({ bot, rtc, serverId: 's2', channelId: 'vc2', logger }),
    ]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'rejected');
    assert.equal(made.rooms.length, 2);
    assert.equal(a.value.source, made.sources[0]);
    assert.equal(made.rooms[0].isConnected, true);
    assert.equal(made.rooms[1].isConnected, false);
    assert.equal(made.rooms[1].disconnects, 1);
    assert.equal(made.tracks[0].closed, false);
    assert.equal(made.tracks[1].closed, true);
  });

  describe('called off with its signal (the player gave up: stopped, or the join took too long)', () => {
    /** connectVoice on the real SDK path whose Yapin’ join waits until the test answers it. */
    function slowJoin(behaviour) {
      let answer;
      const ticket = new Promise((resolve, reject) => { answer = { resolve, reject }; });
      const { rtc, made } = fakeRtc(behaviour);
      const { bot, calls } = realBot({ join: () => ticket });
      const abort = new AbortController();
      const joining = connectVoice({ bot, rtc, serverId: 's1', channelId: 'vc1', logger: quietLogger(),
        leaveTimeoutMs: 20, signal: abort.signal });
      return { joining, abort, answer, made, calls };
    }

    it('before it starts: nothing is joined', async () => {
      const { rtc } = fakeRtc();
      const { bot, calls } = realBot();
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(connectVoice({ bot, rtc, serverId: 's1', channelId: 'vc1', signal: abort.signal }),
        { name: 'AbortError' });
      assert.deepEqual(calls.join, []);
    });

    it('a join that gets through afterwards never connects its room, and leaves nobody out of voice', async () => {
      const { joining, abort, answer, made, calls } = slowJoin();
      abort.abort();
      answer.resolve({ url: 'wss://lk.test', token: 't', e2ee: false });
      await assert.rejects(within(joining), { name: 'AbortError' });
      assert.equal(made.rooms.length, 1);
      assert.equal(made.rooms[0].connectArgs, undefined, 'the room never connected (same identity as a newer one)');
      assert.deepEqual(calls.leave, [], 'no server-wide leave: a newer session of the server may be in voice');
    });

    it('a join that fails afterwards (Yapin’ was rate-limiting it) leaves nobody out of voice either', async () => {
      const { joining, abort, answer, calls } = slowJoin();
      abort.abort();
      answer.reject(httpError(429, 'Too many', { retryAfter: 60 }));
      await assert.rejects(within(joining), { name: 'AbortError' });
      assert.deepEqual(calls.leave, []);
    });

    it('while the room is connecting: torn down, with no VoiceConnection and no server-wide leave',
      async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const { joining, abort, answer, made, calls } = slowJoin({ publish: () => gate });
        answer.resolve({ url: 'wss://lk.test', token: 't', e2ee: false });
        await within((async () => { while (!made.tracks.length) await new Promise((r) => setImmediate(r)); })());
        abort.abort();
        release();
        await assert.rejects(within(joining), { name: 'AbortError' });
        assert.equal(made.rooms[0].isConnected, false);
        assert.equal(made.tracks[0].closed, true);
        assert.deepEqual(calls.leave, []);
      });

    it('a join that still fails on its own (not called off) does leave voice server-side', async () => {
      const { joining, answer, calls } = slowJoin();
      answer.reject(httpError(403, 'Missing permission'));
      await assert.rejects(within(joining), { status: 403 });
      assert.deepEqual(calls.leave, ['s1']);
    });
  });

  it('rejects bad arguments before joining anything', async () => {
    const { rtc } = fakeRtc();
    const { bot, calls } = realBot();
    const base = { bot, rtc, serverId: 's1', channelId: 'vc1', logger: quietLogger() };
    await assert.rejects(connectVoice({ ...base, bot: undefined }), TypeError);
    await assert.rejects(connectVoice({ ...base, rtc: undefined }), TypeError);
    await assert.rejects(connectVoice({ ...base, rtc: { ...rtc, AudioFrame: undefined } }), TypeError);
    await assert.rejects(connectVoice({ ...base, serverId: undefined }), TypeError);
    await assert.rejects(connectVoice({ ...base, channelId: '' }), TypeError);
    await assert.rejects(connectVoice({ ...base, queueMs: 0 }), RangeError);
    await assert.rejects(connectVoice({ ...base, queueMs: 1.5 }), RangeError);
    // LiveKit's native AudioSource panics (aborting the whole process) on a queue that isn't a multiple of 10 ms.
    for (const queueMs of [75, 55, 125, 333]) await assert.rejects(connectVoice({ ...base, queueMs }), RangeError);
    await assert.rejects(connectVoice({ ...base, signal: {} }), TypeError);
    await assert.rejects(connectVoice({ ...base, bitrate: -1 }), RangeError);
    await assert.rejects(connectVoice({ ...base, leaveTimeoutMs: 0 }), RangeError);
    await assert.rejects(connectVoice(), TypeError);
    assert.deepEqual(calls.join, []);
    assert.deepEqual(calls.leave, []);
  });
});

describe('VoiceConnection', () => {
  it('createFrame builds rtc.AudioFrame(pcm, 48000, 2, 480)', async () => {
    const { conn, rtc } = await connected();
    const pcm = new Int16Array(960).fill(5);
    const frame = conn.createFrame(pcm);
    assert.ok(frame instanceof rtc.AudioFrame);
    assert.equal(frame.data, pcm, 'a frame that owns its buffer is used as is');
    assert.deepEqual([frame.sampleRate, frame.channels, frame.samplesPerChannel], [48000, 2, 480]);
  });

  it('createFrame copies a view into a bigger buffer (native code reads the whole buffer)', async () => {
    const { conn } = await connected();
    const big = new Int16Array(2000).map((_, i) => i);
    const view = big.subarray(10, 970);
    const frame = conn.createFrame(view);
    assert.notEqual(frame.data, view);
    assert.equal(frame.data.byteOffset, 0);
    assert.equal(frame.data.buffer.byteLength, 1920);
    assert.deepEqual([...frame.data], [...view]);
  });

  it('createFrame refuses anything but 960 Int16 samples', async () => {
    const { conn } = await connected();
    assert.throws(() => conn.createFrame(new Float32Array(960)), TypeError);
    assert.throws(() => conn.createFrame(new Array(960).fill(0)), TypeError);
    assert.throws(() => conn.createFrame(new Int16Array(959)), RangeError);
  });

  it("turns the room's participant events into 'participantsChanged'", async () => {
    const { conn, room } = await connected();
    const seen = [];
    conn.on('participantsChanged', (count) => seen.push(count));
    room.remoteParticipants.set('u1', { identity: 'u1' });
    room.emit('participantConnected', { identity: 'u1' });
    room.remoteParticipants.set('u2', { identity: 'u2' });
    room.emit('participantConnected', { identity: 'u2' });
    room.remoteParticipants.delete('u1');
    room.emit('participantDisconnected', { identity: 'u1' });
    assert.deepEqual(seen, [1, 2, 1]);
    assert.equal(conn.participantCount(), 1);
  });

  it('participantCount is null when the room says nothing', () => {
    assert.equal(manual({ room: null }).conn.participantCount(), null, 'no room at all');
    assert.equal(manual().conn.participantCount(), null, 'a room without remoteParticipants');
    const room = Object.assign(new EventEmitter(), { remoteParticipants: {} });
    assert.equal(manual({ room }).conn.participantCount(), null);
  });

  it("reports a disconnect it didn't ask for, once", async () => {
    const { conn, room, logger } = await connected();
    const reasons = [];
    conn.on('disconnected', (reason) => reasons.push(reason));
    room.isConnected = false;
    room.emit('disconnected', 4);
    room.emit('disconnected', 4);
    assert.deepEqual(reasons, [4]);
    assert.equal(conn.closed, true);
    assert.equal(conn.participantCount(), null);
    assert.ok(logger.lines.some((l) => l.level === 'info' && l.text.includes('SERVER_SHUTDOWN')));
  });

  it("doesn't report the disconnect its own leave() causes", async () => {
    const { conn, room, made, calls } = await connected();
    let disconnected = 0;
    conn.on('disconnected', () => disconnected++);
    await within(conn.leave());
    assert.equal(disconnected, 0);
    assert.equal(room.disconnects, 1);
    assert.equal(room.isConnected, false);
    assert.equal(made.tracks[0].closed, true);
    assert.equal(made.sources[0].closed, true);
    assert.deepEqual(calls.leave, [], 'a clean leave needs no server-side leave');
    assert.equal(conn.closed, true);
  });

  it('sets its leaving flag before call.leave(), even when the listeners could not be removed', async () => {
    const { conn, room } = await connected();
    room.off = room.removeListener = () => room; // detaching does nothing: only the flag can stop the event
    let disconnected = 0;
    conn.on('disconnected', () => disconnected++);
    await within(conn.leave());
    assert.equal(room.disconnects, 1);
    assert.equal(disconnected, 0);
  });

  it('leave() is idempotent: same promise, one hang-up', async () => {
    const { conn, call, source } = manual();
    const first = conn.leave();
    assert.equal(conn.leave(), first);
    await within(first);
    assert.equal(conn.leave(), first);
    assert.equal(call.leaves, 1);
    assert.equal(call.track.closes, 1);
    assert.equal(source.closed, 1);
  });

  it('leave() asks Yapin’ to remove the bot when call.leave() fails', async () => {
    const { conn, call, leaveVoice, logger } = manual({ leave: async () => { throw new Error('ffi gone'); } });
    await within(conn.leave());
    assert.deepEqual(leaveVoice, ['s1']);
    assert.equal(call.track.closes, 1);
    assert.ok(logger.lines.some((l) => l.level === 'warn' && l.text.includes('ffi gone')));
  });

  it('leave() gives up on a hung call.leave() after the timeout and falls back', async () => {
    const { conn, call, leaveVoice } = manual({ leave: never });
    const started = Date.now();
    await within(conn.leave());
    assert.ok(Date.now() - started < 900);
    assert.deepEqual(leaveVoice, ['s1']);
    assert.equal(call.track.closes, 1);
  });

  it('leave() never rejects, even when every step fails or hangs', async () => {
    const bot = { leaveVoice: never };
    const { conn, call } = manual({ leave: async () => { throw new Error('a'); }, bot });
    call.track.close = async () => { throw new Error('b'); };
    assert.equal(await within(conn.leave()), undefined);
    const { conn: noBot } = manual({ leave: async () => { throw new Error('c'); }, bot: null });
    assert.equal(await within(noBot.leave()), undefined);
  });

  it('leave() closes the source itself when the call has no track', async () => {
    const { conn, source } = manual({ track: false });
    await within(conn.leave());
    assert.equal(source.closed, 1);
  });

  it("a throwing listener doesn't break the room's own emit", async () => {
    const { conn, room, logger } = await connected();
    conn.on('participantsChanged', () => { throw new Error('listener bug'); });
    assert.doesNotThrow(() => room.emit('participantConnected', { identity: 'u1' }));
    assert.ok(logger.lines.some((l) => l.level === 'error' && l.text.includes('participantsChanged')));
  });

  it('reports a room that was already gone once the caller could subscribe', async () => {
    const room = Object.assign(new EventEmitter(), { isConnected: false, remoteParticipants: new Map() });
    const { conn } = manual({ room });
    const reasons = [];
    conn.on('disconnected', (reason) => reasons.push(reason));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reasons, [null]);
  });

  it('releases a LiveKit room the server dropped, which rtc-node 1.2.1 keeps on its global event feed', async (t) => {
    let rtc;
    try {
      rtc = await import('@livekit/rtc-node');
    } catch {
      t.skip("@livekit/rtc-node's native library doesn't load here");
      return;
    }
    try {
      const room = new rtc.Room();
      new rtc.AudioSource(48000, 2, 200); // brings up LiveKit's FfiClient: the event feed every room listens to
      const feed = globalThis._ffiClientInstance;
      const before = feed.listenerCount('ffi_event');
      // What Room.connect() leaves behind, set up by hand: there is no LiveKit server here.
      feed.on('ffi_event', room.onFfiEvent);
      room.ffiHandle = { handle: 4242n, dispose() {} };
      room.info = { sid: 'RM_test', name: 'vc1' };
      room.localParticipant = { identity: 'bot-1', trackPublications: new Map(), disposeOpenStreamWriters() {} };
      room.updateConnectionState(rtc.ConnectionState.CONN_CONNECTED);
      assert.equal(room.isConnected, true);
      const call = { room, e2ee: false, source: { async close() {} }, track: { async close() {} },
        async leave() { await room.disconnect(); } };
      const conn = new VoiceConnection({ bot: { async leaveVoice() {} }, rtc, call, serverId: 's1', channelId: 'vc1',
        logger: quietLogger(), leaveTimeoutMs: 1000 });
      const dropped = new Promise((resolve) => { conn.once('disconnected', resolve); });
      // The server drops us (a moderator, a LiveKit restart): the native layer reports it on the feed.
      feed.emit('ffi_event', { message: { case: 'roomEvent', value: { roomHandle: 4242n,
        message: { case: 'disconnected', value: { reason: rtc.DisconnectReason.SERVER_SHUTDOWN } } } } });
      await within(dropped);
      assert.equal(room.isConnected, false);
      await within(conn.leave()); // what the player does next; room.disconnect() does nothing now
      assert.equal(feed.listenerCount('ffi_event'), before, 'the dead room no longer handles every FFI event');
    } finally {
      await rtc.dispose();
    }
  });

  it('checks what it is built from', () => {
    const { rtc } = fakeRtc();
    const call = { room: null, source: {}, leave: async () => {} };
    assert.throws(() => new VoiceConnection({ rtc, call: { leave: async () => {} } }), TypeError);
    assert.throws(() => new VoiceConnection({ rtc: {}, call }), TypeError);
    assert.throws(() => new VoiceConnection({ rtc, call, leaveTimeoutMs: -5 }), RangeError);
    assert.throws(() => new VoiceConnection(), TypeError);
  });
});

describe('VoiceDirectory', () => {
  const VOICE = [{ channel_id: 'vc1', user_ids: ['u1', 'u2'] }, { channel_id: 'vc2', user_ids: [] }];

  /** A bot whose api() answers with `respond(n, path)` (n = 1 for the first call) and records every call. */
  function apiBot(respond = () => ({ voice: VOICE })) {
    const calls = [];
    return {
      calls,
      async api(method, path, body, opts) {
        calls.push({ method, path, body, opts });
        return respond(calls.length, path);
      },
    };
  }
  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }
  const clock = (start = 1_000_000) => { const c = () => c.t; c.t = start; return c; };

  it('asks GET /servers/:id/voice without the SDK retries and returns .voice', async () => {
    const bot = apiBot();
    const dir = new VoiceDirectory(bot);
    assert.deepEqual(await dir.snapshot('s1'), VOICE);
    assert.deepEqual(bot.calls, [
      { method: 'GET', path: '/servers/s1/voice', body: undefined, opts: { timeout: 2500, retries: 0 } },
    ]);
    const custom = apiBot();
    await new VoiceDirectory(custom, { timeoutMs: 900 }).snapshot('s9');
    assert.deepEqual(custom.calls[0].opts, { timeout: 900, retries: 0 });
  });

  it('reuses an answer for ttlMs, then asks again', async () => {
    const bot = apiBot();
    const now = clock();
    const dir = new VoiceDirectory(bot, { ttlMs: 5000, now });
    await dir.snapshot('s1');
    now.t += 4999;
    await dir.snapshot('s1');
    assert.equal(bot.calls.length, 1);
    now.t += 1;
    await dir.snapshot('s1');
    assert.equal(bot.calls.length, 2);
  });

  it('caches per server, skips the cache with fresh, and never caches with ttlMs 0', async () => {
    const bot = apiBot();
    const dir = new VoiceDirectory(bot, { now: clock() });
    await dir.snapshot('s1');
    await dir.snapshot('s2');
    await dir.snapshot('s1');
    assert.deepEqual(bot.calls.map((c) => c.path), ['/servers/s1/voice', '/servers/s2/voice']);
    await dir.snapshot('s1', { fresh: true });
    assert.equal(bot.calls.length, 3);
    const uncached = apiBot();
    const dir0 = new VoiceDirectory(uncached, { ttlMs: 0, now: clock() });
    await dir0.snapshot('s1');
    await dir0.snapshot('s1');
    assert.equal(uncached.calls.length, 2);
  });

  it('shares one request between concurrent lookups', async () => {
    const pending = deferred();
    const bot = apiBot(() => pending.promise);
    const dir = new VoiceDirectory(bot, { now: clock() });
    const a = dir.snapshot('s1');
    const b = dir.snapshot('s1', { fresh: true });
    const c = dir.channelOf('s1', 'u2');
    pending.resolve({ voice: VOICE });
    assert.deepEqual(await a, VOICE);
    assert.deepEqual(await b, VOICE);
    assert.equal(await c, 'vc1');
    assert.equal(bot.calls.length, 1);
  });

  it('hands out copies, so callers cannot change the cache', async () => {
    const dir = new VoiceDirectory(apiBot(), { now: clock() });
    const first = await dir.snapshot('s1');
    first[0].user_ids.push('intruder');
    first.pop();
    assert.deepEqual(await dir.snapshot('s1'), VOICE);
  });

  it('channelOf answers from the cache when the user is there', async () => {
    const bot = apiBot();
    const dir = new VoiceDirectory(bot, { now: clock() });
    assert.equal(await dir.channelOf('s1', 'u1'), 'vc1');
    assert.equal(await dir.channelOf('s1', 'u2'), 'vc1');
    assert.equal(bot.calls.length, 1);
  });

  it('channelOf re-checks a cached "not in voice" once with a fresh lookup', async () => {
    const bot = apiBot((n) => ({ voice: n === 1 ? VOICE : [{ channel_id: 'vc2', user_ids: ['u3'] }] }));
    const now = clock();
    const dir = new VoiceDirectory(bot, { now });
    await dir.snapshot('s1');
    now.t += 1000;
    assert.equal(await dir.channelOf('s1', 'u3'), 'vc2', 'joined after the cached answer');
    assert.equal(bot.calls.length, 2);
  });

  it('channelOf gives null after at most one extra lookup', async () => {
    const bot = apiBot();
    const dir = new VoiceDirectory(bot, { now: clock() });
    await dir.snapshot('s1');
    assert.equal(await dir.channelOf('s1', 'nobody'), null);
    assert.equal(bot.calls.length, 2);
    const fresh = apiBot();
    assert.equal(await new VoiceDirectory(fresh, { now: clock() }).channelOf('s1', 'nobody'), null);
    assert.equal(fresh.calls.length, 1, 'an answer that was just fetched is not fetched again');
  });

  it('channelOf remembers someone it found outside voice, so repeated asks cost no lookups', async () => {
    const bot = apiBot();
    const now = clock();
    const dir = new VoiceDirectory(bot, { now });
    assert.equal(await dir.channelOf('s1', 'u9'), null);
    for (let i = 0; i < 30; i++) assert.equal(await dir.channelOf('s1', 'u9'), null); // spam: /play, a button, ...
    assert.equal(bot.calls.length, 1, 'one lookup however often they ask (60 a minute for the whole bot)');
    now.t += 14_999; // the cached voice state is stale by now; the memory isn't
    assert.equal(await dir.channelOf('s1', 'u9'), null);
    assert.equal(bot.calls.length, 1);
    now.t += 1;
    assert.equal(await dir.channelOf('s1', 'u9'), null);
    assert.equal(bot.calls.length, 2, 'after absentMs they are looked up again');
    assert.equal(await dir.channelOf('s1', 'u1'), 'vc1', 'everybody else is answered as before');
    const forgetful = apiBot();
    const dir0 = new VoiceDirectory(forgetful, { absentMs: 0, now: clock() });
    await dir0.channelOf('s1', 'u9');
    await dir0.channelOf('s1', 'u9');
    assert.equal(forgetful.calls.length, 2, 'absentMs 0: no memory');
  });

  it('a voice event in the server, fresh, or the cache showing them in voice overrides that memory', async () => {
    let voice = VOICE;
    const bot = apiBot(() => ({ voice }));
    const now = clock();
    const dir = new VoiceDirectory(bot, { now });
    const joined = [{ channel_id: 'vc2', user_ids: ['u9'] }];
    assert.equal(await dir.channelOf('s1', 'u9'), null);
    voice = joined;
    dir.invalidate('s1'); // their voice_join
    assert.equal(await dir.channelOf('s1', 'u9'), 'vc2');
    voice = VOICE;
    dir.invalidate();
    assert.equal(await dir.channelOf('s1', 'u9'), null);
    voice = joined;
    assert.equal(await dir.channelOf('s1', 'u9', { fresh: true }), 'vc2', 'fresh skips the memory');
    voice = VOICE;
    now.t += 20_000;
    assert.equal(await dir.channelOf('s1', 'u9'), null);
    voice = joined;
    now.t += 6000;
    await dir.snapshot('s1'); // somebody else's lookup: they're in vc2 now
    assert.equal(await dir.channelOf('s1', 'u9'), 'vc2', 'what the cache shows beats the memory');
  });

  it("doesn't remember an answer that was on its way when a voice event came in", async () => {
    const replies = [deferred(), deferred()];
    const bot = apiBot((n) => replies[n - 1].promise);
    const dir = new VoiceDirectory(bot, { now: clock() });
    const asking = dir.channelOf('s1', 'u9');
    dir.invalidate('s1'); // they joined voice while the lookup was on its way
    replies[0].resolve({ voice: VOICE });
    assert.equal(await asking, null);
    replies[1].resolve({ voice: [{ channel_id: 'vc2', user_ids: ['u9'] }] });
    assert.equal(await dir.channelOf('s1', 'u9'), 'vc2', 'asked again instead of trusting the old answer');
    assert.equal(bot.calls.length, 2);
  });

  it('channelOf with fresh always asks; without a user id it asks nothing', async () => {
    const bot = apiBot();
    const dir = new VoiceDirectory(bot, { now: clock() });
    await dir.snapshot('s1');
    assert.equal(await dir.channelOf('s1', 'u1', { fresh: true }), 'vc1');
    assert.equal(bot.calls.length, 2);
    assert.equal(await dir.channelOf('s1', undefined), null);
    assert.equal(await dir.channelOf('s1', ''), null);
    assert.equal(bot.calls.length, 2);
  });

  it('compares ids as strings', async () => {
    const numeric = apiBot(() => ({ voice: [{ channel_id: 77, user_ids: [123, 456] }] }));
    const dir = new VoiceDirectory(numeric, { now: clock() });
    assert.equal(await dir.channelOf('s1', '123'), 77);
    assert.deepEqual(await dir.othersIn('s1', '77', ['456']), [123]);
  });

  it('othersIn always asks fresh and drops excluded and duplicate ids', async () => {
    const bot = apiBot(() => ({ voice: [{ channel_id: 'vc1', user_ids: ['bot', 'u1', 'u2', 'u1'] }] }));
    const dir = new VoiceDirectory(bot, { now: clock() });
    await dir.snapshot('s1');
    assert.deepEqual(await dir.othersIn('s1', 'vc1', ['bot']), ['u1', 'u2']);
    assert.equal(bot.calls.length, 2);
    assert.deepEqual(await dir.othersIn('s1', 'vc1', 'bot'), ['u1', 'u2'], 'a single id works too');
    assert.deepEqual(await dir.othersIn('s1', 'vc1', new Set(['u1', 'bot'])), ['u2']);
    assert.deepEqual(await dir.othersIn('s1', 'vc1'), ['bot', 'u1', 'u2']);
    assert.deepEqual(await dir.othersIn('s1', 'nope', ['bot']), []);
  });

  it('invalidate forgets one server (or all of them)', async () => {
    const bot = apiBot();
    const dir = new VoiceDirectory(bot, { now: clock() });
    await dir.snapshot('s1');
    await dir.snapshot('s2');
    dir.invalidate('s1');
    await dir.snapshot('s1');
    await dir.snapshot('s2');
    assert.deepEqual(bot.calls.map((c) => c.path), ['/servers/s1/voice', '/servers/s2/voice', '/servers/s1/voice']);
    dir.invalidate();
    await dir.snapshot('s1');
    await dir.snapshot('s2');
    assert.equal(bot.calls.length, 5);
    dir.invalidate(null); // a voice event without a server id
    await dir.snapshot('s2');
    assert.equal(bot.calls.length, 6);
  });

  it('a request on its way when invalidate() runs is neither shared nor cached', async () => {
    const replies = [deferred(), deferred()];
    const bot = apiBot((n) => replies[n - 1].promise);
    const dir = new VoiceDirectory(bot, { now: clock() });
    const stale = dir.snapshot('s1');
    dir.invalidate('s1');
    const fresh = dir.snapshot('s1');
    assert.equal(bot.calls.length, 2);
    // The orphaned request answers last, which is when it could clobber the newer answer.
    replies[1].resolve({ voice: [{ channel_id: 'new', user_ids: [] }] });
    assert.equal((await fresh)[0].channel_id, 'new');
    replies[0].resolve({ voice: [{ channel_id: 'old', user_ids: [] }] });
    assert.equal((await stale)[0].channel_id, 'old', 'whoever asked before invalidate() still gets its answer');
    assert.equal((await dir.snapshot('s1'))[0].channel_id, 'new', 'the stale answer did not overwrite the cache');
    assert.equal(bot.calls.length, 2);
  });

  it('API errors reach every waiting caller and nothing is cached', async () => {
    const pending = deferred();
    const bot = apiBot((n) => (n === 1 ? pending.promise : { voice: VOICE }));
    const dir = new VoiceDirectory(bot, { now: clock() });
    const a = dir.snapshot('s1');
    const b = dir.channelOf('s1', 'u1');
    const err = httpError(429, 'Too many', { retryAfter: 3 });
    pending.reject(err);
    await assert.rejects(a, (e) => e === err);
    await assert.rejects(b, (e) => e === err);
    assert.deepEqual(await dir.snapshot('s1'), VOICE);
    assert.equal(bot.calls.length, 2);
  });

  it('rejects an unexpected response and tolerates odd entries', async () => {
    const empty = new VoiceDirectory(apiBot(() => ({})), { now: clock() });
    await assert.rejects(empty.snapshot('s1'), /unexpected voice state/);
    const odd = [null, 'vc0', { channel_id: 'a' }, { channel_id: 'b', user_ids: 'u1' }, { user_ids: ['u2'] },
      { channel_id: 'c', user_ids: ['u3'], name: 'Lounge' }];
    const dir = new VoiceDirectory(apiBot(() => ({ voice: odd })), { now: clock() });
    assert.deepEqual(await dir.snapshot('s1'), [
      { channel_id: 'a', user_ids: [] },
      { channel_id: 'b', user_ids: [] },
      { channel_id: 'c', user_ids: ['u3'], name: 'Lounge' }, // fields we don't use are kept
    ]);
  });

  it('checks its arguments', async () => {
    assert.throws(() => new VoiceDirectory(undefined), TypeError);
    assert.throws(() => new VoiceDirectory({}), TypeError);
    assert.throws(() => new VoiceDirectory(apiBot(), { ttlMs: -1 }), RangeError);
    assert.throws(() => new VoiceDirectory(apiBot(), { absentMs: -1 }), RangeError);
    assert.throws(() => new VoiceDirectory(apiBot(), { timeoutMs: 0 }), RangeError);
    assert.throws(() => new VoiceDirectory(apiBot(), { now: 5 }), TypeError);
    const bot = apiBot();
    const dir = new VoiceDirectory(bot);
    await assert.rejects(dir.snapshot(undefined), TypeError);
    await assert.rejects(dir.othersIn('', 'vc1'), TypeError);
    assert.equal(bot.calls.length, 0);
  });
});
