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

/** Sets the global level and returns it as parsed (' WARN ' gives 'warn'). Throws TypeError on an unknown level. */
export function setLogLevel(level) {
  const parsed = parseLogLevel(level);
  if (!parsed) throw new TypeError(`Unknown log level ${inspect(level)}: use ${LOG_LEVELS.join(', ')}`);
  return (globalLevel = parsed);
}

/** @returns {LogLevel} */
export function getLogLevel() { return globalLevel; }

/** @type {LogSink} */
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
 * @param {string} [scope] shown as `[scope]`; a child logs as `[scope:subscope]`
 * @param {{ level?: LogLevel|null, sink?: LogSink, now?: () => number|Date }} [opts]
 *   level: this logger's own minimum, instead of following the global level; now: the timestamp clock.
 * @returns {Logger}
 * @throws {TypeError} on an unknown level or a sink that isn't a function
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
    // Logging must never take the bot down (a closed stdout, a throwing sink, a bad clock).
    try {
      sink(lvl, `${stamp(now)} ${lvl.toUpperCase().padEnd(5)} [${name}]${text ? ` ${text}` : ''}`);
    } catch { /* the line is lost */ }
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
