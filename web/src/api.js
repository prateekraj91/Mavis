// Calls to the helper, and the dispatcher that turns gestures, voice commands
// and HUD clicks into actions. Reports what happened as HUD events.
//
//   const api = startApi({ engine });
//   api.execute({ action: 'spotify', do: 'next' });
//
// Commands
//   {action:'spotify', do:'next'|'previous'|'playpause'|'pause'|'resume'|'like'|'volume_up'|'volume_down'}
//   {action:'spotify', do:'set_volume', level}
//   {action:'spotify', do:'play', query}
//   {action:'open', target}        {action:'close'}        {action:'sleep'}
//   {action:'files', do:'open'|'back'|'next_page'|'prev_page'}     {action:'back'}
//   {action:'cursor', do:'on'|'off'|'calibrate'|'dwell_on'|'dwell_off'}
//   {action:'key', combo:'cmd+shift+t', label?}    press keys in the front app (helper /key)
//
// Cursor mode (cursor.js): while it is on, gestures do not run profile commands, so a
// pinch-click cannot also change the volume. Thumbs up leaves cursor mode.
//
// Folder browser: this file fetches listings (GET /fs) and sends `files:list`;
// files.js draws them and answers `files:activate` with `files:pick {path, type, name}`.
//
// Profiles (format in profiles.js): every JSON file in web/profiles/ is loaded.
// Which one maps gestures to commands:
//   1. the profile matching the front app or browser tab (helper pushes helper:front)
//   2. otherwise, or while Jarvis's own tab is in front, the open panel (Spotify / Files)
// The HUD is told with profile:change {name, source:'app'|'panel'}.
import { profileForFront } from './profiles.js';

const HELPER = 'http://localhost:7777';
const POLL_MS = 2000; // /state while awake
const DEFAULT_PROFILE = 'spotify'; // gestures work for this app before anything is opened
const VOLUME_STEP = 6; // per pinch step
const VOICE_VOLUME_STEP = 12; // "volume up"
const VOLUME_HOLD_MS = 1500; // ignore polled volume this long after setting it
const OFFLINE_NOTE_MS = 20000;
const CURSOR_EXIT_GESTURE = 'thumbs_up'; // the only gesture that acts while cursor mode is on

const LABELS = { next: 'Next track', previous: 'Previous track', pause: 'Paused', resume: 'Playing', like: 'Like toggled' };

const profiles = {};
for (const mod of Object.values(import.meta.glob('../profiles/*.json', { eager: true }))) {
  const p = mod.default ?? mod;
  if (p?.app) profiles[p.app.toLowerCase()] = p;
}
const profileList = Object.values(profiles);

async function call(path, body) {
  const r = await fetch(HELPER + path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return r.json();
}

export function startApi({ engine, cursor = null, bus = window }) {
  const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail || {}));
  const send = (type, detail = {}) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  const say = (text) => send('hud:say', { text });

  let panel = profiles[DEFAULT_PROFILE] ?? null; // centre panel's profile
  let frontProfile = null; // front app's profile
  let active = panel; // the one gestures use
  let tabErrorSaid = false;
  function refresh() {
    const next = frontProfile ?? panel;
    if (next === active) return;
    active = next;
    send('profile:change', { name: active?.app ?? '', source: frontProfile ? 'app' : 'panel' });
  }
  const known = { playing: false, volume: 50, trackId: '' };
  const liked = new Set();
  let volumeSetAt = 0;
  let offlineAt = -Infinity;

  async function helper(path, body) {
    try {
      return await call(path, body);
    } catch {
      if (performance.now() - offlineAt > OFFLINE_NOTE_MS) {
        offlineAt = performance.now();
        say('Helper is not running. Start it in server/ with npm start');
      }
      return null;
    }
  }

  function paintSpotify(s) {
    if (!s) return;
    if (!s.running || !s.trackId) {
      known.playing = false;
      known.trackId = '';
      send('spotify:state', { title: '', artist: '', artUrl: '', positionMs: 0, durationMs: 0, playing: false, liked: false });
      return;
    }
    known.playing = s.playing;
    known.trackId = s.trackId;
    const d = {
      title: s.title, artist: s.artist, artUrl: s.artUrl,
      positionMs: s.positionMs, durationMs: s.durationMs,
      playing: s.playing, liked: liked.has(s.trackId),
    };
    if (performance.now() - volumeSetAt > VOLUME_HOLD_MS) { known.volume = s.volume; d.volume = s.volume; }
    send('spotify:state', d);
  }

  // Volume: paint at once, send only the newest level (pinch steps arrive every 120 ms).
  let volumeBusy = false;
  let volumeNext = null;
  async function setVolume(level) {
    known.volume = Math.max(0, Math.min(100, Math.round(level)));
    volumeSetAt = performance.now();
    send('spotify:state', { volume: known.volume });
    volumeNext = known.volume;
    if (volumeBusy) return;
    volumeBusy = true;
    while (volumeNext !== null) {
      const v = volumeNext;
      volumeNext = null;
      const r = await helper('/spotify', { action: 'set_volume', level: v });
      if (r && !r.ok && r.error) say(r.error);
    }
    volumeBusy = false;
  }

  async function spotify(cmd, source) {
    const act = (label) => send('action', { action: 'spotify', do: cmd.do, label });
    switch (cmd.do) {
      case 'volume_up':
      case 'volume_down': {
        const step = (source === 'voice' ? VOICE_VOLUME_STEP : VOLUME_STEP) * (cmd.do === 'volume_up' ? 1 : -1);
        setVolume(known.volume + step);
        return act(`Volume ${known.volume}`);
      }
      case 'set_volume':
        setVolume(cmd.level);
        return act(`Volume ${known.volume}`);
      case 'play': {
        if (panel?.app !== 'Spotify' || !document.getElementById('hud')?.dataset.app) openPanel('Spotify');
        act(`Finding ${cmd.query}`);
        const r = await helper('/spotify', { action: 'play', query: cmd.query });
        if (!r) return;
        paintSpotify(r.state);
        if (r.ok) say(`Playing ${r.track?.title ?? cmd.query}`);
        else if (r.fallback === 'search') say(`${r.error}. Showing the search in Spotify`);
        else say(r.error || 'Could not play that');
        return;
      }
      default: {
        act(cmd.do === 'playpause' ? (known.playing ? 'Paused' : 'Playing') : LABELS[cmd.do] ?? cmd.do);
        const r = await helper('/spotify', { action: cmd.do });
        if (!r) return;
        if (!r.ok) return say(r.error || 'Spotify did not respond');
        if (cmd.do === 'like' && r.state?.trackId) {
          const id = r.state.trackId;
          if (liked.has(id)) liked.delete(id); else liked.add(id);
        }
        paintSpotify(r.state);
      }
    }
  }

  function openPanel(appName) {
    const p = profiles[appName.toLowerCase()];
    if (p?.panel) { panel = p; refresh(); } // app profiles (Chrome, ...) switch by the front app instead
    send('app:open', { app: p?.app ?? appName });
  }

  async function open(cmd) {
    // With the folder browser up, "open <name>" first means something in this folder.
    if (filesOpen()) {
      const k = nameKey(cmd.target);
      const hit = listing.entries.find((e) => nameKey(e.name) === k)
        ?? listing.entries.find((e) => nameKey(e.name.replace(/\.[^.]+$/, '')) === k);
      if (hit) return pick(hit);
    }
    const r = await helper('/open', { target: cmd.target });
    if (!r) return;
    if (!r.ok) return say(r.error || `Could not open ${cmd.target}`);
    if (r.kind === 'folder') return loadFolder(r.path);
    send('action', { action: 'open', do: r.name, label: `Opening ${r.name}` });
    openPanel(r.name);
    if (r.name === 'Spotify') setTimeout(poll, 1200);
  }

  // ── folder browser ──
  let listing = null;
  const filesOpen = () => !!listing && panel?.app === 'Files';
  const nameKey = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  async function loadFolder(path) {
    const r = await helper(`/fs?path=${encodeURIComponent(path)}`);
    if (!r) return;
    if (!r.ok) return say(r.error || 'Could not open that folder');
    listing = r;
    panel = profiles.files ?? panel;
    refresh();
    send('app:open', { app: 'Files' });
    send('files:list', r);
  }

  async function pick(entry) {
    if (entry.type === 'dir') return loadFolder(entry.path);
    const r = await helper('/open', { path: entry.path });
    if (r) say(r.ok ? `Opening ${entry.name}` : r.error || `Could not open ${entry.name}`);
  }

  function files(cmd) {
    if (!filesOpen()) return;
    if (cmd.do === 'open') return send('files:activate');
    if (cmd.do === 'next_page' || cmd.do === 'prev_page') return send('files:page', { step: cmd.do === 'next_page' ? 1 : -1 });
    if (cmd.do === 'back') {
      if (!listing.parent) return say('This is the top folder');
      send('action', { action: 'files', do: 'back', label: 'Back' });
      return loadFolder(listing.parent);
    }
  }

  function closePanel() {
    listing = null;
    panel = profiles[DEFAULT_PROFILE] ?? null;
    refresh();
    send('app:close');
  }

  /** Run one command. `source` is 'voice', 'gesture' or 'click'. */
  function execute(cmd, source = 'voice') {
    if (!cmd) return;
    engine.noteActivity();
    if (cmd.action === 'spotify') return spotify(cmd, source);
    if (cmd.action === 'open') return open(cmd);
    if (cmd.action === 'files') return files(cmd);
    if (cmd.action === 'back') return filesOpen() ? files({ do: 'back' }) : closePanel();
    if (cmd.action === 'close') return closePanel();
    if (cmd.action === 'sleep') return engine.sleep(source);
    if (cmd.action === 'cursor') return cursorCmd(cmd);
    if (cmd.action === 'key') return key(cmd);
  }

  async function key(cmd) {
    send('action', { action: 'key', do: cmd.combo, label: cmd.label || cmd.combo });
    const r = await helper('/key', { combo: cmd.combo });
    if (r && !r.ok) say(r.error || `Could not press ${cmd.combo}`);
  }

  function cursorCmd(cmd) {
    if (!cursor) return say('Cursor control is off in this mode');
    if (cmd.do === 'on') cursor.setMode(true);
    else if (cmd.do === 'off') cursor.setMode(false);
    else if (cmd.do === 'calibrate') cursor.calibrate();
    else if (cmd.do === 'dwell_on' || cmd.do === 'dwell_off') cursor.setDwell(cmd.do === 'dwell_on');
  }

  // ── polling ──
  let timer = null;
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    const s = await helper('/state');
    polling = false;
    if (!s) return;
    send('system:stats', s);
    paintSpotify(s.spotify);
  }
  async function today() {
    const t = await helper('/today');
    if (t) send('today:list', t);
  }
  function wakeUp() {
    poll();
    today();
    clearInterval(timer);
    timer = setInterval(poll, POLL_MS);
  }

  on('state:awake', wakeUp);
  on('state:asleep', () => { clearInterval(timer); timer = null; });
  on('gesture', (d) => {
    if (cursor?.isOn()) {
      if (d.name === CURSOR_EXIT_GESTURE) cursor.setMode(false);
      return;
    }
    const cmd = active?.gestures?.[d.name];
    if (cmd) execute(cmd, 'gesture');
  });
  on('hud:action', (d) => execute(d, 'click'));
  on('helper:front', (d) => {
    frontProfile = profileForFront(d, profileList);
    refresh();
    if (d.tabError && !tabErrorSaid) { tabErrorSaid = true; say(d.tabError); }
  });
  on('files:pick', pick);
  if (engine.state === 'AWAKE') wakeUp();
  send('profile:change', { name: active?.app ?? '', source: 'panel' });

  return { execute, profiles, activeProfile: () => active };
}
