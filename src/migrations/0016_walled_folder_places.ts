import type Database from "better-sqlite3-multiple-ciphers";

// Migration 16 — where a walled-off project's folder is, beyond its path
// (Jimmy, 16/10/2026: a walled-off folder renamed or moved outside Twoody,
// docs/projects-design.md §8 « Moved outside Twoody »; src/documents/wallPlaces.ts).
//
//   document_folders.identity  « device:file number » of a walled-off project's
//                              folder (project_id set) as last seen at its
//                              path: met under another name or in another
//                              place, it is still that folder — walled there,
//                              and followed
//   document_folders.volume    the folder that is the root of the disk holding
//                              it, as last seen (« /Volumes/NAS », « Z:\ »):
//                              when that disk is not connected, the folder is
//                              out of reach rather than lost
//
// Both are written by the server when the folder is linked to its project and
// again whenever its path is found to hold it; NULL for every other folder.
// Local only, like the whole table (schema/contract.json `local_only`): a
// walled-off project's folder never leaves this computer.

export function walledFolderPlaces(sqlite: Database.Database) {
  const columns = new Set((sqlite.prepare("PRAGMA table_info(document_folders)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has("identity")) sqlite.exec("ALTER TABLE document_folders ADD COLUMN identity TEXT");
  if (!columns.has("volume")) sqlite.exec("ALTER TABLE document_folders ADD COLUMN volume TEXT");
}
