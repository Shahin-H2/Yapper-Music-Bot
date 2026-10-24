// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.

/**
 * What /play can play: music-folder files, radio presets (config/stations.json) and, if allowed, http(s) streams.
 * A query is only compared with the folder listing, never turned into a path, so '../../.env' can't reach a file
 * outside the music folder. Links to this machine or its private network are refused.
 */
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { probeFile } from './ffmpeg.js';

/**
 * @typedef {object} Track What the queue holds and the player plays. Text is raw: escape it before display.
 * @property {'file'|'stream'} kind
 * @property {boolean} live true for streams (radio): pausing drops audio instead of holding ffmpeg back
 * @property {string} title
 * @property {string|null} artist
 * @property {string} input absolute file path or http(s) URL
 * @property {'local'|'station'|'url'} source
 * @property {number|null} duration seconds; null when unknown or live
 * @property {string|null} fileName local files only
 * @property {string|null} stationId stations only
 * @property {string|null} description stations only
 * @property {string|null} url https page the embed title links to (a station's homepage)
 * @property {string|null} requestedBy user id, set by the cog
 */
/** @typedef {{ fileName: string, path: string, title: string, ext: string }} LocalTrack */
/** @typedef {{ id: string, name: string, url: string, description: string|null, homepage: string|null }} Station */
/** @typedef {{ label: string, query: string }} Candidate `query` is what to type after /play to pick it */
/**
 * @typedef {{ ok: true, track: Track, match: 'url'|'station'|'file'|'index'|'fuzzy' }
 *   | { ok: false, reason: 'empty'|'bad_url'|'urls_disabled'|'bad_index'|'not_found'|'ambiguous', message: string,
 *       candidates?: Candidate[] }} Resolution `message` is ready to post; `candidates` are options to offer
 */

/** Matched case-insensitively (SONG.MP3 counts). */
export const AUDIO_EXTENSIONS = Object.freeze(['.mp3', '.wav', '.flac', '.ogg', '.opus', '.m4a']);

// Must hold a letter, so an id can never be mistaken for a track number (/play 3).
const STATION_ID = /^(?=.*[a-z])[a-z0-9][a-z0-9_-]{0,31}$/;
const INDEX = /^#?\d+$/;
const RADIO = /^(?:radio|station)\s*:/i;
const MAX_CANDIDATES = 5;
const LABEL_MAX = 80;
// Fuzzy search costs query words times library size, on the thread that feeds every server's audio. No real search
// is this long, and a crafted one over a big library could stall playback for longer than LiveKit's audio buffer.
const SEARCH_MAX = 200;
const PROBE_CACHE_SIZE = 2000;
const LIST_HINT = '/tracks lists the tracks and stations.';
const LINKS_OFF = `Playing links is turned off on this bot. ${LIST_HINT}`;
const PRIVATE_LINK = "I don't play links to the computer I run on or to its local network, only public streams.";
// Literal addresses a link may not point at, since ffmpeg fetches it from the bot's own machine: loopback, private,
// carrier-grade NAT, link-local (cloud metadata), benchmarking, multicast and reserved ranges.
const PRIVATE_NETS = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 3]]) PRIVATE_NETS.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 96], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  PRIVATE_NETS.addSubnet(address, prefix, 'ipv6');
}
// Schemes that count as links without '//'; any other "word:" is search text ("Muse: Uprising", "AC:DC").
const BARE_SCHEMES = new Set(['about', 'blob', 'concat', 'data', 'file', 'ftp', 'ftps', 'http', 'https', 'javascript',
  'magnet', 'mailto', 'rtmp', 'rtsp', 'sftp', 'spotify', 'subfile', 'tel', 'vbscript', 'view-source', 'ws', 'wss']);
// Web pages, not audio: ffmpeg would only fetch HTML and fail, so these are refused before joining voice.
const SERVICES = [
  ['YouTube', ['youtube.com', 'youtu.be', 'youtube-nocookie.com']],
  ['Spotify', ['spotify.com', 'spotify.link']],
  ['SoundCloud', ['soundcloud.com']],
  ['Apple Music', ['music.apple.com']],
  ['Deezer', ['deezer.com', 'deezer.page.link']],
  ['Tidal', ['tidal.com']],
  ['Bandcamp', ['bandcamp.com']],
  ['Twitch', ['twitch.tv']],
];
const PAIRS = new Map([['<', '>'], ['"', '"'], ["'", "'"], ['`', '`'],
  ['“', '”'], ['‘', '’'], ['«', '»'], ['„', '“']]);

// One line of display text: control and bidi-override characters out, whitespace collapsed.
const clean = (text) => text.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu, ' ')
  .replace(/\s+/g, ' ').trim();
// Cuts to `max` characters with an ellipsis, never splitting a surrogate pair.
const truncate = (text, max) => (text.length <= max ? text
  : `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`);
// How warnings describe a bad config value.
const show = (v) => (typeof v === 'string' ? JSON.stringify(truncate(v, 40))
  : v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v);
// Typed text as a reply quotes it back: short plain text only, so mentions, markdown and links (or anything chat
// would turn into a link, like a domain) are never echoed. Anything else is replaced by `fallback`.
const quote = (text, fallback = 'your search') => {
  const t = text.normalize('NFC');
  return /^[\p{L}\p{N}][\p{L}\p{N} .,'’&!?()+-]{0,39}$/u.test(t) && !/\.\p{L}{2}/u.test(t) ? `“${t}”` : fallback;
};

// The parsed URL if `text` is http(s) with a real host (one with a letter or digit), else null.
function httpUrl(text) {
  if (typeof text !== 'string') return null;
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && /[\p{L}\p{N}]/u.test(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

export function isHttpUrl(text) {
  return httpUrl(text) !== null;
}

// Whether a hostname, as new URL() canonicalizes it (2130706433, 0x7f.1 and 127.1 all become 127.0.0.1), is this
// machine or a private, link-local or multicast address. Literal addresses and localhost names only: a public name
// resolving to a private address, or a redirect to one, still gets through, since ffmpeg resolves and follows those.
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const kind = net.isIP(host);
  if (kind === 4) return PRIVATE_NETS.check(host, 'ipv4');
  if (kind !== 6) return false;
  // ::ffff:a.b.c.d is an IPv4 address in IPv6 notation (new URL() writes ::ffff:127.0.0.1 as ::ffff:7f00:1).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) return PRIVATE_NETS.check(host, 'ipv6');
  const [high, low] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
  return PRIVATE_NETS.check(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, 'ipv4');
}

/** Whether `text` reads as a link of any kind (scheme://, or a slashless scheme like data:), not a search. */
export function looksLikeUrl(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;
  // Text right after the colon, as in a link: "Data: The Album" is a title, data:text/plain,x isn't.
  const scheme = /^([a-z][a-z0-9+.-]*):\S/i.exec(t)?.[1];
  return scheme !== undefined && BARE_SCHEMES.has(scheme.toLowerCase());
}

/** Search form of text: lowercase, no diacritics or apostrophes, and other non-letter/digit runs as one space. */
export function normalize(text) {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/['’‘ʼ`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** 'My_Song.MP3' -> 'My Song', case kept; only a real extension goes, so 'Mr. Brightside' stays whole. */
export function titleFromFilename(name) {
  if (typeof name !== 'string') return '';
  return clean(name.replace(/\.[\p{L}\p{N}]{1,10}$/u, '').replace(/_/g, ' ')) || clean(name);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// Natural order (track2 before track10); names the collator calls equal ('a' and 'A') get a fixed order anyway.
const byFileName = (a, b) => collator.compare(a.fileName, b.fileName)
  || (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0);

// A folder that can't be read gives no tracks plus the error, which init() turns into a warning.
async function readMusicDir(musicDir) {
  if (typeof musicDir !== 'string' || !musicDir || musicDir.includes('\0')) return { tracks: [], error: null };
  const dir = path.resolve(musicDir);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return { tracks: [], error };
  }
  const picked = await Promise.all(entries.map(async (entry) => {
    const name = entry.name;
    const ext = path.extname(name).toLowerCase();
    if (name.startsWith('.') || !AUDIO_EXTENSIONS.includes(ext)) return null;
    const file = path.join(dir, name);
    // A symlink counts when it leads to a regular file (a linked-in collection); FIFOs, devices and folders never do.
    if (entry.isSymbolicLink()) {
      try {
        if (!(await fs.stat(file)).isFile()) return null;
      } catch {
        return null;
      }
    } else if (!entry.isFile()) {
      return null;
    }
    return { fileName: name, path: file, title: titleFromFilename(name), ext };
  }));
  return { tracks: picked.filter(Boolean).sort(byFileName), error: null };
}

/** Audio files directly in `musicDir`, in natural order (the numbering /tracks shows); [] if unreadable. */
export async function listLocalTracks(musicDir) {
  try {
    return (await readMusicDir(musicDir)).tracks;
  } catch {
    return [];
  }
}

/**
 * Validates parsed stations JSON: an array of { id, name, url, description?, homepage? }, or { stations: [...] }.
 * Bad entries are skipped and bad optional fields dropped, each with a warning; never throws. Ids are lowercased,
 * the first entry with a given id wins, and a homepage must be https.
 * @returns {{ stations: Station[], warnings: string[] }} the stations are frozen
 */
export function parseStations(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.stations) ? data.stations : null;
  if (!list) {
    const warning = `Stations must be a JSON array of { id, name, url } objects (got ${show(data)})`;
    return { stations: [], warnings: [warning] };
  }
  const stations = [];
  const warnings = [];
  const ids = new Set();
  for (const [i, raw] of list.entries()) {
    const where = `station ${i + 1}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push(`${where} isn't an object; skipped`);
      continue;
    }
    const given = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id).trim() : '';
    const id = given.toLowerCase();
    const problem = !id ? 'has no id'
      : /^\d+$/.test(id) ? `has id ${show(given)}, which needs a letter so it can't clash with track numbers`
        : !STATION_ID.test(id) ? `has id ${show(given)}, but ids are 1-32 of a-z, 0-9, - and _ `
          + '(with a letter, not starting with - or _)'
          : ids.has(id) ? `has id "${id}", which is already taken` : null;
    if (problem) {
      warnings.push(`${where} ${problem}; skipped`);
      continue;
    }
    const url = httpUrl(typeof raw.url === 'string' ? raw.url.trim() : null);
    if (!url) {
      warnings.push(`station "${id}": url ${show(raw.url)} isn't an http(s) link; skipped`);
      continue;
    }
    let name = typeof raw.name === 'string' ? clean(raw.name) : '';
    if (!name) {
      warnings.push(`station "${id}" has no name; using its id`);
      name = id;
    }
    let description = null;
    if (typeof raw.description === 'string') description = clean(raw.description) || null;
    else if (raw.description != null) warnings.push(`station "${id}": description isn't text; left out`);
    let homepage = null;
    if (raw.homepage != null && raw.homepage !== '') {
      const page = httpUrl(typeof raw.homepage === 'string' ? raw.homepage.trim() : null);
      if (page?.protocol === 'https:') homepage = page.href;
      else warnings.push(`station "${id}": homepage ${show(raw.homepage)} isn't an https link; left out`);
    }
    ids.add(id);
    stations.push(Object.freeze({ id, name, url: url.href, description, homepage }));
  }
  return { stations, warnings };
}

/** parseStations on a file; never throws. A missing or broken file gives a warning, null or '' gives nothing. */
export async function loadStations(file) {
  if (file === undefined || file === null || file === '') return { stations: [], warnings: [] };
  if (typeof file !== 'string') {
    return { stations: [], warnings: [`The stations file must be a path (got ${show(file)})`] };
  }
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    const why = err?.code === 'ENOENT' ? `Stations file ${file} not found`
      : `Can't read the stations file ${file}: ${err?.message}`;
    return { stations: [], warnings: [`${why}; no radio stations`] };
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^\ufeff/, '')); // some Windows editors start files with a BOM
  } catch (err) {
    return { stations: [], warnings: [`Stations file ${file} isn't valid JSON (${err.message}); no radio stations`] };
  }
  const { stations, warnings } = parseStations(data);
  return { stations, warnings: warnings.map((w) => `${path.basename(file)}: ${w}`) };
}

const isLocal = (t) => t !== null && typeof t === 'object' && typeof t.fileName === 'string' && t.fileName !== ''
  && typeof t.path === 'string' && path.isAbsolute(t.path);
const isStation = (s) => s !== null && typeof s === 'object' && typeof s.id === 'string' && s.id !== ''
  && isHttpUrl(s.url);
const localTitle = (local) => (typeof local.title === 'string' && clean(local.title))
  || titleFromFilename(local.fileName);

/** Track for a LocalTrack. Throws TypeError without a file name and an absolute path. */
export function fileTrack(local) {
  if (!isLocal(local)) throw new TypeError('fileTrack needs a { fileName, path } entry with an absolute path');
  return {
    kind: 'file', live: false, title: localTitle(local), artist: null, input: local.path, source: 'local',
    duration: null, fileName: local.fileName, stationId: null, description: null, url: null, requestedBy: null,
  };
}

/** Track for a Station, linking the embed to its https homepage. Throws TypeError without an id and http(s) url. */
export function stationTrack(station) {
  if (!isStation(station)) throw new TypeError('stationTrack needs a station with an id and an http(s) url');
  const page = httpUrl(station.homepage);
  return {
    kind: 'stream', live: true, title: (typeof station.name === 'string' && clean(station.name)) || station.id,
    artist: null, input: httpUrl(station.url).href, source: 'station', duration: null, fileName: null,
    stationId: station.id, description: (typeof station.description === 'string' && clean(station.description)) || null,
    url: page?.protocol === 'https:' ? page.href : null, requestedBy: null,
  };
}

/** Track titled by host + path only (the query and user:password can hold secrets). Throws TypeError unless http(s). */
export function urlTrack(url) {
  const parsed = httpUrl(url instanceof URL ? url.href : url);
  if (!parsed) throw new TypeError('urlTrack needs an http(s) URL');
  parsed.hash = ''; // never sent to the server anyway
  let pathname = parsed.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch { /* a stray %: keep the raw path */ }
  const title = truncate(clean(`${parsed.host}${pathname === '/' ? '' : pathname}`), LABEL_MAX);
  return {
    kind: 'stream', live: true, title, artist: null, input: parsed.href, source: 'url', duration: null,
    fileName: null, stationId: null, description: null, url: null, requestedBy: null,
  };
}

// Strips one pair of surrounding <> or quotes; people wrap a link in <> to stop its preview.
function unwrap(text) {
  const t = text.trim();
  const close = t.length >= 2 ? PAIRS.get(t[0]) : undefined;
  return close !== undefined && t.endsWith(close) ? t.slice(1, -1).trim() : t;
}

function serviceOf(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return SERVICES.find(([, domains]) => domains.some((d) => host === d || host.endsWith(`.${d}`)))?.[0] ?? null;
}

// Library names are normalized once: they don't change between searches, and a big library has thousands.
const normalized = new Map();
function normalizeName(text) {
  let norm = normalized.get(text);
  if (norm === undefined) {
    if (normalized.size >= 50_000) normalized.clear();
    norm = normalize(text);
    normalized.set(text, norm);
  }
  return norm;
}

// Search items: files and stations with their normalized names; `keys` are what fuzzy matching scores.
function fileItem(local, index) {
  const title = localTitle(local);
  const norm = normalizeName(title);
  return { kind: 'file', local, index, title, norm, name: local.fileName.normalize('NFC'),
    keys: [norm, normalizeName(local.fileName)] };
}
function stationItem(station) {
  const title = (typeof station.name === 'string' && clean(station.name)) || station.id;
  const norm = normalizeName(title);
  const id = normalizeName(station.id);
  return { kind: 'station', station, title, norm, compact: [id.replaceAll(' ', ''), norm.replaceAll(' ', '')],
    keys: [id, norm] };
}
const trackOf = (item) => (item.kind === 'file' ? fileTrack(item.local) : stationTrack(item.station));

// Files are offered by track number; two with the same title are labelled by file name.
function candidates(items) {
  const shown = items.slice(0, MAX_CANDIDATES);
  const titles = shown.map((i) => i.title.toLowerCase());
  return shown.map((item) => {
    if (item.kind === 'station') return { label: truncate(item.title, LABEL_MAX), query: item.station.id };
    const twin = titles.filter((t) => t === item.title.toLowerCase()).length > 1;
    return { label: truncate(twin ? item.local.fileName : item.title, LABEL_MAX), query: String(item.index) };
  });
}

const found = (track, match) => ({ ok: true, track, match });
const fail = (reason, message, items = []) => (items.length
  ? { ok: false, reason, message, candidates: candidates(items) } : { ok: false, reason, message });

function ambiguous(text, items) {
  const files = items.filter((i) => i.kind === 'file').length;
  const stations = items.length - files;
  const what = files && stations ? `${items.length} tracks and stations`
    : files ? `${files} tracks` : `${stations} stations`;
  const ask = items.length > MAX_CANDIDATES ? 'Be more specific, or pick one of these:' : 'Which one did you mean?';
  return fail('ambiguous', `${what} match ${quote(text)}. ${ask}`, items);
}

// Levenshtein distance if it is at most `max`, else max + 1. Only cells with |i - j| <= max can lie on such a path,
// so only that band is computed.
function distance(a, b, max) {
  const over = max + 1;
  if (Math.abs(a.length - b.length) > max) return over;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => (j <= max ? j : over));
  let row = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    row.fill(over);
    if (i <= max) row[0] = i;
    let low = row[0];
    for (let j = Math.max(1, i - max); j <= Math.min(b.length, i + max); j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), over);
      if (row[j] < low) low = row[j];
    }
    if (low > max) return over;
    [prev, row] = [row, prev];
  }
  return prev[b.length];
}

// "Did you mean" items, closest first: those with a run of words within a typo or two of the query ('groovesald' and
// 'grove salad' both find groovesalad). Only ever suggested, never picked.
function suggest(q, items) {
  const max = q.length < 4 ? 0 : q.length < 8 ? 1 : 2;
  if (max === 0) return [];
  const n = q.split(' ').length;
  const close = [];
  for (const item of items) {
    let best = max + 1;
    // A file name is its title plus the extension, so the title is enough here.
    for (const key of item.kind === 'file' ? [item.norm] : item.keys) {
      const words = key ? key.split(' ') : [];
      // Runs of up to n + 1 words (a typo can drop a space), measured before any string is cut out.
      for (let p = 0, start = 0; p < words.length && best > 0; start += words[p].length + 1, p++) {
        let length = -1;
        for (let size = 1; size <= n + 1 && p + size <= words.length; size++) {
          length += words[p + size - 1].length + 1;
          if (Math.abs(length - q.length) <= max) {
            best = Math.min(best, distance(q, key.slice(start, start + length), max));
          }
        }
      }
    }
    if (best <= max) close.push({ item, best });
  }
  return close.sort((a, b) => a.best - b.best).map((c) => c.item); // stable: library order within a distance
}

// How well `text` matches the query: equal 100, starts with it 80, every query word starts a word 60, contains 40.
function score(q, tokens, text) {
  if (!text) return 0;
  if (text === q) return 100;
  if (text.startsWith(q)) return 80;
  // Cheap test first: a word can't start with a token that isn't in the text at all.
  if (tokens.every((t) => text.includes(t))) {
    const words = text.split(' ');
    if (tokens.every((t) => words.some((w) => w.startsWith(t)))) return 60;
  }
  return text.includes(q) ? 40 : 0;
}

// Step 8: the single best-scoring item, ambiguous on a tie, not_found (with near misses) when nothing scores.
function fuzzy(text, q, items, notFound) {
  if (q.length > SEARCH_MAX) return fail('not_found', `${notFound} ${LIST_HINT}`);
  const tokens = [...new Set(q.split(' '))]; // 'a a a a' costs no more than 'a'
  let best = 0;
  let top = [];
  for (const item of items) {
    const s = Math.max(...item.keys.map((k) => score(q, tokens, k)));
    if (s > best) {
      best = s;
      top = [item];
    } else if (s === best && s > 0) {
      top.push(item);
    }
  }
  if (top.length === 1) return found(trackOf(top[0]), 'fuzzy');
  if (top.length > 1) return ambiguous(text, top);
  const close = suggest(q, items);
  return fail('not_found', `${notFound} ${close.length ? 'Did you mean one of these?' : LIST_HINT}`, close);
}

// Station name or id equality, spaces ignored: 'kexp 90.3 seattle', 'groove salad' and 'fip-jazz' all hit.
function sameStation(q, items) {
  const compact = q.replaceAll(' ', '');
  return items.filter((s) => s.compact.includes(compact));
}

// 'radio:<id>' or 'station:<id>': stations only, by id, then name, then fuzzily.
function resolveStation(rest, stations) {
  if (stations.length === 0) return fail('not_found', 'There are no radio stations on this bot.');
  const items = stations.map(stationItem);
  if (!rest) return fail('empty', 'Which station? Type its id, like one of these:', items);
  const id = rest.toLowerCase();
  const exact = stations.find((s) => s.id === id);
  if (exact) return found(stationTrack(exact), 'station');
  const notFound = `There's no station called ${quote(rest, 'that')}.`;
  const q = normalize(rest);
  if (!q) return fail('not_found', `${notFound} ${LIST_HINT}`);
  const same = sameStation(q, items);
  if (same.length === 1) return found(stationTrack(same[0].station), 'station');
  if (same.length > 1) return ambiguous(rest, same);
  return fuzzy(rest, q, items, notFound);
}

// Step 3: an http(s) link becomes a stream (when allowed); any other link is refused.
function resolveLink(text, allowUrls) {
  const url = httpUrl(text);
  const service = url ? serviceOf(url.hostname) : /^spotify:/i.test(text) ? 'Spotify' : null;
  if (service) {
    return fail('bad_url', allowUrls
      ? `I can't play ${service} links, only direct audio streams (like an internet radio stream), stations and local `
        + 'tracks.'
      : `I can't play ${service} links. ${LIST_HINT}`);
  }
  if (!url) return fail('bad_url', allowUrls ? 'I can only play http:// and https:// links.' : LINKS_OFF);
  if (!allowUrls) return fail('urls_disabled', LINKS_OFF);
  // The bot's machine would fetch it: no reaching into its own network (and no telling chat what answers there).
  if (isPrivateHost(url.hostname)) return fail('bad_url', PRIVATE_LINK);
  return found(urlTrack(url), 'url');
}

// Step 6: '/play 3' or '/play #3' is the third file in the listing.
function resolveIndex(text, all, files) {
  const digits = text.replace(/^#/, '').replace(/^0+(?=\d)/, '');
  const hit = files.find((f) => f.index === Number(digits));
  if (hit) return found(fileTrack(hit.local), 'index');
  const n = all.length;
  const have = n === 0 ? 'The music library is empty' : n === 1 ? 'The library has 1 track (#1)'
    : `The library has ${n} tracks (#1 to #${n})`;
  return fail('bad_index', `There's no track #${truncate(digits, 10)}. ${have}. ${LIST_HINT}`);
}

/**
 * Resolves what someone typed after /play; the first step that matches wins. Pure and synchronous.
 *  1. trim and unwrap one pair of <> or quotes; nothing left: 'empty'
 *  2. 'radio:<id>' or 'station:<id>': stations only (id, then name, then fuzzy)
 *  3. a link: an http(s) stream if allowed, else 'urls_disabled'; other links, service pages, private hosts: 'bad_url'
 *  4. a station id, any case
 *  5. a file name (any case), else a normalized title; numbers skip titles, so '7' is track #7 even if 7.mp3 exists
 *  6. '3' or '#3': that track number, else 'bad_index'
 *  7. a station name, or an id typed with spaces ('groove salad')
 *  8. fuzzy over titles, file names and stations (see score): 'fuzzy', 'ambiguous' on a tie, else 'not_found'
 * @param {{ localTracks?: LocalTrack[], stations?: Station[], allowUrls?: boolean }} [lists]
 * @returns {Resolution} with a new Track object every time
 */
export function resolveQuery(query, { localTracks = [], stations = [], allowUrls = true } = {}) {
  const text = unwrap(typeof query === 'string' ? query : Number.isFinite(query) ? String(query) : '');
  const presets = Array.isArray(stations) ? stations.filter(isStation) : [];
  if (!text) {
    const what = allowUrls ? 'a track number or name, a station or an http(s) link'
      : 'a track number or name, or a station';
    return fail('empty', `Tell me what to play: ${what}. ${LIST_HINT}`);
  }
  const radio = RADIO.exec(text);
  if (radio) return resolveStation(text.slice(radio[0].length).trim(), presets);
  if (looksLikeUrl(text)) return resolveLink(text, allowUrls);
  const lower = text.toLowerCase();
  const byId = presets.find((s) => s.id === lower);
  if (byId) return found(stationTrack(byId), 'station');

  const all = Array.isArray(localTracks) ? localTracks : [];
  const files = [];
  all.forEach((local, i) => { if (isLocal(local)) files.push(fileItem(local, i + 1)); });
  // Exact case first: on a case-sensitive disk Song.mp3 and song.mp3 can both exist.
  const name = text.normalize('NFC');
  const lowerName = name.toLowerCase();
  const exact = files.filter((f) => f.name === name);
  const named = exact.length ? exact : files.filter((f) => f.name.toLowerCase() === lowerName);
  if (named.length === 1) return found(fileTrack(named[0].local), 'file');
  if (named.length > 1) return ambiguous(text, named);
  const numeric = INDEX.test(text);
  const q = normalize(text);
  if (q && !numeric) {
    const titled = files.filter((f) => f.norm === q);
    if (titled.length === 1) return found(fileTrack(titled[0].local), 'file');
    if (titled.length > 1) return ambiguous(text, titled);
  }
  if (numeric) return resolveIndex(text, all, files);
  const notFound = `Nothing matches ${quote(text)}.`;
  if (!q) return fail('not_found', `${notFound} ${LIST_HINT}`);
  const items = presets.map(stationItem);
  const same = sameStation(q, items);
  if (same.length === 1) return found(stationTrack(same[0].station), 'station');
  if (same.length > 1) return ambiguous(text, same);
  return fuzzy(text, q, [...files, ...items], notFound);
}

function musicDirWarning(dir, err) {
  if (err?.code === 'ENOENT') {
    return `Music folder ${dir} doesn't exist: create it and put audio files in it (or set MUSIC_DIR)`;
  }
  if (err?.code === 'ENOTDIR') return `Music folder ${dir} is a file, not a folder (check MUSIC_DIR)`;
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return `Can't read the music folder ${dir}: permission denied`;
  return `Can't read the music folder ${dir}: ${err?.message ?? err}`;
}

function probeInfo(raw) {
  const text = (v) => (typeof v === 'string' ? clean(v) || null : null);
  const duration = raw?.duration;
  return {
    duration: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null,
    title: text(raw?.title),
    artist: text(raw?.artist),
  };
}

// A copy with what the probe found; a title tag replaces the file-name title and brings its artist (or none).
function withInfo(track, { duration, title, artist }) {
  const out = { ...track, duration: duration ?? track.duration ?? null };
  if (title) return { ...out, title, artist: artist ?? null };
  // Only an artist tag: show it, unless the file name already says it ("Beyoncé - Halo").
  if (artist && !normalize(out.title).includes(normalize(artist))) out.artist = artist;
  return out;
}

/** Stations load in init(); the folder listing is cached for `cacheMs`, so new files show up without a restart. */
export class TrackLibrary {
  #musicDir;
  #stationsFile;
  #allowUrls;
  #probe;
  #cacheMs;
  #now;
  #stations = [];
  #listing = null;
  #reading = null;
  #generation = 0;
  // file path -> its latest probe, least recently used first
  #probes = new Map();

  /**
   * @param {{ musicDir?: string|null, stationsFile?: string|null, allowUrls?: boolean, ffprobePath?: string,
   *   probe?: (file: string) => Promise<{ duration: number|null, title: string|null, artist: string|null }>,
   *   cacheMs?: number, now?: () => number }} [opts]
   *   musicDir, stationsFile: null for none; ffprobePath: for the default probe; cacheMs: how long a listing is reused
   */
  constructor({ musicDir = null, stationsFile = null, allowUrls = true, ffprobePath = 'ffprobe',
    probe = (file) => probeFile(file, { ffprobePath }), cacheMs = 3000, now = Date.now } = {}) {
    if (typeof probe !== 'function') throw new TypeError('probe must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof cacheMs !== 'number' || !(cacheMs >= 0)) throw new RangeError('cacheMs must be a number >= 0');
    this.#musicDir = typeof musicDir === 'string' && musicDir ? path.resolve(musicDir) : null;
    this.#stationsFile = stationsFile;
    this.#allowUrls = Boolean(allowUrls);
    this.#probe = probe;
    this.#cacheMs = cacheMs;
    this.#now = now;
  }

  get musicDir() { return this.#musicDir; }
  get allowUrls() { return this.#allowUrls; }
  /** A copy of the presets from the last init(); [] before it. */
  get stations() { return [...this.#stations]; }

  /** (Re)loads the stations and checks the music folder; resolves warnings for the log. Never throws. */
  async init() {
    const { stations, warnings } = await loadStations(this.#stationsFile);
    this.#stations = stations;
    this.invalidate();
    const { error } = await this.#list();
    if (error) warnings.push(musicDirWarning(this.#musicDir, error));
    return warnings;
  }

  /** Forgets the cached folder listing (not the stations or probe results). */
  invalidate() {
    this.#generation++;
    this.#listing = null;
    this.#reading = null;
  }

  /** The folder's tracks from a listing at most `cacheMs` old, as a new array. Never throws. */
  async localTracks() {
    return [...(await this.#list()).tracks];
  }

  #list() {
    const now = this.#now();
    const age = now - (this.#listing?.at ?? NaN);
    // age < 0: the clock went back, so don't trust the listing to be recent
    if (this.#listing && age >= 0 && age < this.#cacheMs) return Promise.resolve(this.#listing);
    // Concurrent calls share one read. A read that invalidate() overtook still answers its callers but isn't cached.
    if (!this.#reading) {
      const generation = this.#generation;
      const reading = readMusicDir(this.#musicDir)
        .catch((error) => ({ tracks: [], error }))
        .then((listing) => {
          if (this.#reading === reading) this.#reading = null;
          if (generation === this.#generation) this.#listing = { ...listing, at: now };
          return listing;
        });
      this.#reading = reading;
    }
    return this.#reading;
  }

  /** resolveQuery against the current folder listing and stations. Never throws. */
  async resolve(query) {
    const { tracks } = await this.#list();
    return resolveQuery(query, { localTracks: tracks, stations: this.#stations, allowUrls: this.#allowUrls });
  }

  /** A copy of a file track with ffprobe's duration and tags, probed once per file version. Never throws. */
  async enrich(track) {
    try {
      if (track === null || typeof track !== 'object' || track.kind !== 'file' || typeof track.input !== 'string') {
        return track;
      }
      const stat = await fs.stat(track.input);
      if (!stat.isFile()) return track;
      const info = await this.#probeOnce(track.input, `${stat.mtimeMs}:${stat.size}`);
      return info ? withInfo(track, info) : track;
    } catch {
      return track;
    }
  }

  #probeOnce(file, stamp) {
    const cached = this.#probes.get(file);
    this.#probes.delete(file); // re-inserted below, which keeps the map in least-recently-used order
    if (cached?.stamp === stamp) {
      this.#probes.set(file, cached);
      return cached.info;
    }
    const entry = { stamp, info: null };
    entry.info = (async () => this.#probe(file))().then(probeInfo).catch(() => {
      if (this.#probes.get(file) === entry) this.#probes.delete(file); // don't cache a failure: ask again next time
      return null;
    });
    this.#probes.set(file, entry);
    if (this.#probes.size > PROBE_CACHE_SIZE) this.#probes.delete(this.#probes.keys().next().value);
    return entry.info;
  }
}
