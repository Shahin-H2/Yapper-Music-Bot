/**
 * ffmpeg as the decoder (a local file or an http(s) stream in, 48 kHz stereo s16le PCM out on stdout), plus the
 * startup check and ffprobe lookups. Inputs are locked down with protocol whitelists: a file opens as `file:<path>`
 * with only the file protocol (so `concat:x.mp3` stays a name); a stream gets http(s) and the protocols under it.
 */
import { execFile, spawn as spawnProcess } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CHANNELS, SAMPLE_RATE } from './audio.js';

// Some radio servers refuse requests without a User-Agent.
export const USER_AGENT = 'music-bot/1.0';
// Characters of stderr a Decoder keeps: the tail, where ffmpeg says why it failed.
export const STDERR_LIMIT = 4096;

const COMMON = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
const OUTPUT = ['-vn', '-sn', '-dn', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1'];
// Reconnect when a radio drops (mid-stream too); give up after 15 s without data (-rw_timeout is in microseconds).
const STREAM_INPUT = ['-protocol_whitelist', 'http,https,tcp,tls,crypto',
  '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5',
  '-rw_timeout', '15000000', '-user_agent', USER_AGENT];

const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : v === null ? 'null' : typeof v);

function httpUrl(text) {
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/** A file track needs an absolute path and a stream an http(s) URL; anything else throws a TypeError. */
export function buildFfmpegArgs(track) {
  const input = track?.input;
  // spawn refuses NUL bytes anyway; refusing here keeps the error a TypeError about the track.
  if (typeof input !== 'string' || !input || input.includes('\0')) {
    throw new TypeError('track.input must be a non-empty string');
  }
  if (track.kind === 'file') {
    if (!path.isAbsolute(input)) throw new TypeError('A file track needs an absolute path');
    return [...COMMON, '-protocol_whitelist', 'file', '-i', `file:${input}`, ...OUTPUT];
  }
  if (track.kind === 'stream') {
    const url = httpUrl(input);
    if (!url) throw new TypeError(`A stream track needs an http(s) URL, got ${show(input)}`);
    return [...COMMON, ...STREAM_INPUT, '-i', url, ...OUTPUT];
  }
  throw new TypeError(`Unknown track kind ${show(track.kind)} (expected "file" or "stream")`);
}

/** ffmpeg couldn't start (`code`: 'ENOENT' and the like). The message names the binary's path: for logs, not chat. */
export class FfmpegStartError extends Error {
  constructor(message, { cause, code = null } = {}) {
    super(message, { cause });
    this.name = 'FfmpegStartError';
    this.code = code;
  }
}

function startError(err, bin) {
  const message = err?.code === 'ENOENT' ? `ffmpeg not found at "${bin}" — install ffmpeg or set FFMPEG_PATH`
    : err?.code === 'EACCES' ? `ffmpeg at "${bin}" can't be run (permission denied) — check FFMPEG_PATH`
      : `Couldn't start ffmpeg at "${bin}": ${err?.message ?? String(err)}`;
  return new FfmpegStartError(message, { cause: err, code: err?.code ?? null });
}

/**
 * @typedef {object} DecoderResult
 * @property {number|null} code null when ended by a signal or never started
 * @property {string|null} signal
 * @property {string} stderr the last STDERR_LIMIT characters (ffmpeg runs with -loglevel error)
 * @property {Error|null} error why ffmpeg couldn't start, or a process error Node reported (a failed kill); a decode
 *   failure shows as a non-zero code instead
 */
/**
 * @typedef {object} Decoder
 * @property {import('node:stream').Readable} stdout the PCM. Stop reading and ffmpeg waits: that's how files pause
 * @property {Promise<DecoderResult>} done settles once ffmpeg exited and its pipes closed; never rejects
 * @property {() => void} kill SIGKILL and destroy stdout; idempotent. A for-await still reading stdout then rejects
 *   with ERR_STREAM_PREMATURE_CLOSE, so check an abort flag before treating that as a failure
 * @property {boolean} killed
 * @property {number|undefined} pid
 */

function decoder(stdout, done, pid, sendKill) {
  let killed = false;
  return {
    stdout,
    done,
    pid,
    get killed() { return killed; },
    kill() {
      if (killed) return;
      killed = true;
      // Signal first: with SIGKILL already pending, ffmpeg can't race to a clean exit on the broken pipe.
      try { sendKill?.(); } catch { /* already gone */ }
      stdout.destroy();
    },
  };
}

const failedDecoder = (error) =>
  decoder(Readable.from([]), Promise.resolve({ code: null, signal: null, stderr: '', error }));

/**
 * Never throws: if ffmpeg can't start, stdout is empty and `done` holds the error; callers see a failed track.
 * @returns {Decoder}
 */
export function spawnDecoder(track, { ffmpegPath = 'ffmpeg', spawn = spawnProcess } = {}) {
  let args;
  try {
    args = buildFfmpegArgs(track);
  } catch (err) {
    return failedDecoder(err);
  }
  let child;
  try {
    child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    return failedDecoder(startError(err, ffmpegPath));
  }
  let stderr = '';
  let error = null;
  let spawned = false;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const finish = (code, signal) => {
    if (!settle) return;
    settle({ code: code ?? null, signal: signal ?? null, stderr, error });
    settle = null;
  };
  // Without file descriptors (EMFILE) Node gives no stdout at all; an empty stream keeps readers simple.
  const stdout = child.stdout ?? Readable.from([]);
  // Readers see stream errors themselves; these listeners only keep a broken pipe from crashing the process.
  stdout.on('error', () => {});
  child.stderr?.on('error', () => {});
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (text) => { stderr = (stderr + text).slice(-STDERR_LIMIT); });
  child.once('spawn', () => { spawned = true; });
  child.on('error', (err) => {
    // Before 'spawn' it's a start failure: nothing to wait for, and a fake child may never send 'close'.
    if (!spawned) {
      error ??= startError(err, ffmpegPath);
      finish(null, null);
    } else {
      error ??= err;
    }
  });
  child.once('close', (code, signal) => finish(code, signal));
  return decoder(stdout, done, child.pid, () => child.kill('SIGKILL'));
}

/** execFile that never throws or rejects; resolves { err, stdout, stderr }. */
function run(file, args, timeoutMs) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.ceil(timeoutMs) : 0;
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1 << 20 },
        (err, stdout, stderr) => resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
    } catch (err) {
      resolve({ err, stdout: '', stderr: '' });
    }
  });
}

/**
 * Runs `ffmpeg -version`. Never throws; when ok is false, error.message says why in words a bot owner can act on.
 * @returns {Promise<{ ok: boolean, version: string|null, error: Error|null }>}
 */
export async function checkFfmpeg(ffmpegPath = 'ffmpeg', { timeoutMs = 5000 } = {}) {
  const { err, stdout, stderr } = await run(ffmpegPath, ['-hide_banner', '-version'], timeoutMs);
  const version = /^ffmpeg version (\S+)/m.exec(stdout)?.[1] ?? null;
  if (!err && version) return { ok: true, version, error: null };
  let error;
  if (!err) error = new Error(`"${ffmpegPath}" ran but doesn't look like ffmpeg (no version line)`);
  else if (err.killed) error = new Error(`ffmpeg at "${ffmpegPath}" didn't answer within ${timeoutMs} ms`);
  else if (typeof err.code !== 'number') error = startError(err, ffmpegPath);
  else error = new Error(`ffmpeg at "${ffmpegPath}" failed: ${summarizeFfmpegError(stderr, err.code)}`);
  return { ok: false, version: null, error };
}

/** Tag names match case-insensitively: FLAC and Vorbis taggers write TITLE. */
function tag(sets, name) {
  for (const tags of sets) {
    if (!tags || typeof tags !== 'object') continue;
    for (const [key, value] of Object.entries(tags)) {
      if (key.toLowerCase() !== name || typeof value !== 'string') continue;
      const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
  }
  return null;
}

/**
 * Duration in seconds and title/artist tags via ffprobe; nulls on any failure or timeout, never throws. Tags are read
 * from the container and from the first audio stream, where Ogg and Opus keep them.
 * @returns {Promise<{ duration: number|null, title: string|null, artist: string|null }>}
 */
export async function probeFile(file, { ffprobePath = 'ffprobe', timeoutMs = 3000 } = {}) {
  const none = { duration: null, title: null, artist: null };
  if (typeof file !== 'string' || !file || file.includes('\0')) return none;
  const args = ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'a:0',
    '-show_entries', 'format=duration:format_tags=title,artist:stream_tags=title,artist', '-of', 'json',
    `file:${path.resolve(file)}`];
  const { err, stdout } = await run(ffprobePath, args, timeoutMs);
  if (err) return none;
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return none;
  }
  const duration = Number(data?.format?.duration);
  const sets = [data?.format?.tags, ...(Array.isArray(data?.streams) ? data.streams.map((s) => s?.tags) : [])];
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    title: tag(sets, 'title'),
    artist: tag(sets, 'artist'),
  };
}

const ANSI = /\x1b\[[0-9;]*m/g;
const LOG_CONTEXT = /^(?:\[[^\]]*\]\s*)+/;                            // "[in#0 @ 0x6000...] "
const WRAPPER = /^Error opening (?:in|out)put(?: files?)?: /i;        // "Error opening input files: <the reason>"
const INPUT_PREFIX = /^(?:file:|[a-z][a-z0-9+.-]*:\/\/|\/|[a-z]:\\).*?: (?=[^:]*$)/i; // older ffmpeg: "<path>: reason"
// Lines that never say why: the one naming the input also leaks local paths into chat.
const NOISE = /^(?:Error opening (?:in|out)put file .*|Conversion failed!?|Exiting normally.*|Terminating thread.*)$/i;
const REPEATED = /^Last message repeated \d+ times?\.?$/i;
const VAGUE = /^(?:Invalid argument|Operation not permitted|Error number -?\d+ occurred)\.?$/i;
// What a retry can't change: a refusal (HTTP 4xx except 408 and 429, which mean "later"), an answer that isn't audio
// (ffmpeg calls a web page or an empty answer an input/output error while opening it), or a protocol we don't allow
// (a redirect to rtmp: or file:). ffmpeg has already retried network errors (-reconnect_on_network_error).
const LASTING = [/Server returned (?!408|429)4(?:\d\d|XX)/, /Invalid data found when processing input/,
  /does not contain any stream/, /not on whitelist/, /Input\/output error/];

/**
 * A short reason a decode failed, fit for chat: the last meaningful stderr line without log prefixes, wrappers or
 * local paths (e.g. 'Server returned 404 Not Found'), at most 200 characters. Falls back to the exit code.
 */
export function summarizeFfmpegError(stderr, code) {
  const lines = String(stderr ?? '').replace(ANSI, '').split(/\r\n|[\r\n]/)
    .map((l) => l.trim().replace(LOG_CONTEXT, '').replace(WRAPPER, '').replace(INPUT_PREFIX, '').trim())
    .filter((l) => l && !NOISE.test(l) && !REPEATED.test(l));
  let line = lines.at(-1);
  // ffmpeg often ends on "Invalid argument"; the specific cause is a line or two up.
  if (line && VAGUE.test(line)) line = lines.findLast((l) => !VAGUE.test(l)) ?? line;
  if (line && /does not contain any stream/i.test(line)) line = 'No audio stream found';
  line ||= Number.isInteger(code) && code !== 0 ? `ffmpeg exited with code ${code}`
    : code === 0 ? 'ffmpeg produced no audio' : 'ffmpeg stopped unexpectedly';
  return line.length > 200 ? `${line.slice(0, 199).replace(/[\uD800-\uDBFF]$/, '')}…` : line;
}

/**
 * Whether a retry would fail the same way (see LASTING). Only meaningful before the first audio: once a stream has
 * played, an input/output error is a dropped connection.
 */
export function isLastingFfmpegError(stderr) {
  const text = String(stderr ?? '');
  return LASTING.some((re) => re.test(text));
}
