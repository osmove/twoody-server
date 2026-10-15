import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import { isAllowedDownloadUrl } from "./catalog.js";

// Downloads one model of the catalogue into the models folder.
//
// This is the only connection Twoody's local space ever makes to the
// outside, and only when the person asks for it. It goes to Hugging Face
// and its content network and nowhere else: every redirect is followed by
// hand and checked. What arrives is hashed as it is written; a file whose
// SHA-256 is not the catalogue's never gets its final name, so the runtime
// never sees it.
//
// A download of several gigabytes gets interrupted: the partial file is
// kept, and the next attempt asks for the rest (Range). What is already on
// disk is hashed again first, so the final digest still covers every byte.
//
// A file is checked by its SHA-256 — every model file, every large file of
// an MLX folder (Git LFS) — or, for the small text files of an MLX folder
// (config.json, the tokenizer's), by git's own object id as Hugging Face
// lists it at the pinned revision: the SHA-1 of "blob <size>\0" and the
// content (catalogTypes.ts MlxFile).
//
// Ported from twoody-desktop/src/main/modelDownloads.ts. No Electron import: `test/builtinDownloads.test.ts` runs under Node
// against a local server.

/// What a download needs: a catalogue model, its vision file, or one file
/// of an MLX folder.
export interface DownloadTarget {
  id: string;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
  /// Instead of the SHA-256: git's object id (40 hex digits).
  gitSha1?: string;
}

export type DownloadState = "downloading" | "verifying" | "done";

export interface DownloadProgress {
  id: string;
  state: DownloadState;
  received: number;
  total: number;
  bytesPerSecond: number;
}

export class DownloadError extends Error {
  constructor(
    public code: "cancelled" | "not_enough_space" | "checksum_mismatch" | "forbidden_url" | "http_error" | "incomplete",
    message: string,
    /// For "not_enough_space": what the disk lacks, in bytes, for the screen.
    public space?: { needed: number; free: number },
  ) {
    super(message);
  }
}

// Room left on the disk once the model is there.
export const SPACE_MARGIN_BYTES = 2 * 1024 ** 3;
const MAX_REDIRECTS = 5;
const PROGRESS_EVERY_MS = 200;
/// A download that receives nothing for this long is stopped; tried again,
/// it resumes where it stopped.
const IDLE_TIMEOUT_MS = 60_000;

/// The digest that checks a file: SHA-256, or git's blob SHA-1 (its
/// header first, so that the digest of a resumed file covers it once).
function newHash(model: DownloadTarget) {
  if (!model.gitSha1) return createHash("sha256");
  return createHash("sha1").update(`blob ${model.bytes}\0`);
}

export function modelPath(dir: string, model: DownloadTarget): string {
  return join(dir, model.file);
}

export async function isInstalled(dir: string, model: DownloadTarget): Promise<boolean> {
  try {
    return (await fs.stat(modelPath(dir, model))).size === model.bytes;
  } catch {
    return false;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size;
  } catch {
    return 0;
  }
}

/// The free space of the disk that holds `dir` — or, before it exists, its
/// nearest folder that does; null when it cannot be told.
export async function freeDiskBytes(dir: string): Promise<number | null> {
  for (let at = dir; ; at = dirname(at)) {
    try {
      const stats = await fs.statfs(at);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      if (dirname(at) === at) return null;
    }
  }
}

/// What installing these files still needs on the disk: each one's size
/// less what is there already (installed, or a partial file that resumes),
/// and the margin once — a model and its vision file are one install, and
/// running out of room between the two would leave gigabytes for nothing.
export async function spaceToInstall(files: Array<{ dir: string; model: DownloadTarget }>): Promise<number> {
  let needed = 0;
  for (const { dir, model } of files) {
    if (await isInstalled(dir, model)) continue;
    const partial = await fileSize(`${modelPath(dir, model)}.part`);
    needed += model.bytes - (partial <= model.bytes ? partial : 0);
  }
  return needed > 0 ? needed + SPACE_MARGIN_BYTES : 0;
}

/// One GET with Node's own HTTP client. fetch (undici, in Electron 44)
/// throws an uncaught AssertionError — a dialog over the whole app — when
/// a server closes the connection while the reading is paused, as it is
/// whenever the disk writes slower than the network brings.
function get(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(target, { headers, signal }, resolve);
    request.setTimeout(IDLE_TIMEOUT_MS, () => request.destroy(new DownloadError("incomplete", `nothing received for ${IDLE_TIMEOUT_MS / 1000} s`)));
    request.on("error", reject);
    request.end();
  });
}

const succeeded = (response: IncomingMessage) => (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300;

async function openChecked(url: string, headers: Record<string, string>, signal: AbortSignal, allowLoopback: boolean): Promise<IncomingMessage> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isAllowedDownloadUrl(current, allowLoopback)) {
      throw new DownloadError("forbidden_url", `refusing to download from ${new URL(current).host}`);
    }
    const response = await get(current, headers, signal);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      response.resume();
      if (!location) throw new DownloadError("http_error", `redirect without a location (${status})`);
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new DownloadError("http_error", "too many redirects");
}

export async function downloadModel(
  model: DownloadTarget,
  dir: string,
  options: { signal: AbortSignal; onProgress?: (progress: DownloadProgress) => void; allowLoopback?: boolean },
): Promise<string> {
  const { signal, onProgress, allowLoopback = false } = options;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = modelPath(dir, model);
  const partial = `${target}.part`;
  if (await isInstalled(dir, model)) return target;

  let received = await fileSize(partial);
  if (received > model.bytes) {
    await fs.rm(partial, { force: true });
    received = 0;
  }

  const free = await freeDiskBytes(dir);
  const needed = model.bytes - received + SPACE_MARGIN_BYTES;
  if (free !== null && free < needed) {
    throw new DownloadError("not_enough_space", `${needed - free} bytes short`, { needed, free });
  }

  const report = (state: DownloadState, bytesPerSecond = 0) =>
    onProgress?.({ id: model.id, state, received, total: model.bytes, bytesPerSecond });

  const hash = newHash(model);
  try {
    if (received > 0 && received < model.bytes) {
      const response = await openChecked(model.url, { Range: `bytes=${received}-` }, signal, allowLoopback);
      if (response.statusCode === 206) {
        // Hash what is already there, then carry on where it stopped.
        for await (const chunk of createReadStream(partial)) {
          if (signal.aborted) throw new DownloadError("cancelled", "cancelled");
          hash.update(chunk as Buffer);
        }
        await pump(response, partial, "a");
      } else if (succeeded(response)) {
        // The server sent the whole file again: start over.
        received = 0;
        await pump(response, partial, "w");
      } else {
        response.resume();
        throw new DownloadError("http_error", `HTTP ${response.statusCode}`);
      }
    } else if (received < model.bytes) {
      const response = await openChecked(model.url, {}, signal, allowLoopback);
      if (!succeeded(response)) {
        response.resume();
        throw new DownloadError("http_error", `HTTP ${response.statusCode}`);
      }
      await pump(response, partial, "w");
    } else {
      // Everything was there already, the check below decides.
      for await (const chunk of createReadStream(partial)) hash.update(chunk as Buffer);
    }
  } catch (err) {
    if (signal.aborted) throw new DownloadError("cancelled", "cancelled");
    throw err;
  }

  report("verifying");
  if (received !== model.bytes) {
    throw new DownloadError("incomplete", `${received} bytes of ${model.bytes}`);
  }
  if (hash.digest("hex") !== (model.gitSha1 ?? model.sha256)) {
    // Not the file the catalogue describes: nothing of it is worth keeping.
    await fs.rm(partial, { force: true });
    throw new DownloadError("checksum_mismatch", `${model.file} does not match its ${model.gitSha1 ? "git object id" : "SHA-256"}`);
  }
  await fs.chmod(partial, 0o600).catch(() => undefined);
  await fs.rename(partial, target);
  report("done");
  return target;

  async function pump(response: IncomingMessage, path: string, flags: "a" | "w") {
    const out = createWriteStream(path, { flags, mode: 0o600 });
    let windowStart = Date.now();
    let windowBytes = 0;
    let speed = 0;
    let lastReport = 0;
    try {
      report("downloading");
      for await (const chunk of response as AsyncIterable<Buffer>) {
        if (received + chunk.byteLength > model.bytes) {
          throw new DownloadError("checksum_mismatch", `${model.file} is larger than announced`);
        }
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, "drain");
        received += chunk.byteLength;
        windowBytes += chunk.byteLength;
        const now = Date.now();
        if (now - windowStart >= 1000) {
          speed = Math.round((windowBytes * 1000) / (now - windowStart));
          windowStart = now;
          windowBytes = 0;
        }
        if (now - lastReport >= PROGRESS_EVERY_MS) {
          lastReport = now;
          report("downloading", speed);
        }
      }
    } finally {
      out.end();
      await once(out, "close").catch(() => undefined);
    }
  }
}

export async function removeModel(dir: string, model: DownloadTarget): Promise<void> {
  await fs.rm(modelPath(dir, model), { force: true });
  await fs.rm(`${modelPath(dir, model)}.part`, { force: true });
}
