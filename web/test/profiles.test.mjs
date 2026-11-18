// Profile files and front-app matching. Run: npm test
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { checkProfile, profileForFront } from '../src/profiles.js';
import { GESTURE_NAMES } from '../src/gestures.js';
import { parseCombo } from '../../server/keys.js';

const dir = new URL('../profiles/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const profiles = files.map((f) => ({ file: f, ...JSON.parse(readFileSync(new URL(f, dir), 'utf8')) }));
const byName = (n) => profiles.find((p) => p.app === n);
const isValidCombo = (c) => { try { parseCombo(c); return true; } catch { return false; } };
const CHROME = 'com.google.Chrome';

const tests = {
  'every profile file is valid: known gestures, actions, key combos the helper accepts'() {
    const gestureNames = new Set(GESTURE_NAMES);
    const problems = profiles.flatMap((p) => checkProfile(p, { gestureNames, isValidCombo }).map((e) => `${p.file}: ${e}`));
    assert.deepEqual(problems, []);
  },
  'the required apps all have a profile'() {
    for (const n of ['Chrome', 'YouTube', 'VS Code', 'Finder', 'Zoom', 'Google Meet', 'Keynote', 'PowerPoint', 'Spotify', 'Files']) {
      assert.ok(byName(n), `no profile for ${n}`);
    }
  },
  'app names are unique'() {
    const names = profiles.map((p) => p.app.toLowerCase());
    assert.equal(new Set(names).size, names.length);
  },
  'front app by bundle id'() {
    assert.equal(profileForFront({ bundleId: 'com.apple.finder' }, profiles)?.app, 'Finder');
    assert.equal(profileForFront({ bundleId: 'com.microsoft.VSCode' }, profiles)?.app, 'VS Code');
    assert.equal(profileForFront({ bundleId: 'us.zoom.xos' }, profiles)?.app, 'Zoom');
    assert.equal(profileForFront({ bundleId: 'com.apple.iWork.Keynote' }, profiles)?.app, 'Keynote');
    assert.equal(profileForFront({ bundleId: 'com.microsoft.Powerpoint' }, profiles)?.app, 'PowerPoint');
    assert.equal(profileForFront({ bundleId: 'com.spotify.client' }, profiles)?.app, 'Spotify');
  },
  'a browser tab beats the browser app'() {
    assert.equal(profileForFront({ bundleId: CHROME, host: 'www.youtube.com' }, profiles)?.app, 'YouTube');
    assert.equal(profileForFront({ bundleId: CHROME, host: 'm.youtube.com' }, profiles)?.app, 'YouTube');
    assert.equal(profileForFront({ bundleId: CHROME, host: 'music.youtube.com' }, profiles)?.app, 'YouTube');
    assert.equal(profileForFront({ bundleId: 'com.apple.Safari', host: 'meet.google.com' }, profiles)?.app, 'Google Meet');
    assert.equal(profileForFront({ bundleId: CHROME, host: 'github.com' }, profiles)?.app, 'Chrome');
    assert.equal(profileForFront({ bundleId: CHROME, host: '' }, profiles)?.app, 'Chrome');
  },
  'look-alike hosts do not match'() {
    assert.equal(profileForFront({ bundleId: CHROME, host: 'notyoutube.com' }, profiles)?.app, 'Chrome');
    assert.equal(profileForFront({ bundleId: CHROME, host: 'youtube.com.evil.io' }, profiles)?.app, 'Chrome');
  },
  'Mavis own tab in front: no app profile (the panel profile applies)'() {
    assert.equal(profileForFront({ bundleId: CHROME, host: 'localhost:5173' }, profiles), null);
    assert.equal(profileForFront({ bundleId: CHROME, host: '127.0.0.1:5173' }, profiles), null);
  },
  'unknown app or nothing in front: no profile'() {
    assert.equal(profileForFront({ bundleId: 'com.apple.Notes' }, profiles), null);
    assert.equal(profileForFront({ bundleId: '' }, profiles), null);
    assert.equal(profileForFront(null, profiles), null);
  },
  'only Spotify and Files are panel profiles (opening Chrome must not make it the panel)'() {
    assert.deepEqual(profiles.filter((p) => p.panel).map((p) => p.app).sort(), ['Files', 'Spotify']);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`ok    ${name}`); }
  catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}
console.log(failed ? `\n${failed} failed` : '\nprofiles: all passed');
process.exit(failed ? 1 : 0);
