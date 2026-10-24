import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  CHANNELS, FRAME_BYTES, FRAME_MS, FRAME_SAMPLES, MAX_VOLUME, MIN_VOLUME, SAMPLE_RATE, SAMPLES_PER_CHANNEL,
  PcmFramer, applyGain, clampVolume, parseVolume, readFrames, volumeToGain,
} from '../src/audio.js';

/** Deterministic PRNG (mulberry32): the property tests replay the same cases on every run. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randomBytes = (rand, n) => Buffer.from(Array.from({ length: n }, () => Math.floor(rand() * 256)));
const bytesOf = (frames) => Buffer.concat(frames.map((f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength)));
/** Bytes padded with zeros up to whole frames. */
const padded = (bytes) => {
  const missing = (FRAME_BYTES - (bytes.length % FRAME_BYTES)) % FRAME_BYTES;
  return Buffer.concat([bytes, Buffer.alloc(missing)]);
};

/** What rtc-node needs from a frame: AudioFrame hands native code the WHOLE ArrayBuffer from offset 0. */
function assertOwnFrame(frame) {
  assert.ok(frame instanceof Int16Array, 'frame is an Int16Array');
  assert.equal(frame.length, FRAME_SAMPLES);
  assert.equal(frame.byteOffset, 0);
  assert.equal(frame.buffer.byteLength, FRAME_BYTES);
}

/** Frame samples must be the input read as signed 16-bit little-endian. */
function assertSamplesMatch(frames, expected) {
  frames.forEach((frame, k) => {
    for (let j = 0; j < FRAME_SAMPLES; j++) {
      const want = expected.readInt16LE(k * FRAME_BYTES + j * 2);
      if (frame[j] !== want) assert.fail(`frame ${k} sample ${j}: ${frame[j]} !== ${want}`);
    }
  });
}

/** An Int16Array wrapped so any out-of-bounds index access (or, with readOnly, any write) fails the test. */
function guarded(array, { readOnly = false } = {}) {
  const check = (prop) => {
    if (typeof prop === 'string' && /^-?\d+$/.test(prop) && (Number(prop) < 0 || Number(prop) >= array.length)) {
      assert.fail(`out-of-bounds access at index ${prop}`);
    }
  };
  return new Proxy(array, {
    get(target, prop) {
      check(prop);
      return Reflect.get(target, prop); // receiver = the real array, so TypedArray getters like length work
    },
    set(target, prop, value) {
      check(prop);
      if (readOnly) assert.fail(`unexpected write at index ${String(prop)}`);
      return Reflect.set(target, prop, value);
    },
  });
}

describe('constants', () => {
  test('48 kHz stereo s16le in 10 ms frames', () => {
    assert.deepEqual(
      { SAMPLE_RATE, CHANNELS, SAMPLES_PER_CHANNEL, FRAME_SAMPLES, FRAME_BYTES, FRAME_MS, MIN_VOLUME, MAX_VOLUME },
      { SAMPLE_RATE: 48000, CHANNELS: 2, SAMPLES_PER_CHANNEL: 480, FRAME_SAMPLES: 960, FRAME_BYTES: 1920, FRAME_MS: 10,
        MIN_VOLUME: 1, MAX_VOLUME: 200 },
    );
    assert.equal((SAMPLES_PER_CHANNEL / SAMPLE_RATE) * 1000, FRAME_MS);
  });
});

describe('clampVolume', () => {
  test('rounds to a whole percent and clamps to 1..200', () => {
    const cases = [[100, 100], [1, 1], [200, 200], [0, 1], [-50, 1], [-0.4, 1], [201, 200], [1e9, 200],
      [99.5, 100], [99.4, 99], [1.4, 1], [150.6, 151], [199.5, 200]];
    for (const [input, want] of cases) assert.equal(clampVolume(input), want, `clampVolume(${input})`);
  });

  test('throws RangeError for non-finite values and non-numbers', () => {
    for (const bad of [NaN, Infinity, -Infinity, '150', '', null, undefined, {}, [100]]) {
      assert.throws(() => clampVolume(bad), RangeError, `clampVolume(${String(bad)})`);
    }
  });
});

describe('parseVolume', () => {
  test('accepts whole percents 1..200, with an optional % and spaces', () => {
    const cases = [['150', 150], ['150%', 150], [' 80 ', 80], ['80 %', 80], ['\t42%\n', 42], ['1', 1], ['200', 200],
      ['200%', 200], ['007', 7], [200, 200], [1, 1], [150, 150]];
    for (const [input, want] of cases) assert.equal(parseVolume(input), want, `parseVolume(${JSON.stringify(input)})`);
  });

  test('anything else is null', () => {
    const cases = ['0', '0%', '201', '1000', '1.5', '150.0', '1e2', '', '   ', 'abc', '%', '50%%', '%50', '-5', '+5',
      '1 0', '0x10', '１５０', '١٢', 'loud', null, undefined, 0, 201, 1.5, -1, NaN, Infinity, true, {}, [150]];
    for (const input of cases) {
      const label = typeof input === 'string' ? JSON.stringify(input) : String(input);
      assert.equal(parseVolume(input), null, `parseVolume(${label})`);
    }
  });
});

describe('volumeToGain', () => {
  test('linear: volume / 100', () => {
    for (const [volume, gain] of [[100, 1], [200, 2], [50, 0.5], [1, 0.01], [0, 0], [150, 1.5]]) {
      assert.equal(volumeToGain(volume), gain, `volumeToGain(${volume})`);
    }
  });

  test('throws RangeError for negative or non-finite volumes', () => {
    for (const bad of [-1, NaN, Infinity, '100', null]) assert.throws(() => volumeToGain(bad), RangeError);
  });
});

describe('applyGain', () => {
  test('unity gain returns the same array untouched', () => {
    const samples = Int16Array.from([1, -1, 32767, -32768, 12345, -12345]);
    const before = Int16Array.from(samples);
    assert.equal(applyGain(samples, 1), samples);
    assert.equal(applyGain(samples, 1, 1), samples);
    assert.deepEqual(samples, before);
    const watched = guarded(Int16Array.from(before), { readOnly: true }); // the fast path must not even write
    assert.equal(applyGain(watched, 1, 1), watched);
  });

  test('halves at 0.5, rounding with Math.round', () => {
    const samples = Int16Array.from([1000, -1000, 3, -3, 1, -1, 32767, -32768]);
    assert.equal(applyGain(samples, 0.5), samples);
    assert.deepEqual([...samples], [500, -500, 2, -1, 1, 0, 16384, -16384]);
  });

  test('doubling clips at both rails instead of wrapping around', () => {
    const samples = Int16Array.from([20000, -20000, 16383, -16384, 16384, -16385, 100, -100, 0, 0]);
    applyGain(samples, 2);
    assert.deepEqual([...samples], [32767, -32768, 32766, -32768, 32767, -32768, 200, -200, 0, 0]);
    const loud = applyGain(Int16Array.from([1, -1, 0, 32767]), 1e6);
    assert.deepEqual([...loud], [32767, -32768, 0, 32767]);
  });

  test('toGain defaults to fromGain: a constant gain', () => {
    const samples = new Int16Array(FRAME_SAMPLES).fill(1000);
    applyGain(samples, 0.25);
    assert.ok(samples.every((s) => s === 250));
  });

  test('ramps linearly: one step past fromGain, ending exactly on toGain, L and R together', () => {
    assert.deepEqual([...applyGain(Int16Array.from([1000, 1000, 1000, 1000]), 1, 0.5)], [750, 750, 500, 500]);

    const up = applyGain(new Int16Array(FRAME_SAMPLES).fill(10000), 0, 1);
    assert.equal(up[0], Math.round(10000 / SAMPLES_PER_CHANNEL)); // 21: the first pair is one step in
    assert.equal(up.at(-2), 10000);
    assert.equal(up.at(-1), 10000);
    for (let i = 0; i < up.length; i += 2) assert.equal(up[i], up[i + 1], `pair ${i / 2}: L and R share the gain`);
    for (let i = 2; i < up.length; i++) assert.ok(up[i] >= up[i - 1], `non-decreasing at ${i}`);

    const down = applyGain(new Int16Array(FRAME_SAMPLES).fill(10000), 1, 0);
    assert.equal(down[0], Math.round(10000 * (1 - 1 / SAMPLES_PER_CHANNEL))); // 9979
    assert.equal(down.at(-1), 0);
    for (let i = 2; i < down.length; i++) assert.ok(down[i] <= down[i - 1], `non-increasing at ${i}`);

    const clipped = applyGain(new Int16Array(FRAME_SAMPLES).fill(30000), 1, 2);
    assert.equal(clipped[0], Math.round(30000 * (1 + 1 / SAMPLES_PER_CHANNEL)));
    assert.equal(clipped.at(-1), 32767);
    for (let i = 2; i < clipped.length; i++) assert.ok(clipped[i] >= clipped[i - 1]);
  });

  test('consecutive frames join without a jump (the next frame starts from the last gain)', () => {
    const a = applyGain(new Int16Array(FRAME_SAMPLES).fill(8000), 1, 0.5);
    const b = applyGain(new Int16Array(FRAME_SAMPLES).fill(8000), 0.5);
    assert.equal(a.at(-1), 4000);
    assert.equal(b[0], 4000);
  });

  test('gain 0 is silence', () => {
    const rand = prng(7);
    const samples = Int16Array.from({ length: FRAME_SAMPLES }, () => Math.floor(rand() * 65536) - 32768);
    assert.ok(applyGain(samples, 0).every((s) => s === 0));
    const faded = applyGain(new Int16Array(FRAME_SAMPLES).fill(-12345), 1, 0);
    assert.equal(faded.at(-1), 0);
    assert.equal(faded.at(-2), 0);
  });

  test('an empty array is returned as is', () => {
    const empty = new Int16Array(0);
    assert.equal(applyGain(empty, 0.5), empty);
    assert.equal(applyGain(empty, 0, 2), empty);
    assert.equal(empty.length, 0);
  });

  test('odd length: a lone last sample gets toGain, with no out-of-bounds reads or writes', () => {
    const odd = Int16Array.from([1000, 1000, 1000, 1000, 1000]);
    applyGain(guarded(odd), 1, 0.5); // 3 "pairs": gains 5/6, 4/6, then exactly 0.5 for the lone sample
    assert.deepEqual([...odd], [833, 833, 667, 667, 500]);
    const one = Int16Array.from([1000]);
    applyGain(guarded(one), 0, 1);
    assert.deepEqual([...one], [1000]);
    const backing = new Int16Array(7).fill(1000);
    applyGain(backing.subarray(1, 6), 2); // a view: its neighbours in the same buffer stay as they were
    assert.deepEqual([...backing], [1000, 2000, 2000, 2000, 2000, 2000, 1000]);
  });

  test('RangeError for NaN, infinite or negative gains (before touching anything)', () => {
    const samples = Int16Array.from([100, -100]);
    for (const bad of [NaN, Infinity, -Infinity, -0.01, -1, '1', null, undefined]) {
      assert.throws(() => applyGain(samples, bad, 1), RangeError, `fromGain ${String(bad)}`);
      assert.throws(() => applyGain(samples, 1, bad === undefined ? NaN : bad), RangeError, `toGain ${String(bad)}`);
    }
    assert.throws(() => applyGain(samples), RangeError);
    assert.deepEqual([...samples], [100, -100]);
  });

  test('TypeError for anything that is not an Int16Array', () => {
    const bad = [[1, 2], new Float32Array(4), new Int32Array(4), new Uint8Array(4), Buffer.alloc(4), null, 'pcm'];
    for (const samples of bad) assert.throws(() => applyGain(samples, 0.5), TypeError);
  });
});

describe('PcmFramer', () => {
  test('one exact frame in, one frame out, nothing pending', () => {
    const framer = new PcmFramer();
    const input = randomBytes(prng(1), FRAME_BYTES);
    const frames = framer.push(input);
    assert.equal(frames.length, 1);
    assertOwnFrame(frames[0]);
    assertSamplesMatch(frames, input);
    assert.equal(framer.pendingBytes, 0);
    assert.equal(framer.flush(), null);
  });

  test('every frame owns a fresh buffer and never aliases the input', () => {
    const input = randomBytes(prng(2), FRAME_BYTES * 3);
    const frames = new PcmFramer().push(input);
    assert.equal(frames.length, 3);
    frames.forEach(assertOwnFrame);
    assert.equal(new Set(frames.map((f) => f.buffer)).size, 3);
    assert.ok(frames.every((f) => f.buffer !== input.buffer));
    const copy = Buffer.from(input);
    input.fill(0); // the caller reuses its buffer: the frames must not change
    assertSamplesMatch(frames, copy);
  });

  test('a chunk at an odd byte offset with an odd length', () => {
    const backing = randomBytes(prng(3), FRAME_BYTES * 2 + 8);
    const chunk = backing.subarray(1, 1 + FRAME_BYTES * 2 + 1);
    assert.equal(chunk.byteOffset % 2, 1);
    const framer = new PcmFramer();
    const frames = framer.push(chunk);
    assert.equal(frames.length, 2);
    frames.forEach(assertOwnFrame);
    assertSamplesMatch(frames, Buffer.from(chunk));
    assert.equal(framer.pendingBytes, 1);
  });

  test('1-byte chunks: samples split across chunks are put back together', () => {
    const input = randomBytes(prng(4), FRAME_BYTES * 2 + 3);
    const framer = new PcmFramer();
    const frames = [];
    for (let i = 0; i < input.length; i++) {
      const out = framer.push(input.subarray(i, i + 1));
      assert.equal(out.length, (i + 1) % FRAME_BYTES === 0 ? 1 : 0, `byte ${i}`);
      frames.push(...out);
      assert.equal(framer.pendingBytes, (i + 1) % FRAME_BYTES);
    }
    assert.equal(frames.length, 2);
    frames.forEach(assertOwnFrame);
    assertSamplesMatch(frames, input);
  });

  test('a chunk spanning many frames keeps the remainder for later', () => {
    const input = randomBytes(prng(5), FRAME_BYTES * 10 + FRAME_BYTES / 2);
    const framer = new PcmFramer();
    const frames = framer.push(input);
    assert.equal(frames.length, 10);
    assert.equal(framer.pendingBytes, FRAME_BYTES / 2);
    frames.push(framer.flush());
    frames.forEach(assertOwnFrame);
    assert.ok(bytesOf(frames).equals(padded(input)));
  });

  test('exact multiples over several chunks leave nothing to flush', () => {
    const input = randomBytes(prng(6), FRAME_BYTES * 4);
    const framer = new PcmFramer();
    const frames = [...framer.push(input.subarray(0, FRAME_BYTES * 2))];
    frames.push(...framer.push(input.subarray(FRAME_BYTES * 2)));
    assert.equal(frames.length, 4);
    assert.equal(framer.pendingBytes, 0);
    assert.equal(framer.flush(), null);
    assert.ok(bytesOf(frames).equals(input));
  });

  test('flush() pads the remainder with silence and starts over', () => {
    const framer = new PcmFramer();
    assert.equal(framer.flush(), null);
    assert.deepEqual(framer.push(Buffer.alloc(1001, 0xab)), []);
    assert.equal(framer.pendingBytes, 1001);
    const last = framer.flush();
    assertOwnFrame(last);
    const bytes = Buffer.from(last.buffer);
    assert.ok(bytes.subarray(0, 1001).every((b) => b === 0xab));
    assert.ok(bytes.subarray(1001).every((b) => b === 0));
    assert.equal(framer.pendingBytes, 0);
    assert.equal(framer.flush(), null);
    const next = framer.push(Buffer.alloc(FRAME_BYTES, 0x01)); // a fresh frame, nothing left over from before
    assert.equal(next.length, 1);
    assert.ok(Buffer.from(next[0].buffer).every((b) => b === 0x01));
  });

  test('empty chunks are fine', () => {
    const framer = new PcmFramer();
    assert.deepEqual(framer.push(Buffer.alloc(0)), []);
    assert.deepEqual(framer.push(new Uint8Array(0)), []);
    assert.equal(framer.pendingBytes, 0);
    assert.equal(framer.flush(), null);
  });

  test('takes any byte view or an ArrayBuffer', () => {
    const input = randomBytes(prng(8), FRAME_BYTES);
    const ab = input.buffer.slice(input.byteOffset, input.byteOffset + input.length);
    const framer = new PcmFramer();
    const frames = [
      ...framer.push(new DataView(ab, 0, 100)),
      ...framer.push(new Int16Array(ab, 100, 50)),
      ...framer.push(ab.slice(200)),
    ];
    assert.equal(frames.length, 1);
    assertSamplesMatch(frames, input);
  });

  test('rejects things that are not bytes, keeping its state', () => {
    const framer = new PcmFramer();
    framer.push(Buffer.alloc(10));
    for (const bad of ['abc', null, undefined, 123, [1, 2], {}]) assert.throws(() => framer.push(bad), TypeError);
    assert.equal(framer.pendingBytes, 10);
  });

  test('property: seeded random chunking reproduces the input exactly (plus zero padding)', () => {
    const rand = prng(0xd15b07);
    const chunkSize = () => {
      const r = rand();
      if (r < 0.2) return 1 + Math.floor(rand() * 3); // tiny: splits samples
      if (r < 0.5) return Math.floor(rand() * 300); // includes empty chunks
      if (r < 0.8) return Math.floor(rand() * 4000); // around a frame or two
      return Math.floor(rand() * 20000); // many frames at once
    };
    for (let round = 0; round < 200; round++) {
      const input = randomBytes(rand, Math.floor(rand() * 12000));
      const framer = new PcmFramer();
      const frames = [];
      for (let fed = 0; fed < input.length;) {
        const size = Math.min(input.length - fed, chunkSize());
        // Copy the chunk to a random (often odd) offset of a bigger buffer, as Buffer or plain Uint8Array.
        const pad = Math.floor(rand() * 5);
        const backing = Buffer.alloc(size + pad + 3, 0xee);
        input.copy(backing, pad, fed, fed + size);
        const chunk = rand() < 0.5 ? backing.subarray(pad, pad + size)
          : new Uint8Array(backing.buffer, backing.byteOffset + pad, size);
        frames.push(...framer.push(chunk));
        backing.fill(0x55); // reused by the "caller" right away
        fed += size;
        assert.equal(framer.pendingBytes, fed % FRAME_BYTES);
        assert.equal(frames.length, Math.floor(fed / FRAME_BYTES));
      }
      const last = framer.flush();
      if (last) frames.push(last);
      assert.equal(frames.length, Math.ceil(input.length / FRAME_BYTES), `round ${round}`);
      frames.forEach(assertOwnFrame);
      const expected = padded(input);
      assert.ok(bytesOf(frames).equals(expected), `round ${round}: bytes differ`);
      assertSamplesMatch(frames, expected);
    }
  });
});

describe('readFrames', () => {
  test('frames a Readable and flushes the padded remainder last', async () => {
    const input = randomBytes(prng(9), 4000);
    const source = Readable.from([input.subarray(0, 1000), input.subarray(1000, 3001), input.subarray(3001)]);
    const frames = [];
    for await (const frame of readFrames(source)) frames.push(frame);
    assert.equal(frames.length, 3);
    frames.forEach(assertOwnFrame);
    assert.ok(bytesOf(frames).equals(padded(input)));
    assertSamplesMatch(frames, padded(input));
  });

  test('an empty stream yields nothing; exact multiples get no padded frame', async () => {
    const none = [];
    for await (const frame of readFrames(Readable.from([]))) none.push(frame);
    assert.equal(none.length, 0);
    const two = [];
    for await (const frame of readFrames(Readable.from([Buffer.alloc(FRAME_BYTES * 2, 3)]))) two.push(frame);
    assert.equal(two.length, 2);
  });

  test('a stream error propagates out of the for-await (and the partial frame is not flushed)', async () => {
    const source = new Readable({ read() {} });
    source.push(Buffer.alloc(FRAME_BYTES * 2 + 10, 7));
    const frames = [];
    await assert.rejects(async () => {
      for await (const frame of readFrames(source)) {
        frames.push(frame);
        if (frames.length === 2) source.destroy(new Error('decoder blew up'));
      }
    }, /decoder blew up/);
    assert.equal(frames.length, 2);

    async function* failing() {
      yield Buffer.alloc(FRAME_BYTES);
      throw new Error('read failed');
    }
    await assert.rejects(async () => {
      for await (const frame of readFrames(Readable.from(failing()))) assertOwnFrame(frame);
    }, /read failed/);
  });

  test('works with any (async) iterable of chunks', async () => {
    async function* chunks() {
      yield new Uint8Array(FRAME_BYTES).fill(1);
      yield Buffer.from([2]);
    }
    const frames = [];
    for await (const frame of readFrames(chunks())) frames.push(frame);
    assert.equal(frames.length, 2);
    assert.equal(frames[1][0], 2); // little-endian: the lone byte is the low half of the first sample
    assert.equal(frames[1][1], 0);
  });

  test('leaving the loop early destroys the stream', async () => {
    const source = Readable.from([Buffer.alloc(FRAME_BYTES * 3)]);
    for await (const frame of readFrames(source)) {
      assertOwnFrame(frame);
      break;
    }
    assert.equal(source.destroyed, true);
  });
});
