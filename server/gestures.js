// Taught gestures (web/src/trainer.js) are stored in gestures.json by the helper.
// This file checks what the page sends before it is written.
//
// {
//   "version": 1,
//   "gestures": [
//     { "name": "peace", "action": {"action":"key","combo":"cmd+shift+t"}, "samples": [[60 numbers], ...] }
//   ]
// }
import { parseCombo } from './keys.js';

export const LIMITS = {
  MAX_GESTURES: 30,
  MIN_SAMPLES: 5,
  MAX_SAMPLES: 60,
  FEATURE_LEN: 60, // web/src/knn.js FEATURE_LEN
  MAX_ABS_VALUE: 50, // features are in hand sizes; anything bigger is garbage
  MAX_BODY: '2mb',
};

// The engine's own gestures (web/src/gestures.js GESTURE_NAMES): a taught one may not reuse a name.
export const BUILT_IN = new Set(['swipe_right', 'swipe_left', 'palm', 'thumbs_up', 'pinch_up', 'pinch_down', 'pinch', 'fist']);
export const NAME_RE = /^[a-z][a-z0-9_]{0,23}$/;

const SPOTIFY_DO = new Set(['next', 'previous', 'playpause', 'pause', 'resume', 'like', 'volume_up', 'volume_down']);
const CURSOR_DO = new Set(['on', 'off', 'calibrate', 'dwell_on', 'dwell_off']);
const TEXT_RE = /^[\p{L}\p{N} .,:/+&'()-]{1,60}$/u;

/** A mapped action, cleaned to known fields, or throws. null = no action (event only). */
export function cleanAction(a) {
  if (a === null || a === undefined) return null;
  const kind = a?.action;
  const label = typeof a.label === 'string' && TEXT_RE.test(a.label) ? { label: a.label } : {};
  switch (kind) {
    case 'key': return { action: 'key', combo: parseCombo(a.combo).combo, ...label };
    case 'spotify':
      if (!SPOTIFY_DO.has(a.do)) throw new Error(`Unknown Spotify action "${a.do}"`);
      return { action: 'spotify', do: a.do };
    case 'open':
      if (typeof a.target !== 'string' || !TEXT_RE.test(a.target)) throw new Error('Open needs an app or site name');
      return { action: 'open', target: a.target.trim() };
    case 'cursor':
      if (!CURSOR_DO.has(a.do)) throw new Error(`Unknown cursor action "${a.do}"`);
      return { action: 'cursor', do: a.do };
    case 'sleep': case 'close': case 'back':
      return { action: kind };
    default:
      throw new Error(`Unknown action "${kind}"`);
  }
}

/** The whole file, cleaned, or throws with a readable reason. */
export function cleanGestureFile(body) {
  const list = body?.gestures;
  if (!Array.isArray(list)) throw new Error('Expected {gestures: [...]}');
  if (list.length > LIMITS.MAX_GESTURES) throw new Error(`At most ${LIMITS.MAX_GESTURES} gestures`);
  const seen = new Set();
  const gestures = list.map((g, i) => {
    const name = String(g?.name ?? '');
    const where = name || `#${i + 1}`;
    if (!NAME_RE.test(name)) throw new Error(`${where}: names are lowercase letters, digits and _, starting with a letter, up to 24`);
    if (BUILT_IN.has(name)) throw new Error(`${name}: that name is a built-in gesture`);
    if (seen.has(name)) throw new Error(`${name}: used twice`);
    seen.add(name);
    const samples = g.samples;
    if (!Array.isArray(samples) || samples.length < LIMITS.MIN_SAMPLES || samples.length > LIMITS.MAX_SAMPLES) {
      throw new Error(`${name}: needs ${LIMITS.MIN_SAMPLES} to ${LIMITS.MAX_SAMPLES} samples`);
    }
    for (const s of samples) {
      if (!Array.isArray(s) || s.length !== LIMITS.FEATURE_LEN || !s.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LIMITS.MAX_ABS_VALUE)) {
        throw new Error(`${name}: each sample must be ${LIMITS.FEATURE_LEN} numbers`);
      }
    }
    let action;
    try { action = cleanAction(g.action); } catch (err) { throw new Error(`${name}: ${err.message}`); }
    return { name, action, samples };
  });
  return { version: 1, gestures };
}

/** JSON with one sample per line, so the file is readable and diffs stay small. */
export function formatGestureFile(file) {
  const g = file.gestures.map((x) => [
    '    {',
    `      "name": ${JSON.stringify(x.name)},`,
    `      "action": ${JSON.stringify(x.action)},`,
    '      "samples": [',
    x.samples.map((s) => `        ${JSON.stringify(s)}`).join(',\n'),
    '      ]',
    '    }',
  ].join('\n'));
  return `{\n  "version": 1,\n  "gestures": [\n${g.join(',\n')}\n  ]\n}\n`;
}
