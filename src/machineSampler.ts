import { existsSync, readdirSync, readFileSync } from "node:fs";
import { arch, cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { db, users } from "./db.js";
import { recordMachine, recordSamples, type SampleInput } from "./usageStore.js";

// The machine's load, when no Twoody Desktop measures it for this server
// (a Raspberry Pi, a NAS): CPU, memory and, where Linux shows it, GPU,
// every 15 s — the same samples the Desktop posts to /usage/samples, so
// the usage screen of a headless computer is not empty, and the router
// (router/score.ts) knows when it is busy.
//
// The last two samples are also kept in memory: the status a computer
// publishes (account/statusSource.ts) carries the latest, and the router
// looks at two in a row before calling a machine hot.

export const SAMPLE_EVERY_MS = 15_000;

export interface LoadSample {
  at: Date;
  cpuPct: number | null;
  gpuPct: number | null;
  ramUsedPct: number | null;
  ramUsedBytes: number | null;
  ramTotalBytes: number | null;
}

const recent: LoadSample[] = [];

/// The latest samples, newest last (two at most).
export function recentLoad(): LoadSample[] {
  return recent.slice();
}

/// Only for tests.
export function setRecentLoad(samples: LoadSample[]): void {
  recent.splice(0, recent.length, ...samples.slice(-2));
}

type CpuTimes = { idle: number; total: number };

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/// Memory in use: MemAvailable on Linux (free memory counts the page cache
/// as used, which on a Pi reads 90 % all day), free memory elsewhere.
export function memoryUse(meminfo: string | null = readText("/proc/meminfo")): { used: number; total: number } {
  if (meminfo) {
    const total = /MemTotal:\s+(\d+) kB/.exec(meminfo);
    const available = /MemAvailable:\s+(\d+) kB/.exec(meminfo);
    if (total && available) {
      const t = Number(total[1]) * 1024;
      return { total: t, used: Math.max(0, t - Number(available[1]) * 1024) };
    }
  }
  const t = totalmem();
  return { total: t, used: Math.max(0, t - freemem()) };
}

/// A GPU busy figure where Linux gives one without a vendor tool: AMD's
/// gpu_busy_percent, or a Jetson / Mali-style devfreq load. Null elsewhere.
export function gpuBusy(root = "/sys/class/drm"): number | null {
  try {
    if (!existsSync(root)) return null;
    for (const card of readdirSync(root)) {
      if (!/^card\d+$/.test(card)) continue;
      const busy = readText(`${root}/${card}/device/gpu_busy_percent`);
      if (busy !== null && /^\d+/.test(busy.trim())) return Math.min(100, Number(busy.trim()));
    }
  } catch {
    // no GPU figure
  }
  const jetson = readText("/sys/devices/gpu.0/load");
  if (jetson && /^\d+/.test(jetson.trim())) return Math.min(100, Number(jetson.trim()) / 10);
  return null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export interface MachineSampler {
  stop(): void;
}

/// Starts sampling; `record` false keeps the samples in memory only.
export function startMachineSampler(options: { everyMs?: number; record?: boolean; log?: (message: string) => void } = {}): MachineSampler {
  const everyMs = options.everyMs ?? SAMPLE_EVERY_MS;
  let previous = cpuTimes();
  let machineRecorded = false;

  const tick = () => {
    const now = cpuTimes();
    const total = now.total - previous.total;
    const cpuPct = total > 0 ? Math.round((1 - (now.idle - previous.idle) / total) * 1000) / 10 : null;
    previous = now;
    const memory = memoryUse();
    const sample: LoadSample = {
      at: new Date(),
      cpuPct,
      gpuPct: gpuBusy(),
      ramUsedPct: memory.total > 0 ? Math.round((memory.used / memory.total) * 1000) / 10 : null,
      ramUsedBytes: memory.used,
      ramTotalBytes: memory.total,
    };
    recent.push(sample);
    while (recent.length > 2) recent.shift();
    if (options.record === false) return;
    try {
      const row: SampleInput = {
        at: sample.at,
        cpuPct: sample.cpuPct,
        ramUsedBytes: sample.ramUsedBytes,
        ramTotalBytes: sample.ramTotalBytes,
        gpuPct: sample.gpuPct,
        runtimeRssBytes: null,
        appRssBytes: process.memoryUsage().rss,
      };
      for (const { id } of db.select({ id: users.id }).from(users).all()) {
        recordSamples(id, [row]);
        if (!machineRecorded) {
          recordMachine(id, {
            cpuModel: cpus()[0]?.model?.trim() || null,
            cores: cpus().length || null,
            ramTotalBytes: totalmem(),
            gpuName: null,
            os: `${systemName()} (${arch()}) — ${hostname()}`,
          });
        }
      }
      machineRecorded ||= db.select({ id: users.id }).from(users).limit(1).all().length > 0;
    } catch (err) {
      options.log?.(`machine sample not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const first = setTimeout(tick, Math.min(everyMs, 2_000));
  first.unref();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}

/// The system as people know it: Windows 11 reports 10.0 like Windows 10,
/// only its build (22000 and later) tells.
function systemName(): string {
  if (platform() !== "win32") return `${platform()} ${release()}`;
  const build = Number(release().split(".")[2]);
  return `Windows ${build >= 22000 ? 11 : 10} (build ${build})`;
}
