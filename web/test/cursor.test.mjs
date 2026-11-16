// Real-cursor logic and calibration, with synthetic hand events. Run: npm test
import assert from 'node:assert/strict';
import { C, CursorLogic, mapPoint } from '../src/cursor.js';
import { rectFromCorners, StillDetector } from '../src/calibrate.js';
import { GestureEngine, T } from '../src/gestures.js';
import { hand } from './hand.mjs';

const DT = 33;
const FULL = { x0: 0, y0: 0, x1: 1, y1: 1 }; // identity mapping keeps the numbers readable
const POINT = { index: true, middle: false, ring: false, pinky: false };
const TWO = { index: true, middle: true, ring: false, pinky: false };

/** A `hand` event like the engine's. */
const ev = (x, y, { pinch = false, fingers = POINT, pinchPoint } = {}) =>
  ({ present: true, x, y, pinch, fingers, pinchPoint: pinchPoint ?? { x, y } });

function rig(opts = {}) {
  const c = new CursorLogic({ calibration: FULL, ...opts });
  const cmds = [];
  let t = 1000;
  const step = (e, active = true) => { const out = c.update(e, t, active); cmds.push(...out); t += DT; return out; };
  const run = (ms, f, active) => { for (const end = t + ms; t < end;) step(f(t), active); };
  return { c, cmds, step, run, time: () => t, ops: () => cmds.map((x) => x.op) };
}

const tests = {
  'mapping: calibration rectangle stretches to the display, clamped'() {
    const cal = { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.7 };
    const m = mapPoint({ x: 0.4, y: 0.5 }, cal);
    assert.ok(Math.abs(m.x - 0.5) < 1e-9 && Math.abs(m.y - 0.5) < 1e-9);
    assert.deepEqual(mapPoint({ x: 0.1, y: 0.9 }, cal), { x: 0, y: 1 });
  },
  'index finger moves the cursor'() {
    const r = rig();
    r.step(ev(0.2, 0.3)); r.step(ev(0.5, 0.6));
    assert.deepEqual(r.cmds, [{ op: 'move', x: 0.2, y: 0.3 }, { op: 'move', x: 0.5, y: 0.6 }]);
  },
  'tiny jitter is not sent'() {
    const r = rig();
    r.step(ev(0.5, 0.5)); r.step(ev(0.5002, 0.5)); r.step(ev(0.5, 0.5003));
    assert.equal(r.cmds.length, 1);
  },
  'inactive (asleep or cursor mode off) sends nothing'() {
    const r = rig();
    r.run(300, () => ev(0.5, 0.5, { pinch: true }), false);
    assert.deepEqual(r.cmds, []);
  },
  'quick pinch clicks where the cursor was before the fingers closed'() {
    const r = rig();
    r.run(300, () => ev(0.4, 0.4));
    // closing the pinch drags the fingertip down a little in the last frames
    r.step(ev(0.4, 0.43)); r.step(ev(0.4, 0.46));
    r.run(150, () => ev(0.4, 0.47, { pinch: true }));
    r.step(ev(0.4, 0.47));
    const click = r.cmds.find((c) => c.op === 'click');
    assert.ok(click, r.ops().join());
    assert.ok(Math.abs(click.y - 0.4) < 0.005, `click at y=${click.y}`);
    assert.ok(!r.ops().includes('down'));
  },
  'pinch held is press, move drags, open drops'() {
    const r = rig();
    r.run(200, () => ev(0.3, 0.3));
    r.run(C.DRAG_HOLD_MS + 50, () => ev(0.3, 0.3, { pinch: true }));
    assert.ok(r.ops().includes('down'), r.ops().join());
    const t0 = r.time();
    r.run(300, (t) => { const k = (t - t0) / 300; return ev(0.3 + 0.2 * k, 0.3, { pinch: true, pinchPoint: { x: 0.3 + 0.2 * k, y: 0.3 } }); });
    r.step(ev(0.5, 0.3));
    const ops = r.ops();
    assert.equal(ops.at(-1), 'up');
    assert.ok(!ops.includes('click'));
    const last = r.cmds.filter((c) => c.op === 'move').at(-1);
    assert.ok(last.x > 0.45, `dragged to ${last.x}`);
  },
  'moving while pinched starts the drag before the hold time'() {
    const r = rig();
    r.run(200, () => ev(0.3, 0.3));
    r.step(ev(0.3, 0.3, { pinch: true }));
    r.step(ev(0.36, 0.3, { pinch: true, pinchPoint: { x: 0.36, y: 0.3 } }));
    assert.ok(r.ops().includes('down'));
  },
  'two fingers scroll; fingers up scrolls content up (natural)'() {
    const r = rig();
    r.run(200, () => ev(0.5, 0.5, { fingers: TWO }));
    const before = r.cmds.length;
    const t0 = r.time();
    r.run(300, (t) => ev(0.5, 0.5 - 0.1 * ((t - t0) / 300), { fingers: TWO }));
    const scrolls = r.cmds.slice(before).filter((c) => c.op === 'scroll');
    const total = scrolls.reduce((s, c) => s + c.dy, 0);
    assert.ok(scrolls.length >= 5, `scrolls ${scrolls.length}`);
    assert.ok(total < 0 && Math.abs(Math.abs(total) - 0.1 * C.SCROLL_GAIN_PX) < 0.1 * C.SCROLL_GAIN_PX * 0.15, `total ${total}`);
    assert.ok(!r.cmds.slice(before).some((c) => c.op === 'move'), 'cursor holds still while scrolling');
  },
  'scroll direction flips with SCROLL_NATURAL off'() {
    C.SCROLL_NATURAL = false;
    try {
      const r = rig();
      r.run(200, () => ev(0.5, 0.5, { fingers: TWO }));
      const t0 = r.time();
      r.run(200, (t) => ev(0.5, 0.5 - 0.1 * ((t - t0) / 200), { fingers: TWO }));
      assert.ok(r.cmds.filter((c) => c.op === 'scroll').reduce((s, c) => s + c.dy, 0) > 0);
    } finally { C.SCROLL_NATURAL = true; }
  },
  'a brief two-finger flicker does not start scrolling'() {
    const r = rig();
    r.step(ev(0.5, 0.5, { fingers: TWO })); r.step(ev(0.5, 0.45, { fingers: TWO }));
    r.run(200, () => ev(0.5, 0.4));
    assert.equal(r.c.mode, 'pointer');
    assert.ok(!r.ops().includes('scroll'));
  },
  'hand lost mid-drag releases the button'() {
    const r = rig();
    r.run(C.DRAG_HOLD_MS + 100, () => ev(0.3, 0.3, { pinch: true }));
    assert.ok(r.c.down);
    r.step({ present: false });
    assert.equal(r.ops().at(-1), 'up');
    assert.ok(!r.c.down);
  },
  'going inactive mid-drag (sleep) releases the button'() {
    const r = rig();
    r.run(C.DRAG_HOLD_MS + 100, () => ev(0.3, 0.3, { pinch: true }));
    r.step(ev(0.3, 0.3, { pinch: true }), false);
    assert.equal(r.ops().at(-1), 'up');
  },
  'dwell off by default: resting never clicks'() {
    const r = rig();
    r.run(3000, () => ev(0.5, 0.5));
    assert.ok(!r.ops().includes('click'));
  },
  'dwell on: resting clicks once, then needs a real move to re-arm'() {
    const r = rig({ dwell: true });
    r.run(C.DWELL_MS + 200, () => ev(0.5, 0.5));
    assert.deepEqual(r.ops().filter((o) => o === 'click').length, 1);
    r.run(2000, () => ev(0.505, 0.5)); // small wobble, still inside the re-arm radius
    assert.deepEqual(r.ops().filter((o) => o === 'click').length, 1);
    r.run(100, () => ev(0.6, 0.6));
    r.run(C.DWELL_MS + 200, () => ev(0.6, 0.6));
    assert.deepEqual(r.ops().filter((o) => o === 'click').length, 2);
  },
  'dwell reports progress while charging'() {
    const r = rig({ dwell: true });
    r.run(C.DWELL_MS / 2, () => ev(0.5, 0.5));
    assert.ok(r.c.dwellProgress > 0.3 && r.c.dwellProgress < 0.7, `progress ${r.c.dwellProgress}`);
  },
  'calibration: corners -> rectangle, shrunk by the edge margin'() {
    const rect = rectFromCorners({ tl: { x: 0.2, y: 0.2 }, tr: { x: 0.8, y: 0.22 }, br: { x: 0.78, y: 0.8 }, bl: { x: 0.22, y: 0.78 } }, 0.05);
    assert.ok(Math.abs(rect.x0 - (0.21 + 0.58 * 0.05)) < 1e-9);
    assert.ok(Math.abs(rect.x1 - (0.79 - 0.58 * 0.05)) < 1e-9);
    assert.ok(rect.y0 < rect.y1);
  },
  'calibration: corners too close together are rejected'() {
    assert.equal(rectFromCorners({ tl: { x: 0.5, y: 0.5 }, tr: { x: 0.55, y: 0.5 }, br: { x: 0.55, y: 0.55 }, bl: { x: 0.5, y: 0.55 } }), null);
  },
  'calibration: a corner is recorded only after holding still'() {
    const s = new StillDetector({ ms: 900, radius: 0.015 });
    let r;
    for (let t = 0; t < 600; t += 33) r = s.update({ x: 0.3 + (t % 66 ? 0.005 : 0), y: 0.3 }, t);
    assert.equal(r.point, null);
    s.update({ x: 0.5, y: 0.5 }, 650); // moved: restarts
    for (let t = 683; t < 1700; t += 33) { r = s.update({ x: 0.5, y: 0.5 }, t); if (r.point) break; }
    assert.ok(r.point && Math.abs(r.point.x - 0.5) < 1e-9);
  },
  'end to end: engine hand events -> click from a synthetic pinch tap'() {
    T.MIRROR = false;
    const e = new GestureEngine();
    const c = new CursorLogic({ calibration: FULL });
    const cmds = [];
    e.on('hand', (d) => cmds.push(...c.update(d, d.t, true)));
    let t = 1000;
    const hold = (pose, ms, cx = 0.5, cy = 0.5) => { for (const end = t + ms; t < end; t += DT) e.update(hand(pose, cx, cy), t, 1); };
    hold('point', 400); hold('pinch', 200); hold('point', 300);
    const ops = cmds.map((x) => x.op);
    assert.ok(ops.includes('click') && !ops.includes('down'), ops.join());
  },
  'end to end: peace sign scrolls, pinch hold drags'() {
    T.MIRROR = false;
    const e = new GestureEngine();
    const c = new CursorLogic({ calibration: FULL });
    const cmds = [];
    e.on('hand', (d) => cmds.push(...c.update(d, d.t, true)));
    let t = 1000;
    const move = (pose, ms, y0, y1) => { const t0 = t; for (const end = t + ms; t < end; t += DT) e.update(hand(pose, 0.5, y0 + (y1 - y0) * ((t - t0) / ms)), t, 1); };
    move('peace', 300, 0.6, 0.6); move('peace', 400, 0.6, 0.45);
    assert.ok(cmds.some((x) => x.op === 'scroll'), cmds.map((x) => x.op).join());
    move('point', 300, 0.45, 0.45); move('pinch', 600, 0.45, 0.45); move('point', 300, 0.45, 0.45);
    const ops = cmds.map((x) => x.op);
    assert.ok(ops.includes('down') && ops.lastIndexOf('up') > ops.indexOf('down'), ops.join());
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`ok    ${name}`); }
  catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : '\ncursor: all passed');
process.exit(failed ? 1 : 0);
