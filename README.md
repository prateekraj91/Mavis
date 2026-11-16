# Jarvis gesture shell

Control a Mac with hand gestures and voice, but only after saying "Jarvis". A HUD boots in Chrome, Spotify opens as a centre panel, and folders open as a grid of floating cards. While asleep, gestures do nothing.

Status: all the code for the wake gate, HUD, Spotify control, voice and folder browser is written. It has been tested with synthetic hands, a fake speech recogniser and a headless browser, never on a Mac with a real camera. The checklist below is that first real test.

## What you need

- macOS, Google Chrome, a webcam and microphone
- Node 20 or newer
- The Spotify desktop app
- Internet: Chrome's speech recognition sends audio to Google. Camera frames stay in memory on your machine.

## Setup

```
cd jarvis/server
npm install

cd ../web
npm install
```

`npm install` in `web/` also downloads the hand-tracking model into `web/public/models/`. If that fails, the page loads the model from Google's CDN instead.

### Spotify keys (for "play <song>")

1. Create an app at https://developer.spotify.com/dashboard. Spotify currently requires the developer account to have Premium.
2. Copy `server/.env.example` to `server/.env` and fill in the client ID and secret.

Without keys everything else works; "play <song>" opens the search in Spotify instead of playing.

## Run

Two terminals:

```
cd jarvis/server && npm start      # helper on localhost:7777
cd jarvis/web && npm run dev       # page on localhost:5173
```

Open http://localhost:5173 in Chrome and click Start.

| URL | What it is |
|---|---|
| `/` | The real thing |
| `/?debug` | Same, with the live gesture values panel (Shift+D toggles it) |
| `/?demo` | HUD with fake data and keyboard control, no helper or voice. Good for recording. |
| `/?accent=cyan` | Cyan instead of gold |
| `/dev.html` | Bare gesture test page with an event log |

Demo keys: W wake, S sleep, O Spotify panel, Space play/pause, arrows track and volume, L like, F folder browser, B back, V fake voice line.

## Using it

Wake: say "Jarvis", or hold an open palm for 1 second.
Sleep: say "Jarvis, sleep", hold a fist for 2 seconds, or leave it idle for 30 seconds.

| Gesture | Spotify | Folder browser |
|---|---|---|
| Swipe right / left | next / previous track | next / previous page |
| Open palm, 0.6 s | play / pause | |
| Pinch and move up / down | volume | |
| Quick pinch | | open the card under the hand |
| Thumbs up | like | |
| Short fist | | back |
| Fist, 2 s | sleep | sleep |

Voice, once awake (the word "Jarvis" is optional then):

- "open Spotify", "open VS Code", "open YouTube", "open Downloads"
- "play <song>", "pause", "resume", "next", "previous"
- "volume up", "volume down", "set volume to 40", "like this song"
- "back", "close", "sleep"

In the folder browser, "open <name>" opens the item with that name in the current folder.

## Changing things

| To change | Edit |
|---|---|
| Gesture thresholds | `T` at the top of `web/src/gestures.js`, or live in the console: `jarvis.T.SWIPE_MIN_DX = 0.2` |
| Wake word spellings, language | `V` at the top of `web/src/voice.js` |
| What a gesture does in an app | `web/profiles/<app>.json` (one file per app) |
| Names that "open ..." understands | `server/targets.json` |
| Today list | `server/today.json` (re-read every wake) |
| Cursor feel (click, drag, scroll, dwell) | `C` at the top of `web/src/cursor.js` |
| Custom gestures | Shift+T or "teach Jarvis a gesture"; saved in `server/gestures.json` |

New since the first checklist: cursor control, per-app profiles, a perf panel and custom gestures. Their camera tests are in `TESTING.md`, and what was built and decided is in `PROGRESS.md`.

## Mac test checklist

Work through these in order. Each step says what should happen and what to do if it doesn't.

### 1. Permissions

macOS asks for most of these the first time they are needed. "Terminal" below means whichever app runs `npm start` (Terminal, iTerm, VS Code).

- [ ] Click Start: Chrome asks for camera and microphone. Allow both.
  - If nothing happens: System Settings > Privacy & Security > Camera and Microphone, turn on Google Chrome, then restart Chrome.
- [ ] First Spotify command: macOS asks to let Terminal control Spotify. Allow.
  - If you clicked Don't Allow: Privacy & Security > Automation > Terminal > turn on Spotify.
- [ ] First thumbs up: macOS asks to let Terminal control System Events, and needs Accessibility. Privacy & Security > Accessibility > add Terminal.
- [ ] First "open Downloads": macOS asks to let Terminal read the folder. Allow. Same for Desktop and Documents.
  - If the HUD says macOS blocked the folder: Privacy & Security > Files and Folders > Terminal.

### 2. Wake gate

- [ ] Asleep: wave, swipe, pinch, make a fist. Nothing happens.
- [ ] Say "Jarvis": HUD boots in under 2 seconds.
  - If it never wakes: open `/?debug`, wake with a palm, and read the voice pill to see how Chrome spells what you say. Add that spelling to `WAKE_WORDS` in `voice.js`. If recognition is poor overall, change `LANG` to `en-US`.
- [ ] Hold an open palm for 1 second while asleep: it wakes, and the music does not pause.
- [ ] Hold a fist for 2 seconds: it sleeps.
- [ ] Leave it awake and untouched for 30 seconds: it sleeps.

### 3. Gestures (use `/?debug`)

Good front lighting matters more than any threshold.

- [ ] Swipe right: one "Next track", and the hand coming back does not fire "Previous track".
- [ ] Open palm 0.6 s: play/pause toggles once per hold.
- [ ] Pinch and move up, then down: volume follows in steps.
- [ ] Thumbs up: fires once.
- [ ] No gesture fires twice from one motion.
- If a gesture is missed or fires by accident, watch its line in the debug panel while you make it, and move the matching threshold in `T`. The panel prints each live value next to its threshold.

### 4. Spotify

- [ ] "Jarvis, open Spotify": the app opens and the centre panel appears with the current track.
- [ ] "Pause", "resume", "next", "previous", "set volume to 40" each work.
- [ ] The panel's progress bar, title and album art match Spotify within about 2 seconds.

### 5. Spotify search fallback

"Play <song>" searches through Spotify's Web API. Spotify tightened that API in 2026, so this is the step most likely to fail.

- [ ] With keys in `server/.env`, say "play <a well-known song>". Expected: the HUD says "Playing <title>" and the song starts.
- [ ] If instead the HUD says a reason followed by "Showing the search in Spotify", the helper fell back. The reason tells you which case you are in:
  - "No Spotify keys in server/.env": the keys are missing or the helper was not restarted after adding them.
  - "Spotify rejected the keys (400 or 401)": wrong ID or secret.
  - "Spotify search failed (403)" or "(401)": the keys are fine but Spotify refuses search for this kind of login. The fix is a code change (a user login flow in `server/spotify.js`), not a setting.
  - "No song found": the search worked and returned nothing.
- [ ] Remove the keys, restart the helper, and say "play <song>": Spotify shows the search results and the HUD explains why. This confirms the fallback itself.

### 6. Like shortcut (Option+Shift+B)

Spotify has no scriptable "like", so the helper brings Spotify to the front and presses Option+Shift+B.

- [ ] In Spotify itself, press Option+Shift+B by hand with a song playing. The heart should toggle. If it doesn't, your Spotify version uses a different shortcut: check Spotify's keyboard shortcut list (Cmd+/ in the app) and change the keystroke in `server/spotify.js` (`case 'like'`).
- [ ] Thumbs up, or say "like this song": Spotify comes to the front and the heart toggles.
- [ ] Note that it toggles: a second thumbs up on the same song removes the like. The heart in the HUD only tracks likes made through Jarvis in this session.
- [ ] After the like, Spotify is in front of Chrome. Check gestures still work (this is the next test).

### 7. Background tracking

Gestures have to keep working while another app is in front. The engine ticks from a worker timer for this reason, but Chrome may still pause a hidden page. Wake Jarvis, start a song, then try a swipe in each situation:

- [ ] A. Chrome visible, another app focused (click on Spotify, leave Chrome showing beside it).
- [ ] B. Chrome window fully covered by another window.
- [ ] C. Jarvis in a background tab of Chrome, another tab in front.
- [ ] D. Chrome minimised.
- [ ] In each case also say "next" to check voice.

A should work. B, C and D are unknown until tested. If one fails:

- Keep Jarvis in its own Chrome window and leave at least part of it visible.
- If B fails, try starting Chrome with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`. This may help; it is untested here.
- D is the least likely to work, and there may be no fix short of not minimising.

### 8. Folder browser

- [ ] "Open Downloads": cards fly out from the centre and the side panels step aside.
- [ ] Move your hand: a card lifts under the ring cursor and the grid tilts toward the hand.
- [ ] Quick pinch on a folder card: it opens that folder. On a file card: the file opens in its default app.
- [ ] Short fist, or say "back": up one level.
- [ ] Swipe: next page (15 cards per page).
- [ ] "Open <a file or folder name you can see>": it opens.
- [ ] "Close": back to the rings.
- If the pinch opens the wrong card: the pinch opens whichever card was lifted just before you pinched, so hover first, then pinch without moving.

## Limits and safety

- The helper listens on 127.0.0.1 only and accepts requests only from the Jarvis page, so other websites cannot use it.
- The folder browser cannot leave your home folder, hides dotfiles, lists at most 300 items per folder, and refuses to open apps, scripts and installers.
- No video or audio is stored by this code.

## Not built yet

- A start script and launch at login.

## Layout

```
jarvis/
  server/
    index.js        routes: /open /spotify /state /today /fs
    spotify.js      AppleScript control, Web API search
    system.js       CPU, memory, battery
    files.js        folder listing, path checks
    targets.json    app and site names
    today.json      today list
  web/
    index.html      HUD markup and startup
    dev.html        gesture test page
    src/gestures.js gesture engine and state machine
    src/voice.js    wake word and command parser
    src/api.js      helper calls, gesture/voice/click dispatcher
    src/hud.js      HUD (events in, paint out)
    src/files.js    folder browser view
    src/demo.js     fake data for /?demo
    profiles/       one JSON per app
    test/           npm test
```
