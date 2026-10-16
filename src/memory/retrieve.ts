import { sqlite } from "../db.js";
import { projectsLine } from "../projects/projects.js";
import { smallTalk } from "../documents/query.js";
import type { MemoryMode, MemoryRow, ProfileHints } from "../chatContext.js";
import { embedMemoryQuery, embedPendingMemories, memoryEmbeddingStatus, memoryEmbeddingsEnabled, memoryVectors } from "./embeddings.js";
import { aliasesOf, ensureLinked, entitiesInText, findEntity, KINSHIP, kinLabels, kinshipIn, listEntities, normaliseName, relatedFrom, relationsOf, selfOf } from "./entities.js";
import { coreFact, ENTITY_DIRECT, firstPerson, inflected, memoryWords, rankMemories, scoreMemories, type RankItem } from "./rank.js";

// Retrieval v2 (docs/memory-v2-design.md §3, lot L3): which memories ride on
// a message (tier b), worked out before the turn is built (chatContext.ts
// buildChatTurn, `relevant`), and what the profile of the system prompt is
// made of (tier a, `profileHints`). The scoring itself is rank.ts.
//
//   1. nothing for small talk, outside « Complète », in a document-only turn;
//   2. the pool: the person's current memories (the turn then leaves out the
//      ones in its profile, told already, or said in its last messages);
//   3. the entities the message names (names, aliases, kinship), and one hop
//      over their relations;
//   4–7. scored, admitted, deduplicated (rank.ts); the turn budgets them;
//   8. given grouped by entity; memory_usage counts what was given;
//   9. the message's vector is waited for 300 ms at most — a cold engine
//      starts meanwhile, and this turn goes lexical, with the entities.

const QUERY_WAIT_MS = 300;
/// An alias that is a common noun with its article (« le chien », « la
/// maison »): someone only in a message about the person.
const DETERMINER = /^(?:le|la|les|l|the|mon|ma|mes|my) /;
const SUBJECT = new Set(["je", "j", "nous", "on", "i", "we"]);
const POSSESSIVE = new Set(["ma", "mon", "mes", "notre", "nos", "my", "our", "le", "la", "les", "l", "the", "de", "du", "d"]);

/// What a relation is called from the other side: Élodie → Léa « fille »
/// makes Élodie Léa's « mère ».
const INVERSE = new Map<string, string[]>(([
  [["fille", "fils", "enfant", "daughter", "son", "child"], ["mère", "père", "parent", "parents", "maman", "papa", "mother", "father", "mom", "dad"]],
  [["mère", "père", "maman", "papa", "mother", "father"], ["fille", "fils", "enfant", "enfants", "daughter", "son", "child", "children"]],
  [["épouse", "femme", "mari", "époux", "conjoint", "conjointe", "compagnon", "compagne", "wife", "husband", "spouse", "partner"], ["mari", "femme", "épouse", "époux", "conjoint", "conjointe", "wife", "husband", "spouse", "partner"]],
  [["sœur", "frère", "sister", "brother"], ["sœur", "frère", "sister", "brother"]],
  [["nièce", "neveu", "niece", "nephew"], ["oncle", "tante", "uncle", "aunt"]],
  [["filleul", "filleule", "godson", "goddaughter"], ["parrain", "marraine", "godfather", "godmother"]],
  [["manager", "chef", "cheffe", "patron", "patronne", "boss"], ["collaborateur", "collaboratrice", "équipe", "employé", "employée", "report"]],
] as Array<[string[], string[]]>).flatMap(([labels, inverse]) => labels.map((label) => [normaliseName(label), inverse] as [string, string[]])));

export interface RelevantMemories {
  /// Admitted memories, best first, with the entity they are shown under.
  items: Array<{ id: string; score: number; entity: string | null }>;
  /// How they were found: with vectors, by words and entities only, or not
  /// looked for (small talk, a mode without them).
  retrieval: "hybrid" | "lexical" | "skipped";
  ms: number;
  /// Asked for (a dry run's `explain`): the best-scored memories, admitted
  /// or not, with what their score is made of.
  explained?: Array<{ id: string; score: number; c: number | null; l: number; e: number; p: number; ok: boolean; rare: boolean; personal: boolean }>;
}

/// How a memory names an entity: by its name or a proper alias; only by an
/// alias that is a common noun (« le chien » in « Le chien de Paul… »: maybe
/// someone else's); or as the one something belongs to (« La sœur de Nadia
/// Chevalier est pharmacienne »: about her sister, not about her).
type Link = { entity: string; how: "strong" | "noun" | "owner" };

/// Words that, before « de <someone> », make the memory about someone else.
const BELONGS = new Set([
  ...[...KINSHIP.values()].flatMap((labels) => [...labels]).flatMap((label) => label.split(" ")),
  "parents", "enfants", "jumeaux", "voisin", "voisine", "voisins", "ami", "amie", "amis", "collegue", "collegues", "chien", "chienne", "chat", "chatte",
].filter((word) => word.length >= 3));

function linksOf(userId: string, texts?: Map<string, string>): Map<string, Link[]> {
  const rows = sqlite.prepare(
    "SELECT me.memory_id, me.entity_id, me.how, e.norm FROM memory_entities me JOIN entities e ON e.id = me.entity_id WHERE e.user_id = ? AND e.merged_into IS NULL AND e.archived_at IS NULL",
  ).all(userId) as Array<{ memory_id: string; entity_id: string; how: string; norm: string }>;
  const proper = new Map<string, string[]>();
  const properOf = (entityId: string, norm: string) => {
    let names = proper.get(entityId);
    if (!names) {
      names = [norm, ...aliasesOf(entityId).map(normaliseName).filter((alias) => alias && !DETERMINER.test(`${alias} `))];
      proper.set(entityId, names);
    }
    return names;
  };
  const out = new Map<string, Link[]>();
  for (const row of rows) {
    let how: Link["how"] = "strong";
    const text = texts?.get(row.memory_id);
    if (text !== undefined) {
      const padded = ` ${normaliseName(text)} `;
      const names = properOf(row.entity_id, row.norm).filter((name) => padded.includes(` ${name} `));
      if (names.length === 0) how = "noun";
      else if (names.every((name) => ownerOnly(padded, name))) how = "owner";
    }
    out.set(row.memory_id, [...(out.get(row.memory_id) ?? []), { entity: row.entity_id, how }]);
  }
  return out;
}

/// Where a text first names one of these (its length when none).
function firstMention(padded: string, names: string[]): number {
  let first = padded.length;
  for (const name of names) {
    const at = padded.indexOf(` ${name} `);
    if (at >= 0 && at < first) first = at;
  }
  return first;
}

/// Every mention of `name` is as an owner: « la sœur de Nadia Chevalier ».
function ownerOnly(padded: string, name: string): boolean {
  let at = padded.indexOf(` ${name} `);
  let mentions = 0;
  while (at >= 0) {
    mentions += 1;
    const before = padded.slice(Math.max(0, at - 40), at).trim().split(" ");
    const [noun, of] = before.slice(-2);
    if (!(of && ["de", "d", "du", "des"].includes(of) && noun && BELONGS.has(noun))) return false;
    at = padded.indexOf(` ${name} `, at + 1);
  }
  return mentions > 0;
}

/// The words that named them are resolved: what they say is the entity, not
/// a word to look for (« ma femme » is Élodie, not every fact with « femme »).
function queryEntities(userId: string, query: string, selfId: string | null): { weights: Map<string, number>; namesSomeone: boolean; resolved: Set<string> } {
  const weights = new Map<string, number>();
  const resolved = new Set<string>();
  const resolve = (phrase: string) => {
    for (const word of normaliseName(phrase).split(" ")) if (!POSSESSIVE.has(word)) resolved.add(word);
  };
  let namesSomeone = false;
  const personal = firstPerson(query);
  const padded = ` ${normaliseName(query)} `;
  const words = new Set(padded.trim().split(" "));
  const direct: string[] = [];
  const kinship = kinshipIn(query);
  for (const link of entitiesInText(userId, query)) {
    if (link.entity_id === selfId) continue;
    if (link.how === "alias") {
      // « le chien de mes parents » is someone else's dog.
      const said = aliasesOf(link.entity_id).map(normaliseName)
        .filter((alias) => padded.includes(` ${alias} `) && !(DETERMINER.test(`${alias} `) && new RegExp(` ${alias} (?:de|du|des|d|of) `).test(padded)));
      if (said.length === 0) continue;
      const proper = said.some((alias) => !DETERMINER.test(`${alias} `));
      if (!proper && !personal) continue;
      if (proper) namesSomeone = true;
      said.forEach(resolve);
    } else if (link.how === "name") {
      namesSomeone = true;
      const entity = findEntity(userId, link.entity_id);
      if (entity) resolve(entity.name);
    } else {
      kinship.forEach((kin) => resolve(kin.phrase));
    }
    weights.set(link.entity_id, ENTITY_DIRECT);
    direct.push(link.entity_id);
  }
  // One hop, when the message says the relation: « la fille de ma sœur »
  // leads from Sophie to Inès by « fille ». (Any neighbour, said or not, let
  // in their every fact: worse on the bench.)
  const raise = (id: string, weight: number) => {
    if (id !== selfId && (weights.get(id) ?? 0) < weight) weights.set(id, weight);
  };
  const says = (label: string) => {
    const said = normaliseName(label).split(" ").every((word) => words.has(word));
    if (said) resolve(label);
    return said;
  };
  // The person's own relation said as what they do: « le projet que je
  // pilote », « j'habite » (not « mon beau-frère »: a noun there).
  if (selfId && personal) {
    const sequence = padded.trim().split(" ");
    for (const relation of relationsOf(selfId)) {
      const label = normaliseName(relation.label).split(" ");
      const at = sequence.findIndex((_, i) => label.every((word, k) => sequence[i + k] === word));
      if (at >= 0 && SUBJECT.has(sequence[at - 1] ?? "")) {
        resolve(relation.label);
        raise(relation.to, ENTITY_DIRECT);
      }
    }
  }
  for (const id of direct) {
    for (const relation of relationsOf(id)) if (says(relation.label)) raise(relation.to, ENTITY_DIRECT);
    // Backwards: Élodie → Léa « fille » makes Élodie « la mère » of Léa.
    for (const relation of relatedFrom(id)) {
      const inverse = INVERSE.get(normaliseName(relation.label)) ?? [];
      if (inverse.filter(says).length > 0) raise(relation.from, ENTITY_DIRECT);
    }
  }
  return { weights, namesSomeone, resolved };
}

/// The memories a message bears on. Never throws: a failure is a turn
/// without them.
export async function retrieveMemories(args: {
  userId: string;
  query: string;
  memories: MemoryRow[];
  mode: MemoryMode;
  documentMode?: string | null;
  /// τ for this call (the bench's sweep): the threshold of the mode in use.
  tau?: number | null;
  waitMs?: number;
  now?: number;
  explain?: boolean;
}): Promise<RelevantMemories> {
  const started = performance.now();
  const done = (items: RelevantMemories["items"], retrieval: RelevantMemories["retrieval"]): RelevantMemories =>
    ({ items, retrieval, ms: Math.round((performance.now() - started) * 10) / 10 });
  const query = args.query.trim();
  if (args.mode !== "full" || args.documentMode === "only" || !query || smallTalk(query)) return done([], "skipped");
  try {
    const pool = args.memories.filter((memory): memory is MemoryRow & { id: string } => !!memory.id && !memory.archived && !!memory.content.trim());
    if (pool.length === 0) return done([], "skipped");

    ensureLinked(args.userId);
    const self = selfOf(args.userId)?.id ?? null;
    const links = linksOf(args.userId, new Map(pool.map((memory) => [memory.id, `${memory.title ?? ""} ${memory.content}`])));
    const reached = queryEntities(args.userId, query, self);

    let queryVector: Float32Array | null = null;
    let vectors: Map<string, Float32Array> | null = null;
    if (memoryEmbeddingsEnabled(args.userId)) {
      vectors = memoryVectors(args.userId);
      // Asked even with no memory embedded yet: the engine warms for the
      // next turn.
      const asked = embedMemoryQuery(query);
      asked.catch(() => undefined);
      if (vectors.size > 0) {
        let timer: NodeJS.Timeout | undefined;
        queryVector = await Promise.race([
          asked.catch(() => null),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), args.waitMs ?? QUERY_WAIT_MS); }),
        ]);
        if (timer) clearTimeout(timer);
      }
    }

    const items: RankItem[] = pool.map((memory) => ({
      text: memory.title?.trim() && !memory.content.trim().startsWith(memory.title.trim().replace(/…$/, "")) ? `${memory.title.trim()}: ${memory.content}` : memory.content,
      manual: !!memory.manual || !!memory.pinned,
      importance: memory.importance,
      createdAt: memory.createdAt ?? null,
      vector: queryVector ? vectors?.get(memory.id) ?? null : null,
      entities: (links.get(memory.id) ?? []).map((link) => link.entity),
      nounEntities: (links.get(memory.id) ?? []).filter((link) => link.how === "noun").map((link) => link.entity),
      ownerEntities: (links.get(memory.id) ?? []).filter((link) => link.how === "owner").map((link) => link.entity),
      // Learned from the person or written by them: about them, named or not.
      aboutPerson: !!memory.manual || memory.source === "conversation",
    }));
    const options = { queryVector, queryEntities: reached.weights, namesSomeone: reached.namesSomeone, resolvedWords: reached.resolved, self, tau: args.tau ?? null, now: args.now };
    const ranked = rankMemories(items, query, options);
    const round = (x: number) => Math.round(x * 1000) / 1000;
    const explained = args.explain
      ? scoreMemories(items, query, options).sort((a, b) => b.score - a.score).slice(0, 60)
        .map((entry) => ({ id: pool[entry.index]!.id, score: round(entry.score), c: entry.c === null ? null : round(entry.c), l: round(entry.l), e: entry.e, p: round(entry.p), ok: entry.ok, rare: entry.rare, personal: entry.personal }))
      : undefined;
    const names = new Map(listEntities(args.userId).map((entity) => [entity.id, entity.name]));
    // Shown under the entity the message reaches it by, else the first other
    // one it names.
    const shownUnder = (index: number, entity: string | null) => {
      if (entity) return names.get(entity) ?? null;
      const other = (items[index]!.entities ?? []).find((id) => id !== self && names.has(id));
      return other ? names.get(other)! : null;
    };
    return {
      ...done(
        ranked.map((entry) => ({ id: pool[entry.index]!.id, score: round(entry.score), entity: shownUnder(entry.index, entry.entity) })),
        queryVector ? "hybrid" : "lexical",
      ),
      ...(explained ? { explained } : {}),
    };
  } catch {
    return done([], "skipped");
  }
}

/// What the profile is made of beyond the memories themselves: which are the
/// person's own facts (linked to their entity), how often each was given,
/// and one line of the people and places of their life, from the graph.
const usesOfDay = new Map<string, { day: string; uses: Record<string, number> }>();

/// Forgets the day's counts (tests).
export function forgetUsesOfDay() {
  usesOfDay.clear();
}

export function profileHints(userId: string, memories: MemoryRow[]): ProfileHints {
  try {
    ensureLinked(userId);
    const self = selfOf(userId);
    const selfIds = self
      ? (sqlite.prepare("SELECT memory_id FROM memory_entities WHERE entity_id = ?").all(self.id) as Array<{ memory_id: string }>).map((row) => row.memory_id)
      : null;
    // How often each was given, as it stood at the day's first turn: the
    // profile it orders stays the same all day, and the runtime reuses it
    // from one conversation to the next instead of reading it again (it
    // shifted at nearly every answer, 01/10/2026).
    const day = new Date().toDateString();
    let uses = usesOfDay.get(userId)?.day === day ? usesOfDay.get(userId)!.uses : null;
    if (!uses) {
      uses = {};
      for (const row of sqlite.prepare("SELECT memory_id, uses FROM memory_usage WHERE user_id = ? AND uses > 0").all(userId) as Array<{ memory_id: string; uses: number }>) {
        uses[row.memory_id] = row.uses;
      }
      usesOfDay.set(userId, { day, uses });
    }
    return { selfIds, uses, graph: self ? graphLine(self.id) : null, peopleIds: self ? peopleFacts(userId, self.id, memories) : [], projects: projectsLine(userId) };
  } catch {
    return { selfIds: null, uses: {}, graph: null };
  }
}

/// For each of the person's relations, in their order, the fact that best
/// says who that one is to them: one of the person's own (it names them)
/// that says the relation (« marié », « enfants », « habite »), a core one
/// (family, home, work), about that one rather than several. A fact that
/// says the relation of several (« Mathieu et Élodie ont deux enfants : Léa
/// et Hugo ») stands for all of them; none that is neither the person's own
/// nor says the relation (« Les parents de Karim habitent à Marseille »).
function peopleFacts(userId: string, selfId: string, memories: MemoryRow[]): string[] {
  const links = new Map([...linksOf(userId)].map(([id, linked]) => [id, linked.map((link) => link.entity)] as const));
  const facts = memories
    .filter((memory) => memory.id && !memory.archived && !memory.sensitive && memory.kind !== "reference")
    .map((memory) => ({ memory, words: memoryWords(`${memory.title ?? ""} ${memory.content}`), text: ` ${normaliseName(memory.content)} `, linked: links.get(memory.id!) ?? [] }));
  const known = new Map<string, string[]>();
  const names = (entityId: string) => {
    let list = known.get(entityId);
    if (!list) {
      const entity = findEntity(userId, entityId);
      list = entity ? [entity.norm, ...aliasesOf(entityId).map(normaliseName)] : [];
      known.set(entityId, list);
    }
    return list;
  };
  const relations = relationsOf(selfId);
  const says = (words: string[], label: string) => {
    const kin = [...kinLabels(label)].flatMap((name) => name.split(" "));
    return words.some((word) => kin.some((k) => inflected(k, word)));
  };
  const taken: string[] = [];
  const covered = new Set<string>();
  for (const relation of relations) {
    if (covered.has(relation.to)) continue;
    let best: { fact: (typeof facts)[number]; score: number; first: number } | null = null;
    for (const fact of facts) {
      if (!fact.linked.includes(relation.to) || taken.includes(fact.memory.id!)) continue;
      const own = fact.linked.includes(selfId);
      // The relation, or one another of theirs has with them (Karim is « le
      // mari » of Sophie).
      const said = says(fact.words, relation.label) || relatedFrom(relation.to).some((other) => other.from !== selfId && fact.linked.includes(other.from) && says(fact.words, other.label));
      if (!own && !said) continue;
      const others = fact.linked.filter((id) => id !== selfId).length;
      const score = (own ? 2 : 0) + (said ? 1.5 : 0) + (coreFact(fact.memory.content) ? 0.5 : 0) - 0.5 * Math.max(0, others - 1);
      // Ties: the one that names them first (about them, « Karim Benali, le
      // mari de Sophie… »), then the oldest, what was said first about them.
      const first = firstMention(fact.text, names(relation.to));
      if (!best || score > best.score || (score === best.score && (first < best.first || (first === best.first && (fact.memory.createdAt ?? 0) < (best.fact.memory.createdAt ?? 0))))) {
        best = { fact, score, first };
      }
    }
    if (!best) continue;
    taken.push(best.fact.memory.id!);
    // It stands for the others it names when it says their relation too.
    for (const other of relations) {
      if (best.fact.linked.includes(other.to) && (other.to === relation.to || says(best.fact.words, other.label))) covered.add(other.to);
    }
  }
  return taken;
}

const GRAPH_CHARS = 700;

/// « Élodie Garnier (épouse), Léa Garnier (fille), … »: the person's
/// relations, one name each with its labels, in the order they were given.
function graphLine(selfId: string): string | null {
  const byName = new Map<string, string[]>();
  for (const relation of relationsOf(selfId)) {
    const labels = byName.get(relation.to_name) ?? [];
    if (!labels.includes(relation.label)) labels.push(relation.label);
    byName.set(relation.to_name, labels);
  }
  if (byName.size === 0) return null;
  const parts: string[] = [];
  let chars = 0;
  for (const [name, labels] of byName) {
    const part = `${name} (${labels.join(", ")})`;
    if (chars + part.length + 2 > GRAPH_CHARS) break;
    parts.push(part);
    chars += part.length + 2;
  }
  return `The user's people, places and projects: ${parts.join(", ")}.`;
}

/// The memories a turn gave with its message: counted, for the profile's
/// « most used ». Kept on this computer only.
export function noteMemoryUse(userId: string, ids: Array<string | null>, now = Date.now()) {
  const given = ids.filter((id): id is string => !!id);
  if (given.length === 0) return;
  try {
    const put = sqlite.prepare(
      `INSERT INTO memory_usage (memory_id, user_id, uses, last_used_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(memory_id) DO UPDATE SET uses = uses + 1, last_used_at = excluded.last_used_at`,
    );
    sqlite.transaction(() => {
      for (const id of given) put.run(id, userId, now);
    })();
  } catch {
    /* a count is no reason to fail a turn */
  }
}

/// Every memory of this person embedded before a dry run (POST
/// /memories/retrieve measures retrieval with an index up to date), for
/// `timeoutMs` at most. False when some are still missing.
export async function settleMemoryVectors(userId: string, timeoutMs = 20_000): Promise<boolean> {
  if (!memoryEmbeddingsEnabled(userId)) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = memoryEmbeddingStatus(userId);
    if (status.indexed >= status.total) return true;
    if (Date.now() > deadline || status.error) return false;
    // The background job may hold this person: then wait for it.
    if (status.running) await new Promise((resolve) => setTimeout(resolve, 100));
    else await Promise.race([embedPendingMemories(userId, { busy: () => false }), new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))]);
  }
}
