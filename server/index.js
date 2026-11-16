// JARVIS helper: the only part that touches the OS. Listens on localhost:7777.
//   POST /open     {target}                 open an app or a site
//   POST /spotify  {action, query?, level?} control the Spotify desktop app
//   GET  /state                             system stats + Spotify state for the HUD
//   GET  /today                             today list from today.json
//   GET  /fs?path=                          list a folder inside home (name, ~/path or full path)
// POST /open also takes {path} to open a file found through /fs.
import express from 'express';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

const PORT = 7777;
const HOST = '127.0.0.1'; // never reachable from the network
const ALLOWED_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const APP_NAME_RE = /^[\p{L}\p{N} .+&'-]{1,60}$/u;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/;

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

app.listen(PORT, HOST, () => {
  console.log(`Jarvis helper on http://localhost:${PORT}`);
  if (!spotify.hasKeys()) console.log('No Spotify keys in server/.env: "play <song>" will only open the search in Spotify.');
});
