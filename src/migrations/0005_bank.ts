import type Database from "better-sqlite3-multiple-ciphers";

// Migration 5 — « Banque » (Jimmy, 04/10/2026: « import de relevés pour la
// banque »): the statements the person imports, kept on this computer
// (src/bank/). Named after the account's own tables where they mean the same
// thing (twoody-backend bank_accounts, bank_transactions: name, iban,
// currency, product, status, balance_at, ref, booking_date, value_date,
// info, creditor_name, debtor_name, code), with the convergence's rules
// (docs/schema-convergence.md): UUIDs, dates in ms, JSON without « _json »,
// and amounts in cents (the account keeps floats).
//
// Local only, not in schema/contract.json: the account's tables differ in
// shape (float amounts, a bank_authorization_id that is required, dates as
// `date`) and no statement goes to the account — nothing about the bank
// leaves this computer. To add the day the cloud reads the same tables.
//
//   bank_accounts             one per account found in the statements; the
//                             last digits of a number they mask (« ****4521 »)
//                             to offer it again, never to file one alone
//   bank_imports              one per statement imported: file name, format,
//                             period, counts, the balance it gave
//   bank_transactions         one per transaction, its fingerprint unique per
//                             account (bank/parse.ts fingerprintsOf): an
//                             overlapping statement adds only what is new
//   bank_transaction_imports  which imports held each transaction: deleting
//                             one import keeps what another one also held
//   bank_category_rules       the person's own categories, by counterparty

export function bank(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      bank_name TEXT,
      ref TEXT,
      iban TEXT,
      number_tail TEXT,
      currency TEXT NOT NULL DEFAULT 'EUR',
      product TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      balance_cents INTEGER,
      balance_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bank_accounts_user ON bank_accounts (user_id);

    CREATE TABLE IF NOT EXISTS bank_imports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
      file_name TEXT NOT NULL,
      format TEXT NOT NULL,
      checksum TEXT,
      period_start INTEGER,
      period_end INTEGER,
      transactions_count INTEGER NOT NULL DEFAULT 0,
      added_count INTEGER NOT NULL DEFAULT 0,
      duplicates_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      balance_cents INTEGER,
      balance_at INTEGER,
      mapping TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bank_imports_user ON bank_imports (user_id, created_at);
    CREATE INDEX IF NOT EXISTS bank_imports_account ON bank_imports (bank_account_id);

    CREATE TABLE IF NOT EXISTS bank_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
      import_id TEXT REFERENCES bank_imports(id),
      booking_date INTEGER NOT NULL,
      value_date INTEGER,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      info TEXT NOT NULL,
      comment TEXT,
      creditor_name TEXT,
      debtor_name TEXT,
      code TEXT,
      ref TEXT,
      category TEXT NOT NULL DEFAULT 'other',
      category_source TEXT NOT NULL DEFAULT 'rule',
      fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_fingerprint ON bank_transactions (bank_account_id, fingerprint);
    CREATE INDEX IF NOT EXISTS bank_transactions_user_date ON bank_transactions (user_id, booking_date);

    CREATE TABLE IF NOT EXISTS bank_transaction_imports (
      transaction_id TEXT NOT NULL REFERENCES bank_transactions(id),
      import_id TEXT NOT NULL REFERENCES bank_imports(id),
      PRIMARY KEY (transaction_id, import_id)
    );
    CREATE INDEX IF NOT EXISTS bank_transaction_imports_import ON bank_transaction_imports (import_id);

    CREATE TABLE IF NOT EXISTS bank_category_rules (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      match TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS bank_category_rules_match ON bank_category_rules (user_id, match);
  `);
}
