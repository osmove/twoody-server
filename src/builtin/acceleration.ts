// Which llama-server of a runtime folder to start, and with which flags:
// Metal on a Mac, Vulkan beside the CPU build on Windows, CPU elsewhere.
// Ported from twoody-desktop/src/main/runtimeAcceleration.ts.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { RuntimeFailure } from "./failure.js";

export type Acceleration = "metal" | "vulkan" | "cpu";
export type RuntimeEngine = { binary: string; backend: Acceleration; devices: number };

// The first run of a llama.cpp release prepares its GPU code, and that is
// slow: on a Mac, Metal compiles the shader library before llama-server
// does anything — `--list-devices` included, and the CPU build too, which
// is the same program. Measured on an M5 with an empty shader cache
// (10/10/2026): 16 to 26 s idle, 37 to 40 s with the processors busy; a
// modest or busy computer takes longer, and Vulkan's first compile on
// Windows can too. A check stopped halfway leaves the system's cache
// empty, so the next launch pays it all again: with 15 s for the GPU check
// and 20 s for the start, such a Mac ran on its CPU at every launch, or
// not at all. Both waits are generous now, and still bounded: past them,
// something else is wrong.

/// How long `llama-server --list-devices` may take.
export const PROBE_TIMEOUT_MS = 180_000;
/// How long a starting runtime may take to answer its /health.
export const START_TIMEOUT_MS = 180_000;

/// After a start on the GPU that did not answer, whether the CPU is worth
/// a try. When the GPU's process exited, yes. When it was still silent at
/// the end of the wait, only where the CPU build is another program
/// (Windows: Vulkan's llama-server in its own folder): on a Mac it is the
/// same program, which prepares the same Metal code first — starting it
/// again would only start the wait over.
export function retryOnCpu(engine: RuntimeEngine, failure: RuntimeFailure, cpuOnly: boolean): boolean {
  if (cpuOnly || engine.backend === "cpu") return false;
  return failure.reason !== "no-answer" || engine.backend === "vulkan";
}

// Only actual offload devices count; BLAS/Accelerate and CPU are not GPUs.
// Never expose driver-provided free text in a copied diagnostic.
export function countGpuDevices(output: string, backend: "metal" | "vulkan"): number {
  const pattern = backend === "metal" ? /^\s*MTL\d+:\s+.+\(\d+ MiB,/gm : /^\s*Vulkan\d+:\s+.+\(\d+ MiB,/gm;
  return [...output.matchAll(pattern)].length;
}

/// The memory of the largest graphics card with memory of its own, from
/// what `llama-server --list-devices` says on Windows: Vulkan names each
/// device (`ggml_vulkan: 0 = <name> (<driver>) | uma: 0 | …`) and its size
/// (`Vulkan0: <name> (12288 MiB, 11000 MiB free)`). An integrated GPU
/// (`uma: 1`) shares the system's memory, which is counted already; a
/// device whose kind is not said is not counted. Null when there is none.
export function dedicatedGpuMemory(output: string): number | null {
  const shared = new Map<number, boolean>();
  for (const match of output.matchAll(/ggml_vulkan:\s*(\d+)\s*=[^\n]*?\|\s*uma:\s*([01])\b/g)) shared.set(Number(match[1]), match[2] === "1");
  let largest = 0;
  for (const match of output.matchAll(/^\s*Vulkan(\d+):\s+.+\((\d+) MiB,/gm)) {
    if (shared.get(Number(match[1])) !== false) continue;
    largest = Math.max(largest, Number(match[2]) * 1024 ** 2);
  }
  return largest > 0 ? largest : null;
}

export function accelerationArgs(backend: Acceleration): string[] {
  // Leave layer count unset on GPU: llama.cpp fits layers to available memory
  // and keeps a 1 GiB margin. Forcing all layers can fail on smaller GPUs.
  return backend === "cpu"
    ? ["--device", "none", "--gpu-layers", "0", "--no-op-offload"]
    : ["--fit", "on", "--flash-attn", "auto"];
}

export async function selectRuntimeEngine(
  directory: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  forceCpu = false,
  probe: (binary: string) => Promise<string> = (binary) => new Promise((resolve) => {
    execFile(binary, ["--list-devices"], { cwd: dirname(binary), env, windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      resolve(error ? "" : `${stdout}\n${stderr}`);
    });
  }),
): Promise<RuntimeEngine> {
  const binary = join(directory, platform === "win32" ? "llama-server.exe" : "llama-server");
  const cpu: RuntimeEngine = { binary, backend: "cpu", devices: 0 };
  if (forceCpu || !["win32", "darwin"].includes(platform)) return cpu;
  const backend = platform === "darwin" ? "metal" : "vulkan";
  const accelerated = backend === "vulkan" ? join(directory, "vulkan", "llama-server.exe") : binary;
  if (!existsSync(accelerated)) return cpu;
  const devices = countGpuDevices(await probe(accelerated).catch(() => ""), backend);
  return devices ? { binary: accelerated, backend, devices } : cpu;
}
