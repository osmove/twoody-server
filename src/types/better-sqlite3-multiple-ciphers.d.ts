// better-sqlite3-multiple-ciphers is better-sqlite3 built with SQLite3
// Multiple Ciphers (the encryption of the local database, dbCipher.ts): the
// same API, plus `key`/`rekey`, which this server reaches through PRAGMAs
// only. Its own index.d.ts is not reachable through its package.json
// "exports", so the module is typed as better-sqlite3 (@types/better-sqlite3,
// which drizzle-orm's types read too).
declare module "better-sqlite3-multiple-ciphers" {
  import Database = require("better-sqlite3");
  export = Database;
}
