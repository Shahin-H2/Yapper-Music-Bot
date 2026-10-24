/**
 * Settings from environment variables; `npm start` loads .env, and .env.example documents each variable.
 * loadConfig never throws: an unusable value falls back to its default and adds a line to `warnings` (the token is
 * never echoed). Relative paths resolve against the project root, not the working directory.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_LEVELS, parseLogLevel } from './log.js';

/**
 * @typedef {Readonly<{
 *   token: string|null, musicDir: string, stationsFile: string, ffmpegPath: string, ffprobePath: string,
 *   defaultVolume: number, volumeStep: number, maxQueueSize: number, idleTimeoutMs: number, aloneTimeoutMs: number,
 *   allowUrls: boolean, requireSameVoice: boolean, embedColor: string, statusText: string, audioQueueMs: number,
 *   bitrate: number, logLevel: import('./log.js').LogLevel, warnings: readonly string[],
 * }>} Config
 */

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BOOLEANS = new Map([
  ...['true', '1', 'yes', 'on'].map((k) => [k, true]),
  ...['false', '0', 'no', 'off'].map((k) => [k, false]),
]);

// Quoted and cut short. Anything token-like is masked, in case a token was pasted into the wrong variable.
const show = (raw) => {
  const safe = raw.replace(/yb_\S*/g, 'yb_…');
  return JSON.stringify(safe.length > 60 ? `${safe.slice(0, 59)}…` : safe);
};

// .env values aren't shell-expanded. Only `~` and `~/x` are handled, not `~user`.
const expandHome = (p) => (/^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);

/**
 * @param {Record<string, unknown>} [env]
 * @returns {Config}
 */
export function loadConfig(env = process.env) {
  const source = env !== null && typeof env === 'object' ? env : {};
  const warnings = [];
  const reject = (name, raw, why, fallback) => { warnings.push(`${name}=${show(raw)} ${why}; using ${fallback}`); };

  // Trimmed, minus one pair of surrounding quotes (Docker env files keep them); undefined when unset.
  const read = (name) => {
    try {
      const value = source[name];
      if (value === undefined || value === null) return undefined;
      const text = String(value).trim();
      return (/^(["'])(.*)\1$/s.exec(text)?.[2] ?? text).trim();
    } catch {
      return undefined; // a throwing getter or an unprintable value counts as unset
    }
  };
  const int = (name, min, max, fallback, { percent = false, step = 1 } = {}) => {
    const raw = read(name);
    if (!raw) return fallback;
    const digits = percent ? raw.replace(/\s*%$/, '') : raw;
    const n = /^\+?\d+$/.test(digits) ? Number(digits) : NaN;
    if (n >= min && n <= max && n % step === 0) return n;
    reject(name, raw, `isn't a ${step === 1 ? 'whole number' : `multiple of ${step}`} from ${min} to ${max}`, fallback);
    return fallback;
  };
  const bool = (name, fallback) => {
    const raw = read(name);
    if (!raw) return fallback;
    const value = BOOLEANS.get(raw.toLowerCase());
    if (value !== undefined) return value;
    reject(name, raw, "isn't true or false (1/0, yes/no and on/off work too)", fallback);
    return fallback;
  };
  const filePath = (name, fallback, { bareName = false } = {}) => {
    const raw = read(name);
    if (!raw) return fallback;
    if (raw.includes('\0')) { reject(name, raw, 'contains a NUL character', fallback); return fallback; }
    const p = expandHome(raw);
    // A bare program name ('ffmpeg') stays a PATH lookup; anything with a slash resolves from the project root.
    return bareName && !/[\\/]/.test(p) ? p : path.resolve(PROJECT_ROOT, p);
  };
  const color = (name, fallback) => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    if (raw === '') {
      // Node's --env-file reads an unquoted # as a comment, so EMBED_COLOR=#00aaff arrives empty.
      warnings.push(`${name} is empty (in .env an unquoted # starts a comment): write ${name}="#00aaff" or `
        + `${name}=00aaff; using ${fallback}`);
      return fallback;
    }
    const hex = /^#?([0-9a-f]{6})$/i.exec(raw)?.[1];
    if (hex) return `#${hex.toLowerCase()}`;
    reject(name, raw, "isn't a #rrggbb colour", fallback);
    return fallback;
  };
  const level = (name, fallback) => {
    const raw = read(name);
    if (!raw) return fallback;
    const parsed = parseLogLevel(raw);
    if (parsed) return parsed;
    reject(name, raw, `isn't one of ${LOG_LEVELS.join(', ')}`, fallback);
    return fallback;
  };

  const token = read('YAPPER_BOT_TOKEN') || null;
  // Kept, so the SDK refuses it with its own error; flagged here too, without echoing it.
  if (token && !token.startsWith('yb_')) {
    warnings.push("YAPPER_BOT_TOKEN doesn't start with yb_, so it isn't a bot token "
      + '(make one in Yapin’ → Settings → Developer)');
  }
  // Object literals evaluate in order, so warnings come out in field order and are complete before the freeze.
  return Object.freeze({
    token,
    musicDir: filePath('MUSIC_DIR', path.join(PROJECT_ROOT, 'music')),
    stationsFile: filePath('STATIONS_FILE', path.join(PROJECT_ROOT, 'config', 'stations.json')),
    ffmpegPath: filePath('FFMPEG_PATH', 'ffmpeg', { bareName: true }),
    ffprobePath: filePath('FFPROBE_PATH', 'ffprobe', { bareName: true }),
    defaultVolume: int('DEFAULT_VOLUME', 1, 200, 100, { percent: true }),
    volumeStep: int('VOLUME_STEP', 1, 100, 10, { percent: true }),
    maxQueueSize: int('MAX_QUEUE_SIZE', 1, 1000, 100),
    idleTimeoutMs: int('IDLE_TIMEOUT_SECONDS', 0, 3600, 30) * 1000,
    aloneTimeoutMs: int('ALONE_TIMEOUT_SECONDS', 0, 3600, 30) * 1000,
    allowUrls: bool('ALLOW_URLS', true),
    requireSameVoice: bool('REQUIRE_SAME_VOICE', true),
    embedColor: color('EMBED_COLOR', '#ff4fd8'),
    statusText: read('BOT_STATUS')?.replace(/\s+/g, ' ') || 'Listening to /play',
    // LiveKit panics on a queue that isn't a multiple of 10 ms, which aborts the whole process on the first /play.
    audioQueueMs: int('AUDIO_QUEUE_MS', 50, 1000, 200, { step: 10 }),
    bitrate: int('AUDIO_BITRATE', 32000, 256000, 128000),
    logLevel: level('LOG_LEVEL', 'info'),
    warnings: Object.freeze(warnings),
  });
}
