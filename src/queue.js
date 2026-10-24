/**
 * The play queue of one server: the track playing now, the tracks up next and the loop mode. Pure state (no I/O,
 * timers or events), so the player drives it and every transition is easy to test.
 *
 *   const q = new Queue({ maxSize: 100 });
 *   q.add(a); q.add(b);   // → 1, 2 (positions in the upcoming list)
 *   q.advance();          // → a, now playing
 *   q.loop = 'queue';
 *   q.peek();             // → b: what plays when a ends
 *   q.advance('ended');   // → b, and a goes to the back so the queue comes round again
 */

/** @typedef {'off'|'track'|'queue'} LoopModeValue */
/** @typedef {'ended'|'skipped'|'failed'} AdvanceReason */
/** @typedef {object} Track A track (shape in src/tracks.js). The queue keeps references and never reads them. */

/** off: play the queue once · track: repeat the current track · queue: send each played track to the back. */
export const LoopMode = Object.freeze({ OFF: 'off', TRACK: 'track', QUEUE: 'queue' });
/** Every loop mode, in the order the loop button cycles through them. */
export const LOOP_MODES = Object.freeze([LoopMode.OFF, LoopMode.TRACK, LoopMode.QUEUE]);
/** Why the current track stopped (Queue#advance): it played to the end, someone skipped it, or it couldn't play. */
export const ADVANCE_REASONS = Object.freeze(['ended', 'skipped', 'failed']);

// A Map rather than an object, so typed text like 'constructor' or '__proto__' can't hit Object.prototype.
const ALIASES = new Map([
  ...['off', 'none', '0', 'false'].map((k) => [k, LoopMode.OFF]),
  ...['track', 'song', 'one', 'single', '1'].map((k) => [k, LoopMode.TRACK]),
  ...['queue', 'all', 'list', 'q'].map((k) => [k, LoopMode.QUEUE]),
]);

/**
 * A bad argument as it reads in an error message. Only short plain strings are quoted back: the cog may show the
 * message in chat, so typed text (mentions, markdown, links) must never come out verbatim.
 */
const show = (v) => {
  if (typeof v === 'string') return /^[\w .+-]{0,24}$/.test(v) ? `"${v}"` : 'a string';
  return (v !== null && typeof v === 'object') || typeof v === 'function' ? typeof v : String(v);
};

/**
 * The mode after `mode`: off → track → queue → off. Anything that isn't a mode gives 'off'.
 * @param {unknown} mode
 * @returns {LoopModeValue}
 */
export function nextLoopMode(mode) {
  const i = LOOP_MODES.indexOf(mode);
  return i === -1 ? LoopMode.OFF : LOOP_MODES[(i + 1) % LOOP_MODES.length];
}

/**
 * A loop mode from what someone typed, in any case, spaces around it ignored:
 * off/none/0/false → 'off', track/song/one/single/1 → 'track', queue/all/list/q → 'queue'.
 * @param {unknown} text
 * @returns {LoopModeValue|null} null when it isn't a mode (or isn't a string)
 */
export function parseLoopMode(text) {
  return typeof text === 'string' ? ALIASES.get(text.trim().toLowerCase()) ?? null : null;
}

/** Thrown by Queue#add when maxSize tracks are already waiting. `code` is 'QUEUE_FULL', `maxSize` the limit. */
export class QueueFullError extends Error {
  /** @param {number} maxSize */
  constructor(maxSize) {
    super(`The queue is full (${maxSize} track${maxSize === 1 ? '' : 's'} max).`);
    this.name = 'QueueFullError';
    this.code = 'QUEUE_FULL';
    this.maxSize = maxSize;
  }
}

/**
 * Now playing + up next + loop mode. Tracks are kept by reference: the object you add is the one that comes back
 * from advance(), peek(), remove() and upcoming.
 */
export class Queue {
  /** @type {Track|null} */
  #current = null;
  /** @type {Track[]} */
  #upcoming = [];
  /** @type {LoopModeValue} */
  #loop = LoopMode.OFF;
  #maxSize;

  /** @param {{ maxSize?: number }} [opts] maxSize: how many tracks may wait (the current one doesn't count) */
  constructor({ maxSize = 100 } = {}) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new RangeError(`maxSize must be a whole number of at least 1 (got ${show(maxSize)})`);
    }
    this.#maxSize = maxSize;
  }

  /** The track playing now, or null. */
  get current() { return this.#current; }
  /** The waiting tracks in play order, as a copy: changing it doesn't change the queue. */
  get upcoming() { return [...this.#upcoming]; }
  /** How many tracks are waiting (the current one isn't counted). */
  get length() { return this.#upcoming.length; }
  /** Nothing playing and nothing waiting. */
  get isEmpty() { return this.#current === null && this.#upcoming.length === 0; }
  /** The most tracks that may wait. */
  get maxSize() { return this.#maxSize; }
  /** 'off', 'track' or 'queue'. */
  get loop() { return this.#loop; }
  /** Applies from the next advance()/peek(). Exact modes only: run typed text through parseLoopMode first. */
  set loop(mode) {
    if (!LOOP_MODES.includes(mode)) {
      throw new TypeError(`Loop mode must be one of ${LOOP_MODES.join(', ')} (got ${show(mode)})`);
    }
    this.#loop = mode;
  }

  /**
   * Adds a track at the end.
   * @param {Track} track
   * @returns {number} its 1-based position in upcoming
   * @throws {QueueFullError} when maxSize tracks are already waiting
   */
  add(track) {
    if (!track || typeof track !== 'object') throw new TypeError(`add() needs a track object (got ${show(track)})`);
    if (this.#upcoming.length >= this.#maxSize) throw new QueueFullError(this.#maxSize);
    return this.#upcoming.push(track);
  }

  /**
   * Moves on once the current track stops and returns what plays now (null when nothing is left):
   * - 'ended' in loop 'track' replays the current track;
   * - in loop 'queue' the current track first goes to the back (even past maxSize), unless it 'failed';
   * - otherwise it's dropped. Then the first waiting track becomes current.
   * @param {AdvanceReason} [reason]
   * @returns {Track|null}
   */
  advance(reason = 'ended') {
    if (!ADVANCE_REASONS.includes(reason)) {
      throw new TypeError(`advance() reason must be one of ${ADVANCE_REASONS.join(', ')} (got ${show(reason)})`);
    }
    const cur = this.#current;
    if (cur && reason === 'ended' && this.#loop === LoopMode.TRACK) return cur;
    // A failed track would only fail again next lap, so it never goes back in.
    if (cur && reason !== 'failed' && this.#loop === LoopMode.QUEUE) this.#upcoming.push(cur);
    this.#current = this.#upcoming.shift() ?? null;
    return this.#current;
  }

  /**
   * What plays after the current track ends on its own (exactly what advance('ended') would return), without
   * changing anything.
   * @returns {Track|null}
   */
  peek() {
    const cur = this.#current;
    if (cur && this.#loop === LoopMode.TRACK) return cur;
    return this.#upcoming[0] ?? (this.#loop === LoopMode.QUEUE ? cur : null);
  }

  /**
   * Takes a waiting track out of the queue.
   * @param {number} position 1-based, as numbered in the queue list
   * @returns {Track} the removed track
   * @throws {RangeError} unless position is a whole number from 1 to length
   */
  remove(position) {
    const n = this.#upcoming.length;
    if (!Number.isInteger(position) || position < 1 || position > n) {
      throw new RangeError(n === 0 ? 'Nothing to remove: the queue is empty'
        : `Position must be a whole number from 1 to ${n} (got ${show(position)})`);
    }
    return this.#upcoming.splice(position - 1, 1)[0];
  }

  /**
   * Shuffles the waiting tracks (Fisher–Yates). The current track stays where it is.
   * @param {() => number} [random] like Math.random; pass your own for repeatable tests
   * @returns {number} how many tracks were shuffled
   */
  shuffle(random = Math.random) {
    if (typeof random !== 'function') {
      throw new TypeError(`shuffle() needs a function like Math.random (got ${show(random)})`);
    }
    const a = [...this.#upcoming]; // shuffled as a copy: if random() throws, the queue stays as it was
    for (let i = a.length - 1; i > 0; i--) {
      // Clamped (NaN → 0) so a random() outside [0, 1) can't index past the end and leave holes in the queue.
      const j = Math.min(i, Math.floor(Math.max(0, random()) * (i + 1))) || 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    this.#upcoming = a;
    return a.length;
  }

  /**
   * Empties the waiting list; the current track keeps playing.
   * @returns {number} how many tracks were removed
   */
  clear() {
    const n = this.#upcoming.length;
    this.#upcoming = [];
    return n;
  }

  /**
   * Forgets the current track and every waiting one (the loop mode stays).
   * @returns {number} how many tracks were dropped, the current one included
   */
  reset() {
    const n = this.#upcoming.length + (this.#current ? 1 : 0);
    this.#current = null;
    this.#upcoming = [];
    return n;
  }
}
