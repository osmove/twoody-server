import { extname } from "node:path";

// The folder names no walk, browser or picker enters: application data,
// developer trees, caches, libraries and applications, and anything
// hidden. Pure (no import but node:path) so the Desktop compiles the same
// rules (twoody-desktop scripts/sync-vault.mjs copies it): the iPhone's
// folder picker of Twoody Code (twoody-desktop src/main/code/remoteFolders.ts)
// hides exactly what the document walk never enters.

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
