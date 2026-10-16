import { statSync, type BigIntStats } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { foldPath } from "./samePath.js";

// What a walled-off project's folder is beyond its path — its identity, its
// disk, its documents' name, size and date — for the walls to follow it when
// it is renamed or moved outside Twoody (wallPlaces.ts,
// docs/projects-design.md §8 « Moved outside Twoody »). No database here:
// the walkers (fileListing.ts, walk.ts) use these as they are.
//
// A folder's identity is its device and file number, « dev:ino » — the same
// as samePath.ts identityOf, for folders only: a walled-off project's folder
// is a folder, and a file's number never stands for one. Away from its path,
// a walled-off folder is also met by its file number alone, on any device: a
// network drive mounted again gets another device number (« *:ino »). A wrong
// match only hides a folder more; the identity is never what follows one
// (library.ts asks for its documents too).

/// A file's date as another disk may keep it: FAT, to two seconds.
export const DATE_SLACK_MS = 2_000;

/// One document of a walled-off folder away from its path (wallPlaces.ts
/// awayPrints): its size and date, the folder (its document_folders.id) and
/// where it was in it.
export interface WallPrint {
  size: number;
  mtime: number;
  wall: string;
  rel: string;
}

export interface WallPrints {
  /// The documents' names (NFC).
  names: ReadonlySet<string>;
  byName: ReadonlyMap<string, readonly WallPrint[]>;
  /// How many documents each walled-off folder has.
  counts: ReadonlyMap<string, number>;
}

/// The walled-off document a file is, by its name, size and date; null when
/// it is none.
export function printMatch(prints: WallPrints, name: string, size: number, mtimeMs: number): WallPrint | null {
  for (const print of prints.byName.get(name.normalize("NFC")) ?? []) {
    if (print.size === size && Math.abs(print.mtime - Math.floor(mtimeMs)) <= DATE_SLACK_MS) return print;
  }
  return null;
}

const key = (info: BigIntStats) => (info.ino === 0n ? null : `${info.dev}:${info.ino}`);

/// The identity of the folder at `path` (links followed), null when there is
/// none: not there, not a folder, or a file system that numbers nothing.
export function folderIdentity(path: string): string | null {
  try {
    const info = statSync(path, { bigint: true, throwIfNoEntry: false });
    return info?.isDirectory() ? key(info) : null;
  } catch {
    return null;
  }
}

/// `folderIdentity`, without holding the event loop.
export async function folderIdentityAsync(path: string): Promise<string | null> {
  try {
    const info = await stat(path, { bigint: true });
    return info.isDirectory() ? key(info) : null;
  } catch {
    return null;
  }
}

/// The file number of an identity, on any device.
export function anyDevice(identity: string): string {
  return `*:${identity.slice(identity.indexOf(":") + 1)}`;
}

/// Whether `identity` is one of `keys` (identities, and file numbers on any
/// device: `anyDevice`).
export function walledIdentity(keys: ReadonlySet<string>, identity: string | null): boolean {
  return !!identity && keys.size > 0 && (keys.has(identity) || keys.has(anyDevice(identity)));
}

/// The folder at the root of the disk that holds `path` — the deepest folder
/// above it on another device (« /Volumes/NAS », « /Users » on a Mac's data
/// volume, « Z:\ »), or the disk's own root. Null when `path` is not there.
export function volumeOf(path: string): string | null {
  let current = resolve(path);
  let device: bigint;
  try {
    device = statSync(current, { bigint: true }).dev;
  } catch {
    return null;
  }
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return current;
    try {
      if (statSync(parent, { bigint: true }).dev !== device) return current;
    } catch {
      return current;
    }
    current = parent;
  }
}

/// Whether the disk whose root is `volume` is there: the folder exists and is
/// still a disk of its own (an empty mount point left behind is not), or is a
/// disk's root.
export function volumeConnected(volume: string): boolean {
  let device: bigint;
  try {
    device = statSync(volume, { bigint: true }).dev;
  } catch {
    return false;
  }
  const parent = dirname(volume);
  if (parent === volume) return true;
  try {
    return statSync(parent, { bigint: true }).dev !== device;
  } catch {
    return true;
  }
}

/// `volumeConnected`, without holding the event loop (a network drive out of
/// reach).
export async function volumeConnectedAsync(volume: string): Promise<boolean> {
  let device: bigint;
  try {
    device = (await stat(volume, { bigint: true })).dev;
  } catch {
    return false;
  }
  const parent = dirname(volume);
  if (parent === volume) return true;
  try {
    return (await stat(parent, { bigint: true })).dev !== device;
  } catch {
    return true;
  }
}

/// Where a walled-off folder away from its path seems to be, from one of its
/// documents met at `path` — `rel` being where it was inside the folder: the
/// folder that holds it as it held it (`path` without `rel`'s names, when it
/// ends with them), else the folder the file is in.
export function placeFromDocument(path: string, rel: string, platform: NodeJS.Platform = process.platform): string {
  const names = rel.split(/[\\/]/).filter(Boolean);
  let place = resolve(path);
  for (let i = names.length - 1; i >= 0; i -= 1) {
    if (foldPath(basename(place), platform) !== foldPath(names[i]!, platform)) return dirname(resolve(path));
    place = dirname(place);
  }
  return place;
}
