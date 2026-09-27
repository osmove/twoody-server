// Turns a question into an FTS5 MATCH expression. Pure, so it is tested
// without a database.
//
// The index is lexical (BM25), which suits the documents this is for:
// contracts, filings and letters are searched by the names, numbers and
// terms of art they contain. Two things make it forgiving enough for
// questions asked in natural language:
//   - the tokenizer folds case and diacritics ("delai" finds "délai");
//   - longer words are reduced to a crude stem and matched as a prefix,
//     so "redevances" finds "redevance" and "résilier" finds
//     "résiliation".
// Terms are OR-ed: BM25 then ranks passages that contain more of them,
// and the rarer ones, first.

const STOPWORDS = new Set([
  // Common short words; short subject terms such as CV, RH and AI remain searchable.
  "de", "le", "la", "du", "un", "ce", "se", "ma", "ta", "sa", "il", "en", "et", "au", "ou", "si", "ne", "je", "tu", "on", "me", "te", "ca",
  "an", "as", "at", "be", "by", "do", "go", "he", "if", "in", "is", "it", "my", "no", "of", "or", "so", "to", "up", "us", "we",
  // French
  "les", "des", "une", "aux", "est", "sont", "ont", "pour", "par", "sur", "dans", "avec", "sans", "sous", "que", "qui",
  "quoi", "quel", "quelle", "quels", "quelles", "dont", "mais", "donc", "car", "pas", "plus", "moins", "tres", "tout",
  "tous", "toute", "toutes", "cette", "ces", "son", "ses", "leur", "leurs", "mon", "mes", "nos", "vos", "notre", "votre",
  "elle", "elles", "ils", "nous", "vous", "etre", "avoir", "fait", "faire", "peut", "peux", "doit", "comme", "aussi",
  "alors", "quand", "comment", "pourquoi", "combien", "entre", "selon", "dit", "dis", "moi", "toi", "lui", "merci",
  "bonjour", "stp", "svp", "veux", "voudrais", "peut-on", "est-ce",
  // English
  "the", "and", "for", "are", "was", "were", "has", "have", "had", "with", "without", "from", "that", "this", "these",
  "those", "what", "when", "where", "which", "who", "whom", "why", "how", "does", "did", "can", "could", "should",
  "would", "will", "shall", "may", "not", "but", "you", "your", "our", "their", "its", "his", "her", "about", "into",
  "please", "thanks", "hello", "tell", "give", "show",
]);

const MAX_TERMS = 12;

export function queryTerms(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const word of words(text)) {
    // Short subjects (CV, RH, AI) matter as much as numbers and codes.
    const keep = word.length >= 2 || /\d/.test(word);
    if (!keep || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    terms.push(word);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/// null when the text holds nothing worth searching for.
export function buildMatchQuery(text: string): string | null {
  const terms = queryTerms(text);
  if (terms.length === 0) return null;
  return terms.map(matchTerm).join(" OR ");
}

function matchTerm(term: string): string {
  // Tokens are letters and digits only, so quoting is enough to keep
  // FTS5 operators (AND, OR, NOT, NEAR) literal.
  if (matchedWhole(term)) return `"${term}"`;
  return `"${stem(term)}"*`;
}

function matchedWhole(term: string): boolean {
  return term.length < 6 || /\d/.test(term);
}

/// Words the way the tokenizer sees them: case and diacritics folded.
function words(text: string): string[] {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u);
}

/// How many of the terms a text holds, matched as the MATCH expression
/// matches them: a short word or a code whole, a longer word by its stem.
export function termsFound(text: string, terms: string[]): number {
  const present = new Set(words(text));
  return terms.filter((term) => {
    if (matchedWhole(term)) return present.has(term);
    const prefix = stem(term);
    return [...present].some((word) => word.startsWith(prefix));
  }).length;
}

/// Which of the passages FTS5 found go to the model, best first. BM25
/// ranks them, and those far behind the best one are dropped as noise —
/// unless they hold several of the question's words. In a small folder,
/// BM25 gives next to no weight to a word found in most passages (FTS5
/// floors its IDF): a note that repeated the question outscored, by far,
/// the contract and the amendment that answered it, and both were
/// dropped.
export function selectPassages<T extends { document_id: string; text: string; score: number }>(
  rows: T[],
  terms: string[],
  limit: number,
  perDocument: number,
): T[] {
  if (rows.length === 0) return [];
  const floor = rows[0].score * 0.35; // bm25() is negative, lower is better
  const enough = Math.max(2, Math.ceil(terms.length / 4));
  const used = new Map<string, number>();
  const kept: T[] = [];
  for (const row of rows) {
    if (row.score > floor && termsFound(row.text, terms) < enough) continue;
    const count = used.get(row.document_id) ?? 0;
    if (count >= perDocument) continue;
    used.set(row.document_id, count + 1);
    kept.push(row);
    if (kept.length >= limit) break;
  }
  return kept;
}

/// Not linguistics — just enough to bridge singular / plural and the
/// commonest French and English endings.
function stem(term: string): string {
  const stripped = term.replace(/(ements|ement|ations|ation|ions|ion|ees|ee|es|er|ez|ent|ing|ed|s|x|e)$/, "");
  return stripped.length >= 4 ? stripped : term.slice(0, Math.max(4, term.length - 1));
}

/** Names carry useful search terms even when the document body never says them. */
export function metadataScore(name: string, location: string, terms: string[]): number {
  return termsFound(name, terms) * 8 + termsFound(location, terms) * 2;
}
