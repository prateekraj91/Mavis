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
