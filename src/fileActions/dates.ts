import { fold } from "../intentText.js";

// The date a document gives itself — an invoice's, a letter's, a scan's —
// for « range mes factures par mois » and « renomme ces scans avec leur
// date »: the one after « Date », « Facture du », « émise le », Invoice
// date, Rechnungsdatum, Fecha, 日付… first, else the first plausible one
// in its first pages. Not the deadline or the period it speaks of when it
// labels its own date; a document that says none is dated by the file
// (plan.ts says which, file by file).

export interface FoundDate {
  year: number;
  month: number;
  day: number;
}

const MONTHS: Record<string, number> = {};
const NAMES: Array<[string[], number]> = [
  [["janvier", "janv", "january", "jan", "januar", "janner", "enero", "ene", "gennaio", "gen", "janeiro", "januari"], 1],
  [["fevrier", "fevr", "fev", "february", "feb", "februar", "febrero", "febbraio", "fevereiro", "februari"], 2],
  [["mars", "march", "mar", "marz", "marzo", "marco", "maart", "mrt"], 3],
  [["avril", "avr", "april", "apr", "abril", "abr", "aprile"], 4],
  [["mai", "may", "mayo", "maggio", "mag", "maio", "mei"], 5],
  [["juin", "june", "jun", "juni", "junio", "giugno", "giu", "junho"], 6],
  [["juillet", "juil", "july", "jul", "juli", "julio", "luglio", "lug", "julho"], 7],
  [["aout", "august", "aug", "agosto", "ago", "augustus"], 8],
  [["septembre", "sept", "september", "sep", "septiembre", "settembre", "set", "setembro"], 9],
  [["octobre", "oct", "october", "oktober", "okt", "octubre", "ottobre", "ott", "outubro", "out"], 10],
  [["novembre", "nov", "november", "noviembre", "novembro"], 11],
  [["decembre", "dec", "december", "dezember", "dez", "diciembre", "dic", "dicembre", "dezembro"], 12],
];
for (const [names, month] of NAMES) for (const name of names) MONTHS[name] = month;
const MONTH_NAME = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

/// Words that announce a document's own date, in the ten languages.
const LABEL = new RegExp([
  String.raw`date(?: de (?:la )?(?:facture|emission|creation|document|piece|signature|commande))?|facture du|facture n[o°]?\s*\S+ du|emise? le|etablie? le|fait le|le (?=\d)|en date du|invoice date|date of issue|issued(?: on)?|dated|statement date|rechnungsdatum|datum|ausgestellt am|vom|fecha(?: de (?:emision|factura))?|emitida el|data(?: di emissione| della fattura| de emissao| da fatura)?|emessa il|emitida em|factuurdatum|gedateerd`,
  "日付|発行日|請求日|作成日|日期|开票日期|開票日期|发票日期|날짜|발행일|작성일|청구일",
].join("|"), "u");

function valid(year: number, month: number, day: number, now: Date): FoundDate | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1990 || year > now.getFullYear() + 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return { year, month, day };
}

function fullYear(text: string): number {
  const value = Number(text);
  return text.length === 2 ? (value > 70 ? 1900 + value : 2000 + value) : value;
}

type Hit = { index: number; date: FoundDate };

/// Every date written in the text, where it is.
function datesIn(folded: string, now: Date, monthFirst: boolean): Hit[] {
  const hits: Hit[] = [];
  const push = (index: number, date: FoundDate | null) => {
    if (date) hits.push({ index, date });
  };
  let match: RegExpExecArray | null;
  // 2026-09-12, 2026/09/12, 2026.09.12
  const iso = /(?<!\d)((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g;
  while ((match = iso.exec(folded))) push(match.index, valid(Number(match[1]), Number(match[2]), Number(match[3]), now));
  // 12/09/2026, 12.09.2026, 12-09-26 (day first, unless the language puts the month first and the day says so)
  const numeric = /(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-]((?:19|20)?\d{2})(?![\d/.-])/g;
  while ((match = numeric.exec(folded))) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    const year = fullYear(match[3]!);
    const dayFirst = !(monthFirst && a <= 12) || b > 12;
    push(match.index, dayFirst ? valid(year, b, a, now) : valid(year, a, b, now));
  }
  // 12 septembre 2026, 12. September 2026, 12 de septiembre de 2026, 1er mars 2026
  const dayName = new RegExp(String.raw`(?<!\d)(\d{1,2})(?:er|st|nd|rd|th|°|\.)?\s+(?:de\s+)?(${MONTH_NAME})\.?\s+(?:de\s+)?((?:19|20)\d{2})(?!\d)`, "g");
  while ((match = dayName.exec(folded))) push(match.index, valid(Number(match[3]), MONTHS[match[2]!]!, Number(match[1]), now));
  // September 12, 2026
  const nameDay = new RegExp(String.raw`(?<![\p{L}])(${MONTH_NAME})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})(?!\d)`, "gu");
  while ((match = nameDay.exec(folded))) push(match.index, valid(Number(match[3]), MONTHS[match[1]!]!, Number(match[2]), now));
  // 2026年9月12日, 2026년 9월 12일
  const cjk = /((?:19|20)\d{2})\s*[年년]\s*(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일]?/g;
  while ((match = cjk.exec(folded))) push(match.index, valid(Number(match[1]), Number(match[2]), Number(match[3]), now));
  return hits.sort((a, b) => a.index - b.index);
}

/// The document's own date, or null when its text holds none. `language`
/// settles 03/04/2026 (the 3rd of April, but March 4th in English).
export function documentDate(text: string, options: { language?: string | null; now?: Date } = {}): FoundDate | null {
  const now = options.now ?? new Date();
  const head = fold(text.slice(0, 20_000));
  const monthFirst = (options.language ?? "").toLowerCase().startsWith("en-us") || (options.language ?? "").toLowerCase() === "en";
  const hits = datesIn(head, now, monthFirst);
  if (!hits.length) return null;
  // A date labelled as the document's, within 40 characters after its label.
  const label = new RegExp(`(?:${LABEL.source})\\s*:?\\s*$`, "u");
  for (const hit of hits) {
    const before = head.slice(Math.max(0, hit.index - 40), hit.index);
    if (label.test(before)) return hit.date;
  }
  return hits[0]!.date;
}

export function isoDay(date: FoundDate): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function fromTime(ms: number): FoundDate {
  const date = new Date(ms);
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

/// A name that already starts with a date (« 2026-09-12 Facture.pdf »,
/// « 20260912_scan.pdf », « 12-09-2026 scan.pdf »).
export function namedWithDate(name: string): boolean {
  return /^(?:(?:19|20)\d{2}[-_. ]?\d{2}[-_. ]?\d{2}|\d{2}[-_.]\d{2}[-_.](?:19|20)\d{2})(?!\d)/.test(name);
}
