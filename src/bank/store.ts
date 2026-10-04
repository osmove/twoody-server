import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";
import { categorize, counterpartyKey, counterpartyOf, isBankCategory, plainLabel, categoryFrom, type BankCategory, type CategoryRule } from "./categories.js";
import { checksumOf, fingerprintsOf, parseStatement, StatementError, type ParseOptions, type ParseResult, type ParsedStatement, type ParsedTransaction, type StatementAccount } from "./parse.js";

// « Banque »: what the person imported, kept in this computer's database
// (migration 5). An account is found again by the number its statements
// give (OFX ACCTID, a number or an IBAN above a CSV's table); a transaction
// by its fingerprint (bank/parse.ts): importing a statement that overlaps
// another adds only what is new. Nothing here leaves this computer.

export class BankError extends Error {
  constructor(public code: "unknown_account" | "unknown_import" | "unknown_transaction" | "invalid") {
    super(code);
  }
}

interface AccountRow {
  id: string;
  user_id: string;
  name: string;
  bank_name: string | null;
  ref: string | null;
  iban: string | null;
  number_tail: string | null;
  currency: string;
  product: string | null;
  status: string;
  balance_cents: number | null;
  balance_at: number | null;
  created_at: number;
  updated_at: number;
}

interface TransactionRow {
  id: string;
  bank_account_id: string;
  import_id: string | null;
  booking_date: number;
  value_date: number | null;
  amount_cents: number;
  currency: string;
  info: string;
  comment: string | null;
  creditor_name: string | null;
  debtor_name: string | null;
  code: string | null;
  ref: string | null;
  category: string;
  category_source: string;
  created_at: number;
}

export const isoDay = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null);

/// « •••• 4521 »: enough to tell two accounts apart, never the number.
export function numberHint(account: { ref?: string | null; iban?: string | null; tail?: string | null; number_tail?: string | null }): string | null {
  const digits = (account.iban ?? account.ref ?? "").replace(/[^A-Za-z0-9]/g, "");
  if (digits.length >= 4) return `•••• ${digits.slice(-4)}`;
  const tail = account.tail ?? account.number_tail;
  return tail ? `•••• ${tail.slice(-4)}` : null;
}

const counterpartyOfRow = (row: Pick<TransactionRow, "creditor_name" | "debtor_name" | "info">) => row.creditor_name ?? row.debtor_name ?? counterpartyOf(row.info);

// ── Accounts ──────────────────────────────────────────────────────────────

export interface BankAccountView {
  id: string;
  name: string;
  bank_name: string | null;
  number_hint: string | null;
  currency: string;
  product: string | null;
  /// The last balance a statement gave, and its day (YYYY-MM-DD).
  balance_cents: number | null;
  balance_at: string | null;
  /// The days its imported transactions cover.
  first_date: string | null;
  last_date: string | null;
  transactions: number;
  imports: number;
  last_import_at: number | null;
}

export function hasBankAccounts(userId: string): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM bank_accounts WHERE user_id = ? AND status = 'active' LIMIT 1").get(userId));
}

export function listAccounts(userId: string): BankAccountView[] {
  const rows = sqlite.prepare(`
    SELECT a.*,
      (SELECT MIN(t.booking_date) FROM bank_transactions t WHERE t.bank_account_id = a.id) AS first_date,
      (SELECT MAX(t.booking_date) FROM bank_transactions t WHERE t.bank_account_id = a.id) AS last_date,
      (SELECT COUNT(*) FROM bank_transactions t WHERE t.bank_account_id = a.id) AS transactions,
      (SELECT COUNT(*) FROM bank_imports i WHERE i.bank_account_id = a.id) AS imports,
      (SELECT MAX(i.created_at) FROM bank_imports i WHERE i.bank_account_id = a.id) AS last_import_at
    FROM bank_accounts a WHERE a.user_id = ? AND a.status = 'active' ORDER BY a.name COLLATE NOCASE, a.created_at
  `).all(userId) as Array<AccountRow & { first_date: number | null; last_date: number | null; transactions: number; imports: number; last_import_at: number | null }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    bank_name: row.bank_name,
    number_hint: numberHint(row),
    currency: row.currency,
    product: row.product,
    balance_cents: row.balance_cents,
    balance_at: isoDay(row.balance_at),
    first_date: isoDay(row.first_date),
    last_date: isoDay(row.last_date),
    transactions: row.transactions,
    imports: row.imports,
    last_import_at: row.last_import_at,
  }));
}

function accountOf(userId: string, id: string): AccountRow | null {
  return (sqlite.prepare("SELECT * FROM bank_accounts WHERE id = ? AND user_id = ? AND status = 'active'").get(id, userId) as AccountRow | undefined) ?? null;
}

export function renameAccount(userId: string, id: string, name: string): BankAccountView | null {
  const cleaned = name.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!cleaned) throw new BankError("invalid");
  const changed = sqlite.prepare("UPDATE bank_accounts SET name = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'active'").run(cleaned, Date.now(), id, userId);
  return changed.changes ? listAccounts(userId).find((account) => account.id === id) ?? null : null;
}

/// The account a statement is of: the same number or IBAN.
function matchAccount(userId: string, account: StatementAccount): AccountRow | null {
  const keys = [account.ref, account.iban].map((value) => value?.replace(/\s+/g, "").toUpperCase()).filter((value): value is string => !!value);
  if (!keys.length) return null;
  const rows = sqlite.prepare("SELECT * FROM bank_accounts WHERE user_id = ? AND status = 'active'").all(userId) as AccountRow[];
  return rows.find((row) => [row.ref, row.iban].some((value) => value && keys.includes(value.replace(/\s+/g, "").toUpperCase()))) ?? null;
}

/// The account to offer for a statement that does not give its number: the
/// one whose number ends with the digits it shows (« ****4521 »); else the
/// one imported into last — unless the statement names another kind of
/// account (« Livret A » after a « Compte de chèques »).
function suggestedAccount(userId: string, account: StatementAccount, lastUsed: string | null): string | null {
  const rows = sqlite.prepare("SELECT * FROM bank_accounts WHERE user_id = ? AND status = 'active'").all(userId) as AccountRow[];
  if (account.tail) {
    const ending = rows.filter((row) => row.number_tail === account.tail || (row.iban ?? row.ref ?? "").replace(/\s+/g, "").endsWith(account.tail!));
    if (ending.length === 1) return ending[0]!.id;
    if (ending.length === 0) return null;
  }
  const last = rows.find((row) => row.id === lastUsed);
  if (!last) return null;
  if (!account.name) return last.id;
  const named = plainLabel(account.name);
  const lastName = plainLabel(last.name);
  return lastName.includes(named) || named.includes(lastName) ? last.id : null;
}

/// The name a new account takes when the person gives none.
function defaultName(account: StatementAccount, fileName: string): string {
  if (account.name) return account.name;
  const hint = numberHint(account);
  if (account.bankName) return `${account.bankName}${hint ? ` ${hint}` : ""}`;
  if (hint) return hint;
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 60) || "—";
}

/// The balance an account shows: the latest a statement of it gave.
function refreshBalance(accountId: string) {
  const latest = sqlite.prepare("SELECT balance_cents, balance_at FROM bank_imports WHERE bank_account_id = ? AND balance_cents IS NOT NULL ORDER BY balance_at DESC, created_at DESC LIMIT 1").get(accountId) as { balance_cents: number; balance_at: number } | undefined;
  sqlite.prepare("UPDATE bank_accounts SET balance_cents = ?, balance_at = ?, updated_at = ? WHERE id = ?").run(latest?.balance_cents ?? null, latest?.balance_at ?? null, Date.now(), accountId);
}

// ── Imports ───────────────────────────────────────────────────────────────

export interface BankImportView {
  id: string;
  account_id: string;
  account_name: string;
  file_name: string;
  format: string;
  period_start: string | null;
  period_end: string | null;
  transactions: number;
  added: number;
  duplicates: number;
  skipped: number;
  /// The transactions no other import holds: those deleting it removes.
  own_transactions: number;
  created_at: number;
}

export function listImports(userId: string, ids?: string[]): BankImportView[] {
  const rows = sqlite.prepare(`
    SELECT i.*, a.name AS account_name,
      (SELECT COUNT(*) FROM bank_transaction_imports ti WHERE ti.import_id = i.id
        AND NOT EXISTS (SELECT 1 FROM bank_transaction_imports o WHERE o.transaction_id = ti.transaction_id AND o.import_id != ti.import_id)) AS own_transactions
    FROM bank_imports i JOIN bank_accounts a ON a.id = i.bank_account_id
    WHERE i.user_id = ? ORDER BY i.created_at DESC
  `).all(userId) as Array<{ id: string; bank_account_id: string; account_name: string; file_name: string; format: string; period_start: number | null; period_end: number | null; transactions_count: number; added_count: number; duplicates_count: number; skipped_count: number; own_transactions: number; created_at: number }>;
  return rows.filter((row) => !ids || ids.includes(row.id)).map((row) => ({
    id: row.id,
    account_id: row.bank_account_id,
    account_name: row.account_name,
    file_name: row.file_name,
    format: row.format,
    period_start: isoDay(row.period_start),
    period_end: isoDay(row.period_end),
    transactions: row.transactions_count,
    added: row.added_count,
    duplicates: row.duplicates_count,
    skipped: row.skipped_count,
    own_transactions: row.own_transactions,
    created_at: row.created_at,
  }));
}

function personRules(userId: string): CategoryRule[] {
  return (sqlite.prepare("SELECT match, category FROM bank_category_rules WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as Array<{ match: string; category: string }>)
    .filter((rule) => isBankCategory(rule.category))
    .map((rule) => ({ key: rule.match, category: rule.category as BankCategory }));
}

/// Who a transaction of a statement is with: the statement's own column,
/// else found in its label, else in its details.
function counterpartyOfParsed(transaction: ParsedTransaction): string | null {
  const named = transaction.counterparty?.replace(/\s+/g, " ").trim();
  return (named || counterpartyOf(transaction.label) || (transaction.details ? counterpartyOf(transaction.details) : null))?.slice(0, 120) ?? null;
}

export interface StatementPreview {
  account: {
    number_hint: string | null;
    name: string | null;
    bank_name: string | null;
    currency: string | null;
    product: string | null;
    /// The account of this computer it is of, found by its number.
    match: { id: string; name: string } | null;
    /// Whether the statement says which account it is of.
    identified: boolean;
    /// What the person is offered: the match, else — for a statement that
    /// does not say — the account imported into last; null: a new one.
    suggested_account_id: string | null;
    suggested_name: string;
  };
  period_start: string | null;
  period_end: string | null;
  transactions: number;
  new_transactions: number;
  duplicates: number;
  balance: { cents: number; at: string | null } | null;
  samples: Array<{ date: string | null; label: string; amount_cents: number; currency: string | null; category: BankCategory }>;
}

export interface ImportPreview {
  format: ParseResult["format"];
  sure: boolean;
  date_order: ParseResult["dateOrder"];
  date_ambiguous: boolean;
  skipped: number;
  statements: StatementPreview[];
  csv: ParseResult["csv"];
  /// The same file, imported before.
  already_imported: { id: string; file_name: string; created_at: number } | null;
}

export interface ImportOptions extends ParseOptions {
  fileName: string;
  /// The account chosen by the person (one statement only).
  accountId?: string | null;
  /// The name of a new account, as the person gave it.
  accountName?: string | null;
}

function withTransactions(parsed: ParseResult): ParsedStatement[] {
  return parsed.statements.filter((statement) => statement.transactions.length > 0);
}

export function previewImport(userId: string, text: string, options: ImportOptions): ImportPreview {
  const parsed = parseStatement(text, options);
  const rules = personRules(userId);
  const statements = withTransactions(parsed);
  const lastUsed = (sqlite.prepare("SELECT bank_account_id FROM bank_imports WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(userId) as { bank_account_id: string } | undefined)?.bank_account_id ?? null;
  const chosen = options.accountId ? accountOf(userId, options.accountId) : null;
  const checksum = checksumOf(text);
  const seen = sqlite.prepare("SELECT id, file_name, created_at FROM bank_imports WHERE user_id = ? AND checksum = ? ORDER BY created_at DESC LIMIT 1").get(userId, checksum) as { id: string; file_name: string; created_at: number } | undefined;
  const knownAlready = sqlite.prepare("SELECT 1 FROM bank_transactions WHERE bank_account_id = ? AND fingerprint = ?");
  return {
    format: parsed.format,
    sure: parsed.sure,
    date_order: parsed.dateOrder,
    date_ambiguous: parsed.dateAmbiguous,
    skipped: parsed.skipped,
    csv: parsed.csv,
    already_imported: seen ?? null,
    statements: (statements.length ? statements : parsed.statements.slice(0, 1)).map((statement) => {
      const match = matchAccount(userId, statement.account);
      const identified = Boolean(statement.account.ref || statement.account.iban);
      const target = (statements.length === 1 ? chosen : null) ?? match;
      const fingerprints = fingerprintsOf(statement.transactions);
      const known = target
        ? fingerprints.filter((fingerprint) => knownAlready.get(target.id, fingerprint)).length
        : 0;
      const newest = [...statement.transactions].sort((a, b) => b.bookingDate - a.bookingDate).slice(0, 6);
      return {
        account: {
          number_hint: numberHint(statement.account),
          name: statement.account.name,
          bank_name: statement.account.bankName,
          currency: statement.account.currency,
          product: statement.account.product,
          match: match ? { id: match.id, name: match.name } : null,
          identified,
          suggested_account_id: match?.id ?? (identified ? null : suggestedAccount(userId, statement.account, lastUsed)),
          suggested_name: defaultName(statement.account, options.fileName),
        },
        period_start: isoDay(statement.periodStart),
        period_end: isoDay(statement.periodEnd),
        transactions: statement.transactions.length,
        new_transactions: statement.transactions.length - known,
        duplicates: known,
        balance: statement.balance ? { cents: statement.balance.cents, at: isoDay(statement.balance.at) } : null,
        samples: newest.map((transaction) => ({
          date: isoDay(transaction.bookingDate),
          label: transaction.label,
          amount_cents: transaction.amountCents,
          currency: transaction.currency,
          category: categorize({ label: transaction.label, details: transaction.details, counterparty: counterpartyOfParsed(transaction), amountCents: transaction.amountCents, code: transaction.code }, rules),
        })),
      };
    }),
  };
}

export interface ImportOutcome {
  imports: BankImportView[];
  added: number;
  duplicates: number;
}

/// Keeps a statement: each account it covers found again or created, each
/// transaction added once — what an earlier import already holds is linked
/// to this one too, so that deleting either keeps it.
export function importStatements(userId: string, text: string, options: ImportOptions, now = Date.now()): ImportOutcome {
  const parsed = parseStatement(text, options);
  const statements = withTransactions(parsed);
  if (!statements.length) throw new StatementError("no_transactions");
  const chosen = options.accountId ? accountOf(userId, options.accountId) : null;
  if (options.accountId && !chosen) throw new BankError("unknown_account");
  const rules = personRules(userId);
  const checksum = checksumOf(text);
  const insertAccount = sqlite.prepare("INSERT INTO bank_accounts (id, user_id, name, bank_name, ref, iban, number_tail, currency, product, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)");
  const insertImport = sqlite.prepare(`INSERT INTO bank_imports (id, user_id, bank_account_id, file_name, format, checksum, period_start, period_end, transactions_count, skipped_count, balance_cents, balance_at, mapping, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertTransaction = sqlite.prepare(`INSERT OR IGNORE INTO bank_transactions (id, user_id, bank_account_id, import_id, booking_date, value_date, amount_cents, currency, info, comment, creditor_name, debtor_name, code, ref, category, category_source, fingerprint, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rule', ?, ?, ?)`);
  const existing = sqlite.prepare("SELECT id FROM bank_transactions WHERE bank_account_id = ? AND fingerprint = ?");
  const link = sqlite.prepare("INSERT OR IGNORE INTO bank_transaction_imports (transaction_id, import_id) VALUES (?, ?)");
  const ids: string[] = [];
  let added = 0;
  let duplicates = 0;
  sqlite.transaction(() => {
    for (const statement of statements) {
      let account = (statements.length === 1 ? chosen : null) ?? matchAccount(userId, statement.account);
      if (!account) {
        const id = randomUUID();
        const name = (statements.length === 1 && options.accountName?.replace(/\s+/g, " ").trim().slice(0, 80)) || defaultName(statement.account, options.fileName);
        insertAccount.run(id, userId, name, statement.account.bankName, statement.account.ref, statement.account.iban, statement.account.tail ?? null, statement.account.currency ?? "EUR", statement.account.product, now, now);
        account = accountOf(userId, id)!;
      } else {
        // What a later statement says that the account did not know yet.
        sqlite.prepare(`UPDATE bank_accounts SET bank_name = COALESCE(bank_name, ?), ref = COALESCE(ref, ?), iban = COALESCE(iban, ?), number_tail = COALESCE(number_tail, ?), product = COALESCE(product, ?), updated_at = ? WHERE id = ?`)
          .run(statement.account.bankName, statement.account.ref, statement.account.iban, statement.account.tail ?? null, statement.account.product, now, account.id);
      }
      const importId = randomUUID();
      ids.push(importId);
      insertImport.run(importId, userId, account.id, options.fileName.slice(0, 255), parsed.format, checksum, statement.periodStart, statement.periodEnd, statement.transactions.length, parsed.skipped,
        statement.balance?.cents ?? null, statement.balance?.at ?? null, parsed.csv ? JSON.stringify(parsed.csv.mapping) : null, now);
      const fingerprints = fingerprintsOf(statement.transactions);
      let addedHere = 0;
      statement.transactions.forEach((transaction, index) => {
        const fingerprint = fingerprints[index]!;
        const counterparty = counterpartyOfParsed(transaction);
        const category = categorize({ label: transaction.label, details: transaction.details, counterparty, amountCents: transaction.amountCents, code: transaction.code }, rules);
        const id = randomUUID();
        const inserted = insertTransaction.run(id, userId, account!.id, importId, transaction.bookingDate, transaction.valueDate, transaction.amountCents,
          transaction.currency ?? account!.currency, transaction.label, transaction.details,
          transaction.amountCents < 0 ? counterparty : null, transaction.amountCents >= 0 ? counterparty : null,
          transaction.code, transaction.ref, category, fingerprint, now, now);
        const transactionId = inserted.changes ? id : (existing.get(account!.id, fingerprint) as { id: string }).id;
        if (inserted.changes) addedHere += 1;
        link.run(transactionId, importId);
      });
      sqlite.prepare("UPDATE bank_imports SET added_count = ?, duplicates_count = ? WHERE id = ?").run(addedHere, statement.transactions.length - addedHere, importId);
      added += addedHere;
      duplicates += statement.transactions.length - addedHere;
      refreshBalance(account.id);
    }
  })();
  return { imports: listImports(userId, ids), added, duplicates };
}

/// Removes an import, at the person's request, with the transactions only
/// it held; those another import also held stay, now its. An account left
/// with nothing goes too.
export function deleteImport(userId: string, importId: string): { deleted: number; kept: number; account_removed: boolean } {
  const row = sqlite.prepare("SELECT id, bank_account_id FROM bank_imports WHERE id = ? AND user_id = ?").get(importId, userId) as { id: string; bank_account_id: string } | undefined;
  if (!row) throw new BankError("unknown_import");
  let deleted = 0;
  let kept = 0;
  let removed = false;
  sqlite.transaction(() => {
    const held = sqlite.prepare("SELECT transaction_id FROM bank_transaction_imports WHERE import_id = ?").all(importId) as Array<{ transaction_id: string }>;
    sqlite.prepare("DELETE FROM bank_transaction_imports WHERE import_id = ?").run(importId);
    const elsewhere = sqlite.prepare("SELECT import_id FROM bank_transaction_imports WHERE transaction_id = ? LIMIT 1");
    const remove = sqlite.prepare("DELETE FROM bank_transactions WHERE id = ? AND user_id = ?");
    const move = sqlite.prepare("UPDATE bank_transactions SET import_id = ? WHERE id = ? AND import_id = ?");
    for (const { transaction_id } of held) {
      const other = elsewhere.get(transaction_id) as { import_id: string } | undefined;
      if (other) {
        move.run(other.import_id, transaction_id, importId);
        kept += 1;
      } else {
        deleted += remove.run(transaction_id, userId).changes;
      }
    }
    // Anything left pointing at it (none, unless the links were lost).
    sqlite.prepare("UPDATE bank_transactions SET import_id = NULL WHERE import_id = ?").run(importId);
    sqlite.prepare("DELETE FROM bank_imports WHERE id = ?").run(importId);
    refreshBalance(row.bank_account_id);
    const left = sqlite.prepare("SELECT (SELECT COUNT(*) FROM bank_transactions WHERE bank_account_id = ?) + (SELECT COUNT(*) FROM bank_imports WHERE bank_account_id = ?) AS n").get(row.bank_account_id, row.bank_account_id) as { n: number };
    if (left.n === 0) {
      sqlite.prepare("DELETE FROM bank_accounts WHERE id = ? AND user_id = ?").run(row.bank_account_id, userId);
      removed = true;
    }
  })();
  return { deleted, kept, account_removed: removed };
}

// ── Transactions ──────────────────────────────────────────────────────────

export interface TransactionFilter {
  query?: string | null;
  /// Days, ms at 00:00 UTC, both included.
  from?: number | null;
  to?: number | null;
  /// Sizes, in cents, whatever the sign.
  minCents?: number | null;
  maxCents?: number | null;
  category?: BankCategory | null;
  accountId?: string | null;
  direction?: "in" | "out" | null;
  limit?: number;
  offset?: number;
}

export interface TransactionView {
  id: string;
  account_id: string;
  account_name: string;
  date: string;
  value_date: string | null;
  amount_cents: number;
  currency: string;
  label: string;
  details: string | null;
  counterparty: string | null;
  category: BankCategory;
  /// « person »: chosen by the person, never changed by a rule.
  category_source: "rule" | "person";
  import_id: string | null;
}

function filtered(userId: string, filter: TransactionFilter): Array<TransactionRow & { account_name: string }> {
  const where = ["t.user_id = ?"];
  const params: unknown[] = [userId];
  if (filter.from != null) { where.push("t.booking_date >= ?"); params.push(filter.from); }
  if (filter.to != null) { where.push("t.booking_date <= ?"); params.push(filter.to); }
  if (filter.category) { where.push("t.category = ?"); params.push(filter.category); }
  if (filter.accountId) { where.push("t.bank_account_id = ?"); params.push(filter.accountId); }
  if (filter.minCents != null) { where.push("ABS(t.amount_cents) >= ?"); params.push(filter.minCents); }
  if (filter.maxCents != null) { where.push("ABS(t.amount_cents) <= ?"); params.push(filter.maxCents); }
  if (filter.direction === "out") where.push("t.amount_cents < 0");
  if (filter.direction === "in") where.push("t.amount_cents >= 0");
  const rows = sqlite.prepare(`SELECT t.*, a.name AS account_name FROM bank_transactions t JOIN bank_accounts a ON a.id = t.bank_account_id
    WHERE ${where.join(" AND ")} ORDER BY t.booking_date DESC, t.created_at DESC, t.rowid DESC`).all(...params) as Array<TransactionRow & { account_name: string }>;
  // Every word of the search, in the label, the details, the counterparty —
  // or the category it names (« loyer », « courses »).
  const words = plainLabel(filter.query ?? "").split(" ").filter((word) => word.length >= 2);
  if (!words.length) return rows;
  return rows.filter((row) => {
    const text = plainLabel(`${row.info} ${row.comment ?? ""} ${row.creditor_name ?? ""} ${row.debtor_name ?? ""}`);
    return words.every((word) => text.includes(word) || categoryFrom(word) === row.category);
  });
}

const viewOf = (row: TransactionRow & { account_name: string }): TransactionView => ({
  id: row.id,
  account_id: row.bank_account_id,
  account_name: row.account_name,
  date: isoDay(row.booking_date)!,
  value_date: isoDay(row.value_date),
  amount_cents: row.amount_cents,
  currency: row.currency,
  label: row.info,
  details: row.comment,
  counterparty: counterpartyOfRow(row),
  category: isBankCategory(row.category) ? row.category : "other",
  category_source: row.category_source === "person" ? "person" : "rule",
  import_id: row.import_id,
});

export interface TransactionPage {
  total: number;
  /// Of all those found, not only this page, by currency.
  out_cents: Record<string, number>;
  in_cents: Record<string, number>;
  transactions: TransactionView[];
}

export function searchTransactions(userId: string, filter: TransactionFilter = {}): TransactionPage {
  const rows = filtered(userId, filter);
  const out: Record<string, number> = {};
  const into: Record<string, number> = {};
  for (const row of rows) {
    if (row.amount_cents < 0) out[row.currency] = (out[row.currency] ?? 0) - row.amount_cents;
    else into[row.currency] = (into[row.currency] ?? 0) + row.amount_cents;
  }
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
  return { total: rows.length, out_cents: out, in_cents: into, transactions: rows.slice(offset, offset + limit).map(viewOf) };
}

export interface SummaryGroup {
  key: string;
  label: string;
  currency: string;
  out_cents: number;
  in_cents: number;
  count: number;
}

export interface Summary {
  groups: SummaryGroup[];
  out_cents: Record<string, number>;
  in_cents: Record<string, number>;
  count: number;
}

/// What came in and went out over a period, by category, counterparty or
/// month (a transfer to a savings account is shown as such: the reader
/// decides whether it is spending).
export function summarize(userId: string, options: { from: number | null; to: number | null; groupBy: "category" | "counterparty" | "month"; accountId?: string | null; category?: BankCategory | null; direction?: "in" | "out" | null }): Summary {
  const rows = filtered(userId, { from: options.from, to: options.to, accountId: options.accountId, category: options.category, direction: options.direction });
  const groups = new Map<string, SummaryGroup>();
  const out: Record<string, number> = {};
  const into: Record<string, number> = {};
  for (const row of rows) {
    let key: string;
    let label: string;
    if (options.groupBy === "month") {
      key = label = isoDay(row.booking_date)!.slice(0, 7);
    } else if (options.groupBy === "counterparty") {
      const name = counterpartyOfRow(row);
      key = counterpartyKey(name) ?? "?";
      label = name ?? "?";
    } else {
      key = label = isBankCategory(row.category) ? row.category : "other";
    }
    const id = `${key}|${row.currency}`;
    const group = groups.get(id) ?? { key, label, currency: row.currency, out_cents: 0, in_cents: 0, count: 0 };
    if (row.amount_cents < 0) {
      group.out_cents -= row.amount_cents;
      out[row.currency] = (out[row.currency] ?? 0) - row.amount_cents;
    } else {
      group.in_cents += row.amount_cents;
      into[row.currency] = (into[row.currency] ?? 0) + row.amount_cents;
    }
    group.count += 1;
    groups.set(id, group);
  }
  const sorted = [...groups.values()].sort((a, b) =>
    options.groupBy === "month" ? a.key.localeCompare(b.key)
    : options.direction === "in" ? b.in_cents - a.in_cents
    : b.out_cents - a.out_cents || b.in_cents - a.in_cents);
  return { groups: sorted, out_cents: out, in_cents: into, count: rows.length };
}

const DAY_MS = 86_400_000;
/// Statements a few days apart are taken as following each other: a CSV's
/// period is its first and last transactions, not the days it covers.
const COVERAGE_GAP_MS = 7 * DAY_MS;

/// The days the imported statements cover (of one account, or of any),
/// joined: each import's period (an OFX gives it; otherwise its first and
/// last transactions), those that touch or nearly do made one.
export function coveredSpans(userId: string, accountId?: string | null): Array<[number, number]> {
  const rows = sqlite.prepare(`SELECT i.period_start AS start, i.period_end AS end,
      (SELECT MIN(t.booking_date) FROM bank_transaction_imports ti JOIN bank_transactions t ON t.id = ti.transaction_id WHERE ti.import_id = i.id) AS first,
      (SELECT MAX(t.booking_date) FROM bank_transaction_imports ti JOIN bank_transactions t ON t.id = ti.transaction_id WHERE ti.import_id = i.id) AS last
    FROM bank_imports i JOIN bank_accounts a ON a.id = i.bank_account_id
    WHERE i.user_id = ? AND a.status = 'active' ${accountId ? "AND i.bank_account_id = ?" : ""}`).all(...(accountId ? [userId, accountId] : [userId])) as Array<{ start: number | null; end: number | null; first: number | null; last: number | null }>;
  const spans = rows
    .map((row): [number | null, number | null] => [row.start ?? row.first, row.end ?? row.last])
    .filter((span): span is [number, number] => span[0] !== null && span[1] !== null)
    .sort((a, b) => a[0] - b[0]);
  const joined: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = joined[joined.length - 1];
    if (last && start <= last[1] + COVERAGE_GAP_MS) last[1] = Math.max(last[1], end);
    else joined.push([start, end]);
  }
  return joined;
}

/// The days of [from, to] no imported statement covers.
export function uncoveredDays(spans: Array<[number, number]>, from: number, to: number): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  let cursor = from;
  for (const [start, end] of spans) {
    if (end < cursor) continue;
    if (start > to) break;
    if (start > cursor) gaps.push([cursor, Math.min(start - DAY_MS, to)]);
    cursor = Math.max(cursor, end + DAY_MS);
  }
  if (cursor <= to) gaps.push([cursor, to]);
  return gaps;
}

/// The person's correction of a category: this transaction's, and — when
/// they say so — every one with the same counterparty that they did not set
/// themselves, now and in the statements imported later.
export function setCategory(userId: string, transactionId: string, category: BankCategory, similar = false, now = Date.now()): { updated: number; rule: string | null } {
  const row = sqlite.prepare("SELECT * FROM bank_transactions WHERE id = ? AND user_id = ?").get(transactionId, userId) as TransactionRow | undefined;
  if (!row) throw new BankError("unknown_transaction");
  let updated = 0;
  let rule: string | null = null;
  sqlite.transaction(() => {
    updated += sqlite.prepare("UPDATE bank_transactions SET category = ?, category_source = 'person', updated_at = ? WHERE id = ?").run(category, now, transactionId).changes;
    if (!similar) return;
    const key = counterpartyKey(counterpartyOfRow(row));
    if (!key) return;
    rule = key;
    sqlite.prepare(`INSERT INTO bank_category_rules (id, user_id, match, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, match) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at`).run(randomUUID(), userId, key, category, now, now);
    const others = sqlite.prepare("SELECT id, info, creditor_name, debtor_name FROM bank_transactions WHERE user_id = ? AND category_source != 'person' AND id != ?").all(userId, transactionId) as Array<Pick<TransactionRow, "id" | "info" | "creditor_name" | "debtor_name">>;
    const change = sqlite.prepare("UPDATE bank_transactions SET category = ?, updated_at = ? WHERE id = ?");
    for (const other of others) {
      if (counterpartyKey(counterpartyOfRow(other)) === key) updated += change.run(category, now, other.id).changes;
    }
  })();
  return { updated, rule };
}
