// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER_TIMINGS, Player, PlayerError, PlayerManager, PlayerState } from '../src/player.js';
import { QueueFullError } from '../src/queue.js';
import {
  FakeDecoders, FakeTimers, FakeVoice, catchUnhandledRejections, flush, makeFileTrack, makeStreamTrack, quietLogger,
  recordEvents, until,
} from './helpers.js';

// Any promise the player forgets to handle fails the test it happened in.
const unhandled = catchUnhandledRejections();
afterEach(async () => {
  await flush();
  assert.deepEqual(unhandled.splice(0), [], 'unhandled promise rejections');
});

const CH = 'voice-1';
const OPTS = { timeout: 5000 }; // a hang fails the test instead of the whole run

/** A player wired to fakes; every event it emits is recorded in `events`. */
function setup({ voice = new FakeVoice(), decoders = new FakeDecoders(), ...opts } = {}) {
  const timers = new FakeTimers();
  const logger = quietLogger();
  const player = new Player({
    serverId: 'server-1', connect: voice.connect, spawnDecoder: decoders.spawn, timers, logger, ...opts,
  });
  const events = recordEvents(player);
  return { player, timers, voice, decoders, events, logger };
}

const titles = (list) => list.map(([track]) => track.title);
const ends = (events) => events.of('trackEnd').map(([track, { reason }]) => [track.title, reason]);
const firstSamples = (conn) => conn.frames.map((frame) => frame[0]);
const isPlayerError = (code) => (err) => err instanceof PlayerError && err.code === code;

/** Completes the manual FakeVoice's join once the player has asked for it. */
async function join(voice) {
  await until(() => voice.pending > 0);
  return voice.resolve();
}

/** Plays a hanging file track and waits until it is being decoded. */
async function playing(ctx, track = makeFileTrack('A')) {
  ctx.player.play(track, { channelId: CH });
  await until(() => ctx.decoders.count === 1);
  return { conn: ctx.voice.last, dec: ctx.decoders.last, track };
}

/** Plays `track`, sends one frame, then pauses with the next frame read and held (a file) or dropped (live). */
async function paused(ctx, track) {
  const { conn, dec } = await playing(ctx, track);
  conn.source.gate();
  dec.push(5);
  await until(() => conn.source.waiting === 1);
  assert.equal(ctx.player.pause(), true);
  conn.source.open();
  await flush();
  return { conn, dec, track };
}

describe('Player: playing through the queue', OPTS, () => {
  it('plays three tracks back to back, goes idle, then leaves after the idle timeout', async () => {
    const decoders = new FakeDecoders((dec, i) => dec.play(3, 100 * (i + 1)));
    const { player, voice, events, timers } = setup({ decoders });
    const [a, b, c] = ['A', 'B', 'C'].map((title) => makeFileTrack(title));
    assert.deepEqual(player.play(a, { channelId: CH }), { position: 0, startedNow: true });
    assert.equal(player.state, PlayerState.CONNECTING);
    assert.equal(player.isBusy, true);
    assert.deepEqual(player.play(b, { channelId: CH }), { position: 1, startedNow: false });
    assert.deepEqual(player.play(c, { channelId: CH }), { position: 2, startedNow: false });
    await until(() => events.count('queueEnd') === 1);

    const conn = voice.last;
    assert.deepEqual(voice.calls, [CH]);
    assert.deepEqual(firstSamples(conn), [100, 100, 100, 200, 200, 200, 300, 300, 300]);
    assert.deepEqual(events.names(['trackStart', 'trackEnd', 'queueEnd']),
      ['trackStart', 'trackEnd', 'trackStart', 'trackEnd', 'trackStart', 'trackEnd', 'queueEnd']);
    assert.deepEqual(titles(events.of('trackStart')), ['A', 'B', 'C']);
    assert.deepEqual(ends(events), [['A', 'ended'], ['B', 'ended'], ['C', 'ended']]);
    assert.deepEqual(events.of('queueEnd'), [[{ idleTimeoutMs: 30000 }]]);
    assert.deepEqual(events.of('stateChange').map(([s]) => s), ['connecting', 'playing', 'idle']);
    assert.ok(decoders.all.every((d) => d.killCalls === 0), 'each decoder ended on its own');
    assert.equal(conn.source.waitForPlayoutCalls, 1);
    assert.equal(player.current, null);
    assert.equal(player.isBusy, false);
    assert.deepEqual(timers.delays, [30000]);

    await timers.advance(29999);
    assert.equal(events.count('destroy'), 0);
    await timers.advance(1);
    await player.whenDestroyed;
    assert.deepEqual(events.of('destroy'), [[{ reason: 'idle', error: null }]]);
    assert.equal(conn.leaveCalls, 1);
    assert.equal(player.state, PlayerState.DESTROYED);
    assert.equal(timers.pending, 0);
  });

  it('loop track replays the same track (a new play each time) until the loop is turned off', async () => {
    const decoders = new FakeDecoders((dec) => dec.play(2, 500));
    const { player, voice, events } = setup({ decoders });
    const a = makeFileTrack('A');
    assert.equal(player.setLoop('track'), 'track');
    player.on('trackStart', () => { if (events.count('trackStart') === 3) player.setLoop('off'); });
    player.play(a, { channelId: CH });
    await until(() => events.count('queueEnd') === 1);
    assert.equal(events.count('trackStart'), 3);
    assert.ok(events.of('trackStart').every(([track]) => track === a));
    assert.deepEqual(ends(events), [['A', 'ended'], ['A', 'ended'], ['A', 'ended']]);
    assert.equal(decoders.count, 3);
    assert.equal(voice.last.frames.length, 6);
  });

  it('loop queue goes round the whole queue', async () => {
    const decoders = new FakeDecoders((dec, i) => dec.play(1, i + 1));
    const { player, voice, events } = setup({ decoders });
    player.setLoop('queue');
    player.on('trackStart', () => { if (events.count('trackStart') === 4) player.setLoop('off'); });
    player.play(makeFileTrack('A'), { channelId: CH });
    player.play(makeFileTrack('B'), { channelId: CH });
    await until(() => events.count('queueEnd') === 1);
    assert.deepEqual(titles(events.of('trackStart')), ['A', 'B', 'A', 'B', 'A']);
    assert.deepEqual(firstSamples(voice.last), [1, 2, 3, 4, 5]);
  });

  it('play() while lingering after the queue ended starts at once, on the same connection', async () => {
    const decoders = new FakeDecoders((dec) => dec.play(2));
    const { player, voice, events, timers } = setup({ decoders });
    player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => events.count('queueEnd') === 1);
    assert.equal(player.state, PlayerState.IDLE);
    assert.deepEqual(timers.delays, [30000]);

    assert.deepEqual(player.play(makeFileTrack('B'), { channelId: CH }), { position: 0, startedNow: true });
    assert.equal(timers.pending, 0, 'the idle timer is cancelled');
    assert.equal(player.state, PlayerState.PLAYING);
    await until(() => events.count('queueEnd') === 2);
    assert.deepEqual(voice.calls, [CH], 'no second join');
    assert.equal(voice.last.leaveCalls, 0);
    assert.deepEqual(titles(events.of('trackStart')), ['A', 'B']);
    assert.equal(voice.last.frames.length, 4);
  });

  it('a queueEnd listener may play the next track straight away', async () => {
    const decoders = new FakeDecoders((dec) => dec.play(1));
    const { player, voice, events, timers } = setup({ decoders });
    player.once('queueEnd', () => player.play(makeFileTrack('B'), { channelId: CH }));
    player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => events.count('queueEnd') === 2);
    assert.deepEqual(titles(events.of('trackStart')), ['A', 'B']);
    assert.deepEqual(timers.delays, [30000], 'one idle timer, for the second queue end');
    assert.deepEqual(voice.calls, [CH]);
  });

  it('idleTimeoutMs 0 leaves as soon as the queue ends', async () => {
    const decoders = new FakeDecoders((dec) => dec.play(1));
    const { player, voice, events, timers } = setup({ decoders, idleTimeoutMs: 0 });
    player.play(makeFileTrack('A'), { channelId: CH });
    await player.whenDestroyed;
    assert.deepEqual(events.names(['queueEnd', 'destroy']), ['queueEnd', 'destroy']);
    assert.deepEqual(events.of('queueEnd'), [[{ idleTimeoutMs: 0 }]]);
    assert.deepEqual(events.of('destroy'), [[{ reason: 'idle', error: null }]]);
    assert.equal(voice.last.leaveCalls, 1);
    assert.equal(timers.pending, 0);
  });

  it('waits for the last audio to play out before going idle, but only for playoutTimeoutMs', async () => {
    const ctx = setup();
    const { conn, dec } = await playing(ctx);
    conn.source.hangPlayout();
    dec.play(2);
    await until(() => conn.source.waitForPlayoutCalls === 1);
    await flush();
    assert.equal(ctx.player.state, PlayerState.PLAYING);
    assert.equal(ctx.events.count('queueEnd'), 0);
    assert.deepEqual(ctx.timers.delays, [PLAYER_TIMINGS.playoutTimeoutMs]);
    await ctx.timers.advance(PLAYER_TIMINGS.playoutTimeoutMs);
    assert.equal(ctx.events.count('queueEnd'), 1);
    assert.equal(ctx.player.state, PlayerState.IDLE);
  });

  it('play() while the last audio plays out carries on without waiting for it', async () => {
    const ctx = setup();
    const { conn, dec } = await playing(ctx);
    conn.source.hangPlayout();
    dec.play(1);
    await until(() => conn.source.waitForPlayoutCalls === 1);
    assert.equal(ctx.player.isBusy, false);
    assert.deepEqual(ctx.player.play(makeFileTrack('B'), { channelId: CH }), { position: 0, startedNow: true });
    await until(() => ctx.decoders.count === 2);
    assert.equal(ctx.timers.pending, 0, 'the playout wait (and its timer) ended');
    assert.equal(ctx.events.count('queueEnd'), 0);
  });

  it('an ffmpeg that closes its output but never exits is killed after exitTimeoutMs; the track ended', async () => {
    const ctx = setup();
    const { conn, dec } = await playing(ctx);
    dec.push(2);
    dec.stdout.end(); // output done, process "still running"
    await until(() => conn.frames.length === 2 && ctx.timers.pending === 1);
    assert.deepEqual(ctx.timers.delays, [PLAYER_TIMINGS.exitTimeoutMs]);
    assert.equal(dec.killCalls, 0);
    await ctx.timers.advance(PLAYER_TIMINGS.exitTimeoutMs);
    await until(() => ctx.events.count('queueEnd') === 1);
    assert.equal(dec.killed, true);
    assert.deepEqual(ends(ctx.events), [['A', 'ended']]);
    assert.equal(ctx.events.count('trackError'), 0);
  });

  it('waits for the server\'s previous player (waitFor) before joining', async () => {
    let release;
    const waitFor = new Promise((resolve) => { release = resolve; });
    const { player, voice } = setup({ waitFor });
    player.play(makeFileTrack('A'), { channelId: CH });
    await flush();
    assert.equal(player.state, PlayerState.CONNECTING);
    assert.equal(player.isBusy, true);
    assert.deepEqual(voice.calls, []);
    release();
    await until(() => voice.calls.length === 1);
  });

  it('a previous player that never finishes leaving holds the join up for waitForTimeoutMs at most', async () => {
    const { player, voice, timers } = setup({ waitFor: new Promise(() => {}) });
    player.play(makeFileTrack('A'), { channelId: CH });
    await flush();
    assert.deepEqual(timers.delays, [PLAYER_TIMINGS.waitForTimeoutMs]);
    await timers.advance(PLAYER_TIMINGS.waitForTimeoutMs);
    await until(() => voice.calls.length === 1);
  });
});

describe('Player: pause and resume', OPTS, () => {
  it('pausing a file holds its frames: nothing is killed and no frame is lost', async () => {
    const ctx = setup();
    const { player, events } = ctx;
    const { conn, dec } = await playing(ctx);
    conn.source.gate();
    dec.push(10, 400);
    await until(() => conn.source.waiting === 1);
    assert.equal(player.pause(), true);
    assert.equal(player.pause(), false, 'already paused');
    assert.equal(player.state, PlayerState.PAUSED);
    assert.equal(player.paused, true);
    conn.source.open();
    await flush(10);
    assert.equal(conn.frames.length, 1, 'the next frame is held, not sent');
    assert.equal(dec.killCalls, 0);
    assert.equal(conn.source.clearQueueCalls, 0, "pausing doesn't throw buffered audio away");

    assert.equal(player.resume(), true);
    assert.equal(player.resume(), false, 'not paused any more');
    assert.equal(player.state, PlayerState.PLAYING);
    await until(() => conn.frames.length === 10);
    dec.end();
    await until(() => events.count('queueEnd') === 1);
    assert.equal(conn.frames.length, 10);
    assert.ok(conn.frames.every((frame) => frame[0] === 400));
    assert.deepEqual(ends(events), [['A', 'ended']]);
    assert.equal(dec.killCalls, 0);
    assert.deepEqual(events.of('stateChange').map(([s]) => s), ['connecting', 'playing', 'paused', 'playing', 'idle']);
  });

  it('pausing a live stream keeps reading but drops the audio, so resume is live', async () => {
    const ctx = setup();
    const { player } = ctx;
    const { conn, dec } = await playing(ctx, makeStreamTrack('Radio'));
    dec.push(3, 100);
    await until(() => conn.frames.length === 3);
    assert.equal(player.pause(), true);
    assert.equal(player.state, PlayerState.PAUSED);
    dec.push(5, 200);
    await flush(10);
    assert.equal(conn.frames.length, 3, 'nothing sent while paused');
    assert.equal(dec.stdout.readableLength, 0, 'but the stream was read (and dropped), not left to back up');
    assert.equal(dec.killCalls, 0);
    assert.equal(player.position, 0.03, 'dropped audio does not count as heard');

    assert.equal(player.resume(), true);
    dec.push(2, 300);
    await until(() => conn.frames.length === 5);
    assert.deepEqual(firstSamples(conn), [100, 100, 100, 300, 300]);
    assert.equal(player.position, 0.05);
  });

  it('pausing while still joining: the track starts paused', async () => {
    const voice = new FakeVoice({ manual: true });
    const ctx = setup({ voice });
    const { player, decoders, events } = ctx;
    player.play(makeFileTrack('A'), { channelId: CH });
    assert.equal(player.pause(), true);
    assert.equal(player.state, PlayerState.CONNECTING);
    const conn = await join(voice);
    await until(() => decoders.count === 1);
    assert.equal(player.state, PlayerState.PAUSED);
    decoders.last.push(2);
    await flush(10);
    assert.equal(conn.frames.length, 0);
    assert.equal(events.count('trackStart'), 1, 'its first frame was decoded (and is held)');
    assert.equal(player.togglePause(), 'resumed');
    await until(() => conn.frames.length === 2);
  });

  it('a paused stream that ends with the queue leaves the player unpaused for the next play()', async () => {
    const ctx = setup();
    const { player, events, decoders } = ctx;
    const { dec } = await paused(ctx, makeStreamTrack('Link', { source: 'url' })); // a link may end; a station doesn't
    dec.end();
    await until(() => events.count('queueEnd') === 1);
    assert.equal(player.paused, false);
    player.play(makeFileTrack('B'), { channelId: CH });
    assert.equal(player.state, PlayerState.PLAYING);
    await until(() => decoders.count === 2);
    decoders.last.push(1, 3);
    await until(() => ctx.voice.last.frames.length === 2);
  });

  it('togglePause() reports what it did; there is nothing to pause without a track', async () => {
    const ctx = setup();
    assert.equal(ctx.player.togglePause(), null);
    assert.equal(ctx.player.pause(), false);
    await playing(ctx);
    assert.equal(ctx.player.togglePause(), 'paused');
    assert.equal(ctx.player.togglePause(), 'resumed');
  });
});

describe('Player: volume', OPTS, () => {
  it('a change ramps across the very next frame, then holds', async () => {
    const ctx = setup();
    const { player, events } = ctx;
    const { conn, dec } = await playing(ctx);
    conn.source.gate();
    dec.push(3, 1000);
    await until(() => conn.source.waiting === 1);
    assert.equal(player.setVolume(50), 50);
    conn.source.release();
    await until(() => conn.frames.length === 2);
    conn.source.open();
    await until(() => conn.frames.length === 3);

    const [first, second, third] = conn.frames;
    assert.ok(first.every((s) => s === 1000), 'sent before the change: untouched');
    assert.equal(second[0], 999, 'the ramp starts one step below the old gain');
    assert.equal(second[1], 999, 'left and right get the same gain');
    assert.ok(second[480] < 1000 && second[480] > 500, 'halfway through the ramp');
    assert.equal(second[958], 500);
    assert.equal(second[959], 500, 'and it ends exactly on the new gain');
    assert.ok(third.every((s) => s === 500), 'the frame after that is flat at the new gain');
    assert.deepEqual(events.of('volumeChange'), [[50]]);
    assert.equal(player.volume, 50);
  });

  it('clamps and rounds, rejects non-numbers, and reports changes through onVolumeChange', () => {
    const seen = [];
    const { player } = setup({ volume: 80, onVolumeChange: (v) => seen.push(v) });
    assert.equal(player.volume, 80);
    assert.equal(player.setVolume(250), 200);
    assert.equal(player.setVolume(0), 1);
    assert.equal(player.setVolume(99.6), 100);
    assert.throws(() => player.setVolume(Number.NaN), RangeError);
    assert.throws(() => player.setVolume('50'), RangeError);
    assert.deepEqual(seen, [200, 1, 100]);
    assert.equal(player.volume, 100);
  });

  it('a new track starts at the volume set while nothing played (no ramp from the old one)', async () => {
    const decoders = new FakeDecoders((dec) => dec.play(1, 1000));
    const { player, voice, events } = setup({ decoders });
    player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => events.count('queueEnd') === 1);
    player.setVolume(150);
    player.play(makeFileTrack('B'), { channelId: CH });
    await until(() => events.count('queueEnd') === 2);
    assert.ok(voice.last.frames[1].every((s) => s === 1500));
  });
});

describe('Player: skip', OPTS, () => {
  it('while joining: the skipped track is never decoded', async () => {
    const voice = new FakeVoice({ manual: true });
    const { player, decoders, events } = setup({ voice });
    const [a, b] = [makeFileTrack('A'), makeFileTrack('B')];
    player.play(a, { channelId: CH });
    player.play(b, { channelId: CH });
    assert.equal(player.skip(), a);
    assert.equal(player.current, b);
    assert.equal(player.state, PlayerState.CONNECTING);
    assert.equal(events.count('trackEnd'), 0, 'A never made a sound');
    await join(voice);
    await until(() => decoders.count === 1);
    assert.equal(decoders.last.track, b);
  });

  it('while a file is paused: unpauses, silences it at once and plays the next track', async () => {
    const ctx = setup();
    const { player, decoders, events } = ctx;
    const { conn, dec } = await paused(ctx);
    player.play(makeFileTrack('B'), { channelId: CH });
    assert.equal(player.state, PlayerState.PAUSED);
    assert.equal(player.skip().title, 'A');
    assert.equal(player.paused, false);
    assert.equal(player.state, PlayerState.PLAYING);
    assert.equal(dec.killed, true);
    assert.equal(conn.source.clearQueueCalls, 1, 'buffered audio is dropped');
    assert.deepEqual(ends(events), [['A', 'skipped']]);
    await until(() => decoders.count === 2);
    assert.equal(decoders.last.track.title, 'B');
    decoders.last.play(2, 7);
    await until(() => events.count('queueEnd') === 1);
    assert.deepEqual(firstSamples(conn), [1000, 7, 7]);
  });

  it('while a live stream is paused', async () => {
    const ctx = setup();
    const { player, decoders, events } = ctx;
    const { conn, dec } = await paused(ctx, makeStreamTrack('Radio'));
    player.play(makeFileTrack('B'), { channelId: CH });
    assert.equal(player.skip().title, 'Radio');
    assert.equal(player.paused, false);
    assert.equal(dec.killed, true);
    assert.equal(conn.source.clearQueueCalls, 1);
    await until(() => decoders.count === 2);
    decoders.last.play(1, 9);
    await until(() => events.count('queueEnd') === 1);
    assert.deepEqual(ends(events), [['Radio', 'skipped'], ['B', 'ended']]);
  });

  it('while waiting on a captureFrame that never returns', async () => {
    const ctx = setup();
    const { player, decoders } = ctx;
    const { conn, dec } = await playing(ctx);
    player.play(makeFileTrack('B'), { channelId: CH });
    conn.source.gate();
    dec.push(3);
    await until(() => conn.source.waiting === 1);
    assert.equal(player.skip().title, 'A');
    await until(() => decoders.count === 2);
    assert.equal(decoders.last.track.title, 'B');
    assert.equal(dec.killed, true);
    assert.equal(conn.source.waiting, 1, "A's send is still stuck, and nobody waits for it");
    conn.source.open();
    decoders.last.push(1, 9);
    await until(() => conn.frames.length === 2);
    assert.deepEqual(firstSamples(conn), [1000, 9]);
  });

  it('during a live stream\'s retry backoff: the backoff timer goes too', async () => {
    const decoders = new FakeDecoders((dec, i) => { if (i === 0) dec.fail('Connection refused'); });
    const { player, events, timers } = setup({ decoders });
    player.play(makeStreamTrack('Radio'), { channelId: CH });
    player.play(makeFileTrack('B'), { channelId: CH });
    await until(() => decoders.count === 1 && timers.pending === 1); // past the join's own timer
    assert.deepEqual(timers.delays, [PLAYER_TIMINGS.retryBaseMs]);
    assert.equal(player.skip().title, 'Radio');
    await until(() => decoders.count === 2);
    assert.equal(decoders.last.track.title, 'B');
    assert.equal(timers.pending, 0);
    assert.equal(events.count('trackError'), 0);
    assert.equal(events.count('trackEnd'), 0, 'the stream never made a sound');
  });

  it('while lingering after the queue ended: nothing to skip', async () => {
    const decoders = new FakeDecoders((dec) => dec.play(1));
    const { player, events, timers } = setup({ decoders });
    assert.equal(player.skip(), null);
    player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => events.count('queueEnd') === 1);
    assert.equal(player.skip(), null);
    assert.deepEqual(timers.delays, [30000]);
    assert.equal(player.state, PlayerState.IDLE);
  });

  it('twice in a row skips two tracks', async () => {
    const ctx = setup();
    const { player, decoders, events } = ctx;
    const { conn, dec } = await playing(ctx);
    player.play(makeFileTrack('B'), { channelId: CH });
    player.play(makeFileTrack('C'), { channelId: CH });
    dec.push(1);
    await until(() => conn.frames.length === 1);
    assert.equal(player.skip().title, 'A');
    assert.equal(player.skip().title, 'B');
    assert.equal(player.current.title, 'C');
    await until(() => decoders.count === 2);
    assert.equal(decoders.last.track.title, 'C');
    assert.deepEqual(ends(events), [['A', 'skipped']], 'B never started');
    assert.deepEqual(events.of('queueUpdate').map(([u]) => u.reason), ['add', 'add', 'add', 'skip', 'skip']);
  });

  it('the last track: the player goes idle', async () => {
    const ctx = setup();
    const { player, events } = ctx;
    const { dec } = await playing(ctx);
    dec.push(1);
    await until(() => events.count('trackStart') === 1);
    assert.equal(player.skip().title, 'A');
    await until(() => events.count('queueEnd') === 1);
    assert.equal(player.state, PlayerState.IDLE);
    assert.equal(player.current, null);
  });
});

/** The checks every stop() must pass, whatever state it hit. */
async function assertStopped(ctx, stopping, { conn = ctx.voice.last, reason = 'stopped' } = {}) {
  assert.equal(ctx.player.state, PlayerState.DESTROYED);
  assert.equal(ctx.player.destroyed, true);
  assert.equal(ctx.player.current, null);
  assert.equal(ctx.player.queue.length, 0);
  assert.equal(ctx.player.isBusy, false);
  assert.throws(() => ctx.player.play(makeFileTrack('Late'), { channelId: CH }), isPlayerError('DESTROYED'));
  await stopping;
  assert.deepEqual(ctx.events.of('destroy'), [[{ reason, error: null }]]);
  assert.equal(ctx.timers.pending, 0, 'no timer left behind');
  if (conn) {
    assert.equal(conn.leaveCalls, 1);
    assert.equal(conn.listenerCount('disconnected'), 0, 'listeners taken off the connection');
    assert.equal(conn.listenerCount('participantsChanged'), 0);
  }
  for (const dec of ctx.decoders.all) assert.ok(dec.killed || dec.result, 'no decoder left running');
}

describe('Player: stop', OPTS, () => {
  it('while joining: the connection that arrives afterwards is left', async () => {
    const voice = new FakeVoice({ manual: true });
    const ctx = setup({ voice });
    ctx.player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => voice.pending === 1);
    assert.equal(voice.signals[0].aborted, false);
    const stopping = ctx.player.stop();
    assert.equal(ctx.player.state, PlayerState.DESTROYED);
    await flush();
    assert.equal(voice.signals[0].aborted, true, 'connect() hears that the join was given up');
    assert.equal(ctx.events.count('destroy'), 0, 'still waiting (bounded) for the join to settle');
    const conn = voice.resolve();
    await assertStopped(ctx, stopping, { conn });
    assert.equal(ctx.decoders.count, 0);
  });

  it('while joining, when the join never completes: bounded, and the late connection is still left', async () => {
    const voice = new FakeVoice({ manual: true });
    const ctx = setup({ voice });
    ctx.player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => voice.pending === 1);
    const stopping = ctx.player.stop();
    await flush();
    assert.deepEqual(ctx.timers.delays, [PLAYER_TIMINGS.leaveTimeoutMs]);
    await ctx.timers.advance(PLAYER_TIMINGS.leaveTimeoutMs);
    await assertStopped(ctx, stopping, { conn: null });
    const late = voice.resolve();
    await until(() => late.leaveCalls === 1);
  });

  it('while a file is paused', async () => {
    const ctx = setup();
    const { conn, dec } = await paused(ctx);
    ctx.player.play(makeFileTrack('B'), { channelId: CH });
    const stopping = ctx.player.stop();
    assert.equal(dec.killed, true);
    assert.equal(conn.source.clearQueueCalls, 1);
    await assertStopped(ctx, stopping);
    assert.deepEqual(ends(ctx.events), [['A', 'stopped']]);
    assert.equal(ctx.decoders.count, 1, 'B never started');
  });

  it('while a live stream is paused', async () => {
    const ctx = setup();
    const { dec } = await paused(ctx, makeStreamTrack('Radio'));
    const stopping = ctx.player.stop();
    assert.equal(dec.killed, true);
    await assertStopped(ctx, stopping);
    assert.deepEqual(ends(ctx.events), [['Radio', 'stopped']]);
  });

  it('while waiting on a captureFrame that never returns', async () => {
    const ctx = setup();
    const { conn, dec } = await playing(ctx);
    conn.source.gate();
    dec.push(2);
    await until(() => conn.source.waiting === 1);
    const stopping = ctx.player.stop();
    await assertStopped(ctx, stopping);
    assert.equal(dec.killed, true);
  });

  it('during a live stream\'s retry backoff', async () => {
    const decoders = new FakeDecoders((dec) => dec.fail('Connection refused'));
    const ctx = setup({ decoders });
    ctx.player.play(makeStreamTrack('Radio'), { channelId: CH });
    await until(() => decoders.count === 1 && ctx.timers.pending === 1); // past the join's own timer
    const stopping = ctx.player.stop();
    await assertStopped(ctx, stopping);
    assert.equal(decoders.count, 1, 'no retry after stop');
    assert.equal(ctx.events.count('trackError'), 0);
  });

  it('while lingering after the queue ended', async () => {
    const ctx = setup({ decoders: new FakeDecoders((dec) => dec.play(1)) });
    ctx.player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => ctx.events.count('queueEnd') === 1);
    await assertStopped(ctx, ctx.player.stop());
  });

  it('before anything was played', async () => {
    const ctx = setup();
    await assertStopped(ctx, ctx.player.stop('shutdown'), { conn: null, reason: 'shutdown' });
    assert.deepEqual(ctx.voice.calls, []);
  });

  it('twice, or along with other reasons to stop: one promise, one destroy, the first reason wins', async () => {
    const ctx = setup();
    const { conn, dec } = await playing(ctx);
    dec.push(1);
    await until(() => conn.frames.length === 1);
    const first = ctx.player.stop();
    const second = ctx.player.stop('error');
    assert.equal(first, second);
    conn.drop(); // the room going away during our own stop changes nothing
    await assertStopped(ctx, first);
    await ctx.timers.advance(120000);
    assert.equal(ctx.player.stop('idle'), first);
    await first;
    assert.equal(ctx.events.count('destroy'), 1);
    assert.equal(ctx.events.of('stateChange').filter(([s]) => s === 'destroyed').length, 1);
  });

  it('from inside a stateChange listener: no decoder is started, the state stays destroyed', async () => {
    const ctx = setup();
    ctx.player.on('stateChange', (state) => { if (state === 'playing') void ctx.player.stop(); });
    ctx.player.play(makeFileTrack('A'), { channelId: CH });
    await ctx.player.whenDestroyed;
    await assertStopped(ctx, ctx.player.stop());
    assert.equal(ctx.decoders.count, 0);
    assert.deepEqual(ctx.events.of('stateChange').map(([s]) => s), ['connecting', 'playing', 'destroyed']);
  });

  it('is bounded when leaving voice hangs', async () => {
    const ctx = setup();
    const { conn } = await playing(ctx);
    conn.hangLeave();
    const stopping = ctx.player.stop();
    await flush();
    assert.equal(ctx.events.count('destroy'), 0);
    assert.deepEqual(ctx.timers.delays, [PLAYER_TIMINGS.leaveTimeoutMs]);
    await ctx.timers.advance(PLAYER_TIMINGS.leaveTimeoutMs);
    await assertStopped(ctx, stopping);
  });

  it('from inside a trackStart listener', async () => {
    const ctx = setup();
    ctx.player.once('trackStart', () => { void ctx.player.stop(); });
    const { conn, dec } = await playing(ctx);
    dec.push(3);
    await ctx.player.whenDestroyed;
    await assertStopped(ctx, ctx.player.stop());
    assert.equal(conn.frames.length, 0, 'the first frame is not sent after the stop');
    assert.deepEqual(ends(ctx.events), [['A', 'stopped']]);
  });
});

describe('Player: failures', OPTS, () => {
  it('a decoder that exits with an error: trackError (fit for chat), then the next track', async () => {
    const decoders = new FakeDecoders((dec, i) => (i === 0
      ? dec.fail('[in#0 @ 0x600] Invalid data found when processing input', 1) : dec.play(2, 5)));
    const { player, events } = setup({ decoders });
    const a = makeFileTrack('A');
    player.play(a, { channelId: CH });
    player.play(makeFileTrack('B'), { channelId: CH });
    await until(() => events.count('queueEnd') === 1);
    const [[track, err]] = events.of('trackError');
    assert.equal(track, a);
    assert.equal(err.message, 'Invalid data found when processing input');
    assert.deepEqual(titles(events.of('trackStart')), ['B'], 'a track that never made a sound gets no trackStart');
    assert.deepEqual(ends(events), [['B', 'ended']]);
  });

  it('no audio at all, or no ffmpeg at all, is a failure too', async () => {
    const decoders = new FakeDecoders((dec, i) => (i === 0 ? dec.end() : dec.failToStart()));
    const { player, events } = setup({ decoders });
    player.play(makeFileTrack('Empty'), { channelId: CH });
    player.play(makeFileTrack('B'), { channelId: CH });
    await until(() => events.count('queueEnd') === 1);
    assert.deepEqual(events.of('trackError').map(([t, e]) => [t.title, e.message]), [
      ['Empty', 'ffmpeg produced no audio'],
      ['B', 'ffmpeg not found at "ffmpeg" — install ffmpeg or set FFMPEG_PATH'],
    ]);
  });

  it('a failing track is dropped even when looping, so it cannot loop forever', async () => {
    for (const loop of ['track', 'queue']) {
      const decoders = new FakeDecoders((dec, i) => (i === 0 ? dec.fail() : dec.play(1)));
      const { player, events } = setup({ decoders });
      player.setLoop(loop);
      player.on('trackStart', () => player.setLoop('off')); // B plays once, then the queue ends
      player.play(makeFileTrack('Broken'), { channelId: CH });
      player.play(makeFileTrack('B'), { channelId: CH });
      await until(() => events.count('queueEnd') === 1);
      assert.equal(events.count('trackError'), 1, loop);
      assert.equal(decoders.count, 2, `${loop}: the broken track wasn't retried`);
    }
  });

  it('a live stream that drops is retried after 1 s, then 2 s, without a second trackStart', async () => {
    const decoders = new FakeDecoders((dec, i) => {
      if (i === 0) dec.push(2, 10).end({ code: 1, stderr: 'Connection reset by peer' });
      else if (i === 1) dec.fail('Connection refused');
      // the third attempt keeps playing
    });
    const { player, voice, events, timers } = setup({ decoders });
    player.play(makeStreamTrack('Radio'), { channelId: CH });
    await until(() => decoders.count === 1 && timers.pending === 1); // past the join's own timer
    assert.deepEqual(timers.delays, [1000]);
    await timers.advance(999);
    assert.equal(decoders.count, 1);
    await timers.advance(1);
    await until(() => decoders.count === 2 && timers.pending === 1);
    assert.deepEqual(timers.delays, [2000]);
    await timers.advance(2000);
    await until(() => decoders.count === 3);
    decoders.last.push(3, 30);
    await until(() => voice.last.frames.length === 5);
    assert.deepEqual(firstSamples(voice.last), [10, 10, 30, 30, 30]);
    assert.equal(events.count('trackStart'), 1);
    assert.equal(events.count('trackError'), 0);
    assert.equal(events.count('trackEnd'), 0);
    assert.equal(player.state, PlayerState.PLAYING);
    assert.equal(player.current.title, 'Radio');
  });

  it('a live stream gives up after maxStreamRetries, then the queue moves on', async () => {
    const decoders = new FakeDecoders((dec) => dec.fail('Server returned 5XX Server Error reply'));
    const { player, events, timers } = setup({ decoders, maxStreamRetries: 2 });
    player.play(makeStreamTrack('Radio'), { channelId: CH });
    await until(() => decoders.count === 1 && timers.pending === 1); // past the join's own timer
    await timers.advance(1000);
    await until(() => decoders.count === 2 && timers.pending === 1);
    assert.deepEqual(timers.delays, [2000]);
    await timers.advance(2000);
    await until(() => events.count('queueEnd') === 1);
    assert.equal(decoders.count, 3, 'one try and two retries');
    assert.deepEqual(events.of('trackError').map(([t, e]) => [t.title, e.message]),
      [['Radio', 'Server returned 5XX Server Error reply']]);
  });

  it('a link with a lasting error before any audio (404, web page, blocked protocol) fails at once', async () => {
    const whitelist = "Protocol 'rtmp' not on whitelist 'http,https,tcp,tls,crypto'!";
    const lasting = [
      ['[in#0 @ 0x1] Error opening input: Server returned 404 Not Found', 'Server returned 404 Not Found'],
      ['[in#0 @ 0x1] Error opening input: Input/output error', 'Input/output error'], // ffmpeg on a web page
      [`[http @ 0x1] ${whitelist}\n    Last message repeated 3 times\n`
        + '[in#0 @ 0x2] Error opening input: Invalid argument', whitelist],
    ];
    for (const [stderr, reason] of lasting) {
      const decoders = new FakeDecoders((dec) => dec.fail(stderr, 8));
      const { player, events, timers } = setup({ decoders });
      player.play(makeStreamTrack('Link', { source: 'url' }), { channelId: CH });
      await until(() => events.count('queueEnd') === 1);
      assert.equal(decoders.count, 1, `${reason}: not retried`);
      assert.deepEqual(events.of('trackError').map(([, e]) => e.message), [reason]);
      assert.deepEqual(timers.delays, [30000], 'no backoff, just the idle timer');
    }
  });

  it('a stream that already played is retried whatever ends it (a mount is 404 while its source restarts)',
    async () => {
      const decoders = new FakeDecoders((dec, i) => {
        if (i === 0) dec.push(3).end({ code: 1, stderr: '[in#0/mp3 @ 0x1] Error during demuxing: Input/output error' });
        else if (i === 1) dec.fail('[in#0 @ 0x1] Error opening input: Server returned 404 Not Found', 8);
      });
      const { player, events, timers } = setup({ decoders });
      player.play(makeStreamTrack('Radio'), { channelId: CH });
      await until(() => decoders.count === 1 && timers.pending === 1);
      assert.deepEqual(timers.delays, [1000]);
      await timers.advance(1000);
      await until(() => decoders.count === 2 && timers.pending === 1);
      assert.deepEqual(timers.delays, [2000], 'the 404 after the drop is retried too');
      await timers.advance(2000);
      await until(() => decoders.count === 3);
      assert.equal(events.count('trackError'), 0);
      assert.equal(player.current.title, 'Radio');
    });

  it('a radio station whose server ends the stream cleanly is reconnected (ffmpeg would not)', async () => {
    const decoders = new FakeDecoders((dec, i) => { if (i === 0) dec.play(3, 10); }); // audio, then exit code 0
    const { player, voice, events, timers } = setup({ decoders });
    player.play(makeStreamTrack('Radio'), { channelId: CH });
    await until(() => decoders.count === 1 && timers.pending === 1);
    assert.deepEqual(timers.delays, [PLAYER_TIMINGS.retryBaseMs]);
    await timers.advance(PLAYER_TIMINGS.retryBaseMs);
    await until(() => decoders.count === 2);
    decoders.last.push(2, 20);
    await until(() => voice.last.frames.length === 5);
    assert.deepEqual(firstSamples(voice.last), [10, 10, 10, 20, 20]);
    assert.deepEqual(events.names(['trackStart', 'trackEnd', 'trackError', 'queueEnd']), ['trackStart']);
    assert.equal(player.current.title, 'Radio');
  });

  it('a station that keeps ending on its own gives up after the retries; a link or file is not retried', async () => {
    const decoders = new FakeDecoders((dec) => dec.play(1));
    const { player, events, timers } = setup({ decoders, maxStreamRetries: 1 });
    player.play(makeStreamTrack('Radio'), { channelId: CH });
    await until(() => decoders.count === 1 && timers.pending === 1);
    await timers.advance(1000);
    await until(() => events.count('queueEnd') === 1);
    assert.deepEqual(events.of('trackError').map(([t, e]) => [t.title, e.message]),
      [['Radio', 'The station closed the stream']]);
    for (const track of [makeStreamTrack('Link', { source: 'url' }), makeFileTrack('A')]) {
      const ctx = setup({ decoders: new FakeDecoders((dec) => dec.play(3)) });
      ctx.player.play(track, { channelId: CH });
      await until(() => ctx.events.count('queueEnd') === 1);
      assert.deepEqual(ends(ctx.events), [[track.title, 'ended']]);
      assert.equal(ctx.decoders.count, 1);
    }
  });

  it('the retry count starts over after a stretch of good audio', async () => {
    const decoders = new FakeDecoders((dec, i) => {
      if (i === 0) dec.fail('Connection refused');
      else if (i === 1) dec.push(5).end({ code: 1, stderr: 'Connection reset by peer' }); // 50 ms: "good"
    });
    const { player, timers } = setup({ decoders, timings: { goodStreamMs: 50 } });
    player.play(makeStreamTrack('Radio'), { channelId: CH });
    await until(() => decoders.count === 1 && timers.pending === 1); // past the join's own timer
    assert.deepEqual(timers.delays, [1000]);
    await timers.advance(1000);
    await until(() => decoders.count === 2 && timers.pending === 1);
    assert.deepEqual(timers.delays, [1000], 'back to the first delay, not 2 s');
    await timers.advance(1000);
    await until(() => decoders.count === 3);
  });

  it('an ffmpeg that dies from a signal it was not sent is a failure, even after some audio', async () => {
    const decoders = new FakeDecoders((dec) => dec.push(2).end({ code: null, signal: 'SIGSEGV' }));
    const { player, events } = setup({ decoders });
    player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => events.count('queueEnd') === 1);
    assert.deepEqual(events.of('trackError').map(([t, e]) => [t.title, e.message]),
      [['A', 'ffmpeg stopped unexpectedly']]);
    assert.deepEqual(ends(events), [['A', 'failed']]);
  });

  it('a stream whose ffmpeg cannot even start is not retried', async () => {
    const decoders = new FakeDecoders((dec) => dec.failToStart());
    const { player, events } = setup({ decoders });
    player.play(makeStreamTrack('Radio'), { channelId: CH });
    await until(() => events.count('queueEnd') === 1);
    assert.equal(decoders.count, 1);
    assert.match(events.of('trackError')[0][1].message, /ffmpeg not found/);
  });

  it('a spawnDecoder that throws counts as a failed track', async () => {
    let calls = 0;
    const { player, events } = setup({
      decoders: { spawn: () => { calls++; throw new Error('spawn EMFILE'); } },
    });
    player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => events.count('queueEnd') === 1);
    assert.equal(calls, 1);
    assert.equal(events.of('trackError')[0][1].message, 'spawn EMFILE');
  });

  it('a captureFrame failure means the call is gone: stop("disconnected")', async () => {
    const ctx = setup();
    const { conn, dec } = await playing(ctx);
    const err = new Error('AudioSource is closed');
    conn.source.failNext(err);
    dec.push(2);
    await ctx.player.whenDestroyed;
    assert.deepEqual(ctx.events.of('destroy'), [[{ reason: 'disconnected', error: err }]]);
    assert.deepEqual(ends(ctx.events), [['A', 'stopped']]);
    assert.equal(dec.killed, true);
    assert.equal(conn.leaveCalls, 1);
    assert.equal(ctx.timers.pending, 0);
  });

  it('the connection dropping stops the player with "disconnected"', async () => {
    const ctx = setup();
    const { conn, dec } = await playing(ctx);
    dec.push(1);
    await until(() => conn.frames.length === 1);
    conn.drop();
    await assertStopped(ctx, ctx.player.whenDestroyed, { reason: 'disconnected' });
    assert.equal(dec.killed, true);
  });

  it('a failed join: connectError (the error as given), then destroy with reason "error"', async () => {
    const voice = new FakeVoice();
    const err = Object.assign(new Error("I don't have permission to join that voice channel."), { status: 403 });
    voice.failNext(err);
    const { player, events, decoders, timers } = setup({ voice });
    player.play(makeFileTrack('A'), { channelId: CH });
    await player.whenDestroyed;
    assert.deepEqual(events.names(['connectError', 'destroy']), ['connectError', 'destroy']);
    assert.equal(events.of('connectError')[0][0], err);
    assert.deepEqual(events.of('destroy'), [[{ reason: 'error', error: err }]]);
    assert.equal(decoders.count, 0);
    assert.equal(timers.pending, 0);
  });

  it('a join that takes over connectTimeoutMs is given up: connectError, and a late connection is left', async () => {
    const voice = new FakeVoice({ manual: true }); // e.g. yapper.js waiting out 429s for minutes
    const ctx = setup({ voice });
    ctx.player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => voice.pending === 1);
    assert.deepEqual(ctx.timers.delays, [PLAYER_TIMINGS.connectTimeoutMs]);
    await ctx.timers.advance(PLAYER_TIMINGS.connectTimeoutMs - 1);
    assert.equal(ctx.events.count('connectError'), 0);
    assert.equal(ctx.player.state, PlayerState.CONNECTING);
    await ctx.timers.advance(1);
    const [[err]] = ctx.events.of('connectError');
    assert.ok(err instanceof PlayerError);
    assert.equal(err.code, 'CONNECT_TIMEOUT');
    assert.equal(err.message, 'It took over 20 s, so I gave up. Try again in a minute.');
    assert.equal(voice.signals[0].aborted, true, 'connect() hears that the join was given up');
    assert.equal(ctx.player.destroyed, true);
    assert.equal(ctx.player.isBusy, false, 'nothing is held up any more');
    const late = voice.resolve(); // the join completes after all...
    await ctx.player.whenDestroyed;
    assert.equal(late.leaveCalls, 1, '… and is left right away');
    assert.deepEqual(ctx.events.of('destroy'), [[{ reason: 'error', error: err }]]);
    assert.equal(ctx.timers.pending, 0);
    assert.equal(ctx.decoders.count, 0);
  });

  it('connect() resolving with something unusable is a connectError too', async () => {
    const { player, events } = setup({ voice: { connect: async () => ({ channelId: CH, leave: async () => {} }) } });
    player.play(makeFileTrack('A'), { channelId: CH });
    await player.whenDestroyed;
    assert.match(events.of('connectError')[0][0].message, /no usable voice connection/);
  });

  it('a listener that throws is logged and changes nothing', async () => {
    const decoders = new FakeDecoders((dec) => dec.play(1));
    const { player, events, logger } = setup({ decoders });
    player.on('trackStart', () => { throw new Error('ui bug'); });
    player.on('stateChange', () => { throw new Error('another ui bug'); });
    player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => events.count('queueEnd') === 1);
    assert.deepEqual(ends(events), [['A', 'ended']]);
    assert.ok(logger.lines.some((l) => l.level === 'error' && l.text.includes('ui bug')));
  });
});

describe('Player: voice channels', OPTS, () => {
  it('refuses another channel while busy (BUSY_ELSEWHERE, nothing changes); the same channel is fine', async () => {
    const voice = new FakeVoice({ manual: true });
    const ctx = setup({ voice });
    const { player } = ctx;
    player.play(makeFileTrack('A'), { channelId: CH });
    const busy = (err) => isPlayerError('BUSY_ELSEWHERE')(err) && err.channelId === CH;
    assert.throws(() => player.play(makeFileTrack('B'), { channelId: 'voice-2' }), busy);
    await join(voice);
    await until(() => ctx.decoders.count === 1);
    assert.throws(() => player.play(makeFileTrack('B'), { channelId: 'voice-2' }), busy);
    assert.equal(player.queue.length, 0);
    assert.equal(player.channelId, CH);
    assert.deepEqual(player.play(makeFileTrack('B'), { channelId: CH }), { position: 1, startedNow: false });
    assert.deepEqual(player.play(makeFileTrack('C')), { position: 2, startedNow: false }, 'default: same channel');
  });

  it('idle in one channel, play() for another moves there (leave, then join)', async () => {
    const decoders = new FakeDecoders((dec, i) => (i === 0 ? dec.play(1) : undefined));
    const { player, voice, events } = setup({ decoders });
    player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => events.count('queueEnd') === 1);
    assert.deepEqual(player.play(makeFileTrack('B'), { channelId: 'voice-2' }), { position: 0, startedNow: true });
    assert.equal(player.channelId, 'voice-2');
    await until(() => decoders.count === 2);
    const [first, second] = voice.connections;
    assert.deepEqual(voice.calls, [CH, 'voice-2']);
    assert.equal(first.leaveCalls, 1);
    assert.equal(first.listenerCount('disconnected'), 0);
    first.drop(); // the old room going away must not stop the player
    decoders.last.push(2, 8);
    await until(() => second.frames.length === 2);
    assert.equal(player.destroyed, false);
    assert.deepEqual(events.of('stateChange').map(([s]) => s),
      ['connecting', 'playing', 'idle', 'connecting', 'playing']);
  });

  it("stop() during a move: 'destroy' (it lets the next player in) waits until the old channel is left", async () => {
    const decoders = new FakeDecoders((dec, i) => (i === 0 ? dec.play(1) : undefined));
    const { player, voice, events, timers } = setup({ decoders });
    player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => events.count('queueEnd') === 1);
    voice.last.hangLeave(); // leaving takes a while (bounded by leaveTimeoutMs)
    player.play(makeFileTrack('B'), { channelId: 'voice-2' });
    await flush();
    const stopping = player.stop();
    await flush(10);
    assert.equal(events.count('destroy'), 0, 'still leaving the old channel');
    assert.deepEqual(voice.calls, [CH], 'and never joined the new one');
    await timers.advance(PLAYER_TIMINGS.leaveTimeoutMs);
    await stopping;
    assert.deepEqual(events.of('destroy'), [[{ reason: 'stopped', error: null }]]);
    assert.equal(timers.pending, 0);
  });

  it('play() needs a track and a channel', () => {
    const { player } = setup();
    assert.throws(() => player.play(null, { channelId: CH }), TypeError);
    assert.throws(() => player.play(makeFileTrack('A')), TypeError);
    assert.equal(player.isBusy, false);
    assert.equal(player.queue.length, 0);
  });

  it('a full queue throws QueueFullError and changes nothing', async () => {
    const ctx = setup({ maxQueueSize: 1 });
    await playing(ctx);
    ctx.player.play(makeFileTrack('B'), { channelId: CH });
    ctx.events.clear();
    assert.throws(() => ctx.player.play(makeFileTrack('C'), { channelId: CH }), QueueFullError);
    assert.equal(ctx.player.queue.length, 1);
    assert.equal(ctx.events.count('queueUpdate'), 0);
  });
});

describe('Player: presence', OPTS, () => {
  const DEBOUNCE = PLAYER_TIMINGS.presenceDebounceMs;

  it('alone: one lookup per burst, a countdown, a last look, then stop("alone")', async () => {
    let lookups = 0;
    const ctx = setup({ countListeners: async () => { lookups++; return 0; } });
    await playing(ctx);
    ctx.player.checkPresence();
    ctx.player.checkPresence(); // same burst
    assert.deepEqual(ctx.timers.delays, [DEBOUNCE]);
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(lookups, 1);
    assert.deepEqual(ctx.events.of('alone'), [[{ timeoutMs: 30000 }]]);
    assert.deepEqual(ctx.timers.delays, [30000]);
    ctx.player.checkPresence(); // still alone: the countdown keeps going, no second 'alone'
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(ctx.events.count('alone'), 1);
    await ctx.timers.advance(30000 - DEBOUNCE);
    await assertStopped(ctx, ctx.player.whenDestroyed, { reason: 'alone' });
    assert.equal(lookups, 3);
  });

  it('someone coming back cancels the countdown', async () => {
    let count = 0;
    const ctx = setup({ countListeners: async () => count });
    await playing(ctx);
    ctx.player.checkPresence();
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(ctx.events.count('alone'), 1);
    count = 2;
    ctx.player.checkPresence();
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(ctx.timers.pending, 0, 'countdown cancelled');
    await ctx.timers.advance(60000);
    assert.equal(ctx.player.destroyed, false);
  });

  it('the last look finds someone: it stays (and can count down again later)', async () => {
    let count = 0;
    const ctx = setup({ countListeners: async () => count });
    await playing(ctx);
    ctx.player.checkPresence();
    await ctx.timers.advance(DEBOUNCE);
    count = 1;
    await ctx.timers.advance(30000);
    assert.equal(ctx.player.destroyed, false);
    count = 0;
    ctx.player.checkPresence();
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(ctx.events.count('alone'), 2);
  });

  it('countListeners failing falls back to the room count', async () => {
    const ctx = setup({ countListeners: async () => { throw new Error('rate limited'); } });
    const { conn } = await playing(ctx);
    conn.participants = 0;
    ctx.player.checkPresence();
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(ctx.events.count('alone'), 1);
  });

  it('a count nobody knows changes nothing', async () => {
    const ctx = setup({ countListeners: async () => null });
    const { conn } = await playing(ctx);
    conn.participants = null;
    ctx.player.checkPresence();
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(ctx.events.count('alone'), 0);
    assert.equal(ctx.timers.pending, 0);
  });

  it('a countListeners that hangs counts as unknown after countTimeoutMs', async () => {
    const ctx = setup({ countListeners: () => new Promise(() => {}) });
    const { conn } = await playing(ctx);
    conn.participants = 0;
    ctx.player.checkPresence();
    await ctx.timers.advance(DEBOUNCE);
    assert.deepEqual(ctx.timers.delays, [PLAYER_TIMINGS.countTimeoutMs]);
    await ctx.timers.advance(PLAYER_TIMINGS.countTimeoutMs);
    assert.equal(ctx.events.count('alone'), 1, 'the room count said 0');
  });

  it("the connection's participantsChanged triggers a check", async () => {
    const ctx = setup();
    const { conn } = await playing(ctx);
    conn.setParticipants(0);
    assert.deepEqual(ctx.timers.delays, [DEBOUNCE]);
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(ctx.events.count('alone'), 1);
    conn.setParticipants(1);
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(ctx.timers.pending, 0);
  });

  it('aloneTimeoutMs 0 leaves right away', async () => {
    const ctx = setup({ countListeners: async () => 0, aloneTimeoutMs: 0 });
    await playing(ctx);
    ctx.player.checkPresence();
    await ctx.timers.advance(DEBOUNCE);
    assert.deepEqual(ctx.events.of('alone'), [[{ timeoutMs: 0 }]]);
    await assertStopped(ctx, ctx.player.whenDestroyed, { reason: 'alone' });
  });

  it('moving to another channel drops the old countdown, so the new channel can count down afresh', async () => {
    let count = 0;
    const decoders = new FakeDecoders((dec, i) => (i === 0 ? dec.play(1) : undefined));
    const ctx = setup({ decoders, countListeners: async () => count });
    ctx.player.play(makeFileTrack('A'), { channelId: CH });
    await until(() => ctx.events.count('queueEnd') === 1);
    ctx.player.checkPresence();
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(ctx.events.count('alone'), 1);
    ctx.player.play(makeFileTrack('B'), { channelId: 'voice-2' });
    await until(() => decoders.count === 2);
    assert.equal(ctx.timers.pending, 0, 'the old countdown is gone');
    count = 0; // nobody followed the bot to voice-2 either
    ctx.player.checkPresence();
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(ctx.events.count('alone'), 2);
    await ctx.timers.advance(30000);
    assert.deepEqual(ctx.events.of('destroy'), [[{ reason: 'alone', error: null }]]);
  });

  it('stop() clears a pending check and a running countdown', async () => {
    const ctx = setup({ countListeners: async () => 0 });
    await playing(ctx);
    ctx.player.checkPresence();
    await ctx.timers.advance(DEBOUNCE);
    ctx.player.checkPresence();
    assert.deepEqual(ctx.timers.delays, [DEBOUNCE, 30000]);
    await assertStopped(ctx, ctx.player.stop());
  });

  it('a check asked for while joining runs once the connection is up (no voice event would ask again)', async () => {
    let lookups = 0;
    const voice = new FakeVoice({ manual: true, participants: 0 });
    const ctx = setup({ voice, countListeners: async () => { lookups++; return 0; } });
    ctx.player.play(makeStreamTrack('Radio'), { channelId: CH }); // radio: it would play to nobody for ever
    ctx.player.checkPresence(); // everyone left while the bot was still joining
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(lookups, 0, 'nothing to look at yet');
    await join(voice);
    await until(() => ctx.decoders.count === 1);
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(lookups, 1);
    assert.deepEqual(ctx.events.of('alone'), [[{ timeoutMs: 30000 }]]);
    await ctx.timers.advance(30000);
    assert.deepEqual(ctx.events.of('destroy'), [[{ reason: 'alone', error: null }]]);
  });

  it('nothing to check before the join or after stop()', async () => {
    let lookups = 0;
    const voice = new FakeVoice({ manual: true });
    const ctx = setup({ voice, countListeners: async () => { lookups++; return 0; } });
    ctx.player.play(makeFileTrack('A'), { channelId: CH });
    ctx.player.checkPresence();
    await ctx.timers.advance(DEBOUNCE);
    assert.equal(lookups, 0);
    await join(voice);
    await ctx.player.stop();
    ctx.player.checkPresence();
    assert.equal(ctx.timers.pending, 0);
  });
});

describe('Player: position, snapshot and queue edits', OPTS, () => {
  it('position is the audio sent minus what is still buffered, never below 0', async () => {
    const ctx = setup();
    assert.equal(ctx.player.position, 0);
    const { conn, dec } = await playing(ctx);
    dec.push(5);
    await until(() => conn.frames.length === 5);
    assert.equal(ctx.player.position, 0.05);
    conn.source.queuedDuration = 20;
    assert.equal(ctx.player.position, 0.03);
    conn.source.queuedDuration = 1000;
    assert.equal(ctx.player.position, 0);
    conn.source.queuedDuration = undefined;
    assert.equal(ctx.player.position, 0.05);
  });

  it('snapshot() is plain data, copied', async () => {
    const voice = new FakeVoice({ manual: true });
    const { player } = setup({ voice, volume: 120 });
    const [a, b, c] = ['A', 'B', 'C'].map((title) => makeFileTrack(title));
    player.channelName = 'Lounge';
    player.textChannelId = 'text-1';
    for (const track of [a, b, c]) player.play(track, { channelId: CH });
    const snap = player.snapshot();
    assert.deepEqual(snap, {
      serverId: 'server-1', channelId: CH, channelName: 'Lounge', textChannelId: 'text-1', state: 'connecting',
      current: a, position: 0, paused: false, volume: 120, loop: 'off', upcoming: [b, c], next: b,
    });
    assert.notEqual(snap.current, a);
    snap.current.title = 'changed';
    snap.upcoming.pop();
    assert.equal(player.current.title, 'A');
    assert.equal(player.queue.length, 2);
    player.setLoop('track');
    assert.equal(player.snapshot().next.title, 'A');
  });

  it('remove, shuffle, clear and the loop mode edit the queue and emit queueUpdate', () => {
    const voice = new FakeVoice({ manual: true });
    const { player, events } = setup({ voice });
    for (const title of ['A', 'B', 'C', 'D', 'E']) player.play(makeFileTrack(title), { channelId: CH });
    assert.equal(player.remove(2).title, 'C');
    assert.throws(() => player.remove(9), RangeError);
    assert.equal(player.shuffle(() => 0), 3);
    assert.deepEqual(player.queue.upcoming.map((t) => t.title), ['D', 'E', 'B']);
    assert.equal(player.clear(), 3);
    assert.equal(player.current.title, 'A', 'the current track stays');
    assert.equal(player.cycleLoop(), 'track');
    assert.equal(player.cycleLoop(), 'queue');
    assert.equal(player.cycleLoop(), 'off');
    assert.equal(player.setLoop('all'), 'queue');
    assert.equal(player.loop, 'queue');
    assert.throws(() => player.setLoop('sometimes'), TypeError);
    assert.deepEqual(events.of('queueUpdate').map(([u]) => u.reason), [
      'add', 'add', 'add', 'add', 'add', 'remove', 'shuffle', 'clear', 'loop', 'loop', 'loop', 'loop',
    ]);
  });

  it('the constructor checks its options', () => {
    const base = { serverId: 's', connect: async () => {}, spawnDecoder: () => {} };
    assert.throws(() => new Player({ ...base, serverId: '' }), TypeError);
    assert.throws(() => new Player({ ...base, connect: null }), TypeError);
    assert.throws(() => new Player({ ...base, spawnDecoder: 'ffmpeg' }), TypeError);
    assert.throws(() => new Player({ ...base, countListeners: 3 }), TypeError);
    assert.throws(() => new Player({ ...base, timers: {} }), TypeError);
    assert.throws(() => new Player({ ...base, idleTimeoutMs: -1 }), RangeError);
    assert.throws(() => new Player({ ...base, aloneTimeoutMs: Number.NaN }), RangeError);
    assert.throws(() => new Player({ ...base, maxStreamRetries: 1.5 }), RangeError);
    assert.throws(() => new Player({ ...base, volume: 'loud' }), RangeError);
    assert.throws(() => new Player({ ...base, timings: { nope: 1 } }), TypeError);
    assert.throws(() => new Player({ ...base, timings: { stopTimeoutMs: -5 } }), RangeError);
    const player = new Player({ ...base, volume: 300, logger: quietLogger() });
    assert.equal(player.volume, 200);
    assert.equal(player.state, PlayerState.IDLE);
    assert.equal(player.destroyed, false);
  });
});

describe('PlayerManager', OPTS, () => {
  /** A manager whose players run on shared fakes; `created` keeps the options each player got. */
  function manager({ defaultVolume = 80 } = {}) {
    const timers = new FakeTimers();
    const voice = new FakeVoice();
    const decoders = new FakeDecoders();
    const created = [];
    const players = new PlayerManager({
      defaultVolume,
      createPlayer: (serverId, opts) => {
        created.push(opts);
        return new Player({
          serverId, connect: voice.connect, spawnDecoder: decoders.spawn, timers, logger: quietLogger(),
          timings: { leaveTimeoutMs: 5000 }, ...opts,
        });
      },
    });
    return { players, created, timers, voice, decoders };
  }

  it('obtain() hands out one live player per server and remembers its volume', () => {
    const { players, created } = manager();
    const p1 = players.obtain('s1');
    assert.equal(players.obtain('s1'), p1);
    assert.equal(players.get('s1'), p1);
    assert.equal(players.get('s2'), undefined);
    assert.deepEqual(created, [{ volume: 80, waitFor: null }]);
    assert.equal(p1.volume, 80);
    p1.setVolume(120);
    assert.deepEqual(players.settings('s1'), { volume: 120 });
    assert.deepEqual(players.settings('s2'), { volume: 80 });
    const p2 = players.obtain('s2');
    assert.equal(players.size, 2);
    assert.deepEqual(players.values(), [p1, p2]);
  });

  it('a stopping player is replaced by one that waits until the old one is out of voice', async () => {
    const { players, created, timers, voice, decoders } = manager();
    const p1 = players.obtain('s1');
    p1.setVolume(120);
    p1.play(makeFileTrack('A'), { channelId: CH });
    await until(() => decoders.count === 1);
    voice.last.hangLeave(); // so p1 is still leaving while p2 starts
    const stopping = p1.stop();
    assert.equal(players.get('s1'), undefined);
    assert.equal(players.size, 0);

    const p2 = players.obtain('s1');
    assert.notEqual(p2, p1);
    assert.equal(created[1].waitFor, p1.whenDestroyed);
    assert.equal(created[1].volume, 120);
    p2.play(makeFileTrack('B'), { channelId: CH });
    await flush(10);
    assert.equal(voice.calls.length, 1, 'p2 waits for p1 to leave');
    assert.equal(p2.state, PlayerState.CONNECTING);

    await timers.advance(5000); // p1's bounded leave gives up
    await stopping;
    await until(() => voice.calls.length === 2);
    assert.equal(players.get('s1'), p2, "p1's destroy didn't remove its successor");
    assert.equal(players.obtain('s1'), p2);
  });

  it('a waiting player that is stopped still holds its successor back until its predecessor has left',
    async () => {
      const { players, timers, voice, decoders } = manager();
      const p1 = players.obtain('s1');
      p1.play(makeFileTrack('A'), { channelId: CH });
      await until(() => decoders.count === 1);
      voice.last.hangLeave(); // p1 takes its time leaving (5 s at most here)
      void p1.stop();
      const p2 = players.obtain('s1');
      p2.play(makeFileTrack('B'), { channelId: CH });
      await flush();
      const p2Stopped = p2.stop(); // /stop again while p2 still waits for p1
      const p3 = players.obtain('s1');
      p3.play(makeFileTrack('C'), { channelId: CH });
      await flush(10);
      assert.equal(voice.calls.length, 1, "p3 doesn't join while p1 is still leaving (an old leave could undo it)");
      await timers.advance(5000); // p1's bounded leave gives up
      await p2Stopped;
      await until(() => voice.calls.length === 2);
      assert.equal(players.get('s1'), p3);
    });

  it('destroyAll() stops every player, the stopping ones too, and never rejects', async () => {
    const { players, decoders } = manager();
    const p1 = players.obtain('s1');
    const p2 = players.obtain('s2');
    p1.play(makeFileTrack('A'), { channelId: CH });
    await until(() => decoders.count === 1);
    const reasons = [];
    for (const p of [p1, p2]) p.on('destroy', ({ reason }) => reasons.push(reason));
    void p2.stop('idle');
    await players.destroyAll();
    assert.deepEqual(reasons.sort(), ['idle', 'shutdown']);
    assert.equal(players.size, 0);
    assert.equal(players.get('s1'), undefined);
    await players.destroyAll(); // nothing left: fine
  });

  it('needs a createPlayer function', () => {
    assert.throws(() => new PlayerManager({}), TypeError);
    assert.throws(() => new PlayerManager({ createPlayer: () => {}, defaultVolume: 'x' }), RangeError);
  });
});
