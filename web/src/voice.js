// Voice: continuous Web Speech recognition, wake-word gating, keyword command parser.
// No model calls. While ASLEEP nothing is shown or acted on except the wake word.
//
//   startVoice({ engine, execute })   call from a user click
//     engine   GestureEngine (wake / sleep / noteActivity / state)
//     execute  function(cmd) from api.js, e.g. {action:'spotify', do:'next'}
//
// Emits: voice:listening {on}, voice:heard {text, final}

// ───────────────────────── tunables ─────────────────────────
export const V = {
  LANG: 'en-IN', // try 'en-US' if recognition is poor
  // How the recogniser tends to spell it. Add what the voice pill shows when it mishears you.
  WAKE_WORDS: ['jarvis', 'jarvas', 'jarvus', 'javis', 'jervis', 'jarves', 'jarviz', 'jar vis', 'charvis'],
  MAX_ALTERNATIVES: 3,
  RESTART_MS: 250, // Chrome stops after silence; restart this soon after
  RESTART_ERROR_MS: 2000, // after a network error
};

const FILLER_START = /^(?:(?:hey|ok|okay|please|can you|could you|will you)\s+)+/;
const FILLER_END = /(?:\s+please)+$/;

export function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}.\s]/gu, ' ')
    .replace(/\.(?=\s|$)/g, ' ') // sentence dots go, "youtube.com" stays
    .replace(/\s+/g, ' ')
    .trim();
}

/** Finds the wake word. `rest` is whatever was said after it. */
export function stripWake(text) {
  const s = normalise(text);
  let end = -1;
  for (const w of V.WAKE_WORDS) {
    const m = [...s.matchAll(new RegExp(`(?:^|\\s)${w}(?=\\s|$)`, 'g'))].pop();
    if (m) end = Math.max(end, m.index + m[0].length);
  }
  return end < 0 ? { hasWake: false, rest: s } : { hasWake: true, rest: s.slice(end).trim() };
}

// Whole-utterance matches only, so song lyrics and conversation rarely trigger anything.
const RULES = [
  // Cursor control (before "start/open ..." so "start the cursor" is not an app).
  [/^(?:cursor|mouse)(?: mode)?(?: on)?$|^(?:start|enable|turn on|use) (?:the )?(?:cursor|mouse)(?: mode)?$/, () => ({ action: 'cursor', do: 'on' })],
  [/^(?:cursor|mouse)(?: mode)? off$|^(?:stop|disable|turn off|exit|leave|end) (?:the )?(?:cursor|mouse)(?: mode)?$/, () => ({ action: 'cursor', do: 'off' })],
  [/^calibrate(?: (?:the )?(?:cursor|mouse|camera|hand))?$/, () => ({ action: 'cursor', do: 'calibrate' })],
  [/^(?:teach|train)(?: jarvis| you| me)? (?:a |an )?(?:new )?gesture$|^(?:new|custom) gesture$|^(?:open )?(?:the )?gesture trainer$/, () => ({ action: 'trainer', do: 'open' })],
  [/^dwell(?: click(?:ing)?)? (on|off)$|^(?:turn )?(on|off) dwell(?: click(?:ing)?)?$/, (m) => ({ action: 'cursor', do: `dwell_${m[1] || m[2]}` })],
  [/^(?:go to sleep|sleep|good ?night|goodbye|thats all|that will be all)$/, () => ({ action: 'sleep' })],
  [/^(?:back|go back|go up|up|up a level)$/, () => ({ action: 'back' })],
  [/^close(?: it| (?:the )?(?:panel|spotify))?$/, () => ({ action: 'close' })],
  [/^(?:set )?(?:the )?volume (?:to |at )?(\d{1,3})(?: percent)?$/, (m) => ({ action: 'spotify', do: 'set_volume', level: Math.min(100, Number(m[1])) })],
  [/^(?:volume up|louder|turn (?:it |the volume )?up|(?:increase|raise) (?:the )?volume)$/, () => ({ action: 'spotify', do: 'volume_up' })],
  [/^(?:volume down|quieter|softer|turn (?:it |the volume )?down|(?:decrease|lower|reduce) (?:the )?volume)$/, () => ({ action: 'spotify', do: 'volume_down' })],
  [/^(?:pause|stop)(?: (?:the )?(?:music|song|track))?$/, () => ({ action: 'spotify', do: 'pause' })],
  [/^(?:resume|continue|unpause|play|play (?:the )?music)$/, () => ({ action: 'spotify', do: 'resume' })],
  [/^(?:next|skip)(?: (?:this|it|one|(?:the |this )?(?:song|track)))?$|^play (?:the )?next(?: (?:song|track|one))?$/, () => ({ action: 'spotify', do: 'next' })],
  [/^previous(?: (?:song|track|one))?$|^(?:last|play (?:the )?(?:previous|last)) (?:song|track|one)$/, () => ({ action: 'spotify', do: 'previous' })],
  [/^(?:like|save)(?: (?:this|it|(?:the |this )?(?:song|track)))?$/, () => ({ action: 'spotify', do: 'like' })],
  [/^(?:open|launch|start|show)(?: up)? (?:the )?(.+?)(?: app)?$/, (m) => ({ action: 'open', target: m[1] })],
  [/^play (?:me )?(?:the song )?(.+?)(?: on spotify)?$/, (m) => ({ action: 'spotify', do: 'play', query: m[1] })],
];

/** "open spotify" -> {action:'open', target:'spotify'}; null if it is not a command. */
export function parseCommand(text) {
  const s = normalise(text).replace(FILLER_START, '').replace(FILLER_END, '');
  if (!s) return null;
  for (const [re, build] of RULES) {
    const m = s.match(re);
    if (m) return build(m);
  }
  return null;
}

export function startVoice({ engine, execute, bus = window }) {
  const send = (type, detail = {}) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    send('hud:say', { text: 'Voice needs Chrome' });
    return { stop() {} };
  }

  const rec = new Recognition();
  rec.lang = V.LANG;
  rec.continuous = true;
  rec.interimResults = true; // the wake word is caught mid-sentence, before the result is final
  rec.maxAlternatives = V.MAX_ALTERNATIVES;

  let stopped = false;
  let announced = false;
  let restartMs = V.RESTART_MS;
  const begin = () => { if (!stopped) { try { rec.start(); } catch { /* already running */ } } };

  rec.onstart = () => {
    restartMs = V.RESTART_MS;
    if (!announced) { announced = true; send('voice:listening', { on: true }); }
  };

  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const alts = Array.from(result, (a) => a.transcript.trim()).filter(Boolean);
      if (!alts.length) continue;

      const woke = alts.map(stripWake).find((w) => w.hasWake);
      if (woke) engine.wake('voice'); // also resets the idle timer if already awake
      if (engine.state !== 'AWAKE') continue; // asleep and no wake word: ignore completely

      send('voice:heard', { text: alts[0], final: result.isFinal });
      if (!result.isFinal) continue;

      // Try each alternative; with a wake word, only what came after it.
      let cmd = null;
      for (const alt of alts) {
        const w = stripWake(alt);
        cmd = parseCommand(w.hasWake ? w.rest : alt);
        if (cmd) break;
      }
      if (!cmd) continue;
      engine.noteActivity();
      if (cmd.action === 'sleep') engine.sleep('voice');
      else execute(cmd);
    }
  };

  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      stopped = true;
      send('voice:listening', { on: false });
      send('hud:say', { text: 'Microphone is blocked for this page' });
    } else if (e.error === 'network') {
      restartMs = V.RESTART_ERROR_MS;
    } // no-speech and aborted are routine
  };

  rec.onend = () => { if (!stopped) setTimeout(begin, restartMs); };

  begin();
  return {
    stop() {
      stopped = true;
      announced = false;
      try { rec.stop(); } catch { /* not running */ }
      send('voice:listening', { on: false });
    },
  };
}
