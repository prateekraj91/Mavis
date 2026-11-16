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
