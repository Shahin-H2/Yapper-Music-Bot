/**
 * What Music Bot shows in chat: the Now Playing card and its buttons, the queue, the library and help, plus the
 * custom ids the buttons carry. Pure: builders take plain data (a PlayerSnapshot, Tracks) and return yapper.js
 * Embed and Row objects; nothing here does I/O or keeps state.
 *
 *   const s = player.snapshot();
 *   await bot.send(s.textChannelId, '', { embeds: [nowPlayingEmbed(s, { color })], components: controlRows(s) });
 *   const hit = parseCustomId(i.custom_id);   // a click on one of them: { action: 'skip', serverId } or null
 *
 * Titles, tags, file and station names come from users and files, so they go through sanitize() and can't format
 * the card or ping anyone. Every builder stays inside the platform limits whatever it gets (500-character titles,
 * a thousand files): text is cut between whole characters, lists between whole lines.
 */
import { Button, Embed, Row } from '../yapper.js';
import { MAX_VOLUME, MIN_VOLUME, clampVolume } from './audio.js';
import { LOOP_MODES } from './queue.js';

/** @typedef {import('./queue.js').LoopModeValue} LoopModeValue */
/**
 * The Track fields read here (the full shape is in src/tracks.js); missing or malformed ones degrade, never throw.
 * @typedef {{ kind?: string, live?: boolean, title?: string, artist?: string|null, duration?: number|null,
 *   fileName?: string, stationId?: string, description?: string|null, url?: string|null,
 *   requestedBy?: string|null }} Track
 */
/**
 * The PlayerSnapshot fields read here (player.snapshot() in src/player.js).
 * @typedef {{ serverId?: string, channelName?: string|null, current?: Track|null, position?: number,
 *   paused?: boolean, volume?: number, loop?: LoopModeValue, upcoming?: Track[], next?: Track|null }} PlayerSnapshot
 */
/** @typedef {{ title?: string, fileName?: string }} LocalTrack from listLocalTracks(); its path is never shown */
/** @typedef {{ id?: string, name?: string }} Station */
/** @typedef {string|number} Color '#rrggbb', 0xrrggbb or a yapper.js colour name ('red', 'blue', …) */

/** Message limits from the yapper.js docs: the API rejects embeds and buttons that go over them. */
export const LIMITS = Object.freeze({
  title: 256, description: 4096, fields: 10, fieldName: 256, fieldValue: 1024, total: 6000,
  rows: 5, buttons: 5, label: 80, customId: 100,
});
/** The start of every custom id made here, and so the key of the cog's `buttons` handler. */
export const CUSTOM_ID_PREFIX = 'music:';
/** What the control buttons do: play/pause, skip, stop, next loop mode, volume down, volume up. */
export const BUTTON_ACTIONS = Object.freeze(['toggle', 'skip', 'stop', 'loop', 'voldown', 'volup']);

const ZWSP = '\u200b';
const DEFAULT_COLOR = 0xff4fd8;
// AUDIO_EXTENSIONS of src/tracks.js; tracksEmbed takes the real list as an option.
const DEFAULT_EXTENSIONS = Object.freeze(['.mp3', '.wav', '.flac', '.ogg', '.opus', '.m4a']);
const LOOP_LABELS = new Map(LOOP_MODES.map((m) => [m, m[0].toUpperCase() + m.slice(1)]));
const NAMED_COLORS = new Set(['red', 'green', 'blue', 'yellow', 'purple', 'orange', 'grey', 'gray']);
const LONGEST_ACTION = Math.max(...BUTTON_ACTIONS.map((a) => a.length));
const MAX_SERVER_ID = LIMITS.customId - CUSTOM_ID_PREFIX.length - 1 - LONGEST_ACTION;
const NAME_MAX = 300;          // a track's name in a card
const LINE_MAX = 160;          // one list line (a page's share of the description can make it shorter)
const QUEUE_PAGE_MAX = 25;
const LIBRARY_PAGE_MAX = 50;

const MARKDOWN = /[\\*_~`|[\]()>#]/g;
// '@' starts @everyone, @here and @name, '<' starts <@id>, <@&role> and <#channel>: a zero-width space after either
// leaves the text looking the same, but no longer a mention.
const PING = /[@<]/g;
const SPACE = /^[\s\u0085]+$/;
// Control characters, and the bidi overrides that would flip the rest of the line (times, mentions) around.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const SERVER_ID = /^[^\s\p{C}]+$/u;
const USER_ID = /^[\w-]{1,64}$/;
const USER_MENTION = /<@[\w-]{1,64}>/g;
const COMMAND_NAME = /^[a-z0-9_-]{1,32}$/;
// Text is cut between graphemes, so an emoji or an accented letter never ends up half there (half a surrogate
// pair isn't even valid JSON text). Without ICU, code points still keep surrogate pairs together.
const SEGMENTER = typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** The text of a value meant to be a string; objects, symbols and other junk show as nothing. */
const str = (v) => (typeof v === 'string' ? v
  : typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' ? String(v) : '');
const obj = (v) => (v !== null && typeof v === 'object' ? v : null);
const list = (v) => (Array.isArray(v) ? v : []);
/** A whole number in [min, max] from an option; anything that isn't a finite number gives the fallback. */
const clampInt = (v, min, max, fallback) =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback);
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const limitOf = (max) => (typeof max === 'number' && max > 0 ? Math.floor(max) : 0);
/** A bad argument as an error shows it: short plain strings quoted, anything else only named. */
const show = (v) => (typeof v === 'string' ? (/^[\w .:-]{0,40}$/.test(v) ? `"${v}"` : 'a string')
  : typeof v === 'number' ? String(v) : v === null ? 'null' : typeof v);

function* graphemes(text) {
  if (SEGMENTER) for (const { segment } of SEGMENTER.segment(text)) yield segment;
  else yield* text;
}
function* map(items, fn) { for (const x of items) yield fn(x); }

/** The graphemes of text on one line: every run of whitespace (newlines too) is one space, controls are dropped. */
function* cleaned(text) {
  let gap = false;
  let started = false;
  for (const g of graphemes(str(text))) {
    if (SPACE.test(g)) { gap = started; continue; }
    const visible = g.replace(INVISIBLE, '');
    if (!visible) continue;
    if (gap) yield ' ';
    gap = false;
    started = true;
    yield visible;
  }
}

/** One grapheme with its markdown characters escaped and its pings defused. */
const escapeMd = (g) => g.replace(MARKDOWN, '\\$&').replace(PING, `$&${ZWSP}`);

/**
 * Joins pieces while they fit in max; when they don't all fit, keeps the longest run that leaves room for '…'.
 * A piece (a grapheme, or an escape that must stay whole) is never split, and only the pieces needed are read.
 */
function fit(pieces, max) {
  let out = '';
  let room = 0; // where to cut: the end of the last visible piece that still leaves room for '…'
  for (const p of pieces) {
    if (out.length + p.length > max) return max > 0 ? `${out.slice(0, room)}…` : '';
    out += p;
    if (out.length < max && p.trim()) room = out.length;
  }
  return out;
}

/**
 * Cuts text to at most max characters, ending in '…' when something was cut. The cut falls between whole
 * characters (an emoji or an accented letter stays whole). For plain text: cutting markdown can unbalance it.
 * @param {unknown} text
 * @param {number} [max] default: no limit
 * @returns {string}
 */
export function truncate(text, max = Infinity) { return fit(graphemes(str(text)), limitOf(max)); }

/**
 * Makes text from users or files (a file name, tag, URL, station name, query) safe in a message: one line, control
 * characters and bidi overrides gone, markdown escaped (\ * _ ~ ` | [ ] ( ) > #), pings defused by a zero-width
 * space after every @ and < (so @everyone, @here, <@id>, <@&id> and <#id> show as plain text), then cut to max
 * characters, escapes included, never inside one.
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string} '' for empty or non-text input
 */
export function sanitize(text, max = 100) { return fit(map(cleaned(text), escapeMd), limitOf(max)); }

/** sanitize() without the escapes, for footers (they aren't markdown, so a backslash would show). */
const plain = (text, max) => fit(map(cleaned(text), (g) => g.replace(PING, `$&${ZWSP}`)), limitOf(max));
/** Inline code. Escapes don't work between backticks, so a backtick in the text becomes ˋ instead. */
const code = (text, max) =>
  `\`${fit(map(cleaned(text), (g) => g.replace(/`/g, 'ˋ').replace(PING, `$&${ZWSP}`)), limitOf(max - 2)) || '?'}\``;

/** A status line such as '⏭ Skipped by <@id>': escaped like sanitize(), but each <@id> user mention stays whole. */
function* statusPieces(text) {
  const line = [...cleaned(text)].join('');
  let at = 0;
  for (const m of line.matchAll(USER_MENTION)) {
    yield* map(graphemes(line.slice(at, m.index)), escapeMd);
    yield m[0];
    at = m.index + m[0].length;
  }
  yield* map(graphemes(line.slice(at)), escapeMd);
}
/** <@id> for something shaped like a user id, else null: a malformed id must not turn into markup. */
const mention = (id) =>
  ((typeof id === 'string' && USER_ID.test(id)) || (Number.isSafeInteger(id) && id >= 0) ? `<@${id}>` : null);
/** A server id as it goes in a custom id: a non-empty string (or whole number) without spaces or controls. */
const serverIdOf = (v) => {
  const id = typeof v === 'string' ? v : Number.isSafeInteger(v) && v >= 0 ? String(v) : '';
  return SERVER_ID.test(id) ? id : null;
};

/** A colour Embed#color understands; anything else is the bot's pink (a NaN colour would go out as null). */
function colorOf(c) {
  if (Number.isInteger(c) && c >= 0 && c <= 0xffffff) return c;
  const s = typeof c === 'string' ? c.trim().toLowerCase() : '';
  if (/^#?[0-9a-f]{6}$/.test(s)) return parseInt(s.replace('#', ''), 16);
  return NAMED_COLORS.has(s) ? s : DEFAULT_COLOR;
}
const newEmbed = (title, color) => new Embed().title(title).color(colorOf(color));

/** The url if it's a plain https link (the only kind a card may point to), else null. */
function httpsUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) return null;
  try {
    const url = new URL(u);
    // user:pass@ is refused: 'https://trusted.example@evil.example' reads like a link to the first host.
    const ok = url.protocol === 'https:' && url.hostname && !url.username && !url.password && url.href.length <= 2048;
    return ok ? url.href : null;
  } catch {
    return null;
  }
}

const isLive = (t) => (typeof t?.live === 'boolean' ? t.live : t?.kind === 'stream');
const isLength = (v) => typeof v === 'number' && v > 0 && v <= Number.MAX_SAFE_INTEGER;
/** A track's length in seconds, or null when it has none (live, unknown, or not a sane number). */
const lengthOf = (t) => (!isLive(t) && isLength(t?.duration) ? t.duration : null);
/** Seconds played: never negative, never past the end (a probed length can be a little short). */
const elapsed = (position, length) => {
  const at = typeof position === 'number' && position > 0 && position <= Number.MAX_SAFE_INTEGER ? position : 0;
  return length === null ? at : Math.min(at, length);
};
/** '🔴 LIVE', or the length as `m:ss` (`--:--` when unknown). */
const lengthLabel = (t) => (isLive(t) ? '🔴 LIVE' : `\`${formatDuration(lengthOf(t))}\``);
const volumeLabel = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${clampVolume(v)}%` : '—');

/**
 * A track's title and artist, escaped and together at most max characters with ' — ' between them. The artist gets
 * up to a third, or whatever a shorter title leaves.
 */
function nameParts(t, max) {
  // The first candidate with anything visible: sanitize(v, 1) is '' only for blank or non-text values.
  const raw = [t?.title, t?.fileName, t?.stationId].find((v) => sanitize(v, 1)) ?? 'Unknown track';
  const room = max - 3;
  let artist = sanitize(t?.artist, Math.floor(room / 3));
  const title = sanitize(raw, artist ? room - artist.length : max);
  if (artist) artist = sanitize(t.artist, room - title.length);
  return { title, artist };
}
const trackName = (t, max) => {
  const { title, artist } = nameParts(t, max);
  return artist ? `${title} — ${artist}` : title;
};
/** **Title** — Artist, for the top of a card. */
const heading = (t) => {
  const { title, artist } = nameParts(t, NAME_MAX);
  return `**${title}**${artist ? ` — ${artist}` : ''}`;
};
/** head + name + ' · length · requester', the name cut so the line stays within max. */
function trackLine(head, t, max, length = lengthLabel(t)) {
  const by = mention(t?.requestedBy);
  const tail = ` · ${length}${by ? ` · ${by}` : ''}`;
  return `${head}${trackName(t, max - head.length - tail.length)}${tail}`;
}

/** Whole lines joined while they fit in max; the ones that don't are counted in a last '… and N more' line. */
function joinLines(lines, max) {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const next = out ? `${out}\n${lines[i]}` : lines[i];
    const left = lines.length - i - 1;
    // Room for the summary is kept as we go, so cutting at any line still fits.
    if (next.length + (left ? `\n… and ${left} more`.length : 0) > max) {
      const rest = `… and ${lines.length - i} more`;
      return out ? `${out}\n${rest}` : truncate(rest, max);
    }
    out = next;
  }
  return out;
}

/**
 * A length in seconds as a clock: 0 → '0:00', 65 → '1:05', 3725 → '1:02:05' (fractions are dropped).
 * @param {unknown} seconds
 * @returns {string} '--:--' for anything that isn't a real length (null, NaN, < 0, Infinity, a string)
 */
export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !(seconds >= 0) || seconds > Number.MAX_SAFE_INTEGER) return '--:--';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * A bar of `width` symbols with a knob where the position is: progressBar(30, 100) → '▬▬▬▬🔘▬▬▬▬▬▬▬▬▬'.
 * @param {number} position seconds played (clamped to the track)
 * @param {number|null} duration seconds
 * @param {number} [width] 1 to 50
 * @returns {string} '' when the duration is unknown (null, 0, NaN, Infinity)
 */
export function progressBar(position, duration, width = 14) {
  if (!isLength(duration)) return '';
  const w = clampInt(width, 1, 50, 14);
  const knob = Math.round((elapsed(position, duration) / duration) * (w - 1));
  return `${'▬'.repeat(knob)}🔘${'▬'.repeat(w - 1 - knob)}`;
}

/**
 * How a loop mode reads on the button and the cards.
 * @param {unknown} mode
 * @returns {'Off'|'Track'|'Queue'} 'Off' for anything that isn't a mode
 */
export function loopLabel(mode) { return LOOP_LABELS.get(mode) ?? 'Off'; }

/**
 * The custom id of a control button: `music:<action>:<serverId>`. The server id rides along because a click
 * isn't documented to say which server it came from.
 * @param {string} action one of BUTTON_ACTIONS
 * @param {string|number} serverId
 * @returns {string}
 * @throws {TypeError} for an unknown action, or a server id that is missing or has spaces or control characters
 * @throws {RangeError} when the id would be longer than LIMITS.customId (100)
 */
export function customId(action, serverId) {
  if (!BUTTON_ACTIONS.includes(action)) {
    throw new TypeError(`Unknown button action ${show(action)}: use one of ${BUTTON_ACTIONS.join(', ')}`);
  }
  const sid = serverIdOf(serverId);
  if (sid === null) throw new TypeError(`A custom id needs a server id without spaces (got ${show(serverId)})`);
  const id = `${CUSTOM_ID_PREFIX}${action}:${sid}`;
  if (id.length > LIMITS.customId) {
    throw new RangeError(`A custom id can be ${LIMITS.customId} characters at most; this one would be ${id.length}`);
  }
  return id;
}

/**
 * The action and server id in a custom id made by customId(); null for anything else: another prefix, an unknown
 * action, no server id, a non-string, or more than 100 characters.
 * @param {unknown} id
 * @returns {{ action: string, serverId: string }|null}
 */
export function parseCustomId(id) {
  if (typeof id !== 'string' || id.length > LIMITS.customId || !id.startsWith(CUSTOM_ID_PREFIX)) return null;
  const rest = id.slice(CUSTOM_ID_PREFIX.length);
  const colon = rest.indexOf(':');
  const action = rest.slice(0, colon);
  const serverId = rest.slice(colon + 1);
  return colon > 0 && BUTTON_ACTIONS.includes(action) && SERVER_ID.test(serverId) ? { action, serverId } : null;
}

/**
 * The buttons under the Now Playing card: [⏯ Pause|⏯ Resume, ⏭ Skip, ⏹ Stop] and [🔁 Loop: <mode>, 🔉 Vol -,
 * 🔊 Vol +]. Pause is primary, Resume success, Stop danger, the rest secondary. Vol - is disabled at MIN_VOLUME and
 * Vol + at MAX_VOLUME; a click that would overshoot clamps, so they stay enabled until then.
 * @param {PlayerSnapshot} snapshot
 * @param {{ volumeStep?: number }} [opts] the cog applies volumeStep on a click; the buttons don't depend on it
 * @returns {Row[]} [] when snapshot.serverId can't go in a custom id (a card without buttons beats a rejected message)
 */
export function controlRows(snapshot, { volumeStep = 10 } = {}) {
  const s = obj(snapshot) ?? {};
  const sid = serverIdOf(s.serverId);
  if (sid === null || sid.length > MAX_SERVER_ID) return [];
  const id = (action) => customId(action, sid);
  const volume = typeof s.volume === 'number' && Number.isFinite(s.volume) ? s.volume : null;
  return [
    new Row(
      s.paused === true ? Button.success('⏯ Resume', id('toggle')) : Button.primary('⏯ Pause', id('toggle')),
      Button.secondary('⏭ Skip', id('skip')),
      Button.danger('⏹ Stop', id('stop')),
    ),
    new Row(
      Button.secondary(`🔁 Loop: ${loopLabel(s.loop)}`, id('loop')),
      Button.secondary('🔉 Vol -', id('voldown')).disabled(volume !== null && volume <= MIN_VOLUME),
      Button.secondary('🔊 Vol +', id('volup')).disabled(volume !== null && volume >= MAX_VOLUME),
    ),
  ];
}

/**
 * The Now Playing card: the track in bold (+ artist), then '🔴 LIVE' (+ the station's description) for a stream or
 * a progress bar with `m:ss / m:ss` for a file; inline fields Requested by, Volume and Loop, then Up next; footer
 * '🔊 <voice channel> · <N> in queue'. The title links to track.url when that is https.
 * @param {PlayerSnapshot} snapshot
 * @param {{ color?: Color }} [opts]
 * @returns {Embed}
 */
export function nowPlayingEmbed(snapshot, { color } = {}) {
  const s = obj(snapshot) ?? {};
  const t = obj(s.current);
  const embed = newEmbed(t && s.paused === true ? '⏸ Paused' : '🎶 Now Playing', color);
  if (t) {
    let status;
    if (isLive(t)) {
      const about = sanitize(t.description, NAME_MAX);
      status = about ? `🔴 LIVE · ${about}` : '🔴 LIVE';
    } else {
      const length = lengthOf(t);
      const at = elapsed(s.position, length);
      status = length === null ? `\`${formatDuration(at)}\` · length unknown`
        : `${progressBar(at, length)}  \`${formatDuration(at)} / ${formatDuration(length)}\``;
    }
    embed.description(`${heading(t)}\n${status}`);
    const link = httpsUrl(t.url);
    if (link) embed.url(link);
  } else {
    embed.description('Nothing is playing right now. Start something with `/play`.');
  }
  const upcoming = list(s.upcoming);
  const next = obj(s.next === undefined ? upcoming[0] : s.next);
  const channel = plain(s.channelName, 100);
  return embed
    .field('Requested by', mention(t?.requestedBy) ?? '—', true)
    .field('Volume', volumeLabel(s.volume), true)
    .field('Loop', loopLabel(s.loop), true)
    .field('Up next', next ? `${trackName(next, NAME_MAX)} · ${lengthLabel(next)}` : '—')
    .footer(`${channel ? `🔊 ${channel} · ` : ''}${upcoming.length} in queue`);
}

/**
 * A finished or stale Now Playing card, e.g. endedEmbed(track, `⏭ Skipped by <@${userId}>`): the status line, then
 * the track's name. The status line is escaped like sanitize() (so a username or an error reason can go in as is),
 * except that <@id> user mentions stay mentions.
 * @param {Track|null} track
 * @param {string} text
 * @param {{ color?: Color }} [opts]
 * @returns {Embed}
 */
export function endedEmbed(track, text, { color } = {}) {
  const t = obj(track);
  const lines = [fit(statusPieces(text), NAME_MAX), t ? heading(t) : ''].filter(Boolean);
  return new Embed().color(colorOf(color)).description(lines.join('\n') || 'Finished.');
}

/**
 * The queue: what's playing, then one page of what's waiting, numbered as /remove counts, each with its length and
 * requester. Footer 'Page x/y · N tracks · total h:mm:ss + live · Loop: Off': the total adds up the waiting tracks,
 * and '+ live' / '+ unknown' say that some of them have no length. An empty queue gets a friendly line instead.
 * @param {PlayerSnapshot} snapshot
 * @param {{ page?: number, pageSize?: number, color?: Color }} [opts] page is clamped to [1, pages],
 *   pageSize to [1, 25]
 * @returns {Embed}
 */
export function queueEmbed(snapshot, { page = 1, pageSize = 10, color } = {}) {
  const s = obj(snapshot) ?? {};
  const current = obj(s.current);
  const upcoming = list(s.upcoming);
  const embed = newEmbed('📜 Queue', color);
  const loop = `Loop: ${loopLabel(s.loop)}`;
  if (!current && !upcoming.length) {
    return embed.description('The queue is empty. Add something with `/play <song, number or station>`.').footer(loop);
  }
  const size = clampInt(pageSize, 1, QUEUE_PAGE_MAX, 10);
  const pages = Math.max(1, Math.ceil(upcoming.length / size));
  const at = clampInt(page, 1, pages, 1);
  const first = (at - 1) * size;
  const items = upcoming.slice(first, first + size);
  const head = [];
  if (current) {
    const length = lengthOf(current);
    const time = isLive(current) ? '🔴 LIVE'
      : `\`${formatDuration(elapsed(s.position, length))} / ${formatDuration(length)}\``;
    head.push('**Now playing**', trackLine(s.paused === true ? '⏸ ' : '▶️ ', current, NAME_MAX, time), '');
  }
  head.push('**Up next**');
  // Every line of the page gets an equal share of what's left, so a page of long titles still shows in full.
  const share = Math.floor((LIMITS.description - head.join('\n').length - 1) / Math.max(1, items.length)) - 1;
  const lines = items.length ? items.map((t, i) => trackLine(`**${first + i + 1}.** `, t, Math.min(LINE_MAX, share)))
    : ['Nothing else is queued. Add more with `/play`.'];
  const footer = [`Page ${at}/${pages}`, count(upcoming.length, 'track')];
  if (upcoming.length) footer.push(`total ${totalLength(upcoming)}`);
  footer.push(loop);
  return embed.description(joinLines([...head, ...lines], LIMITS.description)).footer(footer.join(' · '));
}

/** The summed length of tracks, with '+ unknown' / '+ live' when some have none: '1:02:05 + live'. */
function totalLength(tracks) {
  let sum = 0;
  let known = false;
  let unknown = false;
  let live = false;
  for (const t of tracks) {
    const length = lengthOf(t);
    if (isLive(t)) live = true;
    else if (length === null) unknown = true;
    else { sum += length; known = true; }
  }
  return [known && formatDuration(sum), unknown && 'unknown', live && 'live'].filter(Boolean).join(' + ');
}

/** Seconds until the track at `position` starts, or null when something ahead of it has no known end. */
function startsIn(s, position) {
  const upcoming = list(s.upcoming);
  if (!Number.isSafeInteger(position) || position < 1 || position - 1 > upcoming.length) return null;
  let eta = 0;
  const current = obj(s.current);
  if (current) {
    const length = lengthOf(current);
    // A stream, or a track on repeat, never ends by itself: what waits behind it starts whenever someone skips.
    if (length === null || s.loop === 'track') return null;
    eta += length - elapsed(s.position, length);
  }
  for (const t of upcoming.slice(0, position - 1)) {
    const length = lengthOf(t);
    if (length === null) return null;
    eta += length;
  }
  return eta;
}

/**
 * The reply to /play when the track was queued behind others: its name, position, length and, when every track
 * ahead of it has a known end, roughly when it starts.
 * @param {Track} track
 * @param {number} position its 1-based place among the waiting tracks (Player#play's position)
 * @param {PlayerSnapshot} snapshot taken just after adding it (just before works too)
 * @param {{ color?: Color }} [opts]
 * @returns {Embed}
 */
export function trackAddedEmbed(track, position, snapshot, { color } = {}) {
  const t = obj(track) ?? {};
  const about = isLive(t) ? sanitize(t.description, NAME_MAX) : '';
  const embed = newEmbed('➕ Added to queue', color).description(`${heading(t)}${about ? `\n${about}` : ''}`);
  const link = httpsUrl(t.url);
  if (link) embed.url(link);
  if (Number.isSafeInteger(position) && position > 0) embed.field('Position', `#${position}`, true);
  const length = lengthOf(t);
  if (isLive(t) || length !== null) embed.field('Length', isLive(t) ? '🔴 LIVE' : formatDuration(length), true);
  const eta = startsIn(obj(snapshot) ?? {}, position);
  if (eta !== null) embed.field('Starts in', `~${formatDuration(eta)}`, true);
  return embed;
}

/** 'a', 'a or b', 'a, b or c' */
const orList = (words) => (words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : words[0] ?? '');

/**
 * The library: a page of local files numbered for /play <number> (with pageSize 20, page 2 starts at 21), and
 * the radio stations as `id` — name. With no files it says where they go and which formats play.
 * @param {{ localTracks?: LocalTrack[], stations?: Station[], page?: number, pageSize?: number, color?: Color,
 *   folder?: string, extensions?: readonly string[] }} [opts] page is clamped to [1, pages], pageSize to [1, 50];
 *   folder names the music folder in the hint (default './music'; not an absolute path, it would show in chat);
 *   extensions are the playable ones (pass AUDIO_EXTENSIONS from src/tracks.js)
 * @returns {Embed}
 */
export function tracksEmbed({ localTracks, stations, page = 1, pageSize = 20, color, folder = './music',
  extensions = DEFAULT_EXTENSIONS } = {}) {
  const files = list(localTracks);
  // A station without an id can't be picked with /play <id>, so it isn't offered.
  const radios = list(stations).filter((st) => sanitize(st?.id, 1));
  const embed = newEmbed('🎵 Music library', color);
  const size = clampInt(pageSize, 1, LIBRARY_PAGE_MAX, 20);
  const pages = Math.max(1, Math.ceil(files.length / size));
  const at = clampInt(page, 1, pages, 1);
  if (files.length) {
    const first = (at - 1) * size;
    const items = files.slice(first, first + size);
    const share = Math.min(LINE_MAX, Math.floor(LIMITS.description / items.length) - 1);
    embed.description(joinLines(items.map((f, i) => {
      const head = `**${first + i + 1}.** `;
      // Never f.path: an absolute path would show the host's folders in chat.
      const name = [f?.title, f?.fileName].find((v) => sanitize(v, 1)) ?? 'Unknown file';
      return head + sanitize(name, share - head.length);
    }), LIMITS.description));
  } else {
    const types = orList(list(extensions).map((e) => sanitize(e, 16)).filter(Boolean)) || 'audio';
    embed.description(`No music files yet. Put ${types} files in ${code(folder, 100)} and they show up here, `
      + 'no restart needed.');
  }
  if (radios.length) {
    const lines = radios.map((st) => `${code(st.id, 40)} — ${sanitize(st.name, 80) || sanitize(st.id, 40)}`);
    embed.field('📻 Radio stations', joinLines(lines, LIMITS.fieldValue));
  }
  const how = [files.length && '/play <number or name>', radios.length && '/play <station id>'].filter(Boolean);
  const footer = files.length ? [`Page ${at}/${pages}`, count(files.length, 'file')] : [];
  if (how.length) footer.push(`Play: ${how.join(' or ')}`);
  return footer.length ? embed.footer(footer.join(' · ')) : embed;
}

/**
 * The command list, `/name` — description per line, in the order given. Entries without a valid command name
 * are left out.
 * @param {Iterable<{ name?: string, description?: string }>} commands
 * @param {{ color?: Color }} [opts]
 * @returns {Embed}
 */
export function helpEmbed(commands, { color } = {}) {
  const lines = [];
  const items = obj(commands) && typeof commands[Symbol.iterator] === 'function' ? commands : [];
  for (const c of items) {
    const name = str(typeof c === 'string' ? c : c?.name).trim().toLowerCase().replace(/^[/!]/, '');
    if (!COMMAND_NAME.test(name)) continue;
    const about = sanitize(c?.description, 100);
    lines.push(`\`/${name}\`${about ? ` — ${about}` : ''}`);
  }
  return newEmbed('🎧 Commands', color)
    .description(lines.length ? joinLines(lines, LIMITS.description) : 'No commands yet.')
    .footer('The buttons under the Now Playing card pause, skip, stop, loop and change the volume too.');
}
