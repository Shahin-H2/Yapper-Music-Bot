import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bot } from '../yapper.js';
import { Music } from '../cogs/music.js';
import { FfmpegStartError } from '../src/ffmpeg.js';
import { PlayerState } from '../src/player.js';
import { TrackLibrary } from '../src/tracks.js';
import { VoiceDirectory } from '../src/voice.js';
import { FakeDecoders, FakeTimers, FakeVoice, catchUnhandledRejections, flush, quietLogger, until } from './helpers.js';

// The cog runs inside a real yapper.js Bot whose api() is replaced by FakeApi, so commands, clicks and voice events
// go through the SDK's own dispatch (bot.handle) and msg/interaction objects are exactly what the SDK builds. Voice,
// ffmpeg and time are the fakes from helpers.js: nothing here touches the network, LiveKit or a real clock.

const unhandled = catchUnhandledRejections();
/** @type {any[]} */
const contexts = [];

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    if (ctx.bot.cogs.has('Music')) {
      const unloading = ctx.bot.unload('Music');
      await ctx.timers.advance(60_000); // players that hang while leaving run out of time
      await unloading;
    }
    fs.rmSync(ctx.dir, { recursive: true, force: true });
    assert.deepEqual(ctx.errors, [], 'errors reported to the bot');
    const failures = ctx.logger.lines.filter((l) => l.level === 'error' && / failed:/.test(l.text));
    assert.deepEqual(failures, [], 'handlers that failed');
  }
  await flush();
  assert.deepEqual(unhandled.splice(0), [], 'unhandled promise rejections');
});

const OPTS = { timeout: 5000 };
const SERVER = 'server-1';
const TEXT = 'text-1';
const LOUNGE = 'vc-1';
const GAMING = 'vc-2';
const USER = 'user-1';
const BOT = 'bot-1';
const ZWSP = String.fromCharCode(0x200b);
const IDLE = '💤 Nothing is playing right now. Start something with `/play`.';
const DM = '🚫 This only works in a server.';
const STATIONS = [{ id: 'groovesalad', name: 'SomaFM · Groove Salad', url: 'https://radio.example/groovesalad.mp3',
  description: 'Ambient beats and grooves', homepage: 'https://somafm.com/groovesalad/' }];

/** An error like yapper.js's api() throws. */
const apiError = (status, message = `request failed (${status})`, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });

/**
 * The Yapin’ API as the cog sees it through bot.api(): every call is recorded (bodies as they'd go on the wire) and
 * the test sets who is in voice, which channels exist and what fails.
 */
class FakeApi {
  calls = [];
  /** @type {{ id: string, channelId: string, [key: string]: any }[]} messages posted */
  posts = [];
  /** @type {{ channelId: string, messageId: string, [key: string]: any }[]} messages edited */
  edits = [];
  /** @type {{ id: string, token: string, [key: string]: any }[]} interaction answers */
  answers = [];
  channels = new Map([[LOUNGE, { id: LOUNGE, name: 'Lounge', type: 'voice' }],
    [GAMING, { id: GAMING, name: 'Gaming', type: 'voice' }]]);
  voiceError = null;  // thrown by voice lookups while set
  hangVoice = false;  // voice lookups never answer while set
  meError = null;
  holdEdits = false;  // edits wait for releaseEdits() while set
  hangPostsIn = new Set(); // posts in these channels never get an answer (yapper.js waiting out a 429)
  #held = [];
  #voice = new Map();
  #ids = 0;

  /** Lets the held edits through. */
  releaseEdits() {
    this.holdEdits = false;
    for (const release of this.#held.splice(0)) release();
  }

  /** Who is in voice in a server: setVoice({ 'vc-1': ['user-1'] }). */
  setVoice(channels, serverId = SERVER) {
    this.#voice.set(serverId, Object.entries(channels).map(([channel_id, user_ids]) => ({ channel_id, user_ids })));
  }

  get voiceLookups() { return this.calls.filter((c) => /\/voice$/.test(c.path)).length; }

  call = async (method, route, body, opts) => {
    const payload = body === undefined ? undefined : JSON.parse(JSON.stringify(body));
    this.calls.push({ method, path: route, body: payload, opts });
    let m;
    if (method === 'POST' && (m = /^\/channels\/([^/]+)\/messages$/.exec(route))) {
      if (this.hangPostsIn.has(m[1])) return new Promise(() => {});
      const message = { id: `bot-msg-${++this.#ids}`, channelId: m[1], ...payload };
      this.posts.push(message);
      return { message: { ...message, channel_id: m[1] } };
    }
    if (method === 'PATCH' && (m = /^\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(route))) {
      if (this.holdEdits) await new Promise((resolve) => { this.#held.push(resolve); });
      this.edits.push({ channelId: m[1], messageId: m[2], ...payload });
      return { message: { id: m[2], channel_id: m[1], ...payload } };
    }
    if (method === 'POST' && (m = /^\/interactions\/([^/]+)\/([^/]+)\/callback$/.exec(route))) {
      this.answers.push({ id: m[1], token: m[2], ...payload });
      return {};
    }
    if (method === 'GET' && (m = /^\/channels\/([^/]+)$/.exec(route))) {
      const channel = this.channels.get(m[1]);
      if (!channel) throw apiError(404, 'Unknown channel');
      return { channel };
    }
    if (method === 'GET' && (m = /^\/servers\/([^/]+)\/voice$/.exec(route))) {
      if (this.hangVoice) return new Promise(() => {});
      if (this.voiceError) throw this.voiceError;
      return { voice: structuredClone(this.#voice.get(decodeURIComponent(m[1])) ?? []) };
    }
    if (method === 'GET' && route === '/me') {
      if (this.meError) throw this.meError;
      return { id: BOT, username: 'Music_Bot' };
    }
    throw apiError(404, `no fake route for ${method} ${route}`);
  };
}

/** A Bot with the Music cog loaded on fakes, a music folder with `files` and one radio station. */
async function setup({ files = ['Alpha.mp3', 'Beta.mp3', 'Gamma.mp3'], config = {}, ffmpeg = true,
  voice = new FakeVoice(), decoders = new FakeDecoders(), stations = JSON.stringify(STATIONS), library } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-bot-'));
  const musicDir = path.join(dir, 'music');
  fs.mkdirSync(musicDir);
  for (const name of files) fs.writeFileSync(path.join(musicDir, name), ''); // never decoded: decoders are fakes
  const stationsFile = path.join(dir, 'stations.json');
  fs.writeFileSync(stationsFile, stations);
  const api = new FakeApi();
  api.setVoice({ [LOUNGE]: [USER], [GAMING]: [] });
  const bot = new Bot('yb_test', { gateway: false, log: false });
  bot.api = api.call;
  bot.me = { id: BOT, username: 'Music_Bot' };
  const errors = [];
  bot.on('error', (err) => { errors.push(err); });
  const timers = new FakeTimers();
  const logger = quietLogger();
  const ffmpegState = { ok: ffmpeg, checks: 0 };
  const music = new Music(bot, {
    config: { musicDir, stationsFile, ...config },
    library: library ?? new TrackLibrary({ musicDir, stationsFile, cacheMs: 0,
      probe: async () => ({ duration: 180, title: null, artist: null }) }),
    voiceDirectory: new VoiceDirectory(bot, { now: () => timers.now }),
    connect: voice.connect,
    spawnDecoder: decoders.spawn,
    checkFfmpeg: async (ffmpegPath) => {
      ffmpegState.checks++;
      return ffmpegState.ok ? { ok: true, version: '9.0-test', error: null }
        : { ok: false, version: null, error: new Error(`ffmpeg not found at "${ffmpegPath}" — install ffmpeg`) };
    },
    timers,
    now: () => timers.now,
    random: () => 0,
    logger,
  });
  await bot.addCog(music);
  const ctx = { dir, api, bot, music, voice, decoders, timers, logger, errors, ffmpegState };
  contexts.push(ctx);
  return ctx;
}

let seq = 0;

/** `/name args` from `user`, through the SDK's dispatch; resolves when the handler is done. → the message data */
async function command(ctx, name, args = '', { user = USER, server = SERVER, channel = TEXT } = {}) {
  seq++;
  const data = { id: `msg-${seq}`, channel_id: channel, author_id: user, content: `/${name}${args ? ` ${args}` : ''}`,
    command: name, args };
  if (server !== null) data.server_id = server;
  await ctx.bot.handle({ id: seq, type: 'message', data });
  return data;
}

/** A click on a control button of message `messageId`. → the interaction answer the cog sent */
async function click(ctx, action, { messageId, user = USER, server = SERVER, customId } = {}) {
  seq++;
  const data = { id: `int-${seq}`, token: `tok-${seq}`, custom_id: customId ?? `music:${action}:${server}`,
    user_id: user, username: user, message_id: messageId, channel_id: TEXT };
  await ctx.bot.handle({ id: seq, type: 'interaction', data });
  const answer = ctx.api.answers.find((a) => a.id === data.id);
  assert.ok(answer, `the ${action} click was answered`);
  const { id, token, ...rest } = answer;
  return rest;
}

const voiceEvent = (ctx, type, data) => ctx.bot.handle({ id: ++seq, type, data });
const player = (ctx) => ctx.music.players.get(SERVER);
const last = (ctx) => ctx.api.posts.at(-1);
const field = (message, name) => message.embeds[0].fields?.find((f) => f.name === name)?.value;
const button = (message, row, index) => message.components[row].components[index];
const customIds = (message) => message.components.flatMap((row) => row.components.map((b) => b.custom_id));
const isCard = (p) => /^(?:🎶 Now Playing|⏸ Paused)$/.test(p.embeds?.[0]?.title ?? '') && p.components?.length > 0;
const cards = (ctx) => ctx.api.posts.filter(isCard);
const said = (ctx, pattern) => ctx.api.posts.some((p) => pattern.test(p.content ?? ''));

/** /play `query` for a track that starts right away: waits for its decoder, sends a frame, waits for the card. */
async function startPlaying(ctx, query = '1', opts = {}) {
  const decoders = ctx.decoders.count;
  const before = cards(ctx).length;
  const msg = await command(ctx, 'play', query, opts);
  await until(() => ctx.decoders.count === decoders + 1, { message: 'no decoder was started' });
  const dec = ctx.decoders.last;
  dec.push(1);
  await until(() => cards(ctx).length === before + 1, { message: 'no Now Playing card was posted' });
  return { msg, dec, card: cards(ctx).at(-1) };
}

/** Ends the current track and waits for the next one's decoder; sends it a frame. */
async function nextTrack(ctx, dec) {
  const count = ctx.decoders.count;
  dec.end();
  await until(() => ctx.decoders.count === count + 1, { message: 'the next track never started' });
  ctx.decoders.last.push(1);
  return ctx.decoders.last;
}

describe('Music cog: answers that need no voice', OPTS, () => {
  it('/help lists every command, and every command fits what Yapin’ accepts', async () => {
    const ctx = await setup();
    const msg = await command(ctx, 'help');
    const reply = last(ctx);
    assert.equal(reply.reply_to, msg.id);
    assert.equal(reply.embeds[0].title, '🎧 Commands');
    const names = ['play', 'tracks', 'queue', 'nowplaying', 'pause', 'resume', 'skip', 'stop', 'volume', 'loop',
      'shuffle', 'remove', 'clear', 'ping', 'help'];
    assert.deepEqual(Object.keys(ctx.music.commands), names);
    assert.deepEqual([...ctx.bot.commands.keys()], names);
    for (const [name, c] of Object.entries(ctx.music.commands)) {
      assert.match(name, /^[a-z0-9_-]{1,32}$/);
      assert.ok(c.description.length > 0 && c.description.length <= 100, `/${name}: ${c.description.length} chars`);
      assert.ok(reply.embeds[0].description.includes(`\`/${name}\``), `/${name} is listed`);
    }
  });

  it('/ping times a call to the API, and says so when it fails', async () => {
    const ctx = await setup();
    await command(ctx, 'ping');
    assert.match(last(ctx).content, /^🏓 Pong! Yapin’ answered in \*\*\d+ ms\*\*\.$/);
    assert.deepEqual(ctx.api.calls.at(-2).opts, { timeout: 5000, retries: 0 }, 'a quick check, no long retries');
    ctx.api.meError = apiError(503, 'Yapin’ is busy');
    await command(ctx, 'ping');
    assert.equal(last(ctx).content, '🏓 Pong, but Yapin’ didn\'t answer me: Yapin’ is busy.');
  });

  it('/tracks lists the files by number and the stations, page by page', async () => {
    const files = Array.from({ length: 25 }, (_, i) => `Song ${i + 1}.mp3`);
    const ctx = await setup({ files });
    await command(ctx, 'tracks');
    const page1 = last(ctx).embeds[0];
    assert.equal(page1.title, '🎵 Music library');
    assert.match(page1.description, /^\*\*1\.\*\* Song 1\n\*\*2\.\*\* Song 2\n/);
    assert.match(field(last(ctx), '📻 Radio stations'), /^`groovesalad` — SomaFM · Groove Salad$/);
    assert.match(page1.footer.text, /^Page 1\/2 · 25 files/);
    await command(ctx, 'tracks', '2');
    assert.match(last(ctx).embeds[0].description, /^\*\*21\.\*\* Song 21\n/);
    for (const junk of ['lots', '0x2', '2.0']) {
      await command(ctx, 'tracks', junk);
      assert.match(last(ctx).embeds[0].footer.text, /^Page 1\/2/, `${junk}: anything but a plain number is page 1`);
    }
  });

  it('answers with an apology (and logs it) when a handler breaks', async () => {
    const library = { init: async () => [], localTracks: async () => [], enrich: async (t) => t, stations: [],
      musicDir: null, resolve: async () => { throw new Error('the disk is on fire'); } };
    const ctx = await setup({ library });
    await command(ctx, 'play', 'anything');
    assert.equal(last(ctx).content, '⚠️ Something went wrong there. Try again in a moment.');
    const logged = ctx.logger.lines.filter((l) => l.level === 'error' && / failed:/.test(l.text));
    assert.deepEqual(logged.map((l) => l.text), ['/play failed: the disk is on fire']);
    ctx.logger.lines.length = 0; // expected here
  });

  it('logs what the library warns about when the cog loads', async () => {
    const ctx = await setup({ stations: '[{ "id": "broken" ' });
    assert.ok(ctx.logger.lines.some((l) => l.level === 'warn' && /isn't valid JSON/.test(l.text)));
    await command(ctx, 'tracks');
    assert.equal(field(last(ctx), '📻 Radio stations'), undefined, 'no stations, and no crash');
  });

  it('/queue shows an empty queue when nothing plays', async () => {
    const ctx = await setup();
    await command(ctx, 'queue');
    assert.equal(last(ctx).embeds[0].title, '📜 Queue');
    assert.match(last(ctx).embeds[0].description, /The queue is empty/);
  });

  it('commands about a server refuse DMs; /tracks and /help work there too', async () => {
    const ctx = await setup();
    const serverOnly = ['play', 'queue', 'nowplaying', 'pause', 'resume', 'skip', 'stop', 'volume', 'loop', 'shuffle',
      'remove', 'clear'];
    for (const name of serverOnly) {
      await command(ctx, name, name === 'play' ? '1' : '', { server: null });
      assert.equal(last(ctx).content, DM, `/${name} in a DM`);
    }
    await command(ctx, 'tracks', '', { server: null });
    assert.equal(last(ctx).embeds[0].title, '🎵 Music library');
    assert.equal(ctx.api.voiceLookups, 0);
    assert.equal(ctx.voice.calls.length, 0);
  });
});

describe('Music cog: /play', OPTS, () => {
  it('without a query explains itself, or resumes when paused', async () => {
    const usage = /^🎵 What should I play\? `\/play <track number or name>`, a radio station or an http\(s\) stream/;
    const ctx = await setup();
    await command(ctx, 'play');
    assert.match(last(ctx).content, usage);
    await startPlaying(ctx, '1');
    await command(ctx, 'play');
    assert.match(last(ctx).content, usage, 'playing, not paused: nothing to resume');
    await command(ctx, 'pause');
    assert.equal(player(ctx).paused, true);
    ctx.api.setVoice({ [LOUNGE]: [USER, BOT], [GAMING]: ['user-2'] });
    await command(ctx, 'play', '', { user: 'user-2' });
    assert.equal(last(ctx).content, '🎧 Join 🔊 **Lounge** to control the music.');
    assert.equal(player(ctx).paused, true, 'resuming is a control: only for the people listening');
    await command(ctx, 'play');
    assert.equal(last(ctx).content, '▶️ Resumed.');
    assert.equal(player(ctx).paused, false);

    const noLinks = await setup({ config: { allowUrls: false } });
    await command(noLinks, 'play');
    assert.match(last(noLinks).content, /^🎵 What should I play\? `\/play <track number or name>` or a radio station\./);
  });

  it("refuses while ffmpeg is missing (without naming its path) and looks for it again later", async () => {
    const ctx = await setup({ ffmpeg: false });
    assert.equal(ctx.ffmpegState.checks, 1, 'cogLoad looked');
    assert.ok(ctx.logger.lines.some((l) => l.level === 'error' && /ffmpeg not found/.test(l.text)), 'loudly');
    await command(ctx, 'play', '1');
    assert.match(last(ctx).content, /^⚠️ I can't play anything right now: ffmpeg isn't installed/);
    assert.doesNotMatch(last(ctx).content, /not found at|"ffmpeg"/);
    assert.equal(ctx.api.voiceLookups, 0);
    assert.equal(ctx.ffmpegState.checks, 1, 'not again right away');

    ctx.ffmpegState.ok = true; // the owner installs it
    await ctx.timers.advance(30_000);
    await command(ctx, 'play', '1');
    assert.match(last(ctx).content, /ffmpeg isn't installed/, 'this one is still refused');
    await until(() => ctx.ffmpegState.checks === 2);
    await flush();
    await command(ctx, 'play', '1');
    await until(() => ctx.decoders.count === 1);
  });

  it("says what it couldn't find, with what to type for each candidate", async () => {
    const ctx = await setup({ files: ['Alpha [One].mp3', 'Alpha [Two].mp3', 'Beta.mp3'] });
    await command(ctx, 'play', 'alpha');
    assert.equal(last(ctx).content, '🤔 2 tracks match “alpha”. Which one did you mean?\n'
      + '• `/play 1` — Alpha \\[One\\]\n• `/play 2` — Alpha \\[Two\\]');
    await command(ctx, 'play', 'zzzz qqqq');
    assert.match(last(ctx).content, /^🔍 Nothing matches “zzzz qqqq”\./);
    await command(ctx, 'play', '9');
    assert.match(last(ctx).content, /^🔢 There's no track #9\. The library has 3 tracks/);
    await command(ctx, 'play', 'ftp://example.com/song.mp3');
    assert.match(last(ctx).content, /^🚫 /);
    assert.equal(ctx.api.voiceLookups, 0);
    assert.equal(ctx.voice.calls.length, 0);
  });

  it("asks the caller to join a voice channel when they aren't in one", async () => {
    const ctx = await setup();
    ctx.api.setVoice({ [LOUNGE]: [], [GAMING]: [] });
    await command(ctx, 'play', '1');
    assert.equal(last(ctx).content, '🎧 Join a voice channel first, then try `/play` again.');
    assert.equal(ctx.voice.calls.length, 0);
    assert.equal(player(ctx), undefined);
  });

  it('explains a failed, rate-limited or hanging voice lookup', async () => {
    const ctx = await setup();
    ctx.api.voiceError = apiError(500);
    await command(ctx, 'play', '1');
    assert.equal(last(ctx).content, "⚠️ I couldn't check which voice channel you're in. Try again in a moment.");
    ctx.api.voiceError = apiError(429, 'Slow down', { retryAfter: 7 });
    await command(ctx, 'play', '1');
    assert.equal(last(ctx).content, '⏳ Yapin’ is rate-limiting me right now. Try again in 7 s.');

    ctx.api.voiceError = null;
    ctx.api.hangVoice = true;
    const lookups = ctx.api.voiceLookups;
    const pending = command(ctx, 'play', '1');
    await until(() => ctx.api.voiceLookups > lookups);
    await ctx.timers.advance(3000);
    await pending;
    assert.equal(last(ctx).content, "⚠️ I couldn't check which voice channel you're in. Try again in a moment.");
    assert.equal(ctx.voice.calls.length, 0);
  });

  it('starts the first track and answers the /play with its Now Playing card', async () => {
    const ctx = await setup();
    const msg = await command(ctx, 'play', 'beta');
    assert.equal(ctx.api.posts.length, 0, 'no answer until the music starts');
    await until(() => ctx.decoders.count === 1);
    assert.deepEqual(ctx.voice.calls, [LOUNGE]);
    const track = ctx.decoders.last.track;
    assert.equal(track.title, 'Beta');
    assert.equal(track.duration, 180, 'probed while the voice lookup ran');
    assert.equal(track.requestedBy, USER);
    ctx.decoders.last.push(1);
    await until(() => cards(ctx).length === 1);
    const [card] = cards(ctx);
    assert.equal(card.channelId, TEXT);
    assert.equal(card.reply_to, msg.id);
    assert.equal(card.content, '');
    assert.equal(card.embeds[0].title, '🎶 Now Playing');
    assert.match(card.embeds[0].description, /^\*\*Beta\*\*\n.*`0:00 \/ 3:00`$/);
    assert.equal(field(card, 'Requested by'), `<@${USER}>`);
    assert.equal(field(card, 'Volume'), '100%');
    assert.equal(field(card, 'Loop'), 'Off');
    assert.equal(field(card, 'Up next'), '—');
    assert.equal(card.embeds[0].footer.text, '🔊 Lounge · 0 in queue');
    assert.deepEqual(customIds(card), ['toggle', 'skip', 'stop', 'loop', 'voldown', 'volup']
      .map((action) => `music:${action}:${SERVER}`));
    assert.equal(player(ctx).textChannelId, TEXT);
    assert.equal(player(ctx).channelName, 'Lounge');
  });

  it("queues behind the current track and says where (and that it's paused)", async () => {
    const ctx = await setup();
    await startPlaying(ctx, '1');
    const msg = await command(ctx, 'play', 'gamma');
    const reply = last(ctx);
    assert.equal(reply.reply_to, msg.id);
    assert.equal(reply.content, '');
    assert.equal(reply.embeds[0].title, '➕ Added to queue');
    assert.match(reply.embeds[0].description, /^\*\*Gamma\*\*$/);
    assert.equal(field(reply, 'Position'), '#1');
    assert.equal(field(reply, 'Length'), '3:00');
    assert.match(field(reply, 'Starts in'), /^~\d+:\d\d$/);
    await command(ctx, 'pause');
    await command(ctx, 'play', 'beta');
    assert.equal(last(ctx).content, '⏸ The music is paused: `/resume` or the ⏯ button carries on.');
    assert.equal(field(last(ctx), 'Position'), '#2');
    assert.deepEqual(player(ctx).queue.upcoming.map((t) => t.title), ['Gamma', 'Beta']);
  });

  it('refuses while busy in another voice channel, naming it', async () => {
    const ctx = await setup();
    await startPlaying(ctx, '1');
    ctx.api.setVoice({ [LOUNGE]: [USER, BOT], [GAMING]: ['user-2'] });
    await command(ctx, 'play', '2', { user: 'user-2' });
    assert.equal(last(ctx).content,
      "🎶 I'm already playing in 🔊 **Lounge**. Join me there, or wait until the queue is done.");
    assert.equal(player(ctx).queue.length, 0);
    assert.deepEqual(ctx.voice.calls, [LOUNGE]);
  });

  it("moves to the caller's channel when it sits idle in another one", async () => {
    const ctx = await setup();
    const { dec } = await startPlaying(ctx, '1');
    dec.end();
    await until(() => player(ctx).state === PlayerState.IDLE);
    await ctx.timers.advance(20_000); // a move is a join too: paced (well inside the 30 s it lingers)
    ctx.api.setVoice({ [LOUNGE]: [BOT], [GAMING]: [USER] });
    await voiceEvent(ctx, 'voice_leave', { server_id: SERVER, channel_id: LOUNGE, user_id: USER });
    await voiceEvent(ctx, 'voice_join', { server_id: SERVER, channel_id: GAMING, user_id: USER });
    const msg = await command(ctx, 'play', '2');
    await until(() => ctx.decoders.count === 2);
    assert.deepEqual(ctx.voice.calls, [LOUNGE, GAMING]);
    assert.equal(ctx.voice.connections[0].leaveCalls, 1, 'left the old channel first');
    ctx.decoders.last.push(1);
    await until(() => cards(ctx).length === 2);
    assert.equal(cards(ctx)[1].reply_to, msg.id);
    assert.equal(cards(ctx)[1].embeds[0].footer.text, '🔊 Gaming · 0 in queue');
  });

  it('says when the queue is full', async () => {
    const ctx = await setup({ config: { maxQueueSize: 1 } });
    await startPlaying(ctx, '1');
    await command(ctx, 'play', '2');
    await command(ctx, 'play', '3');
    assert.equal(last(ctx).content,
      '📛 The queue is full (1 track max). Make room with `/remove` or `/clear`, or wait a bit.');
    assert.deepEqual(player(ctx).queue.upcoming.map((t) => t.title), ['Beta']);
  });

  it('says so when joining voice takes a while, and answers the /play when it gives up', async () => {
    const voice = new FakeVoice({ manual: true }); // e.g. yapper.js sleeping through rate-limited joins
    const ctx = await setup({ voice });
    const msg = await command(ctx, 'play', '1');
    await until(() => voice.pending === 1);
    await ctx.timers.advance(2499);
    assert.equal(ctx.api.posts.length, 0, 'a normal join is answered by the card alone');
    await ctx.timers.advance(1);
    await until(() => ctx.api.posts.length === 1);
    assert.equal(ctx.api.posts[0].reply_to, msg.id);
    assert.equal(ctx.api.posts[0].content, '🔌 Joining 🔊 **Lounge** is taking a moment…');
    ctx.api.setVoice({ [LOUNGE]: [USER], [GAMING]: ['user-2'] });
    await command(ctx, 'play', '2', { user: 'user-2' });
    assert.equal(last(ctx).content, "🎶 I'm joining 🔊 **Lounge**. Join me there, or wait until the queue is done.");
    await ctx.timers.advance(17_500); // 20 s after the /play
    await until(() => said(ctx, /^❌/));
    assert.equal(last(ctx).reply_to, msg.id);
    assert.equal(last(ctx).content,
      "❌ I couldn't join 🔊 **Lounge**: It took over 20 s, so I gave up. Try again in a minute.");
    assert.equal(voice.signals[0].aborted, true, 'the join was called off');
    assert.equal(ctx.music.players.size, 0, 'nothing is held up any more');
    assert.equal(ctx.api.posts.filter((p) => p.content.startsWith('🔌')).length, 1, 'said once');
  });

  it("keeps ffmpeg's path out of chat when ffmpeg goes missing after the startup check, then refuses /play",
    async () => {
      const bin = '/Users/someone/bin/ffmpeg';
      const decoders = new FakeDecoders((dec) => dec.failToStart(`ffmpeg not found at "${bin}" — install ffmpeg or set `
        + 'FFMPEG_PATH'));
      const ctx = await setup({ decoders });
      const msg = await command(ctx, 'play', '1');
      await until(() => said(ctx, /Couldn't play/));
      const [reply] = ctx.api.posts;
      assert.equal(reply.reply_to, msg.id);
      assert.equal(reply.content,
        "⚠️ Couldn't play **Alpha**: ffmpeg isn't available on the computer I run on. Skipping it.");
      assert.ok(!JSON.stringify(ctx.api.posts).includes('someone'), 'no local path in chat');
      assert.ok(ctx.logger.lines.some((l) => l.level === 'error' && l.text.includes(bin)), 'the log says where');
      const lookups = ctx.api.voiceLookups;
      await command(ctx, 'play', '2');
      assert.match(last(ctx).content, /^⚠️ I can't play anything right now: ffmpeg isn't installed/);
      assert.equal(ctx.api.voiceLookups, lookups, 'refused before any lookup or join');
      assert.equal(ctx.decoders.count, 1);
      await ctx.timers.advance(30_000);
      await command(ctx, 'play', '2');
      await until(() => ctx.ffmpegState.checks === 2, { message: 'it looks for ffmpeg again' });

      // A start failure that doesn't mean ffmpeg is gone (out of file handles) keeps the path out, and /play on.
      const busy = new FakeDecoders((dec) => dec.end({ code: null, error: new FfmpegStartError(
        `Couldn't start ffmpeg at "${bin}": spawn EMFILE`, { code: 'EMFILE' }) }));
      const other = await setup({ decoders: busy });
      await command(other, 'play', '1');
      await until(() => said(other, /Couldn't play/));
      assert.equal(other.api.posts[0].content, "⚠️ Couldn't play **Alpha**: ffmpeg couldn't be started. Skipping it.");
      await command(other, 'play', '2');
      await until(() => other.decoders.count === 2);
    });

  it('answers a failed join once, as a reply to the /play', async () => {
    const voice = new FakeVoice();
    voice.failNext(apiError(403, "I don't have permission to join that voice channel."));
    const ctx = await setup({ voice });
    const msg = await command(ctx, 'play', '1');
    await until(() => ctx.api.posts.length === 1);
    await until(() => ctx.music.players.size === 0);
    await ctx.timers.advance(0);
    assert.equal(ctx.api.posts.length, 1, "the 'destroy' that follows adds nothing");
    const [reply] = ctx.api.posts;
    assert.equal(reply.reply_to, msg.id);
    // The channel's name may still be on its way when the join fails, so either wording is fine.
    assert.match(reply.content, /^❌ I couldn't join (?:🔊 \*\*Lounge\*\*|the voice channel): /);
    assert.ok(reply.content.endsWith(": I don't have permission to join that voice channel."), reply.content);
  });

  it("answers a track that can't be played with the reason, as a reply to the /play", async () => {
    const decoders = new FakeDecoders((dec) => dec.fail('Invalid data found when processing input', 1));
    const ctx = await setup({ decoders });
    const msg = await command(ctx, 'play', '1');
    await until(() => said(ctx, /Nothing else is queued/));
    const [error, end] = ctx.api.posts;
    assert.equal(error.reply_to, msg.id);
    assert.equal(error.content, "⚠️ Couldn't play **Alpha**: Invalid data found when processing input. Skipping it.");
    // Not "✅ That was the last track", which would read as if it had played.
    assert.equal(end.content, "📭 Nothing else is queued, so I'll leave 🔊 **Lounge** in 30 s unless something new is "
      + 'played.');
    assert.equal(cards(ctx).length, 0, 'no card for a track that never made a sound');
  });

  it('says "that was the last track" when the last one did play, even after an earlier one failed', async () => {
    const decoders = new FakeDecoders((dec, i) => (i === 0 ? dec.fail('Invalid data found when processing input', 1)
      : dec.play(2)));
    const voice = new FakeVoice({ manual: true });
    const ctx = await setup({ decoders, voice });
    await command(ctx, 'play', '1');
    await command(ctx, 'play', '2'); // queued while the bot joins
    await until(() => voice.pending === 1);
    voice.resolve();
    await until(() => said(ctx, /last track|Nothing else/));
    assert.match(last(ctx).content, /^✅ That was the last track\. I'll leave/);
    assert.ok(!said(ctx, /Nothing else is queued/));
  });

  it("escapes file, channel and error text, so none of it can format messages or ping anyone", async () => {
    const decoders = new FakeDecoders((dec, i) => {
      if (i === 1) dec.fail('Server returned 403 **Forbidden** for @here', 1);
    });
    const ctx = await setup({ files: ['@everyone_[loud]_#1.mp3', '<@123>_(live).mp3'], decoders });
    ctx.api.channels.set(LOUNGE, { id: LOUNGE, name: '@here *VIP*', type: 'voice' });
    const { card } = await startPlaying(ctx, '1');
    assert.ok(card.embeds[0].description.startsWith(`**@${ZWSP}everyone \\[loud\\] \\#1**\n`));
    await command(ctx, 'play', '2');
    assert.equal(last(ctx).embeds[0].description, `**<${ZWSP}@${ZWSP}123\\> \\(live\\)**`);
    await nextTrack(ctx, ctx.decoders.last);
    await until(() => said(ctx, /Nothing else is queued/));
    assert.ok(ctx.api.posts.some((p) => p.content === `⚠️ Couldn't play **<${ZWSP}@${ZWSP}123\\> \\(live\\)**: `
      + `Server returned 403 \\*\\*Forbidden\\*\\* for @${ZWSP}here. Skipping it.`));
    assert.ok(last(ctx).content.startsWith(`📭 Nothing else is queued, so I'll leave 🔊 **@${ZWSP}here \\*VIP\\*** in`));
    const everything = JSON.stringify(ctx.api.posts);
    for (const ping of ['@everyone', '@here', '<@123>']) assert.ok(!everything.includes(ping), `no live ${ping}`);
  });
});

describe('Music cog: the Now Playing card', OPTS, () => {
  it('follows the queue: a card per track, the old one loses its buttons, then the goodbye', async () => {
    const ctx = await setup();
    const { card: first, dec } = await startPlaying(ctx, '1');
    await command(ctx, 'play', '2');
    const second = await nextTrack(ctx, dec);
    await until(() => cards(ctx).length === 2);
    const card2 = cards(ctx)[1];
    assert.equal(card2.reply_to, undefined, "a queued track's card isn't a reply");
    assert.match(card2.embeds[0].description, /^\*\*Beta\*\*/);
    assert.deepEqual(ctx.api.edits, [{ channelId: TEXT, messageId: first.id, components: null }]);

    second.end();
    await until(() => said(ctx, /last track/));
    assert.deepEqual(ctx.api.edits.at(-1), { channelId: TEXT, messageId: card2.id, components: null });
    assert.equal(last(ctx).content, "✅ That was the last track. I'll leave 🔊 **Lounge** in 30 s unless something "
      + 'new is played.');
    await ctx.timers.advance(30_000);
    await until(() => said(ctx, /Nothing left to play/));
    assert.equal(last(ctx).content, '👋 Nothing left to play, so I left 🔊 **Lounge**.');
    assert.equal(ctx.voice.last.leaveCalls, 1);
    assert.equal(player(ctx), undefined);
    assert.equal(ctx.api.edits.length, 2, 'nothing left to retire');
  });

  it('with IDLE_TIMEOUT_SECONDS=0 it leaves right after the last track, saying goodbye once', async () => {
    const ctx = await setup({ config: { idleTimeoutMs: 0 } });
    const { dec, card } = await startPlaying(ctx, '1');
    dec.end();
    await until(() => said(ctx, /Nothing left to play/));
    assert.ok(!said(ctx, /last track/), 'no "leaving in 0 s"');
    assert.deepEqual(ctx.api.edits, [{ channelId: TEXT, messageId: card.id, components: null }]);
    assert.equal(ctx.voice.last.leaveCalls, 1);
  });

  it('shows a pause, a volume change and a queued track on the card', async () => {
    const ctx = await setup();
    const { card } = await startPlaying(ctx, '1');
    const changes = [
      [() => command(ctx, 'pause'), (edit) => assert.equal(edit.embeds[0].title, '⏸ Paused')],
      [() => command(ctx, 'volume', '150'), (edit) => assert.equal(field(edit, 'Volume'), '150%')],
      [() => command(ctx, 'play', '2'), (edit) => assert.match(field(edit, 'Up next'), /^Beta/)],
    ];
    for (const [change, check] of changes) {
      const edits = ctx.api.edits.length;
      await change();
      await ctx.timers.advance(1500);
      await until(() => ctx.api.edits.length === edits + 1);
      assert.equal(ctx.api.edits.at(-1).messageId, card.id);
      check(ctx.api.edits.at(-1));
    }
  });

  it('batches changes that come close together into one edit', async () => {
    const ctx = await setup();
    const { card } = await startPlaying(ctx, '1');
    await command(ctx, 'pause');
    await ctx.timers.advance(100);
    await command(ctx, 'volume', '150');
    await command(ctx, 'play', '2');
    assert.equal(ctx.api.edits.length, 0, 'not right away');
    await ctx.timers.advance(1400);
    await until(() => ctx.api.edits.length === 1);
    const [edit] = ctx.api.edits;
    assert.equal(edit.messageId, card.id);
    assert.equal(edit.embeds[0].title, '⏸ Paused');
    assert.equal(field(edit, 'Volume'), '150%');
    assert.match(field(edit, 'Up next'), /^Beta · `3:00`/);
    assert.equal(button(edit, 0, 0).label, '⏯ Resume');
    await ctx.timers.advance(5000);
    assert.equal(ctx.api.edits.length, 1, 'nothing changed since');
  });

  it('loop track keeps one live card through every repeat, and its buttons keep working', async () => {
    const ctx = await setup();
    const { card, dec } = await startPlaying(ctx, '1');
    await command(ctx, 'loop', 'track');
    let current = dec;
    for (let i = 0; i < 3; i++) current = await nextTrack(ctx, current); // Alpha again, three times
    await ctx.timers.advance(1500);
    assert.equal(cards(ctx).length, 1, 'no new card for every repeat');
    assert.ok(ctx.api.edits.length > 0, 'the card shows it started over');
    assert.ok(ctx.api.edits.every((e) => e.messageId === card.id && e.components !== null), 'and keeps its buttons');
    const answer = await click(ctx, 'skip', { messageId: card.id });
    assert.equal(answer.embeds[0].description, `⏭ Skipped by <@${USER}>\n**Alpha**`);
    assert.equal(current.killed, true);
  });

  it('/nowplaying answers with a fresh card and retires the old one', async () => {
    const ctx = await setup();
    const { card } = await startPlaying(ctx, '1');
    const msg = await command(ctx, 'nowplaying');
    await until(() => cards(ctx).length === 2);
    const fresh = cards(ctx)[1];
    assert.equal(fresh.reply_to, msg.id);
    assert.deepEqual(ctx.api.edits, [{ channelId: TEXT, messageId: card.id, components: null }]);
    assert.deepEqual(await click(ctx, 'toggle', { messageId: card.id }), { type: 'update', components: null });
    assert.equal(player(ctx).paused, false, 'the old card is dead');
    assert.equal((await click(ctx, 'toggle', { messageId: fresh.id })).embeds[0].title, '⏸ Paused');
  });
});

describe('Music cog: the buttons', OPTS, () => {
  it('⏯ pauses and resumes, updating the card in place', async () => {
    const ctx = await setup();
    const { card } = await startPlaying(ctx, '1');
    const paused = await click(ctx, 'toggle', { messageId: card.id });
    assert.equal(paused.type, 'update');
    assert.equal(paused.embeds[0].title, '⏸ Paused');
    assert.equal(button(paused, 0, 0).label, '⏯ Resume');
    assert.equal(player(ctx).paused, true);
    const resumed = await click(ctx, 'toggle', { messageId: card.id });
    assert.equal(resumed.embeds[0].title, '🎶 Now Playing');
    assert.equal(button(resumed, 0, 0).label, '⏯ Pause');
    assert.equal(player(ctx).paused, false);
    await ctx.timers.advance(5000);
    assert.equal(ctx.api.edits.length, 0, 'the answers showed it: no extra edit');
  });

  it('🔁 cycles the loop mode; 🔉 and 🔊 step the volume within 1 to 200', async () => {
    const ctx = await setup();
    const { card } = await startPlaying(ctx, '1');
    for (const mode of ['Track', 'Queue', 'Off']) {
      const answer = await click(ctx, 'loop', { messageId: card.id });
      assert.equal(button(answer, 1, 0).label, `🔁 Loop: ${mode}`);
      assert.equal(field(answer, 'Loop'), mode);
    }
    assert.equal(field(await click(ctx, 'volup', { messageId: card.id }), 'Volume'), '110%');
    assert.equal(field(await click(ctx, 'voldown', { messageId: card.id }), 'Volume'), '100%');
    player(ctx).setVolume(195);
    const loudest = await click(ctx, 'volup', { messageId: card.id });
    assert.equal(field(loudest, 'Volume'), '200%');
    assert.equal(button(loudest, 1, 2).disabled, true);
    player(ctx).setVolume(5);
    const quietest = await click(ctx, 'voldown', { messageId: card.id });
    assert.equal(field(quietest, 'Volume'), '1%');
    assert.equal(button(quietest, 1, 1).disabled, true);
  });

  it('⏭ finishes the card ("Skipped by") and plays the next track', async () => {
    const ctx = await setup();
    const { card, dec } = await startPlaying(ctx, '1');
    await command(ctx, 'play', '2');
    const answer = await click(ctx, 'skip', { messageId: card.id });
    assert.equal(answer.type, 'update');
    assert.equal(answer.components, null);
    assert.equal(answer.embeds[0].description, `⏭ Skipped by <@${USER}>\n**Alpha**`);
    assert.equal(dec.killed, true);
    await until(() => ctx.decoders.count === 2);
    ctx.decoders.last.push(1);
    await until(() => cards(ctx).length === 2);
    assert.equal(ctx.api.edits.length, 0, 'the answer already took the buttons off');
  });

  it('⏹ finishes the card ("Stopped by"), stops and leaves voice without another word', async () => {
    const ctx = await setup();
    const { card } = await startPlaying(ctx, '1');
    const answer = await click(ctx, 'stop', { messageId: card.id });
    assert.equal(answer.components, null);
    assert.equal(answer.embeds[0].description, `⏹ Stopped by <@${USER}>\n**Alpha**`);
    await until(() => ctx.voice.last.leaveCalls === 1);
    await until(() => ctx.music.players.size === 0);
    await flush();
    assert.equal(ctx.api.posts.length, 1, 'only the card');
    assert.equal(ctx.api.edits.length, 0);
  });

  it('takes the buttons off cards of no live player, and off older cards', async () => {
    const ctx = await setup();
    assert.deepEqual(await click(ctx, 'skip', { messageId: 'card-from-yesterday' }),
      { type: 'update', components: null });
    assert.deepEqual(await click(ctx, 'skip', { messageId: 'x', customId: 'music:dance:server-1' }),
      { type: 'update', components: null });
    const { dec } = await startPlaying(ctx, '1');
    assert.deepEqual(await click(ctx, 'skip', { messageId: 'an-older-card' }), { type: 'update', components: null });
    assert.deepEqual(await click(ctx, 'stop', { messageId: 'x', server: 'server-2' }),
      { type: 'update', components: null });
    ctx.api.setVoice({ [LOUNGE]: [USER, BOT], [GAMING]: ['user-2'] });
    const lookups = ctx.api.voiceLookups;
    assert.deepEqual(await click(ctx, 'skip', { messageId: 'an-older-card', user: 'user-2' }),
      { type: 'update', components: null }, 'dead for everyone');
    assert.equal(ctx.api.voiceLookups, lookups, 'a dead card needs no voice lookup');
    assert.equal(dec.killed, false);
    assert.equal(player(ctx).current.title, 'Alpha');
  });

  it("treats the card of a track that ended as dead, even before it's retired", async () => {
    const ctx = await setup();
    const { card, dec } = await startPlaying(ctx, '1');
    await command(ctx, 'play', '2');
    dec.fail('Connection reset by peer', 1); // Alpha breaks off; Beta is up but hasn't made a sound yet
    await until(() => ctx.decoders.count === 2);
    assert.equal(player(ctx).current.title, 'Beta');
    assert.deepEqual(await click(ctx, 'skip', { messageId: card.id }), { type: 'update', components: null });
    assert.equal(player(ctx).current.title, 'Beta', "Alpha's skip button doesn't skip Beta");
    assert.equal(ctx.decoders.last.killed, false);
  });

  it("only obeys people in the bot's voice channel, but lets them through when the lookup fails", async () => {
    const ctx = await setup();
    const { card } = await startPlaying(ctx, '1');
    ctx.api.setVoice({ [LOUNGE]: [USER, BOT], [GAMING]: ['user-2'] });
    const denied = await click(ctx, 'skip', { messageId: card.id, user: 'user-2' });
    assert.deepEqual(denied, { type: 'ephemeral', content: '🎧 Join 🔊 **Lounge** to control the music.' });
    assert.equal(player(ctx).current.title, 'Alpha');

    await ctx.timers.advance(5001); // the cached voice state is stale now
    ctx.api.voiceError = apiError(500);
    assert.equal((await click(ctx, 'toggle', { messageId: card.id, user: 'user-2' })).embeds[0].title, '⏸ Paused');

    ctx.api.voiceError = null;
    ctx.api.hangVoice = true;
    const lookups = ctx.api.voiceLookups;
    const pending = click(ctx, 'toggle', { messageId: card.id, user: 'user-2' });
    await until(() => ctx.api.voiceLookups > lookups);
    await ctx.timers.advance(1500); // a click can't wait for a slow lookup
    assert.equal((await pending).embeds[0].title, '🎶 Now Playing');
  });
});

describe('Music cog: control commands', OPTS, () => {
  it('say so when nothing is playing', async () => {
    const ctx = await setup();
    for (const name of ['nowplaying', 'pause', 'resume', 'skip', 'stop', 'loop', 'shuffle', 'remove', 'clear']) {
      await command(ctx, name);
      assert.equal(last(ctx).content, IDLE, `/${name}`);
    }
    const { dec } = await startPlaying(ctx, '1');
    dec.end();
    await until(() => player(ctx)?.state === PlayerState.IDLE);
    await ctx.timers.advance(5001); // past the voice cache, so a lookup would show
    const lookups = ctx.api.voiceLookups;
    for (const name of ['nowplaying', 'pause', 'resume', 'skip']) {
      await command(ctx, name);
      assert.equal(last(ctx).content, IDLE, `/${name} while the player waits idle`);
    }
    assert.equal(ctx.api.voiceLookups, lookups, 'no voice lookup spent on that');
  });

  it('/pause, /resume and /skip', async () => {
    const ctx = await setup();
    const { card, dec } = await startPlaying(ctx, '1');
    await command(ctx, 'play', '2');
    await command(ctx, 'pause');
    assert.equal(last(ctx).content, '⏸ Paused. `/resume` or the ⏯ button carries on.');
    await command(ctx, 'pause');
    assert.equal(last(ctx).content, '⏸ Already paused.');
    await command(ctx, 'resume');
    assert.equal(last(ctx).content, '▶️ Resumed.');
    await command(ctx, 'resume');
    assert.equal(last(ctx).content, '▶️ Already playing.');
    await command(ctx, 'skip');
    assert.equal(last(ctx).content, '⏭ Skipped **Alpha**.');
    assert.equal(dec.killed, true);
    await until(() => ctx.api.edits.some((e) => e.messageId === card.id));
    const ended = ctx.api.edits.find((e) => e.messageId === card.id);
    assert.equal(ended.components, null);
    assert.equal(ended.embeds[0].description, `⏭ Skipped by <@${USER}>\n**Alpha**`);
    assert.equal(player(ctx).current.title, 'Beta');
  });

  it('/stop finishes the card, leaves voice and says so', async () => {
    const ctx = await setup();
    const { card } = await startPlaying(ctx, '1');
    await command(ctx, 'stop');
    assert.equal(last(ctx).content, '⏹ Stopped the music and left 🔊 **Lounge**.');
    await until(() => ctx.voice.last.leaveCalls === 1);
    await until(() => ctx.api.edits.length === 1);
    assert.equal(ctx.api.edits[0].messageId, card.id);
    assert.equal(ctx.api.edits[0].embeds[0].description, `⏹ Stopped by <@${USER}>\n**Alpha**`);
    assert.equal(player(ctx), undefined);
  });

  it('/volume shows, sets and steps it, and keeps it for the next session', async () => {
    const ctx = await setup();
    await command(ctx, 'volume');
    assert.equal(last(ctx).content, '🔊 The volume is **100%**.');
    await command(ctx, 'volume', '50%');
    assert.equal(last(ctx).content, '🔊 Volume set to **50%**. It applies when the music starts.');
    for (const bad of ['loud', '0', '250', '1.5']) {
      await command(ctx, 'volume', bad);
      assert.match(last(ctx).content, /^🔢 The volume is a whole number from 1 to 200/, bad);
    }
    await startPlaying(ctx, '1');
    assert.equal(player(ctx).volume, 50);
    await command(ctx, 'volume', '+30');
    assert.equal(last(ctx).content, '🔊 Volume set to **80%**.');
    await command(ctx, 'volume', '- 200');
    assert.equal(last(ctx).content, '🔉 Volume set to **1%**.');
    assert.equal(player(ctx).volume, 1);
  });

  it('/loop cycles through the modes or takes one by name', async () => {
    const ctx = await setup();
    await startPlaying(ctx, '1');
    for (const [mode, note] of [['Track', 'repeating the current track'], ['Queue', 'repeating the whole queue'],
      ['Off', 'tracks play once']]) {
      await command(ctx, 'loop');
      assert.equal(last(ctx).content, `🔁 Loop: **${mode}** (${note}).`);
    }
    await command(ctx, 'loop', 'all');
    assert.equal(last(ctx).content, '🔁 Loop: **Queue** (repeating the whole queue).');
    await command(ctx, 'loop', 'sometimes');
    assert.match(last(ctx).content, /^🔁 Loop can be `off`, `track`/);
    assert.equal(player(ctx).loop, 'queue', 'unchanged');
    await command(ctx, 'loop', 'off');
    assert.equal(last(ctx).content, '🔁 Loop: **Off** (tracks play once).');
    assert.equal(player(ctx).loop, 'off');
  });

  it('/shuffle, /remove and /clear work on what is up next', async () => {
    const ctx = await setup({ files: ['Alpha.mp3', 'Beta.mp3', 'Gamma.mp3', 'Delta.mp3'] });
    await startPlaying(ctx, 'alpha');
    for (const title of [null, 'beta']) {
      if (title) await command(ctx, 'play', title);
      await command(ctx, 'shuffle');
      assert.equal(last(ctx).content, '🔀 There have to be at least 2 tracks up next to shuffle them.');
    }
    for (const title of ['gamma', 'delta']) await command(ctx, 'play', title);
    await command(ctx, 'shuffle');
    assert.equal(last(ctx).content, '🔀 Shuffled 3 tracks.');
    assert.deepEqual(player(ctx).queue.upcoming.map((t) => t.title), ['Gamma', 'Delta', 'Beta'], 'random() is 0');
    await command(ctx, 'remove', '#2');
    assert.equal(last(ctx).content, '🗑 Removed **Delta** from the queue.');
    await command(ctx, 'remove', '9');
    assert.equal(last(ctx).content, '🔢 Position must be a whole number from 1 to 2 (got 9).');
    await command(ctx, 'remove', 'beta');
    assert.equal(last(ctx).content, '🔢 Which one? `/remove <number>`, with the number `/queue` shows.');
    await command(ctx, 'queue');
    assert.match(last(ctx).embeds[0].description, /\*\*1\.\*\* Gamma · `3:00` · <@user-1>\n\*\*2\.\*\* Beta/);
    await command(ctx, 'clear');
    assert.equal(last(ctx).content, '🧹 Cleared 2 tracks from the queue.');
    await command(ctx, 'clear');
    assert.equal(last(ctx).content, '🧹 The queue was empty already.');
    assert.equal(player(ctx).current.title, 'Alpha');
  });

  it("are refused to people outside the bot's voice channel (unless REQUIRE_SAME_VOICE is off)", async () => {
    const ctx = await setup();
    await startPlaying(ctx, '1');
    ctx.api.setVoice({ [LOUNGE]: [USER, BOT], [GAMING]: ['user-2'] });
    for (const name of ['pause', 'skip', 'stop', 'volume', 'loop', 'clear']) {
      await command(ctx, name, name === 'volume' ? '10' : '', { user: 'user-2' });
      assert.equal(last(ctx).content, '🎧 Join 🔊 **Lounge** to control the music.', `/${name}`);
    }
    assert.equal(player(ctx).volume, 100);
    assert.equal(player(ctx).paused, false);

    const open = await setup({ config: { requireSameVoice: false } });
    await startPlaying(open, '1');
    open.api.setVoice({ [LOUNGE]: [USER, BOT], [GAMING]: ['user-2'] });
    const lookups = open.api.voiceLookups;
    await command(open, 'pause', '', { user: 'user-2' });
    assert.equal(last(open).content, '⏸ Paused. `/resume` or the ⏯ button carries on.');
    assert.equal(open.api.voiceLookups, lookups, 'no lookup needed');
  });
});

describe("Music cog: Yapin’'s rate limits", OPTS, () => {
  it("doesn't wait for its own replies: one stuck on a rate limit can't hold up the next event", async () => {
    const ctx = await setup();
    const { card } = await startPlaying(ctx, '1');
    ctx.api.hangPostsIn.add('text-2'); // yapper.js waits out a 429 inside the send, one event at a time
    let handled = false;
    const queued = command(ctx, 'queue', '', { server: 'server-2', channel: 'text-2' }).then(() => { handled = true; });
    await until(() => handled, { message: 'the /queue handler waited for its stuck reply' });
    await queued;
    assert.equal(ctx.api.calls.filter((c) => c.path === '/channels/text-2/messages').length, 1, 'no apology after it');
    // The click right behind it (another server; it must be answered within 3 s) goes through at once.
    assert.equal((await click(ctx, 'toggle', { messageId: card.id })).embeds[0].title, '⏸ Paused');
  });

  it("someone who isn't in voice can't burn the bot's voice lookups by spamming /play or the buttons", async () => {
    const ctx = await setup();
    const { card } = await startPlaying(ctx, '1');
    ctx.api.setVoice({ [LOUNGE]: [USER, BOT], [GAMING]: [] }); // user-9 is in no voice channel
    const lookups = ctx.api.voiceLookups;
    for (let i = 0; i < 20; i++) {
      await command(ctx, 'play', '2', { user: 'user-9' });
      assert.equal(last(ctx).content, '🎧 Join a voice channel first, then try `/play` again.');
    }
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(await click(ctx, 'skip', { messageId: card.id, user: 'user-9' }),
        { type: 'ephemeral', content: '🎧 Join 🔊 **Lounge** to control the music.' });
    }
    assert.equal(ctx.api.voiceLookups - lookups, 1, 'one lookup, not 30 (60 a minute for the whole bot)');
    assert.equal(player(ctx).current.title, 'Alpha');
    // Once they do join (Yapin’ sends voice_join), they're looked up again.
    ctx.api.setVoice({ [LOUNGE]: [USER, BOT, 'user-9'], [GAMING]: [] });
    await voiceEvent(ctx, 'voice_join', { server_id: SERVER, channel_id: LOUNGE, user_id: 'user-9' });
    await command(ctx, 'play', '2', { user: 'user-9' });
    assert.equal(last(ctx).embeds[0].title, '➕ Added to queue');
  });

  it('joins voice at most once every 20 s per server and per person (10 joins and leaves a minute per bot)',
    async () => {
      const ctx = await setup();
      const paced = (s) => `⏳ Yapin’ limits how often I can join voice. Try again in ${s} s.`;
      await startPlaying(ctx, '1');
      await command(ctx, 'stop');
      await until(() => ctx.music.players.size === 0);
      await command(ctx, 'play', '1');
      assert.equal(last(ctx).content, paced(20), '/stop then /play: that would be a second join right away');
      await ctx.timers.advance(12_000);
      await command(ctx, 'play', '1');
      assert.equal(last(ctx).content, paced(8));
      ctx.api.setVoice({ 'vc-9': [USER] }, 'server-2');
      await command(ctx, 'play', '1', { server: 'server-2' });
      assert.equal(last(ctx).content, paced(8), 'the same person in another server');
      assert.deepEqual(ctx.voice.calls, [LOUNGE], 'no join was tried');
      await ctx.timers.advance(8_000);
      const { dec } = await startPlaying(ctx, '1');
      assert.deepEqual(ctx.voice.calls, [LOUNGE, LOUNGE]);
      await command(ctx, 'play', '2');
      assert.equal(last(ctx).embeds[0].title, '➕ Added to queue', "queueing where it is isn't a join");
      await nextTrack(ctx, dec);
      ctx.decoders.last.end();
      await until(() => player(ctx).state === PlayerState.IDLE);
      ctx.api.setVoice({ [LOUNGE]: [BOT], [GAMING]: [USER] });
      await voiceEvent(ctx, 'voice_join', { server_id: SERVER, channel_id: GAMING, user_id: USER });
      await command(ctx, 'play', '3');
      assert.equal(last(ctx).content, paced(20), 'moving to another channel is a join too');
    });
});

describe('Music cog: voice events and unloading', OPTS, () => {
  it('leaves once everyone else has left, saying so before and after', async () => {
    const ctx = await setup();
    const { card } = await startPlaying(ctx, '1');
    ctx.api.setVoice({ [LOUNGE]: [BOT] });
    await voiceEvent(ctx, 'voice_leave', { server_id: SERVER, channel_id: LOUNGE, user_id: USER });
    await ctx.timers.advance(1500);
    await until(() => said(ctx, /^👀/));
    assert.equal(last(ctx).content, "👀 Everyone left 🔊 **Lounge**. I'll leave in 30 s unless someone joins.");
    await ctx.timers.advance(30_000);
    await until(() => said(ctx, /so I left too/));
    assert.equal(last(ctx).content, '👋 Everyone left 🔊 **Lounge**, so I left too.');
    assert.equal(ctx.voice.last.leaveCalls, 1);
    assert.deepEqual(ctx.api.edits.at(-1), { channelId: TEXT, messageId: card.id, components: null });
  });

  it('stays when someone comes back in time', async () => {
    const ctx = await setup();
    await startPlaying(ctx, '1');
    ctx.api.setVoice({ [LOUNGE]: [BOT] });
    await voiceEvent(ctx, 'voice_leave', { server_id: SERVER, channel_id: LOUNGE, user_id: USER });
    await ctx.timers.advance(1500);
    await until(() => said(ctx, /^👀/));
    ctx.api.setVoice({ [LOUNGE]: [BOT, 'user-2'] });
    await voiceEvent(ctx, 'voice_join', { server_id: SERVER, channel_id: LOUNGE, user_id: 'user-2' });
    await ctx.timers.advance(1500);
    await ctx.timers.advance(60_000);
    assert.ok(player(ctx), 'still playing');
    assert.equal(ctx.voice.last.leaveCalls, 0);
    assert.ok(!said(ctx, /so I left too/));
  });

  it('leaves an empty channel even when everyone left while it was still joining', async () => {
    const voice = new FakeVoice({ manual: true, participants: 0 });
    const ctx = await setup({ voice });
    await command(ctx, 'play', 'groovesalad'); // radio: it would never end by itself
    await until(() => voice.pending === 1);
    ctx.api.setVoice({ [LOUNGE]: [BOT], [GAMING]: [] }); // the requester gives up waiting
    await voiceEvent(ctx, 'voice_leave', { server_id: SERVER, channel_id: LOUNGE, user_id: USER });
    await voiceEvent(ctx, 'voice_join', { server_id: SERVER, channel_id: LOUNGE, user_id: BOT });
    await ctx.timers.advance(2000); // the check those events asked for comes while the bot is still joining
    voice.resolve();
    await until(() => ctx.decoders.count === 1);
    ctx.decoders.last.push(1);
    await ctx.timers.advance(1500);
    await until(() => said(ctx, /^👀 Everyone left/));
    await ctx.timers.advance(30_000);
    await until(() => said(ctx, /so I left too/));
    assert.equal(ctx.voice.last.leaveCalls, 1);
  });

  it('looks who is still there once the bot itself arrives (the requester may have left meanwhile)', async () => {
    const ctx = await setup();
    await startPlaying(ctx, '1');
    ctx.api.setVoice({ [LOUNGE]: [BOT] });
    await voiceEvent(ctx, 'voice_join', { server_id: SERVER, channel_id: LOUNGE, user_id: BOT });
    await ctx.timers.advance(1500);
    await until(() => said(ctx, /^👀 Everyone left/));
  });

  it("works before the bot knows its own id (bot.me is null until it's ready), erring on staying", async () => {
    const ctx = await setup();
    ctx.bot.me = null;
    await startPlaying(ctx, '1');
    ctx.api.setVoice({ [LOUNGE]: [BOT] });
    await voiceEvent(ctx, 'voice_leave', { server_id: SERVER, channel_id: LOUNGE, user_id: USER });
    await voiceEvent(ctx, 'voice_leave', { server_id: SERVER, channel_id: GAMING, user_id: BOT });
    await ctx.timers.advance(60_000);
    assert.ok(player(ctx), "the bot can't tell itself from a listener, so it doesn't leave");
    assert.ok(!said(ctx, /^👀/));
  });

  it('ignores voice events in other channels', async () => {
    const ctx = await setup();
    await startPlaying(ctx, '1');
    const lookups = ctx.api.voiceLookups;
    await voiceEvent(ctx, 'voice_leave', { server_id: SERVER, channel_id: GAMING, user_id: 'user-2' });
    await voiceEvent(ctx, 'voice_leave', { server_id: 'server-2', channel_id: LOUNGE, user_id: 'user-2' });
    await ctx.timers.advance(5000);
    assert.equal(ctx.api.voiceLookups, lookups, 'no presence check was needed');
  });

  it('stops when the bot is taken out of its own channel, not for the old half of a move', async () => {
    const ctx = await setup();
    await startPlaying(ctx, '1');
    await voiceEvent(ctx, 'voice_leave', { server_id: SERVER, channel_id: LOUNGE, user_id: BOT });
    assert.ok(player(ctx), 'right after joining it is the previous session leaving');
    await ctx.timers.advance(5000);
    await voiceEvent(ctx, 'voice_leave', { server_id: SERVER, channel_id: GAMING, user_id: BOT });
    await voiceEvent(ctx, 'voice_leave', { server_id: SERVER, user_id: BOT });
    assert.ok(player(ctx), 'another channel, or no channel at all: not ours to act on');
    await voiceEvent(ctx, 'voice_leave', { server_id: SERVER, channel_id: LOUNGE, user_id: BOT });
    assert.equal(player(ctx), undefined);
    await until(() => said(ctx, /disconnected/));
    assert.equal(last(ctx).content, '🔌 I was disconnected from 🔊 **Lounge**. `/play` starts the music again.');
  });

  it('cogUnload stops every player and leaves voice without a goodbye', async () => {
    const ctx = await setup();
    const { card } = await startPlaying(ctx, '1');
    await ctx.bot.unload('Music');
    assert.equal(ctx.voice.last.leaveCalls, 1);
    assert.equal(ctx.music.players.size, 0);
    assert.deepEqual(ctx.api.edits, [{ channelId: TEXT, messageId: card.id, components: null }]);
    assert.equal(ctx.api.posts.length, 1, 'only the card');
    assert.equal(ctx.bot.commands.size, 0);
  });

  it('cogUnload waits briefly for the last cards to lose their buttons', async () => {
    const ctx = await setup();
    const { card } = await startPlaying(ctx, '1');
    ctx.api.holdEdits = true;
    let done = false;
    const unloading = ctx.bot.unload('Music').then(() => { done = true; });
    await flush(20);
    assert.equal(done, false, 'waits for the edit');
    ctx.api.releaseEdits();
    await until(() => done);
    await unloading;
    assert.deepEqual(ctx.api.edits, [{ channelId: TEXT, messageId: card.id, components: null }]);

    const stuck = await setup();
    await startPlaying(stuck, '1');
    stuck.api.holdEdits = true;
    let gaveUp = false;
    const leaving = stuck.bot.unload('Music').then(() => { gaveUp = true; });
    await stuck.timers.advance(1499);
    assert.equal(gaveUp, false);
    await stuck.timers.advance(1);
    await until(() => gaveUp, { message: 'an edit that never finishes must not hold up the shutdown' });
    await leaving;
    stuck.api.releaseEdits();
  });

  it("cogUnload doesn't wait forever for a player that hangs while leaving", async () => {
    const ctx = await setup();
    await startPlaying(ctx, '1');
    ctx.voice.last.hangLeave();
    let done = false;
    const unloading = ctx.bot.unload('Music').then(() => { done = true; });
    await ctx.timers.advance(3999);
    assert.equal(done, false);
    await ctx.timers.advance(1); // 4 s: plenty for a healthy leave, and well inside bot.js's 8 s shutdown
    await until(() => done);
    await unloading;
    await ctx.timers.advance(20_000); // the player's own leave timeout runs out too
    assert.equal(ctx.music.players.size, 0);
  });
});
