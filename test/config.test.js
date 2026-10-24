// Tests for src/config.js and src/log.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROJECT_ROOT, loadConfig } from '../src/config.js';
import { LOG_LEVELS, consoleSink, createLogger, getLogLevel, parseLogLevel, setLogLevel } from '../src/log.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();

const DEFAULTS = Object.freeze({
  token: null,
  musicDir: path.join(ROOT, 'music'),
  stationsFile: path.join(ROOT, 'config', 'stations.json'),
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  defaultVolume: 100,
  volumeStep: 10,
  maxQueueSize: 100,
  idleTimeoutMs: 30000,
  aloneTimeoutMs: 30000,
  allowUrls: true,
  requireSameVoice: true,
  embedColor: '#ff4fd8',
  statusText: 'Listening to /play',
  audioQueueMs: 200,
  bitrate: 128000,
  logLevel: 'info',
  warnings: [],
});

/**
 * Checks one variable: unset gives the default; each valid raw value parses with no warning and no other field
 * changed; each invalid one gives the default plus exactly one warning naming the variable and the quoted value.
 */
function checkVariable({ name, field, fallback, valid = [], invalid = [], why = null, shownFallback = fallback }) {
  assert.deepEqual(loadConfig({}).warnings, []);
  assert.deepEqual(loadConfig({})[field], fallback, `${name} unset`);
  for (const [raw, expected] of valid) {
    const config = loadConfig({ [name]: raw });
    assert.deepEqual(config[field], expected, `${name}=${JSON.stringify(raw)}`);
    assert.deepEqual(config.warnings, [], `${name}=${JSON.stringify(raw)} should not warn`);
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (key !== field && key !== 'warnings') assert.deepEqual(config[key], value, `${name} must not change ${key}`);
    }
  }
  for (const raw of invalid) {
    const config = loadConfig({ [name]: raw });
    assert.deepEqual(config[field], fallback, `${name}=${JSON.stringify(raw)} falls back`);
    assert.equal(config.warnings.length, 1, `${name}=${JSON.stringify(raw)} warns once`);
    const [warning] = config.warnings;
    assert.ok(warning.startsWith(`${name}=${JSON.stringify(raw.trim())} `), warning);
    assert.ok(warning.endsWith(`; using ${shownFallback}`), warning);
    if (why) assert.match(warning, why);
  }
}

describe('PROJECT_ROOT', () => {
  it('is the absolute project folder', () => {
    assert.ok(path.isAbsolute(PROJECT_ROOT));
    assert.equal(PROJECT_ROOT, ROOT);
    assert.equal(JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).name, 'music-bot');
  });
});

describe('loadConfig: defaults and shape', () => {
  it('gives every default for an empty environment, with no warnings', () => {
    assert.deepEqual({ ...loadConfig({}) }, DEFAULTS);
  });

  it('freezes the result and its warnings', () => {
    const config = loadConfig({ DEFAULT_VOLUME: 'loud' });
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.warnings));
    assert.throws(() => { config.defaultVolume = 5; }, TypeError);
    assert.throws(() => config.warnings.push('more'), TypeError);
    assert.equal(config.warnings.length, 1);
    assert.ok(Object.isFrozen(loadConfig({}).warnings));
  });

  it('reads process.env when called without an argument', () => {
    const before = process.env.VOLUME_STEP;
    process.env.VOLUME_STEP = '42';
    try {
      assert.equal(loadConfig().volumeStep, 42);
    } finally {
      if (before === undefined) delete process.env.VOLUME_STEP;
      else process.env.VOLUME_STEP = before;
    }
  });

  it('treats empty and blank values as unset, without a warning', () => {
    const names = ['YAPPER_BOT_TOKEN', 'MUSIC_DIR', 'STATIONS_FILE', 'FFMPEG_PATH', 'FFPROBE_PATH', 'DEFAULT_VOLUME',
      'VOLUME_STEP', 'MAX_QUEUE_SIZE', 'IDLE_TIMEOUT_SECONDS', 'ALONE_TIMEOUT_SECONDS', 'ALLOW_URLS',
      'REQUIRE_SAME_VOICE', 'BOT_STATUS', 'AUDIO_QUEUE_MS', 'AUDIO_BITRATE', 'LOG_LEVEL'];
    for (const blank of ['', '   ', '""']) {
      assert.deepEqual({ ...loadConfig(Object.fromEntries(names.map((n) => [n, blank]))) }, DEFAULTS);
    }
  });

  it('never throws, whatever it is handed', () => {
    assert.deepEqual({ ...loadConfig(null) }, DEFAULTS);
    assert.deepEqual({ ...loadConfig('nope') }, DEFAULTS);
    const hostile = Object.defineProperty({}, 'DEFAULT_VOLUME', { get() { throw new Error('boom'); } });
    assert.equal(loadConfig(hostile).defaultVolume, 100);
    assert.equal(loadConfig({ DEFAULT_VOLUME: Object.create(null) }).defaultVolume, 100);
    assert.equal(loadConfig({ MAX_QUEUE_SIZE: { toString() { throw new Error('no'); } } }).maxQueueSize, 100);
  });

  it('accepts non-string values the way they print', () => {
    const config = loadConfig({ DEFAULT_VOLUME: 150, ALLOW_URLS: false, AUDIO_BITRATE: 64000n });
    assert.deepEqual([config.defaultVolume, config.allowUrls, config.bitrate], [150, false, 64000]);
  });

  it('strips one pair of surrounding quotes (Docker env files keep them)', () => {
    const config = loadConfig({ DEFAULT_VOLUME: '"150"', BOT_STATUS: "'Hi there'", EMBED_COLOR: '"#00AAFF"' });
    assert.deepEqual([config.defaultVolume, config.statusText, config.embedColor], [150, 'Hi there', '#00aaff']);
    assert.deepEqual(config.warnings, []);
    assert.equal(loadConfig({ DEFAULT_VOLUME: '"150\'' }).defaultVolume, 100, 'mismatched quotes are not stripped');
  });

  it('lists warnings in field order, one per bad value', () => {
    const { warnings } = loadConfig({ LOG_LEVEL: 'loud', DEFAULT_VOLUME: 'x', ALLOW_URLS: 'perhaps' });
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /^DEFAULT_VOLUME=/);
    assert.match(warnings[1], /^ALLOW_URLS=/);
    assert.match(warnings[2], /^LOG_LEVEL=/);
  });

  it('quotes bad values safely: escaped, cut short, tokens blanked out', () => {
    const [control] = loadConfig({ DEFAULT_VOLUME: 'ab\ncd' }).warnings;
    assert.ok(control.startsWith('DEFAULT_VOLUME="ab\\ncd" '), control);
    const [long] = loadConfig({ VOLUME_STEP: 'x'.repeat(500) }).warnings;
    assert.ok(long.length < 200);
    assert.match(long, /^VOLUME_STEP="x{59}…" /);
    const [secret] = loadConfig({ DEFAULT_VOLUME: 'yb_supersecrettoken123' }).warnings;
    assert.ok(!secret.includes('supersecret'), secret);
    assert.match(secret, /^DEFAULT_VOLUME="yb_…" /);
  });
});

describe('loadConfig: YAPPER_BOT_TOKEN', () => {
  it('is null when unset or blank', () => {
    assert.equal(loadConfig({}).token, null);
    assert.equal(loadConfig({ YAPPER_BOT_TOKEN: '  ' }).token, null);
  });

  it('is trimmed (and unquoted)', () => {
    const config = loadConfig({ YAPPER_BOT_TOKEN: '  yb_abc123  ' });
    assert.equal(config.token, 'yb_abc123');
    assert.deepEqual(config.warnings, []);
    assert.equal(loadConfig({ YAPPER_BOT_TOKEN: "'yb_quoted'" }).token, 'yb_quoted');
  });

  it('warns about a value without the yb_ prefix, never echoing it', () => {
    const config = loadConfig({ YAPPER_BOT_TOKEN: 'user-token-9f8e7d' });
    assert.equal(config.token, 'user-token-9f8e7d', 'kept: the SDK refuses it with its own message');
    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0], /^YAPPER_BOT_TOKEN .*yb_/);
    assert.ok(!config.warnings[0].includes('9f8e7d'));
  });
});

describe('loadConfig: whole numbers', () => {
  const range = (min, max) => new RegExp(`whole number from ${min} to ${max}`);
  it('DEFAULT_VOLUME sets defaultVolume (1..200, % allowed)', () => checkVariable({
    name: 'DEFAULT_VOLUME', field: 'defaultVolume', fallback: 100, why: range(1, 200),
    valid: [['1', 1], ['150', 150], ['200', 200], [' 80 ', 80], ['+90', 90], ['007', 7], ['75%', 75], ['60 %', 60]],
    invalid: ['0', '201', 'abc', '1.5', '1e2', '-5', '0x10', '10 20', '%', '150%%', '200.0'],
  }));
  it('VOLUME_STEP sets volumeStep (1..100, % allowed)', () => checkVariable({
    name: 'VOLUME_STEP', field: 'volumeStep', fallback: 10, why: range(1, 100),
    valid: [['1', 1], ['25', 25], ['100', 100], ['5%', 5]],
    invalid: ['0', '101', 'ten', '2.5'],
  }));
  it('MAX_QUEUE_SIZE sets maxQueueSize (1..1000)', () => checkVariable({
    name: 'MAX_QUEUE_SIZE', field: 'maxQueueSize', fallback: 100, why: range(1, 1000),
    valid: [['1', 1], ['250', 250], ['1000', 1000]],
    invalid: ['0', '1001', '50%', 'lots', '99999999999999999999'],
  }));
  it('IDLE_TIMEOUT_SECONDS sets idleTimeoutMs (0..3600 s)', () => checkVariable({
    name: 'IDLE_TIMEOUT_SECONDS', field: 'idleTimeoutMs', fallback: 30000, shownFallback: 30, why: range(0, 3600),
    valid: [['0', 0], ['45', 45000], ['3600', 3600000]],
    invalid: ['-1', '3601', '1.5', '30s'],
  }));
  it('ALONE_TIMEOUT_SECONDS sets aloneTimeoutMs (0..3600 s)', () => checkVariable({
    name: 'ALONE_TIMEOUT_SECONDS', field: 'aloneTimeoutMs', fallback: 30000, shownFallback: 30, why: range(0, 3600),
    valid: [['0', 0], ['120', 120000], ['3600', 3600000]],
    invalid: ['-0.5', '3601', 'never'],
  }));
  it('AUDIO_QUEUE_MS sets audioQueueMs (50..1000 in steps of 10; LiveKit aborts the process otherwise)', () => {
    checkVariable({
      name: 'AUDIO_QUEUE_MS', field: 'audioQueueMs', fallback: 200, why: /multiple of 10 from 50 to 1000/,
      valid: [['50', 50], ['120', 120], ['330', 330], ['1000', 1000]],
      invalid: ['49', '1001', 'fast', '200ms', '75', '55', '125', '333', '999'],
    });
    // Every value it lets through is one LiveKit's AudioSource takes.
    for (let n = 0; n <= 1100; n++) {
      const { audioQueueMs } = loadConfig({ AUDIO_QUEUE_MS: String(n) });
      assert.ok(audioQueueMs % 10 === 0 && audioQueueMs >= 50 && audioQueueMs <= 1000, `${n} → ${audioQueueMs}`);
    }
  });
  it('AUDIO_BITRATE sets bitrate (32000..256000)', () => checkVariable({
    name: 'AUDIO_BITRATE', field: 'bitrate', fallback: 128000, why: range(32000, 256000),
    valid: [['32000', 32000], ['96000', 96000], ['256000', 256000]],
    invalid: ['31999', '256001', '128k', '128_000'],
  }));
});

describe('loadConfig: yes/no switches', () => {
  const words = [['true', true], ['TRUE', true], ['1', true], ['yes', true], ['Yes', true], ['on', true], ['ON', true],
    ['false', false], ['False', false], ['0', false], ['no', false], ['NO', false], ['off', false], [' Off ', false]];
  const invalid = ['maybe', '2', 'y', 'n', 'enabled', 'truee'];
  it('ALLOW_URLS sets allowUrls', () => checkVariable({
    name: 'ALLOW_URLS', field: 'allowUrls', fallback: true, valid: words, invalid, why: /true or false/,
  }));
  it('REQUIRE_SAME_VOICE sets requireSameVoice', () => checkVariable({
    name: 'REQUIRE_SAME_VOICE', field: 'requireSameVoice', fallback: true, valid: words, invalid, why: /true or false/,
  }));
});

describe('loadConfig: paths', () => {
  const elsewhere = path.join(os.tmpdir(), 'music-bot-elsewhere', 'songs');
  for (const [name, field, fallback] of [
    ['MUSIC_DIR', 'musicDir', path.join(ROOT, 'music')],
    ['STATIONS_FILE', 'stationsFile', path.join(ROOT, 'config', 'stations.json')],
  ]) {
    it(`${name} sets ${field}: relative to the project root, absolute as given, ~ is home`, () => checkVariable({
      name, field, fallback, why: /NUL/,
      valid: [
        ['library', path.join(ROOT, 'library')],
        ['./library/../tunes', path.join(ROOT, 'tunes')],
        ['../outside', path.resolve(ROOT, '..', 'outside')],
        [elsewhere, elsewhere],
        ['~', HOME],
        ['~/Music', path.join(HOME, 'Music')],
        ['~music', path.join(ROOT, '~music')],
      ],
      invalid: ['bad\0name'],
    }));
  }

  it('resolves relative paths against PROJECT_ROOT, not process.cwd()', () => {
    const cwd = process.cwd();
    const away = fs.mkdtempSync(path.join(os.tmpdir(), 'music-bot-'));
    try {
      process.chdir(away);
      const config = loadConfig({
        MUSIC_DIR: 'music', STATIONS_FILE: './config/stations.json', FFMPEG_PATH: 'bin/ffmpeg',
      });
      assert.equal(config.musicDir, path.join(ROOT, 'music'));
      assert.equal(config.stationsFile, path.join(ROOT, 'config', 'stations.json'));
      assert.equal(config.ffmpegPath, path.join(ROOT, 'bin', 'ffmpeg'));
      assert.equal(loadConfig({}).musicDir, path.join(ROOT, 'music'));
    } finally {
      process.chdir(cwd);
      fs.rmSync(away, { recursive: true, force: true });
    }
  });

  const programs = [['FFMPEG_PATH', 'ffmpegPath', 'ffmpeg'], ['FFPROBE_PATH', 'ffprobePath', 'ffprobe']];
  for (const [name, field, fallback] of programs) {
    it(`${name} sets ${field}: a bare name stays a PATH lookup, a path is resolved`, () => checkVariable({
      name, field, fallback, why: /NUL/,
      valid: [
        [`${fallback}-9`, `${fallback}-9`],
        [`${fallback}.exe`, `${fallback}.exe`],
        [`/opt/homebrew/bin/${fallback}`, `/opt/homebrew/bin/${fallback}`],
        [`./${fallback}`, path.join(ROOT, fallback)],
        [`bin/${fallback}`, path.join(ROOT, 'bin', fallback)],
        [`~/bin/${fallback}`, path.join(HOME, 'bin', fallback)],
      ],
      invalid: [`${fallback}\0`],
    }));
  }
});

describe('loadConfig: text settings', () => {
  it('EMBED_COLOR sets embedColor: #rrggbb (any case, # optional), lower-cased', () => checkVariable({
    name: 'EMBED_COLOR', field: 'embedColor', fallback: '#ff4fd8', why: /#rrggbb/,
    valid: [['#00FF7f', '#00ff7f'], ['#123abc', '#123abc'], ['00aaFF', '#00aaff'], ['  #ABCDEF ', '#abcdef']],
    invalid: ['red', '#fff', '#12345g', '#1234567', 'rgb(1, 2, 3)', '##123456'],
  }));

  it('EMBED_COLOR that arrives empty warns about the unquoted-# pitfall', () => {
    const config = loadConfig({ EMBED_COLOR: '' });
    assert.equal(config.embedColor, '#ff4fd8');
    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0], /^EMBED_COLOR is empty .*unquoted # .*; using #ff4fd8$/);
  });

  it('BOT_STATUS sets statusText: trimmed, inner whitespace collapsed', () => {
    assert.equal(loadConfig({}).statusText, 'Listening to /play');
    assert.equal(loadConfig({ BOT_STATUS: 'Vibing in voice' }).statusText, 'Vibing in voice');
    assert.equal(loadConfig({ BOT_STATUS: '  lots   of\tspace\n here ' }).statusText, 'lots of space here');
    assert.equal(loadConfig({ BOT_STATUS: ' \t ' }).statusText, 'Listening to /play');
    assert.deepEqual(loadConfig({ BOT_STATUS: 'x' }).warnings, []);
  });

  it('LOG_LEVEL sets logLevel: debug|info|warn|error in any case', () => checkVariable({
    name: 'LOG_LEVEL', field: 'logLevel', fallback: 'info', why: /debug, info, warn, error/,
    valid: [['debug', 'debug'], ['DEBUG', 'debug'], ['info', 'info'], [' Warn ', 'warn'], ['error', 'error']],
    invalid: ['verbose', 'trace', '5', 'warning'],
  }));
});

// ---- src/log.js ----

const AT = Date.UTC(2026, 9, 24, 1, 2, 3, 456);
/** A logger writing into an array, with a pinned clock. */
function capture(scope = 'test', opts = {}) {
  const lines = [];
  const log = createLogger(scope, { now: () => AT, sink: (level, line) => lines.push([level, line]), ...opts });
  return { log, lines, text: () => lines.map(([, line]) => line) };
}
/** Run `fn` with the global level set, then put it back. */
function withGlobalLevel(level, fn) {
  const before = getLogLevel();
  setLogLevel(level);
  try { return fn(); } finally { setLogLevel(before); }
}

describe('log: levels', () => {
  it('knows its levels and parses them leniently', () => {
    assert.deepEqual(LOG_LEVELS, ['debug', 'info', 'warn', 'error']);
    assert.ok(Object.isFrozen(LOG_LEVELS));
    assert.equal(parseLogLevel('DEBUG'), 'debug');
    assert.equal(parseLogLevel(' info '), 'info');
    for (const bad of ['verbose', '', 5, null, undefined, 'constructor', '__proto__']) {
      assert.equal(parseLogLevel(bad), null);
    }
  });

  it('drops lines below the logger level', () => {
    const { log, lines } = capture('t', { level: 'warn' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    assert.deepEqual(lines.map(([level]) => level), ['warn', 'error']);
    assert.equal(log.level, 'warn');
  });

  it('a logger without its own level follows setLogLevel, even after it was made', () => {
    const { log, lines } = capture();
    withGlobalLevel('error', () => {
      log.warn('hidden');
      log.error('shown');
      assert.equal(log.level, 'error');
    });
    withGlobalLevel('debug', () => log.debug('also shown'));
    assert.deepEqual(lines.map(([level]) => level), ['error', 'debug']);
  });

  it('an explicit level ignores the global one', () => {
    const { log, lines } = capture('t', { level: 'info' });
    withGlobalLevel('error', () => log.info('kept'));
    withGlobalLevel('debug', () => log.debug('dropped'));
    assert.deepEqual(lines.map(([level]) => level), ['info']);
  });

  it('refuses unknown levels', () => {
    const before = getLogLevel();
    assert.throws(() => setLogLevel('loud'), TypeError);
    assert.equal(getLogLevel(), before);
    assert.throws(() => createLogger('t', { level: 'loud' }), TypeError);
    assert.throws(() => createLogger('t', { sink: 'console' }), TypeError);
    assert.equal(setLogLevel(' WARN '), 'warn');
    setLogLevel(before);
  });

  it('reads LOG_LEVEL once, at import', () => {
    const url = pathToFileURL(path.join(ROOT, 'src', 'log.js')).href;
    const levelWith = (value) => {
      const env = { ...process.env };
      delete env.LOG_LEVEL;
      if (value !== undefined) env.LOG_LEVEL = value;
      const script = `import { getLogLevel } from ${JSON.stringify(url)}; process.stdout.write(getLogLevel());`;
      return execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    };
    assert.equal(levelWith(' Debug '), 'debug');
    assert.equal(levelWith('error'), 'error');
    assert.equal(levelWith('nonsense'), 'info');
    assert.equal(levelWith(undefined), 'info');
  });
});

describe('log: format', () => {
  it('writes "<ISO time> LEVEL [scope] message ...args" with padded level names', () => {
    const { log, text } = capture('player', { level: 'debug' });
    log.debug('d');
    log.info('now playing', 42, { a: 1, nested: { b: [1, 2] } }, null, undefined, true);
    log.warn('w');
    log.error('e');
    log.info();
    assert.deepEqual(text(), [
      '2026-10-24T01:02:03.456Z DEBUG [player] d',
      '2026-10-24T01:02:03.456Z INFO  [player] now playing 42 { a: 1, nested: { b: [ 1, 2 ] } } null undefined true',
      '2026-10-24T01:02:03.456Z WARN  [player] w',
      '2026-10-24T01:02:03.456Z ERROR [player] e',
      '2026-10-24T01:02:03.456Z INFO  [player]',
    ]);
  });

  it('keeps message text as is (no printf-style % handling)', () => {
    const { log, text } = capture();
    log.info('100%s done %d', 'x');
    assert.deepEqual(text(), ['2026-10-24T01:02:03.456Z INFO  [test] 100%s done %d x']);
  });

  it('prints only the message of an error, the stack at debug level', () => {
    const err = new Error('it broke');
    const info = capture('t', { level: 'info' });
    info.log.error('failed:', err);
    assert.equal(info.text()[0], '2026-10-24T01:02:03.456Z ERROR [t] failed: it broke');
    const debug = capture('t', { level: 'debug' });
    debug.log.error('failed:', err);
    assert.ok(debug.text()[0].includes(err.stack), 'stack at debug');
  });

  it('shows an error cause', () => {
    const err = new Error('voice failed', { cause: new Error('403 Forbidden') });
    const info = capture('t', { level: 'info' });
    info.log.warn(err, new Error('plain', { cause: 'just text' }));
    assert.equal(info.text()[0],
      "2026-10-24T01:02:03.456Z WARN  [t] voice failed (cause: 403 Forbidden) plain (cause: 'just text')");
    const debug = capture('t', { level: 'debug' });
    debug.log.warn(err);
    assert.ok(debug.text()[0].includes(`\n  [cause] ${err.cause.stack}`));
  });

  it('child loggers extend the scope and share the sink, level and clock', () => {
    const { log, text } = capture('player', { level: 'warn' });
    const child = log.child('123');
    child.info('dropped');
    child.warn('alone');
    child.child('dec').error('exit 1');
    assert.equal(child.level, 'warn');
    assert.deepEqual(text(), [
      '2026-10-24T01:02:03.456Z WARN  [player:123] alone',
      '2026-10-24T01:02:03.456Z ERROR [player:123:dec] exit 1',
    ]);
  });

  it('never throws: a broken sink, a bad clock or an unprintable value', () => {
    const broken = createLogger('t', { level: 'debug', sink: () => { throw new Error('EPIPE'); } });
    assert.doesNotThrow(() => broken.error('x'));
    const lines = [];
    const badClock = createLogger('t', { level: 'debug', now: () => NaN, sink: (_, line) => lines.push(line) });
    badClock.info('still logged');
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z INFO {2}\[t\] still logged$/);
    const evil = new Proxy({}, { get() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } });
    badClock.info('value:', evil);
    assert.equal(lines.length, 2);
  });

  it('the default sink sends warn/error to console.warn/console.error and the rest to console.log', () => {
    const seen = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    for (const name of Object.keys(saved)) console[name] = (line) => seen.push([name, line]);
    try {
      consoleSink('debug', 'a');
      consoleSink('info', 'b');
      consoleSink('warn', 'c');
      consoleSink('error', 'd');
      createLogger('t', { level: 'debug', now: () => AT }).warn('via default');
    } finally {
      Object.assign(console, saved);
    }
    assert.deepEqual(seen, [['log', 'a'], ['log', 'b'], ['warn', 'c'], ['error', 'd'],
      ['warn', '2026-10-24T01:02:03.456Z WARN  [t] via default']]);
  });
});
