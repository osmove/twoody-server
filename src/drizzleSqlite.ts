import type { Database } from "better-sqlite3";
import { BetterSQLiteSession } from "drizzle-orm/better-sqlite3/session";
import { BaseSQLiteDatabase, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

// drizzle-orm's own better-sqlite3 driver (`drizzle-orm/better-sqlite3`)
// imports the `better-sqlite3` package at load time, to open a database from
// a path. This server opens its database itself with
// better-sqlite3-multiple-ciphers (dbOpen.ts) and has no `better-sqlite3`, so
// the database object is built here the way that driver builds it for a
// client it is handed: no schema, no logger.
export function drizzle(client: Database) {
  const dialect = new SQLiteSyncDialect();
  const session = new BetterSQLiteSession(client, dialect, undefined);
  return new BaseSQLiteDatabase("sync", dialect, session, undefined);
}
