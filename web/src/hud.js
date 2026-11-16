// JARVIS HUD. Presentation only: it listens to events on `window` and paints.
// It never calls the helper, the engine or Spotify.
//
// Listens for (payload in e.detail)
//   From the gesture engine
//     engine:ready | engine:error {message}
//     state:awake | state:asleep
//     hand:move {x, y, pinched} | hand:lost
//     hold:progress {action, progress}        action: wake | palm | sleep | thumbs_up | null
//     gesture {name}
//     perf {fps, latencyMs, latencyP95Ms, detectMs, delegate, input, driver, clock}
//   From voice.js / api.js (Prompt 3 emits these)
//     voice:listening {on}
//     voice:heard {text, final}
//     action {action, do, label?}              a command was executed, e.g. {action:'spotify', do:'next', label:'Next track'}
//     app:open {app} | app:close               'Spotify' and 'Files' take over the centre (files.js draws Files)
//     spotify:state {title, artist, artUrl, positionMs, durationMs, playing, volume, liked}
//     system:stats {cpu, mem, battery, charging}     percentages 0..100
//     today:list {items: [{text, time?, done?}]}
//     hud:say {text}                           one-line message in the centre
//     cursor:mode {on, dwell}                  real-cursor mode chip (cursor.js)
//     profile:change {name, source}            active gesture profile chip (api.js)
//     cursor:dwell {progress}                  dwell-click charge, shown on the ring
//
// Emits
//   hud:start                                  Start button clicked (bootstrap starts the engine)
//   hud:action {action:'spotify', do}          a Spotify control was clicked

const IDLE_LINE = 'Ready';
const PANEL_APPS = new Set(['spotify', 'files']); // apps that take over the centre
const LINE_MS = 2200;
const HEARD_MS = 3000;
const CURSOR_LERP = 0.6; // the engine already One Euro filters hand:move
const PERF_TOGGLE_KEY = 'P'; // Shift+P
const PERF_WARN_LATENCY_MS = 80;
const PERF_WARN_FPS = 20;
const RING_LEN = 119.4; // circumference of the cursor ring (r = 19)

const pretty = (s) => { const t = String(s ?? '').replace(/[_:]/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
const pct = (v) => `${Math.max(0, Math.min(100, v))}%`;
const mmss = (ms) => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function initHud({ root = document.getElementById('hud'), bus = window, perf = false } = {}) {
  const el = (name) => root.querySelector(`[data-el="${name}"]`);
  const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail || {}));
  const send = (type, detail = {}) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  const restart = (node, cls) => { node.classList.remove(cls); void node.getBoundingClientRect(); node.classList.add(cls); };

  // ── state ──
  const setState = (s) => { root.dataset.state = s; };
  on('engine:ready', () => { if (root.dataset.state === 'off') setState('asleep'); });
  on('engine:error', (d) => {
    const note = el('gate-note');
    note.textContent = `Could not start: ${d.message || 'unknown error'}. Check camera permission for Chrome, then try again.`;
    note.classList.add('error');
    el('start').disabled = false;
  });
  on('state:awake', () => { setState('awake'); setLine(IDLE_LINE, 0); });
  on('state:asleep', () => { setState('asleep'); cursor.classList.remove('on'); setRing(0); el('wake-bar').style.width = '0'; });

  el('start').addEventListener('click', () => {
    el('start').disabled = true;
    el('gate-note').classList.remove('error');
    el('gate-note').textContent = 'Starting camera…';
    send('hud:start');
  });

  // ── centre line ──
  const line = el('line');
  let lineTimer;
  function setLine(text, ms = LINE_MS) {
    clearTimeout(lineTimer);
    line.textContent = text;
    restart(line, 'swap-in');
    if (ms) lineTimer = setTimeout(() => { line.textContent = IDLE_LINE; }, ms);
  }
  on('hud:say', (d) => setLine(d.text));

  // ── clock ──
  const tick = () => {
    const now = new Date();
    el('time').textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    el('sec').textContent = String(now.getSeconds()).padStart(2, '0');
    el('date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  };
  tick();
  setInterval(tick, 1000);

  // ── today + system ──
  on('today:list', (d) => {
    const list = el('today');
    list.replaceChildren();
    const items = d.items || [];
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing listed for today.';
      list.append(li);
    }
    for (const it of items.slice(0, 8)) {
      const li = document.createElement('li');
      if (it.done) li.className = 'done';
      if (it.time) { const t = document.createElement('time'); t.textContent = it.time; li.append(t); }
      const s = document.createElement('span');
      s.textContent = it.text;
      li.append(s);
      list.append(li);
    }
  });

  on('system:stats', (d) => {
    for (const row of root.querySelectorAll('[data-stat]')) {
      const v = d[row.dataset.stat];
      if (typeof v !== 'number') continue;
      const charging = row.dataset.stat === 'battery' && d.charging;
      row.querySelector('b').textContent = `${Math.round(v)}%${charging ? ', charging' : ''}`;
      row.querySelector('u').style.width = pct(v);
    }
  });

  // ── Spotify ──
  const sp = { positionMs: 0, durationMs: 0, playing: false, at: performance.now() };
  const panel = el('spotify');
  const paintProgress = () => {
    const pos = Math.min(sp.durationMs || 0, sp.positionMs + (sp.playing ? performance.now() - sp.at : 0));
    const w = sp.durationMs ? pct((pos / sp.durationMs) * 100) : '0%';
    el('bar').style.width = w;
    el('mini-bar').style.width = w;
    el('elapsed').textContent = mmss(pos);
    el('total').textContent = mmss(sp.durationMs);
  };
  setInterval(paintProgress, 300);

  on('spotify:state', (d) => {
    if ('positionMs' in d) { sp.positionMs = d.positionMs; sp.at = performance.now(); }
    if ('durationMs' in d) sp.durationMs = d.durationMs;
    if ('playing' in d) {
      if (!('positionMs' in d)) { sp.positionMs += sp.playing ? performance.now() - sp.at : 0; sp.at = performance.now(); }
      sp.playing = !!d.playing;
      panel.classList.toggle('playing-now', sp.playing);
    }
    if ('title' in d) {
      el('title').textContent = d.title || 'Nothing playing';
      el('mini-title').textContent = d.title || '';
      el('mini').hidden = !d.title;
    }
    if ('artist' in d) { el('artist').textContent = d.artist || ''; el('mini-artist').textContent = d.artist || ''; }
    if ('artUrl' in d) {
      const img = el('art');
      img.hidden = !d.artUrl;
      if (d.artUrl && img.getAttribute('src') !== d.artUrl) { img.onerror = () => { img.hidden = true; }; img.src = d.artUrl; }
    }
    if (typeof d.volume === 'number') { el('vol-bar').style.width = pct(d.volume); el('vol').textContent = Math.round(d.volume); }
    if ('liked' in d) panel.querySelector('[data-do="like"]').classList.toggle('on', !!d.liked);
    paintProgress();
  });

  for (const btn of panel.querySelectorAll('[data-do]')) {
    btn.addEventListener('click', () => send('hud:action', { action: 'spotify', do: btn.dataset.do }));
  }

  on('app:open', (d) => {
    const app = String(d.app || '').toLowerCase();
    if (PANEL_APPS.has(app)) root.dataset.app = app;
    else setLine(`Opening ${d.app}`);
    restart(root, 'ping');
  });
  on('app:close', () => { delete root.dataset.app; });

  // A command ran: say it in the centre and flash the matching control.
  on('action', (d) => {
    setLine(d.label || pretty(d.do || d.action));
    if (d.action !== 'spotify') return;
    const key = { pause: 'playpause', resume: 'playpause', play: 'playpause' }[d.do] || d.do;
    if (key === 'volume_up' || key === 'volume_down') restart(el('volume'), 'flash');
    const btn = panel.querySelector(`[data-do="${key}"]`);
    if (btn) restart(btn, 'flash');
  });

  // ── voice pill ──
  const pill = el('pill');
  const pillText = el('pill-text');
  let listening = false;
  let heardTimer;
  const idlePill = () => { pill.classList.remove('heard'); pillText.textContent = listening ? 'Listening' : 'Voice off'; };
  on('voice:listening', (d) => { listening = !!d.on; pill.classList.toggle('listening', listening); if (!pill.classList.contains('heard')) idlePill(); });
  on('voice:heard', (d) => {
    if (!d.text) return;
    clearTimeout(heardTimer);
    pill.classList.add('heard');
    pillText.textContent = `“${d.text}”`;
    heardTimer = setTimeout(idlePill, d.final === false ? 6000 : HEARD_MS);
  });

  // ── hand cursor ──
  const cursor = el('cursor');
  const prog = el('c-prog');
  const pos = { x: innerWidth / 2, y: innerHeight / 2, tx: innerWidth / 2, ty: innerHeight / 2, live: false };
  const setRing = (p) => { prog.style.strokeDashoffset = String(RING_LEN * (1 - p)); };
  const frame = () => {
    if (!pos.live) return;
    pos.x += (pos.tx - pos.x) * CURSOR_LERP;
    pos.y += (pos.ty - pos.y) * CURSOR_LERP;
    cursor.style.transform = `translate(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px)`;
    requestAnimationFrame(frame);
  };
  on('hand:move', (d) => {
    pos.tx = d.x * innerWidth;
    pos.ty = d.y * innerHeight;
    cursor.classList.toggle('pinched', !!d.pinched);
    if (!pos.live) {
      pos.live = true; pos.x = pos.tx; pos.y = pos.ty;
      cursor.classList.add('on');
      requestAnimationFrame(frame);
    }
  });
  on('hand:lost', () => { pos.live = false; cursor.classList.remove('on'); setRing(0); });

  on('hold:progress', (d) => {
    if (d.action === 'wake') { el('wake-bar').style.width = pct(d.progress * 100); return; }
    el('wake-bar').style.width = '0';
    setRing(d.action ? d.progress : 0);
    if (d.action === 'sleep' && d.progress > 0.2 && d.progress < 1) setLine('Hold to sleep', 600);
  });

  on('gesture', (d) => {
    setRing(0);
    restart(cursor, 'fired');
    // Until a dispatcher reports what it did, name the gesture itself.
    if (line.textContent === IDLE_LINE) setLine(pretty(d.name), 1200);
  });

  // ── profile chip ──
  on('profile:change', (d) => {
    const chip = el('chip-profile');
    chip.hidden = !d.name;
    chip.textContent = d.name || '';
    chip.dataset.source = d.source || '';
  });

  // ── cursor mode chip ──
  on('cursor:mode', (d) => {
    const chip = el('chip-cursor');
    chip.hidden = !d.on;
    chip.textContent = d.dwell ? 'Cursor · dwell' : 'Cursor';
    if (d.on) root.dataset.cursor = 'on'; else delete root.dataset.cursor;
  });
  on('cursor:dwell', (d) => setRing(d.progress || 0));

  // ── perf panel ──
  const perfEl = el('perf');
  perfEl.hidden = !perf;
  addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (e.shiftKey && e.key === PERF_TOGGLE_KEY && tag !== 'INPUT' && tag !== 'TEXTAREA') perfEl.hidden = !perfEl.hidden;
  });
  on('perf', (d) => {
    if (perfEl.hidden) return;
    const put = (name, text, warn) => { const b = el(name); b.textContent = text; b.classList.toggle('warn', !!warn); };
    put('perf-fps', Math.round(d.fps), d.fps < PERF_WARN_FPS);
    put('perf-lat', `${Math.round(d.latencyMs)} ms`, d.latencyMs > PERF_WARN_LATENCY_MS);
    put('perf-p95', `${Math.round(d.latencyP95Ms)} ms`, d.latencyP95Ms > PERF_WARN_LATENCY_MS);
    put('perf-det', `${d.detectMs.toFixed(1)} ms`);
    const clock = d.clock === 'capture' ? 'from capture' : `from ${d.clock} (no capture time, reads low)`;
    el('perf-note').textContent = `${d.delegate} · ${d.input} · ${d.driver} · ${clock}`;
  });

  return {
    setAccent(name) { if (name === 'cyan') root.dataset.accent = 'cyan'; else delete root.dataset.accent; },
    say: setLine,
  };
}
