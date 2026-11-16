// Spotify desktop control through AppleScript, plus Web API search (client credentials).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VOLUME_STEP = 8;
const SETTLE_MS = 180; // let Spotify update before reading state back
const LAUNCH_TIMEOUT_MS = 10000;
const SEARCH_LIMIT = 5; // dev-mode apps are capped at 10

const osa = async (script) => (await run('osascript', ['-e', script], { timeout: 6000 })).stdout.trim();
const tell = (cmd) => osa(`tell application "Spotify" to ${cmd}`);

export const hasKeys = () => !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);

async function isRunning() {
  return (await osa('application "Spotify" is running')) === 'true';
}

async function ensureRunning() {
  if (await isRunning()) return;
  await run('open', ['-a', 'Spotify']);
  const until = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < until) {
    await sleep(400);
    if (await isRunning()) { await sleep(1500); return; } // give it a moment to accept commands
  }
  throw new Error('Spotify did not start');
}

// Does not launch Spotify: asks "is running" first.
const STATE_SCRIPT = `
if application "Spotify" is not running then return "off"
tell application "Spotify"
  set ps to (player state as string)
  set vol to sound volume
  try
    set t to current track
    set pos to player position
    return ps & linefeed & vol & linefeed & (id of t) & linefeed & (name of t) & linefeed & (artist of t) & linefeed & (album of t) & linefeed & (duration of t) & linefeed & pos & linefeed & (artwork url of t)
  on error
    return "stopped" & linefeed & vol
  end try
end tell`;

export async function state() {
  const out = await osa(STATE_SCRIPT);
  if (out === 'off') return { running: false, playing: false };
  const [ps, vol, id, title, artist, album, duration, pos, artUrl] = out.split('\n');
  const base = { running: true, playing: ps === 'playing', volume: Number(vol) || 0 };
  if (!id) return base;
  return {
    ...base,
    trackId: id,
    title,
    artist,
    album,
    durationMs: Number(duration) || 0,
    positionMs: Math.round(parseFloat(String(pos).replace(',', '.')) * 1000) || 0, // some locales print 12,5
    artUrl: /^https:\/\//.test(artUrl || '') ? artUrl : '',
  };
}

async function setVolume(level) {
  const target = Math.max(0, Math.min(100, Math.round(Number(level))));
  if (!Number.isFinite(target)) throw new Error('Volume needs a number');
  await tell(`set sound volume to ${target}`);
  // Spotify often lands one below what was asked; nudge once so steps do not drift down.
  const got = Number(await tell('sound volume'));
  if (got < target && target < 100) await tell(`set sound volume to ${target + 1}`);
  return target;
}

// ── Web API search ──
let token = { value: '', expires: 0 };

async function getToken() {
  if (!hasKeys()) throw new Error('No Spotify keys in server/.env');
  if (token.value && Date.now() < token.expires) return token.value;
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`Spotify rejected the keys (${r.status})`);
  const j = await r.json();
  token = { value: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 };
  return token.value;
}

export async function search(query) {
  const url = `https://api.spotify.com/v1/search?type=track&limit=${SEARCH_LIMIT}&q=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` } });
  if (!r.ok) throw new Error(`Spotify search failed (${r.status})`);
  const item = (await r.json()).tracks?.items?.[0];
  if (!item || !/^spotify:track:[A-Za-z0-9]{22}$/.test(item.uri)) return null;
  return { uri: item.uri, title: item.name, artist: (item.artists || []).map((a) => a.name).join(', ') };
}

// ── actions ──
const NEEDS_RUNNING = new Set(['next', 'previous', 'playpause', 'pause', 'volume_up', 'volume_down', 'set_volume', 'like']);

export async function control(action, { query, level } = {}) {
  if (NEEDS_RUNNING.has(action) && !(await isRunning())) {
    return { ok: false, error: 'Spotify is not open', state: { running: false, playing: false } };
  }
  let extra = {};
  switch (action) {
    case 'state': break;
    case 'next': await tell('next track'); break;
    case 'previous': await tell('previous track'); break;
    case 'playpause': await tell('playpause'); break;
    case 'pause': await tell('pause'); break;
    case 'resume': await ensureRunning(); await tell('play'); break;
    case 'volume_up':
    case 'volume_down': {
      const cur = Number(await tell('sound volume')) || 0;
      return { ok: true, volume: await setVolume(cur + (action === 'volume_up' ? VOLUME_STEP : -VOLUME_STEP)) };
    }
    case 'set_volume': return { ok: true, volume: await setVolume(level) };
    case 'like':
      // Spotify has no AppleScript "like": press its shortcut (Option+Shift+B).
      // Needs Accessibility permission, brings Spotify to the front, and toggles.
      await osa('tell application "Spotify" to activate\ndelay 0.3\ntell application "System Events" to keystroke "b" using {option down, shift down}');
      break;
    case 'play': {
      const q = String(query ?? '').trim().slice(0, 120);
      if (!q) { await ensureRunning(); await tell('play'); break; }
      await ensureRunning();
      let track = null;
      let reason = 'No song found';
      try { track = await search(q); } catch (err) { reason = err.message; }
      if (!track) {
        await run('open', [`spotify:search:${encodeURIComponent(q)}`]);
        return { ok: false, fallback: 'search', error: reason, state: await state() };
      }
      await tell(`play track "${track.uri}"`);
      extra = { track };
      await sleep(400);
      break;
    }
    default:
      return { ok: false, error: `Unknown Spotify action "${action}"` };
  }
  await sleep(SETTLE_MS);
  return { ok: true, ...extra, state: await state() };
}
