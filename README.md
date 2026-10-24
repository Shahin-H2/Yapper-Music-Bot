# Music Bot

![Node.js >= 20.6](https://img.shields.io/badge/node-%3E%3D%2020.6-339933?logo=nodedotjs&logoColor=white)
[![License: Proprietary / All Rights Reserved](https://img.shields.io/badge/license-Proprietary%20%2F%20All%20Rights%20Reserved-red)](LICENSE)

Music Bot plays your own audio files and live internet radio in [Yapin’](https://www.yapin.gg) voice channels. Every server gets its own queue, and an interactive Now Playing card lets people pause, skip, loop and change the volume with a click.

## How to use it

Join a voice channel and type `/play` with a track number, a file name, a station or a stream link. Music Bot joins your channel and answers with a Now Playing card; if something is already playing, your pick goes into the queue instead. By default it leaves 30 seconds after the music runs out or after everyone else has left.

### Now Playing card

This is what the bot posts while a local file plays, with a radio station up next:

```text
🎶 Now Playing
Gymnopédie No. 1 — Erik Satie
▬▬▬▬▬🔘▬▬▬▬▬▬▬▬  1:12 / 3:25
Requested by      Volume      Loop
@alice            100%        Off
Up next
SomaFM · Groove Salad · 🔴 LIVE
🔊 Lounge · 2 in queue

[ ⏯ Pause ]  [ ⏭ Skip ]  [ ⏹ Stop ]
[ 🔁 Loop: Off ]  [ 🔉 Vol - ]  [ 🔊 Vol + ]
```

Radio shows 🔴 LIVE and the station's description instead of a progress bar. The card updates itself when someone pauses, changes the volume or loop mode, or edits the queue (the progress bar moves with those updates). When a new card is posted, the old one loses its buttons.

| Button | What it does |
| --- | --- |
| ⏯ Pause / ⏯ Resume | Pauses or resumes. While paused, the card title reads ⏸ Paused. |
| ⏭ Skip | Skips the current track. |
| ⏹ Stop | Stops the music, clears the queue and leaves the voice channel. |
| 🔁 Loop | Switches between Off, Track (repeat this track) and Queue (repeat the whole queue). |
| 🔉 Vol - / 🔊 Vol + | Turns the volume down or up by `VOLUME_STEP` (default 10), between 1% and 200%. |

### Commands

| Command | What it does |
| --- | --- |
| `/play <number, name, station or link>` | Plays it now, or adds it to the queue if something is already playing. With nothing after it, resumes paused music. |
| `/tracks [page]` | Lists your music files, numbered for `/play`, and the radio stations. |
| `/queue [page]` | Shows what's playing and what's up next. |
| `/nowplaying` | Posts a fresh Now Playing card with buttons. |
| `/pause` | Pauses the music. |
| `/resume` | Resumes the music. |
| `/skip` | Skips the current track. |
| `/stop` | Stops the music, clears the queue and leaves the voice channel. |
| `/volume [number, +10 or -10]` | Shows the volume, or sets it from 1 to 200%. |
| `/loop [off\|track\|queue]` | Repeats nothing, the current track or the whole queue. Without an argument, it moves to the next mode. |
| `/shuffle` | Shuffles the tracks that are up next. |
| `/remove <number>` | Takes a track out of the queue, by the number `/queue` shows. |
| `/clear` | Empties the queue. The current track keeps playing. |
| `/ping` | Checks that the bot is alive and how fast Yapin’ answers. |
| `/help` | Lists the commands. |

Playback controls and the card's buttons only work for people in the bot's voice channel (`REQUIRE_SAME_VOICE`). Typed commands work too: `!play 3` does the same as `/play 3`.

### Built-in radio stations

Twelve stations come with the bot. Play one by its id (`/play groovesalad`) or by its name (`/play groove salad`).

| ID | Station | Network | Style |
| --- | --- | --- | --- |
| `groovesalad` | [Groove Salad](https://somafm.com/groovesalad/) | SomaFM | Ambient beats and grooves |
| `fluid` | [Fluid](https://somafm.com/fluid/) | SomaFM | Instrumental hip-hop & lo-fi beats |
| `dronezone` | [Drone Zone](https://somafm.com/dronezone/) | SomaFM | Atmospheric ambient soundscapes |
| `defcon` | [DEF CON Radio](https://somafm.com/defcon/) | SomaFM | Music for hacking |
| `lush` | [Lush](https://somafm.com/lush/) | SomaFM | Mellow vocals with an electronic touch |
| `radioparadise` | [Main Mix](https://radioparadise.com/) | Radio Paradise | Eclectic rock, indie, electronica & world |
| `mellow` | [Mellow Mix](https://radioparadise.com/) | Radio Paradise | The laid-back side of Radio Paradise |
| `kexp` | [KEXP 90.3 Seattle](https://www.kexp.org/) | KEXP | Independent music from Seattle |
| `fip` | [FIP](https://www.radiofrance.fr/fip) | Radio France | Eclectic sounds from Paris |
| `fipjazz` | [FIP Jazz](https://www.radiofrance.fr/fip) | Radio France | Jazz around the clock from FIP |
| `npo2` | [NPO Radio 2](https://www.nporadio2.nl/) | NPO | Dutch pop & rock classics |
| `3fm` | [NPO 3FM](https://www.npo3fm.nl/) | NPO | New pop, rock & alternative from the Netherlands |

To add your own, add an entry to `config/stations.json` and restart the bot. The fields are listed under Configuration below.

### Quick examples

```text
/play 1              # the first file in ./music (/tracks shows the numbers)
/play groovesalad    # live radio: SomaFM Groove Salad
/play gymnopedie     # search files and stations by name; case and accents don't matter
/queue               # what's playing and what's up next
/volume 80           # set the volume to 80%
```

## Quick start

1. **Install ffmpeg and Node.js 20.6 or newer.**

   ```bash
   brew install ffmpeg node                        # macOS
   sudo apt install ffmpeg nodejs npm              # Debian / Ubuntu
   winget install Gyan.FFmpeg OpenJS.NodeJS.LTS    # Windows, then open a new terminal
   ```

   Check `node -v` afterwards. Some Linux releases ship an older Node; if yours is below 20.6, get a current one from [nodejs.org](https://nodejs.org). The bot runs on macOS, Linux (x64 or arm64, glibc) and Windows x64, the platforms `@livekit/rtc-node` ships binaries for.

2. **Get the code and add your bot token.**

   ```bash
   git clone https://github.com/Shahin-H2/music-bot.git
   cd music-bot
   npm install
   cp .env.example .env            # Windows cmd: copy .env.example .env
   ```

   In Yapin’, open Settings > Developer and create a bot (this one is called Music_Bot). Put its token, which starts with `yb_`, in `.env` as `YAPPER_BOT_TOKEN`, then add the bot to your server from the same page.

3. **Add music and start it.** Put audio files (`.mp3`, `.wav`, `.flac`, `.ogg`, `.opus` or `.m4a`) in `./music`, run `npm start`, join a voice channel and type `/play 1`.

Running your own copy needs the author's written permission, because the code is proprietary (see [License](#license)).

<details><summary><b>Configuration (.env)</b></summary>

Only `YAPPER_BOT_TOKEN` is required. Variables already set in your shell win over `.env`. A value the bot can't use falls back to its default with a warning in the log, relative paths start from the project folder, and switches take `true`/`false`, `1`/`0`, `yes`/`no` or `on`/`off`.

| Variable | Default | What it does |
| --- | --- | --- |
| `YAPPER_BOT_TOKEN` | required | Your bot token from Settings > Developer. It starts with `yb_`. |
| `MUSIC_DIR` | `./music` | The folder with your audio files. Only files directly inside it count, and new ones show up without a restart. |
| `STATIONS_FILE` | `./config/stations.json` | The list of radio stations. |
| `FFMPEG_PATH` | `ffmpeg` | Where ffmpeg is, if it isn't on your `PATH`. |
| `FFPROBE_PATH` | `ffprobe` | Where ffprobe is. It reads track lengths and title/artist tags. |
| `DEFAULT_VOLUME` | `100` | The volume a server starts at, 1 to 200. |
| `VOLUME_STEP` | `10` | How much the 🔉 and 🔊 buttons change the volume, 1 to 100. |
| `MAX_QUEUE_SIZE` | `100` | How many tracks can wait in a server's queue, 1 to 1000. |
| `IDLE_TIMEOUT_SECONDS` | `30` | How long to stay in voice after the queue ends, 0 to 3600 (0 leaves at once). |
| `ALONE_TIMEOUT_SECONDS` | `30` | How long to stay after everyone else has left, 0 to 3600. |
| `ALLOW_URLS` | `true` | Lets `/play` take http(s) stream links. Links to this computer or its local network are refused, but a public name can still point there, so set `false` if you don't trust everyone who can use `/play`. |
| `REQUIRE_SAME_VOICE` | `true` | Only people in the bot's voice channel can use the playback controls. |
| `EMBED_COLOR` | `#ff4fd8` | The card colour. Write it with quotes, `EMBED_COLOR="#00aaff"`, because an unquoted `#` starts a comment in `.env`. |
| `BOT_STATUS` | `Listening to /play` | The bot's activity text. |
| `AUDIO_QUEUE_MS` | `200` | Audio buffered ahead in LiveKit, a multiple of 10 from 50 to 1000. Lower reacts faster to pause and volume, higher rides out network hiccups. |
| `AUDIO_BITRATE` | `128000` | The Opus bitrate of the bot's voice track, 32000 to 256000 bits/s. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

**Your own stations.** `config/stations.json` is a JSON array of objects. Each needs an `id` (what people type after `/play`: 1 to 32 characters from `a-z`, `0-9`, `-` and `_`, starting with a letter or digit and holding at least one letter, so it can't clash with a track number), a `name` and a `url` (the direct http(s) audio stream, not the station's web page). `description` (shown on the card next to 🔴 LIVE) and `homepage` (an https link for the card's title) are optional. Stations load when the bot starts, so restart it after an edit; a broken entry is skipped with a warning.

</details>

<details><summary><b>Troubleshooting</b></summary>

| Symptom | Fix |
| --- | --- |
| `node: bad option: --env-file=.env` | Your Node.js is older than 20.6. Upgrade it. |
| `node: .env: not found` | Run `cp .env.example .env` and put your bot token in it. |
| The log says `YAPPER_BOT_TOKEN isn't set`, or `couldn't start` with a hint to check it | Put the bot token (it starts with `yb_`) in `.env`. If Yapin’ rejected it, make a new one in Settings > Developer. |
| A variable set in your shell is ignored | On Node 20.6.x the `.env` file wins over the shell. Upgrade to Node 20.7 or newer, or change the value in `.env`. |
| `/play` says ffmpeg isn't installed, or the log says `ffmpeg not found` | Install ffmpeg, or set `FFMPEG_PATH` to its full path (`which ffmpeg`, or `where ffmpeg` on Windows). No restart needed: `/play` looks for it again, at most every 30 s. |
| "Join a voice channel first" while you are in one, or "I don't have permission to join that voice channel" | The bot's role needs access to that voice channel, including permission to join it. |
| The card is there, but you hear nothing | Check `/volume` and that the card doesn't say ⏸ Paused. If a moderator muted the bot, unmute it (a muted bot can't hand out its encryption key), then leave and rejoin the channel. |
| "Yapin’ limits how often I can join voice. Try again in N s." | The bot joins voice at most once every 20 s per server and per person. Wait, and change the music with `/skip` or `/clear` rather than `/stop` and a new `/play`. |
| "Yapin’ is rate-limiting me right now", or a join that "took over 20 s" | A bot gets 10 voice joins and leaves and 60 voice lookups a minute, shared by all its servers. Wait the time it says, or a minute. |
| A station fails with "Server returned 404 Not Found" | The stream moved or is down. Update its `url` in `config/stations.json`. |

</details>

## Under the hood

Plain Node.js (ES modules with JSDoc types, no build step) on the single-file yapper.js SDK. The only npm dependency is `@livekit/rtc-node`.

### Architecture

```text
 ./music/song.flac  or  https://host/stream.mp3
   ▼
 ffmpeg: decodes to s16le PCM, 48 kHz stereo                      src/ffmpeg.js
   ▼
 PcmFramer: 10 ms frames of 1920 bytes, each in its own buffer    src/audio.js
   ▼
 applyGain: volume ramped across the frame, clamped to 16 bits    src/audio.js
   ▼
 LiveKit AudioSource with a 200 ms queue (AUDIO_QUEUE_MS)         src/voice.js
   ▼
 end-to-end encrypted Yapin’ voice call                           yapper.js
```

- **Frames that own their memory.** rtc-node hands native code a frame's whole underlying buffer from offset 0, so a view into Node's pooled `Buffer` memory would play whatever bytes sit next to it. `PcmFramer` therefore copies every 10 ms frame (480 samples × 2 channels × 2 bytes) into a fresh `ArrayBuffer`, and puts samples split across chunks back together.
- **Click-free volume.** Volume is a linear gain (200% doubles the amplitude, about +6 dB). `applyGain` ramps from the old gain to the new one across the next 10 ms frame and clamps to 16 bits, so a change never clicks.
- **A 200 ms LiveKit buffer.** LiveKit's `AudioSource` queues a full second by default, so pause, skip and volume would lag by a second. `src/voice.js` hands yapper.js a copy of the rtc module whose `AudioSource` uses `AUDIO_QUEUE_MS`, and skip and stop also drop what is already queued. LiveKit aborts the whole process on a queue that isn't a multiple of 10 ms, so the config falls back to 200 for any other value.
- **Pausing files and radio.** A paused file is simply not read any further: the pipe fills up, ffmpeg blocks, and resume continues on the exact sample. A paused station keeps being read with its frames dropped, so the connection doesn't stall and resume comes back live.
- **Fast handlers for a one-event-at-a-time SDK.** yapper.js waits for each handler before it takes the next event, and a button click must be answered within 3 s. Handlers wait for at most a voice lookup and a file probe, in parallel and time-boxed, and never for their own replies. Joining voice and playing run in a detached loop per server, and their results are posted in order.
- **Rate-limit budgets.** Yapin’ gives each bot 10 voice joins and leaves and 60 voice lookups a minute, shared by all its servers. Lookups are cached for 5 s and shared by concurrent callers, someone found outside voice is remembered for 15 s, and joins are paced to one per 20 s per server and per person, so nobody can use up everyone's budget.
- **Streams that drop.** ffmpeg reconnects by itself and gives up after 15 s without data; the player then retries up to 3 times (after 1, 2 and 4 s). Errors a retry can't fix, such as an HTTP 404 or a web page instead of audio, fail at once.
- **Security boundaries.** Whatever follows `/play` is only compared with the music folder's listing and never turned into a path, so `../../.env` matches nothing. ffmpeg runs without a shell and with protocol whitelists (`file` for files, `http,https,tcp,tls,crypto` for streams), and links to localhost or to private, loopback and link-local addresses are refused. File names, tags and error text are escaped before they reach chat, so they can't format a message or ping `@everyone`. The token stays in `.env`, which git ignores, and config warnings blank out anything that looks like one.

### Project structure

```text
.
├── bot.js                 entry point: settings, logging, cogs, clean shutdown
├── cogs/music.js          commands, buttons and voice events (thin glue over src/)
├── src/
│   ├── audio.js           PCM constants, 10 ms framing, volume ramp (pure)
│   ├── config.js          environment variables to frozen settings, with warnings instead of crashes
│   ├── ffmpeg.js          the ffmpeg decoder, the startup check, ffprobe tags
│   ├── log.js             small leveled logger
│   ├── player.js          Player (one server's playback engine) and PlayerManager
│   ├── queue.js           queue and loop modes (pure state)
│   ├── tracks.js          music folder, stations, what /play understands
│   ├── ui.js              cards, buttons, custom ids, escaping (pure)
│   └── voice.js           joining voice with a short queue and full clean-up, who is in voice
├── config/stations.json   radio presets
├── music/                 your audio files (git-ignored)
├── test/                  node:test suites and shared fakes (helpers.js)
├── yapper.js              the Yapin’ bot SDK, one file (third party)
├── .env.example           settings template, copied to .env
├── LICENSE
└── package.json
```

### Testing

```bash
npm test                            # every suite in test/, run by node --test
node --test test/player.test.js     # a single suite
```

With ffmpeg installed, a full run reports:

```text
ℹ tests 588
ℹ suites 100
ℹ pass 588
ℹ fail 0
```

Everything runs offline and deterministically: fake timers, voice connections and decoders (`test/helpers.js`) drive the player and the cog step by step, and the integration suite talks to a stand-in Yapin’ API on 127.0.0.1. Without ffmpeg, the tests that need it are skipped rather than failed.

- **Pure logic:** `queue` (every advance reason × loop mode × queue state, an unbiased Fisher-Yates shuffle), `audio` (the gain ramp's end points and clipping, framing with odd offsets and 1-byte chunks), `ui` (every card stays inside the message limits with hostile input; escaping; button states) and `config` (every variable's default, range and fallback warning).
- **Processes and I/O:** `ffmpeg` (exact arguments, the decoder lifecycle, readable error summaries; with real ffmpeg, 1 s of WAV or FLAC decodes to exactly 100 frames), `tracks` (all eight `/play` resolution steps, path tricks that must stay inside the music folder, the shipped `stations.json`) and `voice` (the forced queue size, end-to-end encryption, clean-up at every failure point, voice-lookup caching).
- **Behaviour end to end:** `player` (queue flow, pause on files and radio, skip and stop in every state, stream retries, auto-leave), `music` (every command and button, permission checks, the card's lifecycle, rate limits) and `sdk-integration` (the real yapper.js `Bot` loading `cogs/` against a fake API, and `bot.js` without a token).

## License

Proprietary, All Rights Reserved. Copyright (c) 2026 Shahin Hassanyan.

The source is published for portfolio viewing only. You may not copy, modify, run or redistribute it without written permission; see [LICENSE](LICENSE) for the full terms. To ask for permission, contact [Shahin-H2](https://github.com/Shahin-H2) on GitHub. Third-party parts keep their own terms: `yapper.js` (the Yapin’ bot SDK), the npm packages such as `@livekit/rtc-node` (Apache License 2.0), and the radio streams, which belong to their broadcasters.
