// System stats for the HUD: CPU, memory and battery as percentages.
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MEM_CACHE_MS = 4000;
const BATTERY_CACHE_MS = 30000;

const cpuSnapshot = () => {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
};
let prevCpu = cpuSnapshot();
let lastCpu = 0;

function cpu() {
  const now = cpuSnapshot();
  const dt = now.total - prevCpu.total;
  if (dt > 0) { lastCpu = 100 * (1 - (now.idle - prevCpu.idle) / dt); prevCpu = now; }
  return Math.round(lastCpu);
}

const cached = (ms, fn) => {
  let at = 0, value;
  return async () => {
    if (Date.now() - at > ms) { value = await fn().catch(() => null); at = Date.now(); }
    return value;
  };
};

// os.freemem() counts cache as used on macOS, so read vm_stat instead.
const mem = cached(MEM_CACHE_MS, async () => {
  try {
    const { stdout } = await run('vm_stat', [], { timeout: 2000 });
    const page = Number(stdout.match(/page size of (\d+) bytes/)?.[1]) || 4096;
    const pages = (label) => Number(stdout.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1]) || 0;
    const used = (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page;
    return Math.round((100 * used) / os.totalmem());
  } catch {
    return Math.round(100 * (1 - os.freemem() / os.totalmem()));
  }
});

const battery = cached(BATTERY_CACHE_MS, async () => {
  const { stdout } = await run('pmset', ['-g', 'batt'], { timeout: 2000 });
  const level = stdout.match(/(\d+)%/);
  if (!level) return null;
  return { battery: Number(level[1]), charging: /AC Power/.test(stdout) };
});

export async function stats() {
  const [m, b] = await Promise.all([mem(), battery()]);
  return { cpu: cpu(), mem: m ?? undefined, ...(b ?? {}), host: os.hostname() };
}
