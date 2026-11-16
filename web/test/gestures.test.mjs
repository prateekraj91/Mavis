// Synthetic-hand tests for the gesture engine. Run: npm test
import assert from 'node:assert/strict';
import { GestureEngine, STATE, T } from '../src/gestures.js';

T.MIRROR = false; // synthetic hands are already in user-view coords
const DT = 33;

function hand(pose, cx = 0.5, cy = 0.5) {
  const P = (dx, dy) => ({ x: cx + dx, y: cy + dy, z: 0 });
  const lm = new Array(21);
  lm[0] = P(0, 0.12);
  const mcps = [[-0.03, 0.005], [0, 0], [0.03, 0.01], [0.055, 0.025]];
  const curledSet = {
    palm: [0, 0, 0, 0], fist: [1, 1, 1, 1], thumbs_up: [1, 1, 1, 1], pinch: [0, 0, 0, 0], point: [0, 1, 1, 1],
  }[pose];
  mcps.forEach(([mx, my], i) => {
    const b = 5 + i * 4;
    lm[b] = P(mx, my);
    if (curledSet[i]) {
      lm[b + 1] = P(mx, my - 0.04); lm[b + 2] = P(mx, my - 0.01); lm[b + 3] = P(mx, my + 0.03);
    } else {
      lm[b + 1] = P(mx, my - 0.05); lm[b + 2] = P(mx, my - 0.085); lm[b + 3] = P(mx, my - 0.115);
    }
  });
  lm[1] = P(-0.04, 0.09);
  lm[2] = P(-0.065, 0.06);
  if (pose === 'fist') { lm[3] = P(-0.04, 0.04); lm[4] = P(-0.01, 0.03); }
  else if (pose === 'thumbs_up') { lm[3] = P(-0.07, 0); lm[4] = P(-0.07, -0.07); }
  else { lm[3] = P(-0.09, 0.035); lm[4] = P(-0.11, 0.01); }
  if (pose === 'pinch') {
    lm[6] = P(-0.05, -0.04); lm[7] = P(-0.065, -0.02); lm[8] = P(-0.08, 0);
    lm[3] = P(-0.08, 0.03); lm[4] = P(-0.085, 0.005);
  }
  return lm;
}

function rig() {
  const e = new GestureEngine();
  const log = [];
  e.on('gesture', (d) => log.push(d.name));
  e.on('state:change', (d) => log.push(`state:${d.state}`));
  let t = 1000;
  const run = (ms, fn) => { for (const end = t + ms; t < end; t += DT) e.update(fn(t), t, 1); };
  const hold = (pose, ms, cx, cy) => run(ms, () => hand(pose, cx, cy));
  const none = (ms) => run(ms, () => null);
  const move = (pose, ms, from, to) => {
    const t0 = t;
    run(ms, (now) => { const k = (now - t0) / ms; return hand(pose, from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k); });
  };
  const wake = () => { e.wake('test', t); hold('point', 700); log.length = 0; };
  return { e, log, hold, none, move, wake, time: () => t };
}

const tests = {
  'asleep: swipes, pinches, fists do nothing'() {
    const r = rig();
    r.move('point', 300, [0.2, 0.5], [0.8, 0.5]);
    r.hold('fist', 2500); r.hold('pinch', 300); r.hold('thumbs_up', 800);
    assert.deepEqual(r.log, []);
    assert.equal(r.e.state, STATE.ASLEEP);
  },
  'palm held 1 s wakes, and that hold does not also play/pause'() {
    const r = rig();
    r.hold('palm', 800);
    assert.equal(r.e.state, STATE.ASLEEP);
    r.hold('palm', 2500);
    assert.deepEqual(r.log, ['state:AWAKE']);
  },
  'palm 0.6 s fires once per hold'() {
    const r = rig(); r.wake();
    r.hold('palm', 500); assert.deepEqual(r.log, []);
    r.hold('palm', 3000); assert.deepEqual(r.log, ['palm']);
    r.hold('point', 300); r.hold('palm', 1000);
    assert.deepEqual(r.log, ['palm', 'palm']);
  },
  'swipe right fires once; return stroke is swallowed'() {
    const r = rig(); r.wake();
    r.hold('point', 200, 0.25, 0.5);
    r.move('point', 300, [0.25, 0.5], [0.75, 0.5]);
    r.move('point', 300, [0.75, 0.5], [0.25, 0.5]);
    r.hold('point', 600, 0.25, 0.5);
    assert.deepEqual(r.log, ['swipe_right']);
  },
  'swipe left'() {
    const r = rig(); r.wake();
    r.hold('point', 200, 0.75, 0.5);
    r.move('point', 300, [0.75, 0.5], [0.25, 0.5]);
    assert.deepEqual(r.log, ['swipe_left']);
  },
  'slow drift is not a swipe'() {
    const r = rig(); r.wake();
    r.none(400); // hand leaves, re-enters on the left
    r.move('point', 2000, [0.2, 0.5], [0.8, 0.5]);
    assert.deepEqual(r.log, []);
  },
  'pinch + move up gives repeated volume steps, down gives pinch_down'() {
    const r = rig(); r.wake();
    r.hold('pinch', 200, 0.5, 0.6);
    r.move('pinch', 800, [0.5, 0.6], [0.5, 0.4]);
    const ups = r.log.filter((n) => n === 'pinch_up').length;
    assert.ok(ups >= 3 && ups <= 5, `ups=${ups}`);
    assert.ok(!r.log.includes('pinch_down') && !r.log.includes('swipe_right'));
    r.log.length = 0;
    r.move('pinch', 600, [0.5, 0.4], [0.5, 0.55]);
    assert.ok(r.log.every((n) => n === 'pinch_down') && r.log.length >= 2, r.log.join());
    r.hold('palm', 200, 0.5, 0.55);
    assert.ok(!r.log.includes('pinch'), 'moved pinch is not a tap');
  },
  'quick pinch tap'() {
    const r = rig(); r.wake();
    r.hold('pinch', 250); r.hold('point', 300);
    assert.deepEqual(r.log, ['pinch']);
  },
  'fist 2 s sleeps; staying in a fist does not re-wake'() {
    const r = rig(); r.wake();
    r.hold('fist', 1800); assert.equal(r.e.state, STATE.AWAKE);
    r.hold('fist', 3000);
    assert.deepEqual(r.log, ['state:ASLEEP']);
  },
  'short fist fires `fist`'() {
    const r = rig(); r.wake();
    r.hold('fist', 600); r.hold('point', 300);
    assert.deepEqual(r.log, ['fist']);
  },
  'thumbs up'() {
    const r = rig(); r.wake();
    r.hold('thumbs_up', 1500);
    assert.deepEqual(r.log, ['thumbs_up']);
  },
  '30 s idle sleeps'() {
    const r = rig(); r.wake();
    r.none(29000); assert.equal(r.e.state, STATE.AWAKE);
    r.none(1500);
    assert.deepEqual(r.log, ['state:ASLEEP']);
  },
  '`hand` fires every frame with pointer + pinch, asleep too'() {
    const r = rig(); const seen = [];
    r.e.on('hand', (d) => seen.push(d));
    r.hold('point', 330, 0.4, 0.5); r.hold('pinch', 330, 0.4, 0.5); r.none(400);
    const live = seen.filter((d) => d.present);
    assert.equal(live.length, 20);
    assert.ok(live.every((d) => d.x >= 0 && d.x <= 1 && d.y >= 0 && d.y <= 1));
    assert.ok(!live[5].pinch && live[19].pinch && live[5].fingers.index && !live[5].fingers.middle);
    assert.deepEqual(seen.at(-1).present, false);
  },
  'gestures inside the wake grace period are ignored'() {
    const r = rig();
    r.e.wake('test', r.time());
    r.move('point', 300, [0.25, 0.5], [0.75, 0.5]);
    assert.ok(!r.log.includes('swipe_right'));
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`ok    ${name}`); }
  catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
