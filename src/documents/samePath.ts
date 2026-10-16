import { realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

// Whether a path is a folder, or lies inside it: the one comparison every
// wall of a walled-off project is checked with — on this server (library.ts
// listFolders and folderProjects, fileListing.ts walledAt, the shares, the
// file actions) and in Twoody Desktop's Agent and Twoody Code (walledFolders.ts,
// paths.ts: copied there by its scripts/sync-vault.mjs).
//
// One folder is written many ways. On Windows: in another case
// (« c:\users\… »), by its 8.3 short name (« TESSAN~1 »; the temporary folder
// is « C:\Users\RUNNER~1\… » on GitHub's runners, where the Desktop's CI found
// this on 16/10/2026), with « / » for « \ », with a trailing dot or space
// Windows drops (« Tessane. »), with an NTFS stream suffix that names the
// folder itself (« Tessane::$INDEX_ALLOCATION »), through a junction or a
// symbolic link, a mapped or subst drive or the share it stands for, this very
// computer's shares (« \\localhost\C$\… »), « \\?\ » before it all. On macOS:
// in another case or Unicode form, through a link, under /System/Volumes/Data.
// So two paths are compared three ways, and one match says « inside »:
//   - as written, folded (`foldPath`);
//   - as the system resolves them: the native real path of their deepest
//     existing part — links and junctions followed, 8.3 names in full, the
//     disk's own case, a mapped or subst drive's real place —, the rest
//     appended (`realPathOf`; Node's JavaScript realpathSync does none of the
//     last three), folded;
//   - by identity, device and file number, of the folder among the folders on
//     the other path's way (`identitiesOn`): no spelling changes it.
// A wrong « inside » only hides more; a wrong « outside » would open a wall:
// every doubt goes to « inside ».

const pathOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/// A Windows path as its root (« C:\ », « \\server\share\ ») and its names:
/// « \\?\C:\… », « \\.\C:\… » and « \\?\UNC\server\share\… » are « C:\… » and
/// « \\server\share\… ».
function windowsParts(path: string): { root: string; names: string[] } {
  let value = path.replace(/\//g, "\\");
  const device = /^\\\\[?.]\\(?:(UNC)\\)?/i.exec(value);
  if (device) value = (device[1] ? "\\\\" : "") + value.slice(device[0].length);
  value = win32.normalize(value);
  const { root } = win32.parse(value);
  return { root, names: value.slice(root.length).split("\\") };
}

/// A name as Windows opens it: without an NTFS stream suffix (« :… ») and
/// without the trailing dots and spaces it drops.
const windowsName = (name: string) => (name === "." || name === ".." ? name : name.replace(/:[\s\S]*$/, "").replace(/[. ]+$/, ""));

/// How a path compares on this disk: in one Unicode form (NFC); without case
/// on macOS and Windows (in upper case, as NTFS compares names; APFS also
/// takes « ß » and « SS » alike); on Windows with « \ » only and each name as
/// Windows opens it (`windowsName`); never a trailing separator but a root's.
export function foldPath(path: string, platform: NodeJS.Platform = process.platform): string {
  const value = path.normalize("NFC");
  if (platform === "win32") {
    const { root, names } = windowsParts(value);
    return (root + names.map(windowsName).filter((name) => name !== "" && name !== ".").join("\\")).toUpperCase();
  }
  const folded = (value.startsWith("/") ? "/" : "") + posix.normalize(value).split("/").filter((name) => name !== "").join("/");
  return platform === "darwin" ? folded.toUpperCase() : folded;
}

/// Whether the folded path `inner` is the folded path `outer` or lies in it.
export function foldedWithin(outer: string, inner: string, platform: NodeJS.Platform = process.platform): boolean {
  if (outer === inner) return true;
  const sep = platform === "win32" ? "\\" : "/";
  return outer !== "" && inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/// Whether `inner` is `outer` or lies inside it, as written (folded).
export function within(outer: string, inner: string, platform: NodeJS.Platform = process.platform): boolean {
  return foldedWithin(foldPath(outer, platform), foldPath(inner, platform), platform);
}

/// The native real path of `path`'s deepest existing part, the rest of
/// `path` after it: where `path` is, or will be once made. Any failure (a
/// part missing, unreadable, a loop) is taken as « not there »: the part is
/// kept as written, which the comparisons fold.
export function realPathOf(path: string): string {
  const asked = resolve(path);
  let head = asked;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(head);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return asked;
      tail.push(basename(head));
      head = parent;
    }
  }
}

/// `realPathOf`, without holding the event loop.
export async function realPathOfAsync(path: string): Promise<string> {
  const asked = resolve(path);
  let head = asked;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(head);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return asked;
      tail.push(basename(head));
      head = parent;
    }
  }
}

/// What a path is on this computer, links followed: its device and file
/// number; null when it does not exist, or its file system numbers nothing.
export function identityOf(path: string): string | null {
  try {
    const info = statSync(path, { bigint: true, throwIfNoEntry: false });
    if (!info || info.ino === 0n) return null;
    return `${info.dev}:${info.ino}`;
  } catch {
    return null;
  }
}

/// `identityOf`, without holding the event loop.
export async function identityOfAsync(path: string): Promise<string | null> {
  try {
    const info = await stat(path, { bigint: true });
    return info.ino === 0n ? null : `${info.dev}:${info.ino}`;
  } catch {
    return null;
  }
}

/// The identities of `path` and of each folder above it, those that exist —
/// up to the disk's root, or down to `stopAt` (left out).
export function identitiesOn(path: string, stopAt?: string, platform: NodeJS.Platform = process.platform): string[] {
  const stop = stopAt === undefined ? null : foldPath(stopAt, platform);
  const out: string[] = [];
  let current = resolve(path);
  for (;;) {
    if (stop !== null && foldPath(current, platform) === stop) return out;
    const id = identityOf(current);
    if (id) out.push(id);
    const parent = dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

/// `identitiesOn`, without holding the event loop.
export async function identitiesOnAsync(path: string, stopAt?: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const stop = stopAt === undefined ? null : foldPath(stopAt, platform);
  const out: string[] = [];
  let current = resolve(path);
  for (;;) {
    if (stop !== null && foldPath(current, platform) === stop) return out;
    const id = await identityOfAsync(current);
    if (id) out.push(id);
    const parent = dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

/// A path, every way it is compared.
export interface PathPlace {
  /// As given, resolved.
  path: string;
  /// As the system resolves it (`realPathOf`).
  real: string;
  /// Both folded.
  keys: string[];
  /// Its identity, when it exists.
  id: string | null;
}

export function pathPlace(path: string, real?: string, platform: NodeJS.Platform = process.platform): PathPlace {
  const given = resolve(path);
  const resolved = real ?? realPathOf(given);
  return { path: given, real: resolved, keys: [...new Set([foldPath(given, platform), foldPath(resolved, platform)])], id: identityOf(resolved) };
}

/// `pathPlace`, without holding the event loop.
export async function pathPlaceAsync(path: string, platform: NodeJS.Platform = process.platform): Promise<PathPlace> {
  const given = resolve(path);
  const resolved = await realPathOfAsync(given);
  return { path: given, real: resolved, keys: [...new Set([foldPath(given, platform), foldPath(resolved, platform)])], id: await identityOfAsync(resolved) };
}

/// Whether `inner` is `outer` or lies inside it: written either way, resolved
/// either way, or `outer` itself among the folders on `inner`'s way
/// (`innerIds`: `identitiesOn(inner.real)`, computed once for many tests).
export function holds(outer: PathPlace, inner: PathPlace, innerIds?: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  for (const a of outer.keys) for (const b of inner.keys) if (foldedWithin(a, b, platform)) return true;
  return !!outer.id && (innerIds ?? identitiesOn(inner.real, undefined, platform)).includes(outer.id);
}

/// `inner`'s path written from `outer.path`, what a walk started there meets,
/// when `inner` lies in `outer` (or is it): through their real paths, as
/// written, or through the folder on `inner`'s way that is `outer` itself.
/// Null when it does not lie there.
export function spelledFrom(outer: PathPlace, inner: PathPlace, platform: NodeJS.Platform = process.platform): string | null {
  const path = pathOf(platform);
  const from = (base: string, target: string) => {
    const rel = path.relative(base, target);
    return rel ? path.join(outer.path, rel) : outer.path;
  };
  if (foldedWithin(foldPath(outer.real, platform), foldPath(inner.real, platform), platform)) return from(outer.real, inner.real);
  if (foldedWithin(foldPath(outer.path, platform), foldPath(inner.path, platform), platform)) return from(outer.path, inner.path);
  if (!outer.id) return null;
  // Identities are this computer's: its own path functions walk up.
  let current = inner.real;
  for (;;) {
    if (identityOf(current) === outer.id) return from(current, inner.real);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/// Every spelling of `inner` worth comparing with what lies under `outers`:
/// as given, as resolved, and as written from each of `outers` that holds it.
export function spellingsOf(inner: PathPlace, outers: readonly PathPlace[] = [], platform: NodeJS.Platform = process.platform): string[] {
  const out = [inner.path, inner.real];
  for (const outer of outers) {
    const spelt = spelledFrom(outer, inner, platform);
    if (spelt) out.push(spelt);
  }
  return [...new Set(out)];
}
