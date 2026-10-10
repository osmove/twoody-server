import type Database from "better-sqlite3";
import { indexGrams } from "../documents/cjk.js";

// Migration 9 — Japanese, Chinese and Korean in the documents' keyword
// search (10/10/2026: « 解約予告期間 », « 解除通知期 » and « 해지 예고 기간 »
// found nothing although the words were in the files; src/documents/cjk.ts
// says why and how).
//
//   document_grams   an FTS5 index of the passages that hold those scripts,
//                    as their pairs of characters; its rowid is the
//                    passage's rowid in document_chunks. Written with the
//                    passage (library.ts), never on its own.
//
// Derived data only: the passages already indexed get their pairs here,
// from the text document_chunks holds — no file is read again, nothing the
// person made is touched. The rows are read by rowid, a page at a time
// (better-sqlite3 runs no statement while another one is being iterated).

const PAGE = 500;

export function documentGrams(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS document_grams USING fts5(
      grams,
      document_id UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 0'
    );
  `);
  fillDocumentGrams(sqlite);
}

/// Indexes again, from document_chunks, the pairs of every passage that
/// has some: from scratch (a rebuild of derived data). Returns how many
/// passages hold them.
export function fillDocumentGrams(sqlite: Database.Database): number {
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'document_chunks'").get()) return 0;
  sqlite.exec("DELETE FROM document_grams");
  const page = sqlite.prepare("SELECT rowid AS id, document_id, text FROM document_chunks WHERE rowid > ? ORDER BY rowid LIMIT ?");
  const insert = sqlite.prepare("INSERT INTO document_grams (rowid, grams, document_id) VALUES (?, ?, ?)");
  let after = 0;
  let filled = 0;
  for (;;) {
    const rows = page.all(after, PAGE) as Array<{ id: number; document_id: string; text: string | null }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      const grams = indexGrams(row.text ?? "");
      if (grams) {
        insert.run(row.id, grams, row.document_id);
        filled += 1;
      }
    }
    after = rows[rows.length - 1]!.id;
  }
  return filled;
}
