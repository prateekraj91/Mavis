// Signal helpers for the gesture engine. Pure, no DOM, so they run under `npm test`.
//
//   OneEuroFilter   adaptive low-pass: heavy smoothing when the hand is still,
//                   little lag when it moves fast (Casiez et al., CHI 2012).
//   PointFilter     two One Euro filters for an {x, y} point.
//   PerfMeter       rolling FPS and capture-to-event latency for the perf panel.

const TWO_PI = 2 * Math.PI;
const MIN_DT_S = 1e-3; // two samples with the same timestamp still advance

/** Smoothing factor for a first-order low-pass with this cutoff (Hz) at this step (s). */
export function smoothingFactor(cutoffHz, dtS) {
  const tau = 1 / (TWO_PI * cutoffHz);
  return 1 / (1 + tau / dtS);
}

export class OneEuroFilter {
  /**
   * @param minCutoff Hz. Lower = steadier when still, more lag on slow moves.
   * @param beta      How fast the cutoff rises with speed. Higher = less lag on fast moves.
   * @param dCutoff   Hz, cutoff for the speed estimate itself.
   */
  constructor({ minCutoff = 1, beta = 0, dCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null; // last filtered value
    this.dx = 0; // last filtered speed (units / s)
    this.t = null; // last timestamp (ms)
  }

  /** @param value new sample  @param tMs timestamp in ms */
  filter(value, tMs) {
    if (this.x === null || !Number.isFinite(this.x)) {
      this.x = value;
      this.dx = 0;
      this.t = tMs;
      return value;
    }
    const dt = Math.max(MIN_DT_S, (tMs - this.t) / 1000);
    this.t = tMs;
    const rawDx = (value - this.x) / dt;
    this.dx += smoothingFactor(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += smoothingFactor(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

export class PointFilter {
  constructor(opts) {
    this.fx = new OneEuroFilter(opts);
    this.fy = new OneEuroFilter(opts);
  }
  filter(p, tMs) { return { x: this.fx.filter(p.x, tMs), y: this.fy.filter(p.y, tMs) }; }
  reset() { this.fx.reset(); this.fy.reset(); }
  set(opts) { for (const f of [this.fx, this.fy]) Object.assign(f, opts); }
}

/**
 * Rolling frame stats. Call `frame(captureT, doneT, detectMs)` once per processed
 * frame (all performance.now() ms), then `report(now)` for a snapshot.
 */
export class PerfMeter {
  constructor({ windowMs = 1000 } = {}) {
    this.windowMs = windowMs;
    this.frames = []; // {t, latency, detect}
  }

  frame(captureT, doneT, detectMs = 0) {
    this.frames.push({ t: doneT, latency: Math.max(0, doneT - captureT), detect: detectMs });
    this._trim(doneT);
  }

  _trim(now) {
    while (this.frames.length && now - this.frames[0].t > this.windowMs) this.frames.shift();
  }

  report(now) {
    this._trim(now);
    const f = this.frames;
    if (!f.length) return { fps: 0, latencyMs: 0, latencyP95Ms: 0, detectMs: 0, frames: 0 };
    const lat = f.map((s) => s.latency).sort((a, b) => a - b);
    const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // FPS from the span the samples cover, so a half-full window is not reported as half speed.
    const span = f.length > 1 ? f.at(-1).t - f[0].t : 0;
    const fps = span > 0 ? ((f.length - 1) * 1000) / span : 0;
    return {
      fps,
      latencyMs: avg(lat),
      latencyP95Ms: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))],
      detectMs: avg(f.map((s) => s.detect)),
      frames: f.length,
    };
  }
}
