/**
 * One server's play queue: the current track, the tracks up next and the loop mode. Pure state with no I/O, timers
 * or events; the player drives it.
 */

/** @typedef {'off'|'track'|'queue'} LoopModeValue */
/** @typedef {'ended'|'skipped'|'failed'} AdvanceReason */
/** @typedef {object} Track Shape in src/tracks.js; the queue never reads it. */

export const LoopMode = Object.freeze({ OFF: 'off', TRACK: 'track', QUEUE: 'queue' });
/** In the order the loop button cycles through them (nextLoopMode). */
export const LOOP_MODES = Object.freeze([LoopMode.OFF, LoopMode.TRACK, LoopMode.QUEUE]);
export const ADVANCE_REASONS = Object.freeze(['ended', 'skipped', 'failed']);

// A Map rather than an object, so typed text like 'constructor' or '__proto__' can't hit Object.prototype.
const ALIASES = new Map([
  ...['off', 'none', '0', 'false'].map((k) => [k, LoopMode.OFF]),
  ...['track', 'song', 'one', 'single', '1'].map((k) => [k, LoopMode.TRACK]),
  ...['queue', 'all', 'list', 'q'].map((k) => [k, LoopMode.QUEUE]),
]);

// Describes a bad argument for an error message. These messages can reach chat, so only short plain strings are
// quoted back; typed text (mentions, markdown, links) must never come out verbatim.
const show = (v) => {
  if (typeof v === 'string') return /^[\w .+-]{0,24}$/.test(v) ? `"${v}"` : 'a string';
  return (v !== null && typeof v === 'object') || typeof v === 'function' ? typeof v : String(v);
};

/** Cycles off, track, queue; anything else gives 'off'. */
export function nextLoopMode(mode) {
  const i = LOOP_MODES.indexOf(mode);
  return i === -1 ? LoopMode.OFF : LOOP_MODES[(i + 1) % LOOP_MODES.length];
}

/**
 * Accepts the aliases above in any case, with surrounding spaces.
 * @returns {LoopModeValue|null} null when the text isn't a loop mode
 */
export function parseLoopMode(text) {
  return typeof text === 'string' ? ALIASES.get(text.trim().toLowerCase()) ?? null : null;
}

/** Thrown by Queue#add. The message is shown in chat. */
export class QueueFullError extends Error {
  constructor(maxSize) {
    super(`The queue is full (${maxSize} track${maxSize === 1 ? '' : 's'} max).`);
    this.name = 'QueueFullError';
    this.code = 'QUEUE_FULL';
    this.maxSize = maxSize;
  }
}

/** Tracks are kept by reference: the object passed to add() is the one that comes back out. */
export class Queue {
  /** @type {Track|null} */
  #current = null;
  /** @type {Track[]} */
  #upcoming = [];
  /** @type {LoopModeValue} */
  #loop = LoopMode.OFF;
  #maxSize;

  /** @param {{ maxSize?: number }} [opts] maxSize caps the upcoming list; the current track doesn't count */
  constructor({ maxSize = 100 } = {}) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new RangeError(`maxSize must be a whole number of at least 1 (got ${show(maxSize)})`);
    }
    this.#maxSize = maxSize;
  }

  get current() { return this.#current; }
  get upcoming() { return [...this.#upcoming]; }
  get length() { return this.#upcoming.length; }
  get isEmpty() { return this.#current === null && this.#upcoming.length === 0; }
  get maxSize() { return this.#maxSize; }
  get loop() { return this.#loop; }
  /** Exact modes only: run typed text through parseLoopMode first. */
  set loop(mode) {
    if (!LOOP_MODES.includes(mode)) {
      throw new TypeError(`Loop mode must be one of ${LOOP_MODES.join(', ')} (got ${show(mode)})`);
    }
    this.#loop = mode;
  }

  /**
   * @returns {number} the track's 1-based position in the upcoming list
   * @throws {QueueFullError} when maxSize tracks are already waiting
   */
  add(track) {
    if (!track || typeof track !== 'object') throw new TypeError(`add() needs a track object (got ${show(track)})`);
    if (this.#upcoming.length >= this.#maxSize) throw new QueueFullError(this.#maxSize);
    return this.#upcoming.push(track);
  }

  /**
   * Moves past the current track and returns the new one, or null when nothing is left. Loop 'track' replays the
   * track only when it 'ended'; loop 'queue' sends it to the back (even past maxSize) unless it 'failed'.
   * @param {AdvanceReason} [reason]
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

  /** Mirrors advance('ended') without changing anything. */
  peek() {
    const cur = this.#current;
    if (cur && this.#loop === LoopMode.TRACK) return cur;
    return this.#upcoming[0] ?? (this.#loop === LoopMode.QUEUE ? cur : null);
  }

  /**
   * @param {number} position 1-based, as /queue numbers the tracks
   * @throws {RangeError} for any bad position; the cog relies on that and shows the message in chat
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
   * Fisher-Yates over the upcoming tracks; the current one stays put.
   * @returns {number} how many tracks were shuffled
   */
  shuffle(random = Math.random) {
    if (typeof random !== 'function') {
      throw new TypeError(`shuffle() needs a function like Math.random (got ${show(random)})`);
    }
    const a = [...this.#upcoming]; // a copy, so a random() that throws leaves the queue as it was
    for (let i = a.length - 1; i > 0; i--) {
      // Clamped (NaN gives 0) so a random() outside [0, 1) can't index past the end and leave holes in the queue.
      const j = Math.min(i, Math.floor(Math.max(0, random()) * (i + 1))) || 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    this.#upcoming = a;
    return a.length;
  }

  /** The current track plays on. @returns {number} how many were removed */
  clear() {
    const n = this.#upcoming.length;
    this.#upcoming = [];
    return n;
  }

  /** Drops the current track as well; the loop mode stays. @returns {number} how many were dropped */
  reset() {
    const n = this.#upcoming.length + (this.#current ? 1 : 0);
    this.#current = null;
    this.#upcoming = [];
    return n;
  }
}
