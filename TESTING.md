# Manual camera tests

The automated tests (`cd web && npm test`) use synthetic hands. These steps need you, a real camera and a Mac. The README's Mac test checklist still applies; this file covers only the newer work, one section per task.

Start both halves first:

```
cd server && npm start
cd web && npm run dev
```

## Task 1: Lag (perf panel, One Euro pointer)

Open http://localhost:5173/?perf and click Start. The perf panel is at the bottom right; Shift+P shows or hides it.

- [ ] The panel's note line says `GPU · 320x240 · video-frame · from capture`.
  - `CPU` means the GPU delegate failed. Look in the Chrome console for a `[jarvis] GPU delegate failed` warning.
  - `from receive` or `from callback` means Chrome gave no capture time, so the latency figure reads low.
- [ ] FPS is about 30 (your camera's rate). Latency is under about 50 ms, and p95 under 80 ms. Red figures mean FPS is below 20 or latency is above 80 ms.
- [ ] Hold your hand still, awake: the ring cursor sits still and does not shimmer.
- [ ] Move your hand quickly across the frame: the ring keeps up with no visible rubber-banding.
- [ ] Switch to another app with Chrome still visible: the panel's driver may change to `timer`, and gestures still work (README section 7).
- [ ] Note your FPS and latency numbers in PROGRESS.md so later changes can be compared.

If the cursor is too jumpy when still, lower `jarvis.T.POINTER_MIN_CUTOFF` (e.g. 0.4). If it lags on fast moves, raise `jarvis.T.POINTER_BETA` (e.g. 15). Both apply live.

## Task 2: Real cursor control

First time only: `cd server && npm install` compiles `server/native/jarvis-input` (a minute or so). Then `npm start`. Once it is up, the helper's `/cursor/status` should say `"ready":true`.

- [ ] **Permission.** Open http://localhost:7777/cursor/status in a browser. If `"trusted":false`, add the app running `npm start` (Terminal, iTerm or VS Code) under System Settings > Privacy & Security > Accessibility, then restart the helper. Within about 4 seconds the status should show `"trusted":true`.
- [ ] **Calibrate.** Wake Jarvis and say "calibrate", or press Shift+K. For each glowing corner, reach to that corner of the area your hand can comfortably cover and hold still until the ring fills. The dashed box at the end shows the camera area that now covers the screen. Esc cancels.
- [ ] **Cursor on.** Say "cursor mode" or press Shift+C. A CURSOR chip appears at the top of the HUD.
- [ ] **Move.** Point with your index finger: the Mac cursor follows. All four screen edges are reachable without straining. Holding still, it should not shimmer.
- [ ] **Click.** Hover a Finder icon and do a quick pinch: it selects, and the click lands where the cursor was, not a few pixels lower. Two quick pinches open it (double click).
- [ ] **Drag.** Pinch and hold on a Finder window's title bar (about 0.35 s), move, then open your fingers: the window moves and drops.
- [ ] **Scroll.** Raise index and middle fingers with the others curled (peace sign) over a long web page. Move up and down: the page scrolls, and the cursor stays put.
  - If the direction feels backwards, set `C.SCROLL_NATURAL = false` in `web/src/cursor.js`.
- [ ] **Dwell.** Say "dwell click on" or press Shift+W. Rest the cursor on a button: the HUD ring charges, and it clicks once after about 0.9 s. It does not click again until you move away and back.
- [ ] **Gestures paused.** With Spotify playing and cursor mode on, a pinch must not change the volume and a swipe must not skip tracks.
- [ ] **Leave.** Thumbs up, "cursor off", or Shift+C turns it off. Hold a fist for 2 s: Jarvis sleeps and cursor mode turns off.
- [ ] **Safety.** Start a drag, then drop your hand out of view: the button is released (the window stops following). Do the same and close the Jarvis tab: the button is released too.
- [ ] **Idle.** Move the cursor for over 30 s without any other gesture: Jarvis stays awake.

## Task 3: Per-app profiles

The profile chip sits at the top of the HUD: gold means it came from the front app, grey means the Jarvis panel profile (Spotify or Files). To watch it while another app is in front, put Chrome with the Jarvis tab beside that app.

- [ ] **Permissions.** The first time a browser is in front, macOS asks to let Terminal control Google Chrome (to read the active tab's address). Allow it. If you said no, the HUD explains where to turn it on (Privacy & Security > Automation).
  - Keys also need the Accessibility permission from Task 2.
- [ ] **Switching.** Click into each app; the chip follows within about 1 s:
  - Finder → Finder
  - VS Code → VS Code
  - Spotify → Spotify
  - Chrome on any site → Chrome
  - a YouTube tab → YouTube
  - a meet.google.com tab → Google Meet
  - Zoom → Zoom
  - Keynote or PowerPoint → that app
  - Notes (no profile) → Spotify, grey
  - The Jarvis tab itself → Spotify, grey
- [ ] **Chrome.** Swipe right / left: next / previous tab. Fist: back. Pinch and move: scrolls by lines. Thumbs up: reload. Palm: Spotify play/pause.
- [ ] **YouTube.** Palm: play/pause (K). Swipe right / left: ±10 s. Thumbs up: next video. Fist: full screen. Quick pinch: mute. Pinch and move: volume.
  - Click the video once first so YouTube's player has keyboard focus.
- [ ] **VS Code.** Swipe: next / previous editor tab. Palm: command palette. Thumbs up: save. Fist: Escape. Pinch and move: page up / down.
- [ ] **Finder.** Swipe: forward / back. Fist: enclosing folder. Quick pinch: open the selection. Thumbs up: Quick Look. Pinch and move: up / down the list.
- [ ] **Zoom** (in a test meeting). Palm: mute / unmute. Fist: video. Thumbs up: raise hand. Zoom's shortcuts only work while its meeting window is focused.
- [ ] **Google Meet.** Palm: mute (Cmd+D). Fist: camera (Cmd+E). Thumbs up: raise hand (Ctrl+Cmd+H).
- [ ] **Keynote / PowerPoint.** Palm: start the show. Swipe: next / previous slide. Fist: end the show.
- [ ] **Labels.** Each key gesture shows its label (e.g. "Next tab") on the HUD centre line.
- [ ] **Cursor mode.** With cursor mode on, none of the above fire.
- [ ] **Manual /key check** (Terminal, with the helper running and a TextEdit window in front within 3 s):
  ```
  sleep 3; curl -s -X POST localhost:7777/key -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' -d '{"combo":"shift+h"}'
  ```
  An "H" appears.

To change what a gesture does in an app, edit `web/profiles/<app>.json` and reload the page. Combos are like `cmd+shift+t`; write `+` as `plus`.

## Task 4: Custom gesture trainer

- [ ] **Open.** Say "teach Jarvis a gesture", press Shift+T, or open http://localhost:5173/?train (after clicking Start).
- [ ] **Name check.** Type `palm`: it refuses (built-in). Type `Peace Sign`: it refuses (lowercase, digits, `_` only).
- [ ] **Record.** Name `peace`, choose "Press keys…", type `cmd+shift+t`, then click Record.
  - After the 3-2-1 and a short "Hold it…", hold a peace sign. Move it slightly closer, further and turned while the bar fills (about 2 s).
  - The report should say "Recognised 100%" or close to it.
- [ ] **Live box.** While the trainer is open:
  - holding the peace sign shows `peace` with a percentage;
  - an open palm, a fist or a pointing finger shows `–`.
  - If a different shape also shows `peace`, record again with more varied angles.
- [ ] **Save.** Click Save: it appears under Saved gestures with `shift+cmd+t · 20 samples`. `server/gestures.json` now exists.
- [ ] **Use it.** Close the trainer (Esc), then:
  - In Chrome, close a tab, wake Jarvis and hold a peace sign about 0.4 s: the tab reopens, once per hold.
  - Asleep, the same pose does nothing.
  - While the trainer is open, it does nothing either.
- [ ] **Built-in look-alike.** Try teaching an open palm under another name: the report should warn that it looks like the built-in palm.
- [ ] **Confusion check.** Teach two gestures that differ by one finger (e.g. `two` = peace, `three` = index + middle + ring). Both should score ≥ 90% and the Live box should tell them apart. If it warns about mix-ups, the shapes are too similar for the camera.
- [ ] **Edit and delete.** Click a saved gesture's name, change its action to "Spotify: next track", and Save without recording: the samples are kept and the new action applies. Delete asks first, then removes it.
- [ ] **Profile override.** Optional: add `"peace": {"action":"key","combo":"k","label":"Play"}` to `web/profiles/youtube.json`. In a YouTube tab the peace sign then presses K instead of its saved action.
- [ ] **Debug.** On `/?debug`, the `custom` line shows the live prediction and its distance; use it to judge how close a near-miss was.
