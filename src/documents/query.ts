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

// « Voilà c'est activé, tu peux maintenant ? » after « liste les fichiers
// de mon bureau » asked with Documents off (Jimmy, 07/10/2026): the
// question is the one before, asked again — not « maintenant ? », which
// names no folder, so nothing was listed. A short message that only says to
// try again, nothing of its own.
const RETRY = /\b(?:maintenant|a present|reessaie|reessaye|reessayez|essaie encore|essaye encore|recommence|c est (?:fait|active|bon|ok)|ca y est|voila|vas y|allez y|go|now|try again|again|retry|done|it s on)\b/;
const RETRY_WORDS = new Set([
  "et", "alors", "bon", "ok", "okay", "oui", "voila", "c", "est", "fait", "active", "activee", "activees", "actives", "bon", "ca", "y", "tu", "peux", "pouvez", "vous",
  "maintenant", "a", "present", "le", "la", "les", "faire", "reessaie", "reessaye", "reessayez", "essaie", "essaye", "encore", "recommence", "vas", "allez",
  "go", "now", "try", "again", "retry", "done", "it", "s", "on", "can", "you", "do", "please", "stp", "svp", "merci", "documents", "j", "ai", "je", "l",
]);

export function retriesPrevious(text: string): boolean {
  const plain = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[’']/g, " ").replace(/[!?.,;:…()"«»-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!plain || plain.length > 80 || !RETRY.test(plain)) return false;
  return plain.split(" ").every((word) => RETRY_WORDS.has(word));
}

// Small talk — « salut », « ça va ? », « merci Twoody ! » — asks nothing of
// the documents: searching them anyway brought passages that matched a
// stray word, and the answer showed them as sources (28/09/2026). A
// message is small talk when, once greetings, thanks and politeness are
// taken out, at most one short word (a name) is left.
const SMALL_TALK = [
  "comment ca va", "comment vas-tu", "comment vas tu", "comment allez-vous", "tu vas bien", "vous allez bien", "ca va",
  "how are you", "how's it going", "good morning", "good evening", "good night", "au revoir", "a plus", "a bientot",
  "bonne journee", "bonne soiree", "bonne nuit", "thank you", "de rien",
  "salut", "coucou", "bonjour", "bonsoir", "hello", "hi", "hey", "yo", "merci", "thanks", "ok", "okay", "d'accord",
  "daccord", "oui", "non", "yes", "no", "super", "cool", "top", "parfait", "genial", "bravo", "bye", "re",
];

export function smallTalk(text: string): boolean {
  let rest = ` ${text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[!?.,;:…()"«»]+/g, " ").replace(/\s+/g, " ").trim()} `;
  if (rest.trim().length === 0 || rest.length > 80) return false;
  let found = false;
  for (const phrase of SMALL_TALK) {
    const pattern = new RegExp(` ${phrase.replace(/[-']/g, "[-' ]?")}(?= )`, "g");
    if (pattern.test(rest)) {
      found = true;
      rest = rest.replace(pattern, " ");
    }
  }
  const left = rest.trim().split(" ").filter(Boolean);
  return found && (left.length === 0 || (left.length === 1 && left[0].length <= 12));
}

// « Oui », « vas-y », « d'accord », « je veux bien »: an agreement, nothing
// asked of its own.
const AGREEMENT = /^(?:(?:oui|ouais|ok|okay|d accord|daccord|vas y|allez y|go|yes|yep|sure|bien sur|volontiers|c est parti|je veux bien|avec plaisir|s il te plait|s il vous plait|stp|svp|please|merci|parfait|super|top|alors)\s*)+$/;

/// A message that asks nothing of its own: an agreement, small talk, or
/// « réessaie ».
export function asksNothing(text: string): boolean {
  const said = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’']/g, " ").replace(/[!?.,;:…()"«»-]+/g, " ").replace(/\s+/g, " ").trim();
  return !said || AGREEMENT.test(said) || smallTalk(text) || retriesPrevious(text);
}

/// User messages looked back at for the question a retry is about.
export const RETRY_LOOKBACK = 4;

/// The question a message that only says « try again » asks again: the
/// latest earlier user message (newest first in `earlier`) that asks
/// something of its own, within the last few. « Liste les fichiers de mon
/// bureau » (Documents off), « Oui », « Voilà c'est fait »: the listing,
/// not « Oui » (Jimmy, 08/10/2026 — the roots and their counts came back).
export function questionBefore(earlier: string[], within = RETRY_LOOKBACK): string | null {
  for (const message of earlier.slice(0, within)) {
    if (!asksNothing(message)) return message;
  }
  return null;
}
