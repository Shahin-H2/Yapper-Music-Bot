/**
 * PCM between ffmpeg and LiveKit: cuts the decoded byte stream into frames and applies the volume as a gain.
 * Pure: no I/O beyond the stream passed in.
 */

// LiveKit takes 10 ms frames of 48 kHz interleaved stereo s16 PCM (960 samples, 1920 bytes).
export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const FRAME_MS = 10;
export const SAMPLES_PER_CHANNEL = (SAMPLE_RATE / 1000) * FRAME_MS;
export const FRAME_SAMPLES = SAMPLES_PER_CHANNEL * CHANNELS;
export const FRAME_BYTES = FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT;
// Volume is a whole percent: 100 plays as decoded, 200 doubles the amplitude.
export const MIN_VOLUME = 1;
export const MAX_VOLUME = 200;

const INT16_MIN = -32768;
const INT16_MAX = 32767;
// ffmpeg writes little-endian and Int16Array reads in host order. Every platform LiveKit ships binaries for is
// little-endian, but a big-endian host would play static without the byte swap in #take().
const BIG_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 0;

const show = (v) => (typeof v === 'number' ? String(v) : typeof v);
const clip = (v) => (v > INT16_MAX ? INT16_MAX : v < INT16_MIN ? INT16_MIN : v);

function assertGain(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new RangeError(`${what} must be a finite number >= 0, got ${show(v)}`);
  }
}

/**
 * Rounds to a whole percent within MIN_VOLUME..MAX_VOLUME.
 * @throws {RangeError} unless v is a finite number; nothing is coerced, so '' or null can't become 1
 */
export function clampVolume(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new RangeError(`Volume must be a finite number, got ${show(v)}`);
  }
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, Math.round(v)));
}

/**
 * A volume from user input such as '150', '150%' or ' 80 '. Only whole percents within MIN_VOLUME..MAX_VOLUME count.
 * @returns {number|null} null for anything else, including '1.5', '1e2' and ''
 */
export function parseVolume(text) {
  if (typeof text === 'number') return Number.isInteger(text) && text >= MIN_VOLUME && text <= MAX_VOLUME ? text : null;
  if (typeof text !== 'string') return null;
  const m = /^(\d+)\s*%?$/.exec(text.trim());
  const v = m ? Number(m[1]) : NaN;
  return v >= MIN_VOLUME && v <= MAX_VOLUME ? v : null;
}

export function volumeToGain(volume) {
  assertGain(volume, 'Volume');
  return volume / 100;
}

/**
 * Scales interleaved stereo in place and returns it, ramping the gain linearly from fromGain to toGain across the
 * frame so a volume change fades over 10 ms instead of clicking. Results are rounded and clipped to 16 bits.
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
    // Start one step past fromGain (the previous frame ended on it) and end on exactly toGain, not a float next to
    // it, so the next frame continues without a jump.
    const gain = p === pairs - 1 ? toGain : fromGain + step * (p + 1);
    const i = p * 2;
    samples[i] = clip(Math.round(samples[i] * gain));
    if (i + 1 < n) samples[i + 1] = clip(Math.round(samples[i + 1] * gain));
  }
  return samples;
}

function asBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  const got = chunk === null ? 'null' : typeof chunk;
  throw new TypeError(`PcmFramer.push needs bytes (a Buffer or Uint8Array), got ${got}`);
}

/**
 * Cuts a byte stream into 10 ms frames. Each frame is copied into its own FRAME_BYTES ArrayBuffer: rtc-node reads a
 * frame's WHOLE ArrayBuffer from offset 0, so a view into a pooled Buffer would play the memory around it. Chunks
 * may have any size or alignment; a sample split across two chunks is reassembled.
 */
export class PcmFramer {
  // The frame being filled. Each one is a fresh allocation, so an unfilled tail is already silence for flush().
  #frame = null;
  #bytes = null;
  #filled = 0;

  get pendingBytes() { return this.#filled; }

  /** The frames this chunk completed (often none); leftover bytes wait for the next push. */
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

  /** The leftover bytes as a last frame padded with silence, or null when there are none. */
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
 * Frames from a byte stream such as ffmpeg's stdout, the last one padded with silence. Reads only as fast as the
 * consumer pulls, so a paused file parks ffmpeg on a full pipe; leaving the loop early destroys the stream.
 */
export async function* readFrames(readable) {
  const framer = new PcmFramer();
  for await (const chunk of readable) {
    for (const frame of framer.push(chunk)) yield frame;
  }
  const last = framer.flush();
  if (last) yield last;
}
