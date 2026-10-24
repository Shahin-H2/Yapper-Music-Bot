/**
 * Entry point (`npm start` runs `node --env-file=.env bot.js`): loads the settings and the cogs in ./cogs, then runs
 * the bot until SIGINT or SIGTERM. A second signal, or a shutdown that takes over 8 s, exits at once.
 */
import { fileURLToPath } from 'node:url';
import { Bot } from './yapper.js';
import { loadConfig } from './src/config.js';
import { createLogger, setLogLevel } from './src/log.js';

const SHUTDOWN_TIMEOUT_MS = 8000;
const COGS_DIR = fileURLToPath(new URL('./cogs/', import.meta.url));
const log = createLogger('bot');
let stopping = false;

// Last resort: a stray rejection is logged and the bot carries on; after an uncaught exception its state is unknown.
process.on('unhandledRejection', (reason) => log.error('unhandled promise rejection:', reason));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception, exiting:', err?.stack ?? err);
  process.exit(1);
});

/** '[music /play]' for an error a cog threw, else 'yapper:'. */
const origin = (err) => (err?.cog ? `[${err.cog}${err.where ? ` ${err.where}` : ''}]` : 'yapper:');

/** Runs once: stops polling, unloads the cogs (players leave voice), closes LiveKit, exits with `code`. */
async function shutdown(bot, why, code = 0) {
  if (stopping) return;
  stopping = true;
  log.info(`${why}: shutting down…`);
  const watchdog = setTimeout(() => {
    log.error(`shutting down took over ${SHUTDOWN_TIMEOUT_MS / 1000} s; exiting anyway`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  watchdog.unref();
  // Before unloading: while the bot runs, each unload sends Yapin’ the shrinking command list.
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
    process.exitCode = 1; // not process.exit(), which can cut the message off
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
