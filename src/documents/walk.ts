import type { Dirent } from "node:fs";
import { lstat, opendir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isSupported } from "./extract.js";
import { skipDirectory } from "./folderNames.js";
import { foldPath } from "./samePath.js";
import { folderIdentityAsync, walledIdentity } from "./wallIdentity.js";

// How a granted folder is walked, and what is never read inside it.
//
// A folder the person picked, their Downloads or their whole home folder
// all go through the same walk. What it leaves out matters most for the
// home folder: application data, keys and credentials, developer trees,
// caches, photo and music libraries and applications are not documents,
// weigh a great deal, or both. The same list is shown to the person
// before they grant their home folder (GET /local_documents/personal).

// The folder names never entered live in folderNames.ts (shared with the Desktop).
export { SKIPPED_BUNDLES, SKIPPED_DIRECTORIES, skipDirectory } from "./folderNames.js";

const CREDENTIAL_NAME = /^(?:credentials|secrets?|tokens?|passwords?|service[-_]?account)(?:[.-]|$)/i;

/// A file the walk does not read, supported or not: hidden files, Office
/// lock files (~$…) and files named like credentials.
export function skipFile(name: string): boolean {
  return name.startsWith(".") || name.startsWith("~$") || CREDENTIAL_NAME.test(name);
}

/// What a folder's entry is to the walk: a file, a folder, or nothing to
/// follow. A real symbolic link is never followed (it must not widen the
/// grant). But Windows reports every file and folder of OneDrive — which
/// holds the Bureau and Documents of most Windows 11 computers — as a
/// reparse point, which Node lists as a link: lstat tells them apart, as
/// it says « link » only for a real symbolic link or junction (Jimmy,
/// 02/10/2026: a folder on Steeve's desktop stayed at zero documents).
export async function entryKind(entry: Dirent, path: string, platform: NodeJS.Platform = process.platform): Promise<"file" | "dir" | null> {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink() || platform !== "win32") return null;
  try {
    const info = await lstat(path);
    return info.isSymbolicLink() ? null : info.isDirectory() ? "dir" : info.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

export const MAX_FILES_PER_FOLDER = 20_000;
/// How many files a walk lists at most before choosing which to keep: a
/// home folder holds more documents than are indexed, and the choice needs
/// to see them (Jimmy, 02/10/2026: a file added to a full folder was never
/// counted — the walk always stopped on the same 20 000).
export const MAX_FILES_LISTED = 200_000;
/// Folders the system refused, kept for the screen to explain: a few are
/// enough to name, the rest is noise.
const MAX_DENIED = 10;

export interface Walk {
  files: string[];
  limited: boolean;
  /// Folders that could not be read for lack of permission (macOS asks
  /// before an app reads Desktop, Documents, Downloads or iCloud Drive).
  denied: string[];
  /// Files left out because Twoody cannot read text in them (a video, a
  /// picture, music): counted for the screen to say so (Jimmy, 02/10/2026:
  /// a .mp4 dropped in a folder left it at « 0 documents », unexplained).
  ignored: number;
}

export interface WalkOptions {
  /// Folders not entered: granted on their own, they are walked for
  /// themselves and must not spend this folder's share; a walled-off
  /// project's folder is never read from another (library.ts folderLayout
  /// gives each every way the walk may meet it).
  skip?: string[];
  /// Files indexed already: a full folder keeps them.
  keep?: Set<string>;
  /// When the folder was last read (ms): a file changed since is always
  /// taken, past the limit. Null before the first pass.
  since?: number | null;
  /// Another project's walled-off folders by identity (wallPlaces.ts
  /// wallKeys): a folder that is one is not entered, whatever it is called
  /// and wherever it is, and `met` says where it was.
  walls?: { keys: ReadonlySet<string>; met: (path: string, identity: string) => void };
  /// The documents of other projects' walled-off folders away from their path
  /// (wallPlaces.ts awayPrints): a file of one of their names is looked at,
  /// and not taken when `match` says it is one of them.
  prints?: { names: ReadonlySet<string>; match: (path: string, size: number, mtimeMs: number) => boolean };
}

export function permissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

/// The supported files of a folder. Past `maxFiles`, the files indexed
/// already are kept, those added or changed since the last pass are
/// added, and what room is left goes to the most recent ones.
export async function walk(root: string, maxFiles = MAX_FILES_PER_FOLDER, options: WalkOptions = {}): Promise<Walk> {
  const files: string[] = [];
  const denied: string[] = [];
  // Compared as this disk does (samePath.ts): a folder granted on its own
  // may be written with another case, or another way, than the walk meets it.
  const skip = new Set((options.skip ?? []).map((path) => foldPath(path)));
  const pending = [root];
  let listedAll = true;
  let ignored = 0;
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (permissionDenied(error) && denied.length < MAX_DENIED) denied.push(dir);
      continue; // unreadable directory: skip it, keep going
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      // Symlinks are not followed: a link must not widen the grant.
      const kind = await entryKind(entry, path);
      if (kind === "dir") {
        if (skipDirectory(entry.name) || skip.has(foldPath(path))) continue;
        // A walled-off folder renamed or moved here: still walled off.
        if (options.walls?.keys.size) {
          const identity = await folderIdentityAsync(path);
          if (walledIdentity(options.walls.keys, identity)) {
            options.walls.met(path, identity!);
            continue;
          }
        }
        pending.push(path);
      } else if (kind === "file" && !skipFile(entry.name)) {
        if (!isSupported(path)) {
          ignored += 1;
          continue;
        }
        // One of a walled-off folder's documents away from its folder.
        if (options.prints?.names.has(entry.name.normalize("NFC"))) {
          const info = await stat(path).catch(() => null);
          if (info && options.prints.match(path, info.size, info.mtimeMs)) continue;
        }
        files.push(path);
      }
    }
    if (files.length >= MAX_FILES_LISTED) {
      listedAll = false;
      break;
    }
  }
  if (files.length <= maxFiles) return { files, limited: !listedAll, denied, ignored };
  return { files: await choose(files, maxFiles, options), limited: true, denied, ignored };
}

async function choose(files: string[], maxFiles: number, options: WalkOptions): Promise<string[]> {
  const keep = options.keep ?? new Set<string>();
  const kept = files.filter((path) => keep.has(path));
  const others = files.filter((path) => !keep.has(path));
  const dated: Array<{ path: string; mtime: number }> = [];
  for (let start = 0; start < others.length; start += 64) {
    const batch = others.slice(start, start + 64);
    const times = await Promise.all(batch.map((path) => stat(path).then((info) => info.mtimeMs, () => null)));
    batch.forEach((path, index) => {
      if (times[index] !== null) dated.push({ path, mtime: times[index]! });
    });
  }
  dated.sort((a, b) => b.mtime - a.mtime);
  const since = options.since ?? null;
  const fresh = since === null ? [] : dated.filter((file) => file.mtime > since);
  const room = Math.max(0, maxFiles - kept.length - fresh.length);
  const rest = (since === null ? dated : dated.filter((file) => file.mtime <= since)).slice(0, room);
  return [...kept.slice(0, maxFiles), ...fresh.map((file) => file.path), ...rest.map((file) => file.path)];
}

/// Reads the first entry of a folder, which is what makes macOS ask the
/// person whether Twoody may read Desktop, Documents, Downloads or iCloud
/// Drive. False when the system refuses; other failures are left to the
/// checks that follow (a missing folder, a file).
export async function folderReadable(path: string): Promise<boolean> {
  try {
    const dir = await opendir(path);
    try {
      await dir.read();
    } finally {
      await dir.close().catch(() => undefined);
    }
    return true;
  } catch (error) {
    return !permissionDenied(error);
  }
}
