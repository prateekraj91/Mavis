// Key combos like "cmd+shift+t" -> macOS virtual key code + modifier flags for
// jarvis-input's `key` command. US (ANSI) layout codes.

// CGEventFlags
export const MODS = {
  cmd: 0x100000, command: 0x100000, meta: 0x100000,
  shift: 0x20000,
  alt: 0x80000, option: 0x80000, opt: 0x80000,
  ctrl: 0x40000, control: 0x40000,
  fn: 0x800000,
};

// kVK_* virtual key codes (HIToolbox/Events.h)
export const KEYS = {
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07, c: 0x08, v: 0x09,
  b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10, t: 0x11,
  1: 0x12, 2: 0x13, 3: 0x14, 4: 0x15, 6: 0x16, 5: 0x17, '=': 0x18, 9: 0x19, 7: 0x1a, '-': 0x1b, 8: 0x1c, 0: 0x1d,
  ']': 0x1e, o: 0x1f, u: 0x20, '[': 0x21, i: 0x22, p: 0x23, l: 0x25, j: 0x26, "'": 0x27, k: 0x28,
  ';': 0x29, '\\': 0x2a, ',': 0x2b, '/': 0x2c, n: 0x2d, m: 0x2e, '.': 0x2f, '`': 0x32,
  return: 0x24, enter: 0x24, tab: 0x30, space: 0x31, delete: 0x33, backspace: 0x33,
  escape: 0x35, esc: 0x35, forwarddelete: 0x75,
  left: 0x7b, right: 0x7c, down: 0x7d, up: 0x7e,
  home: 0x73, end: 0x77, pageup: 0x74, pagedown: 0x79,
  f1: 0x7a, f2: 0x78, f3: 0x63, f4: 0x76, f5: 0x60, f6: 0x61, f7: 0x62, f8: 0x64,
  f9: 0x65, f10: 0x6d, f11: 0x67, f12: 0x6f,
};

// A physical keyboard sets these flags on navigation keys; apps that compare flags
// exactly (some Electron apps) expect them. Added to whatever modifiers you ask for.
const FN = 0x800000, NUMPAD = 0x200000;
const HARDWARE_FLAGS = {
  left: FN | NUMPAD, right: FN | NUMPAD, up: FN | NUMPAD, down: FN | NUMPAD,
  home: FN, end: FN, pageup: FN, pagedown: FN, forwarddelete: FN,
  f1: FN, f2: FN, f3: FN, f4: FN, f5: FN, f6: FN, f7: FN, f8: FN, f9: FN, f10: FN, f11: FN, f12: FN,
};

// Words people write for symbol keys.
const ALIASES = {
  plus: '=', equal: '=', equals: '=', minus: '-', dash: '-', comma: ',', period: '.', dot: '.',
  slash: '/', backslash: '\\', semicolon: ';', quote: "'", backtick: '`', grave: '`',
  leftbracket: '[', rightbracket: ']', bracketleft: '[', bracketright: ']',
  arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  pgup: 'pageup', pgdn: 'pagedown', pagedn: 'pagedown', del: 'delete', spacebar: 'space',
};

const MAX_COMBO_LEN = 40;

/**
 * "cmd+shift+]" -> {code, flags, combo}. Throws on anything it does not know.
 * Exactly one non-modifier key. "+" itself is written as "plus" (or shift+=).
 */
export function parseCombo(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw || raw.length > MAX_COMBO_LEN) throw new Error('Key combo is empty or too long');
  const parts = raw.split('+').map((p) => p.trim().replace(/\s+/g, ''));
  if (parts.some((p) => !p)) throw new Error(`Bad key combo "${input}" (write + as "plus")`);
  let flags = 0;
  let key = null;
  for (const part of parts) {
    if (part in MODS) { flags |= MODS[part]; continue; }
    const name = ALIASES[part] ?? part;
    if (!(name in KEYS)) throw new Error(`Unknown key "${part}"`);
    if (key !== null) throw new Error(`Only one key per combo: "${input}"`);
    key = name;
  }
  if (key === null) throw new Error(`No key in "${input}", only modifiers`);
  const order = [['ctrl', MODS.ctrl], ['alt', MODS.alt], ['shift', MODS.shift], ['cmd', MODS.cmd], ['fn', MODS.fn]];
  const combo = [...order.filter(([, f]) => flags & f).map(([n]) => n), key].join('+');
  return { code: KEYS[key], flags: flags | (HARDWARE_FLAGS[key] ?? 0), combo };
}
