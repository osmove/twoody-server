import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, promises as fs } from "node:fs";
import { once } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

import {
  RUNTIME_TAG,
  isAllowedRuntimeUrl,
  keepRuntimeFile,
  runtimeTarget,
  runtimeTargetUrl,
  serverBinaryName,
  type RuntimeTarget,
} from "./runtimeManifest.js";

// Installs llama.cpp's server for this computer, when the person asks for
// it (`twoody-server runtime install`, or a first model install from an
// app) — never at `npm install`.
//
// The archive is the pinned release asset of runtimeManifest.ts, fetched
// from GitHub and nowhere else: every redirect is followed by hand and
// checked against the allowlist before a byte is asked for there. It is
// hashed as it is written, and refused unless the digest is the pinned
// one. Only what `llama-server` needs is kept (the Desktop's KEEP/DROP
// rule), with a VERSION stamp, into a staging folder that is renamed into
// place at the end: a runtime folder is either the whole thing or absent.
//
//   <runtimeRoot>/b11146-linux-arm64/{llama-server, lib*.so*, LICENSE.llama.cpp, VERSION}

/// Raised whenever what a runtime folder holds changes, so that a folder
/// made by an older rule is fetched again.
export const RUNTIME_LAYOUT = 1;
export const RUNTIME_STAMP = `${RUNTIME_TAG} layout ${RUNTIME_LAYOUT}`;

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 60_000;
/// Far above any release archive (arm64: 13 MB), far below a disk.
const MAX_ARCHIVE_BYTES = 512 * 1024 ** 2;
const STALE_STAGING_MS = 60 * 60 * 1000;

export type RuntimeFetchErrorCode =
  | "unsupported_platform"
  | "forbidden_url"
  | "http_error"
  | "checksum_mismatch"
  | "too_large"
  | "extract_failed"
  | "no_server"
  | "cancelled";

export class RuntimeFetchError extends Error {
  constructor(
    public code: RuntimeFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeFetchError";
  }
}

export interface InstalledRuntime {
  dir: string;
  binary: string;
  version: string;
  platform: string;
  /// Shared libraries the dynamic loader cannot find (Linux, `ldd`).
  missingLibraries: string[];
}

export interface InstallRuntimeOptions {
  /// DATA_DIR/runtime.
  runtimeRoot: string;
  platform?: string;
  arch?: string;
  /// Tests: another archive and digest than the manifest's.
  target?: RuntimeTarget;
  /// Tests: where to fetch it from instead of the GitHub release.
  url?: string;
  /// Tests: accept a plain-HTTP mirror on this computer.
  allowLoopback?: boolean;
  /// Tests, or a computer without the internet: the archive, already on
  /// disk, instead of a download. Still refused unless its SHA-256 is the
  /// pinned one.
  archive?: string;
  /// Fetch again even when an up-to-date folder is there.
  force?: boolean;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export function runtimeDirName(platform: string = process.platform, arch: string = process.arch): string {
  return `${RUNTIME_TAG}-${platform}-${arch}`;
}

export function runtimeDir(runtimeRoot: string, platform: string = process.platform, arch: string = process.arch): string {
  return join(runtimeRoot, runtimeDirName(platform, arch));
}

/// The runtime installed for this computer, if a whole, current one is there.
export async function installedRuntime(
  runtimeRoot: string,
  platform: string = process.platform,
  arch: string = process.arch,
): Promise<InstalledRuntime | null> {
  const dir = runtimeDir(runtimeRoot, platform, arch);
  const binary = join(dir, serverBinaryName(platform));
  try {
    const version = (await fs.readFile(join(dir, "VERSION"), "utf8")).trim();
    if (version !== RUNTIME_STAMP || !existsSync(binary)) return null;
    return { dir, binary, version, platform: `${platform}-${arch}`, missingLibraries: await missingLibraries(binary, platform) };
  } catch {
    return null;
  }
}

/// What `ldd` says is missing for this binary; empty where there is no ldd.
export function missingLibraries(binary: string, platform: string = process.platform): Promise<string[]> {
  if (platform !== "linux" || process.platform !== "linux") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile("ldd", [binary], { timeout: 10_000, maxBuffer: 256 * 1024 }, (_error, stdout) => {
      const missing = String(stdout ?? "")
        .split("\n")
        .filter((line) => /=>\s*not found/.test(line))
        .map((line) => line.trim().split(/\s+/)[0]);
      resolve(missing);
    });
  });
}

const inflight = new Map<string, Promise<InstalledRuntime & { fetched: boolean }>>();

/// Installs (or finds) the runtime. Concurrent calls for the same folder share one install.
export function installRuntime(options: InstallRuntimeOptions): Promise<InstalledRuntime & { fetched: boolean }> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const key = runtimeDir(options.runtimeRoot, platform, arch);
  const running = inflight.get(key);
  if (running) return running;
  const job = install({ ...options, platform, arch }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function install(options: InstallRuntimeOptions & { platform: string; arch: string }): Promise<InstalledRuntime & { fetched: boolean }> {
  const { runtimeRoot, platform, arch, log = () => undefined } = options;
  const signal = options.signal ?? new AbortController().signal;
  if (!options.force) {
    const existing = await installedRuntime(runtimeRoot, platform, arch);
    if (existing) return { ...existing, fetched: false };
  }
  const target = options.target ?? runtimeTarget(platform, arch);
  if (!target) throw new RuntimeFetchError("unsupported_platform", `no llama.cpp release for ${platform}-${arch}`);
  const url = options.url ?? runtimeTargetUrl(target);

  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await removeStaleStaging(runtimeRoot);
  const staging = join(runtimeRoot, `.staging-${randomBytes(6).toString("hex")}`);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    const archive = join(staging, target.asset);
    if (options.archive) {
      log(`[runtime] installing ${target.asset} from a file on this computer`);
      await copyChecked(options.archive, archive, target);
    } else {
      await downloadChecked(url, archive, target, { signal, log, allowLoopback: options.allowLoopback ?? false });
    }

    const extracted = join(staging, "extract");
    await fs.mkdir(extracted);
    await extract(archive, extracted, platform);
    const binaryName = serverBinaryName(platform);
    const source = [extracted, join(extracted, `llama-${RUNTIME_TAG}`)].find((dir) => existsSync(join(dir, binaryName)));
    if (!source) throw new RuntimeFetchError("no_server", `${target.asset}: no ${binaryName} inside`);

    const out = join(staging, "out");
    await fs.mkdir(out, { mode: 0o755 });
    let kept = 0;
    for (const name of await fs.readdir(source)) {
      if (!keepRuntimeFile(name)) continue;
      const from = join(source, name);
      const stat = await fs.lstat(from);
      if (stat.isSymbolicLink()) {
        // libllama.so.0 -> libllama.so.0.5.0: a name in the same folder, nothing else.
        const link = await fs.readlink(from);
        if (link.includes("/") || link.includes("\\") || link === "..") throw new RuntimeFetchError("extract_failed", `${name} points outside the runtime`);
        await fs.symlink(link, join(out, name));
      } else if (stat.isFile()) {
        await fs.copyFile(from, join(out, name));
        await fs.chmod(join(out, name), name === binaryName ? 0o755 : 0o644);
      } else {
        continue;
      }
      kept += 1;
    }
    const licence = ["LICENSE", "LICENSE.txt"].find((name) => existsSync(join(source, name)));
    if (licence) await fs.copyFile(join(source, licence), join(out, "LICENSE.llama.cpp"));
    for (const name of (await fs.readdir(source)).filter((entry) => /^LICENSE-/.test(entry))) {
      await fs.copyFile(join(source, name), join(out, name));
    }
    await fs.writeFile(join(out, "VERSION"), `${RUNTIME_STAMP}\n`, { mode: 0o644 });

    // Into place: the old folder is moved aside first, then removed.
    const final = runtimeDir(runtimeRoot, platform, arch);
    if (existsSync(final)) await fs.rename(final, join(staging, "previous"));
    await fs.rename(out, final);
    log(`[runtime] llama.cpp ${RUNTIME_TAG} installed for ${platform}-${arch} (${kept} files)`);
    const binary = join(final, binaryName);
    const missing = await missingLibraries(binary, platform);
    if (missing.length) log(`[runtime] missing libraries: ${missing.join(", ")}`);
    return { dir: final, binary, version: RUNTIME_STAMP, platform: `${platform}-${arch}`, missingLibraries: missing, fetched: true };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function removeStaleStaging(runtimeRoot: string): Promise<void> {
  for (const name of await fs.readdir(runtimeRoot).catch(() => [] as string[])) {
    if (!name.startsWith(".staging-")) continue;
    const path = join(runtimeRoot, name);
    const stat = await fs.stat(path).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > STALE_STAGING_MS) await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

function extract(archive: string, into: string, platform: string): Promise<void> {
  const tar = existsSync("/usr/bin/tar") ? "/usr/bin/tar" : "tar";
  const args = archive.endsWith(".zip") ? ["-xf", archive, "-C", into] : ["-xzf", archive, "-C", into];
  if (archive.endsWith(".zip") && platform !== "win32" && process.platform !== "darwin") {
    // GNU tar reads no zip; only Windows assets are zips.
    return Promise.reject(new RuntimeFetchError("extract_failed", "zip archives are only extracted on Windows or macOS"));
  }
  return new Promise((resolve, reject) => {
    execFile(tar, args, { timeout: 120_000, windowsHide: true }, (error) => {
      if (error) reject(new RuntimeFetchError("extract_failed", `could not extract ${archive.split(/[\\/]/).pop()}`));
      else resolve();
    });
  });
}

/// A local archive, copied into the staging folder and hashed on the way.
async function copyChecked(source: string, path: string, target: RuntimeTarget): Promise<void> {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isFile()) throw new RuntimeFetchError("http_error", `${source}: no such file`);
  if (stat.size > MAX_ARCHIVE_BYTES) throw new RuntimeFetchError("too_large", `${target.asset} is larger than any runtime archive`);
  const hash = createHash("sha256");
  const out = createWriteStream(path, { flags: "w", mode: 0o600 });
  try {
    for await (const chunk of createReadStream(source) as AsyncIterable<Buffer>) {
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, "drain");
    }
  } finally {
    out.end();
    await once(out, "close").catch(() => undefined);
  }
  const digest = hash.digest("hex");
  if (digest !== target.sha256) {
    await fs.rm(path, { force: true });
    throw new RuntimeFetchError("checksum_mismatch", `${target.asset}: SHA-256 is ${digest}, expected ${target.sha256}`);
  }
}

function get(url: string, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(target, { signal, headers: { "User-Agent": "twoody-server" } }, resolve);
    request.setTimeout(IDLE_TIMEOUT_MS, () => request.destroy(new RuntimeFetchError("http_error", `nothing received for ${IDLE_TIMEOUT_MS / 1000} s`)));
    request.on("error", reject);
    request.end();
  });
}

async function downloadChecked(
  url: string,
  path: string,
  target: RuntimeTarget,
  { signal, log, allowLoopback }: { signal: AbortSignal; log: (line: string) => void; allowLoopback: boolean },
): Promise<void> {
  let current = url;
  let response: IncomingMessage | null = null;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isAllowedRuntimeUrl(current, allowLoopback)) {
        let host = current;
        try {
          host = new URL(current).host;
        } catch {
          // keep the raw value
        }
        throw new RuntimeFetchError("forbidden_url", `refusing to download the runtime from ${host}`);
      }
      log(`[runtime] fetching ${target.asset} from ${new URL(current).host}`);
      const answer = await get(current, signal);
      const status = answer.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        const location = answer.headers.location;
        answer.resume();
        if (!location) throw new RuntimeFetchError("http_error", `redirect without a location (${status})`);
        current = new URL(location, current).toString();
        continue;
      }
      if (status < 200 || status >= 300) {
        answer.resume();
        throw new RuntimeFetchError("http_error", `HTTP ${status} for ${target.asset}`);
      }
      response = answer;
      break;
    }
    if (!response) throw new RuntimeFetchError("http_error", "too many redirects");

    const hash = createHash("sha256");
    const out = createWriteStream(path, { flags: "w", mode: 0o600 });
    let received = 0;
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        received += chunk.byteLength;
        if (received > MAX_ARCHIVE_BYTES) throw new RuntimeFetchError("too_large", `${target.asset} is larger than any runtime archive`);
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, "drain");
      }
    } finally {
      out.end();
      await once(out, "close").catch(() => undefined);
    }
    const digest = hash.digest("hex");
    if (digest !== target.sha256) {
      await fs.rm(path, { force: true });
      throw new RuntimeFetchError("checksum_mismatch", `${target.asset}: SHA-256 is ${digest}, expected ${target.sha256}`);
    }
  } catch (err) {
    if (signal.aborted) throw new RuntimeFetchError("cancelled", "cancelled");
    throw err;
  }
}
