import {indexedDirectory, type IndexedEntry} from "./tree.js";
import { indexSemantic } from "./semantic.js";
import { and, eq } from "drizzle-orm";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { generateId } from "../auth.js";
import { DATA_DIR, db, documentFolders, documents, sqlite } from "../db.js";
import { chunkSections } from "./chunk.js";
import { extractSections, maxBytesFor } from "./extract.js";
import { ocrEngine } from "./ocr.js";
import { folderRisk } from "./folderRisk.js";
import { capabilityOn, setLocalCapability } from "../localCapabilities.js";
import { folderReadable, walk } from "./walk.js";
import { buildGramsQuery, buildMatchQuery, metadataScore, queryTerms, selectPassages, termsFound } from "./query.js";
import { cjkSnippet, hasCjk, indexGrams } from "./cjk.js";
import { holds, identitiesOn, identitiesOnAsync, pathPlace, pathPlaceAsync, spellingsOf, within as sameOrInside, type PathPlace } from "./samePath.js";
import { folderIdentity, placeFromDocument, walledIdentity } from "./wallIdentity.js";
import {
  awayPrints,
  checkWalls,
  documentsThere,
  forgetWall,
  foundWalls,
  noteSightings,
  onWallAway,
  pausedFor,
  printMatch,
  recordPlace,
  wallKeys,
  wallPlaces,
  type Sighting,
  type WallPlace,
  type WallPrints,
} from "./wallPlaces.js";

// The user's document library: the folders they granted, the index
// built from them, and the search that feeds /queries.
//
// Everything stays in the server's own SQLite file. Indexing is
// incremental (a file is re-read only when its size or modification time
// changed) and runs one file at a time, yielding to the event loop
// between files so chat stays responsive while a large folder is read.

// ─── Folders ────────────────────────────────────────────────────────────────

export class FolderRejected extends Error {
  constructor(public readonly reason: "not_found" | "not_a_directory" | "too_broad" | "sensitive" | "already_added" | "not_permitted") {
    super(reason);
  }
}

/// Validates a folder the user picked and returns its canonical path.
/// Refuses what should never be indexed wholesale (folderRisk.ts): a
/// disk, a whole home directory or what holds it, system directories,
/// and anything hidden or under ~/Library or AppData.
export function canonicalFolder(input: string, personalRoot = false): string {
  let real: string;
  try {
    real = realpathSync(input);
  } catch {
    throw new FolderRejected("not_found");
  }
  if (!statSync(real).isDirectory()) throw new FolderRejected("not_a_directory");

  const risk = folderRisk(real, realpathSync(homedir()), process.platform, personalRoot);
  if (risk) throw new FolderRejected(risk);
  return real;
}

/// A granted folder as the person knows it: iCloud Drive rather than its
/// directory's name (com~apple~CloudDocs).
export function folderName(path: string): string {
  if (/[\\/]Library[\\/]Mobile Documents[\\/]com~apple~CloudDocs$/.test(path)) return "iCloud Drive";
  // ~/Library/CloudStorage/GoogleDrive-claire@example.com → « Google Drive (claire@example.com) »
  const cloud = /[\\/]Library[\\/]CloudStorage[\\/](GoogleDrive|Dropbox|OneDrive|Box)(?:-(.+))?$/.exec(path);
  if (cloud) {
    const name = { GoogleDrive: "Google Drive", Dropbox: "Dropbox", OneDrive: "OneDrive", Box: "Box" }[cloud[1] as "GoogleDrive" | "Dropbox" | "OneDrive" | "Box"];
    return cloud[2] && cloud[2] !== "Box" ? `${name} (${cloud[2]})` : name;
  }
  return basename(path);
}

/// Files of each folder the last pass could not read (walk.ts `ignored`).
const ignoredByFolder = new Map<string, number>();

// ─── Where the granted folders are ─────────────────────────────────────────
//
// Two grants may name one place two ways — « Z:\Cabinet » and
// « \\nas\cabinet\Clients\Tessane », a short name, another case — and a
// walled-off project's folder must be met however a walk, a listing or the
// system writes it (samePath.ts). Each granted folder's place is asked of the
// system once, then kept: asked again in the background after a minute, so a
// network drive out of reach costs one wait, never one per request.

const PLACE_FRESH_MS = 60_000;
const placeCache = new Map<string, { place: PathPlace; ids: string[]; at: number }>();
let placesRefreshing = false;

/// A granted folder's place, and the identities of the folders on its way.
export function grantedPlace(path: string): { place: PathPlace; ids: string[] } {
  const known = placeCache.get(path);
  if (known) {
    if (Date.now() - known.at > PLACE_FRESH_MS) refreshPlaces();
    return known;
  }
  const place = pathPlace(path);
  const fresh = { place, ids: identitiesOn(place.real), at: Date.now() };
  placeCache.set(path, fresh);
  return fresh;
}

/// A folder granted, taken back or walled off now: its place asked again at
/// its next use.
export function forgetGrantedPlace(path: string): void {
  placeCache.delete(path);
  layoutMemo = null;
}

function refreshPlaces(): void {
  if (placesRefreshing) return;
  placesRefreshing = true;
  void (async () => {
    for (const path of [...placeCache.keys()]) {
      const place = await pathPlaceAsync(path).catch(() => null);
      if (place && placeCache.has(path)) placeCache.set(path, { place, ids: await identitiesOnAsync(place.real), at: Date.now() });
    }
  })().finally(() => {
    placesRefreshing = false;
    layoutMemo = null;
  });
}

type FolderRow = { id: string; path: string; projectId: string | null };
type Placed = FolderRow & { place: PathPlace; ids: string[] };

export interface FolderLayout {
  placed: Placed[];
  /// The granted folders holding each one (or naming the same place), however each is written.
  holders: Map<string, Placed[]>;
  /// The walled-off project each folder belongs to (`folderProjects`).
  projectOf: Map<string, string | null>;
  /// Every spelling of each folder worth comparing with what lies under the folders holding it.
  spellings: Map<string, string[]>;
  /// Each folder's spellings as written from one folder holding it: holder id → folder id → spellings.
  spelledFrom: Map<string, Map<string, string[]>>;
}

let layoutMemo: { key: string; at: number; layout: FolderLayout } | null = null;

/// The granted folders with their places, which holds which, the walled-off
/// project each belongs to — its own, else that of the deepest walled-off
/// folder holding it: a folder granted inside one is that project's too,
/// whatever was granted first, and so is the same folder granted again under
/// another spelling — and their spellings. Kept for as long as their places.
export function folderLayout(rows: ReadonlyArray<FolderRow>): FolderLayout {
  const key = [...rows].map((row) => `${row.id}\u0000${row.path}\u0000${row.projectId ?? ""}`).sort().join("\n");
  if (layoutMemo && layoutMemo.key === key && Date.now() - layoutMemo.at <= PLACE_FRESH_MS) return layoutMemo.layout;
  const placed: Placed[] = rows.map((row) => ({ id: row.id, path: row.path, projectId: row.projectId ?? null, ...grantedPlace(row.path) }));
  const holders = new Map(placed.map((inner) => [inner.id, placed.filter((outer) => outer.id !== inner.id && holds(outer.place, inner.place, inner.ids))]));
  const owners = placed.filter((row) => row.projectId).sort((a, b) => b.place.real.length - a.place.real.length);
  const projectOf = new Map(placed.map((row) => [row.id, row.projectId ?? owners.find((owner) => holders.get(row.id)!.includes(owner))?.projectId ?? null]));
  const spelledFrom = new Map<string, Map<string, string[]>>(placed.map((outer) => [outer.id, new Map()]));
  for (const inner of placed) for (const outer of holders.get(inner.id)!) spelledFrom.get(outer.id)!.set(inner.id, spellingsOf(inner.place, [outer.place]));
  const spellings = new Map(placed.map((row) => [row.id, [...new Set([row.place.path, row.place.real, ...holders.get(row.id)!.flatMap((outer) => spelledFrom.get(outer.id)!.get(row.id)!)])]]));
  const layout = { placed, holders, projectOf, spellings, spelledFrom };
  layoutMemo = { key, at: Date.now(), layout };
  return layout;
}

export function listFolders(userId: string) {
  const counts = sqlite
    .prepare(
      `SELECT folder_id AS folderId,
              COUNT(*) AS total,
              SUM(status = 'indexed') AS indexed,
              SUM(status = 'empty') AS empty,
              SUM(status = 'error') AS failed
         FROM documents WHERE user_id = ? GROUP BY folder_id`,
    )
    .all(userId) as Array<{ folderId: string; total: number; indexed: number; empty: number; failed: number }>;
  const byFolder = new Map(counts.map((row) => [row.folderId, row]));

  const rows = db
    .select()
    .from(documentFolders)
    .where(eq(documentFolders.userId, userId))
    .all()
    .sort((a, b) => a.path.localeCompare(b.path));
  const layout = folderLayout(rows);
  const projectOf = layout.projectOf;
  // Where each walled-off project's folder is now (wallPlaces.ts).
  const walls = wallPlaces(userId);
  const wallOf = new Map(walls.map((wall) => [wall.id, wall]));
  return rows.map((folder) => {
    const project = projectOf.get(folder.id) ?? null;
    const count = byFolder.get(folder.id);
    // Another project's walled-off folder is missing and may be anywhere:
    // nothing new is read in this one until it is found again.
    const paused = pausedFor(walls, project);
    const wall = wallOf.get(folder.id);
    return {
      id: folder.id,
      path: folder.path,
      name: folderName(folder.path),
      documents: count?.total ?? 0,
      indexed: count?.indexed ?? 0,
      without_text: count?.empty ?? 0,
      failed: count?.failed ?? 0,
      ignored: ignoredByFolder.get(folder.id) ?? 0,
      // The isolated project it belongs to (src/projects/isolation.ts):
      // searched in that project's conversations only, never elsewhere.
      project_id: project,
      // The folders of another isolated project lying inside it: never
      // walked, listed, browsed nor read from it (fileListing.ts walledAt) —
      // a walled-off project's documents are reached through its own folder,
      // in its own conversations only. Each one every way it may be met from
      // here (samePath.ts): as granted, as the system resolves it, and as
      // written from this folder; where one was found away from its path; and
      // the folder itself while it waits.
      walled: [...new Set([...wallsIn(layout, folder.id, project), ...foundWalls(walls, project), ...(paused ? layout.spellings.get(folder.id) ?? [folder.path] : [])])],
      // The other projects' walled-off folders by identity, wherever they
      // are now (wallPlaces.ts wallKeys). Never sent: routes/localDocuments.ts.
      walledIds: wallKeys(walls, project),
      // Their documents, by name, size and date, while they are away from
      // their path (wallPlaces.ts awayPrints). Never sent either.
      walledPrints: awayPrints(userId, walls, project),
      paused,
      // A walled-off project's own folder: where it is (wallPlaces.ts) —
      // ok, elsewhere (found: where, found_by: how), missing, unreachable —
      // and what it is (« dev:ino »), for this computer's app only.
      ...(wall ? { state: wall.state, found: wall.found, found_by: wall.foundBy, identity: wall.identity } : {}),
    };
  });
}

/// The folders of a walled-off project other than `project` that lie in
/// folder `id` (or are it, granted again under another spelling), every way
/// they may be met from it.
function wallsIn(layout: FolderLayout, id: string, project: string | null): string[] {
  const from = layout.spelledFrom.get(id);
  if (!from) return [];
  const walls = layout.placed.filter((other) => other.id !== id && (layout.projectOf.get(other.id) ?? null) !== null && layout.projectOf.get(other.id) !== project && from.has(other.id));
  return [...new Set(walls.flatMap((other) => from.get(other.id)!))];
}

/// Every spelling of every walled-off project's folder granted here: as
/// granted, as the system resolves it, and as written from each granted
/// folder holding it — what the Agent in the chat keeps out of
/// (fileActions/plan.ts).
export function wallSpellings(userId: string): string[] {
  const layout = folderLayout(db.select().from(documentFolders).where(eq(documentFolders.userId, userId)).all());
  return [...new Set([...layout.placed.filter((folder) => layout.projectOf.get(folder.id)).flatMap((folder) => layout.spellings.get(folder.id)!), ...foundWalls(wallPlaces(userId), null)])];
}

/// The isolated project each granted folder belongs to: its own, else that
/// of an isolated project's folder holding it — a folder granted inside one
/// is that project's too, whatever was granted first, and however each was
/// written (folderLayout).
export function folderProjects(rows: ReadonlyArray<{ id: string; path: string; projectId: string | null }>): Map<string, string | null> {
  return folderLayout(rows).projectOf;
}

/// Grants a folder. Its first entry is read before it is kept, so that
/// macOS asks the person now (Desktop, Documents, Downloads, iCloud
/// Drive) rather than in the middle of an index pass, and a refusal is
/// said at once ("not_permitted") instead of leaving an empty folder.
export async function addFolder(userId: string, input: string, personalRoot = false) {
  const path = canonicalFolder(input, personalRoot);
  if (!(await folderReadable(path))) throw new FolderRejected("not_permitted");
  const existing = db
    .select()
    .from(documentFolders)
    .where(and(eq(documentFolders.userId, userId), eq(documentFolders.path, path)))
    .all();
  if (existing.length > 0) throw new FolderRejected("already_added");

  const id = generateId();
  db.insert(documentFolders).values({ id, userId, path, createdAt: new Date() }).run();
  forgetGrantedPlace(path);
  // Granting a folder is asking for Documents — the way to switch it on
  // for a computer without a screen (a Pi), where Capacités is not shown.
  setLocalCapability(userId, "documents", true);
  return { id, path };
}

export function removeFolder(userId: string, folderId: string): boolean {
  const [folder] = db
    .select()
    .from(documentFolders)
    .where(and(eq(documentFolders.id, folderId), eq(documentFolders.userId, userId)))
    .all();
  if (!folder) return false;

  sqlite.transaction(() => {
    sqlite
      .prepare("DELETE FROM document_grams WHERE document_id IN (SELECT id FROM documents WHERE folder_id = ?)")
      .run(folderId);
    sqlite
      .prepare("DELETE FROM document_chunks WHERE document_id IN (SELECT id FROM documents WHERE folder_id = ?)")
      .run(folderId);
    sqlite.prepare("DELETE FROM documents WHERE folder_id = ?").run(folderId);
    sqlite.prepare("DELETE FROM document_folders WHERE id = ?").run(folderId);
  })();
  forgetGrantedPlace(folder.path);
  forgetWall(userId, folderId);
  return true;
}

// ─── Indexing ───────────────────────────────────────────────────────────────

export interface IndexStatus {
  running: boolean;
  total: number;
  done: number;
  current: string | null;
  started_at: string | null;
  finished_at: string | null;
  limited?: boolean;
  /// Folders the system would not let Twoody read (see walk.ts).
  denied?: string[];
}

const jobs = new Map<string, IndexStatus>();
/// Asked again while a pass ran (a folder granted, an isolated project's
/// folder set): another pass follows it, which knows the new folder.
const askedAgain = new Set<string>();

const passListeners: Array<(userId: string) => void> = [];

/// Called after every pass, and when one was asked with Documents off: the
/// watches follow the folders (watch.ts), the project overviews look for
/// changed documents (projects/overview).
export function onIndexPass(listener: (userId: string) => void): void {
  passListeners.push(listener);
}

function passEnded(userId: string): void {
  for (const listener of passListeners) {
    try {
      listener(userId);
    } catch {
      // one listener's failure is not the pass's
    }
  }
}

// Scans read since the index was made (27/10/2026: Windows reads them from
// Desktop 0.13.115 on; a PDF indexed before, its scanned pages unread, is
// unchanged on the disk and was never read again — found by the Windows
// upgrade check). The engine each person's index was made with is kept
// here; when scans are read and it was made without (or with another
// engine), the next pass reads its PDFs again once, and indexes again only
// those with a page read by OCR: a PDF with all its text keeps its index.
// An index from before this file was made with Vision on a Mac, else
// without.
const OCR_MARKS = join(DATA_DIR, "documents-ocr.json");

function ocrMarks(): Record<string, string> {
  try {
    const marks = JSON.parse(readFileSync(OCR_MARKS, "utf8"));
    return marks && typeof marks === "object" ? marks : {};
  } catch {
    return {};
  }
}

/// The people whose pass reads their PDFs again, scans in view.
const rereading = new Set<string>();

function scansRead(userId: string): string | null {
  const engine = ocrEngine();
  if (engine === "none") return null;
  const made = ocrMarks()[userId] ?? (engine === "vision" ? "vision" : "none");
  return made === engine ? null : engine;
}

function markScansRead(userId: string, engine: string): void {
  try {
    writeFileSync(OCR_MARKS, JSON.stringify({ ...ocrMarks(), [userId]: engine }), { mode: 0o600 });
  } catch {
    // read again at the next pass
  }
}

export function indexStatus(userId: string): IndexStatus {
  return jobs.get(userId) ?? { running: false, total: 0, done: 0, current: null, started_at: null, finished_at: null };
}

/// Brings the index in line with the user's folders. Resolves once the
/// pass is over; callers that only want to start it do not await it.
///
/// It also looks for the walled-off projects' folders renamed or moved
/// outside Twoody (wallPlaces.ts) along its own walk — never elsewhere on the
/// disk: one met by its identity is not entered and is followed, its
/// documents being there too; one whose documents turn up is walled where they
/// are; one found nowhere, its disk connected, keeps its index, and nothing
/// new is read in any folder outside its project until it is found again.
export async function reindex(userId: string): Promise<IndexStatus> {
  const current = jobs.get(userId);
  if (current?.running) {
    askedAgain.add(userId);
    return current;
  }
  // Documents switched off in Capabilities: nothing is read.
  if (!capabilityOn(userId, "documents")) {
    passEnded(userId);
    return indexStatus(userId);
  }

  const status: IndexStatus = {
    running: true,
    total: 0,
    done: 0,
    current: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  jobs.set(userId, status);
  // A walled-off folder followed to its new place: the pass starts again
  // from there.
  let followed = false;

  try {
    // Where each walled-off project's folder is, asked of the system now.
    const walls = await checkWalls(userId, true);
    const folders = db.select().from(documentFolders).where(eq(documentFolders.userId, userId)).all().sort((a,b)=>b.path.length-a.path.length);
    const work: Array<{ folderId: string; path: string }> = [];
    const seen = new Set<string>();
    // Where each folder is, asked of the system before the walk, without
    // holding the event loop (a network drive out of reach).
    await warmGrantedPlaces(folders.map((folder) => folder.path));
    const layout = folderLayout(folders);
    const projectOf = (id: string) => layout.projectOf.get(id) ?? null;
    // The walled-off folders this walk meets away from their path: by their
    // identity, where; by their documents, the folders holding them and how
    // many; and the files that are their documents.
    const met = new Map<string, string>();
    const metByDocuments = new Map<string, Map<string, number>>();
    const printed = new Set<string>();
    const prints = new Map<string | null, WallPrints | null>();
    const printsOf = (project: string | null) => {
      if (!prints.has(project)) prints.set(project, awayPrints(userId, walls, project));
      return prints.get(project)!;
    };
    const sight = (path: string, identity: string, project: string | null) => {
      for (const wall of walls) {
        if (wall.projectId === project || met.has(wall.id)) continue;
        if (walledIdentity(new Set(wallKeys([wall], null)), identity)) met.set(wall.id, path);
      }
    };

    for (const folder of folders) {
      const project = projectOf(folder.id);
      const keys = new Set(wallKeys(walls, project));
      // The granted folder is itself another project's walled-off folder,
      // granted again under its new name: not walked.
      const itself = keys.size ? folderIdentity(folder.path) : null;
      if (walledIdentity(keys, itself)) {
        sight(folder.path, itself!, project);
        ignoredByFolder.set(folder.id, 0);
        continue;
      }
      // Granted subfolders are walked for themselves (longest path first),
      // met however each was written (folderLayout); the files this one
      // indexed already, and when it was last read, decide what a full
      // folder keeps (walk.ts).
      const inside = layout.spelledFrom.get(folder.id) ?? new Map<string, string[]>();
      const indexed = sqlite.prepare("SELECT path, indexed_at AS indexedAt FROM documents WHERE user_id = ? AND folder_id = ?").all(userId, folder.id) as Array<{ path: string; indexedAt: number | null }>;
      const last = indexed.reduce<number | null>((latest, row) => (row.indexedAt !== null && (latest === null || row.indexedAt > latest) ? row.indexedAt : latest), null);
      const away = printsOf(project);
      // Where another project's walled-off folder was found last time is
      // walked again — by identity it is not entered, by its documents only
      // looked at — so that this pass finds it there again; nothing of it is
      // indexed (`elsewhere` below).
      const scan = await walk(folder.path, undefined, {
        skip: [...inside.values()].flat(),
        keep: new Set(indexed.map((row) => row.path)),
        since: last,
        ...(keys.size ? { walls: { keys, met: (path: string, identity: string) => sight(path, identity, project) } } : {}),
        ...(away
          ? {
              prints: {
                names: away.names,
                match: (path: string, size: number, mtimeMs: number) => {
                  const print = printMatch(away, basename(path), size, mtimeMs);
                  if (!print) return false;
                  printed.add(path);
                  const place = placeFromDocument(path, print.rel);
                  const counts = metByDocuments.get(print.wall) ?? new Map<string, number>();
                  counts.set(place, (counts.get(place) ?? 0) + 1);
                  metByDocuments.set(print.wall, counts);
                  return true;
                },
              },
            }
          : {}),
      });
      ignoredByFolder.set(folder.id, scan.ignored);
      if (scan.limited) status.limited = true;
      if (scan.denied.length > 0) status.denied = [...(status.denied ?? []), ...scan.denied].slice(0, 10);
      for (const path of scan.files) {
        if (seen.has(path)) continue;
        seen.add(path);
        work.push({ folderId: folder.id, path });
      }
    }

    // Where the walled-off folders away from their path are now: met by their
    // identity, else where their documents are — as many as two of them, or
    // all it had.
    const sighted = new Map<string, Sighting>();
    for (const wall of walls) {
      if (wall.state === "ok") continue;
      const at = met.get(wall.id);
      if (at) {
        sighted.set(wall.id, { path: at, by: "identity" });
        continue;
      }
      const places = [...(metByDocuments.get(wall.id) ?? [])].sort((a, b) => b[1] - a[1]);
      const total = [...prints.values()].find((each) => each?.counts.has(wall.id))?.counts.get(wall.id) ?? 0;
      if (places[0] && places[0][1] >= Math.min(2, total)) sighted.set(wall.id, { path: places[0][0], by: "documents" });
    }
    noteSightings(userId, sighted);
    // Followed: met by its identity, its documents there too.
    for (const wall of walls) {
      const at = sighted.get(wall.id);
      if (at?.by === "identity" && followWall(userId, wall, at.path)) followed = true;
    }

    if (!followed) {
      // With what this walk saw: elsewhere, missing, out of reach.
      const places = await checkWalls(userId, true);
      const away = places.filter((place) => place.state !== "ok");
      const paused = (id: string) => pausedFor(places, projectOf(id));
      // Where another project's walled-off folder was found: not this folder's.
      const found = new Map<string | null, string[]>();
      const elsewhere = (folderId: string, path: string) => {
        const project = projectOf(folderId);
        if (!found.has(project)) found.set(project, foundWalls(places, project));
        return found.get(project)!.some((wall) => sameOrInside(wall, path));
      };
      // A walled-off folder away from its path keeps its index (and so do the
      // folders granted inside it), and every folder that waits keeps its own.
      const kept = new Set(folders.filter((folder) => paused(folder.id) || away.some((place) => place.projectId === projectOf(folder.id) && sameOrInside(place.path, folder.path))).map((folder) => folder.id));

      // Files that disappeared since the last pass; and what another folder
      // took of a walled-off folder away from its path, wherever it waits.
      const known = db.select({ id: documents.id, path: documents.path, folderId: documents.folderId }).from(documents).where(eq(documents.userId, userId)).all();
      for (const row of known) {
        if (printed.has(row.path) || elsewhere(row.folderId, row.path)) deleteDocument(row.id);
        else if (!seen.has(row.path) && !kept.has(row.folderId)) deleteDocument(row.id);
      }

      // Nothing new where it waits, nor where another project's folder was found.
      const todo = work.filter((item) => !paused(item.folderId) && !elsewhere(item.folderId, item.path));
      status.total = todo.length;
      const engine = scansRead(userId);
      if (engine) rereading.add(userId);
      try {
        for (const item of todo) {
          status.current = basename(item.path);
          await indexFile(userId, item.folderId, item.path);
          status.done += 1;
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (engine) markScansRead(userId, engine);
      } finally {
        rereading.delete(userId);
      }
    }
  } finally {
    status.running = false;
    status.current = null;
    status.finished_at = new Date().toISOString();
  }
  if (askedAgain.delete(userId) || followed) return reindex(userId);
  void indexSemantic(userId);
  passEnded(userId);
  return status;
}

// A walled-off folder found away from its path outside a pass (a request
// asked where the walls are): a pass looks for it.
onWallAway((userId) => void reindex(userId).catch(() => undefined));

/// A walled-off folder met by its identity away from its path, its documents
/// there too (wallPlaces.ts documentsThere — an identity alone is not
/// enough): the project's folder takes its new place (moveWall). Never a
/// place folderRisk refuses. Whether it was followed.
function followWall(userId: string, wall: WallPlace, to: string): boolean {
  let path: string;
  try {
    path = canonicalFolder(to);
  } catch {
    return false;
  }
  if (!documentsThere(userId, wall, path)) return false;
  return moveWall(userId, wall, path) === null;
}

/// A walled-off project's folder (`wall`: its row, its project, where it
/// was) at `path` from now on: the folders granted inside it move with it,
/// their documents keep their index under their new paths, and what other
/// folders indexed there is dropped (the next pass reads it again where it
/// belongs). A folder left at its old place — a new one made under the old
/// name — stays the project's: a folder at a walled-off project's path never
/// becomes an ordinary one by itself. Refused onto a place granted on its own
/// (« already_added »), into or around another project's walled-off folder
/// (« other_project_folder »). Null when done.
export function moveWall(userId: string, wall: { id: string; projectId: string; path: string }, path: string): "already_added" | "other_project_folder" | "failed" | null {
  const rows = sqlite.prepare("SELECT id, path, project_id AS projectId FROM document_folders WHERE user_id = ?").all(userId) as FolderRow[];
  const layout = folderLayout(rows);
  const from = wall.path;
  const moving = rows.filter((row) => sameOrInside(from, row.path));
  const target = pathPlace(path);
  const targetIds = identitiesOn(target.real);
  for (const other of layout.placed) {
    if (moving.some((row) => row.id === other.id)) continue;
    if (holds(other.place, target, targetIds) && holds(target, other.place, other.ids)) return "already_added";
    const project = layout.projectOf.get(other.id) ?? null;
    if (project && project !== wall.projectId && (holds(other.place, target, targetIds) || holds(target, other.place, other.ids))) return "other_project_folder";
  }
  const samePlace = sameOrInside(path, from) && sameOrInside(from, path);
  const leftId = !samePlace && folderIdentity(from) !== null ? generateId() : null;
  const ids = new Set(moving.map((row) => row.id));
  try {
    sqlite.transaction(() => {
      for (const document of sqlite.prepare("SELECT id, path, folder_id AS folderId FROM documents WHERE user_id = ?").all(userId) as Array<{ id: string; path: string; folderId: string }>) {
        if (!ids.has(document.folderId) && sameOrInside(path, document.path)) deleteDocument(document.id);
      }
      const moveFolder = sqlite.prepare("UPDATE document_folders SET path = ? WHERE id = ?");
      const moveDocument = sqlite.prepare("UPDATE documents SET path = ? WHERE id = ?");
      for (const row of moving) {
        const rel = relative(from, row.path);
        if (rel.startsWith("..") || isAbsolute(rel)) continue;
        moveFolder.run(rel ? join(path, rel) : path, row.id);
        for (const document of sqlite.prepare("SELECT id, path FROM documents WHERE folder_id = ?").all(row.id) as Array<{ id: string; path: string }>) {
          const inner = relative(from, document.path);
          if (inner && !inner.startsWith("..") && !isAbsolute(inner)) moveDocument.run(join(path, inner), document.id);
        }
      }
      if (leftId) sqlite.prepare("INSERT INTO document_folders (id, user_id, path, created_at, project_id) VALUES (?, ?, ?, ?, ?)").run(leftId, userId, from, Date.now(), wall.projectId);
    })();
  } catch {
    return "failed";
  }
  recordPlace(wall.id, path);
  if (leftId) recordPlace(leftId, from);
  for (const row of moving) forgetGrantedPlace(row.path);
  forgetGrantedPlace(path);
  forgetGrantedPlace(from);
  forgetWall(userId, wall.id);
  return null;
}

/// The deepest granted folder holding a file, now — however the walk that
/// found it, or Spotlight, wrote it (folderLayout's spellings).
function holderOf(userId: string, path: string): string | null {
  const folders = sqlite.prepare("SELECT id, path, project_id AS projectId FROM document_folders WHERE user_id = ?").all(userId) as FolderRow[];
  const layout = folderLayout(folders);
  // The deepest; between two grants of one place, the one walled off itself.
  return (
    layout.placed
      .filter((folder) => layout.spellings.get(folder.id)!.some((spelt) => sameOrInside(spelt, path)))
      .sort((a, b) => b.place.real.length - a.place.real.length || Number(!!b.projectId) - Number(!!a.projectId))[0]?.id ?? null
  );
}

/// The places of these folders asked of the system without holding the
/// event loop: the index pass does so before it walks them.
async function warmGrantedPlaces(paths: string[]): Promise<void> {
  await Promise.all(
    paths
      .filter((path) => !placeCache.has(path))
      .map(async (path) => {
        const place = await pathPlaceAsync(path).catch(() => null);
        if (place && !placeCache.has(path)) placeCache.set(path, { place, ids: await identitiesOnAsync(place.real), at: Date.now() });
      }),
  );
}

/// One file read into the index now, outside a pass (a file Spotlight found
/// for a question before the indexer reached it): the same as the pass
/// would do, so the pass finds it up to date. The caller checks the grant.
export function indexOnDemand(userId: string, folderId: string, path: string): Promise<void> {
  return indexFile(userId, folderId, path);
}

async function indexFile(userId: string, given: string, path: string): Promise<void> {
  // The deepest granted folder holding it now, not the one the pass started
  // with: a folder granted meanwhile inside it (an isolated project's, which
  // no other conversation may search) takes its files at once.
  const folderId = holderOf(userId, path) ?? given;
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  const mtimeMs = Math.floor(info.mtimeMs);

  const [existing] = db
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.path, path)))
    .all();
  let sections: Awaited<ReturnType<typeof extractSections>> | null = null;
  if (existing && existing.size === info.size && existing.mtimeMs === mtimeMs && existing.folderId === folderId) {
    // Unchanged; a PDF is read again once scans are read here, and kept as
    // it was unless a page of it is read by OCR.
    if (!rereading.has(userId) || extname(path).toLowerCase() !== ".pdf" || existing.status === "error") return;
    try {
      sections = await extractSections(path);
    } catch {
      return;
    }
    if (!sections.some((section) => section.ocr)) return;
  }
  // Never across another project's walls, wherever they are now: what
  // Spotlight hands over is checked as the pass checks it.
  if (!mayIndex(userId, folderId, path, info.size, info.mtimeMs)) return;

  const id = existing?.id ?? generateId();
  let status = "indexed";
  let error: string | null = null;
  let chunks: ReturnType<typeof chunkSections> = [];

  if (info.size > maxBytesFor(path)) {
    status = "error";
    error = "too_large";
  } else {
    try {
      chunks = chunkSections(sections ?? (await extractSections(path)));
      if (chunks.length === 0) status = "empty";
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message.slice(0, 200) : "extraction_failed";
    }
  }

  const insertChunk = sqlite.prepare(
    "INSERT INTO document_chunks (text, document_id, user_id, page, position) VALUES (?, ?, ?, ?, ?)",
  );
  const insertGrams = sqlite.prepare("INSERT INTO document_grams (rowid, grams, document_id) VALUES (?, ?, ?)");
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM document_labels WHERE document_id = ?").run(id);
    sqlite.prepare("DELETE FROM document_embeddings WHERE document_id = ?").run(id);
    sqlite.prepare("DELETE FROM document_grams WHERE document_id = ?").run(id);
    sqlite.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);
    for (const chunk of chunks) {
      const { lastInsertRowid } = insertChunk.run(chunk.text, id, userId, chunk.page, chunk.position);
      // Japanese, Chinese and Korean, by pairs of characters (cjk.ts).
      const grams = indexGrams(chunk.text);
      if (grams) insertGrams.run(lastInsertRowid, grams, id);
    }
    const values = {
      userId,
      folderId,
      path,
      name: basename(path),
      ext: extname(path).toLowerCase(),
      size: info.size,
      mtimeMs,
      status,
      error,
      chars: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
      indexedAt: new Date(),
    };
    if (existing) db.update(documents).set(values).where(eq(documents.id, id)).run();
    else db.insert(documents).values({ id, ...values }).run();
  })();
}

/// Whether a file may be read into folder `folderId`'s index now: not while
/// the folder waits (wallPlaces.ts pausedFor), nor when it lies in another
/// project's walled-off folder — by identity, or where one was found away
/// from its path —, nor when it is one of the documents of one away from its
/// path.
function mayIndex(userId: string, folderId: string, path: string, size: number, mtimeMs: number): boolean {
  const walls = wallPlaces(userId);
  if (!walls.length) return true;
  const rows = sqlite.prepare("SELECT id, path, project_id AS projectId FROM document_folders WHERE user_id = ?").all(userId) as FolderRow[];
  const project = folderLayout(rows).projectOf.get(folderId) ?? null;
  if (pausedFor(walls, project)) return false;
  if (foundWalls(walls, project).some((wall) => sameOrInside(wall, path))) return false;
  const keys = new Set(wallKeys(walls, project));
  if (keys.size) {
    for (let current = dirname(path); ; current = dirname(current)) {
      if (walledIdentity(keys, folderIdentity(current))) return false;
      if (dirname(current) === current) break;
    }
  }
  const prints = awayPrints(userId, walls, project);
  return !prints || !printMatch(prints, basename(path), size, mtimeMs);
}

function deleteDocument(id: string): void {
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM document_labels WHERE document_id = ?").run(id);
    sqlite.prepare("DELETE FROM document_embeddings WHERE document_id = ?").run(id);
    sqlite.prepare("DELETE FROM document_grams WHERE document_id = ?").run(id);
    sqlite.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);
    sqlite.prepare("DELETE FROM documents WHERE id = ?").run(id);
  })();
}

// ─── Search ─────────────────────────────────────────────────────────────────

export interface Passage {
  document_id: string;
  name: string;
  path: string;
  page: number | null;
  text: string;
  snippet: string;
  match?: "content" | "name" | "semantic";
  /// For a semantic match: its cosine with the question (vectors are normalised).
  cosine?: number;
}

const MAX_PASSAGES_PER_DOCUMENT = 3;

/// Best passages for a question, best first (see selectPassages).
export function searchPassages(userId: string, question: string, limit = 6, folderIds?: string[]): Passage[] {
  if (folderIds?.length === 0) return [];
  const scope = folderIds ? ` AND d.folder_id IN (${folderIds.map(() => "?").join(",")})` : "";
  const match = buildMatchQuery(question);
  const grams = buildGramsQuery(question);
  if (!match && !grams) return [];

  let rows: Array<Passage & { score: number }>;
  try {
    rows = grams
      ? gramRows(userId, match, grams, queryTerms(question), scope, folderIds ?? [], limit * 4)
      : sqlite
      .prepare(
        `SELECT c.document_id, d.name, d.path, c.page, c.text,
                snippet(document_chunks, 0, '', '', '…', 24) AS snippet,
                bm25(document_chunks) AS score
           FROM document_chunks c
           JOIN documents d ON d.id = c.document_id
          WHERE document_chunks MATCH ? AND c.user_id = ? ${scope}
          ORDER BY score
          LIMIT ?`,
      )
      .all(match, userId, ...(folderIds ?? []), limit * 4) as Array<Passage & { score: number }>;
  } catch {
    return []; // a malformed MATCH expression must not break a chat turn
  }
  const terms = queryTerms(question);
  const content = selectPassages(rows, terms, limit, MAX_PASSAGES_PER_DOCUMENT).map(({ score: _score, ...passage }) => ({ ...passage, match: "content" as const }));
  // No reindex or schema migration needed: existing libraries benefit too.
  // Only granted-folder-relative paths count, never the user's home path.
  const candidates = sqlite.prepare(`SELECT d.id, d.name, d.path, f.path AS folder_path
    FROM documents d JOIN document_folders f ON f.id = d.folder_id AND f.user_id = d.user_id
    WHERE d.user_id = ? AND d.status = 'indexed' ${scope}`).all(userId, ...(folderIds ?? [])) as Array<{ id: string; name: string; path: string; folder_path: string }>;
  const named = candidates.map((doc) => ({ ...doc, score: metadataScore(doc.name, join(basename(doc.folder_path), relative(doc.folder_path, doc.path)), terms) }))
    .filter((doc) => doc.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  const names: Passage[] = [];
  for (const doc of named) {
    // Prefer the relevant body passage if it also matches this named file.
    const relevant = content.find((passage) => passage.document_id === doc.id);
    if (relevant) { names.push(relevant); continue; }
    const first = sqlite.prepare("SELECT page, text FROM document_chunks WHERE document_id = ? AND user_id = ? ORDER BY rowid LIMIT 1").get(doc.id, userId) as { page: number | null; text: string } | undefined;
    if (first) names.push({ document_id: doc.id, name: doc.name, path: doc.path, ...first, snippet: first.text.slice(0, 240), match: "name" });
  }
  // File-name hits first, then content, then folder-only hits. Keep diversity
  // without letting a folder name push all relevant body passages away.
  const direct = new Set(named.filter((doc) => metadataScore(doc.name, "", terms) > 0).map((doc) => doc.id));
  const combined = [...names.filter((passage) => direct.has(passage.document_id)), ...content, ...names];
  const seen = new Set<string>();
  return combined.filter((passage) => {
    const key = `${passage.document_id}:${passage.page}:${passage.text}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, limit);
}

/// Passages for a question with Japanese, Chinese or Korean words: found by
/// their pairs in document_grams, and by the other words in
/// document_chunks, a passage's two BM25 scores added (both negative, lower
/// is better). A passage sharing a single pair with a longer word (« 通知 »
/// of « 解除通知期 ») holds none of the question's words: left out. The
/// question without those scripts never comes here: its search is the one
/// above, as it was.
function gramRows(userId: string, match: string | null, grams: string, terms: string[], scope: string, folderIds: string[], limit: number): Array<Passage & { score: number }> {
  const hits = match
    ? `SELECT rowid AS id, bm25(document_chunks) AS s FROM document_chunks WHERE document_chunks MATCH ?
        UNION ALL SELECT rowid AS id, bm25(document_grams) AS s FROM document_grams WHERE document_grams MATCH ?`
    : "SELECT rowid AS id, bm25(document_grams) AS s FROM document_grams WHERE document_grams MATCH ?";
  const rows = sqlite
    .prepare(
      `WITH hits AS MATERIALIZED (${hits})
       SELECT c.document_id, d.name, d.path, c.page, c.text, SUM(h.s) AS score
         FROM hits h
         JOIN document_chunks c ON c.rowid = h.id
         JOIN documents d ON d.id = c.document_id
        WHERE c.user_id = ? ${scope}
        GROUP BY h.id
        ORDER BY score
        LIMIT ?`,
    )
    .all(...(match ? [match, grams] : [grams]), userId, ...folderIds, limit) as Array<Omit<Passage, "snippet"> & { score: number }>;
  const words = terms.filter(hasCjk);
  return rows.filter((row) => termsFound(row.text, terms) > 0).map((row) => ({ ...row, snippet: cjkSnippet(row.text, words) }));
}

/** Paginated metadata only; every row is scoped to the caller and a current grant. */
export function listDocuments(userId: string, folderId: string, offset = 0, limit = 100, sort: "name" | "modified" | "category" = "name") {
  const order = sort === "modified" ? "d.mtime_ms DESC," : sort === "category" ? "COALESCE(l.category,'zzz')," : "";
  const files = sqlite.prepare(`SELECT d.id, d.name, d.path, d.status, d.chars, d.indexed_at, d.mtime_ms AS modified_at, l.category
    FROM documents d JOIN document_folders f ON f.id = d.folder_id AND f.user_id = d.user_id
    LEFT JOIN document_labels l ON l.document_id=d.id AND EXISTS(SELECT 1 FROM document_semantic_settings s WHERE s.user_id=d.user_id AND s.enabled=1)
    WHERE d.user_id = ? AND d.folder_id = ? ORDER BY ${order} d.name COLLATE NOCASE, d.id LIMIT ? OFFSET ?`)
    .all(userId, folderId, limit, offset);
  const count = sqlite.prepare("SELECT COUNT(*) AS total FROM documents WHERE user_id = ? AND folder_id = ?").get(userId, folderId) as { total: number };
  return { files, total: count.total, offset, limit };
}

export function hasIndexedDocuments(userId: string): boolean {
  const row = sqlite.prepare("SELECT 1 FROM documents WHERE user_id = ? AND status = 'indexed' LIMIT 1").get(userId);
  return row !== undefined;
}

/// True when `path` is a file this user's index knows about AND lies, on
/// disk now, inside the folder it was indexed from — a folder the person
/// still grants, and that folderRisk does not refuse on this machine. The
/// desktop asks before opening a cited document, so a forged path cannot
/// be used to open arbitrary files, nor an indexed row whose folder was
/// taken back, nor a file a symbolic link moved out of its folder.
export function isIndexedPath(userId: string, path: string): boolean {
  if (typeof path !== "string" || !path || path.includes("\0")) return false;
  const row = sqlite
    .prepare("SELECT f.path AS folder FROM documents d JOIN document_folders f ON f.id = d.folder_id AND f.user_id = d.user_id WHERE d.user_id = ? AND d.path = ? LIMIT 1")
    .get(userId, path) as { folder: string } | undefined;
  if (!row) return false;
  let folder: string;
  let file: string;
  let home: string;
  try {
    folder = realpathSync(row.folder);
    file = realpathSync(path);
    home = realpathSync(homedir());
  } catch {
    return false;
  }
  if (folderRisk(folder, home, process.platform, folder === home) !== null) return false;
  const inside = relative(folder, file);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return false;
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Current grants and caller ownership are checked before reading index metadata. */
export function browseDocuments(userId: string, folderId: string, directory = "", offset = 0) {
  const folder = sqlite.prepare("SELECT path FROM document_folders WHERE user_id = ? AND id = ?").get(userId, folderId) as {path: string} | undefined;
  if (!folder) return null;
  const files = sqlite.prepare("SELECT id, name, path, status, mtime_ms AS modified_at FROM documents WHERE user_id = ? AND folder_id = ?").all(userId, folderId) as IndexedEntry[];
  const entries = indexedDirectory(folder.path, files, directory);
  return {entries: entries.slice(offset, offset + 100), total: entries.length, next_offset: offset + 100 < entries.length ? offset + 100 : null, directory};
}
