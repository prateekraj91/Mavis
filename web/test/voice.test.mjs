// Command parser tests. Run: npm test
import assert from 'node:assert/strict';
import { parseCommand, stripWake } from '../src/voice.js';

const sp = (d, extra = {}) => ({ action: 'spotify', do: d, ...extra });
const cases = [
  ['open Spotify', { action: 'open', target: 'spotify' }],
  ['Open the Spotify app please', { action: 'open', target: 'spotify' }],
  ['launch VS Code', { action: 'open', target: 'vs code' }],
  ['open youtube.com.', { action: 'open', target: 'youtube.com' }],
  ['play Blinding Lights', sp('play', { query: 'blinding lights' })],
  ['Play Shape of You on Spotify', sp('play', { query: 'shape of you' })],
  ["play don't stop me now", sp('play', { query: 'dont stop me now' })],
  ['play', sp('resume')], ['resume', sp('resume')], ['play music', sp('resume')],
  ['Pause.', sp('pause')], ['stop the music', sp('pause')],
  ['next', sp('next')], ['skip this song', sp('next')], ['play the next song', sp('next')],
  ['previous', sp('previous')], ['play the previous track', sp('previous')],
  ['volume up', sp('volume_up')], ['turn it down', sp('volume_down')],
  ['set volume to 40', sp('set_volume', { level: 40 })], ['volume 250', sp('set_volume', { level: 100 })],
  ['like this song', sp('like')],
  ['sleep', { action: 'sleep' }], ['go to sleep', { action: 'sleep' }],
  ['close', { action: 'close' }],
  ['go back', { action: 'back' }], ['back', { action: 'back' }], ['open Downloads', { action: 'open', target: 'downloads' }],
  ['cursor mode', { action: 'cursor', do: 'on' }], ['mouse on', { action: 'cursor', do: 'on' }],
  ['start the cursor', { action: 'cursor', do: 'on' }], ['cursor off', { action: 'cursor', do: 'off' }],
  ['stop mouse mode', { action: 'cursor', do: 'off' }], ['calibrate', { action: 'cursor', do: 'calibrate' }],
  ['calibrate the cursor', { action: 'cursor', do: 'calibrate' }], ['dwell click on', { action: 'cursor', do: 'dwell_on' }],
  ['turn off dwell', { action: 'cursor', do: 'dwell_off' }],
  ['teach Mavis a gesture', { action: 'trainer', do: 'open' }], ['train a new gesture', { action: 'trainer', do: 'open' }],
  ['new gesture', { action: 'trainer', do: 'open' }], ['open the gesture trainer', { action: 'trainer', do: 'open' }], ['start chrome', { action: 'open', target: 'chrome' }],
  ['I should open a bank account and next week we pause', null],
  ['what is the next step', null], ['', null], ['i could not sleep', null],
];
let failed = 0;
for (const [text, want] of cases) {
  try { assert.deepEqual(parseCommand(text), want); }
  catch { failed++; console.log(`FAIL  "${text}" -> ${JSON.stringify(parseCommand(text))}, want ${JSON.stringify(want)}`); }
}
const wake = [
  ['Mavis, open Spotify', true, 'open spotify'], ['hey Mavis', true, ''], ['Mavis sleep', true, 'sleep'],
  ['open spotify', false, 'open spotify'], ['may vis next', true, 'next'], ['Mavis\'s volume up', true, 'volume up'], ['mave is pause', true, 'pause'], ['the mavis thing Mavis pause', true, 'pause'],
  ['service is down', false, 'service is down'],
];
for (const [text, has, rest] of wake) {
  const w = stripWake(text);
  if (w.hasWake !== has || w.rest !== rest) { failed++; console.log(`FAIL  wake "${text}" -> ${JSON.stringify(w)}`); }
}
console.log(failed ? `${failed} failed` : `voice: all ${cases.length + wake.length} passed`);
process.exit(failed ? 1 : 0);
