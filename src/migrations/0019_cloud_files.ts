import type Database from "better-sqlite3-multiple-ciphers";

// Migration 19 — files only online (Jimmy, 28/10/2026; src/documents/cloudFiles.ts):
// a granted folder in OneDrive, iCloud Drive or another cloud sync may hold
// files whose content is not on the computer; reading them to index them
// would download them without a word. They are left unread (`documents.status`
// « online_only ») unless the person chose, for that folder, to have them
// downloaded and read: `document_folders.cloud_files` « read » (NULL: left
// unread). Local only, as the folders are (schema/contract.json `local_only`).

export function cloudFiles(sqlite: Database.Database) {
  const columns = (sqlite.prepare("PRAGMA table_info(document_folders)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!columns.includes("cloud_files")) sqlite.exec("ALTER TABLE document_folders ADD COLUMN cloud_files TEXT");
}
