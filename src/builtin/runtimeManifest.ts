// The llama.cpp release Twoody runs, in one place.
//
// The same pinned release as Twoody Desktop (twoody-desktop/scripts/
// fetch-runtime.mjs, which is to import this file): the nightly the
// llama.cpp project attached to its 0.5.0 release, each archive checked
// against the SHA-256 GitHub reports for it. A build, an install on a Pi
// or an image must never pick up whatever was published this morning: to
// move to a newer runtime, change the tag and every digest together.
//
// One exception, Linux on ARM (a Raspberry Pi): the official build (GCC,
// OpenMP) reads prompts at 0.73× Ollama's speed on a Pi 5. The archive
// there is Osmove's own build of the same commit (Clang 21.1.8, every ARM
// CPU variant, no OpenMP: scripts/build-llama-arm64.sh, built by
// .github/workflows/llama-runtime-arm64.yml), hosted on
// downloads.twoody.com and pinned here by its digest like the others.
//
// No import here, on purpose: this file is read by a plain Node script too.

export const RUNTIME_TAG = "b11146";

export interface RuntimeTarget {
  /// The release asset's file name.
  asset: string;
  sha256: string;
  /// Where it is fetched from, when not llama.cpp's GitHub release.
  url?: string;
}

/// Where Osmove hosts the runtimes it builds itself.
export const OSMOVE_RUNTIME_BASE = "https://downloads.twoody.com/runtime";

/// By `${platform}-${arch}` as Node names them.
export const RUNTIME_TARGETS: Readonly<Record<string, RuntimeTarget>> = Object.freeze({
  "darwin-arm64": { asset: `llama-${RUNTIME_TAG}-bin-macos-arm64.tar.gz`, sha256: "1ad3f9eff80edb9dbef4259ad564d1720612ef7eea48fa4afed0e54f5f3d5711" },
  "darwin-x64": { asset: `llama-${RUNTIME_TAG}-bin-macos-x64.tar.gz`, sha256: "305f0e3a17d2c01eb205cd0a62128357f1ec3b55329cb084d94e5ec0115d7a3b" },
  "win32-x64": { asset: `llama-${RUNTIME_TAG}-bin-win-cpu-x64.zip`, sha256: "14cf1303ca9ac3abd94816850532f9f9a69ac66fbaca3776fc6f9061c2fac1d1" },
  "win32-arm64": { asset: `llama-${RUNTIME_TAG}-bin-win-cpu-arm64.zip`, sha256: "1727d241f3bf6d27360e984e851cf013928fd655bf89f8628e70da027f377b7d" },
  "linux-x64": { asset: `llama-${RUNTIME_TAG}-bin-ubuntu-x64.tar.gz`, sha256: "c150306eb16b5ab696f76a8bdf810c35fd98a24e82158742e6fa28f420ff8410" },
  // Osmove's build (see above): CI run 36638805557 of llama-runtime-arm64.yml, variant « all ».
  "linux-arm64": {
    asset: `llama-${RUNTIME_TAG}-bin-ubuntu-arm64-clang-all.tar.gz`,
    sha256: "6a0d482b641bcafcc4495325959335dc29c0afcfa085fe915c7bdb0760976154",
    url: `${OSMOVE_RUNTIME_BASE}/llama-${RUNTIME_TAG}-bin-ubuntu-arm64-clang-all.tar.gz`,
  },
});

/// The official llama.cpp archive for Linux on ARM, which the Desktop still
/// pins (its Linux arm64 build), and the server no longer uses.
export const RUNTIME_OFFICIAL_LINUX_ARM64: Readonly<RuntimeTarget> = Object.freeze({
  asset: `llama-${RUNTIME_TAG}-bin-ubuntu-arm64.tar.gz`,
  sha256: "4aeda6fe68831547e49b7fa87607383ca5352b3d72ca5f70d52ed265f58c131f",
});

/// Windows x64 carries a separate Vulkan runtime beside the CPU one (Desktop only).
export const RUNTIME_VULKAN: Readonly<RuntimeTarget> = Object.freeze({
  asset: `llama-${RUNTIME_TAG}-bin-win-vulkan-x64.zip`,
  sha256: "55a378aa095b466979d85075234f66d7655c7a7483222af0c006c0e55b4d7bd6",
});

/// What `llama-server` needs, by file name: itself, the ggml/llama/mtmd
/// shared libraries (including the per-CPU-generation ggml-cpu variants,
/// opened at run time and missed by a link-time closure), OpenMP on
/// Windows. macOS puts the version before the extension, Linux after it;
/// both forms are kept because the binary asks for the versioned name.
export const RUNTIME_KEEP = /^(lib)?(ggml.*|llama|llama-common|llama-server-impl|mtmd|omp)(\.[\d.]+)?\.(dll|so|dylib)(\.[\d.]+)?$/i;
/// The `-impl` libraries of the archive's other tools.
export const RUNTIME_DROP = /-(cli|bench|batched-bench|perplexity|quantize|completion|fit-params|mtmd-debug)-impl\./i;

/// Where a release asset may come from, redirects included: GitHub's
/// release hosts, and Osmove's downloads host for the builds it makes.
export const RUNTIME_HOSTS: readonly string[] = Object.freeze([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "downloads.twoody.com",
]);

export function runtimeTargetKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function runtimeTarget(platform: string = process.platform, arch: string = process.arch): RuntimeTarget | null {
  return RUNTIME_TARGETS[runtimeTargetKey(platform, arch)] ?? null;
}

export function runtimeAssetUrl(asset: string, tag: string = RUNTIME_TAG): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${asset}`;
}

/// Where a target's archive is fetched from: its own URL, else the GitHub release.
export function runtimeTargetUrl(target: RuntimeTarget): string {
  return target.url ?? runtimeAssetUrl(target.asset);
}

/// The name of the binary in a runtime folder.
export function serverBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? "llama-server.exe" : "llama-server";
}

/// Whether a file of the archive is kept in the installed runtime.
export function keepRuntimeFile(name: string): boolean {
  if (name === "llama-server" || name === "llama-server.exe") return true;
  return RUNTIME_KEEP.test(name) && !RUNTIME_DROP.test(name);
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

/// HTTPS to one of RUNTIME_HOSTS (no user, no other port), or, when `allowLoopback` (a test
/// mirror), plain HTTP to this computer.
export function isAllowedRuntimeUrl(value: string, allowLoopback = false): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (allowLoopback && isLoopbackHttp(url)) return true;
  return url.protocol === "https:" && !url.port && !url.username && !url.password && RUNTIME_HOSTS.includes(url.hostname.toLowerCase());
}
