// Real macOS cursor from the hand. Engine `hand` events in, mouse commands out to
// the helper over a WebSocket (server/input.js posts them through Quartz).
//
//   index fingertip moves the cursor (through your calibration rectangle)
//   quick pinch         click where the cursor was just before the fingers closed
//   pinch and hold      press; move while pinched to drag; open to drop
//   two fingers up      (index + middle, others curled) move up/down/sideways to scroll
//   dwell (optional)    hold the cursor still DWELL_MS to click
//
// Only while cursor mode is on AND Mavis is awake. Sleeping turns cursor mode off.
// While it is on, api.js does not run profile gestures (except thumbs up, which
// leaves cursor mode), so a pinch-click cannot also change the volume.
//
// Events out (on window): cursor:mode {on, dwell}  cursor:dwell {progress}  hud:say {text}
// Helper status arrives as helper:input {ready, trusted, ...} through socket.js.
// Keys: Shift+C cursor mode, Shift+K calibrate, Shift+W dwell on/off.

export const C = {
  DRAG_HOLD_MS: 350, // pinch held this long -> button down. Released sooner -> click
  DRAG_START_MOVE: 0.03, // or the pinch moved this far (display fraction) -> drag starts at once
  CLICK_LOOKBACK_MS: 100, // the click lands where the cursor was this long before the pinch closed
  RELEASE_FREEZE_MS: 150, // cursor holds still after a click, drop or scroll while the fingers part
  MIN_MOVE: 0.0007, // display fraction; smaller moves are not sent
  HISTORY_MS: 400,
  SCROLL_ENTER_MS: 120, // two-finger pose must hold this long to start scrolling
  SCROLL_EXIT_MS: 120,
  SCROLL_GAIN_PX: 3000, // pixels per full camera-frame height of fingertip travel
  SCROLL_NATURAL: true, // fingers up -> content up, like a trackpad. Flip if it feels backwards
  DWELL_MS: 900,
  DWELL_RADIUS: 0.012, // display fraction the cursor may wander during a dwell
  DWELL_REARM_RADIUS: 0.03, // after a dwell click, move this far before the next can start
  HELPER: 'http://localhost:7777',
  KEY_TOGGLE: 'C',
  KEY_CALIBRATE: 'K',
  KEY_DWELL: 'W',
};

export const DEFAULT_CALIBRATION = { x0: 0.15, y0: 0.15, x1: 0.85, y1: 0.85 };

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Camera point (0..1, mirrored) -> display point (0..1) through the calibration rectangle. */
export function mapPoint(p, cal = DEFAULT_CALIBRATION) {
  return {
    x: clamp01((p.x - cal.x0) / (cal.x1 - cal.x0)),
    y: clamp01((p.y - cal.y0) / (cal.y1 - cal.y0)),
  };
}

const isTwoFinger = (h) =>
  !h.pinch && !!h.fingers?.index && !!h.fingers?.middle && !h.fingers?.ring && !h.fingers?.pinky;

/**
 * Pure state machine: feed it every `hand` event, get mouse commands back.
 * Commands: {op:'move'|'down'|'up'|'click', x, y} (display 0..1) and {op:'scroll', dx, dy}
 * (wheel pixels: dy > 0 scrolls toward the top of the page, dx > 0 toward the left).
 */
export class CursorLogic {
  constructor({ calibration = DEFAULT_CALIBRATION, dwell = false } = {}) {
    this.cal = { ...calibration };
    this.dwellOn = dwell;
    this.pos = null;
    this.down = false;
    this._clear();
  }

  setCalibration(c) { this.cal = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }; }
  setDwell(on) { this.dwellOn = !!on; this.dw = null; this.dwellProgress = null; }

  _clear() {
    this.mode = 'pointer'; // pointer | pinch | drag | scroll
    this.hist = [];
    this.freezeUntil = -Infinity;
    this.scrollCand = null;
    this.scrollExit = null;
    this.scrollRef = null;
    this.acc = { x: 0, y: 0 };
    this.dw = null;
    this.dwellProgress = null;
  }

  /** Stop: lets go of the button if it is held. Returns the commands for that. */
  reset() {
    const out = [];
    if (this.down) out.push({ op: 'up', ...this.pos });
    this.down = false;
    this._clear();
    return out;
  }

  update(h, t, active) {
    if (!active || !h?.present) return this.reset();
    const out = [];
    const tip = mapPoint(h, this.cal);
    const pinchPt = mapPoint(h.pinchPoint ?? h, this.cal);
    const two = isTwoFinger(h);
    this.dwellProgress = null;

    switch (this.mode) {
      case 'pointer': {
        if (h.pinch) {
          this.mode = 'pinch';
          this.pinchT = t;
          this.anchor = this._lookback(t) ?? this.pos ?? tip;
          this.pinchFrom = pinchPt;
          this._moveTo(this.anchor, out);
          break;
        }
        if (two) {
          this.scrollCand ??= t;
          if (t - this.scrollCand >= C.SCROLL_ENTER_MS) {
            this.mode = 'scroll';
            this.scrollRef = { x: h.x, y: h.y };
            this.acc = { x: 0, y: 0 };
            break;
          }
        } else {
          this.scrollCand = null;
        }
        if (t < this.freezeUntil) break;
        this._moveTo(tip, out);
        this._dwell(t, out);
        break;
      }
      case 'pinch': {
        if (!h.pinch) {
          out.push({ op: 'click', ...this.anchor });
          this._toPointer(t);
          break;
        }
        if (t - this.pinchT < C.DRAG_HOLD_MS && dist(pinchPt, this.pinchFrom) < C.DRAG_START_MOVE) break;
        out.push({ op: 'down', ...this.anchor });
        this.down = true;
        this.mode = 'drag';
      }
      // falls through: move this frame too
      case 'drag': {
        if (!h.pinch) {
          out.push({ op: 'up', ...this.pos });
          this.down = false;
          this._toPointer(t);
          break;
        }
        this._moveTo({
          x: clamp01(this.anchor.x + pinchPt.x - this.pinchFrom.x),
          y: clamp01(this.anchor.y + pinchPt.y - this.pinchFrom.y),
        }, out);
        break;
      }
      case 'scroll': {
        if (h.pinch) { this._toPointer(t); break; }
        if (!two) {
          this.scrollExit ??= t;
          if (t - this.scrollExit >= C.SCROLL_EXIT_MS) this._toPointer(t);
          break;
        }
        this.scrollExit = null;
        const sign = C.SCROLL_NATURAL ? 1 : -1;
        const up = this.scrollRef.y - h.y; // camera y grows downward
        const right = h.x - this.scrollRef.x;
        this.scrollRef = { x: h.x, y: h.y };
        // Natural: fingers up moves the content up, which is a wheel scroll toward the bottom (negative).
        this.acc.y += -sign * up * C.SCROLL_GAIN_PX;
        this.acc.x += sign * right * C.SCROLL_GAIN_PX;
        const dx = Math.trunc(this.acc.x), dy = Math.trunc(this.acc.y);
        if (dx || dy) {
          this.acc.x -= dx;
          this.acc.y -= dy;
          out.push({ op: 'scroll', dx, dy });
        }
        break;
      }
    }
    if (this.pos) {
      this.hist.push({ t, x: this.pos.x, y: this.pos.y });
      while (this.hist.length && t - this.hist[0].t > C.HISTORY_MS) this.hist.shift();
    }
    return out;
  }

  _moveTo(p, out) {
    if (this.pos && dist(p, this.pos) < C.MIN_MOVE) return;
    this.pos = { x: p.x, y: p.y };
    out.push({ op: 'move', x: p.x, y: p.y });
  }

  /** Where the cursor was CLICK_LOOKBACK_MS ago: closing a pinch drags the fingertip. */
  _lookback(t) {
    const want = t - C.CLICK_LOOKBACK_MS;
    let best = null;
    for (const s of this.hist) if (s.t <= want) best = s;
    return best ? { x: best.x, y: best.y } : this.hist[0] ? { x: this.hist[0].x, y: this.hist[0].y } : null;
  }

  _toPointer(t) {
    this.mode = 'pointer';
    this.freezeUntil = t + C.RELEASE_FREEZE_MS;
    this.scrollCand = null;
    this.scrollExit = null;
    // A dwell must not fire right where the user just clicked.
    if (this.pos) this.dw = { ...this.pos, t, fired: true };
  }

  _dwell(t, out) {
    if (!this.dwellOn || !this.pos) return;
    const p = this.pos;
    const radius = this.dw?.fired ? C.DWELL_REARM_RADIUS : C.DWELL_RADIUS;
    if (!this.dw || dist(p, this.dw) > radius) {
      this.dw = { x: p.x, y: p.y, t, fired: false };
      this.dwellProgress = 0;
      return;
    }
    if (this.dw.fired) return;
    const progress = (t - this.dw.t) / C.DWELL_MS;
    if (progress >= 1) {
      out.push({ op: 'click', x: this.dw.x, y: this.dw.y });
      this.dw.fired = true;
      this.dwellProgress = 1;
    } else {
      this.dwellProgress = progress;
    }
  }
}

// ───────────────────────── wiring (browser) ─────────────────────────

/**
 * @param engine     GestureEngine
 * @param socket     connectHelper() from socket.js
 * @param calibrate  () => void, opens the calibration screen (calibrate.js)
 */
export function startCursor({ engine, socket, bus = window, calibrate = () => {} }) {
  const logic = new CursorLogic();
  const send = (type, detail = {}) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  const say = (text) => send('hud:say', { text });
  let on = false;
  let status = null;
  let lastDwell = null;

  async function loadCalibration() {
    try {
      const c = await (await fetch(`${C.HELPER}/cursor/calibration`)).json();
      if (Number.isFinite(c?.x0)) logic.setCalibration(c);
    } catch { /* helper offline: default rectangle */ }
  }
  loadCalibration();
  bus.addEventListener('cursor:calibrated', (e) => logic.setCalibration(e.detail));

  bus.addEventListener('helper:input', (e) => { status = e.detail; if (on) explainStatus(); });
  bus.addEventListener('helper:close', () => { status = null; });

  function explainStatus() {
    if (!status) return say('Helper is not running. Start it in server/ with npm start');
    if (status.error) return say(status.error);
    if (!status.ready) return say('Cursor helper is starting');
    if (!status.trusted) say('Allow Terminal under System Settings > Privacy & Security > Accessibility to move the cursor');
  }

  const push = (cmds) => {
    if (!cmds.length) return;
    engine.noteActivity(); // moving the cursor counts as activity, so Mavis does not idle to sleep
    for (const c of cmds) if (!socket.send({ t: 'cursor', ...c })) break;
  };

  bus.addEventListener('hand', (e) => {
    const d = e.detail || {};
    if (!on && !logic.down) return;
    push(logic.update(d, d.t ?? performance.now(), on && engine.state === 'AWAKE'));
    const p = logic.dwellProgress;
    if (p !== lastDwell) { lastDwell = p; send('cursor:dwell', { progress: p ?? 0 }); }
  });

  function setMode(next, reason = '') {
    next = !!next;
    if (next === on) return;
    on = next;
    if (!on) push(logic.reset());
    send('cursor:mode', { on, dwell: logic.dwellOn, reason });
    if (on) { say(logic.dwellOn ? 'Cursor on, dwell click on' : 'Cursor on'); explainStatus(); }
    else if (reason !== 'sleep') say('Cursor off');
  }
  function setDwell(v) {
    logic.setDwell(v);
    send('cursor:mode', { on, dwell: logic.dwellOn });
    say(logic.dwellOn ? 'Dwell click on' : 'Dwell click off');
  }

  bus.addEventListener('state:asleep', () => setMode(false, 'sleep'));
  bus.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (!e.shiftKey || tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === C.KEY_TOGGLE) setMode(!on);
    else if (e.key === C.KEY_CALIBRATE) calibrate();
    else if (e.key === C.KEY_DWELL) setDwell(!logic.dwellOn);
  });

  return {
    logic,
    isOn: () => on,
    setMode,
    setDwell,
    calibrate,
    reloadCalibration: loadCalibration,
  };
}
