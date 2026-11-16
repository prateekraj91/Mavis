// Which app is in front, for per-app gesture profiles. jarvis-input prints a
// `front` line whenever it changes. For browsers we also read the active tab's
// host (AppleScript), because YouTube and Meet are tabs, not apps.
// Only the host leaves this file, never the full URL.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { onHelperLine } from './input.js';

const run = promisify(execFile);
const TAB_POLL_MS = 1000; // tab switches do not change the front app, so poll while a browser is in front
const OSA_TIMEOUT_MS = 1500;

const CHROMIUM = new Set([
  'com.google.Chrome', 'com.google.Chrome.canary', 'com.brave.Browser', 'com.microsoft.edgemac',
  'company.thebrowser.Browser', 'com.vivaldi.Vivaldi', 'org.chromium.Chromium',
]);
const SAFARI = new Set(['com.apple.Safari']);
const BUNDLE_RE = /^[A-Za-z0-9.-]{1,100}$/;

let front = { app: '', bundleId: '', pid: 0, host: '' };
let tabTimer = null;
let tabError = '';
const listeners = new Set();

export const current = () => ({ ...front, ...(tabError ? { tabError } : {}) });
/** fn({t:'front', app, bundleId, host}) on every change. */
export function onFrontChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => { for (const fn of listeners) fn({ t: 'front', ...current() }); };

export const isBrowser = (bundleId) => CHROMIUM.has(bundleId) || SAFARI.has(bundleId);

export function hostOf(url) {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return '';
  }
}

async function activeTabHost(bundleId) {
  if (!BUNDLE_RE.test(bundleId)) return '';
  const script = SAFARI.has(bundleId)
    ? `tell application id "${bundleId}" to if (count of documents) > 0 then return URL of front document`
    : `tell application id "${bundleId}" to if (count of windows) > 0 then return URL of active tab of front window`;
  try {
    const { stdout } = await run('osascript', ['-e', script], { timeout: OSA_TIMEOUT_MS });
    tabError = '';
    return hostOf(stdout.trim());
  } catch (err) {
    const msg = String(err?.stderr || err?.message || '');
    tabError = /-1743|not authori[sz]ed|not allowed/i.test(msg)
      ? 'macOS blocked reading the browser tab. Allow Terminal to control your browser under Privacy & Security > Automation.'
      : '';
    return '';
  }
}

/** Update from a helper `front` line, or (dry-run tests) a simulated one. */
export async function setFront({ pid = 0, bundleId = '', app = '', host } = {}) {
  const sameApp = bundleId === front.bundleId && pid === front.pid;
  front = { app, bundleId, pid, host: sameApp ? front.host : '' };
  clearInterval(tabTimer);
  tabTimer = null;
  if (host !== undefined) front.host = host; // simulated
  else if (isBrowser(bundleId)) {
    front.host = await activeTabHost(bundleId);
    tabTimer = setInterval(pollTab, TAB_POLL_MS);
    tabTimer.unref();
  }
  notify();
}

let polling = false;
async function pollTab() {
  if (polling || !isBrowser(front.bundleId)) return;
  polling = true;
  const host = await activeTabHost(front.bundleId);
  polling = false;
  if (host !== front.host) { front.host = host; notify(); }
}

export function startFront() {
  onHelperLine((parts, line) => {
    if (parts[0] !== 'front') return;
    const [pid, bundleId = '', app = ''] = line.slice('front '.length).split('\t');
    setFront({ pid: Number(pid) || 0, bundleId, app });
  });
}
