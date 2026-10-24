/**
 * The music cog: commands, buttons and voice events as thin glue over src/ (tracks, players, voice, cards).
 * yapper.js handles one event at a time and awaits each handler, and a click must be answered within 3 s, so
 * handlers keep their waits short and bounded and never await their own replies (see #command). Joining voice and
 * playback run detached; what happens there is posted from each Player's events, in order.
 */
import path from 'node:path';
import * as rtc from '@livekit/rtc-node';
import { Cog } from '../yapper.js';
import { MAX_VOLUME, MIN_VOLUME, parseVolume } from '../src/audio.js';
import { PROJECT_ROOT, loadConfig } from '../src/config.js';
import { FfmpegStartError, checkFfmpeg, spawnDecoder } from '../src/ffmpeg.js';
import { createLogger } from '../src/log.js';
import { Player, PlayerError, PlayerManager, PlayerState } from '../src/player.js';
import { QueueFullError, nextLoopMode, parseLoopMode } from '../src/queue.js';
import { AUDIO_EXTENSIONS, TrackLibrary } from '../src/tracks.js';
import {
  CUSTOM_ID_PREFIX, controlRows, endedEmbed, helpEmbed, loopLabel, nowPlayingEmbed, parseCustomId, queueEmbed,
  sanitize, trackAddedEmbed, tracksEmbed,
} from '../src/ui.js';
import { VoiceDirectory, connectVoice } from '../src/voice.js';

/** @typedef {import('../src/tracks.js').Track} Track */
/**
 * @typedef {object} Session the chat side of one Player
 * @property {Player} player
 * @property {{ channelId: string, messageId: string, track: Track }|null} card the Now Playing card with live buttons
 * @property {Promise<void>} chain chat work in order, so a card never overtakes the notice before it
 * @property {number} version bumped by every change the card shows (pause, volume, loop, queue)
 * @property {number} shown the version the card shows
 * @property {any} refresh pending card-refresh timer, or null
 * @property {number|null} joinedAt when the current voice connection came up (#now)
 * @property {boolean} reported a failed join was already posted
 * @property {any} joinNotice pending "still joining" timer, or null
 * @property {boolean} failedLast the last track failed, so the queue end can't say "that was the last track"
 */

const LOOKUP_MS = 3000;         // backstop: VoiceDirectory gives up after 2.5 s itself
const BUTTON_LOOKUP_MS = 1500;  // shorter: a click must be answered within 3 s
const PROBE_MS = 2000;          // ffprobe for length and tags; a slower file plays without them this time
const NAME_TTL_MS = 10 * 60_000; // voice channel names, for messages and the card footer
const NO_NAME_TTL_MS = 30_000;
const REFRESH_MS = 1500;        // Now Playing card edits are batched this long
const JOIN_GRACE_MS = 5000;     // our own voice_leave this soon after joining is stale (a /stop, then a /play)
const JOIN_NOTICE_MS = 2500;
// Yapin’ allows a bot 10 voice joins and leaves a minute across all servers. Each server, and each person, may make
// it join once per JOIN_GAP_MS (3 joins and their leaves a minute), so nobody can use up everyone's budget.
const JOIN_GAP_MS = 20_000;
const FFMPEG_RECHECK_MS = 30_000;
const LEAVE_STEP_MS = 3000;     // per step of leaving voice; a shutdown must fit bot.js's 8 s watchdog
const UNLOAD_MS = 4000;         // cogUnload: for the players to leave voice
const FLUSH_MS = 1500;          // cogUnload: then for their last chat updates

const DM_TEXT = '🚫 This only works in a server.';
const IDLE_TEXT = '💤 Nothing is playing right now. Start something with `/play`.';
const NOT_IN_VOICE = '🎧 Join a voice channel first, then try `/play` again.';
const LOOKUP_TEXT = "⚠️ I couldn't check which voice channel you're in. Try again in a moment.";
const FFMPEG_TEXT = "⚠️ I can't play anything right now: ffmpeg isn't installed on the computer I run on. "
  + 'The bot owner needs to install it (or point FFMPEG_PATH at it).';
const LOOP_USAGE = '🔁 Loop can be `off`, `track` (repeat the current track) or `queue` (repeat the whole queue).';
const REMOVE_USAGE = '🔢 Which one? `/remove <number>`, with the number `/queue` shows.';
const OOPS = '⚠️ Something went wrong there. Try again in a moment.';
const LOOP_NOTES = new Map([['off', 'tracks play once'], ['track', 'repeating the current track'],
  ['queue', 'repeating the whole queue']]);
const REASON_ICONS = new Map([['empty', '🎵'], ['bad_url', '🚫'], ['urls_disabled', '🚫'], ['bad_index', '🔢'],
  ['not_found', '🔍'], ['ambiguous', '🤔']]);

const isId = (v) => v !== undefined && v !== null && v !== '';
const sameId = (a, b) => isId(a) && isId(b) && String(a) === String(b);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const mentionOf = (userId) => (isId(userId) ? `<@${userId}>` : 'someone');
const timeoutError = (ms) => Object.assign(new Error(`no answer within ${ms} ms`), { name: 'TimeoutError' });
// Not clamped here: ui.js knows how many pages there are.
const pageOf = (text) => (/^\d{1,6}$/.test(String(text ?? '')) ? Number(text) : 1);
// Escaped for chat, minus the final period: callers put it inside their own sentence.
const reasonOf = (err) => sanitize(err?.message || String(err || 'something went wrong'), 200).replace(/[.!]+$/, '');

/** Rounded to whole seconds: '30 s', '1 min 30 s'. */
function inWords(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const s = total % 60;
  return min ? `${min} min${s ? ` ${s} s` : ''}` : `${s} s`;
}

/** The music folder as chat shows it: relative to the project, never the host's absolute path. */
function folderLabel(dir) {
  if (typeof dir !== 'string' || !dir) return './music';
  const rel = path.relative(PROJECT_ROOT, dir);
  if (!rel) return '.';
  return rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(dir) : `./${rel.split(path.sep).join('/')}`;
}

function lookupText(err) {
  if (Number(err?.status) !== 429) return LOOKUP_TEXT;
  const wait = Math.ceil(Number(err.retryAfter));
  return `⏳ Yapin’ is rate-limiting me right now. Try again in ${wait > 0 ? `${wait} s` : 'a moment'}.`;
}

export class Music extends Cog {
  #config;
  #color;
  #log;
  #library;
  #voice;
  #players;
  #connect;
  #spawn;
  #checkFfmpeg;
  #timers;
  #now;
  #random;
  #folder;
  /** @type {{ ok: boolean, version?: string|null, error?: Error|null }|null} result of the last ffmpeg check */
  #ffmpeg = null;
  #ffmpegAt = 0;
  #ffmpegCheck = null;
  /** @type {Map<Player, Session>} */
  #sessions = new Map();
  /** @type {WeakMap<Track, { channelId: string, messageId: string }>} the /play its first card or error replies to */
  #origins = new WeakMap();
  /** @type {Map<string, { name: string|null, at: number, pending: Promise<string|null>|null }>} */
  #names = new Map();
  /** @type {Map<string, number>} when a server ('s:<id>') or a person ('u:<id>') last made the bot join voice */
  #joins = new Map();
  #closed = false;

  commands = {
    play: this.#command('Play a track (number or name), a radio station or a stream link. No query: resume',
      (msg) => this.#play(msg)),
    tracks: this.#command('List the local tracks and the radio stations: /tracks [page]', (msg) => this.#tracks(msg)),
    queue: this.#command("Show what's playing and what's up next: /queue [page]", (msg) => this.#queue(msg)),
    nowplaying: this.#command('Show the Now Playing card with its buttons', (msg) => this.#nowPlaying(msg)),
    pause: this.#command('Pause the music', (msg) => this.#pause(msg)),
    resume: this.#command('Resume the music', (msg) => this.#resume(msg)),
    skip: this.#command('Skip the current track', (msg) => this.#skip(msg)),
    stop: this.#command('Stop the music, clear the queue and leave the voice channel', (msg) => this.#stop(msg)),
    volume: this.#command('Show or set the volume, 1 to 200%: /volume [number, +10 or -10]',
      (msg) => this.#volume(msg)),
    loop: this.#command('Repeat nothing, the current track or the whole queue: /loop [off|track|queue]',
      (msg) => this.#loop(msg)),
    shuffle: this.#command('Shuffle the tracks that are up next', (msg) => this.#shuffle(msg)),
    remove: this.#command('Take a track out of the queue: /remove <number from /queue>', (msg) => this.#remove(msg)),
    clear: this.#command('Empty the queue (the current track keeps playing)', (msg) => this.#clear(msg)),
    ping: this.#command('Check that the bot is alive and how fast Yapin’ answers', (msg) => this.#ping(msg)),
    help: this.#command('List the music commands', (msg) => this.#help(msg)),
  };

  buttons = { [CUSTOM_ID_PREFIX]: (i) => this.#click(i) };

  on = {
    voice_join: (ev) => this.#voiceEvent(ev, false),
    voice_leave: (ev) => this.#voiceEvent(ev, true),
  };

  /**
   * @param {any} bot
   * @param {object} [deps] test stand-ins; each defaults to the real thing
   * @param {object} [deps.config] partial settings over the defaults; the environment isn't read
   * @param {TrackLibrary} [deps.library]
   * @param {VoiceDirectory} [deps.voiceDirectory]
   * @param {(channelId: string, serverId: string, opts: { signal: AbortSignal }) => Promise<any>} [deps.connect]
   *   `signal` aborts when the player gives up on the join
   * @param {(track: Track) => any} [deps.spawnDecoder]
   * @param {(ffmpegPath: string) => Promise<{ ok: boolean, version?: string|null, error?: Error|null }>}
   *   [deps.checkFfmpeg]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [deps.timers] shared with the players
   * @param {() => number} [deps.now] clock in ms
   * @param {() => number} [deps.random] for /shuffle
   * @param {import('../src/log.js').Logger} [deps.logger]
   * @param {any} [deps.rtc] the @livekit/rtc-node module
   */
  constructor(bot, deps = {}) {
    super(bot);
    const config = deps.config ? { ...loadConfig({}), ...deps.config } : loadConfig();
    this.#config = config;
    this.#color = config.embedColor;
    this.#log = deps.logger ?? createLogger('music');
    this.#library = deps.library ?? new TrackLibrary({ musicDir: config.musicDir, stationsFile: config.stationsFile,
      allowUrls: config.allowUrls, ffprobePath: config.ffprobePath });
    this.#voice = deps.voiceDirectory ?? new VoiceDirectory(bot);
    const voiceRtc = deps.rtc ?? rtc;
    this.#connect = deps.connect ?? ((channelId, serverId, { signal } = {}) => connectVoice({
      bot: this.bot, rtc: voiceRtc, serverId, channelId, queueMs: config.audioQueueMs, bitrate: config.bitrate,
      logger: this.#sublog('voice'), leaveTimeoutMs: LEAVE_STEP_MS, signal,
    }));
    this.#spawn = deps.spawnDecoder ?? ((track) => spawnDecoder(track, { ffmpegPath: config.ffmpegPath }));
    this.#checkFfmpeg = deps.checkFfmpeg ?? ((ffmpegPath) => checkFfmpeg(ffmpegPath));
    this.#timers = deps.timers ?? { setTimeout, clearTimeout };
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? Math.random;
    this.#folder = folderLabel(this.#library.musicDir ?? config.musicDir);
    this.#players = new PlayerManager({
      defaultVolume: config.defaultVolume,
      createPlayer: (serverId, { volume, waitFor }) => this.#createPlayer(serverId, volume, waitFor),
    });
  }

  /** For other cogs and tests. */
  get players() { return this.#players; }

  /** Awaited by yapper.js before the bot starts. Never throws: problems are logged as warnings. */
  async cogLoad() {
    const [warnings] = await Promise.all([
      Promise.resolve().then(() => this.#library.init())
        .catch((err) => [`Couldn't load the music library: ${err?.message ?? err}`]),
      this.#checkFfmpegNow(),
    ]);
    for (const warning of Array.isArray(warnings) ? warnings : []) this.#log.warn(warning);
  }

  /** Stops every player and flushes its chat work, bounded by UNLOAD_MS and FLUSH_MS so a shutdown can't hang. */
  async cogUnload() {
    this.#closed = true;
    for (const s of this.#sessions.values()) {
      if (s.refresh !== null) this.#timers.clearTimeout(s.refresh);
      s.refresh = null;
      this.#stopJoinNotice(s);
    }
    try {
      await this.#within(this.#players.destroyAll('shutdown'), UNLOAD_MS);
    } catch {
      this.#log.warn(`the players took over ${inWords(UNLOAD_MS)} to leave voice; not waiting any longer`);
    }
    const chats = [...this.#sessions.values()].map((s) => s.chain);
    await this.#within(Promise.allSettled(chats), FLUSH_MS).catch(() => {});
  }

  // ---- commands ----

  async #play(msg) {
    const serverId = msg.server_id;
    if (!isId(serverId)) return msg.reply(DM_TEXT);
    const query = String(msg.args ?? '').trim();
    if (!query) {
      const paused = this.#players.get(serverId);
      if (!paused?.paused) return msg.reply(this.#usage());
      const denied = await this.#denied(serverId, msg.author_id, paused);
      if (denied) return msg.reply(denied);
      paused.resume();
      return msg.reply('▶️ Resumed.');
    }
    if (this.#ffmpeg?.ok === false) {
      this.#recheckFfmpeg();
      return msg.reply(FFMPEG_TEXT);
    }
    const res = await this.#library.resolve(query);
    if (!res?.ok) return msg.reply(this.#notFound(res));
    const [where, enriched] = await Promise.all([
      this.#within(this.#voice.channelOf(serverId, msg.author_id), LOOKUP_MS)
        .then((id) => ({ id }), (error) => ({ error })),
      this.#within(this.#library.enrich(res.track), PROBE_MS).catch(() => res.track),
    ]);
    if (this.#closed) return undefined; // cogUnload ran during the wait: don't start a player
    if (where.error) {
      this.#log.warn(`voice lookup for /play in ${serverId} failed:`, where.error);
      return msg.reply(lookupText(where.error));
    }
    if (!isId(where.id)) return msg.reply(NOT_IN_VOICE);
    const busy = this.#players.get(serverId);
    if (busy?.isBusy && !sameId(busy.channelId, where.id)) return msg.reply(this.#busyText(busy));
    // A player with this channelId is in that channel or joining it; otherwise this /play joins, which is paced.
    const joins = !sameId(busy?.channelId, where.id);
    const wait = joins ? this.#joinWait(serverId, msg.author_id) : 0;
    if (wait > 0) return msg.reply(`⏳ Yapin’ limits how often I can join voice. Try again in ${inWords(wait)}.`);

    const player = this.#players.obtain(serverId);
    const track = enriched !== null && typeof enriched === 'object' ? enriched : res.track;
    track.requestedBy = isId(msg.author_id) ? String(msg.author_id) : null;
    const fresh = !player.isBusy; // new session or a move: its cards go where this /play was typed
    let result;
    try {
      result = player.play(track, { channelId: where.id });
    } catch (err) {
      if (err instanceof QueueFullError) {
        return msg.reply(`📛 ${err.message} Make room with \`/remove\` or \`/clear\`, or wait a bit.`);
      }
      if (err instanceof PlayerError && err.code === 'BUSY_ELSEWHERE') return msg.reply(this.#busyText(player));
      throw err;
    }
    if (joins) this.#noteJoin(serverId, msg.author_id);
    if (fresh) {
      player.textChannelId = msg.channel_id ?? null;
      this.#nameChannel(player, where.id);
    }
    if (result.startedNow) {
      // No reply now: the Now Playing card (or the error) answers this message once playback starts.
      if (isId(msg.id) && isId(msg.channel_id)) {
        this.#origins.set(track, { channelId: msg.channel_id, messageId: msg.id });
      }
      return undefined;
    }
    const note = player.paused ? '⏸ The music is paused: `/resume` or the ⏯ button carries on.' : '';
    const added = trackAddedEmbed(track, result.position, player.snapshot(), { color: this.#color });
    return msg.reply(note, { embeds: [added] });
  }

  async #tracks(msg) {
    const localTracks = await this.#library.localTracks();
    const embed = tracksEmbed({ localTracks, stations: this.#library.stations, page: pageOf(msg.argv?.[0]),
      color: this.#color, folder: this.#folder, extensions: AUDIO_EXTENSIONS });
    return msg.reply('', { embeds: [embed] });
  }

  #queue(msg) {
    const serverId = msg.server_id;
    if (!isId(serverId)) return msg.reply(DM_TEXT);
    const player = this.#players.get(serverId);
    const snap = player?.snapshot() ?? { serverId, current: null, upcoming: [], loop: 'off', paused: false };
    return msg.reply('', { embeds: [queueEmbed(snap, { page: pageOf(msg.argv?.[0]), color: this.#color })] });
  }

  #nowPlaying(msg) {
    const serverId = msg.server_id;
    if (!isId(serverId)) return msg.reply(DM_TEXT);
    const player = this.#players.get(serverId);
    const s = player && this.#sessions.get(player);
    if (!s || !player.current) return msg.reply(IDLE_TEXT);
    // One live card per player: the old one loses its buttons and a new one answers this message.
    this.#step(s, async () => {
      await this.#retire(s);
      await this.#postCard(s, msg.channel_id, msg.id);
    });
    return undefined;
  }

  #pause(msg) {
    return this.#control(msg, (player) => {
      if (player.pause()) return '⏸ Paused. `/resume` or the ⏯ button carries on.';
      return player.paused ? '⏸ Already paused.' : IDLE_TEXT;
    }, { needTrack: true });
  }

  #resume(msg) {
    return this.#control(msg, (player) => (player.resume() ? '▶️ Resumed.' : '▶️ Already playing.'),
      { needTrack: true });
  }

  #skip(msg) {
    return this.#control(msg, (player, s) => {
      const track = player.skip();
      if (!track) return IDLE_TEXT;
      this.#endCard(s, track, `⏭ Skipped by ${mentionOf(msg.author_id)}`);
      return `⏭ Skipped **${sanitize(track.title, 100) || 'the track'}**.`;
    }, { needTrack: true });
  }

  #stop(msg) {
    return this.#control(msg, (player, s) => {
      const track = player.current;
      if (track) this.#endCard(s, track, `⏹ Stopped by ${mentionOf(msg.author_id)}`);
      const where = this.#where(player);
      void player.stop('stopped');
      return `⏹ Stopped the music and left ${where}.`;
    });
  }

  async #volume(msg) {
    const serverId = msg.server_id;
    if (!isId(serverId)) return msg.reply(DM_TEXT);
    const player = this.#players.get(serverId);
    const settings = this.#players.settings(serverId);
    const was = player?.volume ?? settings.volume;
    const arg = String(msg.args ?? '').trim();
    if (!arg) return msg.reply(`🔊 The volume is **${was}%**.`);
    const step = /^([+-])\s*(\d{1,3})\s*%?$/.exec(arg);
    const want = step
      ? Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, was + (step[1] === '-' ? -1 : 1) * Number(step[2])))
      : parseVolume(arg);
    if (want === null) {
      return msg.reply(`🔢 The volume is a whole number from ${MIN_VOLUME} to ${MAX_VOLUME}, like \`/volume 80\` `
        + '(or `/volume +10`).');
    }
    if (!player) {
      settings.volume = want; // what the next player in this server starts with
      return msg.reply(`🔊 Volume set to **${want}%**. It applies when the music starts.`);
    }
    const denied = await this.#denied(serverId, msg.author_id, player);
    if (denied) return msg.reply(denied);
    const set = player.setVolume(want);
    return msg.reply(`${set < was ? '🔉' : '🔊'} Volume set to **${set}%**.`);
  }

  #loop(msg) {
    const arg = String(msg.args ?? '').trim();
    const mode = arg ? parseLoopMode(arg) : null;
    return this.#control(msg, (player) => {
      if (arg && !mode) return LOOP_USAGE;
      const set = player.setLoop(mode ?? nextLoopMode(player.loop));
      return `🔁 Loop: **${loopLabel(set)}** (${LOOP_NOTES.get(set)}).`;
    });
  }

  #shuffle(msg) {
    return this.#control(msg, (player) => {
      if (player.queue.length < 2) return '🔀 There have to be at least 2 tracks up next to shuffle them.';
      return `🔀 Shuffled ${plural(player.shuffle(this.#random), 'track')}.`;
    });
  }

  #remove(msg) {
    const number = /^#?(\d{1,6})$/.exec(String(msg.args ?? '').trim())?.[1];
    return this.#control(msg, (player) => {
      if (!number) return REMOVE_USAGE;
      try {
        const track = player.remove(Number(number));
        return `🗑 Removed **${sanitize(track?.title, 100) || 'that track'}** from the queue.`;
      } catch (err) {
        if (err instanceof RangeError) return `🔢 ${err.message}.`;
        throw err;
      }
    });
  }

  #clear(msg) {
    return this.#control(msg, (player) => {
      const n = player.clear();
      return n ? `🧹 Cleared ${plural(n, 'track')} from the queue.` : '🧹 The queue was empty already.';
    });
  }

  async #ping(msg) {
    const started = this.#now();
    try {
      await this.bot.api('GET', '/me', undefined, { timeout: 5000, retries: 0 });
    } catch (err) {
      return msg.reply(`🏓 Pong, but Yapin’ didn't answer me: ${reasonOf(err)}.`);
    }
    return msg.reply(`🏓 Pong! Yapin’ answered in **${Math.max(0, Math.round(this.#now() - started))} ms**.`);
  }

  #help(msg) {
    const list = Object.entries(this.commands).map(([name, c]) => ({ name, description: c.description }));
    return msg.reply('', { embeds: [helpEmbed(list, { color: this.#color })] });
  }

  /**
   * A handler that throws is logged and answered with OOPS. Replies aren't awaited: yapper.js waits out a 429 inside
   * a send, so an awaited reply could hold up every server's events. A failed send still reaches the 'error' event.
   */
  #command(description, fn) {
    return {
      description,
      run: async (msg) => {
        const quick = { ...msg, reply: (content, opts) => { void msg.reply(content, opts); } };
        try {
          await fn(quick);
        } catch (err) {
          this.#log.error(`/${msg?.command ?? '?'} failed:`, err);
          quick.reply(OOPS);
        }
      },
    };
  }

  /** The checks every control command shares; `act(player, session)` then returns the reply. */
  async #control(msg, act, { needTrack = false } = {}) {
    const serverId = msg.server_id;
    if (!isId(serverId)) return msg.reply(DM_TEXT);
    const player = this.#players.get(serverId);
    if (!player || (needTrack && !player.current)) return msg.reply(IDLE_TEXT);
    const denied = await this.#denied(serverId, msg.author_id, player);
    if (denied) return msg.reply(denied);
    if (player.destroyed || (needTrack && !player.current)) return msg.reply(IDLE_TEXT); // ended during the lookup
    return msg.reply(act(player, this.#sessions.get(player)));
  }

  /** Refusal if `userId` isn't in the player's voice channel, else null; fails open on a failed or slow lookup. */
  async #denied(serverId, userId, player, ms = LOOKUP_MS) {
    if (!this.#config.requireSameVoice || !isId(player?.channelId)) return null;
    let channelId;
    try {
      channelId = await this.#within(this.#voice.channelOf(serverId, userId), ms);
    } catch (err) {
      this.#log.debug(`voice lookup in ${serverId} failed, allowing the control: ${err?.message ?? err}`);
      return null;
    }
    return sameId(channelId, player.channelId) ? null
      : `🎧 Join ${this.#where(player, 'my voice channel')} to control the music.`;
  }

  #usage() {
    const links = this.#config.allowUrls ? ', a radio station or an http(s) stream link' : ' or a radio station';
    return `🎵 What should I play? \`/play <track number or name>\`${links}. \`/tracks\` lists them all.`;
  }

  #notFound(res) {
    const lines = [`${REASON_ICONS.get(res?.reason) ?? '❓'} ${res?.message || "I couldn't find that."}`];
    for (const c of Array.isArray(res?.candidates) ? res.candidates : []) {
      // A track number or station id; any other character is stripped so it can't break the code span.
      const query = String(c?.query ?? '').replace(/[^\w-]/g, '');
      if (query) lines.push(`• \`/play ${query}\` — ${sanitize(c.label, 80)}`);
    }
    return lines.join('\n');
  }

  #busyText(player) {
    // The lookup at session start may have failed: retry it for next time, without waiting.
    if (!player.channelName && isId(player.channelId)) this.#nameChannel(player, player.channelId);
    const doing = player.state === PlayerState.CONNECTING ? 'joining' : 'already playing in';
    return `🎶 I'm ${doing} ${this.#where(player, 'another voice channel')}. Join me there, or wait until `
      + 'the queue is done.';
  }

  /** Ms until both the server and the user may make the bot join again, rounded up to whole seconds; 0 = now. */
  #joinWait(serverId, userId) {
    const now = this.#now();
    let wait = 0;
    for (const key of [`s:${serverId}`, isId(userId) ? `u:${userId}` : null]) {
      const at = key === null ? undefined : this.#joins.get(key);
      if (typeof at === 'number' && now >= at) wait = Math.max(wait, JOIN_GAP_MS - (now - at));
    }
    return Math.ceil(wait / 1000) * 1000;
  }

  /** Delete-then-set keeps #joins oldest first, so pruning can stop at the first recent entry. */
  #noteJoin(serverId, userId) {
    const now = this.#now();
    for (const key of [`s:${serverId}`, isId(userId) ? `u:${userId}` : null]) {
      if (key === null) continue;
      this.#joins.delete(key);
      this.#joins.set(key, now);
    }
    for (const [key, at] of this.#joins) {
      if (now - at < JOIN_GAP_MS) break;
      this.#joins.delete(key);
    }
  }

  // ---- buttons ----

  async #click(i) {
    // Answers aren't awaited, for the same reason as replies (see #command).
    try {
      const hit = parseCustomId(i?.custom_id);
      const serverId = isId(i?.server_id) ? i.server_id : hit?.serverId;
      const player = hit && !this.#closed ? this.#players.get(serverId) : undefined;
      const s = player ? this.#sessions.get(player) : undefined;
      const card = s?.card;
      // A click counts only on the live card while it shows the current track; other cards just lose their buttons.
      const live = () => !!card && s.card === card && card.track === player.current && !player.destroyed
        && (!isId(i.message_id) || sameId(i.message_id, card.messageId));
      if (!live()) {
        void i.update({ components: null });
        return;
      }
      const denied = await this.#denied(serverId, i.user_id, player, BUTTON_LOOKUP_MS);
      if (denied) {
        void i.ephemeral(denied);
        return;
      }
      if (!live()) { // the track changed during the lookup
        void i.update({ components: null });
        return;
      }
      const { action } = hit;
      if (action === 'skip' || action === 'stop') {
        s.card = null; // the update below finishes the card
        const verb = action === 'skip' ? '⏭ Skipped' : '⏹ Stopped';
        void i.update({ embeds: [endedEmbed(card.track, `${verb} by ${mentionOf(i.user_id)}`,
          { color: this.#color })], components: null });
        if (action === 'skip') player.skip();
        else void player.stop('stopped');
        return;
      }
      if (action === 'toggle') player.togglePause();
      else if (action === 'loop') player.cycleLoop();
      else player.setVolume(player.volume + (action === 'volup' ? 1 : -1) * this.#config.volumeStep);
      s.shown = s.version; // the update below shows the change, so the pending refresh has nothing to do
      const snap = player.snapshot();
      void i.update({ embeds: [this.#cardEmbed(snap)], components: this.#rows(snap) });
    } catch (err) {
      this.#log.warn('a button click failed:', err);
    }
  }

  // ---- voice events ----

  #voiceEvent(ev, left) {
    try {
      this.#voice.invalidate(ev?.server_id); // without a server id this clears every server
      if (this.#closed) return;
      const me = this.bot.me?.id;
      const ours = isId(me) && sameId(ev?.user_id, me);
      const players = isId(ev?.server_id) ? [this.#players.get(ev.server_id)].filter(Boolean) : this.#players.values();
      for (const player of players) {
        // No channel id: someone else's event may concern ours (check it), but our own leave can't be placed.
        const here = isId(ev?.channel_id) ? sameId(ev.channel_id, player.channelId) : !ours;
        if (!here) continue; // another channel; for our own events, the old half of a move
        // Someone came or went, or we just arrived (the requester may have left meanwhile): recount the listeners.
        if (!ours || !left) player.checkPresence();
        else if (this.#settled(player)) {
          this.#log.info(`I was taken out of voice channel ${player.channelId} in ${player.serverId}`);
          void player.stop('disconnected');
        }
      }
    } catch (err) {
      this.#log.warn('handling a voice event failed:', err);
    }
  }

  #settled(player) {
    const joinedAt = this.#sessions.get(player)?.joinedAt;
    return player.state !== PlayerState.CONNECTING && typeof joinedAt === 'number'
      && this.#now() - joinedAt >= JOIN_GRACE_MS;
  }

  // ---- players and their chat ----

  #createPlayer(serverId, volume, waitFor) {
    const c = this.#config;
    const player = new Player({
      serverId, volume, waitFor, maxQueueSize: c.maxQueueSize, idleTimeoutMs: c.idleTimeoutMs,
      aloneTimeoutMs: c.aloneTimeoutMs, timers: this.#timers, logger: this.#sublog(String(serverId)),
      connect: (channelId, opts) => this.#connect(channelId, serverId, opts),
      spawnDecoder: (track) => this.#spawn(track),
      // Excludes the bot. If this fails or is slow, the player falls back to LiveKit's participant count.
      countListeners: async () => {
        const me = this.bot.me?.id;
        return (await this.#voice.othersIn(serverId, player.channelId, isId(me) ? [me] : [])).length;
      },
    });
    this.#watch(player);
    return player;
  }

  /** Creates the player's Session and turns its events into chat updates. */
  #watch(player) {
    /** @type {Session} */
    const s = { player, card: null, chain: Promise.resolve(), version: 0, shown: 0, refresh: null, joinedAt: null,
      reported: false, joinNotice: null, failedLast: false };
    this.#sessions.set(player, s);
    const changed = () => { s.version++; this.#refreshSoon(s); };
    player.on('stateChange', (state) => {
      if (state === PlayerState.CONNECTING) {
        s.joinedAt = null;
        this.#startJoinNotice(s);
      } else {
        this.#stopJoinNotice(s);
        if (s.joinedAt === null) s.joinedAt = this.#now();
      }
      if (state === PlayerState.PLAYING || state === PlayerState.PAUSED) changed();
    });
    player.on('volumeChange', changed);
    // A skip or an advance gets a new card (or the queue-end notice) instead of a refresh.
    player.on('queueUpdate', (info) => { if (info?.reason !== 'advance' && info?.reason !== 'skip') changed(); });
    player.on('trackStart', (track) => this.#trackStarted(s, track));
    player.on('trackError', (track, err) => this.#trackFailed(s, track, err));
    player.on('connectError', (err) => this.#joinFailed(s, err));
    player.on('queueEnd', (info) => this.#queueEnded(s, info?.idleTimeoutMs));
    player.on('alone', (info) => this.#leftAlone(s, info?.timeoutMs));
    player.once('destroy', (info) => this.#destroyed(s, info?.reason, info?.error));
  }

  #trackStarted(s, track) {
    s.failedLast = false;
    const origin = this.#origins.get(track);
    this.#origins.delete(track);
    this.#step(s, async () => {
      const { player } = s;
      if (s.card?.track === track && player.current === track && !player.destroyed) {
        // The same track again (looping): its card stays live rather than a new card per repeat, which would
        // leave clicks on the old card going nowhere.
        s.version++;
        this.#refreshSoon(s);
        return;
      }
      await this.#retire(s);
      if (player.destroyed || player.current !== track) return; // already over: no card
      const channelId = player.textChannelId;
      await this.#postCard(s, channelId, origin && sameId(origin.channelId, channelId) ? origin.messageId : null);
    });
  }

  #trackFailed(s, track, err) {
    s.failedLast = true;
    const origin = this.#origins.get(track);
    this.#origins.delete(track);
    const reason = err instanceof FfmpegStartError ? this.#ffmpegFailed(err) : reasonOf(err);
    this.#notify(s, `⚠️ Couldn't play **${sanitize(track?.title, 100) || 'that track'}**: ${reason}. Skipping it.`,
      origin);
  }

  /**
   * ffmpeg failed to start although the startup check passed (removed or moved since). Returns the reason for chat,
   * without the binary's path that the error names. If it's gone, /play refuses and rechecks, as after a failed check.
   */
  #ffmpegFailed(err) {
    if (err.code !== 'ENOENT' && err.code !== 'EACCES') return "ffmpeg couldn't be started"; // e.g. out of file handles
    if (this.#ffmpeg?.ok !== false) this.#log.error(`${err.message}. /play won't work until it's back.`);
    this.#ffmpeg = { ok: false, version: null, error: err };
    this.#ffmpegAt = this.#now();
    return "ffmpeg isn't available on the computer I run on";
  }

  #joinFailed(s, err) {
    s.reported = true; // so the 'destroy' that follows doesn't repeat it
    const track = s.player.current;
    const origin = track ? this.#origins.get(track) : undefined;
    if (track) this.#origins.delete(track);
    this.#notify(s, `❌ I couldn't join ${this.#where(s.player)}: ${reasonOf(err)}.`, origin);
  }

  #queueEnded(s, ms) {
    this.#step(s, () => this.#retire(s));
    if (ms > 0) {
      // After a failed track, "that was the last track" would suggest it played.
      const ended = s.failedLast ? '📭 Nothing else is queued, so' : '✅ That was the last track.';
      this.#notify(s, `${ended} I'll leave ${this.#where(s.player)} in ${inWords(ms)} unless something new is `
        + 'played.');
    }
  }

  #leftAlone(s, ms) {
    if (ms > 0) {
      this.#notify(s, `👀 Everyone left ${this.#where(s.player)}. I'll leave in ${inWords(ms)} unless someone `
        + 'joins.');
    }
  }

  /** A slow join gets a notice, since the /play has no other answer until the music starts. */
  #startJoinNotice(s) {
    this.#stopJoinNotice(s);
    s.joinNotice = this.#timers.setTimeout(() => {
      s.joinNotice = null;
      const { player } = s;
      if (this.#closed || player.destroyed || player.state !== PlayerState.CONNECTING) return;
      const origin = player.current ? this.#origins.get(player.current) : undefined;
      this.#notify(s, `🔌 Joining ${this.#where(player)} is taking a moment…`, origin);
    }, JOIN_NOTICE_MS);
  }

  #stopJoinNotice(s) {
    if (s.joinNotice === null) return;
    this.#timers.clearTimeout(s.joinNotice);
    s.joinNotice = null;
  }

  #destroyed(s, reason, error) {
    if (s.refresh !== null) this.#timers.clearTimeout(s.refresh);
    s.refresh = null;
    this.#stopJoinNotice(s);
    const text = this.#farewell(s, reason, error);
    this.#step(s, async () => {
      await this.#retire(s);
      if (text) await this.#send(s.player.textChannelId, text);
    }).then(() => { if (this.#sessions.get(s.player) === s) this.#sessions.delete(s.player); });
  }

  #farewell(s, reason, error) {
    const where = this.#where(s.player);
    if (reason === 'idle') return `👋 Nothing left to play, so I left ${where}.`;
    if (reason === 'alone') return `👋 Everyone left ${where}, so I left too.`;
    if (reason === 'disconnected') {
      return `🔌 I was disconnected from ${where}${error ? ` (${reasonOf(error)})` : ''}. \`/play\` starts the music `
        + 'again.';
    }
    if (reason === 'error' && !s.reported) {
      return `⚠️ The music stopped because something went wrong: ${reasonOf(error)}.`;
    }
    return null; // 'stopped' was asked for (and answered); 'shutdown' needs no notice
  }

  /** Turns the live card into a finished one without buttons, if it still shows `track`. */
  #endCard(s, track, text) {
    if (!s) return;
    this.#step(s, () => this.#retire(s, (card) => (card.track === track
      ? endedEmbed(track, text, { color: this.#color }) : null)));
  }

  /** Takes the buttons off the live card, swapping in `embedFor(card)` when that returns an embed. */
  async #retire(s, embedFor = null) {
    const card = s.card;
    s.card = null;
    if (!card) return;
    const embed = embedFor?.(card) ?? null;
    await this.#edit(card.channelId, card.messageId,
      embed ? { embeds: [embed], components: null } : { components: null });
  }

  async #postCard(s, channelId, replyTo = null) {
    const { player } = s;
    const track = player.current;
    if (!track || player.destroyed) return;
    const version = s.version;
    const snap = player.snapshot();
    const msg = await this.#send(channelId, '', { embeds: [this.#cardEmbed(snap)], components: this.#rows(snap),
      ...(isId(replyTo) ? { replyTo } : {}) });
    if (!isId(msg?.id)) return;
    s.card = { channelId, messageId: msg.id, track };
    s.shown = version;
    if (s.version !== version) this.#refreshSoon(s); // changed while the post was in flight
  }

  /** Debounced: changes come in bursts, and one edit covers them. */
  #refreshSoon(s) {
    if (s.refresh !== null || this.#closed || !s.card || s.player.destroyed) return;
    s.refresh = this.#timers.setTimeout(() => {
      s.refresh = null;
      this.#step(s, async () => {
        const { player, card } = s;
        if (!card || s.version === s.shown || player.destroyed || card.track !== player.current) return;
        const snap = player.snapshot();
        s.shown = s.version;
        await this.#edit(card.channelId, card.messageId,
          { embeds: [this.#cardEmbed(snap)], components: this.#rows(snap) });
      });
    }, REFRESH_MS);
  }

  /** Runs `work` after the session's earlier chat work. The chain never rejects. */
  #step(s, work) {
    s.chain = s.chain.then(work).catch((err) => this.#log.warn('updating the chat failed:', err));
    return s.chain;
  }

  /** Replies to `origin` (the /play it concerns) when given, else posts in the player's text channel. */
  #notify(s, text, origin = null) {
    this.#step(s, () => (origin ? this.#send(origin.channelId, text, { replyTo: origin.messageId })
      : this.#send(s.player.textChannelId, text)));
  }

  /** bot.send that never throws; resolves to the message or null. */
  async #send(channelId, content, opts = {}) {
    if (!isId(channelId)) return null;
    try {
      return (await this.bot.send(channelId, content, opts)) ?? null;
    } catch (err) {
      this.#log.warn(`couldn't post in channel ${channelId}:`, err);
      return null;
    }
  }

  /** bot.edit that never throws (the message may be gone). */
  async #edit(channelId, messageId, changes) {
    try {
      await this.bot.edit(channelId, messageId, undefined, changes);
    } catch (err) {
      this.#log.debug(`couldn't edit message ${messageId}:`, err);
    }
  }

  #cardEmbed(snap) { return nowPlayingEmbed(snap, { color: this.#color }); }

  #rows(snap) { return controlRows(snap, { volumeStep: this.#config.volumeStep }); }

  /** '🔊 **Lounge**', or `unknown` while the channel's name isn't known. */
  #where(player, unknown = 'the voice channel') {
    const name = sanitize(player?.channelName, 80);
    return name ? `🔊 **${name}**` : unknown;
  }

  /** Sets player.channelName from the cache now, and from Yapin’ when it answers (unless the player moved). */
  #nameChannel(player, channelId) {
    player.channelName = this.#names.get(String(channelId))?.name ?? null;
    void this.#channelName(channelId).then((name) => {
      if (name && sameId(player.channelId, channelId)) player.channelName = name;
    });
  }

  /** Cached, with concurrent lookups shared; null when unknown. Never rejects. */
  #channelName(channelId) {
    const key = String(channelId);
    const hit = this.#names.get(key);
    if (hit?.pending) return hit.pending;
    const age = this.#now() - (hit?.at ?? NaN);
    if (hit && age >= 0 && age < (hit.name ? NAME_TTL_MS : NO_NAME_TTL_MS)) return Promise.resolve(hit.name);
    const entry = { name: hit?.name ?? null, at: 0, pending: null };
    entry.pending = Promise.resolve()
      .then(() => this.bot.channel(channelId))
      .then((channel) => (typeof channel?.name === 'string' && channel.name.trim() ? channel.name : null), () => null)
      .then((name) => {
        entry.name = name ?? entry.name;
        entry.at = this.#now();
        entry.pending = null;
        return entry.name;
      });
    this.#names.set(key, entry);
    return entry.pending;
  }

  /** Logs only when ffmpeg goes missing or comes back. Never rejects. */
  async #checkFfmpegNow() {
    let result;
    try {
      result = await this.#checkFfmpeg(this.#config.ffmpegPath);
    } catch (err) {
      result = { ok: false, version: null, error: err };
    }
    const before = this.#ffmpeg;
    this.#ffmpeg = result?.ok ? result : { ok: false, version: null, error: result?.error ?? null };
    this.#ffmpegAt = this.#now();
    if (this.#ffmpeg.ok) {
      if (!before?.ok) this.#log.info(`using ffmpeg ${this.#ffmpeg.version ?? ''}`.trim());
    } else if (before?.ok !== false) {
      this.#log.error(`${this.#ffmpeg.error?.message ?? 'ffmpeg is missing'}. /play won't work until it's installed.`);
    }
  }

  /** In the background, at most every FFMPEG_RECHECK_MS: the owner may have installed ffmpeg since. */
  #recheckFfmpeg() {
    if (this.#ffmpegCheck || this.#now() - this.#ffmpegAt < FFMPEG_RECHECK_MS) return;
    this.#ffmpegCheck = this.#checkFfmpegNow().finally(() => { this.#ffmpegCheck = null; });
  }

  /** Rejects with a TimeoutError after `ms` without cancelling `work`; the timer never outlives the wait. */
  #within(work, ms) {
    return new Promise((resolve, reject) => {
      const timer = this.#timers.setTimeout(() => reject(timeoutError(ms)), ms);
      Promise.resolve(work).then(
        (value) => { this.#timers.clearTimeout(timer); resolve(value); },
        (err) => { this.#timers.clearTimeout(timer); reject(err); },
      );
    });
  }

  #sublog(scope) { return typeof this.#log.child === 'function' ? this.#log.child(scope) : this.#log; }
}
