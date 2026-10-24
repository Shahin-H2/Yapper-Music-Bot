# DLS_bot

**A music bot for [Yapin’](https://www.yapin.gg) voice channels:** your own audio files and internet radio, a live
Now Playing card with buttons, a queue per server, and audio that reaches the call end-to-end encrypted.

![Node.js ≥ 20.6](https://img.shields.io/badge/node-%E2%89%A5%2020.6-339933?logo=nodedotjs&logoColor=white)
![License: ISC](https://img.shields.io/badge/license-ISC-blue)
![Dependencies: 1](https://img.shields.io/badge/dependencies-1-informational)

DLS_bot joins your voice channel and plays the files in `./music`, twelve radio presets or any direct http(s) stream.
Everything is driven from chat: `/play` understands track numbers, file names, fuzzy titles and station names, and
the Now Playing card carries buttons for pause, skip, stop, loop and volume. Under the hood ffmpeg decodes to raw PCM,
which is cut into 10 ms frames, volume-ramped and fed to LiveKit through a 200 ms queue, so pause, skip and volume
land almost instantly. It is plain Node.js (ESM + JSDoc, no build step) on the single-file `yapper.js` SDK, with one
npm dependency and an offline, deterministic test suite.

[Features](#features) · [Quick start](#quick-start) · [Commands](#commands) · [Now Playing card](#now-playing-card) ·
[Radio stations](#radio-stations) · [Configuration](#configuration) · [How it works](#how-it-works) ·
[Project structure](#project-structure) · [Testing](#testing) · [Troubleshooting](#troubleshooting) ·
[Security](#security) · [License](#license)

## Features

- **Local library**: drop `.mp3` `.wav` `.flac` `.ogg` `.opus` `.m4a` files into `./music` (sub-folders aren't
  scanned). They show up within seconds without a restart, and title/artist tags are used when a file has them.
- **Internet radio**: 12 presets (SomaFM, Radio Paradise, KEXP, FIP, NPO), your own in `config/stations.json`, or
  any direct http(s) stream link.
- **Smart `/play`**: a track number, a file name, a station id or name, or a fuzzy search that ignores case and
  accents. If a search is ambiguous it asks which one you meant, and it suggests near misses for typos.
- **Now Playing card**: shows progress, who requested the track, volume, loop mode and what's next, with ⏯ ⏭ ⏹ 🔁 🔉 🔊
  buttons. It updates in place, and older cards lose their buttons.
- **A real queue**: one per server, up to 100 tracks, with shuffle, remove, clear, loop off/track/queue and a
  "starts in ~m:ss" estimate.
- **Snappy, click-free controls**: pause, skip and volume are heard within about 200 ms. Volume (1–200 %) ramps
  across one 10 ms frame, so changing it never clicks.
- **Pause done right**: a file resumes on the exact sample where it paused, and radio resumes live instead of
  minutes behind.
- **Cleans up after itself**: leaves when the queue is done or everyone else has left (after 30 s, configurable),
  reconnects radio streams that drop, and stops cleanly if it's taken out of voice.
- **Plays nice with Yapin’**: handlers return fast (the SDK handles one event at a time), voice lookups are cached,
  voice joins are paced, and rate limits get a friendly answer.
- **Safe by default**: track lookup can't be tricked into reaching other files, ffmpeg runs with protocol
  whitelists, chat output is escaped, and only people in the bot's voice channel can control it.

## Quick start

**You need:**

- **Node.js 20.6 or newer.** `npm start` uses `node --env-file`. (20.12 or newer is best: see
  [Configuration](#configuration) for what's different before that.)
- **ffmpeg.** ffprobe comes with it and is used for track lengths and tags.
- **A Yapin’ bot token.** Create one under Yapin’ → Settings → Developer → Create, and add the bot to your server from
  the same page.
- **macOS, Linux (x64/arm64, glibc) or Windows x64.** These are the platforms `@livekit/rtc-node` ships native
  binaries for.

**Install ffmpeg:**

| OS | Command |
| --- | --- |
| macOS | `brew install ffmpeg` |
| Debian / Ubuntu | `sudo apt install ffmpeg` |
| Fedora | `sudo dnf install ffmpeg-free` |
| Arch | `sudo pacman -S ffmpeg` |
| Windows | `winget install Gyan.FFmpeg`, then open a new terminal |

Check it with `ffmpeg -version`. If ffmpeg isn't on your `PATH`, set `FFMPEG_PATH` and `FFPROBE_PATH`.

**Run it:**

```bash
git clone <this-repo-url> dls-bot && cd dls-bot
npm install
cp .env.example .env          # Windows cmd: copy .env.example .env
```

Open `.env` and set `YAPPER_BOT_TOKEN=yb_...`. Everything else is optional. Put some audio files in `./music`, then
start the bot:

```bash
npm start                     # node --env-file=.env bot.js
npm run dev                   # the same, but restarts when you edit the code
```

The log should show `INFO  [music] using ffmpeg <version>`. Join a voice channel and type `/play 1`, or try
`/play groovesalad` for radio.

## Commands

| Command | What it does | Who can use it |
| --- | --- | --- |
| `/play <query>` | Plays a track or queues it if something is already playing (the reply gives its position). With no query, resumes if paused. | Anyone in a voice channel (resuming: listeners) |
| `/tracks [page]` | Lists the local files, numbered (20 per page), and the radio stations. | Anyone, DMs too |
| `/queue [page]` | Shows what's playing and what's up next (10 per page), with the total length and loop mode. | Anyone |
| `/nowplaying` | Posts a fresh Now Playing card with buttons; the old card loses its buttons. | Anyone |
| `/pause` · `/resume` | Pauses or resumes. | Listeners |
| `/skip` | Skips the current track. | Listeners |
| `/stop` | Stops, clears the queue and leaves the voice channel. | Listeners |
| `/volume [n\|+n\|-n]` | Shows the volume or sets it (1–200 %): `80`, `80%`, `+10`, `-10`. While the bot isn't in voice, it sets the volume the next session starts at. | Listeners (anyone while the bot isn't in voice) |
| `/loop [off\|track\|queue]` | Sets the loop mode. With no argument, cycles off → track → queue. | Listeners |
| `/shuffle` | Shuffles the tracks that are up next (needs at least 2). | Listeners |
| `/remove <n>` | Removes track *n*, as numbered by `/queue`. | Listeners |
| `/clear` | Empties the queue; the current track keeps playing. | Listeners |
| `/ping` | Shows how fast the Yapin’ API answers. | Anyone, DMs too |
| `/help` | Lists the commands. | Anyone, DMs too |

**Listeners** are the people in the bot's voice channel. With `REQUIRE_SAME_VOICE=false`, anyone in the server can use
those commands. If Yapin’ doesn't answer the voice lookup in time, the bot lets the command through instead of
blocking it. The commands appear in Yapin’'s `/` menu, and typed messages like `!play 3` work too (yapper.js listens
for both the `/` and `!` prefixes).

**Joining voice is paced.** Yapin’ allows a bot 10 voice joins and leaves a minute, for all its servers together. So
that one server (or one person) can't use them all up, the bot joins voice at most once every 20 s per server and per
person. A `/play` that would make it join sooner, like right after `/stop` or to move it to another channel, gets
"⏳ Yapin’ limits how often I can join voice. Try again in 12 s." Adding to the queue of the channel it's already in
is never paced. If a join takes longer than 2.5 s, the bot says it's still joining; after 20 s it gives up and says
so (Yapin’ is most likely rate-limiting it).

**What `/play` understands**, checked in this order:

| You type | What plays |
| --- | --- |
| `/play radio:fip` (or `station:fip`) | Only stations are searched: by id, then name, then fuzzy match |
| `/play https://host/stream.mp3` | Any direct http(s) audio stream on the internet (if `ALLOW_URLS` is on) |
| `/play groovesalad` | A station by id |
| `/play Halo.mp3` · `/play beyonce halo` | A file by name (any case), or by title (case, accents and punctuation ignored) |
| `/play 3` · `/play #3` | Track 3 as numbered by `/tracks` |
| `/play groove salad` | A station by name |
| `/play halo` | The best fuzzy match across files and stations, a list to pick from on a tie, or "did you mean" suggestions |

A bare number is always a track number, never a title: with a file called `7.mp3`, `/play 7` plays track #7, so type
the file name (`/play 7.mp3`) to pick that file.

YouTube, Spotify, SoundCloud, Apple Music, Deezer, Tidal, Bandcamp and Twitch links are web pages, not audio streams,
so the bot says so right away instead of failing after it joins voice. Links to the bot's own computer or its local
network are refused right away too (see [Security](#security)). A bot can only be in one voice channel per server.
While it's busy, `/play` from another channel is refused; when it's idle, it moves to the caller's channel.

## Now Playing card

Each track gets a card; the first one is posted as a reply to the `/play` that started it:

```text
🎶 Now Playing
Halo — Beyoncé
▬▬▬▬🔘▬▬▬▬▬▬▬▬▬  1:12 / 4:21
Requested by @alice     Volume 100%     Loop Off
Up next: SomaFM · Groove Salad · 🔴 LIVE
🔊 Lounge · 2 in queue
[ ⏯ Pause ]  [ ⏭ Skip ]  [ ⏹ Stop ]
[ 🔁 Loop: Off ]  [ 🔉 Vol - ]  [ 🔊 Vol + ]
```

| Button | Action |
| --- | --- |
| ⏯ Pause / ⏯ Resume | Toggles pause. The card title changes to ⏸ Paused. |
| ⏭ Skip | Skips the track. The card turns into "⏭ Skipped by @you". |
| ⏹ Stop | Stops and leaves voice. The card turns into "⏹ Stopped by @you". |
| 🔁 Loop: Off / Track / Queue | Moves to the next loop mode. |
| 🔉 Vol - · 🔊 Vol + | Changes the volume by `VOLUME_STEP` (default 10). Disabled at 1 % and 200 %. |

- Radio shows 🔴 LIVE and the station's description instead of a progress bar, and the card title links to the
  station's homepage.
- Each server has one live card. When the next track starts, the old card loses its buttons. Clicking a button on an
  old card just removes its buttons. A track that repeats (loop *track*, or a one-track queue on loop *queue*) keeps
  its card, which starts over.
- The card updates in place when you pause, change the volume or loop mode, or edit the queue. Changes are batched
  into at most one edit every 1.5 s, and a click updates the card right away. The progress bar shows the position at
  the last update (it doesn't tick by itself); `/nowplaying` posts a fresh card.
- Buttons follow the same rule as commands. People outside the bot's voice channel get a private note telling them to
  join first.

## Radio stations

Play a station with `/play <id>` or by its name (`/play groove salad`). `/tracks` lists them.

| id | Station | Plays |
| --- | --- | --- |
| `groovesalad` | [SomaFM · Groove Salad](https://somafm.com/groovesalad/) | Ambient beats and grooves |
| `fluid` | [SomaFM · Fluid](https://somafm.com/fluid/) | Instrumental hip-hop & lo-fi beats |
| `dronezone` | [SomaFM · Drone Zone](https://somafm.com/dronezone/) | Atmospheric ambient soundscapes |
| `defcon` | [SomaFM · DEF CON Radio](https://somafm.com/defcon/) | Music for hacking |
| `lush` | [SomaFM · Lush](https://somafm.com/lush/) | Mellow vocals with an electronic touch |
| `radioparadise` | [Radio Paradise · Main Mix](https://radioparadise.com/) | Eclectic rock, indie, electronica & world |
| `mellow` | [Radio Paradise · Mellow Mix](https://radioparadise.com/) | The laid-back side of Radio Paradise |
| `kexp` | [KEXP 90.3 Seattle](https://www.kexp.org/) | Independent music from Seattle |
| `fip` | [FIP](https://www.radiofrance.fr/fip) | Eclectic sounds from Paris |
| `fipjazz` | [FIP Jazz](https://www.radiofrance.fr/fip) | Jazz around the clock from FIP |
| `npo2` | [NPO Radio 2](https://www.nporadio2.nl/) | Dutch pop & rock classics |
| `3fm` | [NPO 3FM](https://www.npo3fm.nl/) | New pop, rock & alternative from the Netherlands |

### Add your own

`config/stations.json` is a JSON array. Add an object for each station:

```json
{
  "id": "mystation",
  "name": "My Station",
  "url": "https://stream.example.com/live.mp3",
  "description": "What it plays",
  "homepage": "https://example.com/"
}
```

| Field | Required | Rules |
| --- | --- | --- |
| `id` | yes | 1–32 characters from `a-z 0-9 - _` with at least one letter, so it can't clash with a track number. Can't start with `-` or `_`. Stored lowercase. If two entries share an id, the first one wins. |
| `name` | yes | Shown in `/tracks` and on the card. Falls back to the id. |
| `url` | yes | The direct http(s) audio stream (an Icecast/Shoutcast URL like the presets), not the station's web page. |
| `description` | no | Shown on the Now Playing card. |
| `homepage` | no | https only. The card's title links to it. |

Stations are loaded when the bot starts, so restart it after editing the file. A bad entry is skipped with a warning
in the log and the rest still load. To keep your list somewhere else, point `STATIONS_FILE` at your own file.

> **Respect the stations.** These streams belong to their broadcasters, and each station has its own terms of use.
> Check and respect them before you relay a station to your server. SomaFM, Radio Paradise and KEXP are
> listener-supported.

## Configuration

Put settings in `.env` (`.env.example` lists them all). Only the token is required. Variables already set in the
environment win over `.env`, except on Node 20.6.x, where `--env-file` lets `.env` win (fixed in Node 20.7).

| Variable | Default | Accepts | What it does |
| --- | --- | --- | --- |
| `YAPPER_BOT_TOKEN` | *(required)* | starts with `yb_` | Your bot token (Yapin’ → Settings → Developer) |
| `MUSIC_DIR` | `./music` | folder path | Where your audio files are |
| `STATIONS_FILE` | `./config/stations.json` | file path | The radio presets |
| `FFMPEG_PATH` | `ffmpeg` | program name or path | The ffmpeg binary. A bare name is looked up on `PATH`. |
| `FFPROBE_PATH` | `ffprobe` | program name or path | ffprobe, for track lengths and tags (optional) |
| `DEFAULT_VOLUME` | `100` | 1–200 (`%` allowed) | The volume a server starts at |
| `VOLUME_STEP` | `10` | 1–100 (`%` allowed) | How much 🔉 / 🔊 change the volume |
| `MAX_QUEUE_SIZE` | `100` | 1–1000 | How many tracks can wait in a server's queue |
| `IDLE_TIMEOUT_SECONDS` | `30` | 0–3600 | How long to stay after the queue ends (0 = leave at once) |
| `ALONE_TIMEOUT_SECONDS` | `30` | 0–3600 | How long to stay after everyone else has left (0 = leave at once) |
| `ALLOW_URLS` | `true` | `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off` | Allow `/play <http(s) link>` (never into the bot's own computer or local network) |
| `REQUIRE_SAME_VOICE` | `true` | same as above | Only people in the bot's voice channel can control playback |
| `EMBED_COLOR` | `#ff4fd8` | `#rrggbb` or `rrggbb` | The accent colour of the cards |
| `BOT_STATUS` | `Listening to /play` | text | The bot's activity text |
| `AUDIO_QUEUE_MS` | `200` | 50–1000, a multiple of 10 | Audio buffered in LiveKit. Lower is snappier for pause/skip/volume; higher rides out hiccups better. (LiveKit would crash the whole bot on any other value, so it falls back to 200.) |
| `AUDIO_BITRATE` | `128000` | 32000–256000 | Opus bitrate of the bot's voice track, in bits/s |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` | How much the log says |

- A value that can't be used never crashes the bot. It falls back to the default, and the bot prints a startup
  warning naming the variable.
- Relative paths are resolved against the project folder, not the current directory. `~` means your home folder.
- Values may be quoted. In `.env` an unquoted `#` starts a comment, so write `EMBED_COLOR="#00aaff"` or
  `EMBED_COLOR=00aaff`.
- A volume changed with `/volume` or the buttons is remembered per server until the bot restarts.

## How it works

### The audio pipeline

```text
   ./music/song.flac              https://host/stream.mp3
           │                                │
           └───────────────┬────────────────┘
                           ▼
   ffmpeg … -f s16le -ar 48000 -ac 2 pipe:1                    src/ffmpeg.js
                           │  raw PCM: 48 kHz, stereo, signed 16-bit little-endian
                           ▼
   PcmFramer                                                   src/audio.js
                           │  10 ms frames: 480 samples × 2 channels × 2 bytes = 1920 B,
                           │  each copied into its own ArrayBuffer
                           ▼
   applyGain                                                   src/audio.js
                           │  volume ramped linearly across the frame, clamped to 16 bits
                           ▼
   AudioSource.captureFrame                                    @livekit/rtc-node, via src/voice.js
                           │  ~200 ms native queue (AUDIO_QUEUE_MS); resolves when there's room,
                           │  so the loop runs in real time and ffmpeg waits on the pipe
                           ▼
   LocalAudioTrack in a LiveKit room                           yapper.js connectVoice
                           │  encrypted with the bot's media key, which is handed to each
                           ▼  listener (ECDH P-256 + AES-GCM); the server never sees it
   🎧 end-to-end encrypted Yapin’ voice call
```

- **Why copy every frame?** rtc-node hands native code the frame's *whole* underlying `ArrayBuffer`, starting at
  offset 0. A view into Node's pooled Buffer memory would therefore play whatever happens to sit around it. Every
  frame gets a fresh 1920-byte buffer instead.
- **Why a 200 ms queue?** LiveKit's `AudioSource` buffers 1000 ms by default, so pause, skip and volume would lag by a
  second. `src/voice.js` gives yapper.js a copy of the rtc module whose `AudioSource` subclass forces
  `AUDIO_QUEUE_MS`. It also records what got built, so a join that fails half-way is torn down completely.
- **Pause.** For files, the player simply stops reading. The pipe fills and ffmpeg blocks (it's parked, not killed),
  so resume continues on the exact sample and nothing is lost. For radio, the player keeps reading and drops the
  frames. The station connection doesn't stall, and resume comes back live.
- **Skip and stop.** ffmpeg is killed and `source.clearQueue()` drops the audio already handed to LiveKit, so you hear
  the change at once. Stop also empties the queue and leaves voice.
- **Volume** applies from the very next frame. It's a linear gain (200 % = 2× amplitude, about +6 dB), ramped from
  the old value so it doesn't click and clamped to 16 bits, so very loud tracks can clip near 200 %.
- **Loop modes** cycle off → track → queue. *Track* replays the current track until someone skips. *Queue* sends
  every finished or skipped track to the back. A track that fails is dropped even while looping, so a broken file
  can't loop forever.
- **Radio drops.** ffmpeg reconnects by itself and gives up after 15 s without data. The player then retries up to
  3 times (after 1 s, 2 s and 4 s), and that count resets after 30 s of good audio. A station whose server ends the
  stream cleanly (a restart, a recycled connection) is reconnected the same way, since a station never ends on its
  own; a link can be a finite file, so it just ends. A link or station that fails before playing anything, in a way
  no retry changes (an HTTP 4xx like 404, a web page instead of a stream), fails right away instead.
- **Auto-leave.**
  - *Idle*: after the last track the bot waits `IDLE_TIMEOUT_SECONDS` for a new `/play`, then leaves.
  - *Alone*: on voice join/leave events (debounced 1.5 s) the bot checks who is still in its channel, falling back to
    LiveKit's participant count. If nobody is left, it waits `ALONE_TIMEOUT_SECONDS`, looks once more, then leaves.
    Events that came while it was still joining get their check once it's in.
  - If the bot is taken out of voice, it stops and says so.
- **One event at a time.** yapper.js awaits each handler before it takes the next event, and that includes button
  clicks, which must be answered within 3 s. A slow handler would hold up every event after it. So handlers do at most a
  voice lookup and a file probe, in parallel and time-boxed, and they never wait for their own replies (yapper.js
  waits out a rate limit inside a send). Joining voice and playing run detached, and their results are posted later:

  ```text
  /play groove salad
   └─ cogs/music.js      resolve the query, then voice lookup + file probe in parallel (≤ 3 s)
       └─ player.play()  returns at once → "Added to queue", or nothing yet when it starts now
           └─ run loop   detached, one per server: join voice → decode → frames → captureFrame
               └─ events → Now Playing card and notices, posted in order per server
  ```

- **Per-server players.** Each server has one `Player`. A new player waits until the previous one has fully left
  voice, so an old leave can't undo the new join, also after several quick `/stop`s or a stop in the middle of a move.
  A join is given 20 s; one that's given up on (too slow, or `/stop`) and still gets through later is left again at
  once, without the server-wide leave that would take a newer session out of voice.
- **Rate limits.** Voice lookups are cached for 5 s, shared between concurrent callers and refreshed on voice events.
  Someone a lookup found outside voice is remembered for 15 s (until the next voice event in that server), so
  repeating `/play` or clicking a button doesn't cost a lookup each time: Yapin’ allows 60 a minute for the whole bot.
  Voice joins are paced (see [Commands](#commands)).
- **Clean shutdown.** On Ctrl+C the bot stops polling first (so yapper.js doesn't send Yapin’ an empty command
  list), then unloads the cog (every player leaves voice and the last cards lose their buttons), then closes LiveKit.
  A second Ctrl+C exits at once, and a shutdown that takes over 8 s is cut short.

## Project structure

```text
.
├── bot.js                 entry point: settings, logging, cogs, graceful shutdown
├── cogs/
│   └── music.js           the Music cog: commands, buttons, voice events (thin glue)
├── src/
│   ├── audio.js           PCM constants, 10 ms framing, volume ramp (pure)
│   ├── config.js          environment → frozen settings, with warnings instead of crashes
│   ├── ffmpeg.js          the ffmpeg decoder process, the startup check, ffprobe tags
│   ├── log.js             tiny leveled logger
│   ├── player.js          Player (one server's playback engine) and PlayerManager
│   ├── queue.js           queue state machine and loop modes (pure)
│   ├── tracks.js          the music folder, the stations, /play query resolution
│   ├── ui.js              cards, buttons, custom ids, escaping (pure)
│   └── voice.js           joining voice (short queue, full clean-up), who is in voice
├── config/
│   └── stations.json      radio presets
├── music/                 your audio files (git-ignored)
├── test/                  node:test suites, plus shared fakes in helpers.js
├── yapper.js              the Yapin’ bot SDK (one file)
├── starter.js             the SDK's original example bot (not used by DLS_bot)
├── .env.example           settings template: copy it to .env
└── package.json
```

## Testing

```bash
npm test                            # node --test: every suite in test/
node --test test/player.test.js     # a single suite
```

- **Offline and deterministic.** Fake timers, voice connections and decoders (`test/helpers.js`) drive the player and
  the cog step by step. No internet and no real LiveKit server are needed: the integration suite talks to a stand-in
  Yapin’ API on `127.0.0.1`.
- **Real-ffmpeg tests skip when ffmpeg is missing.** They generate their audio with ffmpeg's `lavfi` source and are
  skipped, not failed, when ffmpeg or ffprobe isn't installed. They honour `FFMPEG_PATH` / `FFPROBE_PATH`.
- **A few tests need POSIX.** They use a stand-in ffmpeg shell script or symlinks, and skip on Windows.

| Suite | What it covers |
| --- | --- |
| `queue.test.js` | Every advance reason × loop mode × queue state (a 36-case table), `peek()` checked against `advance()` on a seeded random walk, and an unbiased Fisher–Yates shuffle |
| `audio.test.js` | Volume parsing; the gain ramp (exact end points, clipping, odd lengths); `PcmFramer` with odd offsets, 1-byte chunks and seeded random chunking; `readFrames` |
| `ffmpeg.test.js` | Exact ffmpeg arguments, the decoder lifecycle with a fake spawn, and readable error summaries from real ffmpeg output. With real ffmpeg: 1 s of WAV/FLAC decodes to exactly 100 frames, a file named `concat:weird #1.wav` plays as a file, kill mid-stream, back-pressure without data loss, ffprobe tags |
| `tracks.test.js` | Folder listing, station validation (including the shipped `stations.json`), all 8 `/play` resolution steps, path tricks that must stay inside the music folder, caching and probing |
| `config.test.js` | Every variable's default, range and fallback warning; paths, quotes and `~`; the logger |
| `voice.test.js` | Joining through a fake SDK: the forced queue size, E2EE, clean-up at every failure point, and joins that were called off. Leave fallbacks, and releasing a real rtc-node `Room` the server dropped. Voice-lookup caching, shared requests and the memory of who isn't in voice |
| `ui.test.js` | Every card stays inside Yapin’'s message limits with hostile input (1000 files, 100 tracks, huge titles); escaping and mentions; custom ids; button states |
| `player.test.js` | The engine: queue flow, loop modes, pause on files vs radio, the volume ramp, skip and stop in every state, the join timeout, stream retries (and what isn't retried), presence and auto-leave, the hand-over between a server's players |
| `music.test.js` | The cog end to end: every command and button, the permission checks, the Now Playing card lifecycle, voice events, Yapin’'s rate limits (pacing, lookups, stuck replies), unloading |
| `sdk-integration.test.js` | The real yapper.js `Bot` loading `cogs/` against the fake API: command registration, replies, a refused voice join, a clean shutdown; and `bot.js` without a token |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `node: bad option: --env-file=.env` | Your Node is older than 20.6. Upgrade it (`node -v`). |
| `node: .env: not found` | Run `cp .env.example .env` and add your token. (Node before 20.12 starts without a `.env` and says `YAPPER_BOT_TOKEN isn't set` instead.) |
| A variable you set in the shell is ignored in favour of `.env` | That's Node 20.6.x. Upgrade to 20.7 or newer, or change the value in `.env`. |
| `YAPPER_BOT_TOKEN isn't set`, or `couldn't start: … (check YAPPER_BOT_TOKEN in .env)` | Put the bot token (it starts with `yb_`) in `.env`. If it was rejected, make a new one in Settings → Developer. |
| The log says `ffmpeg not found at "ffmpeg"`, and `/play` answers "ffmpeg isn't installed" (or a track "Couldn't play …: ffmpeg isn't available") | Install ffmpeg, or set `FFMPEG_PATH` to its full path (`which ffmpeg` / `where ffmpeg`). You'll need that when the bot runs as a service with a different `PATH`. The same goes for ffmpeg disappearing while the bot runs (an upgrade that moved it). No restart needed: `/play` looks for ffmpeg again, at most every 30 s. |
| The card says "length unknown" and shows file-name titles | ffprobe is missing. Install it with ffmpeg, or set `FFPROBE_PATH`. |
| "Join a voice channel first" while you're in one | The bot can't see that voice channel. Give its role access. |
| "I don't have permission to join that voice channel" | Let the bot's role join that channel. |
| The bot doesn't answer at all | Check that it can read and post in that text channel (the log says `couldn't post in channel …`). `LOG_LEVEL=debug` shows more. |
| The card is there but you hear nothing | Check `/volume`, and that the card doesn't say ⏸ Paused. If a moderator muted the bot, unmute it: a muted bot can't hand out its encryption key. Leave and rejoin the voice channel to receive the key again. |
| "Yapin’ is rate-limiting …" | Each bot gets 10 voice joins/leaves and 60 voice lookups per minute. Wait the time it says. Moving to another channel costs a leave plus a join. |
| "⏳ Yapin’ limits how often I can join voice. Try again in 12 s." | The bot joins voice at most once every 20 s per server and per person (see [Commands](#commands)). Wait the time it says, and use `/skip` or `/clear` instead of `/stop` plus `/play` to change what's playing. |
| "🔌 Joining … is taking a moment", then "It took over 20 s, so I gave up" | Yapin’ is slow to let the bot into voice, most likely because the bot used up its 10 joins and leaves for this minute (all servers count). Try again in a minute. |
| `EMBED_COLOR is empty (in .env an unquoted # starts a comment)` | Write `EMBED_COLOR="#00aaff"` or `EMBED_COLOR=00aaff`. |
| A station fails ("Couldn't play …: Server returned 404 Not Found") | The stream moved or is down. Update its `url` in `stations.json`. |

## Security

- **The token only lives in `.env`.** That file is git-ignored, and `.env.example` is the template. Startup warnings
  blank out anything token-like (`yb_…`), and the bot never logs the token. If `.env` was ever committed, untrack it
  (`git rm --cached .env`) and make a new token in Settings → Developer: the old one stays in the git history.
- **No path traversal.** Whatever follows `/play` is only compared with the music folder's listing (top level only,
  no hidden files, symlinks only when they point to a regular file). It's never turned into a path, so `../../.env`
  or `/etc/passwd` simply match nothing.
- **ffmpeg is locked down.**
  - It's spawned without a shell, with an argument array.
  - Files open as `file:<absolute path>` under `-protocol_whitelist file`, so a name like `concat:x.mp3` stays a
    name.
  - Streams may only use `http,https,tcp,tls,crypto`, and ffprobe only `file`.
- **Links (`ALLOW_URLS`).** Only http(s) links are accepted, and a link makes the computer running the bot connect to
  that address.
  - Links to that computer or its private network are refused: `localhost` and `*.local` names, and loopback,
    private, carrier-grade NAT, link-local (like the cloud metadata address `169.254.169.254`), multicast and
    reserved addresses, however they're written (`2130706433`, `0x7f.1`, `[::ffff:127.0.0.1]` …). Without that, a
    member could probe the bot's network and read the answers in the error messages.
  - That check sees literal addresses only. A public name that resolves to a private address, or a stream that
    redirects there, still gets through, because ffmpeg resolves names and follows redirects itself. If you don't
    trust everyone who can use `/play`, set `ALLOW_URLS=false`; presets and local files keep working.
  - Stations in `stations.json` are your own choice and aren't checked, so a home Icecast on your network works.
- **Escaped chat output.**
  - File names, tags, station names and error text are escaped: markdown is neutralised, `@everyone`, `@here` and
    `<@id>` can't ping, and control and bidi characters are dropped.
  - Local paths stay out of chat: `/tracks` and the cards show titles and file names, ffmpeg's error lines are
    stripped of local paths, and an ffmpeg that can't be started is reported without the path it was looked for at.
  - Link titles leave out query strings and credentials.
- **Controls.** With `REQUIRE_SAME_VOICE` on (the default), only people in the bot's voice channel can pause, skip,
  stop or change the queue.
- **Rate limits can't be used up by one person.** Repeated `/play`s or clicks from someone outside voice cost one
  voice lookup, not one each, and voice joins are paced per server and per person, so nobody can spend the bot's
  per-minute budgets (which every server shares) on their own. Searches over 200 characters aren't fuzzy-matched, so
  a crafted query can't stall the audio of every server on a large library.

## License

ISC, as declared in `package.json`. `yapper.js` (Yapin’'s SDK) and `@livekit/rtc-node` (Apache-2.0) keep their own
licenses, and the radio streams belong to their broadcasters.
