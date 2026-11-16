// JARVIS helper: the only part that touches the OS. Listens on localhost:7777.
//   POST /open     {target}                 open an app or a site
//   POST /spotify  {action, query?, level?} control the Spotify desktop app
//   GET  /state                             system stats + Spotify state for the HUD
//   GET  /today                             today list from today.json
//   GET  /fs?path=                          list a folder inside home (name, ~/path or full path)
//   GET  /cursor/status                     cursor helper: ready, Accessibility permission, screen
//   POST /cursor   {op, x, y, dx, dy}       move | down | up | click | scroll (x,y display 0..1)
//   GET|POST /cursor/calibration {x0,y0,x1,y1}   camera area that maps to the display
//   WS   /ws                                 low-latency channel: {t:'cursor', op, ...} in,
//                                            {t:'input', ...status} out
// POST /open also takes {path} to open a file found through /fs.
import express from 'express';
import { WebSocketServer } from 'ws';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

// Load server/.env before spotify.js reads the keys (Node 20 has no --env-file-if-exists).
try {
  for (const line of readFileSync(here('.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env: song search falls back to opening the search in Spotify */ }

const spotify = await import('./spotify.js');
const { stats } = await import('./system.js');
const { listFolder, findHomeFolder, openablePath, fsError } = await import('./files.js');
const input = await import('./input.js');

const PORT = Number(process.env.JARVIS_PORT) || 7777; // tests use another port
// calibration.json (and later gestures.json) live here. Tests point it at a temp folder.
const DATA_DIR = process.env.JARVIS_DATA_DIR || here('.');
const dataFile = (name) => join(DATA_DIR, name);
const HOST = '127.0.0.1'; // never reachable from the network
const ALLOWED_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const APP_NAME_RE = /^[\p{L}\p{N} .+&'-]{1,60}$/u;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/;
const CALIBRATION_FILE = 'calibration.json';
// Until you calibrate: the middle 70% of the camera frame maps to the whole display.
const DEFAULT_CALIBRATION = { x0: 0.15, y0: 0.15, x1: 0.85, y1: 0.85, default: true };
const MIN_CALIBRATION_SPAN = 0.1; // of the camera frame
const WS_MAX_BYTES = 4096;

const run = promisify(execFile);
const targets = JSON.parse(readFileSync(here('targets.json'), 'utf8'));

const app = express();

// Only the Jarvis page may call this server. JSON-only POSTs force a CORS
// preflight, so another website cannot make your Mac open things.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    if (!ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ ok: false, error: 'Origin not allowed' });
    res.set({
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (req.method === 'POST' && !req.is('application/json')) {
    return res.status(415).json({ ok: false, error: 'Send JSON' });
  }
  next();
});
app.use(express.json({ limit: '10kb' }));

export function resolveTarget(raw) {
  const text = String(raw ?? '').trim();
  const key = text.toLowerCase().replace(/\s+/g, ' ').replace(/ dot /g, '.');
  if (!key) return null;
  if (targets.apps[key]) return { kind: 'app', name: targets.apps[key] };
  if (targets.sites[key]) return { kind: 'url', name: key, url: targets.sites[key] };
  if (/^https?:\/\//i.test(text)) {
    try { return { kind: 'url', name: new URL(text).hostname, url: new URL(text).href }; } catch { return null; }
  }
  if (DOMAIN_RE.test(key)) return { kind: 'url', name: key.split('/')[0], url: `https://${key}` };
  if (APP_NAME_RE.test(text)) return { kind: 'app', guess: true, name: text.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) };
  return null;
}

app.post('/open', async (req, res) => {
  // A file picked in the folder browser.
  if (req.body?.path) {
    try {
      const file = await openablePath(req.body.path);
      await run('open', [file], { timeout: 8000 });
      return res.json({ ok: true, kind: 'file', name: file.split('/').pop() });
    } catch (err) {
      return res.status(400).json({ ok: false, error: fsError(err) });
    }
  }
  const t = resolveTarget(req.body?.target);
  // Not a known app or site: a folder in home wins over guessing an app name.
  if (!t || t.guess) {
    const folder = await findHomeFolder(req.body?.target).catch(() => null);
    if (folder) return res.json({ ok: true, kind: 'folder', name: folder.split('/').pop(), path: folder });
  }
  if (!t) return res.status(400).json({ ok: false, error: 'Nothing to open' });
  try {
    await run('open', t.kind === 'app' ? ['-a', t.name] : [t.url], { timeout: 8000 });
    res.json({ ok: true, kind: t.kind, name: t.name });
  } catch {
    res.status(404).json({ ok: false, kind: t.kind, name: t.name, error: `Could not open ${t.name}` });
  }
});

app.post('/spotify', async (req, res) => {
  const { action, query, level } = req.body ?? {};
  try {
    res.json(await spotify.control(String(action ?? ''), { query, level }));
  } catch (err) {
    res.status(500).json({ ok: false, error: cleanError(err) });
  }
});

app.get('/state', async (_req, res) => {
  const [sys, sp] = await Promise.all([stats(), spotify.state().catch(() => null)]);
  res.json({ ...sys, spotify: sp });
});

app.get('/fs', async (req, res) => {
  try {
    res.json(await listFolder(req.query.path));
  } catch (err) {
    res.status(400).json({ ok: false, error: fsError(err) });
  }
});

// ── cursor ──
app.get('/cursor/status', (_req, res) => res.json(input.status()));

app.post('/cursor', (req, res) => {
  const r = input.cursor(req.body);
  res.status(r.ok ? 200 : 400).json(r);
});

export function validCalibration(c) {
  const v = ['x0', 'y0', 'x1', 'y1'].map((k) => Number(c?.[k]));
  if (!v.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) return null;
  const [x0, y0, x1, y1] = v;
  if (x1 - x0 < MIN_CALIBRATION_SPAN || y1 - y0 < MIN_CALIBRATION_SPAN) return null;
  return { x0, y0, x1, y1 };
}

app.get('/cursor/calibration', async (_req, res) => {
  try {
    const c = validCalibration(JSON.parse(await readFile(dataFile(CALIBRATION_FILE), 'utf8')));
    res.json(c ?? DEFAULT_CALIBRATION);
  } catch {
    res.json(DEFAULT_CALIBRATION);
  }
});

app.post('/cursor/calibration', async (req, res) => {
  const c = validCalibration(req.body);
  if (!c) return res.status(400).json({ ok: false, error: `Calibration needs x0<x1 and y0<y1 in 0..1, each span at least ${MIN_CALIBRATION_SPAN}` });
  await writeFile(dataFile(CALIBRATION_FILE), JSON.stringify(c, null, 2) + '\n');
  res.json({ ok: true, ...c });
});

// Dry-run only (JARVIS_INPUT=dry): the commands that would have been posted.
app.get('/cursor/dry', (_req, res) => {
  const log = input.dryCommands();
  if (!log) return res.status(404).json({ ok: false, error: 'Only in dry-run mode (JARVIS_INPUT=dry)' });
  res.json({ ok: true, commands: log });
});

app.get('/today', async (_req, res) => {
  try {
    const data = JSON.parse(await readFile(here('today.json'), 'utf8')); // re-read so edits show up
    res.json({ items: Array.isArray(data.items) ? data.items : [] });
  } catch {
    res.json({ items: [] });
  }
});

function cleanError(err) {
  const msg = String(err?.stderr || err?.message || err);
  if (/not allowed|-1743|not authorized/i.test(msg)) {
    return 'macOS blocked this. Allow Terminal under System Settings > Privacy & Security > Automation (and Accessibility for "like").';
  }
  if (/ENOENT/.test(msg)) return 'osascript not found (the helper only works on macOS)';
  return msg.split('\n')[0].slice(0, 200);
}

const server = app.listen(PORT, HOST, () => {
  console.log(`Jarvis helper on http://localhost:${PORT}`);
  if (!spotify.hasKeys()) console.log('No Spotify keys in server/.env: "play <song>" will only open the search in Spotify.');
});

// ── WebSocket: cursor moves at camera rate, in order, without a request per frame ──
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_BYTES });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  // Same rule as HTTP: only the Jarvis page. Browsers always send Origin on WebSockets.
  if (pathname !== '/ws' || !ALLOWED_ORIGINS.has(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

const broadcast = (msg) => { const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };
input.onInputChange(broadcast);

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'input', ...input.status() }));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg?.t === 'cursor') {
      const r = input.cursor(msg);
      if (!r.ok) ws.send(JSON.stringify({ t: 'cursor:error', error: r.error }));
    }
  });
  // Page closed or reloaded mid-drag: let go of the button.
  ws.on('close', () => { if (wss.clients.size === 0) input.releaseButton(); });
});

input.startInput().then(() => {
  const s = input.status();
  if (s.error) console.log(s.error);
  else if (s.dry) console.log('Cursor helper: dry run (JARVIS_INPUT=dry), nothing is posted to macOS.');
});
