import { createHash } from "node:crypto";
import { plainLabel } from "./categories.js";

// « Banque »: the statements the person exports from their bank and drops
// in Capacités → Banque, read here, on this computer — CSV (French banks
// first: « ; », decimal comma, dd/mm/yyyy, a few lines about the account
// above the table, Débit/Crédit or one signed Montant), OFX/QFX (SGML 1.x and
// XML 2.x) and QIF. Nothing here touches the database: routes/bank.ts shows
// what was read (the CSV layout, to confirm or change when unsure), and
// store.ts keeps it.

export type StatementFormat = "csv" | "ofx" | "qif";
/// How a date like 03/10/2026 reads: day first (France), month first, or
/// year first (2026-10-03).
export type DateOrder = "dmy" | "mdy" | "ymd";
export const DATE_ORDERS: readonly DateOrder[] = ["dmy", "mdy", "ymd"];

/// What a column of a CSV holds.
export const CSV_ROLES = [
  "date", "value_date", "label", "details", "debit", "credit", "amount", "direction", "balance",
  "counterparty", "currency", "reference", "type", "account", "account_name", "ignore",
] as const;
export type CsvRole = (typeof CSV_ROLES)[number];
export const CSV_DELIMITERS = [";", ",", "\t", "|"] as const;

export interface CsvMapping {
  delimiter: string;
  /// The row that names the columns (0-based, among the file's rows), or null.
  headerRow: number | null;
  /// The first row that may hold a transaction.
  firstRow: number;
  columns: CsvRole[];
  dateOrder: DateOrder;
  decimal: "," | ".";
}

export interface ParsedTransaction {
  /// The day it was booked: ms at 00:00 UTC of that day.
  bookingDate: number;
  valueDate: number | null;
  /// Negative: money out.
  amountCents: number;
  currency: string | null;
  /// The label as the bank wrote it (« Libellé »).
  label: string;
  /// More of it (a second label column, OFX MEMO, QIF M).
  details: string | null;
  /// Who the money went to or came from, when the statement says it in a
  /// column of its own (« Tiers », « Bénéficiaire »); otherwise found from
  /// the label (categories.ts counterpartyOf).
  counterparty: string | null;
  /// The kind of operation, as the statement names it (OFX TRNTYPE, CSV « Type »).
  code: string | null;
  /// The bank's reference (OFX FITID, a check number, a CSV reference).
  ref: string | null;
}

export interface StatementAccount {
  /// The account's number as the statement gives it (OFX ACCTID, a number or
  /// an IBAN in the lines above a CSV's table).
  ref: string | null;
  iban: string | null;
  name: string | null;
  bankName: string | null;
  currency: string | null;
  /// OFX ACCTTYPE (CHECKING, SAVINGS…), CREDITCARD for a card's statement.
  product: string | null;
  /// The last digits of a number the statement masks (« ****4521 »): enough
  /// to suggest an account to the person, never to file a statement alone.
  tail?: string | null;
}

export interface ParsedStatement {
  account: StatementAccount;
  transactions: ParsedTransaction[];
  /// The days the statement covers (OFX DTSTART/DTEND, else its first and
  /// last transactions), ms.
  periodStart: number | null;
  periodEnd: number | null;
  /// The balance it states, and the day it is of.
  balance: { cents: number; at: number } | null;
}

export interface ParseResult {
  format: StatementFormat;
  statements: ParsedStatement[];
  /// Read without guessing: a CSV whose columns were all named, or an OFX.
  /// Otherwise the person confirms the layout.
  sure: boolean;
  dateOrder: DateOrder;
  /// Nothing in the dates said whether the day or the month comes first.
  dateAmbiguous: boolean;
  /// Lines that held no transaction (titles, totals, empty lines).
  skipped: number;
  /// A CSV's layout and its first rows, for the person to check.
  csv: { mapping: CsvMapping; rows: string[][]; columns: number } | null;
}

export interface ParseOptions {
  fileName?: string | null;
  /// The layout the person chose (CSV).
  mapping?: Partial<CsvMapping> | null;
  dateOrder?: DateOrder | null;
}

export class StatementError extends Error {
  constructor(public code: "empty" | "unreadable" | "no_transactions") {
    super(code);
  }
}

export function checksumOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/// Which kind of file this is: its content first, its name second.
export function detectFormat(text: string, fileName?: string | null): StatementFormat {
  const head = text.slice(0, 4000);
  if (/<OFX>|^\s*OFXHEADER|<\?OFX\b/im.test(head) || /<STMTTRN>/i.test(text.slice(0, 200_000))) return "ofx";
  if (/^\s*!(?:Type|Account|Option)\b/im.test(head)) return "qif";
  const extension = (fileName ?? "").toLowerCase().split(".").pop();
  if (extension === "ofx" || extension === "qfx") return "ofx";
  if (extension === "qif") return "qif";
  return "csv";
}

export function parseStatement(input: string, options: ParseOptions = {}): ParseResult {
  const text = input.replace(/^\uFEFF/, "").replace(/\u0000/g, "");
  if (!text.trim()) throw new StatementError("empty");
  const format = detectFormat(text, options.fileName);
  if (format === "ofx") return parseOfx(text);
  if (format === "qif") return parseQif(text, options.dateOrder ?? null);
  return parseCsv(text, options);
}

// ── Numbers and dates ─────────────────────────────────────────────────────

/// « -1 234,56 », « 1.234,56 », « 1,234.56 », « 45,20- », « (45.20) »,
/// « +1 200,00 € » → cents. Null when it is no amount.
export function parseAmount(raw: string | null | undefined, decimal: "," | "." = ","): number | null {
  if (raw === null || raw === undefined) return null;
  let text = raw.replace(/[\u2212\u2013]/g, "-").replace(/[\s\u00a0\u202f']/g, "").replace(/(?:EUR|€|USD|US\$|\$|GBP|£|CHF|euros?)/gi, "");
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  if (text.endsWith("-")) { negative = !negative; text = text.slice(0, -1); }
  if (text.startsWith("-")) { negative = !negative; text = text.slice(1); }
  else if (text.startsWith("+")) text = text.slice(1);
  if (!/^\d[\d.,]*$/.test(text)) return null;
  // A value written the other way than the file's (« 45.20 » among « 45,20 »):
  // its last separator, followed by one or two digits, is the decimal one.
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  let separator: "," | "." = decimal;
  if (lastComma >= 0 && lastDot >= 0) separator = lastComma > lastDot ? "," : ".";
  else if (lastComma >= 0 && decimal === "." && !/,\d{3}$/.test(text)) separator = ",";
  else if (lastDot >= 0 && decimal === "," && !/\.\d{3}$/.test(text)) separator = ".";
  const parts = text.split(separator === "," ? "." : ",").join("").split(separator);
  if (parts.length > 2) return null;
  const [whole = "", fraction = ""] = parts;
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) return null;
  let cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (fraction.length > 2 && Number(fraction[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents) || cents > 1e13) return null;
  return negative ? -cents : cents;
}

const MONTHS: Record<string, number> = {
  jan: 1, janv: 1, janvier: 1, january: 1, feb: 2, fev: 2, fevr: 2, fevrier: 2, february: 2, mar: 3, mars: 3, march: 3,
  apr: 4, avr: 4, avril: 4, april: 4, may: 5, mai: 5, jun: 6, juin: 6, june: 6, jul: 7, juil: 7, juillet: 7, july: 7,
  aug: 8, aou: 8, aout: 8, august: 8, sep: 9, sept: 9, septembre: 9, september: 9, oct: 10, octobre: 10, october: 10,
  nov: 11, novembre: 11, november: 11, dec: 12, decembre: 12, december: 12,
};

function utcDay(year: number, month: number, day: number): number | null {
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const at = Date.UTC(year, month - 1, day);
  return new Date(at).getUTCDate() === day ? at : null;
}

const fullYear = (text: string) => (text.length === 4 ? Number(text) : Number(text) + (Number(text) >= 70 ? 1900 : 2000));

/// A day, as ms at 00:00 UTC: « 03/10/2026 » (as `order` says), « 03/10/26 »,
/// « 2026-10-03 », « 2026-10-03T09:12:00 », « 20261003 », « 3 oct. 2026 ».
export function parseDay(raw: string | null | undefined, order: DateOrder = "dmy"): number | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?=$|[T\s])/.exec(text);
  if (match) return utcDay(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?=$|[\s,T])/.exec(text);
  if (match) {
    const [a, b] = [Number(match[1]), Number(match[2])];
    return order === "mdy" ? utcDay(fullYear(match[3]!), a, b) : utcDay(fullYear(match[3]!), b, a);
  }
  match = /^((?:19|20)\d{2})(\d{2})(\d{2})(?=$|[T\s\d[.])/.exec(text);
  if (match) return utcDay(Number(match[1]), Number(match[2]), Number(match[3]));
  const plain = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  match = /^(\d{1,2})(?:er)?[\s-]+([a-z]+)\.?[\s-]+(\d{4}|\d{2})$/.exec(plain);
  if (match && MONTHS[match[2]!]) return utcDay(fullYear(match[3]!), MONTHS[match[2]!]!, Number(match[1]));
  match = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(plain);
  if (match && MONTHS[match[1]!]) return utcDay(Number(match[3]), MONTHS[match[1]!]!, Number(match[2]));
  return null;
}

/// Whether « 03/10/2026 » is the 3rd of October or the 10th of March, from
/// all the dates of a file: a number above 12 says it; otherwise the
/// reading that keeps the dates closest together (a statement covers weeks,
/// not months scattered over a year), day first when even that does not tell.
export function detectDateOrder(values: string[]): { order: DateOrder; ambiguous: boolean } {
  let dayFirst = 0;
  let monthFirst = 0;
  let yearFirst = 0;
  const pairs: Array<[number, number, number]> = [];
  for (const raw of values) {
    const text = raw.trim();
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(text) || /^(?:19|20)\d{6}/.test(text)) { yearFirst += 1; continue; }
    const match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})/.exec(text);
    if (!match) continue;
    const [a, b] = [Number(match[1]), Number(match[2])];
    if (a > 12 && b <= 12) dayFirst += 1;
    else if (b > 12 && a <= 12) monthFirst += 1;
    pairs.push([a, b, fullYear(match[3]!)]);
  }
  if (!pairs.length) return { order: yearFirst ? "ymd" : "dmy", ambiguous: false };
  if (dayFirst || monthFirst) return { order: monthFirst > dayFirst ? "mdy" : "dmy", ambiguous: dayFirst > 0 && monthFirst > 0 };
  if (!pairs.some(([a, b]) => a !== b)) return { order: "dmy", ambiguous: false };
  const span = (order: DateOrder) => {
    const days = pairs.map(([a, b, year]) => (order === "mdy" ? Date.UTC(year, a - 1, b) : Date.UTC(year, b - 1, a)));
    return Math.max(...days) - Math.min(...days);
  };
  return { order: span("mdy") < span("dmy") ? "mdy" : "dmy", ambiguous: true };
}

/// Whether amounts are written « 45,20 » or « 45.20 », from a file's values.
export function detectDecimal(values: string[]): "," | "." {
  let comma = 0;
  let dot = 0;
  for (const raw of values) {
    const text = raw.replace(/[\s\u00a0\u202f]/g, "");
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) {
      if (lastComma > lastDot) comma += 1; else dot += 1;
    } else if (/,\d{1,2}(?:\D*)$/.test(text)) comma += 1;
    else if (/\.\d{1,2}(?:\D*)$/.test(text)) dot += 1;
  }
  return dot > comma ? "." : ",";
}

// ── Accounts named in a statement ─────────────────────────────────────────

/// An IBAN, checked (mod 97): « FR76 3000 4000 0312 3456 7890 143 ».
export function findIban(text: string): string | null {
  for (const match of text.toUpperCase().matchAll(/\b([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?)\b/g)) {
    const iban = match[1]!.replace(/ /g, "");
    if (iban.length >= 15 && iban.length <= 34 && ibanValid(iban)) return iban;
  }
  return null;
}

function ibanValid(iban: string): boolean {
  const moved = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let rest = 0;
  for (const digit of moved) rest = (rest * 10 + Number(digit)) % 97;
  return rest === 1;
}

/// The banks a statement may name, as they write themselves: recognised,
/// never guessed from a number.
const BANKS: Array<[RegExp, string]> = [
  [/\bBNP\s*PARIBAS\b|\bBNPPARIBAS\b/i, "BNP Paribas"],
  [/\bSOCI[ÉE]T[ÉE]\s+G[ÉE]N[ÉE]RALE\b/i, "Société Générale"],
  [/\bCR[ÉE]DIT\s+AGRICOLE\b/i, "Crédit Agricole"],
  [/\bCR[ÉE]DIT\s+MUTUEL\b/i, "Crédit Mutuel"],
  [/\bCR[ÉE]DIT\s+DU\s+NORD\b/i, "Crédit du Nord"],
  [/\bLCL\b|\bCR[ÉE]DIT\s+LYONNAIS\b/i, "LCL"],
  [/\bBOURSORAMA\b|\bBOURSOBANK\b/i, "BoursoBank"],
  [/\bLA\s+BANQUE\s+POSTALE\b/i, "La Banque Postale"],
  [/\bCAISSE\s+D['’]?\s*[ÉE]PARGNE\b/i, "Caisse d'Épargne"],
  [/\bBANQUE\s+POPULAIRE\b/i, "Banque Populaire"],
  [/\bCIC\b/, "CIC"],
  [/\bFORTUNEO\b/i, "Fortuneo"],
  [/\bHELLO\s*BANK\b/i, "Hello bank!"],
  [/\bING\s+(?:DIRECT|BANK)\b/i, "ING"],
  [/\bMONABANQ\b/i, "Monabanq"],
  [/\bN26\b/i, "N26"],
  [/\bREVOLUT\b/i, "Revolut"],
  [/\bQONTO\b/i, "Qonto"],
  [/\bSHINE\b/i, "Shine"],
  [/\bBFORBANK\b/i, "BforBank"],
  [/\bHSBC\b/i, "HSBC"],
  [/\bAXA\s+BANQUE\b/i, "AXA Banque"],
  [/\bORANGE\s+BANK\b/i, "Orange Bank"],
  [/\bNICKEL\b/i, "Nickel"],
];

export function findBank(text: string): string | null {
  return BANKS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function currencyOf(text: string | null | undefined): string | null {
  const value = (text ?? "").trim().toUpperCase();
  if (!value) return null;
  if (/^[A-Z]{3}$/.test(value)) return value;
  if (/€|\bEUROS?\b|\bEUR\b/.test(value)) return "EUR";
  if (/US\$|\bUSD\b|\$/.test(value)) return "USD";
  if (/£|\bGBP\b/.test(value)) return "GBP";
  if (/\bCHF\b/.test(value)) return "CHF";
  return null;
}

const NUMBER_NEAR = /(?:n[°o]|num[ée]ro|numero|compte|account|acct)[^0-9]{0,30}?((?:\d[ -]?){7,22}\d)/i;
const ACCOUNT_KIND = /\b(compte\s+(?:de\s+|d['’]\s*)?(?:ch[èe]ques?|d[ée]p[ôo]ts?|courant|joint|[ée]pargne|titres)|compte\s+[A-Za-zÀ-ÿ]+|livret\s+[A-Za-z0-9À-ÿ]+|ldds|pel|cel|carte\s+[A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)/i;

/// What the lines above a CSV's table say of the account: its number or
/// IBAN, its kind, its bank, a balance and its day.
function accountFromLines(rows: string[][], order: DateOrder, decimal: "," | "."): { account: Partial<StatementAccount>; balance: { cents: number; at: number | null } | null } {
  const account: Partial<StatementAccount> = {};
  let balance: { cents: number; at: number | null } | null = null;
  for (const row of rows) {
    const line = row.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (!line) continue;
    account.iban ??= findIban(line);
    account.tail ??= /(?:[*•]{2,}|X{3,})\s?(\d{3,5})\b/i.exec(line)?.[1] ?? null;
    account.bankName ??= findBank(line);
    account.currency ??= currencyOf(/€|\bEUR\b|\beuros?\b/i.test(line) ? "EUR" : null);
    if (!account.ref) {
      const near = NUMBER_NEAR.exec(line)?.[1]?.replace(/[ -]/g, "");
      // A cell of digits alone (« ="00012345678" »).
      const alone = row.map((cell) => cell.replace(/[ -]/g, "")).find((cell) => /^\d{8,23}$/.test(cell));
      account.ref = near ?? alone ?? null;
    }
    if (!account.name) {
      const kind = ACCOUNT_KIND.exec(line)?.[1];
      if (kind && !/^compte\s+(?:n|num)/i.test(kind)) account.name = kind.replace(/\s+/g, " ").trim().slice(0, 60);
    }
    if (!balance && /\bsolde\b|\bbalance\b/i.test(line)) {
      const dateText = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/.exec(line)?.[0] ?? null;
      const withoutDate = dateText ? line.replace(dateText, " ") : line;
      const amounts = [...withoutDate.matchAll(/[+\-\u2212]?\s?\d{1,3}(?:[ .\u00a0\u202f]\d{3})*(?:[.,]\d{2})\b|[+\-\u2212]?\d+[.,]\d{2}\b/g)].map((match) => match[0]);
      const cents = amounts.length ? parseAmount(amounts[amounts.length - 1]!, decimal) : null;
      if (cents !== null) balance = { cents, at: dateText ? parseDay(dateText, order) : null };
    }
  }
  if (account.iban && !account.ref) account.ref = account.iban;
  return { account, balance };
}

// ── CSV ───────────────────────────────────────────────────────────────────

/// The rows of a CSV: « "…" » cells may hold the delimiter, quotes doubled
/// and line breaks (Crédit Agricole writes its labels on several lines);
/// « ="0123" » (Société Générale) is « 0123 ».
export function csvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let index = 0;
  const length = text.length;
  while (index < length) {
    const char = text[index]!;
    if (char === '"' && (field.trim() === "" || field.trim() === "=")) {
      let cursor = index + 1;
      let value = "";
      let closed = false;
      // A cell is short: a quote that never closes is a quote, not a cell.
      const limit = Math.min(length, index + 20_000);
      while (cursor < limit) {
        const next = text[cursor]!;
        if (next === '"') {
          if (text[cursor + 1] === '"') { value += '"'; cursor += 2; continue; }
          closed = true;
          cursor += 1;
          break;
        }
        value += next;
        cursor += 1;
      }
      if (closed) {
        field = value;
        index = cursor;
        continue;
      }
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\n" || char === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((cells) => cells.map((cell) => cell.replace(/\s+/g, " ").trim()));
}

export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 200_000);
  let best = ";";
  let bestScore = -1;
  for (const delimiter of CSV_DELIMITERS) {
    const counts = new Map<number, number>();
    for (const row of csvRows(sample, delimiter)) {
      if (row.length >= 3 && row.filter(Boolean).length >= 2) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
    }
    const score = Math.max(0, ...counts.values());
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

const headerText = (cell: string) => cell.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/// What a column's name says it holds, in the words French (and a few
/// English-speaking) banks use.
export function roleOfHeader(cell: string): CsvRole | null {
  const name = headerText(cell);
  if (!name) return null;
  if (/^(?:date (?:de )?valeur|dateval|date val|value date|valeur)\b/.test(name)) return "value_date";
  if (/^(?:date|dateop|booking date|transaction date|posting date|posted date|completed date|started date|jour)\b/.test(name)) return "date";
  if (/^(?:montant )?debit\b|^(?:sorties?|depenses?|withdrawals?|money out|paid out|debit amount)\b/.test(name)) return "debit";
  if (/^(?:montant )?credit\b|^(?:entrees?|recettes?|deposits?|money in|paid in|credit amount)\b/.test(name)) return "credit";
  if (/^(?:sens|debit credit|d c|dc|type de mouvement)$/.test(name)) return "direction";
  if (/^(?:solde|balance|accountbalance|running balance)\b|\bsolde$/.test(name)) return "balance";
  if (/^(?:montant|somme|amount|valeur de l operation)\b/.test(name)) return "amount";
  if (/^(?:tiers|beneficiaire|emetteur|contrepartie|counterparty|payee|supplierfound|nom du tiers|merchant|marchand|commercant|nom)\b/.test(name)) return "counterparty";
  if (/^(?:libelle|label|description|intitule|nature|wording|operation)\b/.test(name)) return "label";
  if (/^(?:detail|details|informations? complementaires?|complement|motif|memo|commentaires?|comment|notes?|reference de l operation|libelle complementaire)\b/.test(name)) return "details";
  if (/^(?:devise|currency|monnaie)$/.test(name)) return "currency";
  if (/^(?:reference|ref|numero d operation|n operation|transaction id|id|fitid|numero de cheque|n de cheque)$/.test(name)) return "reference";
  if (/^(?:type|type d operation|type de transaction|type operation|code)$/.test(name)) return "type";
  // The person's own account, on each line of a file of several (BoursoBank's
  // « accountNum »); not N26's « Account number », the counterparty's.
  if (/^(?:accountnum|numero de compte|n de compte|n compte)$/.test(name)) return "account";
  if (/^(?:accountlabel|nom du compte|intitule du compte|account name|libelle du compte)$/.test(name)) return "account_name";
  if (/^(?:categor|sous categor|category|categoryparent)/.test(name)) return "ignore";
  return null;
}

/// One role per column, at most one of each that must be one: a second
/// label is details, a second date the value date.
function settleRoles(roles: Array<CsvRole | null>): CsvRole[] {
  const seen = new Set<CsvRole>();
  const settled = roles.map((role): CsvRole => {
    if (!role) return "ignore";
    if (role === "label" && seen.has("label")) return "details";
    if (role === "date" && seen.has("date")) return seen.has("value_date") ? "ignore" : "value_date";
    if (["date", "value_date", "amount", "debit", "credit", "balance", "counterparty", "currency", "direction", "account", "account_name"].includes(role) && seen.has(role)) return "ignore";
    seen.add(role);
    return role;
  });
  // Débit and Crédit win over a Montant beside them.
  if (settled.includes("debit") && settled.includes("credit")) return settled.map((role) => (role === "amount" ? "ignore" : role));
  // No label: the details are.
  if (!settled.includes("label")) {
    const details = settled.indexOf("details");
    if (details >= 0) settled[details] = "label";
  }
  return settled;
}

function hasMoney(columns: readonly CsvRole[]): boolean {
  return columns.includes("amount") || columns.includes("debit") || columns.includes("credit");
}

/// Columns guessed from what they hold, for a CSV whose table has no names:
/// the dates, the amounts (one signed, or two that take turns: debit then
/// credit; a last one that never empties: the balance) and the longest text.
function guessColumns(rows: string[][], order: DateOrder): { columns: CsvRole[]; firstRow: number } | null {
  const counts = new Map<number, number>();
  for (const row of rows) if (row.length >= 3) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  const width = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!width) return null;
  // Either way round: the dates' order is read from them once found.
  const isDate = (cell: string | undefined) => parseDay(cell, order) !== null || parseDay(cell, order === "mdy" ? "dmy" : "mdy") !== null;
  // The rows of the table, not a line about the account that happens to
  // have as many cells: those with a date somewhere.
  const body = rows.filter((row) => row.length === width && row.some((cell) => isDate(cell)));
  const share = (column: number, test: (cell: string) => boolean) => body.filter((row) => test(row[column] ?? "")).length / Math.max(1, body.length);
  const columns: CsvRole[] = Array.from({ length: width }, () => "ignore");
  const dates = columns.map((_, column) => column).filter((column) => share(column, isDate) >= 0.8);
  if (!dates.length) return null;
  columns[dates[0]!] = "date";
  if (dates[1] !== undefined) columns[dates[1]] = "value_date";
  const dated = body.filter((row) => isDate(row[dates[0]!]));
  const numeric = columns.map((_, column) => column).filter((column) => {
    if (dates.includes(column)) return false;
    const filled = dated.filter((row) => (row[column] ?? "").trim());
    return filled.length >= dated.length * 0.3 && filled.every((row) => parseAmount(row[column]) !== null);
  });
  const alternating = (a: number, b: number) => dated.filter((row) => Boolean((row[a] ?? "").trim()) !== Boolean((row[b] ?? "").trim())).length >= dated.length * 0.8;
  if (numeric.length >= 2 && alternating(numeric[0]!, numeric[1]!)) {
    columns[numeric[0]!] = "debit";
    columns[numeric[1]!] = "credit";
    if (numeric[2] !== undefined) columns[numeric[2]] = "balance";
  } else if (numeric.length >= 1) {
    columns[numeric[0]!] = "amount";
    if (numeric.length >= 2) columns[numeric[numeric.length - 1]!] = "balance";
  } else {
    return null;
  }
  const texts = columns.map((role, column) => ({ role, column, length: dated.reduce((sum, row) => sum + (row[column] ?? "").length, 0) }))
    .filter((entry) => entry.role === "ignore")
    .sort((a, b) => b.length - a.length);
  if (texts[0]) columns[texts[0].column] = "label";
  const firstRow = rows.findIndex((row) => row.length === width && isDate(row[dates[0]!]));
  return { columns, firstRow: Math.max(0, firstRow) };
}

function cleanMapping(input: Partial<CsvMapping> | null | undefined): Partial<CsvMapping> {
  if (!input || typeof input !== "object") return {};
  const out: Partial<CsvMapping> = {};
  if (typeof input.delimiter === "string" && (CSV_DELIMITERS as readonly string[]).includes(input.delimiter)) out.delimiter = input.delimiter;
  if (input.headerRow === null || (Number.isInteger(input.headerRow) && (input.headerRow as number) >= 0)) out.headerRow = input.headerRow;
  if (Number.isInteger(input.firstRow) && (input.firstRow as number) >= 0) out.firstRow = input.firstRow;
  if (Array.isArray(input.columns) && input.columns.length <= 80 && input.columns.every((role) => (CSV_ROLES as readonly string[]).includes(role))) out.columns = input.columns;
  if (input.dateOrder && DATE_ORDERS.includes(input.dateOrder)) out.dateOrder = input.dateOrder;
  if (input.decimal === "," || input.decimal === ".") out.decimal = input.decimal;
  return out;
}

function parseCsv(text: string, options: ParseOptions): ParseResult {
  const chosen = cleanMapping(options.mapping);
  const delimiter = chosen.delimiter ?? detectDelimiter(text);
  const rows = csvRows(text, delimiter);
  if (!rows.some((row) => row.some(Boolean))) throw new StatementError("empty");

  // The row naming the columns: the first, among the first forty, that names
  // a date and an amount.
  let headerRow: number | null = null;
  let columns: CsvRole[] | null = null;
  let sure = false;
  if (chosen.headerRow !== undefined) {
    headerRow = chosen.headerRow;
  } else {
    for (let index = 0; index < Math.min(rows.length, 40); index += 1) {
      const roles = settleRoles(rows[index]!.map(roleOfHeader));
      if (rows[index]!.length >= 3 && roles.includes("date") && hasMoney(roles)) {
        headerRow = index;
        columns = roles;
        sure = roles.includes("label");
        break;
      }
    }
  }
  if (headerRow !== null && !columns) columns = settleRoles((rows[headerRow] ?? []).map(roleOfHeader));

  // The dates of the file decide how they read, whoever chose the columns.
  const firstGuess = headerRow !== null ? headerRow + 1 : 0;
  const dateColumnOf = (roles: CsvRole[] | null) => roles?.indexOf("date") ?? -1;
  let firstRow = chosen.firstRow ?? firstGuess;
  if (chosen.columns) columns = chosen.columns;
  let dateValues = dateColumnOf(columns) >= 0 ? rows.slice(firstRow).map((row) => row[dateColumnOf(columns)] ?? "").filter(Boolean) : [];
  let detected = detectDateOrder(dateValues);
  let dateOrder = chosen.dateOrder ?? options.dateOrder ?? detected.order;

  if (!columns || dateColumnOf(columns) < 0 || !hasMoney(columns)) {
    // No names: guessed from what the columns hold, to be confirmed.
    const guessed = guessColumns(rows.slice(headerRow !== null ? headerRow + 1 : 0), dateOrder);
    sure = false;
    if (guessed) {
      columns = guessed.columns;
      firstRow = (headerRow !== null ? headerRow + 1 : 0) + guessed.firstRow;
      dateValues = rows.slice(firstRow).map((row) => row[columns!.indexOf("date")] ?? "").filter(Boolean);
      detected = detectDateOrder(dateValues);
      dateOrder = chosen.dateOrder ?? options.dateOrder ?? detected.order;
    } else {
      columns = columns ?? Array.from({ length: Math.max(...rows.slice(0, 40).map((row) => row.length)) }, () => "ignore" as CsvRole);
    }
  }
  if (chosen.columns || chosen.headerRow !== undefined || chosen.firstRow !== undefined) sure = true;

  const at = (role: CsvRole) => columns!.indexOf(role);
  const all = (role: CsvRole) => columns!.map((value, index) => (value === role ? index : -1)).filter((index) => index >= 0);
  const moneyColumns = ["amount", "debit", "credit", "balance"].map((role) => at(role as CsvRole)).filter((index) => index >= 0);
  const decimal = chosen.decimal ?? detectDecimal(rows.slice(firstRow).flatMap((row) => moneyColumns.map((index) => row[index] ?? "")).filter(Boolean));

  const lines = rows.slice(0, headerRow ?? firstRow);
  const above = accountFromLines(lines, dateOrder, decimal);
  const headerLine = headerRow !== null ? (rows[headerRow] ?? []).join(" ") : "";
  const fileCurrency = above.account.currency ?? currencyOf(/€|\bEUR\b|\beuros?\b/i.test(headerLine) ? "EUR" : /\bUSD\b|\$/.test(headerLine) ? "USD" : null);

  type Row = { transaction: ParsedTransaction; balance: number | null; account: string | null; accountName: string | null; order: number };
  const read: Row[] = [];
  let skipped = 0;
  for (let index = firstRow; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (!row.some(Boolean)) continue;
    const bookingDate = parseDay(row[at("date")], dateOrder);
    let cents: number | null = null;
    if (at("amount") >= 0) {
      cents = parseAmount(row[at("amount")], decimal);
    } else {
      const debit = at("debit") >= 0 ? parseAmount(row[at("debit")], decimal) : null;
      const credit = at("credit") >= 0 ? parseAmount(row[at("credit")], decimal) : null;
      if (debit !== null || credit !== null) cents = (credit !== null ? Math.abs(credit) : 0) - (debit !== null ? Math.abs(debit) : 0);
    }
    if (bookingDate === null || cents === null) {
      skipped += 1;
      continue;
    }
    if (at("direction") >= 0) {
      const sense = headerText(row[at("direction")] ?? "");
      if (/^(?:d|debit|dr|db|sortie|-)$/.test(sense)) cents = -Math.abs(cents);
      else if (/^(?:c|credit|cr|entree|\+)$/.test(sense)) cents = Math.abs(cents);
    }
    const labels = all("label").map((column) => row[column] ?? "").filter(Boolean);
    const details = all("details").map((column) => row[column] ?? "").filter(Boolean);
    let label = labels.join(" ").trim();
    let more: string | null = details.join(" ").trim() || null;
    if (!label && more) { label = more; more = null; }
    if (!label) label = (at("counterparty") >= 0 ? row[at("counterparty")] : "") || (at("type") >= 0 ? row[at("type")] : "") || "";
    read.push({
      transaction: {
        bookingDate,
        valueDate: at("value_date") >= 0 ? parseDay(row[at("value_date")], dateOrder) : null,
        amountCents: cents,
        currency: (at("currency") >= 0 ? currencyOf(row[at("currency")]) : null) ?? fileCurrency,
        label: label.slice(0, 500),
        details: more && more !== label ? more.slice(0, 1000) : null,
        counterparty: at("counterparty") >= 0 ? (row[at("counterparty")] || null)?.slice(0, 120) ?? null : null,
        code: at("type") >= 0 ? (row[at("type")] || null)?.slice(0, 60) ?? null : null,
        ref: at("reference") >= 0 ? (row[at("reference")] || null)?.slice(0, 120) ?? null : null,
      },
      balance: at("balance") >= 0 ? parseAmount(row[at("balance")], decimal) : null,
      account: at("account") >= 0 ? (row[at("account")] || "").replace(/[ -]/g, "") || null : null,
      accountName: at("account_name") >= 0 ? row[at("account_name")] || null : null,
      order: index,
    });
  }

  // A file of several accounts (BoursoBank's export names each line's): one
  // statement each.
  const groups = new Map<string, Row[]>();
  for (const row of read) {
    const key = row.account ?? "";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  if (!groups.size) groups.set("", []);
  const statements: ParsedStatement[] = [...groups.entries()].map(([key, group]) => {
    const transactions = group.map((row) => row.transaction);
    const days = transactions.map((transaction) => transaction.bookingDate);
    // The balance after the newest line: the last of its day in a file that
    // goes forward in time, the first in one that goes back.
    let balance: { cents: number; at: number } | null = null;
    const balanced = group.filter((row) => row.balance !== null);
    if (balanced.length) {
      const forward = balanced[0]!.transaction.bookingDate <= balanced[balanced.length - 1]!.transaction.bookingDate;
      const newest = Math.max(...balanced.map((row) => row.transaction.bookingDate));
      const ofDay = balanced.filter((row) => row.transaction.bookingDate === newest);
      const row = forward ? ofDay[ofDay.length - 1]! : ofDay[0]!;
      balance = { cents: row.balance!, at: newest };
    } else if (above.balance) {
      balance = { cents: above.balance.cents, at: above.balance.at ?? (days.length ? Math.max(...days) : Date.UTC(1970, 0, 1)) };
    }
    const ref = key || above.account.ref || null;
    return {
      account: {
        ref,
        iban: above.account.iban ?? (ref && findIban(ref) ? ref : null),
        name: group.find((row) => row.accountName)?.accountName ?? above.account.name ?? null,
        bankName: above.account.bankName ?? findBank(options.fileName ?? "") ?? null,
        currency: transactions.find((transaction) => transaction.currency)?.currency ?? fileCurrency ?? null,
        product: null,
        tail: key ? null : above.account.tail ?? null,
      },
      transactions,
      periodStart: days.length ? Math.min(...days) : null,
      periodEnd: days.length ? Math.max(...days) : null,
      balance,
    };
  });

  // Mostly lines that are no transactions: the layout is wrong.
  if (read.length === 0 || skipped > read.length) sure = false;
  const width = Math.max(columns.length, ...rows.slice(0, 40).map((row) => row.length));
  const mapping: CsvMapping = {
    delimiter,
    headerRow,
    firstRow,
    columns: Array.from({ length: width }, (_, index) => columns![index] ?? "ignore"),
    dateOrder,
    decimal,
  };
  return {
    format: "csv",
    statements,
    sure,
    dateOrder,
    dateAmbiguous: !chosen.dateOrder && !options.dateOrder && detected.ambiguous,
    skipped,
    csv: { mapping, rows: rows.slice(0, Math.max(firstRow + 8, 12)).map((row) => row.map((cell) => cell.slice(0, 80))), columns: width },
  };
}

// ── OFX / QFX ─────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

/// A leaf's value — closed (XML) or not (SGML: « <TRNAMT>-45.20 »).
function ofxValue(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, "i").exec(block);
  const value = match ? decodeEntities(match[1]!).trim() : "";
  return value || null;
}

/// An aggregate's blocks; one never closed runs up to the next of its kind.
function ofxBlocks(text: string, tag: string): string[] {
  const closed = [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi"))].map((match) => match[1]!);
  if (closed.length) return closed;
  const parts = text.split(new RegExp(`<${tag}>`, "i")).slice(1);
  return parts.map((part) => part.split(/<\/(?:BANKTRANLIST|STMTRS|CCSTMTRS)>/i)[0]!);
}

function ofxDay(value: string | null): number | null {
  return value ? parseDay(value.slice(0, 8), "ymd") : null;
}

function parseOfx(text: string): ParseResult {
  const bankName = ofxValue(ofxBlocks(text, "FI")[0] ?? "", "ORG");
  const blocks = [...ofxBlocks(text, "STMTRS").map((block) => ({ block, card: false })), ...ofxBlocks(text, "CCSTMTRS").map((block) => ({ block, card: true }))];
  if (!blocks.length) blocks.push({ block: text, card: false });
  const statements: ParsedStatement[] = blocks.map(({ block, card }) => {
    const from = ofxBlocks(block, card ? "CCACCTFROM" : "BANKACCTFROM")[0] ?? block;
    const currency = currencyOf(ofxValue(block, "CURDEF"));
    const amounts = ofxBlocks(block, "STMTTRN");
    const decimal = detectDecimal(amounts.map((transaction) => ofxValue(transaction, "TRNAMT") ?? ""));
    const transactions: ParsedTransaction[] = [];
    for (const transaction of amounts) {
      const bookingDate = ofxDay(ofxValue(transaction, "DTPOSTED")) ?? ofxDay(ofxValue(transaction, "DTUSER"));
      const cents = parseAmount(ofxValue(transaction, "TRNAMT"), decimal);
      if (bookingDate === null || cents === null) continue;
      const name = ofxValue(transaction, "NAME");
      const memo = ofxValue(transaction, "MEMO");
      const label = name ?? memo ?? ofxValue(transaction, "TRNTYPE") ?? "";
      const details = name && memo && !name.includes(memo) ? memo : null;
      const payee = ofxBlocks(transaction, "PAYEE")[0];
      transactions.push({
        bookingDate,
        valueDate: ofxDay(ofxValue(transaction, "DTAVAIL")),
        amountCents: cents,
        currency: currencyOf(ofxValue(transaction, "CURSYM")) ?? currency,
        label: label.slice(0, 500),
        details: details?.slice(0, 1000) ?? null,
        counterparty: payee ? ofxValue(payee, "NAME") : null,
        code: ofxValue(transaction, "TRNTYPE"),
        ref: ofxValue(transaction, "FITID") ?? ofxValue(transaction, "CHECKNUM") ?? ofxValue(transaction, "REFNUM"),
      });
    }
    const ledger = ofxBlocks(block, "LEDGERBAL")[0];
    const balanceCents = ledger ? parseAmount(ofxValue(ledger, "BALAMT"), decimal) : null;
    const balanceAt = ledger ? ofxDay(ofxValue(ledger, "DTASOF")) : null;
    const list = ofxBlocks(block, "BANKTRANLIST")[0] ?? "";
    const days = transactions.map((transaction) => transaction.bookingDate);
    const accountId = ofxValue(from, "ACCTID");
    return {
      account: {
        ref: accountId?.replace(/\s+/g, "") ?? null,
        iban: accountId ? findIban(accountId) : null,
        name: null,
        bankName: bankName ? findBank(bankName) ?? bankName.slice(0, 60) : null,
        currency,
        product: card ? "CREDITCARD" : ofxValue(from, "ACCTTYPE"),
      },
      transactions,
      periodStart: ofxDay(ofxValue(list, "DTSTART")) ?? (days.length ? Math.min(...days) : null),
      periodEnd: ofxDay(ofxValue(list, "DTEND")) ?? (days.length ? Math.max(...days) : null),
      balance: balanceCents !== null ? { cents: balanceCents, at: balanceAt ?? (days.length ? Math.max(...days) : Date.now()) } : null,
    };
  });
  return { format: "ofx", statements, sure: true, dateOrder: "ymd", dateAmbiguous: false, skipped: 0, csv: null };
}

// ── QIF ───────────────────────────────────────────────────────────────────

/// « 03/10'26 », « 3/10' 6 » (Quicken) → « 03/10/26 », « 3/10/06 ».
const qifDate = (raw: string) => raw.trim().replace(/'\s*(\d)$/, "/0$1").replace(/'\s*/, "/");

function parseQif(text: string, asked: DateOrder | null): ParseResult {
  type QifRecord = { D?: string; T?: string; P?: string; M?: string; N?: string };
  const groups: Array<{ name: string | null; type: string | null; records: QifRecord[] }> = [];
  let group = { name: null as string | null, type: null as string | null, records: [] as QifRecord[] };
  let inAccount = false;
  let accountName: string | null = null;
  let accountType: string | null = null;
  let current: QifRecord = {};
  let skipped = 0;
  let readable = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith("!")) {
      const header = line.slice(1).trim().toLowerCase();
      if (header === "account") {
        inAccount = true;
        accountName = null;
        accountType = null;
      } else if (header.startsWith("type:")) {
        inAccount = false;
        const type = header.slice(5).trim();
        // Bank, card and cash lists; never an investment account's.
        readable = ["bank", "ccard", "cash", "oth a", "oth l"].includes(type);
        if (group.records.length) groups.push(group);
        group = { name: accountName, type: accountType ?? type, records: [] };
      }
      continue;
    }
    const code = line[0]!;
    const value = line.slice(1).trim();
    if (inAccount) {
      if (code === "N") accountName = value || null;
      else if (code === "T") accountType = value || null;
      else if (code === "^") inAccount = false;
      continue;
    }
    if (!readable) continue;
    if (code === "^") {
      if (current.D && (current.T ?? "") !== "") group.records.push(current);
      else if (Object.keys(current).length) skipped += 1;
      current = {};
      continue;
    }
    if (code === "D" || code === "T" || code === "P" || code === "M" || code === "N") current[code] = value;
    else if (code === "U" && current.T === undefined) current.T = value;
  }
  if (current.D && current.T) group.records.push(current);
  if (group.records.length || !groups.length) groups.push(group);

  const dates = groups.flatMap((entry) => entry.records.map((record) => qifDate(record.D ?? "")));
  const detected = detectDateOrder(dates);
  const dateOrder = asked ?? detected.order;
  const decimal = detectDecimal(groups.flatMap((entry) => entry.records.map((record) => record.T ?? "")));
  const statements: ParsedStatement[] = groups.map((entry) => {
    const transactions: ParsedTransaction[] = [];
    for (const record of entry.records) {
      const bookingDate = parseDay(qifDate(record.D ?? ""), dateOrder);
      const cents = parseAmount(record.T, decimal);
      if (bookingDate === null || cents === null) {
        skipped += 1;
        continue;
      }
      const label = (record.P || record.M || "").slice(0, 500);
      transactions.push({
        bookingDate,
        valueDate: null,
        amountCents: cents,
        currency: null,
        label,
        details: record.P && record.M && record.M !== record.P ? record.M.slice(0, 1000) : null,
        counterparty: null,
        code: null,
        ref: record.N || null,
      });
    }
    const days = transactions.map((transaction) => transaction.bookingDate);
    return {
      account: { ref: null, iban: null, name: entry.name, bankName: null, currency: null, product: entry.type ? entry.type.toUpperCase() : null },
      transactions,
      periodStart: days.length ? Math.min(...days) : null,
      periodEnd: days.length ? Math.max(...days) : null,
      balance: null,
    };
  });
  return { format: "qif", statements, sure: !detected.ambiguous || asked !== null, dateOrder, dateAmbiguous: asked === null && detected.ambiguous, skipped, csv: null };
}

// ── The same transaction, imported twice ──────────────────────────────────

/// What says two lines are the same transaction, per account: its day, its
/// amount, its label (letters and digits, its first 32 — an OFX cuts its
/// names there), and how many identical lines came before it in the same
/// file — two coffees of 2,50 € the same day at the same café are two
/// transactions, found again as two when an overlapping statement is
/// imported.
export function fingerprintsOf(transactions: ReadonlyArray<Pick<ParsedTransaction, "bookingDate" | "amountCents" | "label">>): string[] {
  const seen = new Map<string, number>();
  return transactions.map((transaction) => {
    const base = `${transaction.bookingDate}|${transaction.amountCents}|${plainLabel(transaction.label).slice(0, 32)}`;
    const index = seen.get(base) ?? 0;
    seen.set(base, index + 1);
    return createHash("sha256").update(`${base}|${index}`).digest("hex").slice(0, 32);
  });
}
