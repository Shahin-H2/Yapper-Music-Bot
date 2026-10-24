// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot } from '../yapper.js';
import { getLogLevel, setLogLevel } from '../src/log.js';

// End to end through the real yapper.js Bot: it long-polls a local node:http stand-in for the Yapin’ API, loads
// cogs/ from disk (real config, TrackLibrary, VoiceDirectory, connectVoice and @livekit/rtc-node), and every
// assertion is on a JSON body the SDK sent. Yapin’ refuses the voice join, so LiveKit never connects anywhere.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const POSIX = process.platform !== 'win32';
const SERVER = 'srv-1';
const TEXT = 'text-1';
const COMMANDS = ['clear', 'help', 'loop', 'nowplaying', 'pause', 'ping', 'play', 'queue', 'remove', 'resume',
  'shuffle', 'skip', 'stop', 'tracks', 'volume'];
// Plays the part of ffmpeg and ffprobe (no audio is ever decoded here): a version line, or a probe answer.
const FAKE_FFMPEG = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "-version" ]; then echo "ffmpeg version 0.0-test"; exit 0; fi
done
echo '{"format":{"duration":"0.2","tags":{"title":"Test Tone"}}}'
`;

/** 0.2 s of a 440 Hz tone as a 16-bit mono WAV file. */
function wav(seconds = 0.2, rate = 8000) {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (let i = 0; i < data.length / 2; i++) {
    data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** The bot API routes Music Bot uses, on 127.0.0.1. Requests are recorded (except the event polls). */
class FakeYapin {
  /** @type {{ method: string, path: string, body: any, auth: string|undefined }[]} */
  requests = [];
  /** @type {Map<string, { channel_id: string, user_ids: string[] }[]>} */
  voice = new Map();
  url = '';
  #server = null;
  #events = [];
  #lastId = 0;
  #polls = new Set();
  #ids = 0;

  async start() {
    this.#server = http.createServer((req, res) => {
      this.#route(req, res).catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    });
    await new Promise((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${this.#server.address().port}`;
  }

  async close() {
    for (const answer of [...this.#polls]) answer();
    this.#server.closeAllConnections?.();
    await new Promise((resolve) => this.#server.close(resolve));
  }

  /** Queues an event for the bot's next poll (a waiting poll gets it right away); returns its data. */
  push(type, data) {
    this.#events.push({ id: ++this.#lastId, type, data });
    for (const answer of [...this.#polls]) answer();
    return data;
  }

  /** The first request matching `predicate`, once it has come in. */
  async waitFor(predicate, what, ms = 3000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.requests.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) assert.fail(`${what} never came`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async #route(req, res) {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    const url = new URL(req.url, this.url);
    const route = url.pathname;
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'GET' && route === '/events') return this.#poll(url, send);
    this.requests.push({ method: req.method, path: route, body, auth: req.headers.authorization });
    let m;
    if (req.method === 'GET' && route === '/me') return send(200, { id: 'bot-1', username: 'Music_Bot' });
    if (req.method === 'PUT' && route === '/commands') return send(200, { ok: true });
    if (req.method === 'POST' && (m = /^\/channels\/([^/]+)\/messages$/.exec(route))) {
      return send(200, { message: { id: `bot-msg-${++this.#ids}`, channel_id: m[1], ...body } });
    }
    if (req.method === 'PATCH' && (m = /^\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(route))) {
      return send(200, { message: { id: m[2], channel_id: m[1], ...body } });
    }
    if (req.method === 'GET' && (m = /^\/channels\/([^/]+)$/.exec(route))) {
      return send(200, { channel: { id: m[1], name: 'Lounge', type: 'voice' } });
    }
    if (req.method === 'GET' && (m = /^\/servers\/([^/]+)\/voice$/.exec(route))) {
      return send(200, { voice: this.voice.get(m[1]) ?? [] });
    }
    if (req.method === 'POST' && /^\/servers\/[^/]+\/voice\/join$/.test(route)) {
      return send(403, { error: 'Missing permission: Connect' });
    }
    if (req.method === 'POST' && /^\/servers\/[^/]+\/voice\/leave$/.test(route)) return send(200, { ok: true });
    if (req.method === 'POST' && /^\/interactions\/[^/]+\/[^/]+\/callback$/.test(route)) return send(200, {});
    return send(404, { error: `no route for ${req.method} ${route}` });
  }

  #poll(url, send) {
    const after = Number(url.searchParams.get('after')) || 0;
    const answer = () => send(200, { events: this.#events.filter((e) => e.id > after), last: this.#lastId });
    if (url.searchParams.get('wait') === '0' || this.#events.some((e) => e.id > after)) return answer();
    // A long poll: answered as soon as an event comes in, or after ~50 ms without one.
    const done = () => {
      clearTimeout(timer);
      this.#polls.delete(done);
      answer();
    };
    const timer = setTimeout(done, 50);
    this.#polls.add(done);
    return undefined;
  }
}

describe('the real yapper.js Bot running cogs/, against a fake Yapin’ API', { timeout: 15000 }, () => {
  const api = new FakeYapin();
  const errors = [];
  const savedEnv = {};
  const savedLevel = getLogLevel();
  let tmp;
  let bot;
  let running;
  let seq = 0;

  /** `/name args` typed in the text channel by user-1; returns the message event's data. */
  const type = (name, args = '', { command = true } = {}) => api.push('message', {
    id: `user-msg-${++seq}`, channel_id: TEXT, server_id: SERVER, author_id: 'user-1',
    content: `/${name}${args ? ` ${args}` : ''}`, ...(command ? { command: name, args } : {}),
  });
  const replyTo = (msg) => api.waitFor((r) => r.method === 'POST' && r.path === `/channels/${TEXT}/messages`
    && r.body?.reply_to === msg.id, `the reply to ${msg.content}`);

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'music-bot-'));
    const musicDir = path.join(tmp, 'music');
    fs.mkdirSync(musicDir);
    fs.writeFileSync(path.join(musicDir, 'test_tone.wav'), wav());
    const stationsFile = path.join(tmp, 'stations.json');
    fs.writeFileSync(stationsFile, JSON.stringify([{ id: 'testradio', name: 'Test Radio',
      url: 'https://radio.example/live.mp3' }]));
    const fake = path.join(tmp, 'fake-ffmpeg');
    fs.writeFileSync(fake, FAKE_FFMPEG, { mode: 0o755 });
    // cogs/music.js reads its settings from the environment when the SDK makes it, so set them before loading.
    const env = { MUSIC_DIR: musicDir, STATIONS_FILE: stationsFile, FFMPEG_PATH: POSIX ? fake : undefined,
      FFPROBE_PATH: POSIX ? fake : undefined, ALLOW_URLS: undefined, REQUIRE_SAME_VOICE: undefined,
      DEFAULT_VOLUME: undefined, MAX_QUEUE_SIZE: undefined, EMBED_COLOR: undefined };
    for (const [key, value] of Object.entries(env)) {
      savedEnv[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setLogLevel('error'); // the cog's info/warn lines (e.g. the refused join) would only clutter the test output
    await api.start();
    bot = new Bot('yb_test', { base: api.url, gateway: false, log: false });
    bot.on('error', (err) => { errors.push(err); });
    const ready = new Promise((resolve) => { bot.on('ready', resolve); });
    assert.deepEqual(await bot.loadCogs(path.join(ROOT, 'cogs')), ['music']);
    running = bot.start();
    await ready;
  });

  after(async () => {
    if (bot?.running) bot.stop();
    if (bot?.cogs.has('music')) await bot.unload('music');
    await running;
    await api.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setLogLevel(savedLevel);
  });

  it('registers the music commands once, with valid names and short descriptions', () => {
    const puts = api.requests.filter((r) => r.method === 'PUT' && r.path === '/commands');
    assert.equal(puts.length, 1);
    assert.equal(puts[0].auth, 'Bot yb_test');
    const { commands } = puts[0].body;
    assert.deepEqual(commands.map((c) => c.name).sort(), COMMANDS);
    for (const c of commands) {
      assert.match(c.name, /^[a-z0-9_-]{1,32}$/);
      assert.ok(typeof c.description === 'string' && c.description.length > 0 && c.description.length <= 100,
        `/${c.name}`);
    }
  });

  it('/ping (typed, parsed by the SDK) answers with the round trip', async () => {
    const msg = type('ping', '', { command: false });
    const reply = await replyTo(msg);
    assert.match(reply.body.content, /^🏓 Pong! Yapin’ answered in \*\*\d+ ms\*\*\.$/);
  });

  it('/tracks lists the generated file and the station', async () => {
    const reply = await replyTo(type('tracks'));
    const [embed] = reply.body.embeds;
    assert.equal(embed.title, '🎵 Music library');
    assert.equal(embed.description, '**1.** test tone');
    assert.deepEqual(embed.fields, [{ name: '📻 Radio stations', value: '`testradio` — Test Radio', inline: false }]);
    assert.equal(typeof embed.color, 'number');
  });

  it('/queue says the queue is empty', async () => {
    const reply = await replyTo(type('queue'));
    assert.match(reply.body.embeds[0].description, /^The queue is empty\./);
  });

  it("/play asks the caller to join a voice channel when they aren't in one", async () => {
    api.voice.set(SERVER, [{ channel_id: 'vc-1', user_ids: [] }]);
    const reply = await replyTo(type('play', 'test tone'));
    assert.equal(reply.body.content, '🎧 Join a voice channel first, then try `/play` again.');
    assert.ok(!api.requests.some((r) => r.path.endsWith('/voice/join')), 'no join was tried');
  });

  it('/play answers a voice join that Yapin’ refuses with a friendly error',
    { skip: !POSIX && 'the stand-in ffmpeg needs a POSIX shell' }, async () => {
      api.voice.set(SERVER, [{ channel_id: 'vc-1', user_ids: ['user-1'] }]);
      // They joined voice since the last test (which remembers them as outside it): Yapin’ says so with an event.
      api.push('voice_join', { server_id: SERVER, channel_id: 'vc-1', user_id: 'user-1' });
      const msg = type('play', 'test tone');
      const join = await api.waitFor((r) => r.path === `/servers/${SERVER}/voice/join`, 'the voice join');
      assert.deepEqual(join.body, { channel_id: 'vc-1' });
      const reply = await replyTo(msg);
      assert.match(reply.body.content, /^❌ I couldn't join .+: I don't have permission to join that voice channel\.$/);
      await api.waitFor((r) => r.path === `/servers/${SERVER}/voice/leave`, 'the clean-up leave');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const posts = api.requests.filter((r) => r.method === 'POST' && r.path === `/channels/${TEXT}/messages`);
      assert.equal(posts.at(-1), reply, 'said once');
    });

  it('a click on a stale Now Playing card takes its buttons off', async () => {
    api.push('interaction', { id: 'int-1', token: 'tok-1', custom_id: `music:skip:${SERVER}`, user_id: 'user-1',
      username: 'alice', message_id: 'card-from-before', channel_id: TEXT });
    const answer = await api.waitFor((r) => r.path === '/interactions/int-1/tok-1/callback', 'the click answer');
    assert.deepEqual(answer.body, { type: 'update', components: null });
  });

  it('stops and unloads without sending Yapin’ an empty command list', async () => {
    bot.stop();
    await bot.unload('music');
    await running;
    assert.equal(api.requests.filter((r) => r.method === 'PUT' && r.path === '/commands').length, 1);
    assert.deepEqual(errors, []);
  });
});

describe('bot.js', () => {
  it('exits with 1 and says what to do when YAPPER_BOT_TOKEN is missing, before any network call', () => {
    // An empty token wins over any .env, and without NODE_OPTIONS nothing adds --env-file: this never reaches Yapin’.
    const env = { ...process.env, YAPPER_BOT_TOKEN: '' };
    delete env.NODE_OPTIONS;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'music-bot-'));
    try {
      const run = spawnSync(process.execPath, [path.join(ROOT, 'bot.js')],
        { cwd, env, encoding: 'utf8', timeout: 10000 });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /YAPPER_BOT_TOKEN isn't set\. Copy \.env\.example to \.env/);
      assert.equal(run.stdout, '');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
