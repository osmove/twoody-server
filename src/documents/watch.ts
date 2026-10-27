import { watch, type FSWatcher } from "node:fs";
import { basename, extname } from "node:path";
import { sqlite } from "../db.js";
import { capabilityOn } from "../localCapabilities.js";
import { isSupported } from "./extract.js";
import { skipDirectory } from "./folderNames.js";
import { onIndexPass, reindex } from "./library.js";
import { within } from "./samePath.js";
import { skipFile } from "./walk.js";

// Watching the granted folders (docs/project-overview-design.md §2): a
// document added, changed, renamed or removed is noticed by itself, not only
// at launch or with « Vérifier les changements ». The watch only says when;
// what is read is the ordinary pass's business (library.ts reindex: a file
// read again only when its size or date changed, the walls as before).
//
// Each granted folder not inside another granted one is watched recursively
// (FSEvents on macOS, ReadDirectoryChangesW on Windows — OneDrive's folders
// included —, inotify on Linux). A change waits until its folder has been
// quiet for a while (Office writes temporary files, a sync client writes in
// bursts), and passes started by the watch are spaced out. What a watch
// misses — a network drive, a watch the system refused (too many folders on
// Linux) — the catch-up pass finds, every half hour.

export const QUIET_MS = 10_000;
/// Between two passes the watch started, for one person.
export const MIN_GAP_MS = 60_000;
let quietMs = QUIET_MS;
let gapMs = MIN_GAP_MS;
export const CATCH_UP_MS = 30 * 60_000;

/// Whether a change at `relative` (as the watch names it, inside a granted
/// folder) may concern the index: never a hidden name, an Office lock, a
/// folder never entered (Library, node_modules…) or a file that is not a
/// document. A name without extension may be a folder renamed or removed.
export function concernsIndex(relative: string | null): boolean {
  if (!relative) return true;
  const parts = relative.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return true;
  const name = parts[parts.length - 1]!;
  if (parts.slice(0, -1).some((part) => skipDirectory(part))) return false;
  if (skipFile(name) || /\.(?:tmp|temp|crdownload|part|download|partial|swp)$/i.test(name) || /^~/.test(name)) return false;
  if (!extname(name)) return !skipDirectory(name);
  return isSupported(name);
}

interface Watched {
  watcher: FSWatcher;
  userId: string;
}

const watched = new Map<string, Watched>();
const pending = new Map<string, NodeJS.Timeout>();
const lastPass = new Map<string, number>();
let started = false;
let catchUp: NodeJS.Timeout | null = null;
type Watcher = (path: string, listener: (event: string, name: string | Buffer | null) => void) => FSWatcher;
let watcherFor: Watcher = (path, listener) => watch(path, { recursive: true, persistent: false }, listener);
let passFor: (userId: string) => Promise<unknown> = reindex;

/// The person's granted folders worth a watch of their own: not inside
/// another granted folder (whose recursive watch sees them already).
export function watchRoots(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const path of sorted) if (!roots.some((root) => within(root, path))) roots.push(path);
  return roots;
}

/// A change seen: a pass once the person's folders have been quiet for a
/// while, and not sooner than MIN_GAP_MS after the last one the watch started.
function changed(userId: string) {
  const waiting = pending.get(userId);
  if (waiting) clearTimeout(waiting);
  const since = Date.now() - (lastPass.get(userId) ?? 0);
  const timer = setTimeout(() => {
    pending.delete(userId);
    if (!started || !capabilityOn(userId, "documents")) return;
    lastPass.set(userId, Date.now());
    void passFor(userId).catch(() => undefined);
  }, Math.max(quietMs, gapMs - since));
  timer.unref?.();
  pending.set(userId, timer);
}

/// The watches brought in line with the person's folders now: a watch for
/// each root, none for a folder taken back, none at all with Documents off.
export function syncWatches(userId: string): void {
  if (!started) return;
  const on = capabilityOn(userId, "documents");
  const paths = on ? (sqlite.prepare("SELECT path FROM document_folders WHERE user_id = ?").all(userId) as Array<{ path: string }>).map((row) => row.path) : [];
  const roots = new Set(watchRoots(paths));
  for (const [path, entry] of watched) {
    if (entry.userId !== userId || roots.has(path)) continue;
    entry.watcher.close();
    watched.delete(path);
  }
  for (const root of roots) {
    if (watched.has(root)) continue;
    try {
      const watcher = watcherFor(root, (_event, name) => {
        const relative = typeof name === "string" ? name : name ? name.toString() : null;
        if (concernsIndex(relative)) changed(userId);
      });
      // A watch the system drops (the folder removed, a network drive gone,
      // too many watches): closed; the catch-up pass and the next sync try
      // again.
      watcher.on("error", () => {
        watcher.close();
        if (watched.get(root)?.watcher === watcher) watched.delete(root);
      });
      watched.set(root, { watcher, userId });
    } catch {
      // Refused (ENOSPC, EMFILE, a drive out of reach): the catch-up pass covers it.
    }
  }
}

/// What is watched now, for the screens and the tests: the folders' names only.
export function watchedFolders(userId: string): string[] {
  return [...watched.entries()].filter(([, entry]) => entry.userId === userId).map(([path]) => basename(path) || path);
}

/// Watching on a running server (index.ts); a test's app watches when asked.
export function startWatching(options: { catchUpMs?: number; quietMs?: number; gapMs?: number; watcher?: Watcher; pass?: (userId: string) => Promise<unknown> } = {}) {
  started = true;
  quietMs = options.quietMs ?? QUIET_MS;
  gapMs = options.gapMs ?? MIN_GAP_MS;
  if (options.watcher) watcherFor = options.watcher;
  if (options.pass) passFor = options.pass;
  const users = () => (sqlite.prepare("SELECT id FROM users").all() as Array<{ id: string }>).map((row) => row.id);
  for (const id of users()) syncWatches(id);
  const every = options.catchUpMs ?? CATCH_UP_MS;
  const tick = () => {
    catchUp = setTimeout(() => {
      for (const id of users()) {
        if (capabilityOn(id, "documents")) void passFor(id).catch(() => undefined);
        else syncWatches(id);
      }
      tick();
    }, every);
    catchUp.unref?.();
  };
  tick();
  return {
    stop() {
      started = false;
      if (catchUp) clearTimeout(catchUp);
      catchUp = null;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      for (const entry of watched.values()) entry.watcher.close();
      watched.clear();
      lastPass.clear();
      watcherFor = (path, listener) => watch(path, { recursive: true, persistent: false }, listener);
      passFor = reindex;
    },
  };
}

// After every pass — folders granted or taken back, Documents switched on or
// off — the watches follow.
onIndexPass((userId) => syncWatches(userId));
