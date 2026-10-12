import type Database from "better-sqlite3-multiple-ciphers";

// Migration 3 — where a conversation's title comes from (04/10/2026: titles
// written by the model, as ChatGPT and Claude do, src/discussionTitles.ts):
//
//   question  the first ~60 characters of the first question, given at once
//             so that the list shows something; the model may replace it
//   model     written by the model after the first answer
//   given     set on purpose: brought with a synchronised conversation
//             (a title another device sealed), a future rename
//
// Only a « question » title is ever replaced by the model, so a title the
// person or another device gave is never overwritten. Conversations from
// before keep NULL: their first answer is long past, nothing replaces them.
// Local only (not in schema/contract.json): the account writes no titles.

export function titleSource(sqlite: Database.Database) {
  const columns = (sqlite.prepare("PRAGMA table_info(discussions)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!columns.includes("title_source")) sqlite.exec("ALTER TABLE discussions ADD COLUMN title_source TEXT");
}
