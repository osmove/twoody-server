import { bigrams, cjkRuns, cjkWords, withoutCjk } from "../documents/cjk.js";
import { importanceBonus } from "./importance.js";

// How well each memory answers a message (docs/memory-v2-design.md §3,
// lot L3): the scoring and admission of retrieval v2, with nothing but the
// texts, vectors and entity links it is handed — no database, so that the
// chat context (chatContext.ts) can rank on its own when it is given no
// retrieval, and tests can call it as it is. src/memory/retrieve.ts reads
// what it needs (vectors, links, entities) and calls it.
//
//   H = 0.7·C + 0.3·L + E + P
//
//   C  cosine of the message's vector (with the memory query instruction)
//      and the memory's: absent without an embedding model;
//   L  lexical: the IDF mass of the message's terms a memory holds, over the
//      mass of the terms that can tell memories apart (below). A word that
//      named an entity (« femme » in « ma femme ») is the entity, not a term;
//      with no term left in any memory, C is all there is (H = C + E + P);
//   E  +0.15 when the memory names an entity the message reaches (by name,
//      alias or kinship, or one hop over a relation the message says),
//      +0.08 when it names it only by a common noun (« le chien »);
//      −0.25 when it is about someone else, −0.08 when it names nobody and
//      came from an import, in a message about the person;
//   P  +0.04 written or pinned by the person, +0.03·exp(−age/180 days),
//      and its importance: +0.06 Essentiel, +0.03 Important, −0.04 Faible.
//
// Admitted: H ≥ τ and (C ≥ 0.45, or L ≥ 0.6 with a rare term, or an entity
// with C ≥ 0.40 or L ≥ 0.5). Without vectors (no embedding model, a Pi):
// H = L + E + P against τ_lex, with a rare term or an entity and L ≥ 0.4.
// Near-duplicates among the admitted ones keep one (cosine > 0.92). The
// turn then keeps H ≥ best − RELATIVE among the ones it would give.
//
// A message that is not about the person — no « je », « mon », « ma »…, no
// one of theirs named — needs memories that cover it: every term of it
// counts in L, C ≥ 0.6 unless L covers it all, and an alias such as « le
// chien » names nobody there.

/// τ, swept on the memory bench (twoody-bench memory --sweep, 01/10/2026,
/// Qwen3-Embedding 0.6B): 0.48 holds recall where 0.52 lost a quarter of
/// the facts a message needed.
export const TAU = 0.48;
export const TAU_LEX = 0.55;
/// H ≥ best − RELATIVE, among the memories a message would be given (not
/// the ones its profile holds already): 0.08 on the bench, where 0.15 let
/// in twice as many that did not bear on it.
export const RELATIVE = 0.08;
export const ENTITY_DIRECT = 0.15;
/// The best cosine of all, this far ahead of the next, is kept on its own.
export const STANDOUT_COSINE = 0.55;
export const STANDOUT_MARGIN = 0.05;
/// A memory that names an entity of the message only by a common noun.
export const ENTITY_NOUN = 0.08;
/// About someone else than the one the message is about.
const ELSEWHERE = 0.25;
/// Names nobody, and neither said nor written by the person, in a message
/// about them: may be about anyone.
const ANONYMOUS = 0.08;
const DEDUP_COSINE = 0.92;
const DAY_MS = 86_400_000;

export const STOPWORDS = new Set([
  "avec", "dans", "pour", "plus", "mais", "comme", "cette", "sont", "vous",
  "nous", "elle", "elles", "leur", "leurs", "quel", "quelle", "quels",
  "quelles", "quoi", "etre", "avoir", "fait", "faire", "tout", "tous",
  "toute", "toutes", "tres", "aussi", "alors", "donc", "peux", "peut",
  "veux", "merci", "bonjour", "what", "when", "where", "which", "with",
  "that", "this", "these", "those", "from", "have", "does", "will", "would",
  "could", "should", "about", "your", "their", "there", "please", "thanks",
  "hello", "quand", "comment", "combien", "pourquoi", "est-ce", "c'est",
  "deja", "encore", "moment", "rappelle", "souviens", "souvenir", "sais",
  "dire", "appelle", "appelles", "chose", "faut", "fais", "fait", "font",
  "lequel", "laquelle", "lesquels", "y-a", "remind", "remember", "tell",
  // What a message asks the assistant to do, not what it is about: « Parle-
  // moi du projet Tulipe ».
  "parle", "parler", "raconte", "explique", "donne", "montre", "decris", "resume", "show", "explain", "describe", "give",
  // Three letters: « âge » is a word worth matching, these are not.
  "les", "des", "une", "est", "que", "qui", "moi", "toi", "mon", "ton",
  "son", "mes", "tes", "ses", "nos", "vos", "pas", "oui", "non", "sur",
  "par", "ete", "suis", "dis", "dit", "the", "and", "you", "are",
  "was", "how", "who", "why", "for", "not", "but", "can", "all", "any",
  "has", "had", "her", "him", "his", "its", "our", "out", "she", "too",
  "did", "get", "got", "know", "cela", "ceci", "ici", "bien", "ont", "avez",
]);

/// Words that ask about the same thing: « Quel âge j'ai ? » and « Jimmy a
/// 40 ans » share no word. Accents and case already removed. A birth date
/// in a memory (« né le 14 mars 1984 ») reads as « naissance ».
export const CONCEPTS: string[][] = [
  ["age", "ans", "anniversaire", "naissance", "birthday", "born", "old", "aged"],
  ["habite", "habites", "habiter", "vit", "vis", "vivre", "adresse", "ville", "domicile", "live", "lives", "living", "address", "city"],
  ["travail", "travaille", "travailles", "travailler", "metier", "job", "boulot", "profession", "emploi", "poste", "work", "works", "career", "entreprise", "societe", "company"],
  ["famille", "femme", "mari", "epouse", "epoux", "enfant", "enfants", "fils", "fille", "filles", "parents", "pere", "mere", "frere", "soeur", "family", "wife", "husband", "children", "kids", "daughter"],
  ["nom", "prenom", "name", "called"],
];
export const CONCEPT_OF = new Map<string, number>(CONCEPTS.flatMap((words, index) => words.map((word) => [word, index] as [string, number])));

export function normalize(text: string): string {
  return text.replace(/œ/g, "oe").replace(/Œ/g, "oe").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’‘]/g, "'");
}

/// A birth date: « né le 14 mars 1984 », « née en 1987 », « born on 3 May 2001 ».
export const BIRTH = /\b(?:nee?s?\s+(?:le\s+(?:\d{1,2}|1er)\s+\p{L}+\s+\d{4}|en\s+\d{4})|born\s+(?:on\s+|in\s+)?(?:\d{1,2}\s+\p{L}+\s+\d{4}|\p{L}+\s+\d{1,2},?\s+\d{4}|\d{4}))/u;

/// A memory's words, accents and case removed; its Japanese, Chinese and
/// Korean as pairs of characters (documents/cjk.ts: those scripts do not
/// space their words, or glue particles to them — 10/10/2026).
export function memoryWords(text: string): string[] {
  const normal = normalize(withoutCjk(text));
  const words = normal.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);
  for (const run of cjkRuns(text)) words.push(...bigrams(run).filter((pair) => [...pair].length === 2));
  if (BIRTH.test(normal)) words.push("naissance");
  return words;
}

/// Age, name, family, home, work: a fact a profile gives first.
export function coreFact(text: string): boolean {
  return coreConcepts(text) > 0;
}

/// How many of these a fact is about (« Les parents de Mathieu habitent à
/// Angers »: family and home, 2).
export function coreConcepts(text: string): number {
  const concepts = new Set<number>();
  for (const word of memoryWords(text)) {
    const exact = CONCEPT_OF.get(word);
    if (exact !== undefined) concepts.add(exact);
    else CONCEPTS.forEach((group, index) => { if (group.some((core) => core.length >= 4 && inflected(core, word))) concepts.add(index); });
  }
  return concepts.size;
}

/// A word or one of its inflections (« marié », « habitent », « enfants »),
/// not any word that starts alike (« entrepôt » is no « entreprise »).
export function inflected(base: string, word: string): boolean {
  if (word === base) return true;
  if (base.length >= 4 && word.startsWith(base)) return word.length - base.length <= 3;
  return word.length >= 4 && base.startsWith(word) && base.length - word.length <= 2;
}

/// The same word, give or take its ending: « travail » / « travaille »,
/// « dossier » / « dossiers ». A short word only as it is: « âge » is not
/// « agenda ».
export function sameWord(token: string, word: string): boolean {
  if (token === word) return true;
  if (token.length < 4 || word.length < 4) return false;
  let shared = 0;
  while (shared < token.length && shared < word.length && token[shared] === word[shared]) shared += 1;
  // Most of the shorter word: « photosynthèse » is no « photographie ».
  return shared >= Math.min(5, token.length, word.length) && shared >= 0.6 * Math.min(token.length, word.length);
}

export function keywords(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of normalize(withoutCjk(text)).split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 3 && !STOPWORDS.has(word)) tokens.add(word);
  }
  // A Japanese, Chinese or Korean word of the message, cut at its particles,
  // as its pairs: each pair is matched whole (sameWord), as memoryWords
  // holds them.
  for (const word of cjkWords(text)) for (const pair of bigrams(word)) if ([...pair].length === 2) tokens.add(pair);
  return tokens;
}

/// Terms of a message: one per word, or per thing it asks about — what a
/// memory may hold for each, and the words of the message it comes from.
function terms(text: string, resolved?: ReadonlySet<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const from = new Map<string, string[]>();
  for (const token of keywords(text)) {
    const concept = CONCEPT_OF.get(token);
    const key = concept === undefined ? token : `#${concept}`;
    if (!out.has(key)) out.set(key, new Set(concept === undefined ? [token] : CONCEPTS[concept]));
    out.get(key)!.add(token);
    from.set(key, [...(from.get(key) ?? []), token]);
  }
  // A term only words that named an entity stand for is not looked for.
  if (resolved?.size) for (const [key, tokens] of from) if (tokens.every((token) => resolved.has(token))) out.delete(key);
  return out;
}

/// Whether a message is about the person: in the first person (« je »,
/// « mon », « nous »…, not « dis-moi ») — or one of theirs is named, which
/// the caller knows.
export function firstPerson(text: string): boolean {
  const t = ` ${normalize(text).replace(/[^\p{L}\p{N}'-]+/gu, " ")} `;
  if (/ (?:j'|m')/.test(t) || / (?:je|me|mon|ma|mes|moi|nous|notre|nos|i|my|me|mine|we|our|us|i'm|i've) /.test(t.replace(/-(?:moi|nous)\b/g, " "))) return true;
  return false;
}

export interface RankItem {
  /// The memory's text, as a line gives it (title and content).
  text: string;
  /// Written or pinned by the person.
  manual?: boolean;
  /// 0 Faible to 3 Essentiel (memory/importance.ts).
  importance?: number;
  createdAt?: number | null;
  vector?: Float32Array | null;
  /// The entities it names (ids).
  entities?: readonly string[];
  /// Those of them it names only by a common noun (« le chien »): maybe
  /// someone else's.
  nounEntities?: readonly string[];
  /// Those of them it names only as an owner (« la sœur de Nadia »): it is
  /// about someone else.
  ownerEntities?: readonly string[];
  /// Learned from the person or written by them: about them even when it
  /// names nobody (« Architecte à Lyon. »).
  aboutPerson?: boolean;
}

export interface RankOptions {
  queryVector?: Float32Array | null;
  /// The entities the message reaches, with their weight (ENTITY_DIRECT or
  /// a relation the message says); the person's own entity is never among them.
  queryEntities?: ReadonlyMap<string, number>;
  /// The message names one of the person's own (a name, an alias): it is
  /// about them even without « je ».
  namesSomeone?: boolean;
  /// The person's own entity (« self »), if they have one.
  self?: string | null;
  /// Words of the message that named an entity (« femme » in « ma femme »):
  /// the entity stands for them, they are not looked for — when the meaning
  /// is there to judge the rest.
  resolvedWords?: ReadonlySet<string>;
  tau?: number | null;
  now?: number;
}

export interface Ranked {
  index: number;
  score: number;
  c: number | null;
  l: number;
  /// The entity term: positive for an entity the message reaches, negative
  /// for a memory about someone else.
  e: number;
  p: number;
  /// The entity it is shown under (the one the message reaches it by).
  entity: string | null;
  /// It holds a term of the message few memories hold.
  rare: boolean;
  /// The message is about the person.
  personal: boolean;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

/// The memories admitted for a message, best first, near-duplicates left
/// out — before the relative cut, which the turn makes among the ones it
/// would give (withinReach). Hybrid when the message has a vector; a memory
/// without one (not embedded yet) is judged on L + E + P alone.
export function rankMemories(items: readonly RankItem[], query: string, options: RankOptions = {}): Ranked[] {
  const tau = options.tau ?? (options.queryVector ? TAU : TAU_LEX);
  const admitted = scoreMemories(items, query, options)
    .filter((entry) => entry.ok && entry.score >= tau)
    .map(({ ok: _ok, ...entry }) => entry);
  admitted.sort((a, b) => b.score - a.score || a.index - b.index);
  const words = items.map((item) => memoryWords(item.text));

  // Near-duplicates: the person's own first, then the newest.
  const kept: Ranked[] = [];
  const order = [...admitted].sort((a, b) =>
    Number(!!items[b.index]!.manual) - Number(!!items[a.index]!.manual) || (items[b.index]!.createdAt ?? 0) - (items[a.index]!.createdAt ?? 0) || b.score - a.score);
  const dropped = new Set<number>();
  for (const entry of order) {
    if (dropped.has(entry.index)) continue;
    for (const other of order) {
      if (other === entry || dropped.has(other.index) || kept.includes(other)) continue;
      if (duplicates(items[entry.index]!, items[other.index]!, words[entry.index]!, words[other.index]!)) dropped.add(other.index);
    }
    kept.push(entry);
  }
  return admitted.filter((entry) => !dropped.has(entry.index));
}

/// Every memory with something in common with the message, scored, and
/// whether it meets the conditions besides τ (`ok`): what rankMemories
/// admits from, and what a dry run shows.
export function scoreMemories(items: readonly RankItem[], query: string, options: RankOptions = {}): Array<Ranked & { ok: boolean }> {
  const now = options.now ?? Date.now();
  const queryTerms = terms(query, options.resolvedWords);
  const queryEntities = options.queryEntities ?? new Map<string, number>();
  if (queryTerms.size === 0 && queryEntities.size === 0 && !options.queryVector) return [];
  const personal = firstPerson(query) || !!options.namesSomeone;

  const words = items.map((item) => memoryWords(item.text));
  const found = (term: Set<string>, haystack: string[]) => [...term].some((token) => haystack.some((word) => sameWord(token, word)));
  const n = items.length;
  const df = new Map<string, number>();
  const hits: Array<Set<string>> = items.map(() => new Set<string>());
  for (const [key, term] of queryTerms) {
    let count = 0;
    words.forEach((haystack, index) => {
      if (found(term, haystack)) {
        count += 1;
        hits[index]!.add(key);
      }
    });
    df.set(key, count);
  }
  const weight = new Map([...df].map(([key, count]) => [key, Math.log(1 + n / (1 + count))]));
  // The terms that tell memories apart; in a message about the person, the
  // others say what to do with them (« propose une activité pour ma
  // fille »). In one that is not, every term must be covered.
  let mass = 0;
  for (const [key, count] of df) if (count > 0 || !personal) mass += weight.get(key)!;
  const rareDf = Math.max(3, Math.ceil(n * 0.03));
  // No word of the message is in any memory: the words tell nothing, the
  // meaning is all there is (« J'ai quel diplôme ? » against « un master en
  // management… »).
  const meaningOnly = mass === 0;
  const self = options.self ?? null;
  const reachesSomeone = [...queryEntities.values()].some((weight) => weight >= ENTITY_DIRECT);
  // The memory closest by meaning, clearly ahead of the next: kept on its
  // meaning, whatever the words (Jimmy, 01/10/2026: « un projet d'achat en ce
  // moment ? » missed « Je réfléchis à acquérir un Mac Mini », C 0.585 the
  // best by far, behind six memories that only shared « projet »).
  const cosines = options.queryVector
    ? items.map((item) => (item.vector ? dot(options.queryVector!, item.vector) : -1)).sort((a, b) => b - a)
    : [];
  const standout = cosines.length && cosines[0]! >= STANDOUT_COSINE && cosines[0]! - (cosines[1] ?? -1) >= STANDOUT_MARGIN ? cosines[0]! : null;

  const scored: Array<Ranked & { ok: boolean }> = [];
  items.forEach((item, index) => {
    let lexical = 0;
    let rare = false;
    for (const key of hits[index]!) {
      lexical += weight.get(key)!;
      if (df.get(key)! <= rareDf) rare = true;
    }
    const l = mass > 0 ? lexical / mass : 0;
    let e = 0;
    let entity: string | null = null;
    // Named by a common noun, it counts less — nothing when the memory names
    // someone else the message does not reach (« Le chien de Paul »).
    const elsewhere = (item.entities ?? []).some((id) => id !== self && !queryEntities.has(id) && !item.nounEntities?.includes(id));
    for (const id of item.entities ?? []) {
      if (item.ownerEntities?.includes(id)) continue;
      const w = Math.min(queryEntities.get(id) ?? 0, item.nounEntities?.includes(id) ? (elsewhere ? 0 : ENTITY_NOUN) : Infinity);
      if (w > e) {
        e = w;
        entity = id;
      }
    }
    // About someone else: a message about the person's brother is not
    // answered by what their colleague's son does, nor « Quel âge j'ai ? »
    // by their daughter's age. A memory that names nobody may be about
    // anyone, unless the person said it or wrote it.
    if (e === 0 && personal && self !== null) {
      if (item.entities?.length) {
        if (reachesSomeone || !item.entities.includes(self)) e = -ELSEWHERE;
      } else if (!item.aboutPerson) {
        e = -ANONYMOUS;
      }
    }
    const ageDays = item.createdAt ? Math.max(0, (now - item.createdAt) / DAY_MS) : null;
    const p = (item.manual ? 0.04 : 0) + (ageDays === null ? 0 : 0.03 * Math.exp(-ageDays / 180)) + importanceBonus(item.importance);
    const c = options.queryVector && item.vector ? dot(options.queryVector, item.vector) : null;
    let score: number;
    let ok: boolean;
    if (c !== null) {
      score = (meaningOnly ? c : 0.7 * c + 0.3 * l) + e + p;
      ok = c >= 0.45 || (l >= 0.6 && rare) || (e > 0 && (c >= 0.4 || l >= 0.5));
      // Not about the person: the meaning alone must be close (« Un
      // marathon, ça fait combien de kilomètres ? » is not about theirs).
      if (!personal) ok = ok && (c >= 0.6 || l >= 0.99);
      if (standout !== null && c === standout && (personal || c >= 0.6)) {
        score = Math.max(score, c + e + p);
        ok = true;
      }
    } else {
      score = l + e + p;
      ok = (l >= 0.6 && rare) || (e > 0 && l >= 0.4);
    }
    if (score > 0) scored.push({ index, score, c, l, e, p, entity, ok, rare, personal });
  });
  return scored;
}

/// The ones within RELATIVE of the best (entries best first).
export function withinReach<T extends { score: number }>(entries: T[]): T[] {
  const best = entries[0]?.score ?? 0;
  return entries.filter((entry) => entry.score >= best - RELATIVE);
}

function duplicates(a: RankItem, b: RankItem, wordsA: string[], wordsB: string[]): boolean {
  if (a.vector && b.vector) return dot(a.vector, b.vector) > DEDUP_COSINE;
  const setA = new Set(wordsA), setB = new Set(wordsB);
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared += 1;
  return shared / Math.max(1, setA.size + setB.size - shared) > 0.85;
}

const MONTHS: Record<string, number> = {
  janvier: 0, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11,
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/// The age a birth date in a memory gives today: « né le 14 mars 1984 » →
/// 42 on 1 October 2026; « née en 1987 » → about 39. Null without one.
export function ageFrom(text: string, now: Date): { years: number; approximate: boolean; birthday?: { month: number; day: number } } | null {
  const t = normalize(text);
  const full = /\b(?:nee?s?\s+le|born\s+on|born)\s+(\d{1,2}|1er)\s+(\p{L}+)\s+(\d{4})/u.exec(t)
    ?? null;
  if (full) {
    const month = MONTHS[full[2]!];
    const day = full[1] === "1er" ? 1 : Number(full[1]);
    const year = Number(full[3]);
    if (month !== undefined && day >= 1 && day <= 31) {
      let years = now.getFullYear() - year;
      if (now.getMonth() < month || (now.getMonth() === month && now.getDate() < day)) years -= 1;
      return years >= 0 && years < 130 ? { years, approximate: false, birthday: { month, day } } : null;
    }
  }
  const english = /\bborn\s+(?:on\s+)?(\p{L}+)\s+(\d{1,2}),?\s+(\d{4})/u.exec(t);
  if (english && MONTHS[english[1]!] !== undefined) {
    const month = MONTHS[english[1]!]!;
    const day = Number(english[2]);
    let years = now.getFullYear() - Number(english[3]);
    if (now.getMonth() < month || (now.getMonth() === month && now.getDate() < day)) years -= 1;
    return years >= 0 && years < 130 ? { years, approximate: false, birthday: { month, day } } : null;
  }
  const year = /\b(?:nee?s?\s+en|born\s+in)\s+(\d{4})\b/u.exec(t);
  if (year) {
    const years = now.getFullYear() - Number(year[1]);
    return years >= 0 && years < 130 ? { years, approximate: true } : null;
  }
  return null;
}
