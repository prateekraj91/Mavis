// Cursor calibration screen. You point at the four corners of the area your hand
// can comfortably reach; that camera rectangle is then stretched over the display.
// Draws its own overlay (like files.js), so hud.js stays paint-only.
//
//   const calibrate = initCalibration();   calibrate() opens it, Esc cancels
// Emits cursor:calibrated {x0, y0, x1, y1} after saving to the helper.

export const K = {
  HOLD_MS: 900, // fingertip must stay still this long to record a corner
  STILL_RADIUS: 0.015, // camera-frame fraction it may wander meanwhile
  EDGE_MARGIN: 0.05, // shrink the rectangle by this much of its size, so screen edges are easy to reach
  MIN_SPAN: 0.1, // narrower than this (camera fraction) is rejected as a mistake
  NEXT_DELAY_MS: 350,
  HELPER: 'http://localhost:7777',
};

const CORNERS = [
  { key: 'tl', label: 'top left' },
  { key: 'tr', label: 'top right' },
  { key: 'br', label: 'bottom right' },
  { key: 'bl', label: 'bottom left' },
];

/** Four camera points -> mapping rectangle, or null if they make no sense. */
export function rectFromCorners({ tl, tr, br, bl }, margin = K.EDGE_MARGIN) {
  let x0 = (tl.x + bl.x) / 2, x1 = (tr.x + br.x) / 2;
  let y0 = (tl.y + tr.y) / 2, y1 = (bl.y + br.y) / 2;
  if (x1 - x0 < K.MIN_SPAN || y1 - y0 < K.MIN_SPAN) return null;
  const mx = (x1 - x0) * margin, my = (y1 - y0) * margin;
  x0 += mx; x1 -= mx; y0 += my; y1 -= my;
  const c = (v) => Math.max(0, Math.min(1, v));
  return { x0: c(x0), y0: c(y0), x1: c(x1), y1: c(y1) };
}

/** Reports how long a point has stayed within `radius`; returns the averaged point once held for `ms`. */
export class StillDetector {
  constructor({ ms = K.HOLD_MS, radius = K.STILL_RADIUS } = {}) { this.ms = ms; this.radius = radius; this.reset(); }
  reset() { this.start = null; this.samples = []; }
  /** @returns {{progress:number, point:{x,y}|null}} */
  update(p, t) {
    const a = this.samples[0];
    if (!a || Math.hypot(p.x - a.x, p.y - a.y) > this.radius) { this.start = t; this.samples = [p]; }
    else this.samples.push(p);
    const progress = Math.min(1, (t - this.start) / this.ms);
    if (progress < 1) return { progress, point: null };
    const n = this.samples.length;
    const point = { x: this.samples.reduce((s, q) => s + q.x, 0) / n, y: this.samples.reduce((s, q) => s + q.y, 0) / n };
    this.reset();
    return { progress: 1, point };
  }
}

const CSS = `
.calib { position: fixed; inset: 0; z-index: 200; background: rgb(6 8 11 / 0.93); color: rgb(236 230 214);
  font: 15px/1.5 'Avenir Next', Avenir, system-ui, sans-serif; }
.calib-box { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); text-align: center; max-width: 520px; }
.calib-box h2 { font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; font-size: 13px; color: rgb(220 196 138); margin: 0 0 10px; }
.calib-box p { margin: 6px 0; color: rgb(236 230 214 / 0.75); }
.calib-box .err { color: #e89a7a; }
.calib-target { position: absolute; width: 44px; height: 44px; margin: -22px; border-radius: 50%;
  border: 1.5px solid rgb(220 196 138 / 0.35); }
.calib-target.now { border-color: rgb(220 196 138); box-shadow: 0 0 24px rgb(220 196 138 / 0.4); }
.calib-target.done { background: rgb(220 196 138 / 0.5); border-color: transparent; }
.calib-target svg { position: absolute; inset: -6px; width: 56px; height: 56px; transform: rotate(-90deg); }
.calib-target circle { fill: none; stroke: rgb(220 196 138); stroke-width: 3; stroke-dasharray: 163.4; stroke-dashoffset: 163.4; }
.calib-tip { position: absolute; width: 12px; height: 12px; margin: -6px; border-radius: 50%; background: rgb(142 211 224); display: none; }
.calib-frame { position: absolute; border: 1px dashed rgb(142 211 224 / 0.5); display: none; }
`;
const INSET = 48; // px from the window edge for the corner targets
const RING_LEN = 163.4;

export function initCalibration({ bus = window } = {}) {
  let ui = null;

  function open() {
    if (ui) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    const root = document.createElement('div');
    root.className = 'calib';
    root.innerHTML = `<div class="calib-box"><h2>Calibrate cursor</h2><p data-c="msg"></p>
      <p>Your fingertip (blue dot) is shown as the camera sees it. Esc cancels.</p></div>
      <div class="calib-frame" data-c="frame"></div><div class="calib-tip" data-c="tip"></div>`;
    const pos = { tl: [INSET, INSET], tr: [-INSET, INSET], br: [-INSET, -INSET], bl: [INSET, -INSET] };
    for (const c of CORNERS) {
      const d = document.createElement('div');
      d.className = 'calib-target';
      d.dataset.corner = c.key;
      const [x, y] = pos[c.key];
      d.style[x > 0 ? 'left' : 'right'] = `${Math.abs(x) - 22}px`;
      d.style[y > 0 ? 'top' : 'bottom'] = `${Math.abs(y) - 22}px`;
      d.style.margin = '0';
      d.innerHTML = '<svg viewBox="0 0 56 56"><circle cx="28" cy="28" r="26"/></svg>';
      root.append(d);
    }
    document.head.append(style);
    document.body.append(root);

    const q = (s) => root.querySelector(`[data-c="${s}"]`);
    const still = new StillDetector();
    const got = {};
    let step = 0;
    let waitUntil = 0;

    const target = () => root.querySelector(`[data-corner="${CORNERS[step].key}"]`);
    const prompt = () => {
      root.querySelectorAll('.calib-target').forEach((el) => el.classList.remove('now'));
      target().classList.add('now');
      q('msg').textContent = `Reach to the ${CORNERS[step].label} of the area you can comfortably cover, and hold your fingertip still.`;
    };
    prompt();

    const onHand = (e) => {
      const h = e.detail || {};
      const tip = q('tip');
      if (!h.present) { tip.style.display = 'none'; still.reset(); return; }
      tip.style.display = 'block';
      tip.style.left = `${h.x * innerWidth}px`;
      tip.style.top = `${h.y * innerHeight}px`;
      const t = h.t ?? performance.now();
      if (t < waitUntil || step >= CORNERS.length) return;
      const { progress, point } = still.update({ x: h.x, y: h.y }, t);
      target().querySelector('circle').style.strokeDashoffset = String(RING_LEN * (1 - progress));
      if (!point) return;
      got[CORNERS[step].key] = point;
      target().classList.replace('now', 'done');
      step++;
      waitUntil = t + K.NEXT_DELAY_MS;
      if (step < CORNERS.length) prompt();
      else finish();
    };

    async function finish() {
      const rect = rectFromCorners(got);
      if (!rect) {
        q('msg').innerHTML = '<span class="err">Those corners were too close together. Reach further apart and try again.</span>';
        setTimeout(() => { close(); open(); }, 1800);
        return;
      }
      const f = q('frame');
      Object.assign(f.style, {
        display: 'block', left: `${rect.x0 * innerWidth}px`, top: `${rect.y0 * innerHeight}px`,
        width: `${(rect.x1 - rect.x0) * innerWidth}px`, height: `${(rect.y1 - rect.y0) * innerHeight}px`,
      });
      try {
        const r = await fetch(`${K.HELPER}/cursor/calibration`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rect),
        });
        if (!r.ok) throw new Error((await r.json()).error);
        q('msg').textContent = 'Saved. The dashed box is the area that now covers your screen.';
      } catch (err) {
        q('msg').textContent = `Using it for now, but could not save it (${err.message || 'helper offline'}).`;
      }
      bus.dispatchEvent(new CustomEvent('cursor:calibrated', { detail: rect }));
      setTimeout(close, 1800);
    }

    const onKey = (e) => { if (e.key === 'Escape') close(); };
    bus.addEventListener('hand', onHand);
    bus.addEventListener('keydown', onKey);
    ui = { root, style, off: () => { bus.removeEventListener('hand', onHand); bus.removeEventListener('keydown', onKey); } };
  }

  function close() {
    if (!ui) return;
    ui.off();
    ui.root.remove();
    ui.style.remove();
    ui = null;
  }

  return Object.assign(open, { close, isOpen: () => !!ui });
}
