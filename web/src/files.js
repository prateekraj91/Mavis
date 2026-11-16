// Holographic folder browser. Presentation only, like hud.js: it draws the
// listing it is sent and reports which card was picked. It never calls the helper.
//
// Listens for
//   files:list {path, name, display, parent, total, entries:[{name, path, type, ext, size, mtime}]}
//   files:page {step}            next / previous page
//   files:activate               open the card under the hand (sent on a pinch)
//   hand:move, pinch:start, hand:lost     from the gesture engine, for hover and tilt
// Emits
//   files:pick {path, type, name}         a card was pinched or clicked
// Visible while the HUD has data-app="files" (hud.js sets that on app:open {app:'Files'}).

const COLS = 5;
const ROWS = 3;
const PER_PAGE = COLS * ROWS;
const FLY_MS = 520;
const FLY_STAGGER_MS = 26;
const LATCH_MS = 1500; // a pinch opens the card that was under the hand just before pinching
const HIT_PAD = 8; // px of forgiveness around a card

const ICON_DIR = '<svg viewBox="0 0 24 24"><path d="M3 7.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V9a1.5 1.5 0 0 0-1.5-1.5H12L10 5H4.5A1.5 1.5 0 0 0 3 6.5z"/></svg>';
const ICON_FILE = '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg>';

const size = (b) => {
  if (b == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1000 && i < units.length - 1) { b /= 1000; i++; }
  return `${b < 10 && i ? b.toFixed(1) : Math.round(b)} ${units[i]}`;
};
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function initFiles({ root = document.getElementById('hud'), bus = window } = {}) {
  const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail || {}));
  const send = (type, detail = {}) => bus.dispatchEvent(new CustomEvent(type, { detail }));

  const view = document.createElement('section');
  view.className = 'files';
  view.setAttribute('aria-label', 'Folder browser');
  view.innerHTML = `
    <header><div class="files-path"></div><div class="files-count"></div></header>
    <div class="files-stage"><div class="files-grid"></div><p class="files-empty" hidden>This folder is empty.</p></div>
    <footer><span>Pinch a card to open it. Make a fist to go back.</span><span class="files-page"></span></footer>`;
  root.append(view);
  const grid = view.querySelector('.files-grid');
  const stage = view.querySelector('.files-stage');

  let listing = null;
  let page = 0;
  let hot = null;
  let latched = null;
  let latchedAt = 0;
  const visible = () => root.dataset.app === 'files';
  const pages = () => Math.max(1, Math.ceil((listing?.entries.length ?? 0) / PER_PAGE));

  function setHot(card) {
    if (card === hot) return;
    hot?.classList.remove('hot');
    hot = card;
    hot?.classList.add('hot');
  }

  function card(entry, i) {
    const el = document.createElement('button');
    el.className = `fcard ${entry.type}`;
    el.style.setProperty('--z', `${((i * 37) % 5) * 9}px`);
    el.style.setProperty('--bob', `${-((i * 53) % 60) / 10}s`);
    el.innerHTML = `<div class="fcard-in"><div class="fcard-icon">${entry.type === 'dir' ? ICON_DIR : ICON_FILE}<b></b></div><div class="fcard-name"></div><div class="fcard-meta"></div></div>`;
    el.querySelector('b').textContent = entry.type === 'file' ? entry.ext.slice(0, 4) : '';
    el.querySelector('.fcard-name').textContent = entry.name;
    el.querySelector('.fcard-meta').textContent = entry.type === 'dir' ? `Folder, ${day(entry.mtime)}` : `${size(entry.size)}, ${day(entry.mtime)}`;
    el.entry = entry;
    el.addEventListener('click', () => choose(el));
    return el;
  }

  function draw() {
    setHot(null);
    latched = null;
    const all = listing.entries;
    const shown = all.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
    view.querySelector('.files-path').textContent = listing.display.replace(/\//g, ' / ');
    view.querySelector('.files-count').textContent =
      listing.total > all.length ? `First ${all.length} of ${listing.total} items` : `${all.length} ${all.length === 1 ? 'item' : 'items'}`;
    view.querySelector('.files-page').textContent = pages() > 1 ? `Page ${page + 1} of ${pages()}. Swipe to turn.` : '';
    view.querySelector('.files-empty').hidden = all.length > 0;
    grid.replaceChildren(...shown.map(card));

    // Cards fly out from the centre of the stage to their places.
    const s = stage.getBoundingClientRect();
    const cx = s.left + s.width / 2;
    const cy = s.top + s.height / 2;
    [...grid.children].forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const dx = cx - (r.left + r.width / 2);
      const dy = cy - (r.top + r.height / 2);
      el.animate(
        [{ transform: `translate3d(${dx}px, ${dy}px, -260px) scale(0.2)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: FLY_MS, delay: i * FLY_STAGGER_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'backwards' },
      );
    });
  }

  function choose(el) {
    if (!el?.entry) return;
    el.classList.remove('picked');
    void el.offsetWidth;
    el.classList.add('picked');
    send('files:pick', { path: el.entry.path, type: el.entry.type, name: el.entry.name });
  }

  on('files:list', (d) => { listing = d; page = 0; requestAnimationFrame(draw); });
  on('files:page', (d) => {
    if (!listing || !visible()) return;
    const next = Math.max(0, Math.min(pages() - 1, page + (d.step || 0)));
    if (next !== page) { page = next; draw(); }
  });
  on('files:activate', () => {
    if (!visible()) return;
    const target = latched && performance.now() - latchedAt < LATCH_MS && latched.isConnected ? latched : hot;
    if (target) choose(target);
    else send('hud:say', { text: 'Point at a card, then pinch' });
  });

  on('hand:move', (d) => {
    if (!visible()) return;
    grid.style.setProperty('--tx', ((d.x - 0.5) * 2).toFixed(3));
    grid.style.setProperty('--ty', ((d.y - 0.5) * 2).toFixed(3));
    if (d.pinched) return; // the pointer jumps to the fingertips while pinched: keep the hover
    const x = d.x * innerWidth;
    const y = d.y * innerHeight;
    let found = null;
    for (const el of grid.children) {
      const r = el.getBoundingClientRect();
      if (x >= r.left - HIT_PAD && x <= r.right + HIT_PAD && y >= r.top - HIT_PAD && y <= r.bottom + HIT_PAD) { found = el; break; }
    }
    setHot(found);
  });
  on('pinch:start', () => { latched = hot; latchedAt = performance.now(); });
  on('hand:lost', () => setHot(null));
}
