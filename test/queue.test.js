import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVANCE_REASONS, LOOP_MODES, LoopMode, Queue, QueueFullError, nextLoopMode, parseLoopMode,
} from '../src/queue.js';

/** A fake track. The title doubles as a readable id, but the checks below also compare object identity. */
const track = (title) => ({ kind: 'file', live: false, title, input: `/music/${title}.mp3`, source: 'local' });
/** Distinct tracks named after the letters of `names`: tracks('ABC') gives { A, B, C }. */
const tracks = (names) => Object.fromEntries([...names].map((n) => [n, track(n)]));
const titles = (list) => list.map((t) => t.title).join('');

/** The very same objects in the same order; equal-looking copies don't count. */
function assertSameTracks(actual, expected) {
  assert.equal(titles(actual), titles(expected)); // readable diff first
  actual.forEach((t, i) => assert.equal(t, expected[i], `item ${i + 1} is a different object`));
}

/** A queue in a given state, built through the public API only, so it also clones one (see cloneQueue). */
function build({ current = null, upcoming = [], loop = 'off', maxSize = 100 } = {}) {
  const q = new Queue({ maxSize });
  if (current) { q.add(current); q.advance(); }
  for (const t of upcoming) q.add(t);
  q.loop = loop;
  return q;
}
const cloneQueue = (q) => build({ current: q.current, upcoming: q.upcoming, loop: q.loop, maxSize: q.maxSize });
const stateOf = (q) => ({ current: q.current, upcoming: q.upcoming, loop: q.loop, maxSize: q.maxSize });
function assertSameState(q, before) {
  assert.equal(q.current, before.current);
  assertSameTracks(q.upcoming, before.upcoming);
  assert.equal(q.loop, before.loop);
  assert.equal(q.maxSize, before.maxSize);
}

/** Seeded PRNG (mulberry32): the same seed gives the same sequence, so "random" tests are repeatable. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A random() that returns the given values in turn. */
const sequence = (...values) => { let i = 0; return () => values[i++ % values.length]; };

describe('LoopMode, LOOP_MODES, ADVANCE_REASONS', () => {
  it('are frozen and list the modes in loop-button order', () => {
    assert.deepEqual(LoopMode, { OFF: 'off', TRACK: 'track', QUEUE: 'queue' });
    assert.deepEqual(LOOP_MODES, ['off', 'track', 'queue']);
    assert.deepEqual(ADVANCE_REASONS, ['ended', 'skipped', 'failed']);
    for (const x of [LoopMode, LOOP_MODES, ADVANCE_REASONS]) assert.ok(Object.isFrozen(x));
  });
});

describe('nextLoopMode', () => {
  it('cycles off, track, queue, then off again', () => {
    assert.equal(nextLoopMode('off'), 'track');
    assert.equal(nextLoopMode('track'), 'queue');
    assert.equal(nextLoopMode('queue'), 'off');
    const seen = [];
    for (let i = 0, mode = LoopMode.OFF; i < 6; i++) seen.push(mode = nextLoopMode(mode));
    assert.deepEqual(seen, ['track', 'queue', 'off', 'track', 'queue', 'off']);
  });

  it("maps anything that isn't a mode to 'off' (aliases included)", () => {
    for (const junk of [undefined, null, '', 'TRACK', 'Queue', 'song', 'q', ' off', 0, 1, true, NaN, {}, ['track']]) {
      assert.equal(nextLoopMode(junk), 'off', String(junk));
    }
  });
});

describe('parseLoopMode', () => {
  it('reads the three modes and every alias', () => {
    const table = {
      off: ['off', 'none', '0', 'false'],
      track: ['track', 'song', 'one', 'single', '1'],
      queue: ['queue', 'all', 'list', 'q'],
    };
    for (const [mode, words] of Object.entries(table)) {
      for (const word of words) assert.equal(parseLoopMode(word), mode, word);
    }
  });

  it('ignores case and surrounding whitespace', () => {
    const cases = [['OFF', 'off'], ['None', 'off'], ['FALSE', 'off'], [' 0 ', 'off'], ['Track', 'track'],
      ['SONG', 'track'], ['sInGlE', 'track'], ['One', 'track'], ['QUEUE', 'queue'], ['Q', 'queue'], ['All', 'queue'],
      ['LIST', 'queue'], ['  track  ', 'track'], ['\tq\n', 'queue']];
    for (const [text, mode] of cases) assert.equal(parseLoopMode(text), mode, JSON.stringify(text));
  });

  it('returns null for anything else, Object.prototype names and non-strings included', () => {
    const words = ['', '   ', 'tracks', 'repeat', 'loop', 'on', 'true', 'yes', '2', '-1', '01', 'qq', 'queue all',
      'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
    for (const text of words) assert.equal(parseLoopMode(text), null, JSON.stringify(text));
    for (const v of [undefined, null, 0, 1, true, false, {}, ['track'], Symbol('track')]) {
      assert.equal(parseLoopMode(v), null, String(v));
    }
  });
});

describe('QueueFullError', () => {
  it('is an Error carrying code QUEUE_FULL and the limit', () => {
    const e = new QueueFullError(5);
    assert.ok(e instanceof Error);
    assert.ok(e instanceof QueueFullError);
    assert.equal(e.name, 'QueueFullError');
    assert.equal(e.code, 'QUEUE_FULL');
    assert.equal(e.maxSize, 5);
    assert.match(e.message, /full \(5 tracks max\)/);
    assert.match(new QueueFullError(1).message, /\(1 track max\)/);
  });
});

describe('new Queue()', () => {
  it('starts empty with loop off and maxSize 100', () => {
    const q = new Queue();
    assert.equal(q.current, null);
    assert.deepEqual(q.upcoming, []);
    assert.equal(q.length, 0);
    assert.equal(q.isEmpty, true);
    assert.equal(q.maxSize, 100);
    assert.equal(q.loop, 'off');
    assert.equal(q.peek(), null);
    assert.equal(q.advance(), null);
    assert.equal(new Queue({}).maxSize, 100);
    assert.equal(new Queue({ maxSize: undefined }).maxSize, 100);
    assert.equal(new Queue({ maxSize: 1 }).maxSize, 1);
  });

  it('rejects a maxSize that is not a whole number of at least 1', () => {
    for (const maxSize of [0, -1, 1.5, NaN, Infinity, '10', null, true]) {
      assert.throws(() => new Queue({ maxSize }), RangeError, String(maxSize));
    }
  });

  it('keeps its state private and read-only', () => {
    const q = build({ current: track('A'), upcoming: [track('B')] });
    for (const key of ['current', 'upcoming', 'length', 'isEmpty', 'maxSize']) {
      assert.throws(() => { q[key] = 1; }, TypeError, key);
    }
    assert.deepEqual(Object.keys(q), []);
  });
});

describe('Queue#add', () => {
  it('appends and returns the 1-based position in upcoming', () => {
    const { A, B, C } = tracks('ABC');
    const q = new Queue();
    assert.equal(q.add(A), 1);
    assert.equal(q.add(B), 2);
    assert.equal(q.isEmpty, false);
    assert.equal(q.advance(), A); // A is playing now, so it no longer has a position
    assert.equal(q.add(C), 2);
    assertSameTracks(q.upcoming, [B, C]);
  });

  it('throws QueueFullError at capacity and leaves the queue as it was', () => {
    const { A, B, C, D } = tracks('ABCD');
    const q = build({ upcoming: [A, B, C], maxSize: 3 });
    assert.throws(() => q.add(D), (e) => {
      assert.ok(e instanceof QueueFullError && e instanceof Error);
      assert.equal(e.code, 'QUEUE_FULL');
      assert.equal(e.maxSize, 3);
      return true;
    });
    assertSameTracks(q.upcoming, [A, B, C]);
  });

  it("doesn't count the current track against maxSize, and accepts tracks again once there's room", () => {
    const { A, B, C, D } = tracks('ABCD');
    const q = build({ current: A, upcoming: [B], maxSize: 2 });
    assert.equal(q.add(C), 2);
    assert.throws(() => q.add(D), QueueFullError);
    assert.equal(q.advance(), B); // frees a slot
    assert.equal(q.add(D), 2);
    assertSameTracks(q.upcoming, [C, D]);
    q.remove(1);
    assert.equal(q.add(A), 2);
  });

  it('rejects anything that is not a track object with a TypeError', () => {
    const q = build({ upcoming: [track('A')] });
    for (const bad of [null, undefined, '', 'song.mp3', 42, true, () => {}]) {
      assert.throws(() => q.add(bad), TypeError, String(bad));
    }
    assert.equal(q.length, 1);
    // A bad argument is reported as such even when the queue is also full.
    assert.throws(() => build({ upcoming: [track('A')], maxSize: 1 }).add(null), TypeError);
  });
});

describe('Queue#upcoming, length and isEmpty', () => {
  it('upcoming is a fresh shallow copy on every read', () => {
    const { A, B, C } = tracks('ABC');
    const q = build({ upcoming: [A, B] });
    const list = q.upcoming;
    assert.notEqual(q.upcoming, list);
    list.push(C);
    list.reverse();
    list.length = 0;
    assertSameTracks(q.upcoming, [A, B]); // the queue didn't change,
    assert.equal(q.upcoming[0], A); // and the copy holds the same track objects
  });

  it('length counts only waiting tracks; isEmpty means nothing playing and nothing waiting', () => {
    const { A, B } = tracks('AB');
    const q = new Queue();
    assert.equal(q.isEmpty, true);
    q.add(A);
    assert.deepEqual([q.length, q.isEmpty], [1, false]);
    q.advance();
    assert.deepEqual([q.length, q.isEmpty], [0, false]); // A is playing
    q.add(B);
    q.advance();
    q.advance();
    assert.deepEqual([q.current, q.length, q.isEmpty], [null, 0, true]);
  });
});

describe('Queue#loop', () => {
  it('accepts the three modes', () => {
    const q = new Queue();
    for (const mode of [...LOOP_MODES, LoopMode.OFF]) {
      q.loop = mode;
      assert.equal(q.loop, mode);
    }
  });

  it('rejects anything else with a TypeError and keeps the old mode', () => {
    const q = build({ loop: 'queue' });
    for (const bad of ['TRACK', 'Queue', 'song', 'none', 'q', '', ' off', undefined, null, 0, 1, true, {}]) {
      assert.throws(() => { q.loop = bad; }, TypeError, String(bad));
      assert.equal(q.loop, 'queue');
    }
  });
});

describe('Queue#advance: every combination of reason, loop, current and upcoming', () => {
  // [reason, loop, current, upcoming, returned (the new current), upcoming after]; '-' is no track.
  const cases = [
    ['ended', 'off', '-', '', '-', ''],
    ['ended', 'off', '-', 'BC', 'B', 'C'],
    ['ended', 'off', 'A', '', '-', ''],
    ['ended', 'off', 'A', 'BC', 'B', 'C'],
    ['skipped', 'off', '-', '', '-', ''],
    ['skipped', 'off', '-', 'BC', 'B', 'C'],
    ['skipped', 'off', 'A', '', '-', ''],
    ['skipped', 'off', 'A', 'BC', 'B', 'C'],
    ['failed', 'off', '-', '', '-', ''],
    ['failed', 'off', '-', 'BC', 'B', 'C'],
    ['failed', 'off', 'A', '', '-', ''],
    ['failed', 'off', 'A', 'BC', 'B', 'C'],
    ['ended', 'track', '-', '', '-', ''],
    ['ended', 'track', '-', 'BC', 'B', 'C'], // nothing to repeat yet: takes the first waiting track
    ['ended', 'track', 'A', '', 'A', ''], // replay
    ['ended', 'track', 'A', 'BC', 'A', 'BC'], // replay, upcoming untouched
    ['skipped', 'track', '-', '', '-', ''],
    ['skipped', 'track', '-', 'BC', 'B', 'C'],
    ['skipped', 'track', 'A', '', '-', ''], // a skip leaves the looped track behind
    ['skipped', 'track', 'A', 'BC', 'B', 'C'],
    ['failed', 'track', '-', '', '-', ''],
    ['failed', 'track', '-', 'BC', 'B', 'C'],
    ['failed', 'track', 'A', '', '-', ''], // never retried forever
    ['failed', 'track', 'A', 'BC', 'B', 'C'],
    ['ended', 'queue', '-', '', '-', ''],
    ['ended', 'queue', '-', 'BC', 'B', 'C'], // no current track to send round
    ['ended', 'queue', 'A', '', 'A', ''], // to the back, which is also the front
    ['ended', 'queue', 'A', 'BC', 'B', 'CA'], // to the back
    ['skipped', 'queue', '-', '', '-', ''],
    ['skipped', 'queue', '-', 'BC', 'B', 'C'],
    ['skipped', 'queue', 'A', '', 'A', ''], // skipping the whole (one-track) loop restarts it
    ['skipped', 'queue', 'A', 'BC', 'B', 'CA'], // a skip still keeps it in the loop
    ['failed', 'queue', '-', '', '-', ''],
    ['failed', 'queue', '-', 'BC', 'B', 'C'],
    ['failed', 'queue', 'A', '', '-', ''], // dropped for good
    ['failed', 'queue', 'A', 'BC', 'B', 'C'], // dropped for good
  ];

  it('the table covers all 36 combinations exactly once', () => {
    const keys = cases.map(([reason, loop, cur, up]) => [reason, loop, cur, up].join('|'));
    const all = ADVANCE_REASONS.flatMap((reason) => LOOP_MODES.flatMap((loop) =>
      ['-', 'A'].flatMap((cur) => ['', 'BC'].map((up) => [reason, loop, cur, up].join('|')))));
    assert.equal(new Set(keys).size, 36);
    assert.deepEqual([...keys].sort(), all.sort());
  });

  for (const [reason, loop, cur, up, want, wantUp] of cases) {
    it(`${reason}, loop ${loop}, current ${cur}, upcoming [${up}]: returns ${want}, upcoming [${wantUp}]`, () => {
      const T = tracks('ABC');
      const q = build({ current: cur === '-' ? null : T[cur], upcoming: [...up].map((k) => T[k]), loop });
      const got = q.advance(reason);
      assert.equal(got, want === '-' ? null : T[want]);
      assert.equal(q.current, got);
      assertSameTracks(q.upcoming, [...wantUp].map((k) => T[k]));
      assert.equal(q.length, wantUp.length);
      assert.equal(q.isEmpty, got === null && wantUp === '');
      assert.equal(q.loop, loop); // advancing never changes the mode
    });
  }
});

describe('Queue#advance: behaviour over time', () => {
  it("defaults to 'ended'", () => {
    const { A, B } = tracks('AB');
    assert.equal(build({ current: A, upcoming: [B], loop: 'track' }).advance(), A);
    assert.equal(build({ current: A, upcoming: [B], loop: 'track' }).advance(undefined), A);
    assert.equal(build({ current: A, upcoming: [B] }).advance(), B);
  });

  it('rejects an unknown reason with a TypeError, changing nothing', () => {
    const { A, B } = tracks('AB');
    const q = build({ current: A, upcoming: [B], loop: 'queue' });
    for (const bad of ['stopped', 'ENDED', 'end', 'skip', '', null, 0, {}]) {
      assert.throws(() => q.advance(bad), TypeError, String(bad));
    }
    assertSameState(q, { current: A, upcoming: [B], loop: 'queue', maxSize: 100 });
  });

  it('loop off plays everything once, in order', () => {
    const { A, B, C } = tracks('ABC');
    const q = build({ upcoming: [A, B, C] });
    const played = [q.advance(), q.advance('skipped'), q.advance('failed')];
    assertSameTracks(played, [A, B, C]);
    assert.equal(q.advance(), null);
    assert.equal(q.isEmpty, true);
  });

  it('loop track replays the very same object until skipped, then the next track loops', () => {
    const { A, B, C } = tracks('ABC');
    const q = build({ current: A, upcoming: [B, C], loop: 'track' });
    for (let i = 0; i < 4; i++) assert.equal(q.advance('ended'), A);
    assertSameTracks(q.upcoming, [B, C]); // the replays didn't touch what's waiting
    assert.equal(q.advance('skipped'), B);
    assert.equal(q.loop, 'track');
    assert.equal(q.advance(), B);
    assert.equal(q.advance('failed'), C);
    assert.equal(q.advance('failed'), null);
  });

  it('loop queue goes round in order, lap after lap, with the same objects', () => {
    const { A, B, C } = tracks('ABC');
    const q = build({ current: A, upcoming: [B, C], loop: 'queue' });
    const played = [q.current];
    for (let i = 0; i < 8; i++) played.push(q.advance());
    assertSameTracks(played, [A, B, C, A, B, C, A, B, C]);
  });

  it('loop queue with a single track keeps replaying it', () => {
    const { A } = tracks('A');
    const q = build({ current: A, loop: 'queue' });
    for (let i = 0; i < 5; i++) {
      assert.equal(q.peek(), A);
      assert.equal(q.advance('ended'), A);
      assert.equal(q.length, 0);
    }
    assert.equal(q.advance('skipped'), A);
    assert.equal(q.advance('failed'), null); // until it fails
    assert.equal(q.isEmpty, true);
  });

  it('loop queue drops a failed track for good', () => {
    const { A, B, C } = tracks('ABC');
    const q = build({ current: A, upcoming: [B, C], loop: 'queue' });
    assert.equal(q.advance('ended'), B);
    assert.equal(q.advance('failed'), C); // B failed: not sent round
    assertSameTracks(q.upcoming, [A]);
    const played = [];
    for (let i = 0; i < 6; i++) played.push(q.advance());
    assertSameTracks(played, [A, C, A, C, A, C]);
    assert.ok(!q.upcoming.includes(B));
  });

  it('a loop mode change mid-queue applies from the next advance', () => {
    const { A, B, C, D } = tracks('ABCD');
    const q = build({ upcoming: [A, B, C, D] });
    assert.equal(q.advance(), A);
    q.loop = 'queue'; // A is current, so it goes round too
    assert.equal(q.advance(), B);
    assertSameTracks(q.upcoming, [C, D, A]);
    q.loop = 'track';
    assert.equal(q.advance('ended'), B);
    assert.equal(q.advance('skipped'), C); // track mode doesn't send round: B is gone
    assertSameTracks(q.upcoming, [D, A]);
    q.loop = 'off';
    assert.equal(q.advance(), D);
    assert.equal(q.advance(), A); // still queued from the earlier lap
    assert.equal(q.advance(), null);
    q.loop = 'queue'; // nothing playing: nothing to send round
    assert.equal(q.advance(), null);
    assert.equal(q.isEmpty, true);
  });

  it('the loop-queue requeue ignores maxSize (the limit is for add)', () => {
    const { A, B, C, D } = tracks('ABCD');
    const q = build({ current: A, upcoming: [B, C], loop: 'queue', maxSize: 2 });
    assert.throws(() => q.add(D), QueueFullError);
    assert.equal(q.advance('ended'), B); // would throw if the requeue went through add()
    assertSameTracks(q.upcoming, [C, A]);
    assert.equal(q.advance('skipped'), C);
    assertSameTracks(q.upcoming, [A, B]);
    assert.equal(q.length, q.maxSize);
    const one = build({ current: A, upcoming: [B], loop: 'queue', maxSize: 1 });
    assert.equal(one.advance(), B);
    assertSameTracks(one.upcoming, [A]);
  });

  it('hands back the very objects that were added, even equal-looking ones', () => {
    const x1 = track('X');
    const x2 = track('X');
    assert.deepEqual(x1, x2); // they look the same,
    const q = build({ upcoming: [x1, x2], loop: 'queue' });
    assert.equal(q.peek(), x1);
    assert.equal(q.advance(), x1); // but the queue keeps them apart
    assert.equal(q.peek(), x2);
    assert.equal(q.advance(), x2);
    assert.equal(q.upcoming[0], x1); // sent round as the same object
    assert.equal(q.advance(), x1);
    q.shuffle(() => 0);
    assert.equal(q.upcoming[0], x2);
    assert.equal(q.remove(1), x2);
  });
});

describe('Queue#peek', () => {
  it("equals what advance('ended') returns in every state, and changes nothing", () => {
    const { A, B, C, D } = tracks('ABCD');
    let states = 0;
    for (const loop of LOOP_MODES) {
      for (const current of [null, A]) {
        for (const upcoming of [[], [B], [B, C], [B, C, D]]) {
          const q = build({ current, upcoming, loop });
          const label = `loop ${loop}, current ${current?.title ?? '-'}, upcoming [${titles(upcoming)}]`;
          const before = stateOf(q);
          const next = q.peek();
          assertSameState(q, before);
          assert.equal(q.peek(), next, label);
          assert.equal(cloneQueue(q).advance('ended'), next, label);
          states++;
        }
      }
    }
    assert.equal(states, 24);
  });

  it('picks the next track in each loop mode, with and without a current track', () => {
    const { A, B } = tracks('AB');
    assert.equal(build({ current: A, upcoming: [B], loop: 'track' }).peek(), A);
    assert.equal(build({ upcoming: [B], loop: 'track' }).peek(), B); // nothing to repeat yet
    assert.equal(build({ current: A, loop: 'queue' }).peek(), A); // the queue comes round
    assert.equal(build({ current: A, upcoming: [B], loop: 'queue' }).peek(), B);
    assert.equal(build({ current: A }).peek(), null);
    assert.equal(build({ current: A, upcoming: [B] }).peek(), B);
    assert.equal(build({ loop: 'queue' }).peek(), null);
  });

  it("stays equal to advance('ended') along a seeded random walk of every operation", () => {
    const rand = mulberry32(0xd15b07);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const pool = Object.values(tracks('ABCDEFGH'));
    const q = new Queue({ maxSize: 5 });
    const ops = {
      add() {
        if (q.length < q.maxSize) q.add(pick(pool));
        else assert.throws(() => q.add(pick(pool)), QueueFullError);
      },
      advance() { q.advance(pick(ADVANCE_REASONS)); },
      remove() { if (q.length) q.remove(1 + Math.floor(rand() * q.length)); },
      shuffle() { q.shuffle(rand); },
      loop() { q.loop = pick(LOOP_MODES); },
      clear() { if (rand() < 0.25) q.clear(); },
      reset() { if (rand() < 0.1) q.reset(); },
    };
    const weighted = ['add', 'add', 'add', 'advance', 'advance', 'advance', 'remove', 'shuffle', 'loop', 'loop',
      'clear', 'reset'];
    const visited = new Set();
    for (let step = 0; step < 3000; step++) {
      ops[pick(weighted)]();
      assert.ok(q.length <= q.maxSize, `step ${step}: more than maxSize waiting`);
      assert.equal(q.isEmpty, q.current === null && q.length === 0);
      const before = stateOf(q);
      const next = q.peek();
      assertSameState(q, before);
      assert.equal(cloneQueue(q).advance('ended'), next, `step ${step}`);
      visited.add(`${q.loop}|${q.current ? 'A' : '-'}|${Math.min(q.length, 2)}`);
    }
    assert.equal(visited.size, 18, 'the walk reached every loop × current × (0, 1, 2+ waiting) state');
  });
});

describe('Queue#remove', () => {
  it('takes out the track at a 1-based position and returns that object', () => {
    const { A, B, C, D, E } = tracks('ABCDE');
    const q = build({ current: A, upcoming: [B, C, D, E] });
    assert.equal(q.remove(2), C);
    assertSameTracks(q.upcoming, [B, D, E]);
    assert.equal(q.remove(3), E); // last
    assert.equal(q.remove(1), B); // first
    assertSameTracks(q.upcoming, [D]);
    assert.equal(q.current, A); // never the current track
    assert.equal(q.remove(1), D);
    assert.equal(q.length, 0);
  });

  it('throws a RangeError for anything but a whole number from 1 to length, changing nothing', () => {
    const { A, B, C } = tracks('ABC');
    const q = build({ current: A, upcoming: [B, C] });
    for (const bad of [0, -1, 1.5, '2', '1', NaN, 3, Infinity, -Infinity, undefined, null, true, [1], {}]) {
      assert.throws(() => q.remove(bad), RangeError, String(bad));
    }
    assert.throws(() => q.remove(3), { name: 'RangeError', message: /from 1 to 2 \(got 3\)/ });
    assert.throws(() => q.remove('2'), { message: /\(got "2"\)/ });
    assertSameState(q, { current: A, upcoming: [B, C], loop: 'off', maxSize: 100 });
  });

  it('never echoes typed text into the message (the cog may show it in chat)', () => {
    const q = build({ upcoming: [track('A')] });
    for (const text of ['@everyone', '<@123>', '[x](https://evil.example)', '**3**', 'x'.repeat(25)]) {
      assert.throws(() => q.remove(text), (e) => e instanceof RangeError && /\(got a string\)$/.test(e.message), text);
      assert.throws(() => { q.loop = text; }, (e) => e instanceof TypeError && !e.message.includes(text), text);
    }
  });

  it('throws a RangeError when nothing is waiting', () => {
    assert.throws(() => build({ current: track('A') }).remove(1), { name: 'RangeError', message: /empty/ });
    assert.throws(() => new Queue().remove(1), RangeError);
  });
});

describe('Queue#shuffle', () => {
  it('is a permutation of upcoming, never touches the current track, and repeats with the same seed', () => {
    const { A, ...rest } = tracks('ABCDEFGHIJ');
    const waiting = Object.values(rest);
    const q = build({ current: A, upcoming: waiting, loop: 'queue' });
    assert.equal(q.shuffle(mulberry32(42)), 9);
    assert.equal(q.current, A);
    assert.equal(q.loop, 'queue');
    const after = q.upcoming;
    assert.equal(new Set(after).size, 9);
    for (const t of after) assert.ok(waiting.includes(t), t.title);
    assert.notEqual(titles(after), titles(waiting), 'this seed moves something');
    const again = build({ current: A, upcoming: waiting });
    again.shuffle(mulberry32(42));
    assertSameTracks(again.upcoming, after);
  });

  it('is a real Fisher-Yates: random() = 0 rotates left, random() near 1 keeps the order', () => {
    const { A, B, C, D } = tracks('ABCD');
    const q = build({ upcoming: [A, B, C, D] });
    q.shuffle(() => 0);
    assert.equal(titles(q.upcoming), 'BCDA');
    q.shuffle(() => 0.999999);
    assert.equal(titles(q.upcoming), 'BCDA');
  });

  it('gives every order exactly once over all possible random choices (unbiased)', () => {
    for (const n of [2, 3, 4]) {
      let total = 1;
      for (let i = 2; i <= n; i++) total *= i;
      const orders = new Set();
      for (let k = 0; k < total; k++) {
        // Fisher-Yates picks j in [0, i] for i = n-1 down to 1; k numbers one choice sequence (mixed radix).
        const values = [];
        for (let i = n - 1, rest = k; i > 0; rest = Math.floor(rest / (i + 1)), i--) {
          values.push(((rest % (i + 1)) + 0.5) / (i + 1));
        }
        const q = build({ upcoming: Object.values(tracks('ABCD'.slice(0, n))) });
        q.shuffle(sequence(...values));
        orders.add(titles(q.upcoming));
      }
      assert.equal(orders.size, total, `${n} tracks`);
    }
  });

  it('calls random() once per step, not at all for 0 or 1 waiting tracks', () => {
    let calls = 0;
    const counting = () => { calls++; return 0.5; };
    assert.equal(new Queue().shuffle(counting), 0);
    assert.equal(build({ current: track('A'), upcoming: [track('B')] }).shuffle(counting), 1);
    assert.equal(calls, 0);
    build({ upcoming: Object.values(tracks('ABCDE')) }).shuffle(counting);
    assert.equal(calls, 4);
  });

  it('survives a random() returning junk: still a permutation, no holes', () => {
    const waiting = Object.values(tracks('ABCDEF'));
    for (const value of [NaN, 1, 1.5, -1, -0.5, Infinity, -Infinity, undefined, null, '0.5']) {
      const q = build({ upcoming: waiting });
      q.shuffle(() => value);
      const after = q.upcoming;
      assert.equal(after.length, waiting.length, String(value));
      assert.equal(new Set(after).size, waiting.length, String(value));
      for (const t of after) assert.ok(waiting.includes(t), String(value));
    }
  });

  it('leaves the queue untouched when random() throws', () => {
    const { A, B, C, D } = tracks('ABCD');
    const q = build({ current: A, upcoming: [B, C, D] });
    let calls = 0;
    assert.throws(() => q.shuffle(() => { if (++calls === 2) throw new Error('boom'); return 0; }), /boom/);
    assertSameTracks(q.upcoming, [B, C, D]);
    assert.equal(q.current, A);
  });

  it('uses Math.random by default and needs a function otherwise', () => {
    const waiting = Object.values(tracks('ABC'));
    const q = build({ upcoming: waiting });
    assert.equal(q.shuffle(), 3);
    assert.equal(new Set(q.upcoming).size, 3);
    const order = titles(q.upcoming);
    for (const bad of [null, 0.5, 'random', {}]) assert.throws(() => q.shuffle(bad), TypeError, String(bad));
    assert.equal(titles(q.upcoming), order);
  });
});

describe('Queue#clear and Queue#reset', () => {
  it('clear() empties upcoming, keeps the current track and loop mode, and returns how many it removed', () => {
    const { A, B, C } = tracks('ABC');
    const q = build({ current: A, upcoming: [B, C], loop: 'queue' });
    assert.equal(q.clear(), 2);
    assert.equal(q.current, A);
    assert.deepEqual(q.upcoming, []);
    assert.equal(q.loop, 'queue');
    assert.equal(q.isEmpty, false);
    assert.equal(q.clear(), 0);
    assert.equal(q.advance('ended'), A); // loop queue: A is all that's left, so it comes round
  });

  it('reset() forgets every track but keeps the loop mode, and returns how many tracks that was', () => {
    const { A, B, C } = tracks('ABC');
    const q = build({ current: A, upcoming: [B, C], loop: 'track', maxSize: 5 });
    assert.equal(q.reset(), 3); // current included
    assert.equal(q.current, null);
    assert.deepEqual(q.upcoming, []);
    assert.equal(q.isEmpty, true);
    assert.equal(q.loop, 'track');
    assert.equal(q.maxSize, 5);
    assert.equal(q.reset(), 0);
    assert.equal(build({ current: A }).reset(), 1);
    assert.equal(build({ upcoming: [B] }).reset(), 1);
    assert.equal(q.add(B), 1); // still usable afterwards
    assert.equal(q.advance(), B);
  });
});
