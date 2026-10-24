/**
 * PCM for the voice pipeline: ffmpeg writes 48 kHz stereo signed 16-bit little-endian bytes, LiveKit takes 10 ms
 * frames, and the volume is a gain applied to each frame on the way. Pure: no I/O beyond the stream you pass in.
 *
 *   let gain = volumeToGain(volume);
 *   for await (const pcm of readFrames(decoder.stdout)) {   // Int16Array(960), each with its own 1920-byte buffer
 *     const target = volumeToGain(volume);
 *     applyGain(pcm, gain, target);                         // ramps, so a volume change doesn't click
 *     gain = target;
 *     await source.captureFrame(new rtc.AudioFrame(pcm, SAMPLE_RATE, CHANNELS, SAMPLES_PER_CHANNEL));
 *   }
 */

/** Samples per second, per channel. */
export const SAMPLE_RATE = 48000;
/** Interleaved stereo: L R L R … */
export const CHANNELS = 2;
/** Length of one frame, the unit AudioSource.captureFrame takes. */
export const FRAME_MS = 10;
/** 480 samples per channel in a frame. */
export const SAMPLES_PER_CHANNEL = (SAMPLE_RATE / 1000) * FRAME_MS;
/** 960 interleaved samples in a frame. */
export const FRAME_SAMPLES = SAMPLES_PER_CHANNEL * CHANNELS;
/** 1920 bytes in a frame (2 bytes a sample). */
export const FRAME_BYTES = FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT;
/** Volume is a whole percent: 100 plays as decoded, 200 doubles the amplitude. */
export const MIN_VOLUME = 1;
export const MAX_VOLUME = 200;

const INT16_MIN = -32768;
const INT16_MAX = 32767;
// Int16Array reads bytes in the host's order and ffmpeg writes little-endian. Every platform LiveKit ships binaries
// for is little-endian, but a big-endian host would otherwise play static.
const BIG_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 0;

/** A bad number as it reads in an error message (never calls toString on objects). */
const show = (v) => (typeof v === 'number' ? String(v) : typeof v);
const clip = (v) => (v > INT16_MAX ? INT16_MAX : v < INT16_MIN ? INT16_MIN : v);

/** Throws a RangeError unless v is a finite number >= 0. */
function assertGain(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new RangeError(`${what} must be a finite number >= 0, got ${show(v)}`);
  }
}

/**
 * A volume rounded to a whole percent and kept within MIN_VOLUME..MAX_VOLUME: 0 → 1, 99.5 → 100, 250 → 200.
 * @param {number} v
 * @returns {number}
 * @throws {RangeError} when v isn't a finite number (strings aren't converted: '' or null must not become 1)
 */
export function clampVolume(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new RangeError(`Volume must be a finite number, got ${show(v)}`);
  }
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, Math.round(v)));
}

/**
 * A volume from what someone typed: '150', '150%' and ' 80 ' give 150, 150 and 80. Only whole percents from
 * MIN_VOLUME to MAX_VOLUME count; anything else ('abc', '0', '201', '1.5', '1e2', '', null) gives null.
 * A number is accepted when it is already such a whole percent.
 * @param {unknown} text
 * @returns {number|null}
 */
export function parseVolume(text) {
  if (typeof text === 'number') return Number.isInteger(text) && text >= MIN_VOLUME && text <= MAX_VOLUME ? text : null;
  if (typeof text !== 'string') return null;
  const m = /^(\d+)\s*%?$/.exec(text.trim());
  const v = m ? Number(m[1]) : NaN;
  return v >= MIN_VOLUME && v <= MAX_VOLUME ? v : null;
}

/**
 * The linear gain for a volume: volume / 100, so 200 % is twice the amplitude (about +6 dB).
 * @param {number} volume percent
 * @returns {number}
 * @throws {RangeError} for a negative or non-finite volume
 */
export function volumeToGain(volume) {
  assertGain(volume, 'Volume');
  return volume / 100;
}

/**
 * Scales interleaved stereo samples in place and returns the same array. The gain moves in a straight line from
 * `fromGain` to `toGain` across the frame, both samples of an L/R pair getting the same gain and the last pair
 * exactly `toGain`, so a volume change fades over 10 ms instead of clicking. Results are rounded (Math.round) and
 * clipped to 16 bits. An odd-length array is handled as pairs plus a lone last sample. Gain 1 → 1 changes nothing.
 * @param {Int16Array} samples
 * @param {number} fromGain the gain the previous frame ended on
 * @param {number} [toGain] the gain this frame ends on (default fromGain: constant)
 * @returns {Int16Array} samples
 * @throws {TypeError} when samples isn't an Int16Array
 * @throws {RangeError} for a negative or non-finite gain
 */
export function applyGain(samples, fromGain, toGain = fromGain) {
  if (!(samples instanceof Int16Array)) throw new TypeError('applyGain needs an Int16Array of samples');
  assertGain(fromGain, 'fromGain');
  assertGain(toGain, 'toGain');
  if (fromGain === 1 && toGain === 1) return samples;
  const n = samples.length;
  const pairs = Math.ceil(n / 2);
  const step = (toGain - fromGain) / pairs;
  for (let p = 0; p < pairs; p++) {
    // The first pair is one step past fromGain (the previous frame ended on it); the last is toGain, not a float
    // that lands next to it, so the next frame continues without a jump.
    const gain = p === pairs - 1 ? toGain : fromGain + step * (p + 1);
    const i = p * 2;
    samples[i] = clip(Math.round(samples[i] * gain));
    if (i + 1 < n) samples[i + 1] = clip(Math.round(samples[i + 1] * gain));
  }
  return samples;
}

/** Any chunk of bytes as a Uint8Array view (no copy). */
function asBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  const got = chunk === null ? 'null' : typeof chunk;
  throw new TypeError(`PcmFramer.push needs bytes (a Buffer or Uint8Array), got ${got}`);
}

/**
 * Cuts a byte stream into 10 ms frames for AudioSource.captureFrame. Every frame is a new Int16Array(FRAME_SAMPLES)
 * on its own FRAME_BYTES-long ArrayBuffer (byteOffset 0), filled by copying: rtc-node hands native code the frame's
 * WHOLE ArrayBuffer, so a view into a pooled Buffer would play the memory around it. Chunks can therefore have any
 * size and byte offset, odd ones included, and a sample split over two chunks is put back together.
 */
export class PcmFramer {
  /** @type {Int16Array|null} the frame being filled; freshly allocated, so its unfilled tail is already silence */
  #frame = null;
  /** @type {Uint8Array|null} byte view of #frame */
  #bytes = null;
  #filled = 0;

  /** Bytes waiting for the rest of their frame (0 to FRAME_BYTES - 1). */
  get pendingBytes() { return this.#filled; }

  /**
   * @param {Uint8Array|ArrayBufferView|ArrayBuffer} chunk e.g. a Buffer from ffmpeg's stdout
   * @returns {Int16Array[]} the frames this chunk completed (none, one or many); the rest is kept for the next push
   * @throws {TypeError} for something that isn't bytes (a string, say)
   */
  push(chunk) {
    const src = asBytes(chunk);
    const frames = [];
    for (let at = 0; at < src.length;) {
      if (!this.#frame) {
        this.#frame = new Int16Array(FRAME_SAMPLES);
        this.#bytes = new Uint8Array(this.#frame.buffer);
      }
      const n = Math.min(FRAME_BYTES - this.#filled, src.length - at);
      this.#bytes.set(src.subarray(at, at + n), this.#filled);
      this.#filled += n;
      at += n;
      if (this.#filled === FRAME_BYTES) frames.push(this.#take());
    }
    return frames;
  }

  /**
   * The leftover bytes as one last frame padded with silence, or null when there are none. Starts over afterwards.
   * @returns {Int16Array|null}
   */
  flush() { return this.#filled > 0 ? this.#take() : null; }

  #take() {
    const frame = this.#frame;
    const bytes = this.#bytes;
    if (BIG_ENDIAN) {
      for (let i = 0; i < FRAME_BYTES; i += 2) { const b = bytes[i]; bytes[i] = bytes[i + 1]; bytes[i + 1] = b; }
    }
    this.#frame = this.#bytes = null;
    this.#filled = 0;
    return frame;
  }
}

/**
 * Yields 10 ms frames (see PcmFramer) from a byte stream such as ffmpeg's stdout; the last, partial one is padded
 * with silence. It reads only as fast as you consume, so a consumer that stops pulling parks the producer
 * (back-pressure). A stream error is thrown out of your for-await; leaving the loop early destroys the stream.
 * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} readable a Readable, or any (async) iterable of byte chunks
 * @returns {AsyncGenerator<Int16Array, void, undefined>}
 */
export async function* readFrames(readable) {
  const framer = new PcmFramer();
  for await (const chunk of readable) {
    for (const frame of framer.push(chunk)) yield frame;
  }
  const last = framer.flush();
  if (last) yield last;
}
