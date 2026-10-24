/**
 * Leveled logger that writes one line per call: `<ISO time> <LEVEL> [scope] <message>`.
 * Loggers created without a level follow the global one (LOG_LEVEL at import, then setLogLevel()).
 * Errors print their stack only at debug level.
 */
import { inspect, types } from 'node:util';

/** @typedef {'debug'|'info'|'warn'|'error'} LogLevel */
/** @typedef {(level: LogLevel, line: string) => void} LogSink */
/**
 * @typedef {{ debug: (...args: unknown[]) => void, info: (...args: unknown[]) => void,
 *   warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void,
 *   child: (subscope: string) => Logger, readonly level: LogLevel }} Logger
 */

// Most verbose first: a level's index is its rank.
export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
const RANK = new Map(LOG_LEVELS.map((level, i) => [level, i]));

/** Ignores case and surrounding whitespace. @returns {LogLevel|null} null for anything that isn't a level */
export function parseLogLevel(value) {
  const level = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return RANK.has(level) ? /** @type {LogLevel} */ (level) : null;
}

let globalLevel = parseLogLevel(process.env.LOG_LEVEL) ?? 'info';

/**
 * Set the level of every logger that wasn't created with its own. Throws TypeError on an unknown level.
 * @param {string} level
 * @returns {LogLevel}
 */
export function setLogLevel(level) {
  const parsed = parseLogLevel(level);
  if (!parsed) throw new TypeError(`Unknown log level ${inspect(level)}: use ${LOG_LEVELS.join(', ')}`);
  return (globalLevel = parsed);
}

/** The level loggers without their own level use right now. @returns {LogLevel} */
export function getLogLevel() { return globalLevel; }

/** The default sink: warn → console.warn, error → console.error, debug/info → console.log. @type {LogSink} */
export function consoleSink(level, line) {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function formatError(err, verbose) {
  let text = verbose && err.stack ? String(err.stack) : String(err.message || err.name || 'Error');
  const cause = err.cause;
  if (cause !== undefined && cause !== null) {
    const isErr = cause instanceof Error || types.isNativeError(cause);
    if (verbose && isErr && cause.stack) text += `\n  [cause] ${cause.stack}`;
    else text += ` (cause: ${isErr ? cause.message || cause.name : inspect(cause, { breakLength: Infinity })})`;
  }
  return text;
}

function formatArg(arg, verbose) {
  try {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error || types.isNativeError(arg)) return formatError(arg, verbose);
    return inspect(arg, { depth: 4, breakLength: Infinity });
  } catch {
    return '[unprintable]'; // e.g. a Proxy whose traps throw
  }
}

function stamp(now) {
  const date = new Date(now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/**
 * A logger for one part of the bot.
 * @param {string} [scope] shown in brackets, e.g. 'player' → [player]
 * @param {{ level?: LogLevel|null, sink?: LogSink, now?: () => number|Date }} [opts]
 *   level: this logger's own minimum level (unknown level → TypeError); left out, it follows the global level.
 *   sink: gets (level, line) for every line that passes the level; defaults to the console.
 *   now: the clock for timestamps (tests pin it).
 * @returns {Logger}
 */
export function createLogger(scope = 'app', { level = null, sink = consoleSink, now = Date.now } = {}) {
  const own = level === null || level === undefined ? null : parseLogLevel(level);
  if (level !== null && level !== undefined && !own) {
    throw new TypeError(`Unknown log level ${inspect(level)}: use ${LOG_LEVELS.join(', ')}`);
  }
  if (typeof sink !== 'function') throw new TypeError('createLogger: sink must be a function');
  const name = String(scope);
  const threshold = () => own ?? globalLevel;
  const write = (lvl, args) => {
    const min = threshold();
    if (RANK.get(lvl) < RANK.get(min)) return;
    const text = args.map((a) => formatArg(a, min === 'debug')).join(' ');
    // Logging must never take the bot down (a closed stdout, a broken test sink, a bad clock).
    try {
      sink(lvl, `${stamp(now)} ${lvl.toUpperCase().padEnd(5)} [${name}]${text ? ` ${text}` : ''}`);
    } catch { /* the line is lost, the bot keeps going */ }
  };
  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    child: (subscope) => createLogger(`${name}:${subscope}`, { level: own, sink, now }),
    get level() { return threshold(); },
  };
}
