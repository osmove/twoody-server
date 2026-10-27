// Whether a quote the model gives is in the document (docs/project-overview-design.md
// §3): an item of the overview stands only on the document's own words. The
// model may change the quotation marks, the dashes, the spaces, the case or a
// word's ending; it must not make the sentence up. Found as written once
// those are folded, else when most of its words come in a row of the
// document, in that order.

/// Case, accents kept (« Größe » is not « Grosse »), quotation marks, dashes,
/// apostrophes and spaces folded; punctuation out.
export function foldQuote(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»‹›「」『』"]/g, " ")
    .replace(/[^\p{L}\p{N}'\-\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text: string): string[] {
  return foldQuote(text).split(" ").filter((word) => word.length > 0);
}

/// Japanese, Chinese and Korean are not written with spaces between words:
/// their quotes are compared by characters.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export interface QuoteFound {
  /// Where it starts in the document's folded text (for the page).
  at: number;
  exact: boolean;
}

/// The quote in the document: as written once folded, else `share` of its
/// words (or characters, for CJK) in a row of the document of the same
/// length, in order. Too short a quote (fewer than 3 words, or 6 CJK
/// characters) must be found as written.
export function findQuote(document: string, quote: string, share = 0.8): QuoteFound | null {
  const doc = foldQuote(document);
  const wanted = foldQuote(quote).replace(/^[-'\s]+|[-'\s]+$/g, "");
  if (!wanted) return null;
  const exact = doc.indexOf(wanted);
  if (exact >= 0) return { at: exact, exact: true };
  if (CJK.test(wanted)) {
    const chars = [...wanted.replace(/\s/g, "")];
    if (chars.length < 6) return null;
    const docChars = [...doc.replace(/\s/g, "")];
    const best = bestWindow(docChars, chars);
    return best && best.share >= share ? { at: positionOfChar(doc, best.start), exact: false } : null;
  }
  const quoteWords = words(wanted);
  if (quoteWords.length < 3) return null;
  const docWords = doc.split(" ");
  const best = bestWindow(docWords, quoteWords, sameWord);
  if (!best || best.share < share) return null;
  let at = 0;
  for (let i = 0; i < best.start; i += 1) at += docWords[i]!.length + 1;
  return { at, exact: false };
}

/// « Anforderungen » and « Anforderung », « décidé » and « décidée »: the
/// same word to a quote, when one starts with the other but for an ending
/// of at most 3 letters.
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short) && long.length - short.length <= 3;
}

/// The row of `doc` as long as `quote` holding most of its items in order
/// (the longest common subsequence over the window).
function bestWindow<T>(doc: T[], quote: T[], same: (a: T, b: T) => boolean = (a, b) => a === b): { start: number; share: number } | null {
  const n = quote.length;
  if (doc.length === 0) return null;
  const width = Math.min(doc.length, n + Math.ceil(n * 0.25));
  const first = quote[0]!;
  let best: { start: number; share: number } | null = null;
  // A window at the document's end is shorter: the quote may be its last words.
  for (let start = 0; start < doc.length; start += 1) {
    // Only windows starting near one of the quote's first words are worth it.
    const opening = quote.slice(0, 3);
    if (!opening.some((item) => same(item, doc[start]!)) && !same(first, doc[start]!)) continue;
    const window = doc.slice(start, start + width);
    const share = lcs(window, quote, same) / n;
    if (!best || share > best.share) best = { start, share };
    if (share === 1) break;
  }
  return best;
}

function lcs<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) current[j] = same(a[i - 1]!, b[j - 1]!) ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    previous = current;
  }
  return previous[b.length]!;
}

function positionOfChar(doc: string, index: number): number {
  let seen = 0;
  for (let i = 0; i < doc.length; i += 1) {
    if (doc[i] === " ") continue;
    if (seen === index) return i;
    seen += 1;
  }
  return 0;
}
