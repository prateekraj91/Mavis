// JARVIS gesture engine: MediaPipe Hand Landmarker -> smoothed landmarks ->
// pose classifier -> gesture detectors -> ASLEEP/AWAKE state machine -> events.
//
// Usage:
//   import { GestureEngine } from './gestures.js';
//   const engine = new GestureEngine();
//   engine.on('gesture:swipe_right', (d) => ...);
//   await engine.start({ debug: true });      // call from a user click
//
// Every event is dispatched on the engine and mirrored on `window`
// (CustomEvent, payload in e.detail), so the HUD can listen without importing.
//
// Events
//   engine:ready | engine:error {error}
//   state:change {state, prev, reason}   also state:awake / state:asleep
//   hand:found | hand:lost
//   hand:move {x, y, pinched, pose}      every frame, mirrored 0..1 coords
//   hand {present, x, y, pinch, pinchRatio, pinchPoint, palm, pose, fingers, t}
//                                        every frame, ASLEEP too: x,y = index fingertip,
//                                        for driving the real cursor. {present:false} on loss
//   pose:change {pose, prev}             palm | fist | thumbs_up | pinch | none
//   hold:progress {pose, action, progress}   0..1 while a hold is charging
//   pinch:start {x, y} | pinch:end {x, y}
//   gesture:<name> {name, ...}           plus a generic `gesture` event
//     swipe_right, swipe_left, palm, thumbs_up, pinch_up, pinch_down,
//     pinch (quick pinch-and-release, for "click"), fist (short fist, for "back")
//
// Coordinates are mirrored (selfie view): moving your hand to YOUR right
// increases x. y grows downward.

// ───────────────────────── tunables ─────────────────────────
// Mutable on purpose: tweak live from the console via `jarvis.T.SWIPE_MIN_DX = 0.2`.
export const T = {
  // Model + camera
  WASM_URL: '/node_modules/@mediapipe/tasks-vision/wasm', // served by Vite dev
  MODEL_URL: '/models/hand_landmarker.task', // local copy (npm install fetches it)
  MODEL_FALLBACK_URL:
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  CAMERA_WIDTH: 640,
  CAMERA_HEIGHT: 480,
  TICK_MS: 33, // detection rate (~30 fps)
  MIRROR: true, // flip x so coords match what the user sees
  MIN_DETECTION_CONFIDENCE: 0.6,
  MIN_PRESENCE_CONFIDENCE: 0.6,
  MIN_TRACKING_CONFIDENCE: 0.6,

  // Smoothing + presence
  EMA_ALPHA: 0.5, // 1 = no smoothing
  HAND_LOST_GRACE_MS: 250, // tolerate dropped detections this long
  POSE_DEBOUNCE_MS: 100, // a pose must persist this long to count

  // Finger state. ratio = dist(tip, wrist) / dist(pip, wrist)
  FINGER_EXTENDED_RATIO: 1.1, // above -> extended
  FINGER_CURLED_RATIO: 0.95, // below -> curled
  // Thumb. ratio = dist(thumbTip, pinkyMcp) / dist(thumbMcp, pinkyMcp)
  THUMB_OPEN_RATIO: 1.0, // above -> thumb counts as open (palm)
  THUMB_UP_RATIO: 1.1, // above -> thumb sticks out (thumbs up)
  THUMB_UP_MIN_RISE: 0.45, // thumb tip above thumb mcp, in hand sizes

  // Holds
  WAKE_PALM_HOLD_MS: 1000, // ASLEEP: open palm -> wake
  PALM_HOLD_MS: 600, // AWAKE: open palm -> play/pause
  FIST_SLEEP_HOLD_MS: 2000, // AWAKE: fist -> sleep
  FIST_TAP_MIN_MS: 250, // AWAKE: fist released before sleep -> `fist`
  THUMBS_UP_HOLD_MS: 400,
  HOLD_MAX_DRIFT: 0.08, // palm centre may move this far (frame units) during a hold

  // Swipe
  SWIPE_MIN_DX: 0.25, // fraction of frame width
  SWIPE_WINDOW_MS: 400,
  SWIPE_MAX_DY: 0.2, // reject diagonal / vertical motion
  SWIPE_MIN_SAMPLES: 3,

  // Pinch. ratio = dist(thumbTip, indexTip) / handSize  (scale invariant;
  // roughly the brief's 0.05-of-frame at arm's length)
  PINCH_ON_RATIO: 0.28,
  PINCH_OFF_RATIO: 0.42, // hysteresis
  PINCH_MIN_OTHER_EXTENDED: 1, // of middle/ring/pinky, so a fist is not a pinch
  PINCH_STEP: 0.04, // vertical travel (frame height) per volume step
  PINCH_REPEAT_MS: 120, // min gap between volume steps
  PINCH_TAP_MIN_MS: 80,
  PINCH_TAP_MAX_MS: 450, // pinch + release faster than this, no movement -> `pinch`

  // State machine
  GESTURE_COOLDOWN_MS: 800, // per gesture; both swipe directions share one
  WAKE_GRACE_MS: 600, // ignore gestures right after waking
  IDLE_SLEEP_MS: 30000,

  // Debug
  DEBUG_REFRESH_MS: 100,
  DEBUG_TOGGLE_KEY: 'D', // Shift+D
  MIRROR_EVENTS_TO_WINDOW: true,
};

export const STATE = { ASLEEP: 'ASLEEP', AWAKE: 'AWAKE' };

// MediaPipe landmark indices
const WRIST = 0;
const THUMB_MCP = 2, THUMB_TIP = 4;
const INDEX_MCP = 5, INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const RING_MCP = 13;
const PINKY_MCP = 17;
const FINGERS = [
  { name: 'index', pip: 6, tip: 8 },
  { name: 'middle', pip: 10, tip: 12 },
  { name: 'ring', pip: 14, tip: 16 },
  { name: 'pinky', pip: 18, tip: 20 },
];
const PALM_POINTS = [WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ───────────────────────── pure geometry ─────────────────────────

/** Turn 21 landmarks into the handful of numbers the classifiers use. */
export function measure(lm, aspect = 1) {
  const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y);
  const handSize = d(WRIST, MIDDLE_MCP) || 1e-6;

  const ratios = {};
  const extended = {};
  const curled = {};
  for (const f of FINGERS) {
    const r = d(f.tip, WRIST) / (d(f.pip, WRIST) || 1e-6);
    ratios[f.name] = r;
    extended[f.name] = r > T.FINGER_EXTENDED_RATIO;
    curled[f.name] = r < T.FINGER_CURLED_RATIO;
  }
  const thumbRatio = d(THUMB_TIP, PINKY_MCP) / (d(THUMB_MCP, PINKY_MCP) || 1e-6);
  const thumbRise = (lm[THUMB_MCP].y - lm[THUMB_TIP].y) / handSize;
  const highestPipY = Math.min(...FINGERS.map((f) => lm[f.pip].y));

  let cx = 0, cy = 0;
  for (const i of PALM_POINTS) { cx += lm[i].x; cy += lm[i].y; }
  const center = { x: cx / PALM_POINTS.length, y: cy / PALM_POINTS.length };

  const fourExtended = FINGERS.every((f) => extended[f.name]);
  const fourCurled = FINGERS.every((f) => curled[f.name]);

  return {
    handSize,
    ratios,
    extended,
    curled,
    fourExtended,
    fourCurled,
    thumbRatio,
    thumbRise,
    thumbOpen: thumbRatio > T.THUMB_OPEN_RATIO,
    thumbUp:
      thumbRatio > T.THUMB_UP_RATIO &&
      thumbRise > T.THUMB_UP_MIN_RISE &&
      lm[THUMB_TIP].y < highestPipY,
    othersExtended: ['middle', 'ring', 'pinky'].filter((n) => extended[n]).length,
    pinchRatio: d(THUMB_TIP, INDEX_TIP) / handSize,
    pinchPoint: {
      x: (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2,
      y: (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2,
    },
    center,
  };
}

/** Static pose from one frame's measurements (pinch is handled separately). */
export function classifyPose(m) {
  if (m.fourExtended && m.thumbOpen) return 'palm';
  if (m.fourCurled) return m.thumbUp ? 'thumbs_up' : 'fist';
  return 'none';
}

// ───────────────────────── engine ─────────────────────────

export class GestureEngine extends EventTarget {
  constructor() {
    super();
    this.T = T;
    this.state = STATE.ASLEEP;
    this.aspect = T.CAMERA_WIDTH / T.CAMERA_HEIGHT;
    this.running = false;
    this._resetTracking();
    this.awakeSince = -Infinity;
    this.lastActivityT = -Infinity;
    this.lastFired = {};
    this.lastGesture = null;
    this._fpsEma = 0;
    this._lastFrameT = 0;
    this._dbg = { on: false, el: null, lastDraw: 0, m: null, swipeDx: 0 };
  }

  _resetTracking() {
    this.handPresent = false;
    this.lastSeenT = -Infinity;
    this.smoothed = null;
    this.pose = 'none';
    this.candidate = null;
    this.candidateSince = 0;
    this.hold = null;
    this.swipeHist = [];
    this.pinch = { active: false, start: 0, anchorY: 0, stepped: false, origin: null, last: null };
  }

  // ── events ──
  on(type, fn) {
    const h = (e) => fn(e.detail);
    this.addEventListener(type, h);
    return () => this.removeEventListener(type, h);
  }

  emit(type, detail = {}) {
    const d = { type, state: this.state, ...detail };
    this.dispatchEvent(new CustomEvent(type, { detail: d }));
    if (T.MIRROR_EVENTS_TO_WINDOW && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(type, { detail: d }));
    }
  }

  // ── state machine (voice.js calls these too) ──
  now() { return performance.now(); }

  wake(reason = 'api', t = this.now()) {
    this.lastActivityT = t;
    if (this.state === STATE.AWAKE) return;
    this.state = STATE.AWAKE;
    this.awakeSince = t;
    if (this.hold) this.hold.fired = true; // the wake hold must not also fire a gesture
    this.swipeHist.length = 0;
    this.emit('state:change', { prev: STATE.ASLEEP, reason });
    this.emit('state:awake', { reason });
  }

  sleep(reason = 'api', t = this.now()) {
    if (this.state === STATE.ASLEEP) return;
    this.state = STATE.ASLEEP;
    if (this.hold) this.hold.fired = true; // the same hold must not wake it again
    this.swipeHist.length = 0;
    this.emit('state:change', { prev: STATE.AWAKE, reason });
    this.emit('state:asleep', { reason });
  }

  /** Any non-gesture input (voice command, click) should call this to reset the idle timer. */
  noteActivity(t = this.now()) { this.lastActivityT = t; }

  _checkIdle(t) {
    if (this.state === STATE.AWAKE && t - this.lastActivityT >= T.IDLE_SLEEP_MS) {
      this.sleep('timeout', t);
    }
  }

  /** Fire a gesture. Only while AWAKE, outside the wake grace period, and off cooldown. */
  _fire(name, detail, t, { key = name, cooldownMs = T.GESTURE_COOLDOWN_MS } = {}) {
    if (this.state !== STATE.AWAKE) return false;
    if (t - this.awakeSince < T.WAKE_GRACE_MS) return false;
    if (t - (this.lastFired[key] ?? -Infinity) < cooldownMs) return false;
    this.lastFired[key] = t;
    this.lastActivityT = t;
    this.lastGesture = { name, t };
    const d = { name, ...detail };
    this.emit(`gesture:${name}`, d);
    this.emit('gesture', d);
    return true;
  }

  // ── per-frame update: pure, driven by (landmarks, time) so it is testable ──

  /**
   * @param rawLm 21 MediaPipe landmarks ({x,y,z} normalised), or null if no hand this frame
   * @param t     timestamp in ms (monotonic)
   */
  update(rawLm, t, aspect = this.aspect) {
    this.aspect = aspect;
    if (this._lastFrameT) {
      const fps = 1000 / Math.max(1, t - this._lastFrameT);
      this._fpsEma = this._fpsEma ? this._fpsEma * 0.9 + fps * 0.1 : fps;
    }
    this._lastFrameT = t;

    if (!rawLm) {
      if (this.handPresent && t - this.lastSeenT > T.HAND_LOST_GRACE_MS) this._handLost(t);
      this._checkIdle(t);
      this._drawDebug(t);
      return;
    }

    this.lastSeenT = t;
    const lm = this._smooth(rawLm);
    if (!this.handPresent) {
      this.handPresent = true;
      this.emit('hand:found');
    }

    const m = measure(lm, aspect);
    this._dbg.m = m;

    this._updatePinch(m, t);
    this._updatePose(this.pinch.active ? 'pinch' : classifyPose(m), m, t);
    this._updateSwipe(m, t);
    this._updateHold(m, t);

    const p = this.pinch.active ? m.pinchPoint : m.center;
    this.emit('hand:move', { x: p.x, y: p.y, pinched: this.pinch.active, pose: this.pose });

    // Raw pointer feed for an OS-cursor helper: fires every frame, in both states.
    this.emit('hand', {
      present: true,
      t,
      x: clamp01(lm[INDEX_TIP].x), // index fingertip
      y: clamp01(lm[INDEX_TIP].y),
      pinch: this.pinch.active,
      pinchRatio: m.pinchRatio,
      pinchPoint: { ...m.pinchPoint }, // steadier than the fingertip while pinched
      palm: { ...m.center },
      pose: this.pose,
      fingers: { ...m.extended }, // index/middle/ring/pinky extended, e.g. two fingers = scroll
    });

    this._checkIdle(t);
    this._drawDebug(t);
  }

  _smooth(raw) {
    const a = T.EMA_ALPHA;
    const mx = (x) => (T.MIRROR ? 1 - x : x);
    if (!this.smoothed) {
      this.smoothed = raw.map((p) => ({ x: mx(p.x), y: p.y, z: p.z ?? 0 }));
    } else {
      for (let i = 0; i < raw.length; i++) {
        const s = this.smoothed[i];
        s.x += a * (mx(raw[i].x) - s.x);
        s.y += a * (raw[i].y - s.y);
        s.z += a * ((raw[i].z ?? 0) - s.z);
      }
    }
    return this.smoothed;
  }

  _handLost(t) {
    if (this.pinch.active) this._endPinch(t, false);
    if (this.hold && !this.hold.fired) this.emit('hold:progress', { pose: this.hold.pose, action: null, progress: 0 });
    const prev = this.pose;
    this._resetTracking();
    if (prev !== 'none') this.emit('pose:change', { pose: 'none', prev });
    this.emit('hand:lost');
    this.emit('hand', { present: false, t, pinch: false });
  }

  // ── pose with debounce ──
  _updatePose(raw, m, t) {
    if (raw === this.pose) { this.candidate = null; return; }
    if (this.candidate !== raw) { this.candidate = raw; this.candidateSince = t; }
    if (t - this.candidateSince < T.POSE_DEBOUNCE_MS) return;

    const prev = this.pose;
    const old = this.hold;
    // Short fist released while awake -> `fist` (used as "back").
    if (prev === 'fist' && old && !old.fired && t - old.start >= T.FIST_TAP_MIN_MS) {
      this._fire('fist', { heldMs: t - old.start }, t);
    }
    if (old && !old.fired) this.emit('hold:progress', { pose: prev, action: null, progress: 0 });

    this.pose = raw;
    this.candidate = null;
    this.hold = { pose: raw, start: this.candidateSince, anchor: { ...m.center }, fired: false };
    this.emit('pose:change', { pose: raw, prev });
  }

  // ── holds: palm (wake / play-pause), fist (sleep), thumbs up ──
  _holdTarget(pose) {
    if (this.state === STATE.ASLEEP) {
      return pose === 'palm' ? { ms: T.WAKE_PALM_HOLD_MS, action: 'wake' } : null;
    }
    if (pose === 'palm') return { ms: T.PALM_HOLD_MS, action: 'palm' };
    if (pose === 'fist') return { ms: T.FIST_SLEEP_HOLD_MS, action: 'sleep' };
    if (pose === 'thumbs_up') return { ms: T.THUMBS_UP_HOLD_MS, action: 'thumbs_up' };
    return null;
  }

  _updateHold(m, t) {
    const h = this.hold;
    if (!h || h.fired) return;
    const target = this._holdTarget(h.pose);
    if (!target) return;

    const drift = Math.hypot(m.center.x - h.anchor.x, m.center.y - h.anchor.y);
    if (drift > T.HOLD_MAX_DRIFT) { h.start = t; h.anchor = { ...m.center }; }

    const progress = clamp01((t - h.start) / target.ms);
    this.emit('hold:progress', { pose: h.pose, action: target.action, progress });
    if (progress < 1) return;

    h.fired = true; // one fire per hold; release and re-form to fire again
    if (target.action === 'wake') this.wake('palm', t);
    else if (target.action === 'sleep') this.sleep('fist', t);
    else this._fire(target.action, { x: m.center.x, y: m.center.y }, t);
  }

  // ── swipe ──
  _updateSwipe(m, t) {
    const hist = this.swipeHist;
    this._dbg.swipeDx = 0;
    const blocked =
      this.state !== STATE.AWAKE ||
      this.pinch.active ||
      t - (this.lastFired.swipe ?? -Infinity) < T.GESTURE_COOLDOWN_MS; // also swallows the return stroke
    if (blocked) { hist.length = 0; return; }

    hist.push({ t, x: m.center.x, y: m.center.y });
    while (hist.length && t - hist[0].t > T.SWIPE_WINDOW_MS) hist.shift();
    if (hist.length < T.SWIPE_MIN_SAMPLES) return;

    let best = 0;
    for (const s of hist) {
      const dx = m.center.x - s.x;
      if (Math.abs(dx) > Math.abs(best) && Math.abs(m.center.y - s.y) <= T.SWIPE_MAX_DY) best = dx;
    }
    this._dbg.swipeDx = best;
    if (Math.abs(best) < T.SWIPE_MIN_DX) return;

    const name = best > 0 ? 'swipe_right' : 'swipe_left';
    if (this._fire(name, { dx: best }, t, { key: 'swipe' })) {
      hist.length = 0;
      if (this.hold) { this.hold.start = t; this.hold.anchor = { ...m.center }; }
    }
  }

  // ── pinch: hold + move = volume steps, quick tap = click ──
  _updatePinch(m, t) {
    const p = this.pinch;
    p.last = m.pinchPoint;
    if (!p.active) {
      if (m.pinchRatio < T.PINCH_ON_RATIO && m.othersExtended >= T.PINCH_MIN_OTHER_EXTENDED) {
        p.active = true;
        p.start = t;
        p.anchorY = m.pinchPoint.y;
        p.stepped = false;
        p.origin = { ...m.pinchPoint };
        if (this.state === STATE.AWAKE) this.emit('pinch:start', { ...p.origin });
      }
      return;
    }
    if (m.pinchRatio > T.PINCH_OFF_RATIO) { this._endPinch(t, true); return; }

    const dy = p.anchorY - m.pinchPoint.y; // up is positive
    if (Math.abs(dy) >= T.PINCH_STEP) {
      const name = dy > 0 ? 'pinch_up' : 'pinch_down';
      const fired = this._fire(name, { x: m.pinchPoint.x, y: m.pinchPoint.y }, t, {
        key: 'pinch_step',
        cooldownMs: T.PINCH_REPEAT_MS,
      });
      if (fired) { p.anchorY -= Math.sign(dy) * T.PINCH_STEP; p.stepped = true; }
    }
  }

  _endPinch(t, handStillThere) {
    const p = this.pinch;
    const dur = t - p.start;
    p.active = false;
    if (this.state === STATE.AWAKE) this.emit('pinch:end', { ...(p.last ?? p.origin) });
    if (handStillThere && !p.stepped && dur >= T.PINCH_TAP_MIN_MS && dur <= T.PINCH_TAP_MAX_MS) {
      this._fire('pinch', { ...p.origin }, t);
    }
  }

  // ── camera + MediaPipe ──

  /** Must be called from a user gesture (click) so Chrome grants the camera. */
  async start({ video = null, debug = false } = {}) {
    if (this.running) return this;
    this.setDebug(debug);
    try {
      const [landmarker, stream] = await Promise.all([
        createLandmarker(),
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { width: T.CAMERA_WIDTH, height: T.CAMERA_HEIGHT, facingMode: 'user' },
        }),
      ]);
      this.landmarker = landmarker;
      this.stream = stream;

      if (!video) {
        video = document.createElement('video');
        // Kept in the DOM but invisible; frames never leave memory.
        video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
        document.body.appendChild(video);
        this._ownVideo = true;
      }
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      this.video = video;
      this._lastVideoTime = -1;
      this.running = true;

      // A worker timer keeps ticking when the tab is in the background
      // (requestAnimationFrame stops there, and Spotify will often be in front).
      this._stopTicker = createTicker(() => this._tick(), T.TICK_MS);

      if (typeof window !== 'undefined') {
        this._onKey = (e) => {
          const tag = e.target?.tagName;
          if (e.shiftKey && e.key === T.DEBUG_TOGGLE_KEY && tag !== 'INPUT' && tag !== 'TEXTAREA') {
            this.setDebug(!this._dbg.on);
          }
        };
        window.addEventListener('keydown', this._onKey);
      }
      this.emit('engine:ready');
    } catch (error) {
      this.emit('engine:error', { error, message: String(error?.message ?? error) });
      throw error;
    }
    return this;
  }

  stop() {
    this.running = false;
    this._stopTicker?.();
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.landmarker?.close?.();
    if (this._ownVideo) this.video?.remove();
    if (this._onKey) window.removeEventListener('keydown', this._onKey);
    this.setDebug(false);
    this.sleep('stop');
    this._resetTracking();
  }

  _tick() {
    const v = this.video;
    if (!this.running || !v || v.readyState < 2) return;
    const t = performance.now();
    if (v.currentTime === this._lastVideoTime) { this._checkIdle(t); return; }
    this._lastVideoTime = v.currentTime;
    let res;
    try {
      res = this.landmarker.detectForVideo(v, t);
    } catch (error) {
      if (!this._detectErrored) {
        this._detectErrored = true;
        this.emit('engine:error', { error, message: String(error?.message ?? error) });
      }
      return;
    }
    const aspect = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : this.aspect;
    this.update(res.landmarks?.[0] ?? null, t, aspect);
  }

  // ── debug overlay ──
  setDebug(on) {
    const d = this._dbg;
    d.on = !!on;
    if (typeof document === 'undefined') return;
    if (d.on && !d.el) {
      d.el = document.createElement('pre');
      d.el.id = 'jarvis-debug';
      d.el.style.cssText =
        'position:fixed;left:12px;top:12px;z-index:99999;margin:0;padding:10px 12px;' +
        'font:11px/1.45 ui-monospace,Menlo,monospace;color:#e8d9a8;background:rgba(10,12,16,.82);' +
        'border:1px solid rgba(232,217,168,.35);border-radius:8px;pointer-events:none;white-space:pre';
      document.body.appendChild(d.el);
    }
    if (d.el) d.el.style.display = d.on ? 'block' : 'none';
  }

  _drawDebug(t) {
    const d = this._dbg;
    if (!d.on || !d.el || t - d.lastDraw < T.DEBUG_REFRESH_MS) return;
    d.lastDraw = t;
    const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '-');
    const cd = (key, ms = T.GESTURE_COOLDOWN_MS) => Math.max(0, ms - (t - (this.lastFired[key] ?? -Infinity)));
    const lines = [
      `state      ${this.state}${this.state === STATE.AWAKE ? `   idle sleep in ${f(Math.max(0, T.IDLE_SLEEP_MS - (t - this.lastActivityT)) / 1000, 1)}s` : ''}`,
      `fps        ${f(this._fpsEma, 0)}`,
      `hand       ${this.handPresent ? 'yes' : 'no'}`,
    ];
    const m = d.m;
    if (this.handPresent && m) {
      const flag = (n) => (m.extended[n] ? 'E' : m.curled[n] ? 'c' : '·');
      const h = this.hold;
      const target = h ? this._holdTarget(h.pose) : null;
      lines.push(
        `pose       ${this.pose}${this.candidate ? `  (-> ${this.candidate})` : ''}`,
        `fingers    I:${flag('index')} M:${flag('middle')} R:${flag('ring')} P:${flag('pinky')}   E>${T.FINGER_EXTENDED_RATIO} c<${T.FINGER_CURLED_RATIO}`,
        `  ratios   ${['index', 'middle', 'ring', 'pinky'].map((n) => f(m.ratios[n])).join(' ')}`,
        `thumb      ratio ${f(m.thumbRatio)} (open>${T.THUMB_OPEN_RATIO} up>${T.THUMB_UP_RATIO})  rise ${f(m.thumbRise)} (>${T.THUMB_UP_MIN_RISE})  up:${m.thumbUp ? 'Y' : 'n'}`,
        `pinch      ratio ${f(m.pinchRatio)} (on<${T.PINCH_ON_RATIO} off>${T.PINCH_OFF_RATIO})  ${this.pinch.active ? `ACTIVE dy ${f(this.pinch.anchorY - m.pinchPoint.y, 3)} / step ${T.PINCH_STEP}` : 'off'}`,
        `palm xy    ${f(m.center.x)} ${f(m.center.y)}   size ${f(m.handSize, 3)}`,
        `swipe dx   ${f(d.swipeDx, 3)} / ${T.SWIPE_MIN_DX} in ${T.SWIPE_WINDOW_MS}ms   cooldown ${f(cd('swipe'), 0)}ms`,
        `hold       ${target && h && !h.fired ? `${target.action} ${f(t - h.start, 0)} / ${target.ms}ms` : h?.fired ? 'fired (release to re-arm)' : '-'}`,
      );
    }
    lines.push(
      `last       ${this.lastGesture ? `${this.lastGesture.name}  ${f((t - this.lastGesture.t) / 1000, 1)}s ago` : '-'}`,
      `Shift+${T.DEBUG_TOGGLE_KEY} hides this`,
    );
    d.el.textContent = lines.join('\n');
  }
}

// ───────────────────────── helpers ─────────────────────────

async function resolveModelUrl() {
  try {
    const r = await fetch(T.MODEL_URL, { method: 'HEAD' });
    const type = r.headers.get('content-type') || '';
    if (r.ok && !type.includes('text/html')) return T.MODEL_URL; // Vite answers missing files with index.html
  } catch { /* fall through */ }
  return T.MODEL_FALLBACK_URL;
}

async function createLandmarker() {
  const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(T.WASM_URL);
  const modelAssetPath = await resolveModelUrl();
  const make = (delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: T.MIN_DETECTION_CONFIDENCE,
      minHandPresenceConfidence: T.MIN_PRESENCE_CONFIDENCE,
      minTrackingConfidence: T.MIN_TRACKING_CONFIDENCE,
    });
  try {
    return await make('GPU');
  } catch {
    return await make('CPU');
  }
}

/** setInterval that is not throttled in background tabs (falls back to a plain interval). */
function createTicker(fn, intervalMs) {
  try {
    const src = 'let id;onmessage=(e)=>{clearInterval(id);id=setInterval(()=>postMessage(0),e.data)};';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = fn;
    worker.postMessage(intervalMs);
    return () => { worker.terminate(); URL.revokeObjectURL(url); };
  } catch {
    const id = setInterval(fn, intervalMs);
    return () => clearInterval(id);
  }
}
