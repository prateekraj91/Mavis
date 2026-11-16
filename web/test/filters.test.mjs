// One Euro filter, perf meter, and the engine's filtered pointer. Run: npm test
import assert from 'node:assert/strict';
import { OneEuroFilter, PerfMeter, PointFilter, smoothingFactor } from '../src/filters.js';
import { GestureEngine, T } from '../src/gestures.js';

// Deterministic noise so failures reproduce.
function rng(seed = 7) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;
}
const std = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
const POINTER = { minCutoff: 0.6, beta: 8, dCutoff: 1.0 }; // engine defaults

const tests = {
  'smoothing factor is in (0,1) and rises with cutoff'() {
    const a1 = smoothingFactor(1, 1 / 30), a5 = smoothingFactor(5, 1 / 30);
    assert.ok(a1 > 0 && a1 < 1 && a5 > a1);
  },
  'first sample passes through unchanged'() {
    const f = new OneEuroFilter(POINTER);
    assert.equal(f.filter(0.42, 1000), 0.42);
  },
  'constant input stays constant'() {
    const f = new OneEuroFilter(POINTER);
    let y;
    for (let i = 0; i < 60; i++) y = f.filter(0.3, i * 33);
    assert.ok(Math.abs(y - 0.3) < 1e-12);
  },
  'still hand: jitter is cut by at least 3x'() {
    const f = new OneEuroFilter(POINTER), r = rng();
    const raw = [], out = [];
    for (let i = 0; i < 300; i++) {
      const x = 0.5 + r() * 0.01; // ±0.5% of frame jitter, typical landmark noise
      raw.push(x);
      out.push(f.filter(x, i * 33));
    }
    const ratio = std(raw.slice(30)) / std(out.slice(30));
    assert.ok(ratio > 3, `jitter reduction ${ratio.toFixed(2)}x`);
  },
  'fast move: lags far less than a fixed low-pass with the same stillness smoothing'() {
    const one = new OneEuroFilter(POINTER);
    const fixed = new OneEuroFilter({ ...POINTER, beta: 0 }); // same min cutoff, no speed adaptation
    let errOne = 0, errFixed = 0;
    for (let i = 0; i <= 15; i++) { // 0.1 -> 0.9 in 0.5 s (a quick reach across the frame)
      const t = i * 33, x = 0.1 + (0.8 * i) / 15;
      errOne = Math.abs(one.filter(x, t) - x);
      errFixed = Math.abs(fixed.filter(x, t) - x);
    }
    assert.ok(errOne < 0.06, `one euro lag ${errOne.toFixed(3)}`);
    assert.ok(errOne < errFixed / 4, `one euro ${errOne.toFixed(3)} vs fixed ${errFixed.toFixed(3)}`);
  },
  'settles on a step within 300 ms'() {
    const f = new OneEuroFilter(POINTER);
    f.filter(0.2, 0);
    let y;
    for (let t = 33; t <= 300; t += 33) y = f.filter(0.8, t);
    assert.ok(Math.abs(y - 0.8) < 0.03, `y=${y.toFixed(3)}`);
  },
  'same timestamp twice does not divide by zero'() {
    const f = new OneEuroFilter(POINTER);
    f.filter(0.2, 100);
    const y = f.filter(0.4, 100);
    assert.ok(Number.isFinite(y) && y >= 0.2 && y <= 0.4);
  },
  'reset forgets the past'() {
    const f = new OneEuroFilter(POINTER);
    f.filter(0.1, 0); f.filter(0.1, 33);
    f.reset();
    assert.equal(f.filter(0.9, 66), 0.9);
  },
  'point filter filters x and y independently'() {
    const p = new PointFilter(POINTER);
    p.filter({ x: 0.1, y: 0.9 }, 0);
    const q = p.filter({ x: 0.1, y: 0.1 }, 33);
    assert.equal(q.x, 0.1);
    assert.ok(q.y < 0.9 && q.y > 0.1);
  },
  'perf meter: fps and latency over the window'() {
    const m = new PerfMeter({ windowMs: 1000 });
    for (let i = 0; i < 40; i++) {
      const done = 1000 + i * 33.3;
      m.frame(done - 40, done, 12); // 40 ms capture -> event
    }
    const r = m.report(1000 + 39 * 33.3);
    assert.ok(Math.abs(r.fps - 30) < 1, `fps ${r.fps}`);
    assert.ok(Math.abs(r.latencyMs - 40) < 1e-9 && r.latencyP95Ms === 40 && r.detectMs === 12);
  },
  'perf meter: old frames drop out, empty window reports zeros'() {
    const m = new PerfMeter({ windowMs: 500 });
    m.frame(0, 10, 1);
    assert.equal(m.report(2000).frames, 0);
    assert.equal(m.report(2000).fps, 0);
  },
  'engine: `hand` pointer is steadier than the raw fingertip when the hand is still'() {
    T.MIRROR = false;
    const e = new GestureEngine(), r = rng(3), xs = [], raws = [];
    e.on('hand', (d) => d.present && xs.push(d.x));
    for (let i = 0; i < 200; i++) {
      const j = r() * 0.01;
      const lm = Array.from({ length: 21 }, (_, k) => ({ x: 0.5 + (k % 5) * 0.01 + j, y: 0.5 + k * 0.005, z: 0 }));
      raws.push(lm[8].x);
      e.update(lm, 1000 + i * 33, 1);
    }
    const ratio = std(raws.slice(30)) / std(xs.slice(30));
    assert.ok(ratio > 3, `engine jitter reduction ${ratio.toFixed(2)}x`);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`ok    ${name}`); }
  catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : '\nfilters: all passed');
process.exit(failed ? 1 : 0);
