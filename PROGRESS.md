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
- Pointer filter defaults: min cutoff 0.6 Hz, beta 8, derivative cutoff 1 Hz. In a parameter sweep this gave the best trade-off: 3.3x less jitter on a still hand, with about 0.015 (1.5% of frame width) lag at the end of a fast reach. Tunable live via `jarvis.T.POINTER_*`.
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
- On this Mac, a different project's Vite server also listens on 127.0.0.1:5173, while Jarvis's listens on [::1]:5173. Chrome normally picks ::1 for `localhost`, but if the wrong app loads, stop the other server.

## Task 2: Real cursor control

Done:
- `server/native/jarvis-input.swift`: a small Swift program posting mouse events through Quartz (CoreGraphics `CGEvent`). The server spawns it once and writes one command per line: move, down, up, click (a second close click becomes a double click), scroll, status. Status reports the main display's bounds and whether Accessibility is granted.
  - Built by `npm install` (postinstall) or, if missing or stale, at helper start. The binary in `server/native/bin/` is git-ignored.
- `server/input.js`: spawns and respawns the helper, maps 0..1 display coordinates to points, caps scrolls, tracks the button. It also releases the button when the last page disconnects or the server exits (the Swift side releases on stdin EOF too).
  - `JARVIS_INPUT=dry` records commands instead of posting them, for tests.
- Server: WebSocket `/ws` (the `ws` package) for camera-rate moves in order, with the same origin check as HTTP. Routes: `GET /cursor/status`, `POST /cursor`, `GET|POST /cursor/calibration` (saved to `server/calibration.json`, git-ignored), `GET /cursor/dry`.
  - `JARVIS_PORT` and `JARVIS_DATA_DIR` env vars exist so tests do not collide with a running helper or overwrite your files.
- `web/src/cursor.js`: pure `CursorLogic` state machine:
  - The index fingertip, through the calibration rectangle, moves the cursor.
  - A quick pinch clicks where the cursor was 100 ms before the fingers closed (closing a pinch drags the fingertip).
  - Pinch held for 350 ms, or moved 3%, presses the button; moving drags; opening drops.
  - Two fingers (index + middle up, ring + pinky curled), held for 120 ms, scroll with the cursor frozen.
  - Optional dwell click: 900 ms within 1.2% of the screen, re-armed after moving 3% away.
  - Plus wiring: WebSocket with reconnect, Shift+C / Shift+K / Shift+W, and a Jarvis idle-timer reset while the cursor moves.
- `web/src/calibrate.js`: a four-corner calibration screen with a live fingertip dot. It records each corner after 0.9 s still, turns the corners into a rectangle (shrunk 5% so screen edges are easy to reach), and saves it to the helper.
- Voice: "cursor mode" / "mouse on" / "start the cursor", "cursor off" / "stop mouse mode", "calibrate", "dwell click on/off". HUD: a CURSOR chip, and the dwell charge on the ring.
- Tests:
  - `web/test/cursor.test.mjs` (20): mapping, move, jitter gate, click lookback, drag, early drag, scroll amount and direction, scroll debounce, release on hand loss and on sleep, dwell, calibration maths, still detector. Two are end-to-end through the real engine with synthetic landmarks.
  - `server/test/routes.test.mjs` (14, `cd server && npm test`): every cursor route and the WebSocket in dry-run mode.
  - The synthetic hand moved to `web/test/hand.mjs` and gained a `peace` pose.

Decisions:
- Quartz through a compiled Swift helper rather than nut.js. It needs only the Xcode command line tools already on this Mac, has no native npm build, and has the lowest latency (stdin, no process per event). nut.js's free npm builds were withdrawn in 2024, so it would not have installed cleanly.
- Cursor control is a mode, off by default: "cursor mode" or Shift+C. With it always on while awake, every pinch would click the real Mac and also fire the Spotify volume gesture. While it is on, profile gestures are paused, except thumbs up, which turns it off.
- Sleeping (fist, timeout, "sleep") turns cursor mode off, so a sleeping Jarvis can never click.
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
