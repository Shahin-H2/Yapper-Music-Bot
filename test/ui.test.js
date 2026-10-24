import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Embed, Row } from '../yapper.js';
import { MAX_VOLUME, MIN_VOLUME } from '../src/audio.js';
import {
  BUTTON_ACTIONS, CUSTOM_ID_PREFIX, LIMITS, controlRows, customId, endedEmbed, formatDuration, helpEmbed, loopLabel,
  nowPlayingEmbed, parseCustomId, progressBar, queueEmbed, sanitize, trackAddedEmbed, tracksEmbed, truncate,
} from '../src/ui.js';

const ZWSP = '\u200b';
const PINK = 0xff4fd8;
const MARKDOWN = new Set('\\*_~`|[]()>#');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Where text may be cut without splitting a grapheme: 0 and the end of every grapheme. */
function boundaries(text) {
  const at = new Set([0]);
  let n = 0;
  for (const { segment } of SEGMENTER.segment(text)) at.add((n += segment.length));
  return at;
}

/** Everything a hostile file name, tag or station name could try at once. */
const NASTY = '**b** __u__ ~~s~~ `c` ||sp|| [x](https://evil.example) > q # h \\ @everyone @here <@123> <@!4> '
  + '<@&56> <#78>\nnext\r\nline\u2028sep\tTab\u0000\u001b\u202eevil\u202c 👨‍👩‍👧 🇳🇱 e\u0301 ';
const HUGE = NASTY.repeat(8); // ~1300 characters

const fileTrack = (title, extra = {}) => ({
  kind: 'file', live: false, title, artist: null, input: `/Users/someone/private/music/${title}.mp3`, source: 'local',
  duration: 225, fileName: `${title}.mp3`, url: null, requestedBy: 'u1', ...extra,
});
const stationTrack = (extra = {}) => ({
  kind: 'stream', live: true, title: 'SomaFM · Groove Salad', artist: null,
  input: 'https://ice2.somafm.com/groovesalad-128-mp3', source: 'station', duration: null, stationId: 'groovesalad',
  description: 'Ambient beats and grooves', url: 'https://somafm.com/groovesalad/', requestedBy: 'u2', ...extra,
});
/** A track with every text field as long and nasty as it gets, and the longest requester id that still counts. */
const hostileTrack = (extra = {}) => fileTrack(HUGE, {
  artist: HUGE, description: HUGE, fileName: HUGE, requestedBy: 'x'.repeat(64), duration: 1e9,
  url: `https://evil.example/${'a'.repeat(3000)}`, ...extra,
});
/** A PlayerSnapshot: Song A by Band playing at 1:23 of 3:45, Song B (3:00) and Song C (3:20) waiting. */
function snapshot(extra = {}) {
  const s = {
    serverId: 'srv1', channelId: 'vc1', channelName: 'Lounge', textChannelId: 'tc1', state: 'playing',
    current: fileTrack('Song A', { artist: 'Band' }), position: 83, paused: false, volume: 100, loop: 'off',
    upcoming: [fileTrack('Song B', { duration: 180 }), fileTrack('Song C', { duration: 200 })], ...extra,
  };
  if (!('next' in extra)) s.next = s.upcoming[0] ?? null;
  return s;
}
/** Track 1 to Track n, a minute each. */
const numbered = (n) => Array.from({ length: n }, (_, i) => fileTrack(`Track ${i + 1}`, { duration: 60 }));

/** Seeded PRNG (mulberry32): the "random" inputs are the same on every run. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PIECES = ['*', '_', '~', '`', '|', '[', ']', '(', ')', '>', '#', '\\', '@', '<', '&', '!', ':', ' ', '  ', '\n',
  '\r\n', '\t', 'x', 'Y', '7', 'é', 'e\u0301', '👍', '👍🏽', '👨‍👩‍👧', '🇳🇱', '#️⃣', '\u202e', '\u0000', '\u0085', '\u3000',
  '\u00a0', ZWSP, 'everyone', 'here', '…'];
const randomText = (rnd, n) => Array.from({ length: n }, () => PIECES[Math.floor(rnd() * PIECES.length)]).join('');

function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/** sanitize() output: one line, no controls, every markdown character escaped, every @ and < defused. */
function assertSafe(s) {
  assert.doesNotMatch(s, /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/, JSON.stringify(s));
  assert.doesNotMatch(s, LONE_SURROGATE);
  assert.doesNotMatch(s, /^\s|\s$|\s\s/, `stray whitespace in ${JSON.stringify(s)}`);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      assert.ok(MARKDOWN.has(s[i + 1]), `stray backslash at ${i} in ${JSON.stringify(s)}`);
      i++;
    } else {
      assert.ok(!MARKDOWN.has(s[i]), `unescaped ${s[i]} at ${i} in ${JSON.stringify(s)}`);
      if (s[i] === '@' || s[i] === '<') assert.equal(s[i + 1], ZWSP, `live ${s[i]} at ${i} in ${JSON.stringify(s)}`);
    }
  }
}
/** How many '*' in s aren't backslash-escaped. */
function liveStars(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '*') n++;
  }
  return n;
}

/** Every string an embed shows that counts towards its 6000-character total. */
const embedTexts = (e) => [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value]),
  e.footer?.text, e.author?.name].filter((t) => t !== undefined);

/** Checks an embed against every platform limit, and that it is clean JSON with nothing leaking; returns its JSON. */
function checkEmbed(embed) {
  assert.ok(embed instanceof Embed, 'builders return yapper.js Embeds');
  const e = JSON.parse(JSON.stringify(embed));
  if (e.title !== undefined) assert.ok(e.title.length >= 1 && e.title.length <= LIMITS.title, 'title length');
  assert.equal(typeof e.description, 'string');
  assert.ok(e.description.length >= 1 && e.description.length <= LIMITS.description,
    `description is ${e.description.length} characters`);
  const fields = e.fields ?? [];
  assert.ok(fields.length <= LIMITS.fields, 'at most 10 fields');
  for (const f of fields) {
    assert.ok(f.name.length >= 1 && f.name.length <= LIMITS.fieldName, `field name is ${f.name.length} characters`);
    assert.ok(f.value.length >= 1 && f.value.length <= LIMITS.fieldValue, `${f.name} is ${f.value.length} characters`);
    assert.equal(typeof f.inline, 'boolean');
  }
  const total = embedTexts(e).reduce((n, t) => n + t.length, 0);
  assert.ok(total <= LIMITS.total, `${total} characters in all`);
  assert.ok(Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff, 'a real colour');
  if (e.url !== undefined) assert.match(e.url, /^https:\/\/[^\s]+$/);
  for (const t of embedTexts(e)) {
    assert.equal(typeof t, 'string');
    assert.doesNotMatch(t, LONE_SURROGATE, 'no half characters');
    assert.doesNotMatch(t, /@(everyone|here)|<@&|<#|<@(?![\w-]{1,64}>)/i, `a live ping in ${JSON.stringify(t)}`);
    assert.doesNotMatch(t, /undefined|NaN|null|\[object/, `junk in ${JSON.stringify(t)}`);
    assert.doesNotMatch(t, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/, 'no controls');
  }
  return e;
}

/** Checks rows against the button limits (custom ids unique in the message); returns the buttons' JSON by row. */
function checkRows(rows) {
  assert.ok(Array.isArray(rows) && rows.length <= LIMITS.rows, 'at most 5 rows');
  const ids = [];
  const out = rows.map((row) => {
    assert.ok(row instanceof Row, 'rows are yapper.js Rows');
    const r = JSON.parse(JSON.stringify(row));
    assert.equal(r.type, 'row');
    assert.ok(r.components.length >= 1 && r.components.length <= LIMITS.buttons, '1 to 5 buttons a row');
    for (const b of r.components) {
      assert.equal(b.type, 'button');
      assert.ok(b.label.length >= 1 && b.label.length <= LIMITS.label, `label ${b.label}`);
      assert.ok(typeof b.custom_id === 'string' && b.custom_id.length <= LIMITS.customId, `custom id ${b.custom_id}`);
      ids.push(b.custom_id);
    }
    return r.components;
  });
  assert.equal(new Set(ids).size, ids.length, 'custom ids are unique within the message');
  return out;
}

describe('constants', () => {
  it('lists the button actions, the custom id prefix and the platform limits, frozen', () => {
    assert.deepEqual(BUTTON_ACTIONS, ['toggle', 'skip', 'stop', 'loop', 'voldown', 'volup']);
    assert.equal(CUSTOM_ID_PREFIX, 'music:');
    assert.deepEqual({ ...LIMITS }, {
      title: 256, description: 4096, fields: 10, fieldName: 256, fieldValue: 1024, total: 6000,
      rows: 5, buttons: 5, label: 80, customId: 100,
    });
    assert.ok(Object.isFrozen(BUTTON_ACTIONS) && Object.isFrozen(LIMITS));
  });
});

describe('formatDuration', () => {
  it('formats seconds as m:ss, or h:mm:ss from an hour on (fractions dropped)', () => {
    const cases = [[0, '0:00'], [5, '0:05'], [59.999, '0:59'], [60, '1:00'], [65, '1:05'], [599, '9:59'],
      [3599, '59:59'], [3600, '1:00:00'], [3725, '1:02:05'], [86399, '23:59:59'], [360000, '100:00:00'], [-0, '0:00']];
    for (const [s, want] of cases) assert.equal(formatDuration(s), want, `${s}`);
  });

  it("gives '--:--' for anything that isn't a real length", () => {
    for (const s of [null, undefined, NaN, -1, -0.5, Infinity, -Infinity, '65', {}, [], 1e20, 10n]) {
      assert.equal(formatDuration(s), '--:--', String(s));
    }
  });
});

describe('progressBar', () => {
  it('draws the knob where the position is (the README example)', () => {
    assert.equal(progressBar(30, 100), '▬▬▬▬🔘▬▬▬▬▬▬▬▬▬');
    assert.equal(progressBar(0, 100), `🔘${'▬'.repeat(13)}`);
    assert.equal(progressBar(100, 100), `${'▬'.repeat(13)}🔘`);
    assert.equal(progressBar(50, 100), `${'▬'.repeat(7)}🔘${'▬'.repeat(6)}`);
  });

  it('clamps the position to the track', () => {
    assert.equal(progressBar(500, 100), progressBar(100, 100));
    for (const p of [-5, NaN, null, undefined, '50', Infinity]) assert.equal(progressBar(p, 100), progressBar(0, 100));
  });

  it('is `width` symbols wide (1 to 50; junk gives 14)', () => {
    for (const w of [1, 2, 5, 14, 50]) assert.equal([...progressBar(10, 100, w)].length, w, `width ${w}`);
    assert.equal([...progressBar(10, 100, 500)].length, 50);
    assert.equal([...progressBar(10, 100, 0)].length, 1);
    for (const w of [NaN, '20', null]) assert.equal([...progressBar(10, 100, w)].length, 14);
    assert.equal(progressBar(1, 2, 5.9), progressBar(1, 2, 5));
  });

  it("is '' when the duration is unknown", () => {
    for (const d of [null, undefined, 0, -5, NaN, Infinity, '100', 1e20]) {
      assert.equal(progressBar(10, d), '', String(d));
    }
  });
});

describe('truncate', () => {
  it('leaves text that fits alone', () => {
    assert.equal(truncate('hello', 10), 'hello');
    assert.equal(truncate('hello', 5), 'hello');
    assert.equal(truncate('line 1\nline 2', 100), 'line 1\nline 2');
    const long = 'x'.repeat(10_000);
    assert.equal(truncate(long), long, 'no max: no limit');
  });

  it('cuts to at most max characters, ending in an ellipsis (never after a space)', () => {
    assert.equal(truncate('hello world', 8), 'hello w…');
    assert.equal(truncate('hello world', 7), 'hello…');
    assert.equal(truncate('hello world', 6), 'hello…');
    assert.equal(truncate('abc', 1), '…');
    for (const max of [0, -3, NaN, null]) assert.equal(truncate('abc', max), '', String(max));
  });

  it('never splits an emoji or an accented letter', () => {
    const text = 'ab👨‍👩‍👧cde\u0301f';
    for (let max = 1; max <= text.length; max++) {
      const out = truncate(text, max);
      assert.ok(out.length <= max);
      assert.ok(out.includes('👨‍👩‍👧') || !out.includes('👨'), `half a family at ${max}: ${out}`);
      assert.ok(out.includes('e\u0301') || !out.includes('e'), `accent lost at ${max}: ${out}`);
      assert.doesNotMatch(out, LONE_SURROGATE);
    }
  });

  it('still keeps surrogate pairs whole without Intl.Segmenter (Node built without ICU)', async () => {
    const segmenter = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    delete Intl.Segmenter;
    let bare;
    try {
      bare = await import('../src/ui.js?without-icu'); // a fresh copy of the module, made while there is no Segmenter
    } finally {
      Object.defineProperty(Intl, 'Segmenter', segmenter);
    }
    assert.equal(bare.truncate('ab👍cd', 4), 'ab…');
    for (let max = 1; max <= 12; max++) {
      for (const out of [bare.truncate('a👍b🇳🇱c👨‍👩‍👧', max), bare.sanitize('*👍@🇳🇱<👨‍👩‍👧', max)]) {
        assert.ok(out.length <= max);
        assert.doesNotMatch(out, LONE_SURROGATE, `max ${max}: ${JSON.stringify(out)}`);
      }
    }
  });

  it('shows non-text as nothing and numbers as text', () => {
    assert.equal(truncate(null, 5), '');
    assert.equal(truncate({ toString: () => 'boom' }, 5), '');
    assert.equal(truncate(42, 5), '42');
  });

  it('keeps a prefix cut between graphemes, for any input (seeded random)', () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 400; i++) {
      const text = randomText(rnd, Math.floor(rnd() * 30));
      const max = Math.floor(rnd() * 40);
      const out = truncate(text, max);
      assert.ok(out.length <= max, JSON.stringify({ text, max, out }));
      assert.doesNotMatch(out, LONE_SURROGATE);
      if (text.length <= max) assert.equal(out, text);
      else if (max === 0) assert.equal(out, '');
      else {
        assert.ok(out.endsWith('…'));
        const kept = out.slice(0, -1);
        assert.ok(text.startsWith(kept) && boundaries(text).has(kept.length), JSON.stringify({ text, max, out }));
      }
    }
  });
});

describe('sanitize', () => {
  it('escapes every markdown character', () => {
    assert.equal(sanitize('*_~`|[]()>#\\'), '\\*\\_\\~\\`\\|\\[\\]\\(\\)\\>\\#\\\\');
    assert.equal(sanitize('Daft Punk - One More Time (Radio Edit).mp3'),
      'Daft Punk - One More Time \\(Radio Edit\\).mp3');
    assert.equal(sanitize('[click](https://evil.example)'), '\\[click\\]\\(https://evil.example\\)');
  });

  it('defuses @everyone, @here and <@id>/<@&id>/<#id> mentions with a zero-width space', () => {
    assert.equal(sanitize('@everyone'), `@${ZWSP}everyone`);
    assert.equal(sanitize('hi @here'), `hi @${ZWSP}here`);
    assert.equal(sanitize('<@123>'), `<${ZWSP}@${ZWSP}123\\>`);
    assert.equal(sanitize('<@!42>'), `<${ZWSP}@${ZWSP}!42\\>`);
    assert.equal(sanitize('<@&456>'), `<${ZWSP}@${ZWSP}&456\\>`);
    assert.equal(sanitize('<#789>'), `<${ZWSP}\\#789\\>`);
    assert.equal(sanitize('Live @ Wembley'), `Live @${ZWSP} Wembley`);
  });

  it('puts the text on one line, without control characters or bidi overrides', () => {
    assert.equal(sanitize('a\nb\r\nc\td\u2028e\u0085f   g\u00a0\u3000h'), 'a b c d e f g h');
    assert.equal(sanitize('  \n x \t '), 'x');
    assert.equal(sanitize('a\u0000b\u001bc\u202ed\u2066e\u007f\u009bf'), 'abcdef');
  });

  it('cuts to max characters (100 by default), escapes included, never inside one', () => {
    const cut = sanitize('x'.repeat(500));
    assert.equal(cut.length, 100);
    assert.ok(cut.endsWith('…'));
    const stars = sanitize('*'.repeat(80), 100);
    assert.equal(stars, `${'\\*'.repeat(49)}…`);
    assertSafe(stars);
    assert.equal(sanitize('ab cd', 4), 'ab…');
    assert.equal(sanitize('abc', 0), '');
    assert.equal(sanitize('abc', 1), '…');
    assert.equal(sanitize('abc', 2.9), 'a…');
  });

  it('keeps bold text bold whatever the input and the cut', () => {
    for (let max = 1; max <= 120; max++) {
      const out = sanitize(NASTY, max);
      assert.ok(out.length <= max);
      assert.equal(liveStars(`**${out}**`), 4, `max ${max}: ${JSON.stringify(out)}`);
      assertSafe(out);
    }
  });

  it('shows empty or non-text input as nothing', () => {
    for (const v of ['', ' \n\t ', null, undefined, {}, [], Symbol('s'), () => 'x', '\u0000\u202e']) {
      assert.equal(sanitize(v), '', String(typeof v));
    }
    assert.equal(sanitize(42), '42');
    assert.equal(sanitize(true), 'true');
  });

  it('is always safe and at most max characters, for any input (seeded random)', () => {
    const rnd = mulberry32(42);
    for (let i = 0; i < 500; i++) {
      const text = randomText(rnd, Math.floor(rnd() * 40));
      const max = Math.floor(rnd() * 80);
      const out = sanitize(text, max);
      assert.ok(out.length <= max, JSON.stringify({ text, max, out }));
      assertSafe(out);
      const full = sanitize(text, Infinity);
      if (full.length <= max) assert.equal(out, full);
      else if (max > 0) {
        assert.ok(out.endsWith('…') && full.startsWith(out.slice(0, -1)), JSON.stringify({ full, out }));
      }
    }
  });
});

describe('loopLabel', () => {
  it('names each loop mode, and anything else Off', () => {
    assert.equal(loopLabel('off'), 'Off');
    assert.equal(loopLabel('track'), 'Track');
    assert.equal(loopLabel('queue'), 'Queue');
    for (const m of ['QUEUE', 'all', '', null, undefined, 'constructor', '__proto__']) {
      assert.equal(loopLabel(m), 'Off', String(m));
    }
  });
});

describe('customId / parseCustomId', () => {
  it('makes music:<action>:<serverId> and reads it back, for every action', () => {
    assert.equal(customId('skip', 'srv1'), 'music:skip:srv1');
    for (const action of BUTTON_ACTIONS) {
      for (const serverId of ['srv1', '0b7c1f2e-9a4d-4c55-8e21-77aa0c3d9f10', 'a:b', 'ünï']) {
        assert.deepEqual(parseCustomId(customId(action, serverId)), { action, serverId });
      }
    }
    assert.equal(customId('stop', 42), 'music:stop:42');
    assert.deepEqual(parseCustomId(customId('stop', 42)), { action: 'stop', serverId: '42' });
  });

  it('throws a TypeError for an unknown action or a missing/malformed server id', () => {
    for (const action of ['pause', '', 'TOGGLE', null, undefined, 'constructor']) {
      assert.throws(() => customId(action, 'srv1'), TypeError, String(action));
    }
    for (const serverId of ['', ' ', 'a b', 'x\ny', 'a\u0000', null, undefined, {}, -1, 1.5, NaN]) {
      assert.throws(() => customId('skip', serverId), TypeError, String(serverId));
    }
  });

  it('throws a RangeError past 100 characters', () => {
    const fits = 'x'.repeat(100 - 'music:voldown:'.length);
    assert.equal(customId('voldown', fits).length, 100);
    assert.throws(() => customId('voldown', `${fits}x`), RangeError);
    assert.equal(customId('skip', 'y'.repeat(89)).length, 100);
  });

  it('parses exactly 100 characters but not 101', () => {
    const id = `music:toggle:${'x'.repeat(87)}`;
    assert.equal(id.length, 100);
    assert.deepEqual(parseCustomId(id), { action: 'toggle', serverId: 'x'.repeat(87) });
    assert.equal(parseCustomId(`${id}x`), null);
  });

  it('rejects unknown actions, missing server ids, other prefixes and non-strings', () => {
    const bad = ['music:pause:1', 'music:TOGGLE:1', 'music:toggle:', 'music:toggle', 'music:', 'music::1', 'music',
      'vote:toggle:1', 'Music:toggle:1', ' music:toggle:1', 'music:toggle:1 2', 'music:toggle:a\u0000',
      'music:constructor:1', '', null, undefined, 42, {}, ['music:toggle:1'], Symbol('x')];
    for (const id of bad) assert.equal(parseCustomId(id), null, String(typeof id === 'symbol' ? 'symbol' : id));
  });
});

describe('controlRows', () => {
  const buttons = (s, opts) => checkRows(controlRows(s, opts));
  const byAction = (s) => Object.fromEntries(buttons(s).flat().map((b) => [parseCustomId(b.custom_id).action, b]));

  it('lays out Pause, Skip, Stop / Loop, Vol -, Vol + with the right styles and ids', () => {
    const rows = buttons(snapshot());
    assert.deepEqual(rows.map((r) => r.map((b) => [b.label, b.style])), [
      [['⏯ Pause', 'primary'], ['⏭ Skip', 'secondary'], ['⏹ Stop', 'danger']],
      [['🔁 Loop: Off', 'secondary'], ['🔉 Vol -', 'secondary'], ['🔊 Vol +', 'secondary']],
    ]);
    assert.deepEqual(rows.flat().map((b) => parseCustomId(b.custom_id)),
      BUTTON_ACTIONS.map((action) => ({ action, serverId: 'srv1' })));
  });

  it('shows Resume (success) instead of Pause (primary) while paused', () => {
    const { label, style } = byAction(snapshot({ paused: true })).toggle;
    assert.deepEqual([label, style], ['⏯ Resume', 'success']);
    assert.equal(byAction(snapshot({ paused: false })).toggle.label, '⏯ Pause');
  });

  it('names the loop mode on the loop button', () => {
    for (const [loop, label] of [['off', 'Off'], ['track', 'Track'], ['queue', 'Queue'], ['bogus', 'Off']]) {
      assert.equal(byAction(snapshot({ loop })).loop.label, `🔁 Loop: ${label}`);
    }
  });

  it('disables Vol - exactly at the minimum and Vol + exactly at the maximum', () => {
    assert.equal(MIN_VOLUME, 1);
    assert.equal(MAX_VOLUME, 200);
    const cases = [[1, true, false], [2, false, false], [100, false, false], [199, false, false], [200, false, true],
      [0, true, false], [250, false, true], [NaN, false, false], [undefined, false, false]];
    for (const [volume, down, up] of cases) {
      const b = byAction(snapshot({ volume }));
      assert.equal(b.voldown.disabled === true, down, `Vol - at ${volume}`);
      assert.equal(b.volup.disabled === true, up, `Vol + at ${volume}`);
      assert.ok(!b.toggle.disabled && !b.skip.disabled && !b.stop.disabled && !b.loop.disabled);
    }
  });

  it("doesn't depend on volumeStep", () => {
    const one = JSON.stringify(controlRows(snapshot({ volume: 195 }), { volumeStep: 5 }));
    assert.equal(JSON.stringify(controlRows(snapshot({ volume: 195 }), { volumeStep: 50 })), one);
    assert.equal(JSON.stringify(controlRows(snapshot({ volume: 195 }))), one);
  });

  it('gives no buttons when the server id cannot go in a custom id', () => {
    for (const serverId of [undefined, null, '', 'a b', 'x'.repeat(87)]) {
      assert.deepEqual(controlRows(snapshot({ serverId })), [], String(serverId));
    }
    assert.deepEqual(controlRows(null), []);
    assert.equal(buttons(snapshot({ serverId: 'x'.repeat(86) })).flat().length, 6, 'the longest id that fits');
  });
});

describe('nowPlayingEmbed', () => {
  it('shows a file: bold title + artist, progress bar and time, the fields and the footer', () => {
    assert.deepEqual(checkEmbed(nowPlayingEmbed(snapshot())), {
      title: '🎶 Now Playing',
      color: PINK,
      description: '**Song A** — Band\n▬▬▬▬▬🔘▬▬▬▬▬▬▬▬  `1:23 / 3:45`',
      fields: [
        { name: 'Requested by', value: '<@u1>', inline: true },
        { name: 'Volume', value: '100%', inline: true },
        { name: 'Loop', value: 'Off', inline: true },
        { name: 'Up next', value: 'Song B · `3:00`', inline: false },
      ],
      footer: { text: '🔊 Lounge · 2 in queue' },
    });
  });

  it("says '⏸ Paused' while paused", () => {
    assert.equal(checkEmbed(nowPlayingEmbed(snapshot({ paused: true }))).title, '⏸ Paused');
  });

  it('shows a live stream as 🔴 LIVE with the station description, without a progress bar', () => {
    const e = checkEmbed(nowPlayingEmbed(snapshot({ current: stationTrack(), position: 4000 })));
    assert.equal(e.description, '**SomaFM · Groove Salad**\n🔴 LIVE · Ambient beats and grooves');
    assert.equal(e.url, 'https://somafm.com/groovesalad/');
    assert.equal(e.fields[0].value, '<@u2>');
    const bare = checkEmbed(nowPlayingEmbed(snapshot({ current: stationTrack({ description: null }) })));
    assert.equal(bare.description, '**SomaFM · Groove Salad**\n🔴 LIVE');
    for (const d of [e.description, bare.description]) assert.doesNotMatch(d, /[🔘▬]|\d:\d\d/u);
  });

  it("shows the position and 'length unknown' for a file with no known length", () => {
    for (const duration of [null, undefined, 0, NaN, Infinity]) {
      const e = checkEmbed(nowPlayingEmbed(snapshot({ current: fileTrack('Song A', { duration }) })));
      assert.equal(e.description, '**Song A**\n`1:23` · length unknown', String(duration));
    }
  });

  it('falls back to the file name, then the station id, when a track has no title', () => {
    const head = (current) => checkEmbed(nowPlayingEmbed(snapshot({ current }))).description.split('\n')[0];
    assert.equal(head(fileTrack(' \n', { fileName: 'my_song.mp3' })), '**my\\_song.mp3**');
    assert.equal(head(stationTrack({ title: undefined })), '**groovesalad**');
    assert.equal(head(stationTrack({ title: null, stationId: null })), '**Unknown track**');
  });

  it('gives a long title most of the room and a long artist the rest', () => {
    const head = (title, artist) =>
      checkEmbed(nowPlayingEmbed(snapshot({ current: fileTrack(title, { artist }) }))).description.split('\n')[0];
    const both = head('T'.repeat(400), 'A'.repeat(400));
    const [, title, artist] = /^\*\*(T+…)\*\* — (A+…)$/.exec(both);
    assert.ok(title.length >= 190 && artist.length >= 90, `${title.length} + ${artist.length}`);
    assert.ok(both.length <= 304);
    assert.match(head('Hi', 'A'.repeat(400)), /^\*\*Hi\*\* — A{250,}…$/, 'a short title leaves the artist more room');
    assert.equal(head('Hi', ' \n '), '**Hi**', 'a blank artist is left out');
  });

  it('keeps the time inside the track', () => {
    const e = checkEmbed(nowPlayingEmbed(snapshot({ position: 300 })));
    assert.equal(e.description.split('\n')[1], `${'▬'.repeat(13)}🔘  \`3:45 / 3:45\``);
    for (const position of [-4, NaN, null, '83']) {
      const d = checkEmbed(nowPlayingEmbed(snapshot({ position }))).description;
      assert.equal(d.split('\n')[1], `🔘${'▬'.repeat(13)}  \`0:00 / 3:45\``);
    }
  });

  it('links the title only to https urls', () => {
    const cases = [
      ['https://somafm.com/groovesalad/', 'https://somafm.com/groovesalad/'],
      ['https://example.com/a b', 'https://example.com/a%20b'],
      ['http://somafm.com/', undefined], ['javascript:alert(1)', undefined], ['ftp://example.com/x', undefined],
      ['https://user:pw@evil.example/', undefined], ['https://', undefined], ['not a url', undefined],
      [`https://example.com/${'a'.repeat(3000)}`, undefined], [42, undefined], [null, undefined],
    ];
    for (const [url, want] of cases) {
      const e = checkEmbed(nowPlayingEmbed(snapshot({ current: fileTrack('Song A', { url }) })));
      assert.equal(e.url, want, String(url));
    }
  });

  it('mentions the requester when the id looks like one, else shows a dash', () => {
    const cases = [['u1', '<@u1>'], ['0b7c1f2e-9a4d-4c55-8e21-77aa0c3d9f10', '<@0b7c1f2e-9a4d-4c55-8e21-77aa0c3d9f10>'],
      [12345, '<@12345>'], [null, '—'], [undefined, '—'], ['', '—'], ['a b', '—'], ['<@everyone>', '—'],
      ['@everyone', '—'], ['x'.repeat(65), '—'], [-1, '—'], [1.5, '—']];
    for (const [requestedBy, want] of cases) {
      const e = checkEmbed(nowPlayingEmbed(snapshot({ current: fileTrack('Song A', { requestedBy }) })));
      assert.equal(e.fields[0].value, want, String(requestedBy));
    }
  });

  it('shows the next track (falling back to the first waiting one) or a dash', () => {
    const upNext = (extra) => checkEmbed(nowPlayingEmbed(snapshot(extra))).fields[3].value;
    assert.equal(upNext({ next: null }), '—');
    assert.equal(upNext({ next: undefined }), 'Song B · `3:00`');
    assert.equal(upNext({ upcoming: [], next: undefined }), '—');
    assert.equal(upNext({ next: stationTrack() }), 'SomaFM · Groove Salad · 🔴 LIVE');
    assert.equal(upNext({ next: fileTrack('Song Z', { duration: null, artist: 'Who' }) }), 'Song Z — Who · `--:--`');
    assert.equal(upNext({ next: 'Song B' }), '—');
  });

  it('shows the volume as a clamped percentage and the loop mode', () => {
    const cases = [[100, '100%'], [150, '150%'], [1, '1%'], [250, '200%'], [0, '1%'], [99.6, '100%'], [NaN, '—'],
      ['100', '—'], [undefined, '—']];
    for (const [volume, want] of cases) {
      assert.equal(checkEmbed(nowPlayingEmbed(snapshot({ volume }))).fields[1].value, want, String(volume));
    }
    assert.equal(checkEmbed(nowPlayingEmbed(snapshot({ loop: 'queue' }))).fields[2].value, 'Queue');
  });

  it('keeps the footer plain text: only the count without a channel; pings defused, markdown left alone', () => {
    assert.equal(checkEmbed(nowPlayingEmbed(snapshot({ channelName: null }))).footer.text, '2 in queue');
    assert.equal(checkEmbed(nowPlayingEmbed(snapshot({ channelName: '**chill** @everyone' }))).footer.text,
      `🔊 **chill** @${ZWSP}everyone · 2 in queue`);
    const many = checkEmbed(nowPlayingEmbed(snapshot({ upcoming: numbered(40) })));
    assert.equal(many.footer.text, '🔊 Lounge · 40 in queue');
  });

  it('says so when nothing is playing, whatever the snapshot', () => {
    for (const s of [snapshot({ current: null, paused: true }), null, undefined, 42, {}, { upcoming: 'nope' }]) {
      const e = checkEmbed(nowPlayingEmbed(s));
      assert.equal(e.title, '🎶 Now Playing');
      assert.match(e.description, /Nothing is playing/);
      assert.equal(e.fields[0].value, '—');
    }
  });

  it('uses the colour given, or the bot pink for anything it cannot use', () => {
    const color = (c) => checkEmbed(nowPlayingEmbed(snapshot(), { color: c })).color;
    assert.equal(color('#57f287'), 0x57f287);
    assert.equal(color('57F287'), 0x57f287);
    assert.equal(color(0x123456), 0x123456);
    assert.equal(color('red'), 0xed4245);
    for (const c of [undefined, 'nope', '#12345', NaN, -1, 0x1000000, null]) assert.equal(color(c), PINK, String(c));
    assert.equal(checkEmbed(nowPlayingEmbed(snapshot())).color, PINK);
  });

  it('stays inside the limits for hostile input, the title bold and everything escaped', () => {
    const s = snapshot({
      current: hostileTrack(), next: hostileTrack(), channelName: HUGE, upcoming: Array(1000).fill(null),
    });
    for (const live of [false, true]) {
      const e = checkEmbed(nowPlayingEmbed({ ...s, current: { ...s.current, live } }));
      const [head] = e.description.split('\n');
      assert.equal(liveStars(head), 4, 'the title is the only bold');
      assertSafe(head.slice(2, head.indexOf('** — ')));
      assert.equal(e.fields[0].value, `<@${'x'.repeat(64)}>`);
      assert.equal(e.url, undefined, 'a 3000-character url is no link');
      assert.ok(e.footer.text.endsWith(' · 1000 in queue'));
    }
  });
});

describe('endedEmbed', () => {
  it('shows the status line, then the track in bold', () => {
    const e = checkEmbed(endedEmbed(fileTrack('Song A', { artist: 'Band' }), '⏭ Skipped by <@u9>'));
    assert.deepEqual(e, { color: PINK, description: '⏭ Skipped by <@u9>\n**Song A** — Band' });
    assert.equal(checkEmbed(endedEmbed(stationTrack(), '⏹ Stopped', { color: 'grey' })).color, 0x95a5a6);
  });

  it('escapes the status line like sanitize(), keeping <@id> user mentions whole, on one line', () => {
    const e = checkEmbed(endedEmbed(null, '⏹ Stopped by <@u9>\n@everyone @HERE <@&123> <#4> <@!5> **x_y**'));
    assert.equal(e.description, `⏹ Stopped by <@u9> @${ZWSP}everyone @${ZWSP}HERE <${ZWSP}@${ZWSP}&123\\> `
      + `<${ZWSP}\\#4\\> <${ZWSP}@${ZWSP}!5\\> \\*\\*x\\_y\\*\\*`);
    assert.equal(checkEmbed(endedEmbed(null, '⏭ Skipped by <@a> and <@b>')).description, '⏭ Skipped by <@a> and <@b>');
  });

  it('never cuts a mention or an escape in half', () => {
    const text = `⏭ Skipped by ${'*'.repeat(140)} <@${'u'.repeat(64)}> ${'x'.repeat(200)}`;
    const line = checkEmbed(endedEmbed(null, text)).description;
    assert.ok(line.length <= 300 && line.endsWith('…'));
    assert.ok(line.includes(`<@${'u'.repeat(64)}>`) || !line.includes('<@'));
    assertSafe(line.replace(/<@u+>/, 'm').replace(/^⏭ /, ''));
  });

  it('works without a track or a text', () => {
    assert.equal(checkEmbed(endedEmbed(null, '✅ Finished the queue')).description, '✅ Finished the queue');
    assert.equal(checkEmbed(endedEmbed(fileTrack('Song A'), '')).description, '**Song A**');
    assert.equal(checkEmbed(endedEmbed(null, null)).description, 'Finished.');
  });

  it('stays inside the limits for hostile input, the status line unable to unbalance the bold title', () => {
    const e = checkEmbed(endedEmbed(hostileTrack(), HUGE));
    assert.ok(e.description.length <= 700);
    const [status, title] = e.description.split('\n');
    assert.equal(liveStars(status), 0);
    assert.equal(liveStars(title), 4);
  });
});

describe('queueEmbed', () => {
  /** The numbers of the '**N.**' lines in an embed's description. */
  const lineNumbers = (e) => e.description.split('\n').filter((l) => /^\*\*\d+\.\*\* /.test(l))
    .map((l) => parseInt(l.slice(2), 10));

  it("shows what's playing, then the waiting tracks with length and requester", () => {
    assert.deepEqual(checkEmbed(queueEmbed(snapshot())), {
      title: '📜 Queue',
      color: PINK,
      description: '**Now playing**\n▶️ Song A — Band · `1:23 / 3:45` · <@u1>\n\n**Up next**\n'
        + '**1.** Song B · `3:00` · <@u1>\n**2.** Song C · `3:20` · <@u1>',
      footer: { text: 'Page 1/1 · 2 tracks · total 6:20 · Loop: Off' },
    });
  });

  it('marks a paused or live current track', () => {
    const paused = checkEmbed(queueEmbed(snapshot({ paused: true })));
    assert.equal(paused.description.split('\n')[1], '⏸ Song A — Band · `1:23 / 3:45` · <@u1>');
    const live = checkEmbed(queueEmbed(snapshot({ current: stationTrack() })));
    assert.equal(live.description.split('\n')[1], '▶️ SomaFM · Groove Salad · 🔴 LIVE · <@u2>');
    assert.ok(!live.footer.text.includes('live'), 'the total only counts waiting tracks');
  });

  it('gives a friendly line for an empty queue', () => {
    const e = checkEmbed(queueEmbed(snapshot({ current: null, upcoming: [], loop: 'queue' })));
    assert.match(e.description, /queue is empty/);
    assert.match(e.description, /\/play/);
    assert.equal(e.footer.text, 'Loop: Queue');
    assert.match(checkEmbed(queueEmbed(null)).description, /queue is empty/);
  });

  it('says when nothing is waiting behind the current track', () => {
    const e = checkEmbed(queueEmbed(snapshot({ upcoming: [] })));
    assert.match(e.description, /\*\*Up next\*\*\nNothing else is queued/);
    assert.equal(e.footer.text, 'Page 1/1 · 0 tracks · Loop: Off');
  });

  it('leaves out the now-playing part while nothing plays yet', () => {
    const e = checkEmbed(queueEmbed(snapshot({ current: null })));
    assert.ok(e.description.startsWith('**Up next**\n**1.** Song B'));
  });

  it('pages the waiting tracks, numbered as /remove counts', () => {
    const s = snapshot({ upcoming: numbered(25) });
    assert.deepEqual(lineNumbers(checkEmbed(queueEmbed(s))), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(lineNumbers(checkEmbed(queueEmbed(s, { page: 2 }))), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const last = checkEmbed(queueEmbed(s, { page: 3 }));
    assert.deepEqual(lineNumbers(last), [21, 22, 23, 24, 25]);
    assert.ok(last.description.includes('**21.** Track 21 · `1:00` · <@u1>'));
    assert.equal(last.footer.text, 'Page 3/3 · 25 tracks · total 25:00 · Loop: Off');
  });

  it('clamps the page to [1, pages] and the page size to [1, 25]', () => {
    const s = snapshot({ upcoming: numbered(25) });
    const pageOf = (opts) => checkEmbed(queueEmbed(s, opts)).footer.text.split(' · ')[0];
    const cases = [[0, 'Page 1/3'], [-5, 'Page 1/3'], [99, 'Page 3/3'], [2.7, 'Page 2/3'], [NaN, 'Page 1/3'],
      ['2', 'Page 1/3'], [Infinity, 'Page 1/3']];
    for (const [page, want] of cases) assert.equal(pageOf({ page }), want, String(page));
    assert.equal(pageOf({ pageSize: 1000 }), 'Page 1/1');
    const big = checkEmbed(queueEmbed(snapshot({ upcoming: numbered(60) }), { pageSize: 1000 }));
    assert.equal(lineNumbers(big).length, 25);
    assert.equal(pageOf({ pageSize: 0 }), 'Page 1/25');
    assert.equal(pageOf({ pageSize: 'x' }), 'Page 1/3');
  });

  it("adds up the waiting tracks, with '+ live' / '+ unknown' for those without a length", () => {
    const total = (upcoming) => checkEmbed(queueEmbed(snapshot({ upcoming }))).footer.text.split(' · ')[2];
    const b = fileTrack('B', { duration: 180 });
    const unknown = fileTrack('X', { duration: null });
    assert.equal(total([b, stationTrack()]), 'total 3:00 + live');
    assert.equal(total([b, unknown]), 'total 3:00 + unknown');
    assert.equal(total([b, unknown, stationTrack()]), 'total 3:00 + unknown + live');
    assert.equal(total([stationTrack()]), 'total live');
    assert.equal(total([unknown]), 'total unknown');
    assert.equal(total(numbered(70)), 'total 1:10:00');
  });

  it('shows broken entries as unknown tracks, keeping the numbering', () => {
    const e = checkEmbed(queueEmbed(snapshot({ upcoming: [fileTrack('B'), null, 'junk', fileTrack('D')] })));
    assert.deepEqual(lineNumbers(e), [1, 2, 3, 4]);
    assert.ok(e.description.includes('**2.** Unknown track · `--:--`'));
  });

  it('stays inside the limits with 100 hostile tracks, showing every line of every page', () => {
    const s = snapshot({ current: hostileTrack(), upcoming: Array.from({ length: 100 }, () => hostileTrack()) });
    for (const pageSize of [10, 25]) {
      for (let page = 1; page <= 100 / pageSize; page++) {
        const e = checkEmbed(queueEmbed(s, { page, pageSize }));
        assert.equal(lineNumbers(e).length, pageSize);
        for (const line of e.description.split('\n').filter((l) => /^\*\*\d+\.\*\* /.test(l))) {
          assert.ok(line.endsWith(` · \`277777:46:40\` · <@${'x'.repeat(64)}>`), line);
        }
      }
    }
  });
});

describe('trackAddedEmbed', () => {
  const field = (e, name) => e.fields?.find((f) => f.name === name)?.value;
  const added = fileTrack('New', { duration: 100 });

  it('shows the track, its position, its length and when it starts', () => {
    const s = snapshot({ upcoming: [...snapshot().upcoming, added] });
    assert.deepEqual(checkEmbed(trackAddedEmbed(added, 3, s)), {
      title: '➕ Added to queue',
      color: PINK,
      description: '**New**',
      fields: [
        { name: 'Position', value: '#3', inline: true },
        { name: 'Length', value: '1:40', inline: true },
        { name: 'Starts in', value: '~8:42', inline: true },
      ],
    });
    const before = checkEmbed(trackAddedEmbed(added, 3, snapshot()));
    assert.equal(field(before, 'Starts in'), '~8:42', 'snapshot taken before adding');
    assert.equal(field(checkEmbed(trackAddedEmbed(added, 1, snapshot({ upcoming: [added] }))), 'Starts in'), '~2:22');
    assert.equal(field(checkEmbed(trackAddedEmbed(added, 2, snapshot({ current: null }))), 'Starts in'), '~3:00');
  });

  it('leaves the start time out when something ahead has no known end', () => {
    const cases = {
      'a stream playing': snapshot({ current: stationTrack() }),
      'the current track on repeat': snapshot({ loop: 'track' }),
      'a stream ahead': snapshot({ upcoming: [fileTrack('B'), stationTrack()] }),
      'an unknown length ahead': snapshot({ upcoming: [fileTrack('B'), fileTrack('X', { duration: null })] }),
      'a position past the queue': snapshot({ upcoming: [] }),
    };
    for (const [why, s] of Object.entries(cases)) {
      assert.equal(field(checkEmbed(trackAddedEmbed(added, 3, s)), 'Starts in'), undefined, why);
    }
  });

  it('shows a station as live, with its description and link', () => {
    const e = checkEmbed(trackAddedEmbed(stationTrack(), 2, snapshot()));
    assert.equal(e.description, '**SomaFM · Groove Salad**\nAmbient beats and grooves');
    assert.equal(field(e, 'Length'), '🔴 LIVE');
    assert.equal(e.url, 'https://somafm.com/groovesalad/');
    const http = checkEmbed(trackAddedEmbed(fileTrack('x', { url: 'http://x.example/' }), 2, snapshot()));
    assert.equal(http.url, undefined);
  });

  it('leaves out what it does not know', () => {
    for (const position of [0, -1, 1.5, '3', NaN, null]) {
      const e = checkEmbed(trackAddedEmbed(fileTrack('X', { duration: null }), position, null));
      assert.equal(e.fields, undefined, String(position));
      assert.equal(e.description, '**X**');
    }
    assert.equal(checkEmbed(trackAddedEmbed(null, 1, null)).description, '**Unknown track**');
  });

  it('stays inside the limits for hostile input', () => {
    checkEmbed(trackAddedEmbed(hostileTrack(), 1e15, snapshot({ current: hostileTrack() })));
    checkEmbed(trackAddedEmbed(hostileTrack({ live: true }), 2, snapshot()));
  });
});

describe('tracksEmbed', () => {
  const files = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
    fileName: `track ${i + 1}.mp3`, path: `/Users/someone/private/music/track ${i + 1}.mp3`, title: `Track ${i + 1}`,
    ext: '.mp3', ...extra,
  }));
  const stations = [{ id: 'groovesalad', name: 'SomaFM · Groove Salad' }, { id: 'kexp', name: 'KEXP 90.3 Seattle' }];
  const lines = (e) => e.description.split('\n');

  it('numbers the files across pages: page 2 of 20 starts at 21', () => {
    const page2 = checkEmbed(tracksEmbed({ localTracks: files(45), stations, page: 2 }));
    assert.equal(page2.title, '🎵 Music library');
    assert.equal(lines(page2).length, 20);
    assert.equal(lines(page2)[0], '**21.** Track 21');
    assert.equal(lines(page2)[19], '**40.** Track 40');
    assert.equal(page2.footer.text, 'Page 2/3 · 45 files · Play: /play <number or name> or /play <station id>');
    const page3 = checkEmbed(tracksEmbed({ localTracks: files(45), page: 3 }));
    assert.deepEqual(lines(page3), [41, 42, 43, 44, 45].map((n) => `**${n}.** Track ${n}`));
    assert.equal(page3.footer.text, 'Page 3/3 · 45 files · Play: /play <number or name>');
  });

  it('clamps the page and the page size', () => {
    const first = (opts) => lines(checkEmbed(tracksEmbed({ localTracks: files(45), ...opts })))[0];
    assert.equal(first({ page: 0 }), '**1.** Track 1');
    assert.equal(first({ page: 99 }), '**41.** Track 41');
    assert.equal(first({ page: 2, pageSize: 10 }), '**11.** Track 11');
    assert.equal(lines(checkEmbed(tracksEmbed({ localTracks: files(200), pageSize: 500 }))).length, 50);
  });

  it('uses the file name when there is no title, and never the path', () => {
    const e = checkEmbed(tracksEmbed({ localTracks: [{ fileName: 'a_b.mp3', path: '/Users/someone/private/a_b.mp3' },
      { path: '/Users/someone/private/x.mp3' }, null, { title: '**loud** @everyone' }] }));
    assert.deepEqual(lines(e), ['**1.** a\\_b.mp3', '**2.** Unknown file', '**3.** Unknown file',
      `**4.** \\*\\*loud\\*\\* @${ZWSP}everyone`]);
    assert.ok(!JSON.stringify(e).includes('/Users/'));
    assert.equal(e.footer.text, 'Page 1/1 · 4 files · Play: /play <number or name>');
  });

  it('explains where music goes when there is none, naming ./music and the formats', () => {
    const e = checkEmbed(tracksEmbed({ localTracks: [], stations: [] }));
    assert.equal(e.description, 'No music files yet. Put .mp3, .wav, .flac, .ogg, .opus or .m4a files in `./music` and '
      + 'they show up here, no restart needed.');
    assert.equal(e.footer, undefined);
    assert.equal(e.fields, undefined);
    assert.equal(checkEmbed(tracksEmbed()).description, e.description);
    const custom = checkEmbed(tracksEmbed({ folder: 'songs `x`', extensions: ['.mp3', '.flac'] }));
    assert.match(custom.description, /^No music files yet\. Put \.mp3 or \.flac files in `songs ˋxˋ` and/);
    assert.match(checkEmbed(tracksEmbed({ extensions: [] })).description, /Put audio files in/);
  });

  it('lists each station as its `id` and name', () => {
    const e = checkEmbed(tracksEmbed({ stations: [...stations, { name: 'No id' }, { id: 'noname' }, null] }));
    assert.deepEqual(e.fields, [{
      name: '📻 Radio stations', inline: false,
      value: '`groovesalad` — SomaFM · Groove Salad\n`kexp` — KEXP 90.3 Seattle\n`noname` — noname',
    }]);
    assert.match(e.description, /^No music files yet/);
    assert.equal(e.footer.text, 'Play: /play <station id>');
  });

  it('cuts a long station list at a whole line, saying how many are left', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `station-${i + 1}`, name: `${'Very long name '.repeat(6)}${i}`,
    }));
    const value = checkEmbed(tracksEmbed({ stations: many })).fields[0].value;
    assert.ok(value.length <= LIMITS.fieldValue);
    const shown = value.split('\n');
    const more = /^… and (\d+) more$/.exec(shown.pop());
    assert.ok(more, 'ends with a count of the rest');
    assert.equal(shown.length + Number(more[1]), 50);
    shown.forEach((line, i) => assert.ok(line.startsWith(`\`station-${i + 1}\` — Very long name`), line));
  });

  it('keeps room for the summary line even when whole lines nearly fill the field', () => {
    // 101-character lines: ten of them take 1019 of the 1024 characters, leaving no room for the "and 30 more" line.
    const exact = Array.from({ length: 40 }, (_, i) => ({
      id: `station-${String(i).padStart(10, '0')}`, name: 'n'.repeat(78),
    }));
    const value = checkEmbed(tracksEmbed({ stations: exact })).fields[0].value;
    const shown = value.split('\n');
    assert.equal(shown[0].length, 101);
    assert.equal(shown.pop(), '… and 31 more');
    assert.equal(shown.length, 9);
  });

  it('stays inside the limits with 1000 hostile files and 50 hostile stations', () => {
    const localTracks = files(1000, { title: HUGE, fileName: HUGE });
    const radios = Array.from({ length: 50 }, (_, i) => ({ id: `${HUGE}${i}`, name: HUGE }));
    for (const page of [1, 7, 50]) {
      for (const pageSize of [20, 50]) {
        const e = checkEmbed(tracksEmbed({ localTracks, stations: radios, page, pageSize }));
        assert.equal(lines(e).length, pageSize);
        assert.equal(lines(e)[0].startsWith(`**${(Math.min(page, 1000 / pageSize) - 1) * pageSize + 1}.** `), true);
        lines(e).forEach((line) => assertSafe(line.replace(/^\*\*\d+\.\*\* /, '')));
      }
    }
  });
});

describe('helpEmbed', () => {
  const commands = [
    ['play', 'Play a song, a number from /tracks, a station or a URL'], ['tracks', 'List local music and stations'],
    ['queue', 'Show the queue'], ['skip', 'Skip the current track'], ['pause', 'Pause'], ['resume', 'Resume'],
    ['volume', 'Set the volume (1-200%)'], ['nowplaying', "Show what's playing"], ['stop', 'Stop and leave voice'],
    ['ping', 'Check the bot is alive'], ['loop', 'Loop off, track or queue'], ['shuffle', 'Shuffle the queue'],
    ['remove', 'Remove a track from the queue'], ['clear', 'Clear the queue'], ['help', 'Show this list'],
  ].map(([name, description]) => ({ name, description }));

  it('lists every command as `/name` and its description, in order', () => {
    const e = checkEmbed(helpEmbed(commands));
    assert.equal(e.title, '🎧 Commands');
    const shown = e.description.split('\n');
    assert.equal(shown.length, 15);
    assert.equal(shown[0], '`/play` — Play a song, a number from /tracks, a station or a URL');
    assert.equal(shown[6], '`/volume` — Set the volume \\(1-200%\\)');
    assert.deepEqual(shown.map((l) => /^`\/([a-z]+)`/.exec(l)[1]), commands.map((c) => c.name));
    assert.match(e.footer.text, /buttons/);
  });

  it('escapes descriptions and skips entries that are not commands', () => {
    const e = checkEmbed(helpEmbed([{ name: '/Play', description: '**loud** @everyone\nnow' }, { name: 'Bad Name' },
      null, 42, { name: '' }, { name: 'x'.repeat(33) }, 'skip', { name: 'stop' }]));
    assert.deepEqual(e.description.split('\n'),
      [`\`/play\` — \\*\\*loud\\*\\* @${ZWSP}everyone now`, '`/skip`', '`/stop`']);
  });

  it('cuts a long list at a whole line and says how many are left', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `cmd${i + 1}`, description: `${'d'.repeat(98)}${i}` }));
    const shown = checkEmbed(helpEmbed(many)).description.split('\n');
    const more = /^… and (\d+) more$/.exec(shown.pop());
    assert.ok(more);
    assert.equal(shown.length + Number(more[1]), 100);
  });

  it('copes with something that is not a list', () => {
    for (const c of [null, undefined, 42, 'play', {}]) {
      assert.equal(checkEmbed(helpEmbed(c)).description, 'No commands yet.', String(c));
    }
    assert.equal(checkEmbed(helpEmbed(new Set(commands.slice(0, 2)))).description.split('\n').length, 2);
  });
});

describe('purity', () => {
  it('never changes what it is given, and gives the same output for the same input', () => {
    const library = { localTracks: [{ title: 'a' }], stations: [{ id: 'x', name: 'y' }] };
    const build = (s, lib) => [
      nowPlayingEmbed(s), controlRows(s), queueEmbed(s, { page: 2, pageSize: 2 }), endedEmbed(s.current, '⏹ Stopped'),
      trackAddedEmbed(s.upcoming[1], 2, s), tracksEmbed(lib), helpEmbed(deepFreeze([{ name: 'play' }])),
    ].map((x) => JSON.stringify(x));
    const s = snapshot({ upcoming: numbered(5) });
    const frozen = deepFreeze(snapshot({ upcoming: numbered(5) }));
    assert.deepEqual(build(frozen, deepFreeze(structuredClone(library))), build(s, library),
      'frozen input: any write would have thrown');
  });

  it('imports nothing but the SDK and the other pure modules (no I/O)', () => {
    const src = readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8');
    const from = [...src.matchAll(/^import [^;]+ from '([^']+)';$/gm)].map((m) => m[1]).sort();
    assert.deepEqual(from, ['../yapper.js', './audio.js', './queue.js']);
    // `{import('./queue.js').X}` in JSDoc is a type, not a load.
    const io = /(?<!\{)\bimport\(|\brequire\(|\bprocess\.|\bconsole\.|\bfetch\(|\bset(Timeout|Interval)\(/.exec(src);
    assert.equal(io, null, `ui.js does I/O or keeps time: ${io?.[0]}`);
  });
});
