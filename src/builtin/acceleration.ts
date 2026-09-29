// Which llama-server of a runtime folder to start, and with which flags:
// Metal on a Mac, Vulkan beside the CPU build on Windows, CPU elsewhere.
// Ported from twoody-desktop/src/main/runtimeAcceleration.ts.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type Acceleration = "metal" | "vulkan" | "cpu";
export type RuntimeEngine = { binary: string; backend: Acceleration; devices: number };

// Only actual offload devices count; BLAS/Accelerate and CPU are not GPUs.
// Never expose driver-provided free text in a copied diagnostic.
export function countGpuDevices(output: string, backend: "metal" | "vulkan"): number {
  const pattern = backend === "metal" ? /^\s*MTL\d+:\s+.+\(\d+ MiB,/gm : /^\s*Vulkan\d+:\s+.+\(\d+ MiB,/gm;
  return [...output.matchAll(pattern)].length;
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
    execFile(binary, ["--list-devices"], { cwd: dirname(binary), env, windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
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
