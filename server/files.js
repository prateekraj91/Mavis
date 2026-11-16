// Folder listing for the holographic browser. Nothing outside the home folder is reachable.
import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';

const HOME = os.homedir();
const MAX_ENTRIES = 300;
const ALIASES = { home: '', docs: 'documents', download: 'downloads', document: 'documents', picture: 'pictures', photos: 'pictures', videos: 'movies' };
// `open` would run these instead of showing them.
const BLOCKED_EXT = new Set(['.app', '.command', '.tool', '.pkg', '.dmg', '.terminal', '.workflow', '.scpt', '.action', '.sh']);

const key = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const inHome = (p) => p === HOME || p.startsWith(HOME + sep);

/** "downloads" -> /Users/you/Downloads, by matching the top-level folders in home. */
export async function findHomeFolder(name) {
  let k = key(name);
  if (!k) return null;
  if (k in ALIASES) k = ALIASES[k];
  if (k === '') return HOME;
  for (const d of await readdir(HOME, { withFileTypes: true })) {
    if (d.isDirectory() && !d.name.startsWith('.') && key(d.name) === k) return join(HOME, d.name);
  }
  return null;
}

/** Resolve a path or folder name to a real path inside home, or throw. */
export async function safePath(input) {
  let p = String(input ?? '').trim();
  if (!p || p === '~') p = HOME;
  else if (p.startsWith('~/')) p = join(HOME, p.slice(2));
  else if (!isAbsolute(p)) p = (await findHomeFolder(p)) ?? '';
  if (!p) throw new Error('No folder with that name');
  const real = await realpath(p); // also resolves symlinks, so a link cannot escape home
  if (!inHome(real)) throw new Error('Only things inside your home folder can be opened');
  return real;
}

export async function listFolder(input) {
  const path = await safePath(input);
  const names = (await readdir(path)).filter((n) => !n.startsWith('.') && n !== 'Icon\r');
  const entries = (
    await Promise.all(
      names.slice(0, MAX_ENTRIES).map(async (name) => {
        try {
          const s = await stat(join(path, name));
          const dir = s.isDirectory() && extname(name).toLowerCase() !== '.app';
          return {
            name,
            path: join(path, name),
            type: dir ? 'dir' : 'file',
            ext: dir ? '' : extname(name).slice(1).toLowerCase(),
            size: dir ? null : s.size,
            mtime: s.mtimeMs,
          };
        } catch {
          return null; // broken link or no permission
        }
      }),
    )
  ).filter(Boolean);
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
  return {
    ok: true,
    path,
    name: path === HOME ? 'Home' : basename(path),
    display: '~' + path.slice(HOME.length),
    parent: path === HOME ? null : dirname(path),
    total: names.length,
    entries,
  };
}

/** A file path that is safe to hand to `open`. */
export async function openablePath(input) {
  const real = await safePath(input);
  if (BLOCKED_EXT.has(extname(real).toLowerCase())) throw new Error('That kind of file is not opened from here');
  return real;
}

export function fsError(err) {
  if (err?.code === 'EPERM' || err?.code === 'EACCES') {
    return 'macOS blocked this folder. Allow Terminal under System Settings > Privacy & Security > Files and Folders.';
  }
  if (err?.code === 'ENOENT') return 'That folder does not exist';
  if (err?.code === 'ENOTDIR') return 'That is not a folder';
  return String(err?.message ?? err).slice(0, 200);
}
