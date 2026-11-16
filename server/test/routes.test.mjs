// Starts the helper in dry-run mode (nothing reaches macOS) on a spare port with a
// temp data folder, then hits its routes and WebSocket. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = 7790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://localhost:5173';
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const samples = (n) => Array.from({ length: n }, (_, i) => Array.from({ length: 60 }, (_, j) => Number(Math.sin(i * 7 + j).toFixed(4))));

const server = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
  env: { ...process.env, JARVIS_PORT: String(PORT), JARVIS_DATA_DIR: dataDir, JARVIS_INPUT: 'dry' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });

const req = async (method, path, body, origin = ORIGIN) => {
  const headers = { Origin: origin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const dry = async () => (await req('GET', '/cursor/dry')).body.commands;
const wsOpen = (origin = ORIGIN) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: origin } });
  const first = new Promise((r) => ws.once('message', (m) => r(JSON.parse(m))));
  ws.once('open', () => resolve({ ws, first }));
  ws.once('error', reject);
  ws.once('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
});

const tests = {
  async 'cursor status reports the dry-run screen'() {
    const r = await req('GET', '/cursor/status');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.ready, r.body.trusted, r.body.dry, r.body.screen.w, r.body.screen.h], [true, true, true, 1440, 900]);
  },
  async 'POST /cursor move maps 0..1 to display points'() {
    const r = await req('POST', '/cursor', { op: 'move', x: 0.5, y: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.point, [720, 899]);
    assert.equal((await dry()).at(-1), 'move 720 899');
  },
  async 'coordinates are clamped to the display'() {
    const r = await req('POST', '/cursor', { op: 'move', x: -3, y: 7 });
    assert.deepEqual(r.body.point, [0, 899]);
  },
  async 'click, down/up and scroll'() {
    await req('POST', '/cursor', { op: 'click', x: 0, y: 0 });
    await req('POST', '/cursor', { op: 'down', x: 0.1, y: 0.1 });
    await req('POST', '/cursor', { op: 'up', x: 0.2, y: 0.1 });
    await req('POST', '/cursor', { op: 'scroll', dx: 0, dy: -40.4 });
    assert.deepEqual((await dry()).slice(-4), ['click 0 0', 'down 144 90', 'up 288 90', 'scroll 0 -40']);
  },
  async 'up without down is ignored'() {
    const before = (await dry()).length;
    const r = await req('POST', '/cursor', { op: 'up', x: 0.5, y: 0.5 });
    assert.equal(r.body.ignored, 'button not down');
    assert.equal((await dry()).length, before);
  },
  async 'scroll is capped per message'() {
    await req('POST', '/cursor', { op: 'scroll', dx: 99999, dy: -99999 });
    assert.equal((await dry()).at(-1), 'scroll 2000 -2000');
  },
  async 'bad ops and bad numbers are rejected'() {
    assert.equal((await req('POST', '/cursor', { op: 'rm -rf', x: 0, y: 0 })).status, 400);
    assert.equal((await req('POST', '/cursor', { op: 'move', x: 'a', y: 0 })).status, 400);
  },
  async 'other websites are refused'() {
    assert.equal((await req('POST', '/cursor', { op: 'move', x: 0.5, y: 0.5 }, 'https://evil.example')).status, 403);
  },
  async 'calibration: default until saved, then the saved rectangle'() {
    assert.equal((await req('GET', '/cursor/calibration')).body.default, true);
    const c = { x0: 0.2, y0: 0.25, x1: 0.75, y1: 0.8 };
    assert.equal((await req('POST', '/cursor/calibration', c)).status, 200);
    assert.deepEqual((await req('GET', '/cursor/calibration')).body, c);
  },
  async 'calibration: nonsense is rejected'() {
    assert.equal((await req('POST', '/cursor/calibration', { x0: 0.5, y0: 0.2, x1: 0.52, y1: 0.8 })).status, 400);
    assert.equal((await req('POST', '/cursor/calibration', { x0: -1, y0: 0.2, x1: 0.5, y1: 0.8 })).status, 400);
  },
  async 'websocket: hello, then cursor commands in order'() {
    const { ws, first } = await wsOpen();
    const hello = await first; // then a {t:'front'} message follows
    assert.equal(hello.t, 'input');
    assert.equal(hello.ready, true);
    for (let i = 0; i <= 10; i++) ws.send(JSON.stringify({ t: 'cursor', op: 'move', x: i / 10, y: 0.5 }));
    await sleep(150);
    const log = await dry();
    assert.deepEqual(log.slice(-11).map((l) => l.split(' ')[1]), Array.from({ length: 11 }, (_, i) => String(Math.round((i / 10) * 1439))));
    ws.close();
  },
  async 'websocket: closing mid-drag lets go of the button'() {
    const { ws, first } = await wsOpen();
    await first;
    ws.send(JSON.stringify({ t: 'cursor', op: 'down', x: 0.5, y: 0.5 }));
    await sleep(80);
    ws.close();
    await sleep(150);
    assert.equal((await dry()).at(-1), 'up');
    assert.equal((await req('GET', '/cursor/status')).body.buttonDown, false);
  },
  async 'websocket: other origins are refused'() {
    await assert.rejects(wsOpen('https://evil.example'), /403/);
  },
  async 'POST /key presses a combo through the helper'() {
    const r = await req('POST', '/key', { combo: 'Cmd+Shift+T' });
    assert.equal(r.status, 200);
    assert.equal(r.body.combo, 'shift+cmd+t');
    assert.equal((await dry()).at(-1), `key 17 ${0x100000 | 0x20000}`);
  },
  async 'POST /key: arrows carry the hardware Fn/keypad flags'() {
    await req('POST', '/key', { combo: 'alt+cmd+left' });
    assert.equal((await dry()).at(-1), `key 123 ${0x80000 | 0x100000 | 0x800000 | 0x200000}`);
  },
  async 'POST /key rejects unknown keys, two keys, modifiers only, and other origins'() {
    for (const combo of ['cmd+hyper', 'a+b', 'cmd+shift', '', 'x'.repeat(60)]) {
      assert.equal((await req('POST', '/key', { combo })).status, 400, combo);
    }
    assert.equal((await req('POST', '/key', { combo: 'cmd+q' }, 'https://evil.example')).status, 403);
  },
  async 'front app: simulated switch is pushed over the websocket and readable at /front'() {
    const { ws, first } = await wsOpen();
    await first; // input
    const msgs = [];
    ws.on('message', (m) => msgs.push(JSON.parse(m)));
    await sleep(50);
    await req('POST', '/front/simulate', { bundleId: 'com.google.Chrome', app: 'Google Chrome', host: 'www.youtube.com' });
    await sleep(100);
    const f = msgs.filter((m) => m.t === 'front').at(-1);
    assert.deepEqual([f.app, f.bundleId, f.host], ['Google Chrome', 'com.google.Chrome', 'www.youtube.com']);
    assert.equal((await req('GET', '/front')).body.host, 'www.youtube.com');
    ws.close();
  },
  async 'gestures: empty until saved, then read back cleaned'() {
    assert.deepEqual((await req('GET', '/gestures')).body, { version: 1, gestures: [] });
    const g = { name: 'peace', action: { action: 'key', combo: 'Cmd+Shift+T', label: 'Reopen tab', junk: 1 }, samples: samples(20) };
    const r = await req('POST', '/gestures', { gestures: [g, { name: 'rock', action: null, samples: samples(8) }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const back = (await req('GET', '/gestures')).body.gestures;
    assert.deepEqual(back.map((x) => x.name), ['peace', 'rock']);
    assert.deepEqual(back[0].action, { action: 'key', combo: 'shift+cmd+t', label: 'Reopen tab' });
    assert.equal(back[1].action, null);
    assert.equal(back[0].samples.length, 20);
    assert.deepEqual(back[0].samples[3], g.samples[3]);
  },
  async 'gestures: a large set fits (30 x 60 samples)'() {
    const gestures = Array.from({ length: 30 }, (_, i) => ({ name: `g${i}`, action: null, samples: samples(60) }));
    assert.equal((await req('POST', '/gestures', { gestures })).status, 200);
  },
  async 'gestures: bad files are rejected with a reason'() {
    const ok = { name: 'peace', action: null, samples: samples(10) };
    const bad = [
      [{ gestures: [{ ...ok, name: 'Peace Sign' }] }, /names are/],
      [{ gestures: [{ ...ok, name: 'palm' }] }, /built-in/],
      [{ gestures: [ok, ok] }, /twice/],
      [{ gestures: [{ ...ok, samples: samples(2) }] }, /samples/],
      [{ gestures: [{ ...ok, samples: [...samples(9), [1, 2, 3]] }] }, /60 numbers/],
      [{ gestures: [{ ...ok, samples: [...samples(9), Array(60).fill(1e9)] }] }, /60 numbers/],
      [{ gestures: [{ ...ok, action: { action: 'key', combo: 'cmd+hyper' } }] }, /Unknown key/],
      [{ gestures: [{ ...ok, action: { action: 'shell', cmd: 'rm' } }] }, /Unknown action/],
      [{ gestures: [{ ...ok, action: { action: 'open', target: '"; do shell script "x' } }] }, /Open needs/],
      [{ nope: true }, /Expected/],
    ];
    for (const [body, re] of bad) {
      const r = await req('POST', '/gestures', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.match(r.body.error, re);
    }
  },
  async 'websocket: bad messages are answered with an error, not a crash'() {
    const { ws, first } = await wsOpen();
    await first;
    const err = new Promise((r) => ws.on('message', (m) => { const d = JSON.parse(m); if (d.t !== 'front') r(d); }));
    ws.send('not json');
    ws.send(JSON.stringify({ t: 'cursor', op: 'explode' }));
    assert.equal((await err).t, 'cursor:error');
    ws.close();
  },
};

let failed = 0;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/cursor/status`); break; } catch { await sleep(100); } }
  for (const [name, fn] of Object.entries(tests)) {
    try { await fn(); console.log(`ok    ${name}`); }
    catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
  }
} finally {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
if (failed) console.log(`\nserver output:\n${serverOut}`);
console.log(failed ? `\n${failed} failed` : '\nroutes: all passed');
process.exit(failed ? 1 : 0);
