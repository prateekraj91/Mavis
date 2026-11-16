// Compiles native/jarvis-input.swift to native/bin/jarvis-input with the Xcode
// command line tools (xcode-select --install). Run by `npm install` and, if the
// binary is missing or older than the source, by the helper at start.
//   node native/build.js
import { execFile } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const SRC = fileURLToPath(new URL('./jarvis-input.swift', import.meta.url));
export const BIN = fileURLToPath(new URL('./bin/jarvis-input', import.meta.url));
const BUILD_TIMEOUT_MS = 300000; // the first swiftc run can take a minute or two

const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
export const isStale = () => mtime(BIN) < mtime(SRC);

export async function build() {
  mkdirSync(fileURLToPath(new URL('./bin/', import.meta.url)), { recursive: true });
  await run('swiftc', ['-O', SRC, '-o', BIN], { timeout: BUILD_TIMEOUT_MS });
  return BIN;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') {
    console.log('jarvis-input: skipped (macOS only)');
  } else if (!isStale()) {
    console.log('jarvis-input: up to date');
  } else {
    console.log('jarvis-input: compiling (first time can take a minute)…');
    build()
      .then(() => console.log(`jarvis-input: built ${BIN}`))
      .catch((err) => {
        // Do not fail npm install: everything except cursor and keys still works.
        console.warn(`jarvis-input: build failed, cursor control and /key will be off.\n${err.stderr || err.message}`);
      });
  }
}
