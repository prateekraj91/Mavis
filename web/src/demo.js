// Demo mode (open /?demo): fake data + keyboard, so the HUD can be checked
// and recorded without the helper or voice. Not loaded otherwise.
//   W wake   S sleep   O open/close Spotify   Space play/pause
//   ← → previous/next   ↑ ↓ volume   L like   V fake voice line
//   F folder browser (click a card, or P to pick the card under the hand)   B back
const say = (type, detail = {}) => window.dispatchEvent(new CustomEvent(type, { detail }));

const TRACKS = [
  { title: 'Midnight Circuit', artist: 'Demo Artist', durationMs: 214000 },
  { title: 'Glass Horizon', artist: 'Another Demo', durationMs: 187000 },
  { title: 'Slow Orbit', artist: 'Demo Artist', durationMs: 251000 },
];

export function runDemo(engine) {
  let i = 0, playing = true, volume = 60, liked = false, open = false;
  const track = (positionMs = 0) => say('spotify:state', { ...TRACKS[i], artUrl: '', positionMs, playing, volume, liked });
  const act = (does, label) => say('action', { action: 'spotify', do: does, label });

  say('today:list', { items: [
    { time: '09:00', text: 'Compilers lecture', done: true },
    { time: '14:30', text: 'Tune gesture thresholds' },
    { time: '18:00', text: 'Record the first clip' },
    { text: 'Push the repo' },
  ] });
  const stats = () => say('system:stats', { cpu: 18 + Math.random() * 30, mem: 61 + Math.random() * 6, battery: 82, charging: true });
  stats();
  setInterval(stats, 2500);
  say('voice:listening', { on: true });
  track(42000);

  // Fake folders for the browser.
  const exts = ['pdf', 'png', 'mp4', 'zip', 'docx', 'py', 'csv', 'mp3'];
  const folder = (name, parent, n) => ({
    ok: true, path: `/demo/${name}`, name, display: `~/${name}`, parent, total: n,
    entries: Array.from({ length: n }, (_, j) => j < 4
      ? { name: ['Projects', 'Screenshots', 'Coursework', 'Invoices'][j], path: `/demo/sub${j}`, type: 'dir', ext: '', size: null, mtime: Date.now() - j * 864e5 }
      : { name: `Sample file ${j - 3}.${exts[j % exts.length]}`, path: `/demo/f${j}`, type: 'file', ext: exts[j % exts.length], size: 40000 * (j + 1) ** 2, mtime: Date.now() - j * 36e5 }),
  });
  let here = null;
  const show = (f) => { here = f; say('app:open', { app: 'Files' }); say('files:list', f); };
  addEventListener('files:pick', (e) => {
    if (e.detail.type === 'dir') show(folder(e.detail.name, here.path, 9));
    else say('hud:say', { text: `Opening ${e.detail.name}` });
  });

  addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'w') engine.wake('key');
    else if (k === 's') engine.sleep('key');
    else if (k === 'o') { open = !open; say(open ? 'app:open' : 'app:close', { app: 'Spotify' }); if (open) say('hud:say', { text: 'Opening Spotify' }); }
    else if (k === ' ') { playing = !playing; say('spotify:state', { playing }); act('playpause', playing ? 'Playing' : 'Paused'); }
    else if (k === 'ArrowRight') { i = (i + 1) % TRACKS.length; liked = false; track(); act('next', 'Next track'); }
    else if (k === 'ArrowLeft') { i = (i + TRACKS.length - 1) % TRACKS.length; liked = false; track(); act('previous', 'Previous track'); }
    else if (k === 'ArrowUp' || k === 'ArrowDown') {
      volume = Math.max(0, Math.min(100, volume + (k === 'ArrowUp' ? 6 : -6)));
      say('spotify:state', { volume });
      act(k === 'ArrowUp' ? 'volume_up' : 'volume_down', `Volume ${volume}`);
    }
    else if (k === 'l') { liked = !liked; say('spotify:state', { liked }); act('like', liked ? 'Liked' : 'Like removed'); }
    else if (k === 'f') show(folder('Downloads', null, 23));
    else if (k === 'b') { if (here?.parent) show(folder('Downloads', null, 23)); else { here = null; say('app:close'); } }
    else if (k === 'p') say('files:activate');
    else if (k === 'PageDown' || k === 'PageUp') say('files:page', { step: k === 'PageDown' ? 1 : -1 });
    else if (k === 'v') say('voice:heard', { text: 'Mavis, open Spotify', final: true });
    else return;
    engine.noteActivity();
    e.preventDefault();
  });
}
