import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";
import { isRelationKind, kindsOfWord, kinshipMentions, wordsOfKind, type RelationKind } from "../people/kinship.js";

// The people, projects, places… the person's memories are about
// (docs/memory-v2-design.md §2, lot L2): entities with their other names
// (entity_aliases: « Élo », « ma grande ») and how they relate
// (entity_relations: Mathieu → Élodie « épouse »), and which memory names
// which (memory_entities, worked out here on each computer).
//
// A memory names an entity by its name or one of its aliases, or by a
// kinship phrase of the person's own (« ma femme », « my boss »): the
// lexicon below gives the relation labels such a phrase means, and the
// person's own entity (kind « self ») the relations to follow. Retrieval
// v2 (src/memory/retrieve.ts) reads the links.

export const ENTITY_KINDS = ["self", "person", "project", "place", "org", "pet", "other"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const MAX_NAME = 200;
export const MAX_NOTE = 2000;
export const MAX_ALIASES = 32;
export const MAX_ALIAS = 100;
export const MAX_RELATIONS = 64;
export const MAX_LABEL = 64;

/// Accents, case, ligatures and punctuation removed, words separated by
/// one space: « Belle-Sœur » → « belle soeur ».
export function normaliseName(text: string): string {
  return text
    .replace(/œ/g, "oe").replace(/Œ/g, "oe").replace(/æ/g, "ae").replace(/Æ/g, "ae")
    .normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
}

// ── the kinship lexicon ──────────────────────────────────────────────────

/// What « ma femme » means: the relation labels it stands for, in French
/// and English (a relation is labelled in the person's own words).
type Kin = { labels: string[]; phrases: string[] };

const KIN: Kin[] = [
  { labels: ["épouse", "époux", "femme", "mari", "conjoint", "conjointe", "compagnon", "compagne", "wife", "husband", "spouse", "partner", "partenaire"],
    phrases: ["ma femme", "mon épouse", "mon mari", "mon époux", "mon conjoint", "ma conjointe", "mon compagnon", "ma compagne", "my wife", "my husband", "my spouse", "my partner"] },
  { labels: ["fille", "daughter"], phrases: ["ma fille", "my daughter"] },
  { labels: ["fils", "son"], phrases: ["mon fils", "my son"] },
  { labels: ["fille", "fils", "enfant", "daughter", "son", "child"], phrases: ["mes enfants", "mes gosses", "my children", "my kids"] },
  { labels: ["mère", "maman", "mother", "mom", "mum"], phrases: ["ma mère", "maman", "my mother", "my mom", "my mum"] },
  { labels: ["père", "papa", "father", "dad"], phrases: ["mon père", "papa", "my father", "my dad"] },
  { labels: ["mère", "père", "maman", "papa", "mother", "father"], phrases: ["mes parents", "my parents"] },
  { labels: ["sœur", "sister"], phrases: ["ma sœur", "my sister"] },
  { labels: ["frère", "brother"], phrases: ["mon frère", "my brother"] },
  { labels: ["grand-mère", "mamie", "grandmother", "grandma"], phrases: ["ma grand-mère", "mamie", "my grandmother", "my grandma"] },
  { labels: ["grand-père", "papi", "grandfather", "grandpa"], phrases: ["mon grand-père", "papi", "my grandfather", "my grandpa"] },
  { labels: ["oncle", "uncle"], phrases: ["mon oncle", "my uncle"] },
  { labels: ["tante", "aunt"], phrases: ["ma tante", "my aunt"] },
  { labels: ["neveu", "nephew"], phrases: ["mon neveu", "my nephew"] },
  { labels: ["nièce", "niece"], phrases: ["ma nièce", "my niece"] },
  { labels: ["cousin", "cousine"], phrases: ["mon cousin", "ma cousine", "my cousin"] },
  { labels: ["filleul", "filleule", "godson", "goddaughter", "godchild"], phrases: ["mon filleul", "ma filleule", "my godson", "my goddaughter"] },
  { labels: ["beau-frère", "brother-in-law"], phrases: ["mon beau-frère", "my brother-in-law"] },
  { labels: ["belle-sœur", "sister-in-law"], phrases: ["ma belle-sœur", "my sister-in-law"] },
  { labels: ["belle-mère", "mother-in-law"], phrases: ["ma belle-mère", "my mother-in-law"] },
  { labels: ["beau-père", "father-in-law"], phrases: ["mon beau-père", "my father-in-law"] },
  { labels: ["manager", "chef", "cheffe", "patron", "patronne", "boss", "supérieur", "n+1"],
    phrases: ["mon chef", "ma cheffe", "mon patron", "ma patronne", "mon manager", "ma manager", "mon boss", "my boss", "my manager"] },
  { labels: ["collègue", "colleague", "coworker"], phrases: ["mon collègue", "ma collègue", "mes collègues", "my colleague", "my coworker", "my colleagues"] },
  { labels: ["ami", "amie", "meilleur ami", "meilleure amie", "friend", "best friend"],
    phrases: ["mon ami", "mon amie", "mon meilleur ami", "ma meilleure amie", "my friend", "my best friend"] },
  { labels: ["chien", "chienne", "dog"], phrases: ["mon chien", "ma chienne", "my dog"] },
  { labels: ["chat", "chatte", "cat"], phrases: ["mon chat", "ma chatte", "my cat"] },
  { labels: ["employeur", "entreprise", "boîte", "employer", "company"], phrases: ["mon employeur", "mon entreprise", "ma boîte", "my employer", "my company"] },
  { labels: ["habite", "domicile", "maison", "appartement", "home", "lives in"], phrases: ["chez moi", "ma maison", "mon appartement", "my home", "my house", "my flat"] },
  { labels: ["médecin", "docteur", "doctor"], phrases: ["mon médecin", "mon docteur", "my doctor"] },
];

/// The same phrase said of « us »: « notre fille », « nos enfants », « our dog ».
function plural(phrase: string): string[] {
  const m = /^(ma|mon|mes|my) (.+)$/.exec(phrase);
  if (!m) return [];
  return m[1] === "my" ? [`our ${m[2]}`] : m[1] === "mes" ? [`nos ${m[2]}`] : [`notre ${m[2]}`];
}

/// Every kinship phrase, normalised, with the labels it stands for.
export const KINSHIP: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const kin of KIN) {
    const labels = kin.labels.map(normaliseName);
    for (const phrase of kin.phrases.flatMap((p) => [p, ...plural(p)])) {
      const key = normaliseName(phrase);
      map.set(key, new Set([...(map.get(key) ?? []), ...labels]));
    }
  }
  return map;
})();

/// The labels that say the same relation as this one, or a wider one
/// (« fille » → fille, daughter, enfant, child…), normalised.
export function kinLabels(label: string): Set<string> {
  const norm = normaliseName(label);
  const out = new Set([norm]);
  for (const kin of KIN) {
    const labels = kin.labels.map(normaliseName);
    if (labels.includes(norm)) for (const other of labels) out.add(other);
  }
  // The same relation in the app's ten languages (« Mutter », « madre »,
  // « 엄마 »): docs/people-design.md §4.
  for (const kind of kindsOfWord(label)) for (const word of kindWords(kind)) out.add(word);
  return out;
}

const KIND_WORD_CACHE = new Map<RelationKind, string[]>();

/// Every word of a kind of relation, folded as names are here.
export function kindWords(kind: RelationKind): string[] {
  let words = KIND_WORD_CACHE.get(kind);
  if (!words) {
    words = [...new Set(wordsOfKind(kind).map((word) => normaliseName(word) || word))];
    KIND_WORD_CACHE.set(kind, words);
  }
  return words;
}

/// The kind of a relation: its own, else what its label says (one kind only).
export function relationKind(kind: string | null | undefined, label: string): RelationKind | null {
  if (isRelationKind(kind)) return kind;
  const kinds = kindsOfWord(label);
  return kinds.length === 1 ? kinds[0]! : null;
}

/// The kinship phrases a text says, each with its labels.
export function kinshipIn(text: string): Array<{ phrase: string; labels: ReadonlySet<string> }> {
  const padded = ` ${normaliseName(text)} `;
  const found: Array<{ phrase: string; labels: ReadonlySet<string> }> = [];
  for (const [phrase, labels] of KINSHIP) if (padded.includes(` ${phrase} `)) found.push({ phrase, labels });
  // The other languages of the app, and their words for one's own
  // relatives (« meine Mutter », « mi madre », « 母 », « 우리 엄마 »):
  // never someone else's (« la mère de Paul », « 友達の母 »). One that owns
  // another (« de zus van mijn vrouw », « 妻の姉妹 ») is named too.
  const said = new Set(found.map((kin) => kin.phrase));
  for (const mention of kinshipMentions(text)) {
    if (!mention.own) continue;
    const phrase = mention.script === "latin" ? normaliseName(mention.phrase) : mention.phrase;
    if (said.has(phrase)) continue;
    said.add(phrase);
    // The word said too (« nipote » says five kinds and is none of theirs).
    const word = phrase.split(" ").at(-1) ?? phrase;
    found.push({ phrase, labels: new Set([...mention.kinds.flatMap((kind) => kindWords(kind)), phrase, word]) });
  }
  return found;
}

// ── rows ─────────────────────────────────────────────────────────────────

export type EntityRow = {
  id: string; user_id: string; kind: string; name: string; norm: string; note: string | null; source: string;
  merged_into: string | null; hlc: string | null; vault_event_id: string | null; created_at: number; updated_at: number;
  /// « Retirer de vos proches » (migration 12, named `archived_at` by
  /// migration 14: hidden but restorable): kept, hidden from the live graph
  /// until restored. findEntity still finds it (its page, « Rétablir »).
  archived_at?: number | null;
};

const byId = (id: string) => sqlite.prepare("SELECT * FROM entities WHERE id = ?").get(id) as EntityRow | undefined;

/// An entity of this person, followed through merges to the one it is now.
export function findEntity(userId: string, id: string): EntityRow | null {
  let row = byId(id);
  for (let hops = 0; row && row.merged_into && hops < 16; hops++) row = byId(row.merged_into);
  return row && row.user_id === userId && !row.merged_into ? row : null;
}

/// This person's entities, merged and removed ones left out unless asked for.
export function listEntities(userId: string, includeMerged = false): EntityRow[] {
  return sqlite.prepare(`SELECT * FROM entities WHERE user_id = ? ${includeMerged ? "" : "AND merged_into IS NULL AND archived_at IS NULL"} ORDER BY kind = 'self' DESC, name COLLATE NOCASE, id`).all(userId) as EntityRow[];
}

function liveByNorm(userId: string, norm: string): EntityRow | undefined {
  return sqlite.prepare("SELECT * FROM entities WHERE user_id = ? AND norm = ? AND merged_into IS NULL ORDER BY created_at, rowid LIMIT 1").get(userId, norm) as EntityRow | undefined;
}

export function selfOf(userId: string): EntityRow | undefined {
  return sqlite.prepare("SELECT * FROM entities WHERE user_id = ? AND kind = 'self' AND merged_into IS NULL ORDER BY created_at, rowid LIMIT 1").get(userId) as EntityRow | undefined;
}

export function aliasesOf(entityId: string): string[] {
  return (sqlite.prepare("SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY rowid").all(entityId) as Array<{ alias: string }>).map((r) => r.alias);
}

export function relationsOf(entityId: string): Array<{ to: string; to_name: string; label: string; kind: string | null }> {
  return sqlite.prepare(
    "SELECT r.to_id AS \"to\", e.name AS to_name, r.label, r.kind FROM entity_relations r JOIN entities e ON e.id = r.to_id WHERE r.from_id = ? AND e.archived_at IS NULL ORDER BY r.rowid",
  ).all(entityId) as Array<{ to: string; to_name: string; label: string; kind: string | null }>;
}

export function relatedFrom(entityId: string): Array<{ from: string; from_name: string; label: string; kind: string | null }> {
  return sqlite.prepare(
    "SELECT r.from_id AS \"from\", e.name AS from_name, r.label, r.kind FROM entity_relations r JOIN entities e ON e.id = r.from_id WHERE r.to_id = ? AND e.archived_at IS NULL ORDER BY r.rowid",
  ).all(entityId) as Array<{ from: string; from_name: string; label: string; kind: string | null }>;
}

export function memoryIdsOf(entityId: string): string[] {
  return (sqlite.prepare("SELECT memory_id FROM memory_entities WHERE entity_id = ? ORDER BY memory_id").all(entityId) as Array<{ memory_id: string }>).map((r) => r.memory_id);
}

// ── writes ───────────────────────────────────────────────────────────────

export type EntityInput = {
  kind?: EntityKind;
  name?: string;
  note?: string | null;
  aliases?: string[];
  /// To an entity by its id, or by its name (one not there yet is made,
  /// to be filled in when it is written in turn).
  relations?: Array<{ to: string; label: string; kind?: RelationKind | null }>;
};

export class EntityError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly entityId?: string) {
    super(code);
  }
}

/// A request body's entity, checked; throws EntityError(422) otherwise.
export function readEntityInput(raw: unknown, creating: boolean): EntityInput {
  const body = (raw && typeof raw === "object" ? (raw as { entity?: unknown }).entity : null) as Record<string, unknown> | null | undefined;
  if (!body || typeof body !== "object") throw new EntityError(422, "entity_required");
  const out: EntityInput = {};
  if (body.kind !== undefined) {
    if (!(ENTITY_KINDS as readonly string[]).includes(String(body.kind))) throw new EntityError(422, "invalid_kind");
    out.kind = body.kind as EntityKind;
  }
  if (body.name !== undefined || creating) {
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > MAX_NAME || !normaliseName(name)) throw new EntityError(422, "invalid_name");
    out.name = name;
  }
  if (body.note !== undefined) {
    if (body.note !== null && (typeof body.note !== "string" || body.note.length > MAX_NOTE)) throw new EntityError(422, "invalid_note");
    out.note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  }
  if (body.aliases !== undefined) {
    if (!Array.isArray(body.aliases) || body.aliases.length > MAX_ALIASES) throw new EntityError(422, "invalid_aliases");
    out.aliases = body.aliases.map((alias) => {
      if (typeof alias !== "string" || !alias.trim() || alias.trim().length > MAX_ALIAS || !normaliseName(alias)) throw new EntityError(422, "invalid_aliases");
      return alias.trim().replace(/\s+/g, " ");
    });
  }
  if (body.relations !== undefined) {
    if (!Array.isArray(body.relations) || body.relations.length > MAX_RELATIONS) throw new EntityError(422, "invalid_relations");
    out.relations = body.relations.map((relation) => {
      const r = relation as { to?: unknown; label?: unknown; kind?: unknown } | null;
      const to = typeof r?.to === "string" ? r.to.trim() : "";
      const label = typeof r?.label === "string" ? r.label.trim().replace(/\s+/g, " ") : "";
      if (!to || to.length > MAX_NAME || !label || label.length > MAX_LABEL) throw new EntityError(422, "invalid_relations");
      if (r?.kind !== undefined && r.kind !== null && !isRelationKind(r.kind)) throw new EntityError(422, "invalid_relations");
      return { to, label, ...(isRelationKind(r?.kind) ? { kind: r.kind } : {}) };
    });
  }
  return out;
}

function setAliases(entity: EntityRow, aliases: string[]) {
  sqlite.prepare("DELETE FROM entity_aliases WHERE entity_id = ?").run(entity.id);
  addAliases(entity, aliases);
}

function addAliases(entity: EntityRow, aliases: string[]) {
  const put = sqlite.prepare("INSERT OR IGNORE INTO entity_aliases (entity_id, alias, norm) VALUES (?, ?, ?)");
  for (const alias of aliases) {
    const norm = normaliseName(alias);
    // Its own name is no other name.
    if (norm && norm !== entity.norm) put.run(entity.id, alias, norm);
  }
}

function insertEntity(userId: string, fields: { kind: string; name: string; note: string | null; source: string }, now: number): EntityRow {
  const id = randomUUID();
  sqlite.prepare("INSERT INTO entities (id, user_id, kind, name, norm, note, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, fields.kind, fields.name, normaliseName(fields.name), fields.note, fields.source, now, now);
  return byId(id)!;
}

/// The entity a relation points to: by id, else by name or alias — a name
/// nobody has yet becomes an entity of its own (source « stub »).
function relationTarget(userId: string, to: string, now: number): EntityRow {
  const known = findEntity(userId, to);
  if (known) return known;
  const norm = normaliseName(to);
  const named = liveByNorm(userId, norm)
    ?? (sqlite.prepare(
      "SELECT e.* FROM entity_aliases a JOIN entities e ON e.id = a.entity_id WHERE e.user_id = ? AND a.norm = ? AND e.merged_into IS NULL ORDER BY e.created_at LIMIT 1",
    ).get(userId, norm) as EntityRow | undefined);
  if (named) return named;
  if (!norm) throw new EntityError(422, "invalid_relations");
  return insertEntity(userId, { kind: "other", name: to.slice(0, MAX_NAME), note: null, source: "stub" }, now);
}

/// A relation as it was before being written again: its id and dates are
/// kept (migration 14), its source too unless said otherwise.
export interface RelationBefore { id: string; kind: string | null; source: string | null; created_at: number; updated_at: number }

export function relationsBefore(where: string, ...args: unknown[]): Map<string, RelationBefore> {
  const rows = sqlite.prepare(`SELECT id, from_id, to_id, label, kind, source, created_at, updated_at FROM entity_relations WHERE ${where}`).all(...args) as Array<RelationBefore & { from_id: string; to_id: string; label: string }>;
  return new Map(rows.map((row) => [`${row.from_id}\n${row.to_id}\n${row.label}`, row]));
}

/// One relation written (`INSERT OR IGNORE`: the pair and label are unique).
/// Written again as it was, it keeps its id and dates; changed, its
/// `updated_at` is now; new, it gets an id of its own.
export function putRelation(from: string, to: string, label: string, kind: string | null, source: string, now: number, before?: RelationBefore | null) {
  const same = !!before && before.kind === kind && before.source === source;
  sqlite
    .prepare("INSERT OR IGNORE INTO entity_relations (id, from_id, to_id, label, kind, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(before?.id ?? randomUUID(), from, to, label, kind, source, before?.created_at ?? now, same ? before!.updated_at : now);
}

function setRelations(entity: EntityRow, relations: Array<{ to: string; label: string; kind?: RelationKind | null }>, now: number) {
  // The source of a relation kept as it was is kept (learned, from a card).
  const before = relationsBefore("from_id = ?", entity.id);
  sqlite.prepare("DELETE FROM entity_relations WHERE from_id = ?").run(entity.id);
  for (const relation of relations) {
    const target = relationTarget(entity.user_id, relation.to, now);
    if (target.id === entity.id) continue;
    const kept = before.get(`${entity.id}\n${target.id}\n${relation.label}`) ?? null;
    putRelation(entity.id, target.id, relation.label, relationKind(relation.kind, relation.label), kept?.source ?? "manual", now, kept);
  }
}

function checkSelf(userId: string, kind: string | undefined, except: string | null) {
  if (kind !== "self") return;
  const self = selfOf(userId);
  if (self && self.id !== except) throw new EntityError(409, "self_exists", self.id);
}

/// A new entity — or the one a relation made for that name, filled in.
export function createEntity(userId: string, input: EntityInput, now = Date.now()): { entity: EntityRow; created: boolean } {
  return sqlite.transaction(() => {
    const name = input.name!;
    const norm = normaliseName(name);
    const existing = liveByNorm(userId, norm);
    if (existing && existing.source !== "stub") throw new EntityError(409, "name_taken", existing.id);
    checkSelf(userId, input.kind, existing?.id ?? null);
    let entity: EntityRow;
    if (existing) {
      sqlite.prepare("UPDATE entities SET kind = ?, name = ?, note = ?, source = 'manual', updated_at = ? WHERE id = ?")
        .run(input.kind ?? "person", name, input.note ?? existing.note, now, existing.id);
      entity = byId(existing.id)!;
    } else {
      entity = insertEntity(userId, { kind: input.kind ?? "person", name, note: input.note ?? null, source: "manual" }, now);
    }
    if (input.aliases) addAliases(entity, input.aliases);
    if (input.relations) setRelations(entity, input.relations, now);
    return { entity: byId(entity.id)!, created: !existing };
  })();
}

/// An entity changed: the fields given, aliases and relations replaced whole.
export function updateEntity(userId: string, id: string, input: EntityInput, now = Date.now()): EntityRow {
  return sqlite.transaction(() => {
    const entity = findEntity(userId, id);
    if (!entity) throw new EntityError(404, "not_found");
    if (input.name !== undefined) {
      const other = liveByNorm(userId, normaliseName(input.name));
      if (other && other.id !== entity.id && other.source !== "stub") throw new EntityError(409, "name_taken", other.id);
    }
    checkSelf(userId, input.kind, entity.id);
    const name = input.name ?? entity.name;
    sqlite.prepare("UPDATE entities SET kind = ?, name = ?, norm = ?, note = ?, source = CASE WHEN source = 'stub' THEN 'manual' ELSE source END, updated_at = ? WHERE id = ?")
      .run(input.kind ?? entity.kind, name, normaliseName(name), input.note !== undefined ? input.note : entity.note, now, entity.id);
    const updated = byId(entity.id)!;
    if (input.aliases) setAliases(updated, input.aliases);
    else if (updated.norm !== entity.norm) sqlite.prepare("DELETE FROM entity_aliases WHERE entity_id = ? AND norm = ?").run(updated.id, updated.norm);
    if (input.relations) setRelations(updated, input.relations, now);
    return byId(entity.id)!;
  })();
}

/// An entity deleted, with its names, relations and links (and the ones
/// merged into it, which only pointed to it).
export function deleteEntity(userId: string, id: string): boolean {
  return sqlite.transaction(() => {
    const entity = findEntity(userId, id);
    if (!entity) return false;
    const gone = [entity.id];
    for (let i = 0; i < gone.length; i++) {
      for (const r of sqlite.prepare("SELECT id FROM entities WHERE merged_into = ?").all(gone[i]) as Array<{ id: string }>) gone.push(r.id);
    }
    const del = sqlite.prepare("DELETE FROM entities WHERE id = ?");
    for (const gid of gone.reverse()) del.run(gid);
    return true;
  })();
}

/// Two entities that are one (« Élo » and « Élodie Garnier »): the first
/// goes into the second — its name and aliases become aliases there, its
/// relations and links move — and stays as a pointer to it.
export function mergeEntities(userId: string, fromId: string, intoId: string, now = Date.now()): EntityRow {
  return sqlite.transaction(() => {
    const from = findEntity(userId, fromId);
    const into = findEntity(userId, intoId);
    if (!from || !into) throw new EntityError(404, "not_found");
    if (from.id === into.id) throw new EntityError(422, "same_entity");
    addAliases(into, [from.name, ...aliasesOf(from.id)]);
    sqlite.prepare("DELETE FROM entity_aliases WHERE entity_id = ?").run(from.id);
    for (const column of ["from_id", "to_id"] as const) {
      sqlite.prepare(`UPDATE OR IGNORE entity_relations SET ${column} = ?, updated_at = ? WHERE ${column} = ?`).run(into.id, now, from.id);
      sqlite.prepare(`DELETE FROM entity_relations WHERE ${column} = ?`).run(from.id);
    }
    sqlite.prepare("DELETE FROM entity_relations WHERE from_id = ? AND to_id = ?").run(into.id, into.id);
    sqlite.prepare("UPDATE OR IGNORE memory_entities SET entity_id = ? WHERE entity_id = ?").run(into.id, from.id);
    sqlite.prepare("DELETE FROM memory_entities WHERE entity_id = ?").run(from.id);
    sqlite.prepare("UPDATE entities SET merged_into = ? WHERE merged_into = ?").run(into.id, from.id);
    sqlite.prepare("UPDATE entities SET merged_into = ?, updated_at = ? WHERE id = ?").run(into.id, now, from.id);
    // The person's own entity stays theirs, whichever side it was on.
    const kind = from.kind === "self" ? "self" : into.kind === "other" && into.source === "stub" ? from.kind : into.kind;
    const note = into.note ?? from.note;
    sqlite.prepare("UPDATE entities SET kind = ?, note = ?, source = CASE WHEN source = 'stub' THEN ? ELSE source END, updated_at = ? WHERE id = ?")
      .run(kind, note, from.source === "stub" ? "manual" : from.source, now, into.id);
    return byId(into.id)!;
  })();
}

// ── the linker ───────────────────────────────────────────────────────────

export type EntityLink = { entity_id: string; how: "name" | "alias" | "kinship" };

type Matcher = { phrases: Array<{ norm: string; entityId: string; how: "name" | "alias" }>; kin: Map<string, string[]> };

/// What a text can name of this person's entities: names and aliases, and
/// the relation labels from their own entity.
function matcherFor(userId: string): Matcher {
  const live = listEntities(userId);
  const phrases: Matcher["phrases"] = [];
  for (const entity of live) {
    if (entity.norm.length >= 2) phrases.push({ norm: entity.norm, entityId: entity.id, how: "name" });
  }
  const aliases = sqlite.prepare(
    "SELECT a.entity_id, a.norm FROM entity_aliases a JOIN entities e ON e.id = a.entity_id WHERE e.user_id = ? AND e.merged_into IS NULL AND e.archived_at IS NULL",
  ).all(userId) as Array<{ entity_id: string; norm: string }>;
  for (const alias of aliases) if (alias.norm.length >= 2) phrases.push({ norm: alias.norm, entityId: alias.entity_id, how: "alias" });
  const kin = new Map<string, string[]>();
  const self = selfOf(userId);
  if (self) {
    for (const relation of sqlite.prepare("SELECT r.to_id, r.label, r.kind FROM entity_relations r JOIN entities e ON e.id = r.to_id WHERE r.from_id = ? AND e.archived_at IS NULL").all(self.id) as Array<{ to_id: string; label: string; kind: string | null }>) {
      // Its label, and its kind's words in the ten languages: « ma mère »
      // and « meine Mutter » reach a relation labelled « maman ».
      const kind = relationKind(relation.kind, relation.label);
      for (const label of new Set([normaliseName(relation.label), ...(kind ? kindWords(kind) : [])])) {
        const ids = kin.get(label) ?? [];
        if (!ids.includes(relation.to_id)) kin.set(label, [...ids, relation.to_id]);
      }
    }
  }
  return { phrases, kin };
}

function linksWith(matcher: Matcher, text: string): EntityLink[] {
  const padded = ` ${normaliseName(text)} `;
  const links = new Map<string, EntityLink>();
  for (const phrase of matcher.phrases) {
    if (!links.has(phrase.entityId) && padded.includes(` ${phrase.norm} `)) links.set(phrase.entityId, { entity_id: phrase.entityId, how: phrase.how });
  }
  if (matcher.kin.size) {
    for (const { labels } of kinshipIn(text)) {
      for (const label of labels) {
        for (const entityId of matcher.kin.get(label) ?? []) {
          if (!links.has(entityId)) links.set(entityId, { entity_id: entityId, how: "kinship" });
        }
      }
    }
  }
  return [...links.values()];
}

/// The entities a text names (a memory, or a message: what L3 expands).
export function entitiesInText(userId: string, text: string): EntityLink[] {
  return linksWith(matcherFor(userId), text);
}

const stale = new Set<string>();

/// The links are to be worked out again (a memory or an entity changed).
export function markLinksStale(userId: string) {
  stale.add(userId);
}

/// Every memory of this person linked again to the entities it names.
export function relinkMemories(userId: string): number {
  stale.delete(userId);
  const matcher = matcherFor(userId);
  const memories = sqlite.prepare("SELECT id, title, content FROM memories WHERE user_id = ? AND superseded_by_id IS NULL").all(userId) as Array<{ id: string; title: string | null; content: string }>;
  let count = 0;
  sqlite.transaction(() => {
    sqlite.prepare(
      "DELETE FROM memory_entities WHERE entity_id IN (SELECT id FROM entities WHERE user_id = ?) OR memory_id IN (SELECT id FROM memories WHERE user_id = ?)",
    ).run(userId, userId);
    const put = sqlite.prepare("INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, how) VALUES (?, ?, ?)");
    for (const memory of memories) {
      for (const link of linksWith(matcher, `${memory.title ?? ""}\n${memory.content}`)) count += put.run(memory.id, link.entity_id, link.how).changes;
    }
  })();
  return count;
}

/// The links as they should be now, worked out again when stale.
export function ensureLinked(userId: string) {
  if (stale.has(userId)) relinkMemories(userId);
}

/// The entity a project is known by (docs/projects-design.md §2): the one
/// with that name or alias already, else a new one of kind « project »; its
/// other names added. The memories naming it are linked again.
export function projectEntity(userId: string, name: string, aliases: string[] = [], source = "manual", now = Date.now()): EntityRow {
  const entity = sqlite.transaction(() => {
    const norm = normaliseName(name);
    if (!norm) throw new EntityError(422, "invalid_name");
    const known = liveByNorm(userId, norm)
      ?? (sqlite.prepare(
        "SELECT e.* FROM entity_aliases a JOIN entities e ON e.id = a.entity_id WHERE e.user_id = ? AND a.norm = ? AND e.merged_into IS NULL ORDER BY e.created_at LIMIT 1",
      ).get(userId, norm) as EntityRow | undefined);
    const row = known ?? insertEntity(userId, { kind: "project", name: name.trim().slice(0, MAX_NAME), note: null, source }, now);
    // A name a relation made for it (source « stub ») is a project now.
    if (known && known.source === "stub") sqlite.prepare("UPDATE entities SET kind = 'project', source = ?, updated_at = ? WHERE id = ?").run(source, now, known.id);
    addAliases(row, aliases.map((alias) => alias.trim()).filter((alias) => alias && alias.length <= MAX_ALIAS).slice(0, MAX_ALIASES));
    return byId(row.id)!;
  })();
  markLinksStale(userId);
  return entity;
}
