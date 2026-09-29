import { opendir, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { isSupported } from "./extract.js";

// How a granted folder is walked, and what is never read inside it.
//
// A folder the person picked, their Downloads or their whole home folder
// all go through the same walk. What it leaves out matters most for the
// home folder: application data, keys and credentials, developer trees,
// caches, photo and music libraries and applications are not documents,
// weigh a great deal, or both. The same list is shown to the person
// before they grant their home folder (GET /local_documents/personal).

/// Folder names never entered, compared without case. `Library` is the
/// Mac's application data (keychains, mail, messages), `AppData` is
/// Windows's; iCloud Drive lives under ~/Library and is granted on its
/// own (folderRisk lets that one folder through).
export const SKIPPED_DIRECTORIES = [
  "Library",
  "AppData",
  "Keychains",
  "Applications",
  "node_modules",
  "bower_components",
  "__pycache__",
  "site-packages",
  "Cache",
  "Caches",
  "snap",
  "__MACOSX",
  "$RECYCLE.BIN",
  "System Volume Information",
  "Windows",
  "Program Files",
  "Program Files (x86)",
  "ProgramData",
] as const;

/// Folders the Mac shows as a single file — an application, a photo or
/// music library, a project package — by their extension: their insides
/// are the program's own files, not the person's documents.
export const SKIPPED_BUNDLES = [
  ".app",
  ".appex",
  ".framework",
  ".bundle",
  ".plugin",
  ".kext",
  ".photoslibrary",
  ".photolibrary",
  ".migratedphotolibrary",
  ".aplibrary",
  ".musiclibrary",
  ".tvlibrary",
  ".imovielibrary",
  ".fcpbundle",
  ".logicx",
  ".band",
  ".lrdata",
  ".xcarchive",
] as const;

const skippedDirectories = new Set(SKIPPED_DIRECTORIES.map((name) => name.toLowerCase()));
const skippedBundles = new Set<string>(SKIPPED_BUNDLES);

/// A folder the walk does not enter. Hidden folders (.ssh, .gnupg, .aws,
/// .git, .cache, .Trash…) are never entered either.
export function skipDirectory(name: string): boolean {
  return name.startsWith(".") || skippedDirectories.has(name.toLowerCase()) || skippedBundles.has(extname(name).toLowerCase());
}

const CREDENTIAL_NAME = /^(?:credentials|secrets?|tokens?|passwords?|service[-_]?account)(?:[.-]|$)/i;

/// A file the walk does not read, supported or not: hidden files, Office
/// lock files (~$…) and files named like credentials.
export function skipFile(name: string): boolean {
  return name.startsWith(".") || name.startsWith("~$") || CREDENTIAL_NAME.test(name);
}

export const MAX_FILES_PER_FOLDER = 20_000;
/// Folders the system refused, kept for the screen to explain: a few are
/// enough to name, the rest is noise.
const MAX_DENIED = 10;

export interface Walk {
  files: string[];
  limited: boolean;
  /// Folders that could not be read for lack of permission (macOS asks
  /// before an app reads Desktop, Documents, Downloads or iCloud Drive).
  denied: string[];
}

export function permissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

export async function walk(root: string, maxFiles = MAX_FILES_PER_FOLDER): Promise<Walk> {
  const files: string[] = [];
  const denied: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < maxFiles) {
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
      if (entry.isDirectory()) {
        if (!skipDirectory(entry.name)) pending.push(path);
      } else if (entry.isFile() && !skipFile(entry.name) && isSupported(path)) {
        files.push(path);
        if (files.length >= maxFiles) return { files, limited: true, denied };
      }
    }
  }
  return { files, limited: false, denied };
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
