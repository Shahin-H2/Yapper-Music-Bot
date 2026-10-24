// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { FRAME_BYTES, FRAME_SAMPLES, readFrames } from '../src/audio.js';
import {
  FfmpegStartError, STDERR_LIMIT, USER_AGENT, buildFfmpegArgs, checkFfmpeg, isLastingFfmpegError, probeFile,
  spawnDecoder, summarizeFfmpegError,
} from '../src/ffmpeg.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const POSIX = process.platform !== 'win32';
const ffmpeg = await checkFfmpeg(FFMPEG);
const hasFfprobe = (() => {
  try {
    execFileSync(FFPROBE, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const fileTrack = (input) => ({ kind: 'file', live: false, title: 'test', input, source: 'local', duration: null });
const OUTPUT = ['-vn', '-sn', '-dn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];
const NOT_FOUND = (bin) => `ffmpeg not found at "${bin}" — install ffmpeg or set FFMPEG_PATH`;

/** Whether a promise has settled, without waiting for it. */
async function settled(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

/**
 * Stands in for child_process.spawn: records calls and returns EventEmitter children with real pipes.
 * `started: false` is a child whose spawn failed (Node leaves its pid undefined).
 */
function fakeSpawn({ started = true, stdout = true } = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      pid: started ? 4242 : undefined,
      stdout: stdout ? new PassThrough() : null,
      stderr: new PassThrough(),
      signals: [],
    });
    child.kill = (signal) => { child.signals.push(signal); return true; };
    calls.push({ file, args, options, child });
    return child;
  };
  return { spawn, calls };
}

async function collect(stream) {
  const frames = [];
  for await (const frame of readFrames(stream)) frames.push(frame);
  return frames;
}

describe('buildFfmpegArgs', () => {
  test('a file: only the file protocol, opened as file:<absolute path>', () => {
    assert.deepEqual(buildFfmpegArgs(fileTrack('/music/My Song.mp3')), [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-protocol_whitelist', 'file', '-i', 'file:/music/My Song.mp3',
      ...OUTPUT,
    ]);
  });

  test('a stream: http(s) protocols only, reconnects, a read timeout and our user agent', () => {
    const url = 'https://ice2.somafm.com/groovesalad-128-mp3';
    assert.equal(USER_AGENT, 'music-bot/1.0');
    assert.deepEqual(buildFfmpegArgs({ kind: 'stream', live: true, input: url }), [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-protocol_whitelist', 'http,https,tcp,tls,crypto',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5',
      '-rw_timeout', '15000000', '-user_agent', 'music-bot/1.0',
      '-i', url,
      ...OUTPUT,
    ]);
  });

  test('a file name that looks like a protocol stays a plain file name', () => {
    const args = buildFfmpegArgs(fileTrack('/music/concat:weird #1.mp3'));
    assert.deepEqual(args.slice(4, 8), ['-protocol_whitelist', 'file', '-i', 'file:/music/concat:weird #1.mp3']);
  });

  test('stream URLs are passed on normalized', () => {
    const input = (track) => buildFfmpegArgs(track).at(-OUTPUT.length - 1);
    assert.equal(input({ kind: 'stream', input: 'HTTP://Radio.Example/live stream.mp3' }),
      'http://radio.example/live%20stream.mp3');
    assert.equal(input({ kind: 'stream', input: 'http://radio.example' }), 'http://radio.example/');
  });

  test('a file must be an absolute path', () => {
    for (const input of ['music/a.mp3', './a.mp3', '../a.mp3', 'a.mp3', 'file:/a.mp3', 'concat:/a.mp3|/b.mp3']) {
      assert.throws(() => buildFfmpegArgs(fileTrack(input)), TypeError, input);
    }
  });

  test('a stream must be an http(s) URL', () => {
    const bad = ['ftp://radio.example/a.mp3', 'file:///etc/passwd', 'javascript:alert(1)', 'rtmp://radio.example/live',
      'concat:a|b', 'not a url', 'https://', '/music/a.mp3', 'data:audio/mp3;base64,AAAA'];
    for (const input of bad) assert.throws(() => buildFfmpegArgs({ kind: 'stream', input }), TypeError, input);
  });

  test('anything else is a TypeError', () => {
    const bad = [null, undefined, 'a.mp3', {}, { kind: 'file' }, { kind: 'file', input: '' },
      { kind: 'file', input: 42 }, { kind: 'file', input: '/a\0b.mp3' }, { kind: 'video', input: '/a.mp4' },
      { input: '/a.mp3' }];
    for (const track of bad) assert.throws(() => buildFfmpegArgs(track), TypeError);
  });
});

describe('spawnDecoder (fake spawn)', () => {
  const track = fileTrack('/music/a.mp3');

  test('spawns ffmpegPath with the built args: stdin ignored, stdout and stderr piped', () => {
    const { spawn, calls } = fakeSpawn();
    const dec = spawnDecoder(track, { ffmpegPath: '/opt/ffmpeg', spawn });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, '/opt/ffmpeg');
    assert.deepEqual(calls[0].args, buildFfmpegArgs(track));
    assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(dec.stdout, calls[0].child.stdout);
    assert.equal(dec.pid, 4242);
    assert.equal(dec.killed, false);
  });

  test('done resolves on close (after the pipes flushed), not on exit', async () => {
    const { spawn, calls } = fakeSpawn();
    const dec = spawnDecoder(track, { spawn });
    const { child } = calls[0];
    child.emit('spawn');
    child.stderr.write('[mp3float @ 0x1] Header missing\n');
    child.emit('exit', 0, null);
    assert.equal(await settled(dec.done), false);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
    assert.deepEqual(await dec.done,
      { code: 0, signal: null, stderr: '[mp3float @ 0x1] Header missing\n', error: null });
  });

  test('ENOENT resolves done with the friendly error and never rejects', async () => {
    const { spawn, calls } = fakeSpawn({ started: false });
    const dec = spawnDecoder(track, { ffmpegPath: '/nope/ffmpeg', spawn });
    const { child } = calls[0];
    const enoent = Object.assign(new Error('spawn /nope/ffmpeg ENOENT'),
      { code: 'ENOENT', errno: -2, syscall: 'spawn /nope/ffmpeg' });
    child.emit('error', enoent);
    child.stdout.end(); // as Node does after a failed spawn
    const res = await dec.done;
    assert.equal(res.error.message, NOT_FOUND('/nope/ffmpeg'));
    assert.ok(res.error instanceof FfmpegStartError, 'recognizable, so its path can be kept out of chat');
    assert.equal(res.error.name, 'FfmpegStartError');
    assert.equal(res.error.code, 'ENOENT');
    assert.equal(res.error.cause, enoent);
    assert.equal(res.code, null);
    assert.equal(res.signal, null);
    assert.equal(dec.pid, undefined);
    assert.deepEqual(await collect(dec.stdout), []);
    child.emit('close', -2, null); // Node's late close with a negative errno changes nothing
    assert.equal((await dec.done).code, null);
  });

  test('EACCES gets its own hint', async () => {
    const { spawn, calls } = fakeSpawn({ started: false });
    const dec = spawnDecoder(track, { ffmpegPath: '/usr/local', spawn });
    calls[0].child.emit('error', Object.assign(new Error('spawn /usr/local EACCES'), { code: 'EACCES' }));
    const { error } = await dec.done;
    assert.match(error.message, /^ffmpeg at "\/usr\/local" can't be run \(permission denied\)/);
    assert.ok(error instanceof FfmpegStartError);
    assert.equal(error.code, 'EACCES');
  });

  test('an error after a successful spawn is kept, but done still waits for close', async () => {
    const { spawn, calls } = fakeSpawn();
    const dec = spawnDecoder(track, { spawn });
    const { child } = calls[0];
    child.emit('spawn');
    child.emit('error', new Error('kill EPERM'));
    assert.equal(await settled(dec.done), false);
    child.emit('close', null, 'SIGKILL');
    const res = await dec.done;
    assert.equal(res.error.message, 'kill EPERM');
    assert.equal(res.signal, 'SIGKILL');
  });

  test('keeps only the last ~4 KB of stderr', async () => {
    const { spawn, calls } = fakeSpawn();
    const dec = spawnDecoder(track, { spawn });
    const { child } = calls[0];
    for (let i = 0; i < 10; i++) child.stderr.write(String(i).repeat(1000));
    child.stderr.write('\nError opening input files: No such file or directory\n');
    child.stderr.end();
    await finished(child.stderr);
    child.emit('close', 254, null);
    const { stderr, code } = await dec.done;
    assert.equal(STDERR_LIMIT, 4096);
    assert.equal(stderr.length, STDERR_LIMIT);
    assert.ok(stderr.endsWith('Error opening input files: No such file or directory\n'));
    assert.ok(!/[0-4]/.test(stderr), 'the oldest output is dropped'); // the tail holds the last 42 '5's onwards
    assert.ok(stderr.includes('6'.repeat(1000)) && stderr.includes('9'.repeat(1000)));
    assert.equal(summarizeFfmpegError(stderr, code), 'No such file or directory');
  });

  test('decodes UTF-8 split across stderr chunks', async () => {
    const { spawn, calls } = fakeSpawn();
    const dec = spawnDecoder(track, { spawn });
    const { child } = calls[0];
    child.stderr.write(Buffer.from([0xc3]));
    child.stderr.end(Buffer.from([0xa9, 0x0a]));
    await finished(child.stderr);
    child.emit('close', 1, null);
    assert.equal((await dec.done).stderr, 'é\n');
  });

  test('kill() is idempotent: one SIGKILL, stdout destroyed', async () => {
    const { spawn, calls } = fakeSpawn();
    const dec = spawnDecoder(track, { spawn });
    const { child } = calls[0];
    dec.kill();
    dec.kill();
    dec.kill();
    assert.deepEqual(child.signals, ['SIGKILL']);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(dec.killed, true);
    child.emit('close', null, 'SIGKILL');
    assert.deepEqual(await dec.done, { code: null, signal: 'SIGKILL', stderr: '', error: null });
  });

  test('kill() never throws, even when child.kill does', () => {
    const { spawn, calls } = fakeSpawn();
    const dec = spawnDecoder(track, { spawn });
    calls[0].child.kill = () => { throw new Error('ESRCH'); };
    assert.doesNotThrow(() => dec.kill());
    assert.equal(calls[0].child.stdout.destroyed, true);
  });

  test('kill() while a for-await is reading: it rejects with ERR_STREAM_PREMATURE_CLOSE', async () => {
    const { spawn, calls } = fakeSpawn();
    const dec = spawnDecoder(track, { spawn });
    const frames = [];
    const reading = (async () => { for await (const frame of readFrames(dec.stdout)) frames.push(frame); })();
    calls[0].child.stdout.write(Buffer.alloc(FRAME_BYTES + 10));
    await delay(5);
    dec.kill();
    await assert.rejects(reading, { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    assert.equal(frames.length, 1);
  });

  test('a spawn that throws gives an empty stdout and done carrying the error', async () => {
    const e2big = Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' });
    const dec = spawnDecoder(track, { spawn: () => { throw e2big; } });
    const res = await dec.done;
    assert.equal(res.error.message, 'Couldn\'t start ffmpeg at "ffmpeg": spawn E2BIG');
    assert.equal(res.error.code, 'E2BIG');
    assert.equal(res.error.cause, e2big);
    assert.deepEqual(await collect(dec.stdout), []);
    assert.equal(dec.pid, undefined);
    dec.kill();
    assert.equal(dec.killed, true);
  });

  test('an invalid track never spawns: done carries the TypeError', async () => {
    const bad = [fileTrack('music/a.mp3'), { kind: 'stream', input: 'ftp://radio.example/a' },
      { kind: 'midi', input: '/a' }, null];
    for (const t of bad) {
      const { spawn, calls } = fakeSpawn();
      const dec = spawnDecoder(t, { spawn });
      assert.equal(calls.length, 0);
      const res = await dec.done;
      assert.ok(res.error instanceof TypeError);
      assert.deepEqual(await collect(dec.stdout), []);
    }
  });

  test('a child without a stdout pipe (EMFILE) still gives a readable that ends', async () => {
    const { spawn, calls } = fakeSpawn({ started: false, stdout: false });
    const dec = spawnDecoder(track, { spawn });
    calls[0].child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' }));
    assert.deepEqual(await collect(dec.stdout), []);
    assert.equal((await dec.done).error.code, 'EMFILE');
  });
});

describe('spawnDecoder (real spawn, no ffmpeg needed)', () => {
  test('a missing binary resolves done with the friendly error', async () => {
    const dec = spawnDecoder(fileTrack('/music/a.wav'), { ffmpegPath: '/nonexistent/ffmpeg' });
    assert.deepEqual(await collect(dec.stdout), []);
    const res = await dec.done;
    assert.equal(res.error.message, NOT_FOUND('/nonexistent/ffmpeg'));
    assert.equal(res.code, null);
  });
});

describe('summarizeFfmpegError', () => {
  // Real ffmpeg 9 output (paths anonymized).
  const MISSING = [
    '[in#0 @ 0x9bb024000] Error opening input: No such file or directory',
    'Error opening input file file:/Users/someone/music/gone.mp3.',
    'Error opening input files: No such file or directory', ''].join('\n');
  const NOT_AUDIO = [
    '[in#0 @ 0xc7d018000] Failed to find two consecutive MPEG audio frames.',
    '[in#0 @ 0xc7cc14000] Error opening input: Invalid data found when processing input',
    'Error opening input file file:/Users/someone/music/fake.mp3.',
    'Error opening input files: Invalid data found when processing input', ''].join('\n');
  const NO_AUDIO_STREAM = [
    '[out#0/s16le @ 0xc00c5c240] Output file does not contain any stream',
    'Error opening output file pipe:1.',
    'Error opening output files: Invalid argument', ''].join('\n');
  const NOT_WHITELISTED = [
    "[file @ 0x88f02c000] Protocol 'file' not on whitelist 'http,https,tcp,tls,crypto'!",
    '[in#0 @ 0x88f024000] Error opening input: Invalid argument',
    'Error opening input file file:/Users/someone/music/a.wav.',
    'Error opening input files: Invalid argument', ''].join('\n');
  const HTTP_404 = [
    '[https @ 0x12a704080] HTTP error 404 Not Found',
    '[in#0 @ 0x12a604000] Error opening input: Server returned 404 Not Found',
    'Error opening input file https://radio.example/missing.mp3.',
    'Error opening input files: Server returned 404 Not Found', ''].join('\n');
  const OLD_STYLE = 'file:/home/someone/My Music/live: at home.mp3: No such file or directory\n';
  // A stream link that redirects to a protocol outside the whitelist (ffmpeg 9.0.2, local test server).
  const REDIRECTED = [
    "[http @ 0x92f024000] Protocol 'rtmp' not on whitelist 'http,https,tcp,tls,crypto'!",
    '    Last message repeated 3 times',
    '[in#0 @ 0x92f01c000] Error opening input: Invalid argument',
    'Error opening input file http://127.0.0.1:54933/rtmp.',
    'Error opening input files: Invalid argument', ''].join('\n');
  const REFUSED = [
    '[tcp @ 0x74b010380] Connection to tcp://127.0.0.1:9 failed: Connection refused',
    '    Last message repeated 3 times',
    '[in#0 @ 0x74b024000] Error opening input: Connection refused',
    'Error opening input file http://127.0.0.1:9/x.',
    'Error opening input files: Connection refused', ''].join('\n');
  const WEB_PAGE = [
    '[in#0 @ 0x885024000] Error opening input: Input/output error',
    'Error opening input file http://127.0.0.1:54933/html.',
    'Error opening input files: Input/output error', ''].join('\n');
  const HTTP = (status) => [
    `[in#0 @ 0x8aac0c000] Error opening input: Server returned ${status}`,
    'Error opening input file http://127.0.0.1:54933/s.',
    `Error opening input files: Server returned ${status}`, ''].join('\n');

  test('picks the reason, without log prefixes, wrappers or local paths', () => {
    const cases = [
      [MISSING, 'No such file or directory'],
      [NOT_AUDIO, 'Invalid data found when processing input'],
      [NO_AUDIO_STREAM, 'No audio stream found'],
      [NOT_WHITELISTED, "Protocol 'file' not on whitelist 'http,https,tcp,tls,crypto'!"],
      [HTTP_404, 'Server returned 404 Not Found'],
      [OLD_STYLE, 'No such file or directory'],
      ['C:\\Music\\song.mp3: Permission denied\n', 'Permission denied'],
      ['[aist#0:0/mp3 @ 0x1] Decoding error: Invalid data found when processing input\nConversion failed!\n',
        'Decoding error: Invalid data found when processing input'],
    ];
    for (const [stderr, want] of cases) {
      const got = summarizeFfmpegError(stderr, 1);
      assert.equal(got, want);
      assert.ok(!got.includes('someone'), 'no local paths');
    }
  });

  test('looks past "Last message repeated N times" to the line it repeats', () => {
    assert.equal(summarizeFfmpegError(REDIRECTED, 234),
      "Protocol 'rtmp' not on whitelist 'http,https,tcp,tls,crypto'!");
    assert.equal(summarizeFfmpegError(REFUSED, 195), 'Connection refused');
    assert.equal(summarizeFfmpegError('Something broke\n    Last message repeated 1 times\n', 1), 'Something broke');
    assert.equal(summarizeFfmpegError('    Last message repeated 3 times\n', 1), 'ffmpeg exited with code 1');
  });

  test('isLastingFfmpegError: what no retry changes (before any audio), and what one might', () => {
    const lasting = [HTTP_404, HTTP('400 Bad Request'), HTTP('401 Unauthorized (authorization failed)'),
      HTTP('403 Forbidden (access denied)'), HTTP('4XX Client Error, but not one of 40{0,1,3,4}'), WEB_PAGE,
      NOT_AUDIO, NO_AUDIO_STREAM, NOT_WHITELISTED, REDIRECTED];
    const passing = [REFUSED, HTTP('5XX Server Error reply'), HTTP('429 Too Many Requests'),
      HTTP('408 Request Timeout'), 'Connection timed out\n', '[http @ 0x1] Error reading HTTP response: End of file\n',
      '', null, undefined];
    for (const stderr of lasting) assert.equal(isLastingFfmpegError(stderr), true, stderr);
    for (const stderr of passing) assert.equal(isLastingFfmpegError(stderr), false, String(stderr));
  });

  test('handles CRLF, bare CR and colour codes', () => {
    const crlf = 'warning\r\nError opening input files: Connection refused\r\n';
    assert.equal(summarizeFfmpegError(crlf, 1), 'Connection refused');
    assert.equal(summarizeFfmpegError('first\rsecond line\r', 1), 'second line');
    assert.equal(summarizeFfmpegError('\x1b[0;31mSomething broke\x1b[0m\n', 1), 'Something broke');
  });

  test('stays at most 200 characters, without splitting an emoji', () => {
    const long = summarizeFfmpegError('x'.repeat(500), 1);
    assert.equal(long.length, 200);
    assert.ok(long.endsWith('…'));
    const emoji = summarizeFfmpegError(`a${'😀'.repeat(150)}`, 1);
    assert.ok(emoji.length <= 200);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji), 'no lone high surrogate');
  });

  test('falls back to the exit code when stderr says nothing useful', () => {
    assert.equal(summarizeFfmpegError('', 1), 'ffmpeg exited with code 1');
    assert.equal(summarizeFfmpegError('\n  \n', 183), 'ffmpeg exited with code 183');
    assert.equal(summarizeFfmpegError('Conversion failed!\n', 1), 'ffmpeg exited with code 1');
    assert.equal(summarizeFfmpegError(null, 0), 'ffmpeg produced no audio');
    assert.equal(summarizeFfmpegError(undefined, null), 'ffmpeg stopped unexpectedly');
  });
});

describe('checkFfmpeg and probeFile without ffmpeg', () => {
  const NONE = { duration: null, title: null, artist: null };

  test('checkFfmpeg: a missing binary is ok:false with the friendly message', async () => {
    const res = await checkFfmpeg('/nonexistent/ffmpeg');
    assert.equal(res.ok, false);
    assert.equal(res.version, null);
    assert.equal(res.error.message, NOT_FOUND('/nonexistent/ffmpeg'));
    assert.equal(res.error.code, 'ENOENT');
  });

  test('checkFfmpeg: a program that is not ffmpeg is ok:false', async () => {
    const res = await checkFfmpeg(process.execPath); // node rejects -hide_banner
    assert.equal(res.ok, false);
    assert.match(res.error.message, /failed/);
  });

  test('probeFile: nulls for a bad ffprobe path or a bad file argument', async () => {
    assert.deepEqual(await probeFile('/music/a.mp3', { ffprobePath: '/nonexistent/ffprobe' }), NONE);
    for (const bad of [null, undefined, '', 42, '/a\0b.mp3']) assert.deepEqual(await probeFile(bad), NONE);
  });

  // One shell script stands in for ffmpeg/ffprobe; its environment says what to print, how to exit, or to hang.
  // (One file on purpose: the OS vets every new executable on its first run, which can take ~0.5 s.)
  describe('with a fake binary', { skip: !POSIX && 'needs a POSIX shell', timeout: 20_000 }, () => {
    let dir;
    let fake;
    const KEYS = ['MUSIC_BOT_FAKE_OUT', 'MUSIC_BOT_FAKE_EXIT', 'MUSIC_BOT_FAKE_SLEEP', 'MUSIC_BOT_FAKE_ARGS'];
    /** Runs fn while the fake behaves as `env` says (execFile hands children process.env). */
    const as = async (env, fn) => {
      const saved = KEYS.map((k) => process.env[k]);
      Object.assign(process.env, env);
      try {
        return await fn();
      } finally {
        KEYS.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
      }
    };
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-bot-'));
      fake = path.join(dir, 'fake-ffmpeg');
      fs.writeFileSync(fake, [
        '#!/bin/sh',
        'if [ -n "$MUSIC_BOT_FAKE_ARGS" ]; then printf \'%s\\n\' "$@" > "$MUSIC_BOT_FAKE_ARGS"; fi',
        'if [ -n "$MUSIC_BOT_FAKE_SLEEP" ]; then exec sleep "$MUSIC_BOT_FAKE_SLEEP"; fi', // exec: SIGKILL must hit sleep itself
        'printf \'%s\\n\' "$MUSIC_BOT_FAKE_OUT"',
        'exit "${MUSIC_BOT_FAKE_EXIT:-0}"', ''].join('\n'), { mode: 0o755 });
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('checkFfmpeg parses the version line', async () => {
      const out = 'ffmpeg version 1.2.3-test Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with clang';
      const res = await as({ MUSIC_BOT_FAKE_OUT: out }, () => checkFfmpeg(fake));
      assert.deepEqual(res, { ok: true, version: '1.2.3-test', error: null });
    });

    test('checkFfmpeg rejects a program without the version line', async () => {
      const res = await as({ MUSIC_BOT_FAKE_OUT: 'hello' }, () => checkFfmpeg(fake));
      assert.equal(res.ok, false);
      assert.match(res.error.message, /doesn't look like ffmpeg/);
    });

    test('checkFfmpeg reports a failing ffmpeg with its exit code', async () => {
      const res = await as({ MUSIC_BOT_FAKE_OUT: 'ffmpeg version 9', MUSIC_BOT_FAKE_EXIT: '3' }, () => checkFfmpeg(fake));
      assert.equal(res.ok, false);
      assert.equal(res.error.message, `ffmpeg at "${fake}" failed: ffmpeg exited with code 3`);
    });

    test('checkFfmpeg gives up after timeoutMs', async () => {
      const started = Date.now();
      const res = await as({ MUSIC_BOT_FAKE_SLEEP: '5' }, () => checkFfmpeg(fake, { timeoutMs: 100 }));
      assert.equal(res.ok, false);
      assert.match(res.error.message, /didn't answer within 100 ms/);
      assert.ok(Date.now() - started < 2000);
    });

    test('checkFfmpeg: a directory is not runnable', async () => {
      const res = await checkFfmpeg(dir);
      assert.equal(res.ok, false);
      assert.match(res.error.message, /permission denied/);
    });

    test('probeFile: the ffprobe command line, and tags read case-insensitively from format or stream', async () => {
      const argsFile = path.join(dir, 'args.txt');
      const out = JSON.stringify({
        streams: [{ tags: { TITLE: 'Stream Title', ARTIST: ' Stream\tArtist\u0007 ' } }],
        format: { duration: '12.500000', tags: { title: '  Format\n Title  ' } },
      });
      const env = { MUSIC_BOT_FAKE_OUT: out, MUSIC_BOT_FAKE_ARGS: argsFile };
      const probe = (file) => as(env, () => probeFile(file, { ffprobePath: fake }));
      const argv = () => fs.readFileSync(argsFile, 'utf8').trimEnd().split('\n');
      const res = await probe('/music/x.flac');
      assert.deepEqual(res, { duration: 12.5, title: 'Format Title', artist: 'Stream Artist' });
      assert.deepEqual(argv(), [
        '-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'a:0',
        '-show_entries', 'format=duration:format_tags=title,artist:stream_tags=title,artist', '-of', 'json',
        'file:/music/x.flac',
      ]);
      await probe('music/x.flac'); // a relative path resolves against the working directory
      assert.equal(argv().at(-1), `file:${path.resolve('music/x.flac')}`);
    });

    test('probeFile: nulls for output that is not JSON, an N/A duration with blank tags, or a failure', async () => {
      const probe = (env) => as(env, () => probeFile('/a.mp3', { ffprobePath: fake }));
      assert.deepEqual(await probe({ MUSIC_BOT_FAKE_OUT: 'not json' }), NONE);
      const na = '{"format":{"duration":"N/A","tags":{"title":"   "}},"streams":[]}';
      assert.deepEqual(await probe({ MUSIC_BOT_FAKE_OUT: na }), NONE);
      assert.deepEqual(await probe({ MUSIC_BOT_FAKE_OUT: '{"format":{"duration":"3.0"}}', MUSIC_BOT_FAKE_EXIT: '1' }), NONE);
      assert.deepEqual(await probe({ MUSIC_BOT_FAKE_OUT: '{"format":{"duration":"3.0"}}' }), { ...NONE, duration: 3 });
    });

    test('probeFile: nulls after timeoutMs', async () => {
      const started = Date.now();
      const res = await as({ MUSIC_BOT_FAKE_SLEEP: '5' }, () => probeFile('/a.mp3', { ffprobePath: fake, timeoutMs: 100 }));
      assert.deepEqual(res, NONE);
      assert.ok(Date.now() - started < 2000);
    });
  });
});

// A timeout so a regression (say, a decoder that never settles) fails instead of hanging the run.
describe('with real ffmpeg', { timeout: 20_000 }, () => {
  let dir;
  const fx = {};
  const skipUnless = (t, needProbe = false) => {
    if (!ffmpeg.ok) t.skip(`ffmpeg not available: ${ffmpeg.error?.message}`);
    else if (needProbe && !hasFfprobe) t.skip('ffprobe not available');
    else return false;
    return true;
  };
  const decode = async (input) => {
    const dec = spawnDecoder(fileTrack(input), { ffmpegPath: FFMPEG });
    const frames = await collect(dec.stdout);
    return { frames, res: await dec.done };
  };
  const assertFrame = (frame) => {
    assert.ok(frame instanceof Int16Array);
    assert.equal(frame.length, FRAME_SAMPLES);
    assert.equal(frame.byteOffset, 0);
    assert.equal(frame.buffer.byteLength, FRAME_BYTES);
  };
  const peak = (frames) => frames.reduce((max, f) => f.reduce((m, s) => Math.max(m, Math.abs(s)), max), 0);

  before(() => {
    if (!ffmpeg.ok) return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-bot-'));
    const make = (name, seconds, extra = []) => {
      const file = path.join(dir, name);
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi',
        '-i', `sine=frequency=440:duration=${seconds}`, ...extra, file]);
      return file;
    };
    fx.wav = make('tone.wav', 1);
    fx.flac = make('tone.flac', 1);
    fx.ten = make('ten.wav', 10);
    fx.tagged = make('tagged.flac', 1, ['-metadata', 'title=Test Tone', '-metadata', 'artist=Music Bot']);
    if (POSIX) { // ':' isn't allowed in Windows file names
      fx.weird = path.join(dir, 'concat:weird #1.wav');
      fs.copyFileSync(fx.wav, fx.weird);
    }
  });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('checkFfmpeg reports the version', async (t) => {
    if (skipUnless(t)) return;
    assert.equal(ffmpeg.ok, true);
    assert.match(ffmpeg.version, /\S/);
    assert.equal(ffmpeg.error, null);
  });

  test('1 s of WAV and FLAC decode to exactly 100 frames of real audio', async (t) => {
    if (skipUnless(t)) return;
    for (const file of [fx.wav, fx.flac]) {
      const { frames, res } = await decode(file);
      assert.equal(frames.length, 100, path.basename(file));
      assert.deepEqual(res, { code: 0, signal: null, stderr: '', error: null });
      frames.forEach(assertFrame);
      assert.ok(peak(frames) > 1000, 'a 440 Hz tone, not silence');
    }
  });

  test('a file named concat:weird #1.wav plays as a plain file', async (t) => {
    if (skipUnless(t)) return;
    if (!fx.weird) return t.skip('needs a POSIX file system');
    const { frames, res } = await decode(fx.weird);
    assert.equal(frames.length, 100);
    assert.equal(res.code, 0);
  });

  test('kill() mid-stream: done resolves promptly with the signal', async (t) => {
    if (skipUnless(t)) return;
    const dec = spawnDecoder(fileTrack(fx.ten), { ffmpegPath: FFMPEG });
    let n = 0;
    for await (const frame of readFrames(dec.stdout)) {
      assertFrame(frame);
      if (++n === 5) {
        dec.kill();
        break;
      }
    }
    const started = Date.now();
    const res = await dec.done;
    assert.ok(Date.now() - started < 2000, 'done settles promptly');
    assert.equal(dec.killed, true);
    assert.equal(res.code, null);
    if (POSIX) assert.equal(res.signal, 'SIGKILL');
  });

  test('back-pressure parks ffmpeg (how files pause) and nothing is lost', async (t) => {
    if (skipUnless(t)) return;
    const dec = spawnDecoder(fileTrack(fx.ten), { ffmpegPath: FFMPEG });
    let settledEarly = false;
    dec.done.then(() => { settledEarly = true; });
    const frames = readFrames(dec.stdout);
    assert.equal((await frames.next()).done, false);
    await delay(300); // 10 s of PCM is ~1.9 MB, far more than the pipe and stream buffers hold
    assert.equal(settledEarly, false);
    assert.doesNotThrow(() => process.kill(dec.pid, 0), 'ffmpeg is still running, waiting on the full pipe');
    let count = 1;
    for await (const frame of frames) {
      assertFrame(frame);
      count++;
    }
    assert.equal(count, 1000);
    assert.equal((await dec.done).code, 0);
  });

  test('a missing file fails with a readable reason', async (t) => {
    if (skipUnless(t)) return;
    const { frames, res } = await decode(path.join(dir, 'missing.wav'));
    assert.equal(frames.length, 0);
    assert.notEqual(res.code, 0);
    assert.equal(res.error, null);
    assert.equal(summarizeFfmpegError(res.stderr, res.code), 'No such file or directory');
  });

  test('probeFile reads duration and tags, and gives nulls for a missing file', async (t) => {
    if (skipUnless(t, true)) return;
    const tone = await probeFile(fx.wav, { ffprobePath: FFPROBE });
    assert.ok(Math.abs(tone.duration - 1) <= 0.05, `duration ${tone.duration}`);
    assert.equal(tone.title, null);
    assert.equal(tone.artist, null);
    const tagged = await probeFile(fx.tagged, { ffprobePath: FFPROBE });
    assert.equal(tagged.title, 'Test Tone');
    assert.equal(tagged.artist, 'Music Bot');
    assert.ok(Math.abs(tagged.duration - 1) <= 0.05);
    if (fx.weird) assert.ok(Math.abs((await probeFile(fx.weird, { ffprobePath: FFPROBE })).duration - 1) <= 0.05);
    const none = { duration: null, title: null, artist: null };
    assert.deepEqual(await probeFile(path.join(dir, 'missing.wav'), { ffprobePath: FFPROBE }), none);
  });
});
