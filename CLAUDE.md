# Mavis
Wake-word-gated gesture + voice shell for macOS. web/ = Chrome page (MediaPipe gestures, HUD, voice). server/ = Node helper on localhost:7777 (AppleScript, open, fs).
Rules: gestures are ignored while asleep. hud.js only paints events, no app logic. Engine thresholds are named constants. No runtime LLM calls. Keep Spotify/AppleScript calls in server/.
Run: cd server && npm start; cd web && npm run dev. Tests: cd web && npm test.
I test with a real camera, so after each task leave a short manual test list in TESTING.md.
