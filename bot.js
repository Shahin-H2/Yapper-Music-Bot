/**
 * DLS_bot's entry point: `npm start` runs `node --env-file=.env bot.js`.
 *
 * Reads the settings (src/config.js), starts the yapper.js bot with every cog in ./cogs and, on Ctrl+C or SIGTERM,
 * shuts down cleanly: event polling stops first, then each cog unloads (the music cog leaves every voice channel),
 * then LiveKit closes. A second signal, or a shutdown that takes longer than 8 s, ends the process right away.
 */
import { fileURLToPath } from 'node:url';
import { Bot } from './yapper.js';
import { loadConfig } from './src/config.js';
import { createLogger, setLogLevel } from './src/log.js';

const SHUTDOWN_TIMEOUT_MS = 8000;
const COGS_DIR = fileURLToPath(new URL('./cogs/', import.meta.url));
const log = createLogger('bot');
let stopping = false;

// Last-resort nets: a stray rejection is logged and the bot carries on; after an exception its state is unknown.
process.on('unhandledRejection', (reason) => log.error('unhandled promise rejection:', reason));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception, exiting:', err?.stack ?? err);
  process.exit(1);
});

/** Where an error from yapper.js came from: '[music /play]' for one a cog threw, else 'yapper:'. */
const origin = (err) => (err?.cog ? `[${err.cog}${err.where ? ` ${err.where}` : ''}]` : 'yapper:');

/** Stops polling, unloads every cog (players leave voice), closes LiveKit, exits with `code`. Runs once. */
async function shutdown(bot, why, code = 0) {
  if (stopping) return;
  stopping = true;
  log.info(`${why}: shutting down…`);
  const watchdog = setTimeout(() => {
    log.error(`shutting down took over ${SHUTDOWN_TIMEOUT_MS / 1000} s; exiting anyway`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  watchdog.unref();
  // First: unloading cogs while the bot still runs would send Yapin’ a shrinking command list.
  bot.stop();
  for (const name of [...bot.cogs.keys()].reverse()) {
    try {
      await bot.unload(name);
    } catch (err) {
      log.error(`unloading ${name} failed:`, err);
    }
  }
  try {
    const rtc = await import('@livekit/rtc-node');
    await rtc.dispose();
  } catch (err) {
    log.warn('closing LiveKit failed:', err);
  }
  clearTimeout(watchdog);
  process.exit(code);
}

function onSignal(bot, signal) {
  if (stopping) {
    log.warn(`${signal} again: exiting right away`);
    process.exit(1);
  }
  void shutdown(bot, signal);
}

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  for (const warning of config.warnings) log.warn(warning);
  if (!config.token) {
    log.error("YAPPER_BOT_TOKEN isn't set. Copy .env.example to .env, put your bot token in it (Yapin’ → "
      + 'Settings → Developer → Create) and start the bot with `npm start`.');
    process.exitCode = 1; // exit by running out of work, so the message isn't cut off
    return;
  }
  let bot;
  try {
    bot = new Bot(config.token);
  } catch (err) {
    log.error(err?.message ?? err);
    process.exitCode = 1;
    return;
  }
  bot.on('error', (err) => log.error(origin(err), err));
  bot.on('ready', () => {
    bot.setStatus('online', config.statusText).catch((err) => log.warn("couldn't set the bot's status:", err));
  });
  try {
    await bot.loadCogs(COGS_DIR);
  } catch (err) {
    log.error(err?.message ?? err);
    void shutdown(bot, 'loading the cogs failed', 1);
    return;
  }
  process.on('SIGINT', () => onSignal(bot, 'SIGINT'));
  process.on('SIGTERM', () => onSignal(bot, 'SIGTERM'));
  bot.start().then(
    // start() only returns by itself when Yapin’ stopped taking the token.
    () => { if (!stopping) void shutdown(bot, 'the bot stopped', 1); },
    (err) => {
      const hint = err?.status === 401 ? ' (check YAPPER_BOT_TOKEN in .env)' : '';
      log.error(`couldn't start: ${err?.message ?? err}${hint}`);
      void shutdown(bot, 'startup failed', 1);
    },
  );
}

main().catch((err) => {
  log.error('startup failed:', err?.stack ?? err);
  process.exitCode = 1;
});
