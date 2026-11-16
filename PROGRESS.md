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
