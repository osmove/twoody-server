import { statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { sqlite } from "../db.js";
import { realPathOf, within as sameOrInside } from "./samePath.js";
import { anyDevice, DATE_SLACK_MS, folderIdentity, folderIdentityAsync, volumeConnected, volumeConnectedAsync, volumeOf, type WallPrint, type WallPrints } from "./wallIdentity.js";

export { printMatch, type WallPrint, type WallPrints } from "./wallIdentity.js";

// Where each walled-off project's folder is now (Jimmy, 16/10/2026;
// docs/projects-design.md §8 « Moved outside Twoody »).
//
// A walled-off folder was known by its path only (document_folders.path).
// Renamed or moved outside Twoody — in the Finder, the Explorer, by a sync
// client —, its path held nothing any more: the project lost its documents,
// and a granted folder holding its new place (the firm's general folder)
// walked, listed and indexed it as its own — found by the general chat, the
// phone, the other computers, a shared folder. So each one is also known:
//
//   by its identity   its device and file number (migration 16), as last seen
//                     at its path. Every walk leaves out a folder that is one
//                     of them, whatever it is called now and wherever it is
//                     (fileListing.ts walledAt, walk.ts `walls`); the index
//                     pass follows it there (library.ts): the project's folder
//                     takes its new path and keeps its index — when its
//                     documents are there too (an identity alone is not
//                     enough: a disk may give a deleted folder's number to
//                     another).
//   by its documents  the name, size and date of what was indexed of it. Not
//                     at its path, a walled-off folder whose documents turn up
//                     somewhere (moved to another disk: a copy, then the
//                     original removed; recreated by a sync client) is taken
//                     to be there: walled there and proposed on the project's
//                     page, never followed alone. Meanwhile none of its
//                     documents is listed, browsed or read into another
//                     folder's index, wherever it lies (`walledPrints`).
//
// Not at its path and found nowhere, its disk being connected (`missing`), it
// may be anywhere: nothing new is read in any folder outside its project until
// the person finds it again on the project's page or takes it out of the
// project (`paused` in library.ts listFolders). What was indexed before stays
// searchable, and its own index stays with the project. Its disk not connected
// (`unreachable`: a NAS out of the office, a USB disk unplugged), nothing of it
// can be walked: nothing is paused, and its documents stay out of the other
// folders' index all the same.
//
// The states are asked of the system at most every two seconds, in the
// background, so a network drive out of reach costs no request a wait; the
// index pass and the Desktop's list of folders ask afresh.

export type WallState = "ok" | "elsewhere" | "missing" | "unreachable";

export interface WallPlace {
  /// document_folders.id of the walled-off folder.
  id: string;
  projectId: string;
  /// Where it was last seen.
  path: string;
  /// « dev:ino » as last seen at its path; null when never seen since migration 16.
  identity: string | null;
  /// The root of the disk holding it, as last seen.
  volume: string | null;
  state: WallState;
  /// Where it is now, when `elsewhere`.
  found: string | null;
  foundBy: "identity" | "documents" | null;
}

interface WallRow {
  id: string;
  projectId: string;
  path: string;
  identity: string | null;
  volume: string | null;
}

export type Sighting = { path: string; by: "identity" | "documents" };

const FRESH_MS = 2_000;

const known = new Map<string, { at: number; places: WallPlace[] }>();
const refreshing = new Map<string, Promise<WallPlace[]>>();
/// Where the last index pass met each walled-off folder away from its path.
const sightings = new Map<string, Map<string, Sighting>>();
let awayHook: ((userId: string) => void) | null = null;

/// Called when a walled-off folder is found away from its path, outside an
/// index pass: library.ts starts one, which looks for it.
export function onWallAway(hook: ((userId: string) => void) | null): void {
  awayHook = hook;
}

function rowsOf(userId: string): WallRow[] {
  return sqlite
    .prepare("SELECT id, project_id AS projectId, path, identity, volume FROM document_folders WHERE user_id = ? AND project_id IS NOT NULL ORDER BY path")
    .all(userId) as WallRow[];
}

/// A walled-off folder seen at `path` now: its identity, and its disk's root.
export function recordPlace(id: string, path: string): void {
  const identity = folderIdentity(path);
  if (identity) sqlite.prepare("UPDATE document_folders SET identity = ?, volume = ? WHERE id = ?").run(identity, volumeOf(path), id);
}

/// One walled-off folder's state, from the identity of what is at its path
/// now (`here`) and whether its disk is there.
function placed(userId: string, row: WallRow, here: string | null, connected: boolean | null): WallPlace {
  const base: WallPlace = { ...row, state: "ok", found: null, foundBy: null };
  // Its path holds it: the same identity, or the same file number on a disk
  // mounted again under another device number; or it was never seen since
  // migration 16 (seen now).
  if (here && (!row.identity || here === row.identity || anyDevice(here) === anyDevice(row.identity))) {
    if (here !== row.identity || !row.volume) {
      const volume = volumeOf(row.path) ?? row.volume;
      sqlite.prepare("UPDATE document_folders SET identity = ?, volume = ? WHERE id = ?").run(here, volume, row.id);
      return { ...base, identity: here, volume };
    }
    return base;
  }
  const seen = sightings.get(userId)?.get(row.id);
  if (seen) return { ...base, state: "elsewhere", found: seen.path, foundBy: seen.by };
  // Nothing at its path, its disk not connected: out of reach, not lost.
  if (!here && row.volume && connected === false) return { ...base, state: "unreachable" };
  return { ...base, state: "missing" };
}

function remember(userId: string, places: WallPlace[], fromPass: boolean): void {
  const before = known.get(userId)?.places;
  known.set(userId, { at: Date.now(), places });
  if (fromPass || !awayHook) return;
  // Away now and not before (or never looked at): an index pass looks for it.
  const was = new Map((before ?? []).map((place) => [place.id, place.state]));
  if (places.some((place) => (place.state === "missing" || place.state === "unreachable") && was.get(place.id) !== place.state)) awayHook(userId);
}

/// The walled-off folders' states asked of the system now, without holding
/// the event loop. `fromPass`: asked by the index pass itself.
export function checkWalls(userId: string, fromPass = false): Promise<WallPlace[]> {
  const running = refreshing.get(userId);
  if (running) return running;
  const work = (async () => {
    const rows = rowsOf(userId);
    const places: WallPlace[] = [];
    for (const row of rows) {
      const here = await folderIdentityAsync(row.path);
      const connected = !here && row.volume ? await volumeConnectedAsync(row.volume) : null;
      places.push(placed(userId, row, here, connected));
    }
    remember(userId, places, fromPass);
    return places;
  })().finally(() => refreshing.delete(userId));
  refreshing.set(userId, work);
  return work;
}

/// The walled-off folders' states as last asked — asked now the first time,
/// again in the background once two seconds old.
export function wallPlaces(userId: string): WallPlace[] {
  const last = known.get(userId);
  if (!last) {
    const places = rowsOf(userId).map((row) => {
      const here = folderIdentity(row.path);
      return placed(userId, row, here, !here && row.volume ? volumeConnected(row.volume) : null);
    });
    remember(userId, places, false);
    return places;
  }
  if (Date.now() - last.at > FRESH_MS) void checkWalls(userId).catch(() => undefined);
  return last.places;
}

/// Where the index pass met the walled-off folders away from their path: the
/// last pass's word replaces the one before.
export function noteSightings(userId: string, found: Map<string, Sighting>): void {
  sightings.set(userId, found);
  known.delete(userId);
}

/// A walled-off folder linked again, followed or taken out of its project:
/// asked again at its next use.
export function forgetWall(userId: string, id?: string): void {
  if (id) sightings.get(userId)?.delete(id);
  known.delete(userId);
}

/// What a folder of project `project` (null: of none) leaves out by identity:
/// every other project's walled-off folder — away from its path, by its file
/// number on any device too (wallIdentity.ts anyDevice).
export function wallKeys(places: readonly WallPlace[], project: string | null): string[] {
  const keys = new Set<string>();
  for (const place of places) {
    if (place.projectId === project || !place.identity) continue;
    keys.add(place.identity);
    if (place.state !== "ok") keys.add(anyDevice(place.identity));
  }
  return [...keys];
}

/// Where the other projects' walled-off folders were found away from their
/// path, every way a walk may meet them.
export function foundWalls(places: readonly WallPlace[], project: string | null): string[] {
  return [...new Set(places.filter((place) => place.found && place.projectId !== project).flatMap((place) => [place.found!, realPathOf(place.found!)]))];
}

/// Whether a folder of project `project` waits: another project's walled-off
/// folder is missing.
export function pausedFor(places: readonly WallPlace[], project: string | null): boolean {
  return places.some((place) => place.state === "missing" && place.projectId !== project);
}

// ─── Its documents ──────────────────────────────────────────────────────────

/// The documents indexed in the folder of a walled-off project — the folder
/// itself and those granted inside it — with where each is from it.
function documentsOf(userId: string, place: Pick<WallPlace, "path">, limit?: number): Array<{ name: string; size: number; mtime: number; rel: string }> {
  const folders = (sqlite.prepare("SELECT id, path FROM document_folders WHERE user_id = ?").all(userId) as Array<{ id: string; path: string }>).filter((folder) => sameOrInside(place.path, folder.path));
  if (!folders.length) return [];
  const rows = sqlite
    .prepare(`SELECT name, size, mtime_ms AS mtime, path FROM documents WHERE user_id = ? AND folder_id IN (${folders.map(() => "?").join(",")}) ORDER BY indexed_at DESC${limit ? ` LIMIT ${limit}` : ""}`)
    .all(userId, ...folders.map((folder) => folder.id)) as Array<{ name: string; size: number; mtime: number; path: string }>;
  return rows.flatMap((row) => {
    const rel = relative(place.path, row.path);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? [{ name: row.name, size: row.size, mtime: row.mtime, rel }] : [];
  });
}

/// The documents of the other projects' walled-off folders away from their
/// path, for the walks to know them anywhere; null when there are none.
/// Kept for as long as the states they come from.
const printsMemo = new WeakMap<readonly WallPlace[], Map<string | null, WallPrints | null>>();
export function awayPrints(userId: string, places: readonly WallPlace[], project: string | null): WallPrints | null {
  if (!places.some((place) => place.state !== "ok" && place.projectId !== project)) return null;
  let memo = printsMemo.get(places);
  if (!memo) printsMemo.set(places, (memo = new Map()));
  if (!memo.has(project)) memo.set(project, printsOf(userId, places, project));
  return memo.get(project)!;
}

function printsOf(userId: string, places: readonly WallPlace[], project: string | null): WallPrints | null {
  const byName = new Map<string, WallPrint[]>();
  const counts = new Map<string, number>();
  for (const place of places) {
    if (place.state === "ok" || place.projectId === project) continue;
    const documents = documentsOf(userId, place);
    counts.set(place.id, documents.length);
    for (const document of documents) {
      const name = document.name.normalize("NFC");
      const list = byName.get(name) ?? [];
      list.push({ size: document.size, mtime: document.mtime, wall: place.id, rel: document.rel });
      byName.set(name, list);
    }
  }
  return byName.size ? { names: new Set(byName.keys()), byName, counts } : null;
}

/// Whether `at` holds what was indexed of the walled-off folder: one of its
/// documents at the same place in it, of the same size and date — or it had
/// none to compare.
export function documentsThere(userId: string, place: Pick<WallPlace, "path">, at: string): boolean {
  const documents = documentsOf(userId, place, 50);
  if (!documents.length) return true;
  return documents.some((document) => {
    try {
      const info = statSync(join(at, document.rel));
      return info.isFile() && info.size === document.size && Math.abs(Math.floor(info.mtimeMs) - document.mtime) <= DATE_SLACK_MS;
    } catch {
      return false;
    }
  });
}
