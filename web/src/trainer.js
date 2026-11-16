// "Teach Jarvis a gesture": record ~20 samples of a hand shape, check them with the
// KNN classifier (knn.js), map the gesture to an action, save to the helper's
// gestures.json. The engine then fires it as gesture:<name> (only while awake).
// Draws its own overlay (like files.js), so hud.js stays paint-only.
//
//   const trainer = initCustomGestures({ engine });   loads saved gestures at once
//   trainer.open()   also: Shift+T, "teach a gesture", or /?train
//
// Emits: gestures:updated {gestures: [{name, action}]}   (api.js maps them to actions)
//        trainer:open {on}                              (api.js pauses gestures meanwhile)

import { KnnClassifier, features, roundFeatures } from './knn.js';
import { GESTURE_NAMES, T, classifyPose, measure } from './gestures.js';

export const TR = {
  SAMPLES: 20,
  SAMPLE_GAP_MS: 100, // between samples while recording
  COUNTDOWN_S: 3,
  SETTLE_MS: 600, // after the countdown, skip this long so half-formed shapes are not recorded
  WARN_ACCURACY: 0.9, // leave-one-out score below this -> warn
  WARN_BUILTIN_SHARE: 0.5, // this share of samples reads as a built-in pose -> warn
  HELPER: 'http://localhost:7777',
  KEY_OPEN: 'T', // Shift+T
  NAME_RE: /^[a-z][a-z0-9_]{0,23}$/,
};

const ACTIONS = [
  ['key', 'Press keys…', 'e.g. cmd+shift+t'],
  ['spotify:playpause', 'Spotify: play / pause'],
  ['spotify:next', 'Spotify: next track'],
  ['spotify:previous', 'Spotify: previous track'],
  ['spotify:like', 'Spotify: like'],
  ['spotify:volume_up', 'Spotify: volume up'],
  ['spotify:volume_down', 'Spotify: volume down'],
  ['open', 'Open an app or site…', 'e.g. Notes or youtube.com'],
  ['cursor:on', 'Cursor mode on'],
  ['cursor:off', 'Cursor mode off'],
  ['sleep', 'Sleep'],
  ['none', 'Nothing (just the gesture event)'],
];

/** Form choice -> stored action object (null = none). */
export function actionFrom(kind, param = '') {
  const p = String(param).trim();
  if (kind === 'none') return null;
  if (kind === 'key') return { action: 'key', combo: p.toLowerCase().replace(/\s+/g, '') };
  if (kind === 'open') return { action: 'open', target: p };
  if (kind === 'sleep') return { action: 'sleep' };
  const [action, does] = kind.split(':');
  return { action, do: does };
}

/** Stored action -> [kind, param] for the form. */
export function actionTo(a) {
  if (!a) return ['none', ''];
  if (a.action === 'key') return ['key', a.combo];
  if (a.action === 'open') return ['open', a.target];
  if (a.action === 'sleep') return ['sleep', ''];
  return [`${a.action}:${a.do}`, ''];
}

export function describeAction(a) {
  if (!a) return 'event only';
  if (a.action === 'key') return a.combo;
  if (a.action === 'open') return `open ${a.target}`;
  return [a.action, a.do].filter(Boolean).join(' ').replace(/_/g, ' ');
}

/** Why a name cannot be used, or '' if it can. */
export function nameProblem(name) {
  if (!TR.NAME_RE.test(name)) return 'Use lowercase letters, digits and _ (start with a letter, up to 24).';
  if (GESTURE_NAMES.includes(name)) return `"${name}" is a built-in gesture. Pick another name.`;
  return '';
}

const CSS = `
.trainer { position: fixed; inset: 0; z-index: 210; background: rgb(6 8 11 / 0.94); color: rgb(236 230 214);
  font: 14px/1.5 'Avenir Next', Avenir, system-ui, sans-serif; display: grid; place-items: center; }
.tr-box { width: min(860px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; }
.tr-box h2 { font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; font-size: 13px; color: rgb(220 196 138); margin: 0 0 16px; }
.tr-cols { display: grid; grid-template-columns: 1.3fr 1fr; gap: 28px; }
@media (max-width: 700px) { .tr-cols { grid-template-columns: 1fr; } }
.tr-box label { display: block; margin: 0 0 12px; color: rgb(236 230 214 / 0.65); font-size: 12px; }
.tr-box input, .tr-box select { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 8px 10px;
  font: inherit; color: inherit; background: rgb(255 255 255 / 0.05); border: 1px solid rgb(220 196 138 / 0.3); border-radius: 6px; }
.tr-box select option { background: #10141a; }
.tr-box button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid rgb(220 196 138 / 0.6);
  background: transparent; color: rgb(220 196 138); cursor: pointer; margin-right: 8px; }
.tr-box button.primary { background: rgb(220 196 138); color: #0a0c10; }
.tr-box button:disabled { opacity: 0.35; cursor: default; }
.tr-status { margin: 12px 0 6px; min-height: 21px; }
.tr-status.err, .tr-warn { color: #e89a7a; }
.tr-ok { color: rgb(142 211 224); }
.tr-bar { height: 4px; background: rgb(255 255 255 / 0.08); margin-bottom: 12px; }
.tr-bar u { display: block; height: 100%; width: 0; background: rgb(220 196 138); }
.tr-report p { margin: 4px 0; }
.tr-side h3 { font-weight: 500; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: rgb(236 230 214 / 0.5); margin: 0 0 6px; }
.tr-live { font-size: 22px; color: rgb(220 196 138); margin-bottom: 18px; min-height: 33px; }
.tr-live small { font-size: 12px; color: rgb(236 230 214 / 0.5); }
.tr-list { list-style: none; padding: 0; margin: 0; }
.tr-list li { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid rgb(255 255 255 / 0.06); }
.tr-list li b { font-weight: 500; cursor: pointer; }
.tr-list li span { flex: 1; color: rgb(236 230 214 / 0.55); font-size: 12px; }
.tr-list li button { padding: 2px 8px; font-size: 12px; margin: 0; }
.tr-hint { color: rgb(236 230 214 / 0.45); font-size: 12px; margin-top: 18px; }
`;

export function initCustomGestures({ engine, bus = window }) {
  const emit = (type, detail = {}) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  let file = { version: 1, gestures: [] };
  let model = null;

  function apply() {
    model = new KnnClassifier().fit(file.gestures);
    engine.setCustomModel(file.gestures.length ? model : null);
    emit('gestures:updated', { gestures: file.gestures.map(({ name, action }) => ({ name, action })) });
  }

  async function load() {
    try {
      const r = await (await fetch(`${TR.HELPER}/gestures`)).json();
      if (Array.isArray(r?.gestures)) file = r;
    } catch { /* helper offline: no taught gestures */ }
    apply();
  }

  async function save(next) {
    try {
      const r = await fetch(`${TR.HELPER}/gestures`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      });
      const body = await r.json();
      if (!r.ok) return { ok: false, error: body.error || `Save failed (${r.status})` };
      file = next;
      apply();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Helper is not running. Start it in server/ with npm start' };
    }
  }

  // ── overlay ──
  let ui = null;

  function open() {
    if (ui) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    const root = document.createElement('div');
    root.className = 'trainer';
    root.innerHTML = `<div class="tr-box">
      <h2>Teach Jarvis a gesture</h2>
      <div class="tr-cols">
        <section>
          <label>Name<input data-t="name" maxlength="24" placeholder="peace" autocomplete="off" spellcheck="false"></label>
          <label>When Jarvis sees it
            <select data-t="kind">${ACTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
            <input data-t="param" autocomplete="off" spellcheck="false">
          </label>
          <button data-t="record" class="primary">Record ${TR.SAMPLES} samples</button><button data-t="save" disabled>Save</button>
          <div class="tr-status" data-t="status">Name it, pick what it does, then record.</div>
          <div class="tr-bar"><u data-t="bar"></u></div>
          <div class="tr-report" data-t="report"></div>
        </section>
        <section class="tr-side">
          <h3>Live</h3><div class="tr-live" data-t="live">–</div>
          <h3>Saved gestures</h3><ul class="tr-list" data-t="list"></ul>
        </section>
      </div>
      <p class="tr-hint">While recording, hold the shape and move it a little: closer, further, slightly turned. Gestures fire only while Jarvis is awake, and are paused while this screen is open. Esc closes.</p>
    </div>`;
    document.head.append(style);
    document.body.append(root);
    const q = (n) => root.querySelector(`[data-t="${n}"]`);
    const status = (text, cls = '') => { q('status').textContent = text; q('status').className = `tr-status ${cls}`; };

    let draft = null; // {name, samples, poses}
    let draftModel = null;
    let recording = null; // {samples, poses, last, startAt}
    let countdown = null;

    const syncParam = () => {
      const meta = ACTIONS.find(([v]) => v === q('kind').value);
      q('param').hidden = !meta?.[2];
      q('param').placeholder = meta?.[2] ?? '';
    };
    q('kind').addEventListener('change', syncParam);
    syncParam();

    const canSave = () => {
      const name = q('name').value.trim();
      const exists = file.gestures.some((g) => g.name === name);
      q('save').disabled = !!recording || !!nameProblem(name) || !(draft?.name === name || exists);
    };
    q('name').addEventListener('input', () => {
      const name = q('name').value.trim();
      const p = name ? nameProblem(name) : '';
      if (p) status(p, 'err');
      else if (draft && draft.name !== name) status('Name changed since recording. Record again, or save under the new name.');
      canSave();
    });

    function renderList() {
      const list = q('list');
      list.replaceChildren();
      if (!file.gestures.length) {
        const li = document.createElement('li');
        li.innerHTML = '<span>None yet.</span>';
        list.append(li);
      }
      for (const g of file.gestures) {
        const li = document.createElement('li');
        const b = document.createElement('b');
        b.textContent = g.name;
        b.title = 'Edit what it does';
        b.onclick = () => {
          q('name').value = g.name;
          const [kind, param] = actionTo(g.action);
          q('kind').value = kind; q('param').value = param; syncParam();
          draft = null; draftModel = null; q('report').replaceChildren();
          status(`Editing ${g.name}. Change what it does and Save, or record again to replace its samples.`);
          canSave();
        };
        const s = document.createElement('span');
        s.textContent = `${describeAction(g.action)} · ${g.samples.length} samples`;
        const del = document.createElement('button');
        del.textContent = 'Delete';
        del.onclick = async () => {
          if (!confirm(`Delete the gesture "${g.name}"?`)) return;
          const r = await save({ version: 1, gestures: file.gestures.filter((x) => x !== g) });
          status(r.ok ? `Deleted ${g.name}.` : r.error, r.ok ? '' : 'err');
          renderList(); canSave();
        };
        li.append(b, s, del);
        list.append(li);
      }
    }
    renderList();

    q('record').onclick = () => {
      const name = q('name').value.trim();
      const p = nameProblem(name);
      if (p) return status(p, 'err');
      clearInterval(countdown);
      let n = TR.COUNTDOWN_S;
      status(`Show the gesture… ${n}`);
      q('record').disabled = true;
      countdown = setInterval(() => {
        n--;
        if (n > 0) return status(`Show the gesture… ${n}`);
        clearInterval(countdown);
        recording = { name, samples: [], poses: [], last: -Infinity, startAt: performance.now() + TR.SETTLE_MS };
        status('Hold it…');
        setTimeout(() => { if (recording) status('Recording. Hold it, and move it a little.'); }, TR.SETTLE_MS);
        canSave();
      }, 1000);
    };

    function finishRecording() {
      draft = { name: recording.name, samples: recording.samples, poses: recording.poses };
      recording = null;
      q('record').disabled = false;
      q('record').textContent = 'Record again';
      const others = file.gestures.filter((g) => g.name !== draft.name);
      draftModel = new KnnClassifier().fit([...others, draft]);
      const ev = draftModel.evaluate();
      const mine = ev.per[draft.name];
      const acc = mine.correct / mine.total;
      const lines = [`<p class="${acc >= TR.WARN_ACCURACY ? 'tr-ok' : 'tr-warn'}">Recognised ${Math.round(acc * 100)}% of its own samples (leave-one-out).</p>`];
      const mixed = Object.entries(ev.confusions).filter(([k]) => k.split('->').includes(draft.name));
      for (const [k, n] of mixed) {
        const [from, to] = k.split('->');
        lines.push(`<p class="tr-warn">${n} sample(s) of ${from} looked like ${to}. Make the two shapes more different.</p>`);
      }
      const counts = {};
      for (const pose of draft.poses) if (pose !== 'none') counts[pose] = (counts[pose] ?? 0) + 1;
      const [builtin, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [];
      if (builtin && n / draft.poses.length >= TR.WARN_BUILTIN_SHARE) {
        lines.push(`<p class="tr-warn">This looks like the built-in ${builtin.replace('_', ' ')} gesture, so both would fire. A different shape is safer.</p>`);
      }
      if (acc < TR.WARN_ACCURACY) lines.push('<p>Try recording again with steadier light and your whole hand in view.</p>');
      q('report').innerHTML = lines.join('');
      status('Check the Live box: it should show the name while you hold the shape. Then Save.');
      canSave();
    }

    q('save').onclick = async () => {
      const name = q('name').value.trim();
      const p = nameProblem(name);
      if (p) return status(p, 'err');
      const action = actionFrom(q('kind').value, q('param').value);
      const old = file.gestures.find((g) => g.name === name);
      const samples = draft?.name === name ? draft.samples.map((f) => roundFeatures(f)) : old?.samples;
      if (!samples) return status('Record it first.', 'err');
      const entry = { name, action, samples };
      const next = { version: 1, gestures: old ? file.gestures.map((g) => (g === old ? entry : g)) : [...file.gestures, entry] };
      q('save').disabled = true;
      const r = await save(next);
      if (!r.ok) { status(r.error, 'err'); canSave(); return; }
      status(`Saved. Jarvis fires gesture:${name} (${describeAction(action)}) while awake.`);
      draft = null; draftModel = null;
      renderList(); canSave();
    };

    const off = engine.tapLandmarks((lm, aspect, t) => {
      const f = features(lm, aspect);
      if (recording && t >= recording.startAt && t - recording.last >= TR.SAMPLE_GAP_MS) {
        recording.last = t;
        recording.samples.push(f);
        const m = measure(lm, aspect);
        recording.poses.push(m.pinchRatio < T.PINCH_ON_RATIO ? 'pinch' : classifyPose(m));
        q('bar').style.width = `${(recording.samples.length / TR.SAMPLES) * 100}%`;
        if (recording.samples.length >= TR.SAMPLES) finishRecording();
      }
      const m = draftModel ?? model;
      if (!m?.samples.length) { q('live').innerHTML = '<small>Nothing taught yet</small>'; return; }
      const r = m.predict(f);
      q('live').innerHTML = r.name
        ? `${r.name} <small>${Math.round(r.confidence * 100)}%</small>`
        : `– <small>closest ${r.closest ?? '-'}, ${Number.isFinite(r.distance) ? r.distance.toFixed(2) : '-'} away</small>`;
    });
    const onHand = (e) => { if (!e.detail?.present) q('live').innerHTML = '<small>No hand in view</small>'; };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    bus.addEventListener('hand', onHand);
    bus.addEventListener('keydown', onKey);
    ui = {
      root, style,
      off: () => { off(); clearInterval(countdown); bus.removeEventListener('hand', onHand); bus.removeEventListener('keydown', onKey); },
    };
    emit('trainer:open', { on: true });
    q('name').focus();
  }

  function close() {
    if (!ui) return;
    ui.off();
    ui.root.remove();
    ui.style.remove();
    ui = null;
    emit('trainer:open', { on: false });
  }

  bus.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (e.shiftKey && e.key === TR.KEY_OPEN && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') open();
  });

  const ready = load();
  return { open, close, isOpen: () => !!ui, ready, gestures: () => file.gestures };
}
