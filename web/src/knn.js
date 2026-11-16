// Custom static hand gestures: normalised landmark features + a k-nearest-neighbour
// classifier with per-gesture "unknown" thresholds. Pure, so `npm test` covers it.
//
//   const f = features(landmarks, aspect);        60 numbers
//   const knn = new KnnClassifier().fit([{ name: 'peace', samples: [f, f, ...] }, ...]);
//   knn.predict(f)  -> {name, confidence, distance}  (name null = none of them)

export const KNN = {
  K: 5,
  Z_WEIGHT: 0.5, // MediaPipe depth is noisier than x/y
  REJECT_FACTOR: 2.5, // accept up to this times the gesture's own typical sample spread
  MIN_THRESHOLD: 0.35, // in hand sizes; very tight recordings still accept a little wobble
  MAX_THRESHOLD: 1.6, // loose recordings still reject clearly different hands
  SPREAD_QUANTILE: 0.9,
};

export const FEATURE_LEN = 60; // 20 landmarks (wrist dropped) x 3
const WRIST = 0;
const MIDDLE_MCP = 9;

/**
 * Landmarks -> features that ignore where the hand is and how big it is in the frame,
 * but keep its shape and orientation (so thumbs up and thumbs down differ).
 * @param lm     21 {x, y, z} landmarks, already mirrored to the user's view
 * @param aspect frame width / height, so x and y are in the same units
 */
export function features(lm, aspect = 1) {
  const w = lm[WRIST];
  const size = Math.hypot((lm[MIDDLE_MCP].x - w.x) * aspect, lm[MIDDLE_MCP].y - w.y) || 1e-6;
  const f = new Array(FEATURE_LEN);
  let j = 0;
  for (let i = 1; i < 21; i++) {
    f[j++] = ((lm[i].x - w.x) * aspect) / size;
    f[j++] = (lm[i].y - w.y) / size;
    f[j++] = (((lm[i].z ?? 0) - (w.z ?? 0)) / size) * KNN.Z_WEIGHT;
  }
  return f;
}

export function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

const quantile = (xs, q) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

export class KnnClassifier {
  constructor({ k = KNN.K } = {}) {
    this.k = k;
    this.samples = []; // {name, f}
    this.thresholds = {}; // name -> max accepted nearest distance
  }

  /** @param gestures [{name, samples: [features]}] */
  fit(gestures) {
    this.samples = gestures.flatMap((g) => (g.samples ?? []).filter((f) => f?.length === FEATURE_LEN).map((f) => ({ name: g.name, f })));
    this.thresholds = {};
    for (const g of gestures) {
      const own = this.samples.filter((s) => s.name === g.name);
      // How far each sample is from its nearest sibling: the gesture's natural wobble.
      const spread = own.map((s) => Math.min(...own.filter((o) => o !== s).map((o) => distance(s.f, o.f))));
      const typical = quantile(spread.filter(Number.isFinite), KNN.SPREAD_QUANTILE);
      this.thresholds[g.name] = Math.min(KNN.MAX_THRESHOLD, Math.max(KNN.MIN_THRESHOLD, typical * KNN.REJECT_FACTOR));
    }
    return this;
  }

  get names() { return Object.keys(this.thresholds); }

  /** @returns {{name: string|null, confidence: number, distance: number, closest: string|null}} */
  predict(f, { exclude = null } = {}) {
    const pool = exclude ? this.samples.filter((s) => s !== exclude) : this.samples;
    if (!pool.length) return { name: null, confidence: 0, distance: Infinity, closest: null };
    const near = pool.map((s) => ({ name: s.name, d: distance(f, s.f) })).sort((a, b) => a.d - b.d).slice(0, this.k);
    const tally = {};
    for (const n of near) {
      const t = (tally[n.name] ??= { votes: 0, sum: 0, min: Infinity });
      t.votes++; t.sum += n.d; t.min = Math.min(t.min, n.d);
    }
    const [winner, t] = Object.entries(tally).sort(([, a], [, b]) => b.votes - a.votes || a.sum - b.sum)[0];
    const confidence = t.votes / near.length;
    if (t.min > (this.thresholds[winner] ?? 0)) return { name: null, confidence, distance: t.min, closest: winner };
    return { name: winner, confidence, distance: t.min, closest: winner };
  }

  /**
   * Leave-one-out check of the training set: how often each sample is recognised
   * as its own gesture with the others as the model. Also lists mix-ups.
   */
  evaluate() {
    const per = {};
    const confusions = {};
    for (const s of this.samples) {
      const p = per[s.name] ??= { total: 0, correct: 0 };
      p.total++;
      const r = this.predict(s.f, { exclude: s });
      if (r.name === s.name) p.correct++;
      else if (r.name) confusions[`${s.name}->${r.name}`] = (confusions[`${s.name}->${r.name}`] ?? 0) + 1;
    }
    const total = this.samples.length;
    const correct = Object.values(per).reduce((a, p) => a + p.correct, 0);
    return { accuracy: total ? correct / total : 0, per, confusions };
  }
}

/** Round features for storage (gestures.json stays small). */
export const roundFeatures = (f, digits = 4) => f.map((v) => Number(v.toFixed(digits)));
