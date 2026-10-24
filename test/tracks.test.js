// Tests for src/tracks.js and the shipped config/stations.json.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIO_EXTENSIONS, TrackLibrary, fileTrack, isHttpUrl, listLocalTracks, loadStations, looksLikeUrl, normalize,
  parseStations, resolveQuery, stationTrack, titleFromFilename, urlTrack,
} from '../src/tracks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = path.join(ROOT, 'config', 'stations.json');
const POSIX = process.platform !== 'win32';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const runs = (bin) => {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
// Built from code points so no editor or tool can quietly turn them into something else.
const ACUTE = String.fromCodePoint(0x301); // combining accent: 'e' + ACUTE is 'é' in NFD (how old Macs store names)
const NEWLINE = String.fromCodePoint(10);
const TAB = String.fromCodePoint(9);
const RLO = String.fromCodePoint(0x202e); // right-to-left override

/** The spec's station table: [id, name, url, homepage]. */
const TABLE = [
  ['groovesalad', 'SomaFM · Groove Salad', 'https://ice2.somafm.com/groovesalad-128-mp3',
    'https://somafm.com/groovesalad/'],
  ['fluid', 'SomaFM · Fluid', 'https://ice2.somafm.com/fluid-128-mp3', 'https://somafm.com/fluid/'],
  ['dronezone', 'SomaFM · Drone Zone', 'https://ice2.somafm.com/dronezone-128-mp3', 'https://somafm.com/dronezone/'],
  ['defcon', 'SomaFM · DEF CON Radio', 'https://ice2.somafm.com/defcon-128-mp3', 'https://somafm.com/defcon/'],
  ['lush', 'SomaFM · Lush', 'https://ice2.somafm.com/lush-128-mp3', 'https://somafm.com/lush/'],
  ['radioparadise', 'Radio Paradise · Main Mix', 'https://stream.radioparadise.com/mp3-192',
    'https://radioparadise.com/'],
  ['mellow', 'Radio Paradise · Mellow Mix', 'https://stream.radioparadise.com/mellow-192',
    'https://radioparadise.com/'],
  ['kexp', 'KEXP 90.3 Seattle', 'https://kexp-mp3-128.streamguys1.com/kexp128.mp3', 'https://www.kexp.org/'],
  ['fip', 'FIP', 'https://icecast.radiofrance.fr/fip-midfi.mp3', 'https://www.radiofrance.fr/fip'],
  ['fipjazz', 'FIP Jazz', 'https://icecast.radiofrance.fr/fipjazz-midfi.mp3', 'https://www.radiofrance.fr/fip'],
  ['npo2', 'NPO Radio 2', 'https://icecast.omroep.nl/radio2-bb-mp3', 'https://www.nporadio2.nl/'],
  ['3fm', 'NPO 3FM', 'https://icecast.omroep.nl/3fm-bb-mp3', 'https://www.npo3fm.nl/'],
];
const STATIONS = parseStations(JSON.parse(fs.readFileSync(SHIPPED, 'utf8'))).stations;

// resolveQuery never touches the disk, so its listings can live in a made-up folder.
const MUSIC = path.resolve('/music');
/** A listing entry exactly as listLocalTracks makes one. */
const local = (fileName, dir = MUSIC) => ({
  fileName, path: path.join(dir, fileName), title: titleFromFilename(fileName),
  ext: path.extname(fileName).toLowerCase(),
});
const listing = (...names) => names.map((n) => local(n));
// #1 … #8. '7.mp3' is #3, so '7' (track #7) and '7.mp3' must pick different files.
const BASE = listing('Beyoncé - Halo.mp3', 'fip.mp3', '7.mp3', 'Halo Theme.flac', 'my_song-remix.ogg', 'Song.mp3',
  'song.flac', 'Track 2.mp3');
const resolve = (query, lists = {}) => resolveQuery(query, { localTracks: BASE, stations: STATIONS, ...lists });
const names = (tracks) => tracks.map((t) => t.fileName);

/** Asserts an ok result and returns the track. */
function picked(res, match) {
  assert.equal(res.ok, true, `expected a track, got ${res.reason}: ${res.message}`);
  assert.equal(res.match, match);
  return res.track;
}
/** Asserts a failure with this reason and returns it. */
function refused(res, reason) {
  assert.equal(res.ok, false, `expected ${reason}, got a track (${res.track?.input})`);
  assert.equal(res.reason, reason, res.message);
  assert.equal(typeof res.message, 'string');
  assert.ok(res.message.length > 0);
  return res;
}

const deepFreeze = (x) => {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.freeze(x);
    Object.values(x).forEach(deepFreeze);
  }
  return x;
};

describe('AUDIO_EXTENSIONS', () => {
  it('lists the six formats, lowercase, frozen', () => {
    assert.deepEqual(AUDIO_EXTENSIONS, ['.mp3', '.wav', '.flac', '.ogg', '.opus', '.m4a']);
    assert.ok(Object.isFrozen(AUDIO_EXTENSIONS));
  });
});

describe('isHttpUrl', () => {
  it('accepts http(s) URLs with a host', () => {
    for (const url of ['http://example.com', 'https://x', 'HTTPS://EXAMPLE.COM/A?b=1', 'https://[::1]:8000/live',
      'https://bücher.example/stream', '  https://example.com/padded  ', 'https://user:pw@example.com/']) {
      assert.equal(isHttpUrl(url), true, url);
    }
  });

  it('refuses other schemes, broken URLs, hostless ones and non-strings', () => {
    for (const url of ['ftp://x', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,x', 'ws://x',
      'http://', 'https://exa mple.com', 'example.com', 'www.example.com/stream', '', 'https://./', 'https://../x']) {
      assert.equal(isHttpUrl(url), false, url);
    }
    for (const v of [null, undefined, 42, {}, ['https://x'], new URL('https://x')]) assert.equal(isHttpUrl(v), false);
  });
});

describe('looksLikeUrl', () => {
  it('spots scheme:// links and slashless schemes', () => {
    for (const text of ['https://x', 'ftp://x', 'file:///etc/passwd', 'weird+scheme.v2://x', 'javascript:alert(1)',
      'JavaScript:alert(1)', 'data:text/plain,x', 'mailto:a@b.c', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
      'file:/etc/passwd', 'https:example.com', '  https://x  ']) {
      assert.equal(looksLikeUrl(text), true, text);
    }
  });

  it('leaves ordinary searches alone, colons included', () => {
    for (const text of ['Muse: Uprising', 'AC:DC', 'Data: The Album', 'javascript: the good parts', '12:30',
      'radio', 'fip', 'song.mp3', 'www.example.com/stream', '../../etc/passwd', '', 'x:', 'https:', 'data: x']) {
      assert.equal(looksLikeUrl(text), false, text);
    }
    for (const v of [null, undefined, 1, {}]) assert.equal(looksLikeUrl(v), false);
  });
});

describe('normalize', () => {
  it('strips diacritics, lowercases and keeps letters of every script', () => {
    assert.equal(normalize('Beyoncé - Halo'), 'beyonce halo');
    assert.equal(normalize('BEYONCÉ'), 'beyonce');
    assert.equal(normalize(`Beyonce${ACUTE}`), 'beyonce', 'decomposed (NFD) input');
    assert.equal(normalize('Motörhead & Sigur Rós'), 'motorhead sigur ros');
    assert.equal(normalize('Кино — Группа крови'), 'кино группа крови');
    assert.equal(normalize('坂本龍一'), '坂本龍一');
  });

  it('turns punctuation, underscores and whitespace runs into single spaces, and joins apostrophes', () => {
    assert.equal(normalize('my_song-remix (Live!)'), 'my song remix live');
    assert.equal(normalize(`  lots   of${TAB}space${NEWLINE}here `), 'lots of space here');
    assert.equal(normalize("Don't Stop Me Now"), 'dont stop me now');
    assert.equal(normalize('Don’t'), 'dont');
    assert.equal(normalize("Rock 'n' Roll"), 'rock n roll');
  });

  it('folds compatibility forms (ligatures, full-width)', () => {
    assert.equal(normalize('ﬁnal'), 'final');
    assert.equal(normalize('Ｆｕｌｌ'), 'full');
  });

  it('gives an empty string for nothing alphanumeric or a non-string', () => {
    for (const v of ['', '   ', '!!!', '—', null, undefined, 42, {}]) assert.equal(normalize(v), '');
  });
});

describe('titleFromFilename', () => {
  it('drops the extension, turns _ into spaces and keeps case', () => {
    assert.equal(titleFromFilename('My_Song.MP3'), 'My Song');
    assert.equal(titleFromFilename('Beyoncé - Halo.mp3'), 'Beyoncé - Halo');
    assert.equal(titleFromFilename('a__b   c.ogg'), 'a b c');
    assert.equal(titleFromFilename('  padded .wav'), 'padded');
    assert.equal(titleFromFilename('archive.tar.mp3'), 'archive.tar');
  });

  it('only drops a real extension', () => {
    assert.equal(titleFromFilename('Mr. Brightside'), 'Mr. Brightside');
    assert.equal(titleFromFilename('Mr. Brightside.flac'), 'Mr. Brightside');
  });

  it('keeps a title on one clean line', () => {
    assert.equal(titleFromFilename(`bad${NEWLINE}name${TAB}here.mp3`), 'bad name here');
    assert.equal(titleFromFilename(`${RLO}evil.mp3`), 'evil');
  });

  it('never returns an empty title for a name with something in it', () => {
    assert.equal(titleFromFilename('___.mp3'), '___.mp3');
    assert.equal(titleFromFilename(''), '');
    for (const v of [null, undefined, 3]) assert.equal(titleFromFilename(v), '');
  });
});

describe('listLocalTracks', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dls-'));
    for (const name of ['UPPER.MP3', '.hidden.mp3', '._mac-junk.mp3', 'notes.txt', 'cover.jpg', 'noext',
      'song.mp3.part', 'track10.mp3', 'track2.mp3', 'Track1.wav', 'b.flac', 'c.ogg', 'd.opus', 'e.m4a']) {
      fs.writeFileSync(path.join(dir, name), 'x');
    }
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'inside.mp3'), 'x');
    fs.mkdirSync(path.join(dir, 'folder.mp3')); // a folder with an audio extension is still a folder
    if (POSIX) {
      fs.symlinkSync(path.join(dir, 'b.flac'), path.join(dir, 'link.mp3'));
      fs.symlinkSync(path.join(dir, 'missing.mp3'), path.join(dir, 'broken.mp3'));
      fs.symlinkSync(path.join(dir, 'sub'), path.join(dir, 'dirlink.mp3'));
    }
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists audio files only, any case, in natural order', async () => {
    const tracks = await listLocalTracks(dir);
    const expected = ['b.flac', 'c.ogg', 'd.opus', 'e.m4a', ...(POSIX ? ['link.mp3'] : []), 'Track1.wav', 'track2.mp3',
      'track10.mp3', 'UPPER.MP3'];
    assert.deepEqual(names(tracks), expected);
  });

  it('describes each file with an absolute path, a title and a lowercase extension', async () => {
    const tracks = await listLocalTracks(dir);
    const upper = tracks.find((t) => t.fileName === 'UPPER.MP3');
    assert.deepEqual(upper, { fileName: 'UPPER.MP3', path: path.join(dir, 'UPPER.MP3'), title: 'UPPER', ext: '.mp3' });
    for (const t of tracks) {
      assert.ok(path.isAbsolute(t.path));
      assert.equal(path.dirname(t.path), dir, 'never from a sub-folder');
      assert.deepEqual(Object.keys(t), ['fileName', 'path', 'title', 'ext']);
    }
  });

  it('follows a symlink only to a regular file', { skip: !POSIX && 'symlinks need a POSIX file system' }, async () => {
    const tracks = names(await listLocalTracks(dir));
    assert.ok(tracks.includes('link.mp3'));
    assert.ok(!tracks.includes('broken.mp3'));
    assert.ok(!tracks.includes('dirlink.mp3'));
  });

  it('resolves a relative folder against the working directory', async () => {
    const tracks = await listLocalTracks(path.relative(process.cwd(), dir));
    assert.equal(tracks[0].path, path.join(dir, 'b.flac'));
  });

  it('gives [] for a missing folder, a file, an empty folder or no folder at all', async () => {
    const empty = path.join(dir, 'sub', 'empty');
    fs.mkdirSync(empty);
    assert.deepEqual(await listLocalTracks(path.join(dir, 'nope')), []);
    assert.deepEqual(await listLocalTracks(path.join(dir, 'b.flac')), []);
    assert.deepEqual(await listLocalTracks(empty), []);
    for (const v of [undefined, null, '', 42, `a${String.fromCodePoint(0)}b`]) {
      assert.deepEqual(await listLocalTracks(v), []);
    }
  });
});

describe('parseStations', () => {
  const ok = { id: 'jazz', name: 'Jazz FM', url: 'https://example.com/jazz' };

  it('keeps valid stations, tidied and frozen', () => {
    const { stations, warnings } = parseStations([
      { id: '  Jazz ', name: `  Jazz${NEWLINE}  FM `, url: ' https://Example.com/jazz ', description: '  Smooth  jazz ',
        homepage: 'https://example.com/' },
      { id: 'b-side_2', name: 'B', url: 'http://example.com:8000/b' },
    ]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(stations, [
      { id: 'jazz', name: 'Jazz FM', url: 'https://example.com/jazz', description: 'Smooth jazz',
        homepage: 'https://example.com/' },
      { id: 'b-side_2', name: 'B', url: 'http://example.com:8000/b', description: null, homepage: null },
    ]);
    assert.ok(stations.every((s) => Object.isFrozen(s)));
  });

  it('skips bad ids with a warning', () => {
    const bad = ['Bad Id!', '-dash', '_under', 'a'.repeat(33), 'émile', 'semi;colon', '', '1-2'];
    const { stations, warnings } = parseStations([...bad.map((id) => ({ ...ok, id })), { ...ok, id: 'a'.repeat(32) }]);
    assert.deepEqual(stations.map((s) => s.id), ['a'.repeat(32)]);
    assert.equal(warnings.length, bad.length);
    assert.match(warnings[0], /^station 1 has id "Bad Id!", but ids are 1-32 of a-z, 0-9, - and _.*; skipped$/);
    assert.match(warnings[6], /^station 7 has no id; skipped$/);
  });

  it('refuses purely numeric ids, which would clash with /play <number>', () => {
    const { stations, warnings } = parseStations([{ ...ok, id: '123' }, { ...ok, id: 7 }, { ...ok, id: '3fm' }]);
    assert.deepEqual(stations.map((s) => s.id), ['3fm']);
    assert.equal(warnings.length, 2);
    for (const w of warnings) assert.match(w, /needs a letter/);
    assert.match(warnings[1], /^station 2 has id "7"/);
  });

  it('skips stations whose url is not http(s)', () => {
    const urls = ['ftp://example.com/x', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url', '', 42, undefined];
    const { stations, warnings } = parseStations(urls.map((url, i) => ({ ...ok, id: `s${i}`, url })));
    assert.deepEqual(stations, []);
    assert.equal(warnings.length, urls.length);
    assert.equal(warnings[0], 'station "s0": url "ftp://example.com/x" isn\'t an http(s) link; skipped');
    assert.match(warnings[6], /url undefined isn't an http\(s\) link/);
  });

  it('drops a homepage that is not https, keeping the station', () => {
    const pages = ['http://example.com/', 'javascript:alert(1)', 'nope', 7];
    const { stations, warnings } = parseStations(pages.map((homepage, i) => ({ ...ok, id: `s${i}`, homepage })));
    assert.equal(stations.length, pages.length);
    assert.ok(stations.every((s) => s.homepage === null));
    assert.equal(warnings[0], 'station "s0": homepage "http://example.com/" isn\'t an https link; left out');
    assert.equal(warnings.length, pages.length);
    // Absent or empty is fine and silent.
    assert.deepEqual(parseStations([{ ...ok, homepage: '' }, { ...ok, id: 'x', homepage: null }]).warnings, []);
  });

  it('keeps the first of two stations with the same id', () => {
    const { stations, warnings } = parseStations([ok, { ...ok, id: 'JAZZ', name: 'Second' }, { ...ok, id: 'other' }]);
    assert.deepEqual(stations.map((s) => [s.id, s.name]), [['jazz', 'Jazz FM'], ['other', 'Jazz FM']]);
    assert.deepEqual(warnings, ['station 2 has id "jazz", which is already taken; skipped']);
  });

  it('lets a later entry take an id whose first entry was skipped', () => {
    const { stations, warnings } = parseStations([{ ...ok, url: 'ftp://x' }, ok]);
    assert.deepEqual(stations.map((s) => s.id), ['jazz']);
    assert.equal(warnings.length, 1);
  });

  it('falls back to the id for a missing name and ignores a description that is not text', () => {
    const { stations, warnings } = parseStations([{ id: 'jazz', url: ok.url, description: 5 }]);
    assert.deepEqual(stations, [{ id: 'jazz', name: 'jazz', url: ok.url, description: null, homepage: null }]);
    assert.deepEqual(warnings, ['station "jazz" has no name; using its id',
      'station "jazz": description isn\'t text; left out']);
  });

  it('skips entries that are not objects', () => {
    const { stations, warnings } = parseStations([null, 'jazz', ['x'], 3, ok]);
    assert.equal(stations.length, 1);
    assert.deepEqual(warnings, [1, 2, 3, 4].map((n) => `station ${n} isn't an object; skipped`));
  });

  it('wants an array (or { stations: [...] })', () => {
    for (const data of [null, undefined, {}, 'x', 5, { stations: 'x' }]) {
      const res = parseStations(data);
      assert.deepEqual(res.stations, []);
      assert.equal(res.warnings.length, 1);
      assert.match(res.warnings[0], /must be a JSON array/);
    }
    assert.deepEqual(parseStations({ stations: [ok] }).stations.map((s) => s.id), ['jazz']);
    assert.deepEqual(parseStations([]), { stations: [], warnings: [] });
  });
});

describe('loadStations', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dls-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };

  it('reads a file, prefixing entry warnings with its name', async () => {
    const file = write('mine.json', JSON.stringify([{ id: 'ok', name: 'OK', url: 'https://x/' },
      { id: '1', url: 'https://x/' }]));
    const { stations, warnings } = await loadStations(file);
    assert.deepEqual(stations.map((s) => s.id), ['ok']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^mine\.json: station 2 has id "1"/);
  });

  it('copes with a byte order mark', async () => {
    const file = write('bom.json', `${String.fromCodePoint(0xfeff)}[{"id":"ok","name":"OK","url":"https://x/"}]`);
    assert.deepEqual(await loadStations(file), {
      stations: [{ id: 'ok', name: 'OK', url: 'https://x/', description: null, homepage: null }], warnings: [],
    });
  });

  it('warns about a missing file, broken JSON or a folder, and never throws', async () => {
    const missing = await loadStations(path.join(dir, 'nope.json'));
    assert.deepEqual(missing.stations, []);
    assert.equal(missing.warnings.length, 1);
    assert.match(missing.warnings[0], /nope\.json not found; no radio stations$/);

    const broken = await loadStations(write('broken.json', '[{"id": "x",'));
    assert.deepEqual(broken.stations, []);
    assert.match(broken.warnings[0], /broken\.json isn't valid JSON \(.+\); no radio stations$/);

    for (const text of ['', '{}', '"just a string"']) {
      const res = await loadStations(write('odd.json', text));
      assert.deepEqual(res.stations, []);
      assert.equal(res.warnings.length, 1, JSON.stringify(text));
    }

    const folder = await loadStations(dir);
    assert.deepEqual(folder.stations, []);
    assert.match(folder.warnings[0], /^Can't read the stations file/);
  });

  it('treats no file as no stations, quietly', async () => {
    for (const v of [null, undefined, '']) assert.deepEqual(await loadStations(v), { stations: [], warnings: [] });
    assert.equal((await loadStations(42)).warnings.length, 1);
  });
});

describe('config/stations.json (shipped)', () => {
  it('parses with zero warnings and holds exactly the specified stations, in order', async () => {
    const { stations, warnings } = await loadStations(SHIPPED);
    assert.deepEqual(warnings, []);
    assert.deepEqual(stations.map((s) => [s.id, s.name, s.url, s.homepage]), TABLE);
  });

  it('gives every station a short description and https links', async () => {
    const raw = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
    assert.ok(Array.isArray(raw), 'a JSON array');
    for (const s of raw) {
      assert.deepEqual(Object.keys(s).sort(), ['description', 'homepage', 'id', 'name', 'url']);
      assert.equal(typeof s.description, 'string');
      assert.ok(s.description.length > 0 && s.description.length <= 60, s.id);
      assert.ok(s.url.startsWith('https://') && s.homepage.startsWith('https://'), s.id);
    }
  });
});

describe('fileTrack, stationTrack, urlTrack', () => {
  const nulls = { artist: null, duration: null, fileName: null, stationId: null, description: null, url: null,
    requestedBy: null };

  it('fileTrack: a local, non-live file track', () => {
    assert.deepEqual(fileTrack(local('My_Song.mp3')), {
      ...nulls, kind: 'file', live: false, title: 'My Song', input: path.join(MUSIC, 'My_Song.mp3'), source: 'local',
      fileName: 'My_Song.mp3',
    });
    // An entry without a usable title gets one from its file name.
    assert.equal(fileTrack({ ...local('a_b.mp3'), title: '  ' }).title, 'a b');
    assert.equal(fileTrack({ fileName: 'x.mp3', path: path.join(MUSIC, 'x.mp3') }).title, 'x');
  });

  it('fileTrack: refuses an entry without a file name or an absolute path', () => {
    for (const bad of [null, {}, { fileName: 'x.mp3' }, { fileName: 'x.mp3', path: 'music/x.mp3' },
      { fileName: '', path: MUSIC }]) {
      assert.throws(() => fileTrack(bad), TypeError);
    }
  });

  it('stationTrack: a live stream whose embed link is the https homepage', () => {
    const fip = STATIONS.find((s) => s.id === 'fip');
    assert.deepEqual(stationTrack(fip), {
      ...nulls, kind: 'stream', live: true, title: 'FIP', input: 'https://icecast.radiofrance.fr/fip-midfi.mp3',
      source: 'station', stationId: 'fip', description: 'Eclectic sounds from Paris',
      url: 'https://www.radiofrance.fr/fip',
    });
    const raw = { id: 'x', name: '', url: 'http://example.com/live', homepage: 'http://example.com/' };
    assert.deepEqual(stationTrack(raw), {
      ...nulls, kind: 'stream', live: true, title: 'x', input: 'http://example.com/live', source: 'station',
      stationId: 'x',
    });
    for (const bad of [null, {}, { id: 'x' }, { id: 'x', url: 'ftp://x' }, { url: 'https://x' }]) {
      assert.throws(() => stationTrack(bad), TypeError);
    }
  });

  it('urlTrack: titled host + decoded path, never the query string or credentials', () => {
    const track = urlTrack('https://user:secret@Example.com:8000/my%20radio/live.mp3?token=SECRET#frag');
    assert.deepEqual(track, {
      ...nulls, kind: 'stream', live: true, title: 'example.com:8000/my radio/live.mp3',
      input: 'https://user:secret@example.com:8000/my%20radio/live.mp3?token=SECRET', source: 'url',
    });
    assert.equal(urlTrack('https://example.com/').title, 'example.com');
    assert.equal(urlTrack(new URL('http://example.com/a')).input, 'http://example.com/a');
    assert.equal(urlTrack('https://example.com/100%').title, 'example.com/100%', 'a stray % is shown as is');
    assert.equal(urlTrack('https://example.com/a%0Ab').title, 'example.com/a b', 'no line breaks in a title');
  });

  it('urlTrack: cuts a long title to 80 characters', () => {
    const { title } = urlTrack(`https://example.com/${'a'.repeat(200)}`);
    assert.equal(title.length, 80);
    assert.ok(title.startsWith('example.com/aaa') && title.endsWith('…'));
  });

  it('urlTrack: refuses anything but http(s)', () => {
    for (const bad of ['ftp://x', 'javascript:alert(1)', 'nope', '', null]) {
      assert.throws(() => urlTrack(bad), TypeError);
    }
  });
});

describe('resolveQuery', () => {
  describe('1. blank queries', () => {
    it('says what it can play', () => {
      for (const q of ['', '   ', `${TAB}${NEWLINE}`, '""', "''", '<>', '“ ”', '``', null, undefined, {}, NaN]) {
        const res = refused(resolve(q), 'empty');
        assert.match(res.message, /\/tracks/);
        assert.match(res.message, /link/);
        assert.equal(res.candidates, undefined);
      }
      assert.doesNotMatch(refused(resolve('', { allowUrls: false }), 'empty').message, /link/);
    });

    it('takes off one pair of <> or quotes', () => {
      for (const q of ['"fip"', '<fip>', '“fip”', "'fip'", '`fip`', '«fip»', '" fip "']) {
        assert.equal(picked(resolve(q), 'station').stationId, 'fip', q);
      }
      // Only one pair: what's left of <<…>> isn't a link any more.
      assert.equal(resolve('<<https://example.com/live>>').ok, false);
    });

    it('takes a number as a track number', () => {
      assert.equal(picked(resolve(2), 'index').fileName, 'fip.mp3');
    });
  });

  describe('2. radio:<id> and station:<id>', () => {
    it('picks the station by id, in any case and spacing', () => {
      for (const q of ['radio:fip', 'station:fip', 'RADIO:FIP', 'Station : fip', 'radio: fip ']) {
        const track = picked(resolve(q), 'station');
        assert.equal(track.stationId, 'fip', q);
        assert.equal(track.source, 'station');
      }
    });

    it('only ever gives a station, even when a file would match', () => {
      const lists = { localTracks: listing('nope.mp3', 'radio.mp3') };
      const res = refused(resolve('radio:nope', lists), 'not_found');
      assert.equal(res.message, 'There\'s no station called “nope”. /tracks lists the tracks and stations.');
      assert.equal(picked(resolve('radio:fip', lists), 'station').stationId, 'fip');
    });

    it('also finds a station by name, or fuzzily among stations', () => {
      assert.equal(picked(resolve('radio:groove salad'), 'station').stationId, 'groovesalad');
      assert.equal(picked(resolve('station:KEXP 90.3 Seattle'), 'station').stationId, 'kexp');
      assert.equal(picked(resolve('radio:jazz'), 'fuzzy').stationId, 'fipjazz');
      const res = refused(resolve('radio:soma'), 'ambiguous');
      assert.deepEqual(res.candidates.map((c) => c.query), ['groovesalad', 'fluid', 'dronezone', 'defcon', 'lush']);
      assert.equal(refused(resolve('radio:groovesald'), 'not_found').candidates[0].query, 'groovesalad');
    });

    it('asks which station when the id is missing', () => {
      const res = refused(resolve('radio:'), 'empty');
      assert.match(res.message, /Which station/);
      assert.equal(res.candidates.length, 5);
      assert.deepEqual(res.candidates[0], { label: 'SomaFM · Groove Salad', query: 'groovesalad' });
    });

    it('says so when there are no stations', () => {
      const res = refused(resolve('radio:fip', { stations: [] }), 'not_found');
      assert.match(res.message, /no radio stations/);
    });
  });

  describe('3. links', () => {
    it('plays an http(s) link as a live stream', () => {
      const track = picked(resolve('https://example.com/live.mp3'), 'url');
      assert.deepEqual([track.kind, track.live, track.source, track.input, track.title],
        ['stream', true, 'url', 'https://example.com/live.mp3', 'example.com/live.mp3']);
      assert.equal(picked(resolve('HTTP://Example.COM:8000/Live'), 'url').input, 'http://example.com:8000/Live');
    });

    it('unwraps <https://…>', () => {
      assert.equal(picked(resolve('<https://example.com/live>'), 'url').input, 'https://example.com/live');
    });

    it('refuses every other kind of link', () => {
      for (const q of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x', 'data:text/plain,x', 'ws://x/y',
        'mailto:a@b.c', 'concat:/etc/passwd|x.mp3', 'http://', 'https://exa mple.com', 'https:exa mple']) {
        const res = refused(resolve(q), 'bad_url');
        assert.equal(res.message, 'I can only play http:// and https:// links.', q);
      }
    });

    it("refuses links into the bot's own computer or network, however the address is written", () => {
      const inside = ['http://127.0.0.1:8080/admin', 'http://localhost/', 'http://LOCALHOST.:1/', 'http://a.localhost/',
        'http://printer.local/live', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.1/', 'http://127.1/',
        'http://0.0.0.0/', 'http://0/', 'http://[::1]/', 'http://[::0.0.0.1]/', 'http://[::ffff:127.0.0.1]/',
        'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://169.254.169.254/latest/meta-data/',
        'http://[::ffff:169.254.169.254]/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://172.31.255.255/',
        'http://192.168.1.1/', 'http://100.64.0.1/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://224.0.0.1/',
        'http://[64:ff9b::7f00:1]/', 'https://user:pw@10.1.2.3:8443/x'];
      for (const q of inside) {
        const res = refused(resolve(q), 'bad_url');
        assert.equal(res.message,
          "I don't play links to the computer I run on or to its local network, only public streams.", q);
      }
      // Public addresses and names are fine, also ones that only look local.
      for (const q of ['http://8.8.8.8/live', 'http://[2606:4700::1111]/', 'http://172.32.0.1/', 'http://192.169.0.1/',
        'http://100.128.0.1/', 'http://localhost.example.com/', 'https://local.example/x',
        'https://ice2.somafm.com/groovesalad-128-mp3']) {
        assert.equal(picked(resolve(q), 'url').input, new URL(q).href, q);
      }
      // Stations are the owner's choice: one on the local network (a home Icecast) still plays.
      const home = parseStations([{ id: 'home', name: 'Home', url: 'http://192.168.1.10:8000/live' }]).stations;
      assert.equal(picked(resolve('home', { stations: home }), 'station').input, 'http://192.168.1.10:8000/live');
    });

    it('turns links off when allowUrls is false', () => {
      const res = refused(resolve('https://example.com/live', { allowUrls: false }), 'urls_disabled');
      assert.match(res.message, /turned off/);
      // A link that's no good either way is still a bad link.
      assert.match(refused(resolve('ftp://x', { allowUrls: false }), 'bad_url').message, /turned off/);
    });

    it('explains that YouTube, Spotify and friends are web pages, not audio', () => {
      const pages = [['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'YouTube'],
        ['https://youtu.be/dQw4w9WgXcQ', 'YouTube'],
        ['https://music.youtube.com/watch?v=x', 'YouTube'], ['https://open.spotify.com/track/x', 'Spotify'],
        ['spotify:track:4uLU6hMCjMI75M1A2tKUQC', 'Spotify'], ['https://soundcloud.com/a/b', 'SoundCloud'],
        ['https://music.apple.com/us/album/x', 'Apple Music'], ['https://artist.bandcamp.com/track/x', 'Bandcamp'],
        ['https://www.twitch.tv/x', 'Twitch'], ['https://YOUTUBE.COM./x', 'YouTube']];
      for (const [q, service] of pages) {
        assert.match(refused(resolve(q), 'bad_url').message, new RegExp(`^I can't play ${service} links`), q);
        assert.match(refused(resolve(q, { allowUrls: false }), 'bad_url').message, new RegExp(service), q);
      }
      // Look-alikes are just other sites.
      for (const q of ['https://notyoutube.com/live', 'https://youtube.com.example.org/live',
        'https://example.com/youtube.com']) {
        assert.equal(picked(resolve(q), 'url').input, q);
      }
    });
  });

  describe('4/5. station ids before file names and titles', () => {
    it('a station id wins over a file with that title; the file name still picks the file', () => {
      assert.equal(picked(resolve('fip'), 'station').stationId, 'fip');
      assert.equal(picked(resolve('FIP'), 'station').stationId, 'fip');
      assert.equal(picked(resolve('fip.mp3'), 'file').fileName, 'fip.mp3');
    });

    it('a file name matches in any case and Unicode form', () => {
      assert.equal(picked(resolve('BEYONCÉ - HALO.MP3'), 'file').fileName, 'Beyoncé - Halo.mp3');
      const nfd = listing(`Beyonce${ACUTE}.mp3`);
      assert.equal(picked(resolve('Beyoncé.mp3', { localTracks: nfd }), 'file').fileName, `Beyonce${ACUTE}.mp3`);
      assert.equal(picked(resolve(`Beyonce${ACUTE} - Halo.mp3`), 'file').fileName, 'Beyoncé - Halo.mp3');
    });

    it('the exact case wins when a case-sensitive disk holds both Song.mp3 and song.mp3', () => {
      const lists = { localTracks: listing('Song.mp3', 'song.mp3') };
      assert.equal(picked(resolve('song.mp3', lists), 'file').input, path.join(MUSIC, 'song.mp3'));
      assert.equal(picked(resolve('Song.mp3', lists), 'file').input, path.join(MUSIC, 'Song.mp3'));
      const res = refused(resolve('SONG.MP3', lists), 'ambiguous');
      assert.deepEqual(res.candidates, [{ label: 'Song.mp3', query: '1' }, { label: 'song.mp3', query: '2' }]);
    });

    it('a title matches after normalizing (case, accents, _ and -)', () => {
      assert.equal(picked(resolve('beyonce halo'), 'file').fileName, 'Beyoncé - Halo.mp3');
      for (const q of ['my song remix', 'MY SONG REMIX', 'my-song_remix', 'My Song-Remix!']) {
        assert.equal(picked(resolve(q), 'file').fileName, 'my_song-remix.ogg', q);
      }
      assert.equal(picked(resolve('track 2'), 'file').fileName, 'Track 2.mp3');
    });

    it('two files with the same title are ambiguous, shown by file name', () => {
      const res = refused(resolve('song'), 'ambiguous');
      assert.equal(res.message, '2 tracks match “song”. Which one did you mean?');
      assert.deepEqual(res.candidates, [{ label: 'Song.mp3', query: '6' }, { label: 'song.flac', query: '7' }]);
    });
  });

  describe('6. track numbers', () => {
    it('a bare number is always a track number, even when a file is called 7.mp3', () => {
      assert.equal(picked(resolve('7'), 'index').fileName, 'song.flac');
      assert.equal(picked(resolve('7.mp3'), 'file').fileName, '7.mp3');
      assert.equal(picked(resolve('#2'), 'index').fileName, 'fip.mp3');
      assert.equal(picked(resolve('007'), 'index').fileName, 'song.flac');
      assert.equal(picked(resolve('2'), 'index').fileName, 'fip.mp3', 'not "Track 2"');
      assert.equal(picked(resolve('#8'), 'index').fileName, 'Track 2.mp3');
    });

    it('says how many tracks there are when the number is out of range', () => {
      for (const q of ['0', '9', '#99', '00', '99999999999999999999']) {
        const res = refused(resolve(q), 'bad_index');
        assert.match(res.message, /The library has 8 tracks \(#1 to #8\)/, q);
      }
      assert.match(refused(resolve('#0'), 'bad_index').message, /^There's no track #0\./);
      assert.match(refused(resolve('2', { localTracks: listing('only.mp3') }), 'bad_index').message,
        /The library has 1 track \(#1\)/);
      assert.match(refused(resolve('1', { localTracks: [] }), 'bad_index').message, /The music library is empty/);
    });
  });

  describe('7. station names', () => {
    it('match after normalizing, or as an id with spaces', () => {
      assert.equal(picked(resolve('kexp 90.3 seattle'), 'station').stationId, 'kexp');
      assert.equal(picked(resolve('NPO Radio 2'), 'station').stationId, 'npo2');
      assert.equal(picked(resolve('groove salad'), 'station').stationId, 'groovesalad');
      assert.equal(picked(resolve('radio paradise'), 'station').stationId, 'radioparadise');
      assert.equal(picked(resolve('FIP-Jazz'), 'station').stationId, 'fipjazz');
    });

    it('come after file titles', () => {
      const lists = { localTracks: listing('NPO Radio 2.mp3') };
      assert.equal(picked(resolve('npo radio 2', lists), 'file').fileName, 'NPO Radio 2.mp3');
    });
  });

  describe('8. fuzzy matching', () => {
    const fuzzy = (q, ...files) => resolve(q, { localTracks: listing(...files), stations: [] });

    it('finds by the start of a title, without accents', () => {
      assert.equal(picked(resolve('beyonce'), 'fuzzy').fileName, 'Beyoncé - Halo.mp3');
      assert.equal(picked(resolve('BEYONC'), 'fuzzy').fileName, 'Beyoncé - Halo.mp3');
    });

    it('ranks equal > starts with > word starts > contains', () => {
      // 100 (the file name, as words) beats 80 (a title starting with it)
      assert.equal(picked(fuzzy('blue mp3', 'blue mp3 remix.mp3', 'blue.mp3'), 'fuzzy').fileName, 'blue.mp3');
      // 80 beats 60: "Halo Theme" starts with halo, "Beyoncé - Halo" only has a word that does
      assert.equal(picked(resolve('halo'), 'fuzzy').fileName, 'Halo Theme.flac');
      // 60 beats 40: every word starts a word of "Monday Blues"; "Lemon Blueberry" merely contains the text
      assert.equal(picked(fuzzy('mon blue', 'Lemon Blueberry.mp3', 'Monday Blues.mp3'), 'fuzzy').fileName,
        'Monday Blues.mp3');
      // 40 on its own is enough
      assert.equal(picked(fuzzy('emon blue', 'Lemon Blueberry.mp3', 'Monday Blues.mp3'), 'fuzzy').fileName,
        'Lemon Blueberry.mp3');
    });

    it('a tie at the top is ambiguous, with at most 5 candidates', () => {
      const res = refused(fuzzy('blue mo', 'Blue Monday.mp3', 'Blue Moon.mp3', 'Moody Blue.mp3'), 'ambiguous');
      assert.deepEqual(res.candidates, [{ label: 'Blue Monday', query: '1' }, { label: 'Blue Moon', query: '2' }]);

      const many = refused(fuzzy('son', ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Song ${n}.mp3`)), 'ambiguous');
      assert.equal(many.message, '8 tracks match “son”. Be more specific, or pick one of these:');
      assert.deepEqual(many.candidates.map((c) => c.query), ['1', '2', '3', '4', '5']);
      assert.deepEqual(many.candidates.map((c) => c.label), ['Song 1', 'Song 2', 'Song 3', 'Song 4', 'Song 5']);
    });

    it('mixes tracks and stations', () => {
      assert.equal(picked(resolve('drone'), 'fuzzy').stationId, 'dronezone');
      const res = refused(resolve('paradise mix', { localTracks: listing('My Paradise Mix.mp3') }), 'ambiguous');
      assert.equal(res.message, '3 tracks and stations match “paradise mix”. Which one did you mean?');
      assert.deepEqual(res.candidates, [{ label: 'My Paradise Mix', query: '1' },
        { label: 'Radio Paradise · Main Mix', query: 'radioparadise' },
        { label: 'Radio Paradise · Mellow Mix', query: 'mellow' }]);
    });

    it('every candidate query picks exactly that candidate', () => {
      for (const q of ['song', 'paradise', 'somafm', 'radio:soma']) {
        for (const c of refused(resolve(q), 'ambiguous').candidates) {
          const again = resolve(c.query);
          assert.equal(again.ok, true, `${q} → ${c.query}`);
          const t = again.track;
          assert.equal(t.stationId ?? String(BASE.findIndex((l) => l.path === t.input) + 1), c.query);
        }
      }
    });

    it('nothing at all is not_found, with near misses as suggestions', () => {
      const none = refused(resolve('zzzz'), 'not_found');
      assert.equal(none.message, 'Nothing matches “zzzz”. /tracks lists the tracks and stations.');
      assert.equal(none.candidates, undefined);

      for (const q of ['groovesald', 'grove salad', 'Groove Slad']) {
        const res = refused(resolve(q), 'not_found');
        assert.match(res.message, /Did you mean one of these\?$/);
        assert.deepEqual(res.candidates, [{ label: 'SomaFM · Groove Salad', query: 'groovesalad' }], q);
      }
      assert.deepEqual(refused(resolve('beyonse'), 'not_found').candidates, [{ label: 'Beyoncé - Halo', query: '1' }]);
      // Longer queries may be two typos off.
      assert.deepEqual(refused(resolve('beyonse hallo'), 'not_found').candidates,
        [{ label: 'Beyoncé - Halo', query: '1' }]);
      // Letters left out count as typos too.
      assert.deepEqual(refused(resolve('beynce'), 'not_found').candidates, [{ label: 'Beyoncé - Halo', query: '1' }]);
      assert.deepEqual(refused(resolve('grvesalad'), 'not_found').candidates.map((c) => c.query), ['groovesalad']);
      // A typo in any word of a title counts, closest and then library order first.
      assert.deepEqual(refused(resolve('hallo'), 'not_found').candidates,
        [{ label: 'Beyoncé - Halo', query: '1' }, { label: 'Halo Theme', query: '4' }]);
      assert.deepEqual(refused(resolve('radioparadice'), 'not_found').candidates.map((c) => c.query),
        ['radioparadise', 'mellow']);
      const closest = refused(fuzzy('blue mooon', 'Blue Mood.mp3', 'Blue Moon.mp3', 'Red Moon.mp3'), 'not_found');
      assert.deepEqual(closest.candidates.map((c) => c.label), ['Blue Moon', 'Blue Mood'], 'one typo before two');
      // Short queries get no guesses: everything is a typo or two away from them.
      assert.equal(refused(resolve('qqq'), 'not_found').candidates, undefined);
    });

    it('a query with no letters or digits finds nothing', () => {
      for (const q of ['???', '...', '—']) refused(resolve(q), 'not_found');
    });

    it("can't be made slow: a search over 200 characters isn't fuzzy-matched", () => {
      // Fuzzy work is about query words × library size, on the thread that feeds every server's audio: 2000 words
      // over 5000 files took ~0.5 s before (LiveKit holds 0.2 s of audio). The fuzzy pass would match every file
      // here (each word starts "alpha"), so not_found without candidates shows it was skipped.
      const big = Array.from({ length: 5000 }, (_, i) => local(`alpha beta gamma ${i}.mp3`));
      const long = refused(resolveQuery('a '.repeat(2000), { localTracks: big }), 'not_found');
      assert.equal(long.candidates, undefined);
      assert.equal(refused(resolveQuery(`radio:${'a '.repeat(150)}`), 'not_found').candidates, undefined);
      // Up to the limit it searches as before; a word said many times counts once.
      assert.deepEqual(refused(resolveQuery('alp '.repeat(45), { localTracks: big }), 'ambiguous').candidates,
        refused(resolveQuery('alp', { localTracks: big }), 'ambiguous').candidates);
      // A long exact title still plays: only the fuzzy step is skipped.
      const title = `${'Very Long Title '.repeat(15)}End`;
      assert.equal(picked(resolveQuery(title, { localTracks: listing(`${title}.mp3`) }), 'file').title, title);
    });
  });

  describe('safety', () => {
    it('never yields a file outside the listing, whatever the path tricks', () => {
      const lists = { localTracks: listing('passwd.mp3', 'env.mp3', 'x.mp3', 'fip.mp3') };
      const inListing = new Set(lists.localTracks.map((l) => l.path));
      for (const q of ['../../etc/passwd', '/etc/passwd', '..\\..\\x', 'music/../.env', '%2e%2e%2f', '..', '.', '.env',
        '../fip.mp3', '/music/../etc/passwd', '~/.ssh/id_rsa', 'C:\\Windows\\win.ini', '\\\\server\\share\\x.mp3',
        `x.mp3${String.fromCodePoint(0)}.txt`, 'file:///etc/passwd', 'file:x.mp3', '/music/x.mp3']) {
        const res = resolve(q, lists);
        if (!res.ok) continue;
        if (res.track.kind === 'file') assert.ok(inListing.has(res.track.input), `${q} → ${res.track.input}`);
        else assert.ok(res.track.source === 'station', `${q} → ${res.track.input}`);
      }
    });

    it('never echoes mentions, markdown or links back into chat', () => {
      const tricks = ['@everyone', 'hey @everyone', '<@123456789>', 'hi <@123456789>', '**bold** _it_',
        '[click](https://evil.example)', 'evil.example', '`code` here', '||spoiler||', '# heading', 'x'.repeat(200),
        '<#987654321>', 'a\\*b'];
      for (const q of tricks) {
        const { message } = resolve(q);
        assert.doesNotMatch(message, /@|\*|\]\(|evil\.example|`code|\|\||# heading|x{41}|<#|\\/, q);
      }
      assert.match(resolve('radio:@everyone').message, /no station called that\./);
      assert.match(resolve('zzzz').message, /“zzzz”/);
      assert.match(resolve('Mr. Nobody').message, /“Mr\. Nobody”/);
    });

    it('is pure: frozen inputs, same answer twice, a new Track every time', () => {
      const lists = deepFreeze({ localTracks: BASE.map((l) => ({ ...l })), stations: STATIONS.map((s) => ({ ...s })) });
      for (const q of ['fip', 'radio:fip', 'https://example.com/x', '7', 'song', 'beyonce', 'zzzz', 'groovesald', '']) {
        const a = resolveQuery(q, lists);
        const b = resolveQuery(q, lists);
        assert.deepEqual(a, b, q);
        if (a.ok) assert.notEqual(a.track, b.track, q);
      }
    });

    it('skips listing entries and stations that make no sense, keeping track numbers', () => {
      const localTracks = [null, { fileName: 'rel.mp3', path: 'music/rel.mp3' }, local('real.mp3'), 'x'];
      const stations = [null, { id: 'bad', url: 'ftp://x' }, { id: 'good', name: 'Good', url: 'https://x/' }];
      assert.equal(picked(resolveQuery('3', { localTracks, stations }), 'index').fileName, 'real.mp3');
      refused(resolveQuery('2', { localTracks, stations }), 'bad_index');
      refused(resolveQuery('rel', { localTracks, stations }), 'not_found');
      assert.equal(picked(resolveQuery('good', { localTracks, stations }), 'station').stationId, 'good');
      refused(resolveQuery('bad', { localTracks, stations }), 'not_found');
      for (const lists of [undefined, {}, { localTracks: 'x', stations: 5 }]) {
        refused(resolveQuery('x', lists), 'not_found');
      }
    });
  });
});

describe('TrackLibrary', () => {
  let dir;
  let n = 0;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dls-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  /** A fresh music folder holding `files`. */
  const folder = (...files) => {
    const d = path.join(dir, `music${++n}`);
    fs.mkdirSync(d);
    for (const f of files) fs.writeFileSync(path.join(d, f), 'not really audio');
    return d;
  };
  /** A probe that records its calls and answers with answer(file, callNumber). */
  const fakeProbe = (answer = () => ({ duration: 12.5, title: null, artist: null })) => {
    const calls = [];
    return { calls, probe: async (file) => { calls.push(file); return answer(file, calls.length); } };
  };
  /** The file track a query resolves to (by name, title or number). */
  const trackIn = async (lib, query) => {
    const res = await lib.resolve(query);
    assert.equal(res.ok, true, `${query}: ${res.message}`);
    assert.equal(res.track.kind, 'file');
    return res.track;
  };

  it('checks its options', () => {
    assert.throws(() => new TrackLibrary({ probe: 'ffprobe' }), TypeError);
    assert.throws(() => new TrackLibrary({ now: 5 }), TypeError);
    for (const cacheMs of [-1, NaN, '3000']) assert.throws(() => new TrackLibrary({ cacheMs }), RangeError);
    const lib = new TrackLibrary({ musicDir: 'relative/music' });
    assert.equal(lib.musicDir, path.resolve('relative/music'));
    assert.equal(lib.allowUrls, true);
    assert.equal(new TrackLibrary().musicDir, null);
  });

  describe('init', () => {
    it('loads the shipped stations quietly; `stations` is a copy', async () => {
      const lib = new TrackLibrary({ musicDir: folder(), stationsFile: SHIPPED });
      assert.deepEqual(lib.stations, []);
      assert.deepEqual(await lib.init(), []);
      assert.deepEqual(lib.stations.map((s) => s.id), TABLE.map((row) => row[0]));
      lib.stations.length = 0;
      assert.equal(lib.stations.length, 12);
      assert.equal(picked(await lib.resolve('groove salad'), 'station').stationId, 'groovesalad');
    });

    it('warns about a missing stations file and a missing music folder', async () => {
      const lib = new TrackLibrary({ musicDir: path.join(dir, 'no-music'), stationsFile: path.join(dir, 'no.json') });
      const warnings = await lib.init();
      assert.equal(warnings.length, 2);
      assert.match(warnings[0], /no\.json not found/);
      assert.match(warnings[1], /^Music folder .*no-music doesn't exist: create it/);
      assert.deepEqual(lib.stations, []);
      assert.deepEqual(await lib.localTracks(), []);
    });

    it('warns when the music folder is a file', async () => {
      const file = path.join(folder('a.mp3'), 'a.mp3');
      const warnings = await new TrackLibrary({ musicDir: file }).init();
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /is a file, not a folder/);
    });

    it('stays quiet without a music folder or stations file', async () => {
      assert.deepEqual(await new TrackLibrary().init(), []);
    });

    it('reloads the stations when called again', async () => {
      const file = path.join(dir, 'reload.json');
      fs.writeFileSync(file, JSON.stringify([{ id: 'one', name: 'One', url: 'https://x/1' }]));
      const lib = new TrackLibrary({ stationsFile: file });
      await lib.init();
      fs.writeFileSync(file, JSON.stringify([{ id: 'two', name: 'Two', url: 'https://x/2' }]));
      await lib.init();
      assert.deepEqual(lib.stations.map((s) => s.id), ['two']);
    });
  });

  describe('localTracks', () => {
    it('reuses a listing for cacheMs, so new files show up soon without a restart', async () => {
      const d = folder('a.mp3');
      let t = 10_000;
      const lib = new TrackLibrary({ musicDir: d, now: () => t });
      assert.deepEqual(names(await lib.localTracks()), ['a.mp3']);
      fs.writeFileSync(path.join(d, 'b.mp3'), 'x');
      t += 2999;
      assert.deepEqual(names(await lib.localTracks()), ['a.mp3'], 'still the cached listing');
      refused(await lib.resolve('b'), 'not_found');
      t += 1;
      assert.deepEqual(names(await lib.localTracks()), ['a.mp3', 'b.mp3']);
      assert.equal((await trackIn(lib, 'b')).input, path.join(d, 'b.mp3'));
    });

    it('reads again when the clock goes back', async () => {
      const d = folder('a.mp3');
      let t = 10_000;
      const lib = new TrackLibrary({ musicDir: d, now: () => t });
      await lib.localTracks();
      fs.writeFileSync(path.join(d, 'b.mp3'), 'x');
      t = 5_000;
      assert.deepEqual(names(await lib.localTracks()), ['a.mp3', 'b.mp3']);
    });

    it('shares one read between calls at the same time, and hands out copies', async () => {
      const lib = new TrackLibrary({ musicDir: folder('a.mp3'), cacheMs: 0 });
      const [x, y] = await Promise.all([lib.localTracks(), lib.localTracks()]);
      assert.notEqual(x, y);
      assert.equal(x[0], y[0], 'the same listing');
      x.pop();
      const z = await lib.localTracks();
      assert.equal(z.length, 1, 'the copy was changed, not the library');
      assert.notEqual(z[0], x[0] ?? y[0], 'cacheMs 0: read again');
    });

    it('invalidate() forgets the listing', async () => {
      const d = folder('a.mp3');
      const lib = new TrackLibrary({ musicDir: d, cacheMs: Infinity });
      await lib.localTracks();
      fs.writeFileSync(path.join(d, 'b.mp3'), 'x');
      assert.equal((await lib.localTracks()).length, 1);
      lib.invalidate();
      assert.equal((await lib.localTracks()).length, 2);
    });
  });

  describe('resolve', () => {
    it('resolves against the folder, the stations and allowUrls', async () => {
      const d = folder('Track_One.mp3', 'two.flac');
      const lib = new TrackLibrary({ musicDir: d, stationsFile: SHIPPED, allowUrls: false });
      await lib.init();
      assert.equal(picked(await lib.resolve('2'), 'index').input, path.join(d, 'two.flac'));
      assert.equal(picked(await lib.resolve('track one'), 'file').title, 'Track One');
      assert.equal(picked(await lib.resolve('fip'), 'station').stationId, 'fip');
      refused(await lib.resolve('https://example.com/live'), 'urls_disabled');
      assert.equal(picked(await new TrackLibrary({ musicDir: d }).resolve('https://example.com/live'), 'url').source,
        'url');
    });

    it('never reaches outside the music folder', async () => {
      const d = folder('song.mp3');
      fs.writeFileSync(path.join(dir, 'secret.mp3'), 'x');
      fs.writeFileSync(path.join(dir, '.env'), 'YAPPER_BOT_TOKEN=nope');
      const lib = new TrackLibrary({ musicDir: d });
      const tricks = ['../secret.mp3', '../.env', path.join(dir, 'secret.mp3'), 'secret', '.env', '..', '../song.mp3'];
      for (const q of tricks) {
        const res = await lib.resolve(q);
        if (res.ok) assert.equal(path.dirname(res.track.input), d, `${q} → ${res.track.input}`);
      }
    });
  });

  describe('enrich', () => {
    it('adds the duration, keeps the file-name title without tags, and copies', async () => {
      const { calls, probe } = fakeProbe();
      const lib = new TrackLibrary({ musicDir: folder('My_Song.mp3'), probe });
      const track = await trackIn(lib, 'my song');
      const before = { ...track };
      const rich = await lib.enrich(track);
      assert.deepEqual(rich, { ...track, duration: 12.5 });
      assert.notEqual(rich, track);
      assert.deepEqual(track, before, 'the original is untouched');
      assert.deepEqual(calls, [track.input]);
    });

    it('uses the title tag and its artist when there is one', async () => {
      const { probe } = fakeProbe(() => ({ duration: 3, title: 'Halo', artist: 'Beyoncé' }));
      const lib = new TrackLibrary({ musicDir: folder('01 track.mp3'), probe });
      const rich = await lib.enrich(await trackIn(lib, '1'));
      assert.deepEqual([rich.title, rich.artist, rich.duration], ['Halo', 'Beyoncé', 3]);
      const { probe: titleOnly } = fakeProbe(() => ({ duration: 3, title: 'Halo', artist: null }));
      const lib2 = new TrackLibrary({ musicDir: folder('01 track.mp3'), probe: titleOnly });
      assert.equal((await lib2.enrich(await trackIn(lib2, '1'))).artist, null);
    });

    it('adds an artist tag alone only when the file name does not already say it', async () => {
      const { probe } = fakeProbe(() => ({ duration: null, title: null, artist: 'Beyoncé' }));
      const lib = new TrackLibrary({ musicDir: folder('Halo.mp3', 'Beyonce - Halo.flac'), probe });
      const halo = await lib.enrich(await trackIn(lib, 'halo.mp3'));
      assert.deepEqual([halo.title, halo.artist], ['Halo', 'Beyoncé']);
      const named = await lib.enrich(await trackIn(lib, 'beyonce - halo.flac'));
      assert.deepEqual([named.title, named.artist], ['Beyonce - Halo', null]);
    });

    it('probes once per file version: path + modification time + size', async () => {
      const { calls, probe } = fakeProbe();
      const d = folder('a.mp3', 'b.mp3');
      const file = path.join(d, 'a.mp3');
      fs.utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));
      const lib = new TrackLibrary({ musicDir: d, probe });
      const a = await trackIn(lib, 'a');
      await Promise.all([lib.enrich(a), lib.enrich(a), lib.enrich({ ...a })]);
      await lib.enrich(a);
      assert.equal(calls.length, 1, 'concurrent and repeated calls share one probe');
      await lib.enrich(await trackIn(lib, 'b'));
      assert.equal(calls.length, 2, 'another file is probed on its own');
      fs.utimesSync(file, new Date(2021, 0, 1), new Date(2021, 0, 1));
      await lib.enrich(a);
      assert.equal(calls.length, 3, 'a new modification time means a new probe');
      fs.appendFileSync(file, 'more');
      fs.utimesSync(file, new Date(2021, 0, 1), new Date(2021, 0, 1));
      await lib.enrich(a);
      assert.equal(calls.length, 4, 'so does a new size');
      await lib.enrich(a);
      assert.equal(calls.length, 4);
    });

    it('never throws: a probe that fails leaves the track as it is and is asked again next time', async () => {
      const { calls, probe } = fakeProbe((file, call) => {
        if (call === 1) throw new Error('ffprobe exploded');
        return { duration: 7, title: null, artist: null };
      });
      const lib = new TrackLibrary({ musicDir: folder('a.mp3'), probe });
      const track = await trackIn(lib, 'a');
      assert.equal(await lib.enrich(track), track);
      assert.equal((await lib.enrich(track)).duration, 7);
      assert.equal(calls.length, 2);
      const sync = new TrackLibrary({ musicDir: lib.musicDir, probe: () => { throw new Error('sync'); } });
      assert.equal(await sync.enrich(track), track);
    });

    it('cleans up odd probe answers', async () => {
      const answers = [undefined, null, 'junk', { duration: -1, title: '   ', artist: 5 }, { duration: NaN },
        { duration: Infinity, title: ['x'] }, { duration: '12', title: `Two${NEWLINE}Lines `, artist: ` A${TAB}B ` }];
      for (const answer of answers) {
        const lib = new TrackLibrary({ musicDir: folder('Plain_Name.mp3'), probe: async () => answer });
        const rich = await lib.enrich(await trackIn(lib, '1'));
        assert.equal(rich.duration, null, JSON.stringify(answer));
        if (answer?.title === `Two${NEWLINE}Lines `) assert.deepEqual([rich.title, rich.artist], ['Two Lines', 'A B']);
        else assert.deepEqual([rich.title, rich.artist], ['Plain Name', null], JSON.stringify(answer));
      }
    });

    it('returns streams, missing files, folders and non-tracks as they are, without probing', async () => {
      const { calls, probe } = fakeProbe();
      const d = folder('gone.mp3');
      const lib = new TrackLibrary({ musicDir: d, stationsFile: SHIPPED, probe });
      await lib.init();
      const station = picked(await lib.resolve('fip'), 'station');
      assert.equal(await lib.enrich(station), station);
      const link = picked(await lib.resolve('https://example.com/x'), 'url');
      assert.equal(await lib.enrich(link), link);
      const gone = await trackIn(lib, 'gone');
      fs.rmSync(gone.input);
      assert.equal(await lib.enrich(gone), gone);
      const folderTrack = { ...gone, input: d };
      assert.equal(await lib.enrich(folderTrack), folderTrack);
      for (const v of [null, undefined, 'x', 5, { kind: 'file' }, { kind: 'file', input: 42 }]) {
        assert.equal(await lib.enrich(v), v);
      }
      assert.deepEqual(calls, []);
    });

    it('defaults to ffprobe at ffprobePath: a missing one just means no details', async () => {
      const lib = new TrackLibrary({ musicDir: folder('Some_Song.mp3'), ffprobePath: path.join(dir, 'no-ffprobe') });
      const track = await trackIn(lib, '1');
      const rich = await lib.enrich(track);
      assert.deepEqual(rich, { ...track, duration: null });
    });

    it('reads duration and tags with the real ffprobe', { timeout: 20_000 }, async (t) => {
      if (!runs(FFMPEG) || !runs(FFPROBE)) return t.skip('ffmpeg/ffprobe not available');
      const d = folder();
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi',
        '-i', 'sine=frequency=440:duration=1', '-metadata', 'title=Test Tone', '-metadata', 'artist=DLS_bot',
        path.join(d, 'tagged_tone.flac')]);
      const lib = new TrackLibrary({ musicDir: d, ffprobePath: FFPROBE });
      const track = await trackIn(lib, 'tagged tone');
      const rich = await lib.enrich(track);
      assert.deepEqual([rich.title, rich.artist], ['Test Tone', 'DLS_bot']);
      assert.ok(Math.abs(rich.duration - 1) < 0.05, `duration ${rich.duration}`);
      // The same file through a missing ffprobe: proves ffprobePath is what the default probe runs.
      const blind = new TrackLibrary({ musicDir: d, ffprobePath: path.join(dir, 'no-ffprobe') });
      assert.deepEqual(await blind.enrich(track), { ...track, duration: null });
    });
  });
});
