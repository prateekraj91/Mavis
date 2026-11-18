# Progress

Log of autonomous work sessions: what was done, decisions made without asking, and known issues.

## Task 1: Fix lag

Done:
- Detection runs on a 320x240 copy of each camera frame (`T.DETECT_WIDTH/HEIGHT`, drawn into a canvas). The camera still captures at 640x480.
- MediaPipe loads with the GPU delegate and falls back to CPU if GPU fails to load, fails on a warm-up frame at start, or throws at run time (rebuilt on CPU once). The active delegate shows on the perf panel and the debug panel.
- Frames are driven by `requestVideoFrameCallback` (one call per new camera frame, with its capture time). The old worker timer stays as a fallback and takes over when the callbacks stall for 120 ms (`T.TIMER_TAKEOVER_MS`), for example in a hidden tab.
- One Euro filter (`web/src/filters.js`) on the pointer outputs: `hand` x,y (index fingertip) and `hand:move`. They now come from the raw landmarks through the filter instead of the EMA-smoothed landmarks. The EMA stays for pose/gesture classification so thresholds and tests are unchanged.
- Warm-up detection at start, so the first real frame does not pay for shader compilation (9 s in headless Chrome's software GL).
- The engine emits `perf` every 500 ms: FPS, capture-to-event latency (average and p95 over 2 s), detect time, delegate, input size, driver, and which clock the latency came from. A perf panel paints it (`/?perf` or `/?debug`, Shift+P toggles). `dev.html` prints the same line.
- HUD cursor lerp raised from 0.35 to 0.6, since the engine now does the smoothing.
- Tests: `web/test/filters.test.mjs`, 12 tests covering the One Euro filter (jitter cut, fast-move lag compared with a fixed low-pass, step settling, same-timestamp safety, reset), the perf meter, and that the engine's `hand` pointer is steadier than the raw fingertip. `npm test` now runs every `test/*.test.mjs`.

Decisions:
- Pointer filter defaults: min cutoff 0.6 Hz, beta 8, derivative cutoff 1 Hz. In a parameter sweep this gave the best trade-off: 3.3x less jitter on a still hand, with about 0.015 (1.5% of frame width) lag at the end of a fast reach. Tunable live via `mavis.T.POINTER_*`.
- Latency is measured from the frame's `captureTime` (from `requestVideoFrameCallback` metadata) to just after all events for that frame are dispatched. It does not include the HUD's paint or the helper round trip.

Measured (headless Chrome with a fake 20 fps camera and software GL, so only a sanity check; real numbers come from your Mac):

| Setup | FPS | Latency avg / p95 | Detect |
|---|---|---|---|
| GPU, 320x240 | 20 (camera rate) | 20 / 22 ms | 14 ms |
| GPU, 640x480 | 20 | 26 / 29 ms | 14 ms |
| CPU, 320x240 | 11 | 65 / 97 ms | 49 ms |

Known issues:
- Not tested on a real camera or GPU. Real hands may want different One Euro settings.
- The background timer path was exercised (it drives frames before the first video-frame callback), but not in a real hidden or occluded window.
- On this Mac, a different project's Vite server also listens on 127.0.0.1:5173, while Mavis's listens on [::1]:5173. Chrome normally picks ::1 for `localhost`, but if the wrong app loads, stop the other server.

## Task 2: Real cursor control

Done:
- `server/native/mavis-input.swift`: a small Swift program posting mouse events through Quartz (CoreGraphics `CGEvent`). The server spawns it once and writes one command per line: move, down, up, click (a second close click becomes a double click), scroll, status. Status reports the main display's bounds and whether Accessibility is granted.
  - Built by `npm install` (postinstall) or, if missing or stale, at helper start. The binary in `server/native/bin/` is git-ignored.
- `server/input.js`: spawns and respawns the helper, maps 0..1 display coordinates to points, caps scrolls, tracks the button. It also releases the button when the last page disconnects or the server exits (the Swift side releases on stdin EOF too).
  - `MAVIS_INPUT=dry` records commands instead of posting them, for tests.
- Server: WebSocket `/ws` (the `ws` package) for camera-rate moves in order, with the same origin check as HTTP. Routes: `GET /cursor/status`, `POST /cursor`, `GET|POST /cursor/calibration` (saved to `server/calibration.json`, git-ignored), `GET /cursor/dry`.
  - `MAVIS_PORT` and `MAVIS_DATA_DIR` env vars exist so tests do not collide with a running helper or overwrite your files.
- `web/src/cursor.js`: pure `CursorLogic` state machine:
  - The index fingertip, through the calibration rectangle, moves the cursor.
  - A quick pinch clicks where the cursor was 100 ms before the fingers closed (closing a pinch drags the fingertip).
  - Pinch held for 350 ms, or moved 3%, presses the button; moving drags; opening drops.
  - Two fingers (index + middle up, ring + pinky curled), held for 120 ms, scroll with the cursor frozen.
  - Optional dwell click: 900 ms within 1.2% of the screen, re-armed after moving 3% away.
  - Plus wiring: WebSocket with reconnect, Shift+C / Shift+K / Shift+W, and a Mavis idle-timer reset while the cursor moves.
- `web/src/calibrate.js`: a four-corner calibration screen with a live fingertip dot. It records each corner after 0.9 s still, turns the corners into a rectangle (shrunk 5% so screen edges are easy to reach), and saves it to the helper.
- Voice: "cursor mode" / "mouse on" / "start the cursor", "cursor off" / "stop mouse mode", "calibrate", "dwell click on/off". HUD: a CURSOR chip, and the dwell charge on the ring.
- Tests:
  - `web/test/cursor.test.mjs` (20): mapping, move, jitter gate, click lookback, drag, early drag, scroll amount and direction, scroll debounce, release on hand loss and on sleep, dwell, calibration maths, still detector. Two are end-to-end through the real engine with synthetic landmarks.
  - `server/test/routes.test.mjs` (14, `cd server && npm test`): every cursor route and the WebSocket in dry-run mode.
  - The synthetic hand moved to `web/test/hand.mjs` and gained a `peace` pose.

Decisions:
- Quartz through a compiled Swift helper rather than nut.js. It needs only the Xcode command line tools already on this Mac, has no native npm build, and has the lowest latency (stdin, no process per event). nut.js's free npm builds were withdrawn in 2024, so it would not have installed cleanly.
- Cursor control is a mode, off by default: "cursor mode" or Shift+C. With it always on while awake, every pinch would click the real Mac and also fire the Spotify volume gesture. While it is on, profile gestures are paused, except thumbs up, which turns it off.
- Sleeping (fist, timeout, "sleep") turns cursor mode off, so a sleeping Mavis can never click.
- The cursor logic lives in the page (testable under `npm test`); the server only maps and posts. Everything that touches the OS stays in `server/`.
- Calibration is stored by the helper (`server/calibration.json`) rather than in the browser, so it survives a cleared browser or a different port.
- Without calibration, the middle 70% of the camera frame maps to the whole display.
- Only the main display is driven.

Verified here:
- In headless Chrome with synthetic hands and a dry-run helper: nothing is sent while asleep; it moves once awake; a quick pinch sends exactly one click; nothing is sent after cursor off; the CURSOR chip shows and hides.
- The calibration screen records four corners, saves them, and the helper returns them.
- With the real Swift helper the server starts it, reads the display (1470x956 here), reports Accessibility not granted, and the helper exits with the server.

Known issues and untested:
- Real mouse events were never posted: this session has no Accessibility permission, so nothing here proves a click lands. First thing to check tomorrow.
- Scroll direction under your natural-scrolling setting is unverified (`C.SCROLL_NATURAL`).
- Multi-monitor: only the main display. Dwell progress shows only on the HUD's ring, which you cannot see while working in another app.
- No right-click yet.

## Task 3: Per-app profiles

Done:
- The Swift helper now reports the frontmost app (`front <pid> <bundleId> <name>`). It uses the NSWorkspace activation notification, plus a 0.5 s poll as a backstop. It also gained `key <code> <flags>`, which presses and releases one key through Quartz.
- `server/front.js` tracks the front app. When it is a browser (Chrome family or Safari), it reads the active tab's host through AppleScript once a second, because YouTube and Meet are tabs, not apps. Only the host leaves the helper, never the full URL. Changes are pushed over the WebSocket as `{t:'front', app, bundleId, host}` and readable at `GET /front`.
- `server/keys.js` parses combos like `cmd+shift+]` into macOS virtual key codes plus modifier flags. It knows letters, digits, punctuation, arrows, F-keys, return/tab/space/escape/delete, page up/down and home/end, and rejects anything else.
  - Navigation keys also get the Fn/keypad flags a real keyboard sends.
- `POST /key {combo}`: answers 400 for a bad combo and 403 with a readable reason if Accessibility is missing.
- Profiles: new JSON for Chrome (also matches Brave, Edge, Arc, Vivaldi, Safari), YouTube, VS Code (and Insiders, VSCodium, Cursor), Finder, Zoom, Google Meet, Keynote and PowerPoint. Spotify gained a `match` so it applies when the Spotify app is in front. The format is documented in `web/src/profiles.js`.
- `web/src/api.js` picks the profile:
  1. a matching browser tab host beats the browser app;
  2. else the front app's bundle id;
  3. else (Mavis's own tab, or an app with no profile) the open panel's profile, Spotify by default, as before.
  - New command `{action:'key', combo, label}`.
- HUD: a profile chip at the top (gold = from the front app, grey = panel), and each key gesture's label on the centre line.
- `web/src/socket.js` now owns the one WebSocket; `cursor.js` and `api.js` both use it.
- Tests: `web/test/profiles.test.mjs` (9):
  - every profile file is valid, with known gestures and combos the server's parser accepts;
  - all required apps are present;
  - bundle and host matching, look-alike hosts rejected, Mavis tab and unknown apps fall back.
  - Server: 4 more route tests for `/key` (codes, flags, rejects, origin) and front-app push.

Decisions:
- Gestures in an app without a profile keep controlling the panel (Spotify), as they did before this task, rather than doing nothing.
- Only Spotify and Files are "panel" profiles. Saying "open Chrome" therefore does not make Chrome the fallback, which would send Ctrl+Tab into the Mavis tab.
- Both Zoom and Meet, and both Keynote and PowerPoint, got profiles, since each is a small file.
- Some gestures fall through to Spotify where the app has no natural use for them (Chrome and Finder palm = play/pause), so music control stays one gesture away.
- Gesture choices per app (my picks, easy to change in the JSON):
  - Chrome: tabs on swipes, back on fist.
  - YouTube: the player's own K / J / L / F / M / Shift+N keys.
  - VS Code: editor tabs, command palette, save.
  - Finder: history, enclosing folder, open, Quick Look.
  - Zoom/Meet: mute, camera, raise hand.
  - Slides: arrows, play, Escape.

Verified here:
- In headless Chrome against a dry-run helper, simulated app switches change the chip correctly (Chrome, YouTube, Mavis tab → Spotify, VS Code, Notes → Spotify, Finder). Gestures send the right key codes, and cursor mode pauses them.
- With the real helper: switching Finder → Chrome on this Mac was reported correctly.

Known issues and untested:
- No real key event was posted (no Accessibility permission in this session).
- The AppleScript tab read was not run, to avoid an Automation prompt on your screen. YouTube and Meet detection is untested on the real browser.
- Tab polling is once a second, so switching tabs takes up to 1 s to change profile.
- Keys go to whichever app is in front. If Mavis's tab is in front, no keys are sent (the panel profile applies).
- Zoom's shortcuts work only in its meeting window. YouTube's need the player focused.

## Task 4: Custom gesture trainer

Done:
- `web/src/knn.js`: features and classifier.
  - Features: 20 landmarks relative to the wrist, scaled by hand size (wrist to middle knuckle), with x corrected for the frame's aspect. Depth counts half. That gives 60 numbers that ignore position and size but keep shape and orientation.
  - Classifier: k-nearest-neighbours (k=5). Each gesture gets its own "unknown" threshold: 2.5x its 90th-percentile spread between nearest siblings, clamped to 0.35..1.6 hand sizes. So untaught shapes are rejected even when only one gesture is taught.
  - Leave-one-out evaluation reports accuracy and mix-ups.
- Engine: `setCustomModel()`.
  - A taught pose must be recognised by at least 60% of neighbours for 350 ms, then fires `gesture:<name>` (plus `gesture` with `custom: true`).
  - Fires once per hold, only awake, outside the wake grace, with the normal cooldown. Not during a pinch.
  - `tapLandmarks()` feeds the trainer. The debug panel has a `custom` line.
- `web/src/trainer.js`: the "Teach Mavis a gesture" screen (Shift+T, "teach Mavis a gesture" / "new gesture", or `/?train`).
  - Name validation; the action is a key combo, a Spotify command, open app/site, cursor on/off, sleep, or nothing.
  - Recording: 3 s countdown, a 0.6 s settle, then 20 samples 100 ms apart.
  - The report shows the leave-one-out score, mix-ups with other taught gestures, and a warning when the shape reads as a built-in pose.
  - A live prediction box, then Save. A saved gesture can be edited (action only) or deleted (with confirm).
- Server: `GET|POST /gestures`, stored in `server/gestures.json` (one sample per line). `server/gestures.js` validates strictly:
  - names, not built-in, no duplicates;
  - 5-60 samples of 60 finite numbers;
  - at most 30 gestures;
  - actions limited to key / spotify / open / cursor / sleep / close / back, with combos checked by the key parser;
  - a 2 MB body limit for this route only.
- `api.js`: taught gestures run the active profile's mapping for that name if there is one, else their saved action. No gesture runs anything while the trainer is open. "Close" closes the trainer first.
- Tests:
  - `web/test/knn.test.mjs` (16): feature invariance; classifying noisy, moved and resized samples; rejecting untaught poses (with one or two taught); leave-one-out flagging duplicates; rounding for storage; engine firing (once per hold, not asleep, not on a short flicker, built-ins unaffected); landmark tap; server/page constants agree; trainer form round-trip.
  - Server: 3 more route tests (save and read back cleaned, a full 30x60 set fits, 10 kinds of bad file rejected with reasons).
  - Voice: 4 more phrases.

Decisions:
- KNN over a tiny MLP: it trains instantly, works from 20 samples, needs no tuning, gives a natural "none of these" via distance, and its leave-one-out check is a free quality report. An MLP would need negative examples to say "none".
- Static hand shapes only (one frame each, held 350 ms). Moving gestures (a circle, a wave) would need sequence models and much more data.
- The trainer saves through the helper (`server/gestures.json`, not git-ignored, so you can commit your gestures if you like), not browser storage.
- A taught gesture's action is global. A profile can override it per app by naming the gesture in its JSON.
- Taught names may not reuse built-in names, and the trainer warns (but does not block) when a taught shape looks like a built-in pose, since both would fire.

Bug found and fixed while testing:
- Recording started the instant the countdown ended, so the first samples caught the hand still in its previous shape. In the browser test, a pointing finger was then recognised as "peace" and fired a second time. A 0.6 s settle before sampling fixed it; one hold now fires exactly once.

Verified here (headless Chrome, synthetic hands, dry-run helper):
- Shift+T opens the trainer; a built-in name is refused; recording a peace sign scores 100%; Live shows `peace` for it and `–` for a palm.
- Save writes the file and the list updates; nothing fires while the trainer is open.
- After closing: awake, one held peace sign fires once and presses shift+cmd+t (dry log); asleep, nothing.

Known issues and untested:
- Never tried on real hands. Real landmark noise may need `KNN.REJECT_FACTOR` or `MIN_THRESHOLD` tuned. Both are named constants in `web/src/knn.js`.
- Left and right hands differ in features. Teach with the hand you will use.
- The `custom_` hack in profile checking was removed; profiles may name taught gestures, but the profile test only checks the shipped files against built-in names.

## Task 5: Rename to Mavis

Done:
- Renamed the app from Jarvis to Mavis in all code, HUD text, titles, comments, docs, package names, tests and log messages.
- Wake words are now `mavis` plus likely mishearings (mavus, mavice, mavies, maves, "mave is", "may vis", mavic, mavees). "teach Mavis a gesture" opens the trainer. The old name no longer wakes anything.
- `window.mavis` replaces the old browser global (console tips updated: `mavis.T...`).
- Swift helper is now `server/native/mavis-input.swift`, built to `server/native/bin/mavis-input`. The stale old binary was deleted (it was ignored build output).
- Env vars are now `MAVIS_PORT`, `MAVIS_DATA_DIR`, `MAVIS_INPUT`.
- package names: `mavis-web`, `mavis-helper`.

Decisions and unusual things:
- No storage migration was needed: nothing uses localStorage, and the saved files (`server/calibration.json`, `gestures.json`, `today.json`) never had the old name in their file names, so calibration and taught gestures carry over as is.
- `normalise()` strips apostrophes before matching, so the requested "mavis's" spelling could never match. It is listed as `maviss`, which is what "Mavis's" becomes; a test covers it. The duplicate "mavus" in the request was listed once.
- If `server/.env` sets any of the old-named env vars (port, data dir, dry run), rename them by hand; I did not open `.env`. Spotify keys are unaffected.
- macOS may ask for Accessibility again because the helper binary has a new name. If the cursor does not move, check System Settings → Privacy & Security → Accessibility.
- `server/package-lock.json` had an uncommitted `hasInstallScript` line from npm; it is correct and was committed with the rename.

- Before pushing: `.gitignore` now also lists `server/.env` and `web/public/models/`. The 7.8 MB hand model was tracked; it is now untracked (still on disk). `npm install` in `web/` downloads it, with Google's CDN as fallback. No `.env` was ever committed, and no keys or tokens were found in any commit.

Tests: web `npm test` and server `npm test` all pass.
