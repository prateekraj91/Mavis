// Real mouse (and, later, keyboard) control through the native jarvis-input helper.
// The page sends display-normalised coordinates (0..1); this file turns them into
// points on the main display and writes commands to the helper's stdin.
//
// JARVIS_INPUT=dry npm start   records commands instead of posting them (for tests;
//                              GET /cursor/dry shows the log). The screen is 1440x900.
import { spawn } from 'node:child_process';
import { BIN, build, isStale } from './native/build.js';

const DRY = process.env.JARVIS_INPUT === 'dry';
const DRY_SCREEN = { x: 0, y: 0, w: 1440, h: 900 };
const RESTART_MS = 2000; // helper crashed -> respawn after this
const STATUS_POLL_MS = 4000; // re-read screen size and Accessibility permission
const SCROLL_MAX_PX = 2000; // per message
const DRY_LOG_MAX = 500;
const OPS = new Set(['move', 'down', 'up', 'click', 'scroll']);

let proc = null;
let ready = false;
let trusted = false;
let screen = null;
let error = null;
let buttonDown = false;
let stopping = false;
const dryLog = [];
const listeners = new Set();

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const notify = (event) => { for (const fn of listeners) fn(event); };

/** Called with {t:'input', ...status()} when readiness or permission changes. */
export function onInputChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function status() {
  return { ok: !error, ready, trusted, screen, buttonDown, dry: DRY, error };
}

export async function startInput() {
  if (DRY) { screen = { ...DRY_SCREEN }; trusted = true; ready = true; return; }
  if (process.platform !== 'darwin') { error = 'Cursor control works only on macOS'; return; }
  try {
    if (isStale()) { console.log('Compiling native/jarvis-input.swift (first time can take a minute)…'); await build(); }
  } catch (err) {
    error = 'Could not compile the cursor helper. Install the Xcode command line tools (xcode-select --install), then restart.';
    console.warn(error, '\n', err.stderr || err.message);
    notify({ t: 'input', ...status() });
    return;
  }
  spawnHelper();
  setInterval(() => write('status'), STATUS_POLL_MS).unref();
  const quit = () => { stopping = true; proc?.stdin.end(); }; // the helper releases a held button on EOF
  process.once('exit', quit);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { quit(); process.exit(0); });
}

function spawnHelper() {
  proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  proc.stdin.on('error', () => {});
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) onLine(buf.slice(0, i));
  });
  proc.on('exit', () => {
    proc = null;
    ready = false;
    buttonDown = false;
    if (!stopping) setTimeout(spawnHelper, RESTART_MS);
    notify({ t: 'input', ...status() });
  });
}

function onLine(line) {
  const p = line.split(' ');
  if (p[0] === 'status') {
    const next = { x: +p[1], y: +p[2], w: +p[3], h: +p[4] };
    const nowTrusted = p[5] === '1';
    const changed = !ready || nowTrusted !== trusted || next.w !== screen?.w || next.h !== screen?.h;
    screen = next;
    trusted = nowTrusted;
    ready = true;
    if (changed) notify({ t: 'input', ...status() });
    return;
  }
  for (const fn of lineHandlers) fn(p, line);
}

const lineHandlers = new Set();
/** Other modules (frontmost app) read their own helper output lines. */
export function onHelperLine(fn) { lineHandlers.add(fn); }

/** Write one raw command line to the helper. False if it is not running. */
export function write(line) {
  if (DRY) {
    dryLog.push(line);
    if (dryLog.length > DRY_LOG_MAX) dryLog.shift();
    return true;
  }
  if (!proc || (!ready && line !== 'status')) return false;
  proc.stdin.write(line + '\n');
  return true;
}

const toPoint = (x, y) => [
  Math.round(screen.x + clamp01(x) * (screen.w - 1)),
  Math.round(screen.y + clamp01(y) * (screen.h - 1)),
];

/**
 * One cursor command from the page.
 * {op:'move'|'down'|'up'|'click', x, y}  x,y display-normalised 0..1
 * {op:'scroll', dx, dy}                  pixels; positive dy = content up
 */
export function cursor(cmd = {}) {
  const op = String(cmd.op ?? '');
  if (!OPS.has(op)) return { ok: false, error: `Unknown cursor op "${op}"` };
  if (error) return { ok: false, error };
  if (!ready || !screen) return { ok: false, error: 'Cursor helper is still starting' };
  if (op === 'scroll') {
    const dx = Math.max(-SCROLL_MAX_PX, Math.min(SCROLL_MAX_PX, Math.round(Number(cmd.dx) || 0)));
    const dy = Math.max(-SCROLL_MAX_PX, Math.min(SCROLL_MAX_PX, Math.round(Number(cmd.dy) || 0)));
    if (dx || dy) write(`scroll ${dx} ${dy}`);
    return { ok: true };
  }
  const x = Number(cmd.x), y = Number(cmd.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'x and y must be numbers' };
  if (op === 'up' && !buttonDown) return { ok: true, ignored: 'button not down' };
  if (op === 'down') buttonDown = true;
  if (op === 'up') buttonDown = false;
  const [px, py] = toPoint(x, y);
  write(`${op} ${px} ${py}`);
  return { ok: true, point: [px, py] };
}

/** Never leave the button held (page closed, Jarvis asleep). */
export function releaseButton() {
  if (!buttonDown || !screen) return;
  buttonDown = false;
  write('up'); // no point: the helper releases wherever the cursor is
}

export const dryCommands = () => (DRY ? dryLog.slice() : null);
export const isDry = () => DRY;
