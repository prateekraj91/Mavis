// Custom gesture classifier and its engine hookup, with noisy synthetic hands. Run: npm test
import assert from 'node:assert/strict';
import { FEATURE_LEN, KnnClassifier, distance, features, roundFeatures } from '../src/knn.js';
import { GestureEngine, STATE, T } from '../src/gestures.js';
import { hand } from './hand.mjs';
import { BUILT_IN, LIMITS } from '../../server/gestures.js';
import { GESTURE_NAMES } from '../src/gestures.js';
import { actionFrom, actionTo, nameProblem } from '../src/trainer.js';

T.MIRROR = false;
const DT = 33;

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;
}

/** A pose as a real camera would give it: anywhere in frame, any size, a little shaky. */
function noisy(pose, r, { jitter = 0.004, scale = [0.8, 1.25] } = {}) {
  const k = scale[0] + (r() + 0.5) * (scale[1] - scale[0]);
  const cx = 0.5 + r() * 0.4, cy = 0.5 + r() * 0.3;
  return hand(pose, 0.5, 0.5).map((p) => ({
    x: cx + (p.x - 0.5) * k + r() * jitter,
    y: cy + (p.y - 0.5) * k + r() * jitter,
    z: r() * jitter,
  }));
}
const record = (pose, n, seed) => { const r = rng(seed); return Array.from({ length: n }, () => features(noisy(pose, r))); };

const tests = {
  'features: 60 numbers, same for a moved and resized hand'() {
    const a = features(hand('peace', 0.3, 0.4));
    const big = hand('peace', 0.5, 0.5).map((p) => ({ x: 0.6 + (p.x - 0.5) * 1.6, y: 0.5 + (p.y - 0.5) * 1.6, z: 0 }));
    assert.equal(a.length, FEATURE_LEN);
    assert.ok(distance(a, features(big)) < 1e-9);
  },
  'features: different poses are far apart'() {
    assert.ok(distance(features(hand('peace')), features(hand('point'))) > 0.5);
  },
  'features: aspect ratio keeps x and y in the same units'() {
    const lm = hand('palm');
    assert.notDeepEqual(features(lm, 4 / 3), features(lm, 1));
  },
  'classifies taught poses from new noisy samples'() {
    const knn = new KnnClassifier().fit([{ name: 'peace', samples: record('peace', 20, 1) }, { name: 'point', samples: record('point', 20, 2) }]);
    const r = rng(99);
    let ok = 0;
    for (let i = 0; i < 40; i++) {
      const pose = i % 2 ? 'peace' : 'point';
      if (knn.predict(features(noisy(pose, r))).name === pose) ok++;
    }
    assert.ok(ok >= 38, `${ok}/40`);
  },
  'rejects poses it was not taught'() {
    const knn = new KnnClassifier().fit([{ name: 'peace', samples: record('peace', 20, 1) }, { name: 'point', samples: record('point', 20, 2) }]);
    const r = rng(7);
    for (const pose of ['fist', 'palm', 'thumbs_up']) {
      let wrong = 0;
      for (let i = 0; i < 20; i++) if (knn.predict(features(noisy(pose, r))).name) wrong++;
      assert.ok(wrong === 0, `${pose} accepted ${wrong}/20`);
    }
  },
  'a single taught gesture still rejects other hands'() {
    const knn = new KnnClassifier().fit([{ name: 'peace', samples: record('peace', 20, 3) }]);
    const r = rng(8);
    assert.equal(knn.predict(features(noisy('peace', r))).name, 'peace');
    assert.equal(knn.predict(features(noisy('palm', r))).name, null);
    assert.equal(knn.predict(features(noisy('point', r))).name, null);
  },
  'leave-one-out check: clean recordings score 100%, no mix-ups'() {
    const ev = new KnnClassifier().fit([{ name: 'peace', samples: record('peace', 20, 4) }, { name: 'fist2', samples: record('fist', 20, 5) }]).evaluate();
    assert.equal(ev.accuracy, 1);
    assert.deepEqual(ev.confusions, {});
  },
  'leave-one-out check flags two names for the same pose'() {
    const ev = new KnnClassifier().fit([{ name: 'a', samples: record('peace', 20, 6) }, { name: 'b', samples: record('peace', 20, 7) }]).evaluate();
    assert.ok(ev.accuracy < 0.8, `accuracy ${ev.accuracy}`);
    assert.ok(Object.keys(ev.confusions).length > 0);
  },
  'empty model predicts nothing; bad samples are skipped'() {
    assert.equal(new KnnClassifier().predict(new Array(60).fill(0)).name, null);
    const knn = new KnnClassifier().fit([{ name: 'x', samples: [[1, 2, 3]] }]);
    assert.equal(knn.samples.length, 0);
  },
  'rounded features (as stored) classify the same'() {
    const samples = record('peace', 20, 9).map((f) => roundFeatures(f));
    const knn = new KnnClassifier().fit([{ name: 'peace', samples }]);
    assert.equal(knn.predict(features(noisy('peace', rng(10)))).name, 'peace');
  },
  'engine: held custom pose fires gesture:<name> once per hold, only awake'() {
    const e = new GestureEngine();
    e.setCustomModel(new KnnClassifier().fit([{ name: 'peace', samples: record('peace', 20, 11) }]));
    const log = [];
    e.on('gesture', (d) => log.push(`${d.name}${d.custom ? '*' : ''}`));
    let t = 1000;
    const hold = (pose, ms) => { for (const end = t + ms; t < end; t += DT) e.update(hand(pose, 0.5, 0.5), t, 1); };
    hold('peace', 1500);
    assert.deepEqual(log, [], 'asleep: nothing');
    e.wake('test', t);
    hold('point', 700);
    hold('peace', 2000);
    assert.deepEqual(log, ['peace*']);
    hold('point', 300); hold('peace', 600);
    assert.deepEqual(log, ['peace*', 'peace*'], 're-forming fires again (after cooldown)');
  },
  'engine: a flicker shorter than the hold time does not fire'() {
    const e = new GestureEngine();
    e.setCustomModel(new KnnClassifier().fit([{ name: 'peace', samples: record('peace', 20, 12) }]));
    const log = [];
    e.on('gesture', (d) => log.push(d.name));
    let t = 1000;
    const hold = (pose, ms) => { for (const end = t + ms; t < end; t += DT) e.update(hand(pose, 0.5, 0.5), t, 1); };
    e.wake('test', t); hold('point', 700);
    hold('peace', T.CUSTOM_HOLD_MS - 120); hold('point', 300);
    assert.deepEqual(log, []);
  },
  'engine: built-in gestures still work with a model loaded'() {
    const e = new GestureEngine();
    e.setCustomModel(new KnnClassifier().fit([{ name: 'peace', samples: record('peace', 20, 13) }]));
    const log = [];
    e.on('gesture', (d) => log.push(d.name));
    let t = 1000;
    const hold = (pose, ms) => { for (const end = t + ms; t < end; t += DT) e.update(hand(pose, 0.5, 0.5), t, 1); };
    e.wake('test', t); hold('point', 700);
    hold('thumbs_up', 1000);
    hold('point', 300);
    hold('fist', 2500);
    assert.deepEqual(log, ['thumbs_up']);
    assert.equal(e.state, STATE.ASLEEP);
  },
  'server and page agree on built-in names and feature length'() {
    assert.deepEqual([...BUILT_IN].sort(), [...GESTURE_NAMES].sort());
    assert.equal(LIMITS.FEATURE_LEN, FEATURE_LEN);
  },
  'trainer form: names and actions round-trip'() {
    assert.equal(nameProblem('peace'), '');
    assert.match(nameProblem('palm'), /built-in/);
    assert.match(nameProblem('Peace sign'), /lowercase/);
    for (const [kind, param] of [['key', 'cmd+shift+t'], ['open', 'Notes'], ['spotify:next', ''], ['cursor:on', ''], ['sleep', ''], ['none', '']]) {
      assert.deepEqual(actionTo(actionFrom(kind, param)), [kind, param]);
    }
    assert.deepEqual(actionFrom('key', ' Cmd + Shift + T '), { action: 'key', combo: 'cmd+shift+t' });
  },
  'engine: landmark tap sees every hand frame'() {
    const e = new GestureEngine();
    let n = 0;
    const off = e.tapLandmarks((lm) => { if (lm.length === 21) n++; });
    for (let i = 0; i < 10; i++) e.update(hand('palm'), 1000 + i * DT, 1);
    off();
    e.update(hand('palm'), 2000, 1);
    assert.equal(n, 10);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`ok    ${name}`); }
  catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : '\nknn: all passed');
process.exit(failed ? 1 : 0);
