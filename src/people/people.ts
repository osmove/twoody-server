import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";
import { storedValues } from "../contactFields.js";
import {
  aliasesOf, EntityError, findEntity, kindWords, listEntities, markLinksStale, MAX_ALIAS, MAX_ALIASES, MAX_LABEL, MAX_NAME, MAX_NOTE,
  memoryIdsOf, mergeEntities, normaliseName, putRelation, relationKind, relationsBefore, selfOf, type EntityRow,
} from "../memory/entities.js";
import { isRelationKind, KIND_GROUP, kindsOfWord, kindWord, type KindGroup, type RelationKind } from "./kinship.js";

// « Proches » (docs/people-design.md): the person's people — one entity
// each (kind « person »), with their relation to the person (from the
// person's own entity, kind « self »), their links to one another, and the
// contact cards that are theirs (entity_contacts, migration 10).
//
// A card is never copied into the entity: it is read as it is now (a card
// the Mac updates is read updated). Two entities are never merged without
// the person's yes; a card is linked on its own only when sure (§3), else
// proposed in « À confirmer ».

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const LINK_HOWS = ["auto", "confirmed", "manual", "refused"] as const;
export type LinkHow = (typeof LINK_HOWS)[number];

export class PeopleError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

// ── Reading ──────────────────────────────────────────────────────────────

export interface ContactCard {
  id: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  organization: string | null;
  emails: string[];
  phones: string[];
  birthday: string | null;
  source: string | null;
  relation_type: string | null;
  relation_subtype: string | null;
}

interface ContactDbRow {
  id: string; name: string | null; first_name: string | null; last_name: string | null; organization: string | null;
  email: string | null; phone_number: string | null; emails: string | null; phones: string | null; birthday: string | null;
  source: string | null; relation_type: string | null; relation_subtype: string | null;
}

function card(row: ContactDbRow): ContactCard {
  return {
    id: row.id,
    name: row.name || [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
    first_name: row.first_name,
    last_name: row.last_name,
    organization: row.organization,
    emails: row.emails ? storedValues(row.emails) : [row.email].filter((value): value is string => !!value),
    phones: row.phones ? storedValues(row.phones) : [row.phone_number].filter((value): value is string => !!value),
    birthday: row.birthday,
    source: row.source,
    relation_type: row.relation_type,
    relation_subtype: row.relation_subtype,
  };
}

const CONTACT_COLUMNS = "id, name, first_name, last_name, organization, email, phone_number, emails, phones, birthday, source, relation_type, relation_subtype";

export function contactsOf(userId: string, ids: string[]): Map<string, ContactCard> {
  const out = new Map<string, ContactCard>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = sqlite.prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE user_id = ? AND id IN (${chunk.map(() => "?").join(",")})`).all(userId, ...chunk) as ContactDbRow[];
    for (const row of rows) out.set(row.id, card(row));
  }
  return out;
}

export interface PersonLink { entity_id: string; contact_id: string; how: LinkHow }

/// The cards linked to these entities (refused links left out unless asked).
export function linksOf(entityIds: string[], withRefused = false): PersonLink[] {
  if (!entityIds.length) return [];
  const out: PersonLink[] = [];
  for (let i = 0; i < entityIds.length; i += 400) {
    const chunk = entityIds.slice(i, i + 400);
    out.push(...(sqlite.prepare(`SELECT entity_id, contact_id, how FROM entity_contacts WHERE entity_id IN (${chunk.map(() => "?").join(",")}) ${withRefused ? "" : "AND how != 'refused'"} ORDER BY created_at`).all(...chunk) as PersonLink[]));
  }
  return out;
}

/// Whose each card is (a live person's, not refused): for Contacts.
export function peopleOfContacts(userId: string): Map<string, { id: string; name: string }> {
  const rows = sqlite.prepare(`SELECT c.contact_id, e.id, e.name FROM entity_contacts c JOIN entities e ON e.id = c.entity_id
    WHERE e.user_id = ? AND e.merged_into IS NULL AND e.archived_at IS NULL AND c.how != 'refused' ORDER BY c.created_at`).all(userId) as Array<{ contact_id: string; id: string; name: string }>;
  const out = new Map<string, { id: string; name: string }>();
  for (const row of rows) if (!out.has(row.contact_id)) out.set(row.contact_id, { id: row.id, name: row.name });
  return out;
}

/// The person's own entity, made when missing (their name, else « Me »).
export function ensureSelf(userId: string, now = Date.now()): EntityRow {
  const known = selfOf(userId);
  if (known) return known;
  const user = sqlite.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string | null } | undefined;
  const name = (user?.name?.trim() && user.name.trim() !== "Self-hosted user" ? user.name.trim() : "Me").slice(0, MAX_NAME);
  const norm = normaliseName(name) || "me";
  const same = sqlite.prepare("SELECT * FROM entities WHERE user_id = ? AND norm = ? AND merged_into IS NULL LIMIT 1").get(userId, norm) as EntityRow | undefined;
  if (same && (same.kind === "person" || same.kind === "other")) {
    sqlite.prepare("UPDATE entities SET kind = 'self', updated_at = ? WHERE id = ?").run(now, same.id);
    return findEntity(userId, same.id)!;
  }
  const id = randomUUID();
  sqlite.prepare("INSERT INTO entities (id, user_id, kind, name, norm, note, source, created_at, updated_at) VALUES (?, ?, 'self', ?, ?, NULL, 'manual', ?, ?)")
    .run(id, userId, same ? `${name} (me)` : name, same ? `${norm} me` : norm, now, now);
  return findEntity(userId, id)!;
}

export interface Relation { kind: RelationKind | null; label: string; source: string | null }

/// The relation of the person to this one (self → it): its first one.
function relationToSelf(selfId: string | null, entityId: string): Relation | null {
  if (!selfId) return null;
  const row = sqlite.prepare("SELECT label, kind, source FROM entity_relations WHERE from_id = ? AND to_id = ? ORDER BY rowid LIMIT 1").get(selfId, entityId) as { label: string; kind: string | null; source: string | null } | undefined;
  return row ? { kind: relationKind(row.kind, row.label), label: row.label, source: row.source } : null;
}

export interface Link {
  /// The other person.
  id: string;
  name: string;
  kind: RelationKind | null;
  label: string;
  /// « of »: this one is the <kind> of the other (Claire is Nadine's
  /// sister: other → this); « has »: the other is this one's <kind>.
  side: "of" | "has";
}

function linksBetween(entityId: string, selfId: string | null): Link[] {
  const rows = sqlite.prepare(`
    SELECT r.from_id, r.to_id, r.label, r.kind, f.name AS from_name, t.name AS to_name
    FROM entity_relations r JOIN entities f ON f.id = r.from_id JOIN entities t ON t.id = r.to_id
    WHERE (r.from_id = ? OR r.to_id = ?) AND f.merged_into IS NULL AND t.merged_into IS NULL AND f.archived_at IS NULL AND t.archived_at IS NULL ORDER BY r.rowid`).all(entityId, entityId) as Array<{ from_id: string; to_id: string; label: string; kind: string | null; from_name: string; to_name: string }>;
  return rows
    .filter((row) => row.from_id !== selfId && row.to_id !== selfId && row.from_id !== row.to_id)
    .map((row) => row.from_id === entityId
      ? { id: row.to_id, name: row.to_name, kind: relationKind(row.kind, row.label), label: row.label, side: "has" as const }
      : { id: row.from_id, name: row.from_name, kind: relationKind(row.kind, row.label), label: row.label, side: "of" as const });
}

/// « 1958-03-12 » or « --03-12 »: the next one from `now`, and the age then.
export function nextBirthday(birthday: string | null, now = new Date()): { date: string; age: number | null } | null {
  const match = birthday ? /^(\d{4}|--)-(\d{2})-(\d{2})$/.exec(birthday) : null;
  if (!match) return null;
  const [, year, month, day] = match;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  let next = Date.UTC(now.getFullYear(), Number(month) - 1, Number(day));
  if (next < today) next = Date.UTC(now.getFullYear() + 1, Number(month) - 1, Number(day));
  const at = new Date(next);
  return { date: at.toISOString().slice(0, 10), age: year === "--" ? null : at.getUTCFullYear() - Number(year) };
}

export interface Person {
  id: string;
  kind: string;
  name: string;
  aliases: string[];
  note: string | null;
  source: string;
  relation: Relation | null;
  group: KindGroup | null;
  links: Link[];
  contacts: Array<ContactCard & { how: LinkHow }>;
  memory_count: number;
  birthday: string | null;
  next_birthday: { date: string; age: number | null } | null;
  updated_at: string;
  /// « Retirer de vos proches »: when, or null (migration 12; `archived_at`
  /// since migration 14). `removed_at` says the same for the apps of before
  /// (one release, 0.13.104; none reads it).
  archived_at: string | null;
  removed_at: string | null;
}

/// Whether an entity is one of the person's people: a person, or a name a
/// relation made (« stub ») that the person relates to or a card is linked to.
function isPerson(entity: EntityRow, selfId: string | null, linked: Set<string>): boolean {
  if (entity.kind === "person") return true;
  if (entity.kind !== "other") return false;
  if (linked.has(entity.id)) return true;
  const relation = relationToSelf(selfId, entity.id);
  return !!relation?.kind;
}

function personOf(entity: EntityRow, selfId: string | null, links: PersonLink[], cards: Map<string, ContactCard>, now: Date): Person {
  const relation = relationToSelf(selfId, entity.id);
  const contacts = links.filter((link) => link.entity_id === entity.id && cards.has(link.contact_id)).map((link) => ({ ...cards.get(link.contact_id)!, how: link.how }));
  const birthday = contacts.find((contact) => contact.birthday)?.birthday ?? null;
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    aliases: aliasesOf(entity.id),
    note: entity.note,
    source: entity.source,
    relation,
    group: relation?.kind ? KIND_GROUP[relation.kind] : null,
    links: linksBetween(entity.id, selfId),
    contacts,
    memory_count: memoryIdsOf(entity.id).length,
    birthday,
    next_birthday: nextBirthday(birthday, now),
    updated_at: new Date(entity.updated_at).toISOString(),
    archived_at: entity.archived_at ? new Date(entity.archived_at).toISOString() : null,
    removed_at: entity.archived_at ? new Date(entity.archived_at).toISOString() : null,
  };
}

/// `removed_at`: the same date, for the apps of before (one release).
export interface RemovedPerson { id: string; name: string; relation: Relation | null; archived_at: string; removed_at: string }

/// « Proches retirés »: the people removed, kept, the latest first.
export function removedPeople(userId: string): RemovedPerson[] {
  const self = selfOf(userId) ?? null;
  const rows = sqlite.prepare("SELECT * FROM entities WHERE user_id = ? AND merged_into IS NULL AND archived_at IS NOT NULL ORDER BY archived_at DESC").all(userId) as EntityRow[];
  return rows.map((entity) => {
    const at = new Date(entity.archived_at!).toISOString();
    return { id: entity.id, name: entity.name, relation: relationToSelf(self?.id ?? null, entity.id), archived_at: at, removed_at: at };
  });
}

/// The person's people, those with a relation first (the removed ones apart:
/// removedPeople).
export function listPeople(userId: string, now = new Date()): { self: { id: string; name: string } | null; people: Person[] } {
  const self = selfOf(userId) ?? null;
  const entities = listEntities(userId);
  const allLinks = linksOf(entities.map((entity) => entity.id));
  const linked = new Set(allLinks.map((link) => link.entity_id));
  const people = entities.filter((entity) => entity.id !== self?.id && isPerson(entity, self?.id ?? null, linked));
  const links = allLinks.filter((link) => people.some((person) => person.id === link.entity_id));
  const cards = contactsOf(userId, [...new Set(links.map((link) => link.contact_id))]);
  return {
    self: self ? { id: self.id, name: self.name } : null,
    people: people.map((entity) => personOf(entity, self?.id ?? null, links, cards, now)),
  };
}

export interface PersonDetail extends Person {
  memories: Array<{ id: string; title: string | null; content: string; sensitive: boolean; created_at: string }>;
  events: Array<{ id: string; title: string; start: string; all_day: boolean }>;
  merged: Array<{ id: string; name: string }>;
}

const EVENT_DAYS = 60;

/// The events of the next weeks that name them (their name, an alias, their
/// card's name), never a walled-off project's.
function eventsNaming(userId: string, names: string[], now: Date): PersonDetail["events"] {
  const wanted = names.map((name) => normaliseName(name)).filter((name) => name.length >= 3 || (CJK.test(name) && name.length >= 2));
  if (!wanted.length) return [];
  const rows = sqlite.prepare(`SELECT e.id, e.name, e.notes, e.start_time, e.all_day FROM events e
    WHERE e.user_id = ? AND e.start_time >= ? AND e.start_time <= ?
      AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = e.project_id AND p.isolated = 1)
    ORDER BY e.start_time LIMIT 2000`).all(userId, now.getTime() - 86_400_000, now.getTime() + EVENT_DAYS * 86_400_000) as Array<{ id: string; name: string; notes: string | null; start_time: number; all_day: number }>;
  return rows
    .filter((row) => {
      const padded = ` ${normaliseName(`${row.name} ${row.notes ?? ""}`)} `;
      return wanted.some((name) => (CJK.test(name) ? padded.includes(name) : padded.includes(` ${name} `)));
    })
    .slice(0, 10)
    .map((row) => ({ id: row.id, title: row.name, start: new Date(row.start_time).toISOString(), all_day: row.all_day === 1 }));
}

export function personDetail(userId: string, id: string, now = new Date()): PersonDetail | null {
  const entity = findEntity(userId, id);
  if (!entity) return null;
  const self = selfOf(userId) ?? null;
  const links = linksOf([entity.id]);
  const cards = contactsOf(userId, links.map((link) => link.contact_id));
  const person = personOf(entity, self?.id ?? null, links, cards, now);
  const memoryIds = memoryIdsOf(entity.id);
  const memories = memoryIds.length
    ? (sqlite.prepare(`SELECT id, title, content, tags, created_at FROM memories WHERE user_id = ? AND superseded_by_id IS NULL AND id IN (${memoryIds.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 100`).all(userId, ...memoryIds) as Array<{ id: string; title: string | null; content: string; tags: string; created_at: number }>)
      .filter((row) => !row.tags.includes("\"archive\""))
      .map((row) => ({ id: row.id, title: row.title, content: row.content, sensitive: row.tags.includes("\"sensitive\""), created_at: new Date(row.created_at).toISOString() }))
    : [];
  const merged = sqlite.prepare("SELECT id, name FROM entities WHERE merged_into = ? AND user_id = ? ORDER BY updated_at DESC").all(entity.id, userId) as Array<{ id: string; name: string }>;
  const names = [entity.name, ...person.aliases, ...person.contacts.map((contact) => contact.name).filter((name): name is string => !!name && name.includes(" "))];
  return { ...person, memories, events: eventsNaming(userId, names, now), merged };
}

// ── Writing ──────────────────────────────────────────────────────────────

export interface RelationInput { kind: RelationKind; label: string | null }

export function readRelation(raw: unknown): RelationInput | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const body = raw as { kind?: unknown; label?: unknown };
  if (!isRelationKind(body?.kind)) throw new PeopleError(422, "invalid_relation");
  if (body.label !== undefined && body.label !== null && (typeof body.label !== "string" || body.label.trim().length > MAX_LABEL)) throw new PeopleError(422, "invalid_relation");
  return { kind: body.kind, label: typeof body.label === "string" && body.label.trim() ? body.label.trim().replace(/\s+/g, " ") : null };
}

function labelFor(input: RelationInput, locale: string | null): string {
  return input.label ?? kindWord(input.kind, locale);
}

/// The relation of the person to this one, replaced (none: removed).
export function setRelationToSelf(userId: string, entityId: string, input: RelationInput | null, locale: string | null, source = "manual", now = Date.now()) {
  const entity = findEntity(userId, entityId);
  if (!entity) throw new PeopleError(404, "not_found");
  if (entity.kind === "self") throw new PeopleError(422, "self");
  sqlite.transaction(() => {
    const self = ensureSelf(userId, now);
    const before = relationsBefore("from_id = ? AND to_id = ?", self.id, entity.id);
    sqlite.prepare("DELETE FROM entity_relations WHERE from_id = ? AND to_id = ?").run(self.id, entity.id);
    if (input) {
      const label = labelFor(input, locale);
      putRelation(self.id, entity.id, label, input.kind, source, now, before.get(`${self.id}\n${entity.id}\n${label}`));
      // A name a relation made (« stub ») is a person now.
      if (entity.kind === "other") sqlite.prepare("UPDATE entities SET kind = 'person', source = CASE WHEN source = 'stub' THEN 'manual' ELSE source END, updated_at = ? WHERE id = ?").run(now, entity.id);
    }
    sqlite.prepare("UPDATE entities SET updated_at = ? WHERE id = ?").run(now, self.id);
  })();
  markLinksStale(userId);
}

export interface LinkInput { person: string; kind: RelationKind; label: string | null; side: "of" | "has" }

export function readLinks(raw: unknown): LinkInput[] {
  const list = (raw as { links?: unknown } | null)?.links;
  if (!Array.isArray(list) || list.length > 64) throw new PeopleError(422, "invalid_links");
  return list.map((item) => {
    const link = item as { person?: unknown; kind?: unknown; label?: unknown; side?: unknown } | null;
    const person = typeof link?.person === "string" ? link.person.trim() : "";
    if (!person || person.length > MAX_NAME || !isRelationKind(link?.kind) || (link?.side !== "of" && link?.side !== "has")) throw new PeopleError(422, "invalid_links");
    if (link.label !== undefined && link.label !== null && (typeof link.label !== "string" || link.label.trim().length > MAX_LABEL)) throw new PeopleError(422, "invalid_links");
    return { person, kind: link.kind, label: typeof link.label === "string" && link.label.trim() ? link.label.trim() : null, side: link.side };
  });
}

/// A person by id, or by name or alias — a name nobody has yet becomes a
/// person of their own.
export function personNamed(userId: string, nameOrId: string, source = "manual", now = Date.now()): EntityRow {
  const known = findEntity(userId, nameOrId);
  if (known) return known;
  const norm = normaliseName(nameOrId);
  if (!norm) throw new PeopleError(422, "invalid_name");
  const named = (sqlite.prepare("SELECT * FROM entities WHERE user_id = ? AND norm = ? AND merged_into IS NULL ORDER BY kind = 'person' DESC, created_at LIMIT 1").get(userId, norm) as EntityRow | undefined)
    ?? (sqlite.prepare("SELECT e.* FROM entity_aliases a JOIN entities e ON e.id = a.entity_id WHERE e.user_id = ? AND a.norm = ? AND e.merged_into IS NULL ORDER BY e.created_at LIMIT 1").get(userId, norm) as EntityRow | undefined);
  if (named) {
    if (named.kind === "other") sqlite.prepare("UPDATE entities SET kind = 'person', source = CASE WHEN source = 'stub' THEN ? ELSE source END, updated_at = ? WHERE id = ?").run(source, now, named.id);
    // Named again by the person (a link typed by hand): back among their people.
    if (named.archived_at) restorePerson(userId, named.id, now);
    return findEntity(userId, named.id)!;
  }
  const id = randomUUID();
  const name = nameOrId.trim().replace(/\s+/g, " ").slice(0, MAX_NAME);
  sqlite.prepare("INSERT INTO entities (id, user_id, kind, name, norm, note, source, created_at, updated_at) VALUES (?, ?, 'person', ?, ?, NULL, ?, ?, ?)").run(id, userId, name, norm, source, now, now);
  markLinksStale(userId);
  return findEntity(userId, id)!;
}

/// This one's relations with the others (the person aside), replaced.
export function setLinks(userId: string, entityId: string, links: LinkInput[], locale: string | null, now = Date.now()) {
  const entity = findEntity(userId, entityId);
  if (!entity) throw new PeopleError(404, "not_found");
  const self = selfOf(userId);
  sqlite.transaction(() => {
    const keep = relationsBefore("from_id = ? OR to_id = ?", entity.id, entity.id);
    sqlite.prepare(`DELETE FROM entity_relations WHERE (from_id = ? AND to_id != ?) OR (to_id = ? AND from_id != ?)`).run(entity.id, self?.id ?? "", entity.id, self?.id ?? "");
    for (const link of links) {
      const other = personNamed(userId, link.person, "manual", now);
      if (other.id === entity.id || other.id === self?.id) continue;
      const [from, to] = link.side === "of" ? [other.id, entity.id] : [entity.id, other.id];
      const label = link.label ?? kindWord(link.kind, locale);
      const kept = keep.get(`${from}\n${to}\n${label}`) ?? null;
      putRelation(from, to, label, link.kind, kept?.source ?? "manual", now, kept);
    }
    sqlite.prepare("UPDATE entities SET updated_at = ? WHERE id = ?").run(now, entity.id);
  })();
  markLinksStale(userId);
}

export interface PersonInput {
  name?: string;
  aliases?: string[];
  note?: string | null;
  relation?: RelationInput | null;
  contact_id?: string;
}

export function readPersonInput(raw: unknown, creating: boolean): PersonInput {
  const body = (raw && typeof raw === "object" ? (raw as { person?: unknown }).person : null) as Record<string, unknown> | null | undefined;
  if (!body || typeof body !== "object") throw new PeopleError(422, "person_required");
  const out: PersonInput = {};
  if (body.name !== undefined || (creating && body.contact_id === undefined)) {
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > MAX_NAME || !normaliseName(name)) throw new PeopleError(422, "invalid_name");
    out.name = name;
  }
  if (body.aliases !== undefined) {
    if (!Array.isArray(body.aliases) || body.aliases.length > MAX_ALIASES) throw new PeopleError(422, "invalid_aliases");
    out.aliases = body.aliases.map((alias) => {
      if (typeof alias !== "string" || !alias.trim() || alias.trim().length > MAX_ALIAS || !normaliseName(alias)) throw new PeopleError(422, "invalid_aliases");
      return alias.trim().replace(/\s+/g, " ");
    });
  }
  if (body.note !== undefined) {
    if (body.note !== null && (typeof body.note !== "string" || body.note.length > MAX_NOTE)) throw new PeopleError(422, "invalid_note");
    out.note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  }
  const relation = readRelation(body.relation);
  if (relation !== undefined) out.relation = relation;
  if (body.contact_id !== undefined) {
    if (typeof body.contact_id !== "string" || !body.contact_id.trim()) throw new PeopleError(422, "invalid_contact");
    out.contact_id = body.contact_id.trim();
  }
  return out;
}

function setAliases(entity: EntityRow, aliases: string[]) {
  sqlite.prepare("DELETE FROM entity_aliases WHERE entity_id = ?").run(entity.id);
  const put = sqlite.prepare("INSERT OR IGNORE INTO entity_aliases (entity_id, alias, norm) VALUES (?, ?, ?)");
  for (const alias of aliases) {
    const norm = normaliseName(alias);
    if (norm && norm !== entity.norm) put.run(entity.id, alias, norm);
  }
}

function contactRow(userId: string, contactId: string): ContactCard | null {
  return contactsOf(userId, [contactId]).get(contactId) ?? null;
}

/// The relation a hand-made card says (« Famille » + « mère »): its detail
/// when it names a kind, else its type.
export function contactRelation(contact: ContactCard): RelationInput | null {
  const detail = contact.relation_subtype?.trim();
  if (detail) {
    const kinds = [...new Set(kindsOfWord(detail))];
    if (kinds.length === 1) return { kind: kinds[0]!, label: detail };
  }
  switch (contact.relation_type) {
    case "partner": return { kind: "partner", label: detail || null };
    case "friend": return { kind: "friend", label: detail || null };
    case "colleague": return { kind: "colleague", label: detail || null };
    case "client": return { kind: "client", label: detail || null };
    case "family": return { kind: "relative", label: detail || null };
    case "other": return detail ? { kind: "other", label: detail } : null;
    default: return null;
  }
}

/// A new person (« Ajouter un proche », or a card of Contacts added).
export function createPerson(userId: string, input: PersonInput, locale: string | null, now = Date.now()): EntityRow {
  const contact = input.contact_id ? contactRow(userId, input.contact_id) : null;
  if (input.contact_id && !contact) throw new PeopleError(404, "contact_not_found");
  const name = input.name ?? contact?.name ?? null;
  if (!name) throw new PeopleError(422, "invalid_name");
  const norm = normaliseName(name);
  const existing = sqlite.prepare("SELECT * FROM entities WHERE user_id = ? AND norm = ? AND merged_into IS NULL LIMIT 1").get(userId, norm) as EntityRow | undefined;
  // Added again under the same name: the person removed comes back, with
  // what was known of them.
  if (existing && existing.source !== "stub" && existing.kind !== "other" && !existing.archived_at) throw new EntityError(409, "name_taken", existing.id);
  const entity = sqlite.transaction(() => {
    let row: EntityRow;
    if (existing) {
      sqlite.prepare("UPDATE entities SET kind = 'person', name = ?, note = COALESCE(?, note), source = 'manual', archived_at = NULL, updated_at = ? WHERE id = ?").run(name, input.note ?? null, now, existing.id);
      row = findEntity(userId, existing.id)!;
    } else {
      const id = randomUUID();
      sqlite.prepare("INSERT INTO entities (id, user_id, kind, name, norm, note, source, created_at, updated_at) VALUES (?, ?, 'person', ?, ?, ?, 'manual', ?, ?)").run(id, userId, name, norm, input.note ?? null, now, now);
      row = findEntity(userId, id)!;
    }
    if (input.aliases) setAliases(row, input.aliases);
    if (contact) {
      sqlite.prepare("DELETE FROM entity_contacts WHERE contact_id = ? AND how = 'auto'").run(contact.id);
      sqlite.prepare("INSERT OR REPLACE INTO entity_contacts (entity_id, contact_id, how, created_at, updated_at) VALUES (?, ?, 'manual', ?, ?)").run(row.id, contact.id, now, now);
    }
    return row;
  })();
  const relation = input.relation !== undefined ? input.relation : contact ? contactRelation(contact) : null;
  if (relation) setRelationToSelf(userId, entity.id, relation, locale, input.relation !== undefined ? "manual" : "contact", now);
  markLinksStale(userId);
  markPeopleStale(userId);
  return findEntity(userId, entity.id)!;
}

export function updatePerson(userId: string, id: string, input: PersonInput, locale: string | null, now = Date.now()): EntityRow {
  const entity = findEntity(userId, id);
  if (!entity) throw new PeopleError(404, "not_found");
  sqlite.transaction(() => {
    if (input.name !== undefined) {
      const norm = normaliseName(input.name);
      const other = sqlite.prepare("SELECT id, source FROM entities WHERE user_id = ? AND norm = ? AND merged_into IS NULL AND id != ? LIMIT 1").get(userId, norm, entity.id) as { id: string; source: string } | undefined;
      if (other && other.source !== "stub") throw new EntityError(409, "name_taken", other.id);
      sqlite.prepare("UPDATE entities SET name = ?, norm = ?, updated_at = ? WHERE id = ?").run(input.name, norm, now, entity.id);
      sqlite.prepare("DELETE FROM entity_aliases WHERE entity_id = ? AND norm = ?").run(entity.id, norm);
    }
    if (input.note !== undefined) sqlite.prepare("UPDATE entities SET note = ?, updated_at = ? WHERE id = ?").run(input.note, now, entity.id);
    if (input.aliases) setAliases(findEntity(userId, entity.id)!, input.aliases);
    if (entity.kind === "other") sqlite.prepare("UPDATE entities SET kind = 'person', source = CASE WHEN source = 'stub' THEN 'manual' ELSE source END WHERE id = ?").run(entity.id);
  })();
  if (input.relation !== undefined) setRelationToSelf(userId, entity.id, input.relation, locale, "manual", now);
  if (input.contact_id) linkContact(userId, entity.id, input.contact_id, "manual", now);
  markLinksStale(userId);
  markPeopleStale(userId);
  return findEntity(userId, entity.id)!;
}

/// A card is theirs: linked (by hand, or the person's yes), taken from
/// whom it was linked to on its own.
export function linkContact(userId: string, entityId: string, contactId: string, how: "manual" | "confirmed" = "manual", now = Date.now()) {
  const entity = findEntity(userId, entityId);
  if (!entity) throw new PeopleError(404, "not_found");
  if (!contactRow(userId, contactId)) throw new PeopleError(404, "contact_not_found");
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM entity_contacts WHERE contact_id = ? AND how = 'auto' AND entity_id != ?").run(contactId, entity.id);
    sqlite.prepare("INSERT OR REPLACE INTO entity_contacts (entity_id, contact_id, how, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(entity.id, contactId, how, now, now);
  })();
  markPeopleStale(userId);
}

/// « Délier »: not theirs — and never linked to them again on its own.
export function unlinkContact(userId: string, entityId: string, contactId: string, now = Date.now()) {
  const entity = findEntity(userId, entityId);
  if (!entity) throw new PeopleError(404, "not_found");
  sqlite.prepare("INSERT OR REPLACE INTO entity_contacts (entity_id, contact_id, how, created_at, updated_at) VALUES (?, ?, 'refused', ?, ?)").run(entity.id, contactId, now, now);
  markPeopleStale(userId);
}

/// « Retirer de vos proches » (Jimmy, 17/10/2026: nothing is deleted for
/// good): kept with their names, relations, cards and memories, hidden
/// from « Proches », the chat's cards, the graph the memory follows, « dis
/// à maman » and the learner's proposals about them, until restored.
export function removePerson(userId: string, id: string, now = Date.now()): boolean {
  const entity = findEntity(userId, id);
  if (!entity) return false;
  if (entity.kind === "self") throw new PeopleError(422, "self");
  if (!entity.archived_at) sqlite.prepare("UPDATE entities SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, entity.id);
  markLinksStale(userId);
  markPeopleStale(userId);
  return true;
}

/// « Rétablir »: back among the person's people, as they were.
export function restorePerson(userId: string, id: string, now = Date.now()): EntityRow {
  const entity = findEntity(userId, id);
  if (!entity) throw new PeopleError(404, "not_found");
  if (entity.archived_at) sqlite.prepare("UPDATE entities SET archived_at = NULL, updated_at = ? WHERE id = ?").run(now, entity.id);
  markLinksStale(userId);
  markPeopleStale(userId);
  return findEntity(userId, entity.id)!;
}

/// Whether a name is that of someone the person removed (and of no one
/// still among their people): the learner proposes nothing about them.
export function removedNamed(userId: string, name: string): boolean {
  const norm = normaliseName(name);
  if (!norm || namedEntity(userId, name)) return false;
  return !!(sqlite.prepare("SELECT 1 FROM entities WHERE user_id = ? AND norm = ? AND merged_into IS NULL AND archived_at IS NOT NULL LIMIT 1").get(userId, norm)
    ?? sqlite.prepare("SELECT 1 FROM entity_aliases a JOIN entities e ON e.id = a.entity_id WHERE e.user_id = ? AND a.norm = ? AND e.merged_into IS NULL AND e.archived_at IS NOT NULL LIMIT 1").get(userId, norm));
}

/// Two people who are one: the first into the second (its names become
/// aliases there, its relations, memories and cards move).
export function mergePeople(userId: string, fromId: string, intoId: string, now = Date.now()): EntityRow {
  const from = findEntity(userId, fromId);
  const into = findEntity(userId, intoId);
  if (!from || !into) throw new PeopleError(404, "not_found");
  const merged = sqlite.transaction(() => {
    const row = mergeEntities(userId, from.id, into.id, now);
    for (const link of sqlite.prepare("SELECT contact_id, how, created_at FROM entity_contacts WHERE entity_id = ?").all(from.id) as Array<{ contact_id: string; how: string; created_at: number }>) {
      sqlite.prepare("INSERT OR IGNORE INTO entity_contacts (entity_id, contact_id, how, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(into.id, link.contact_id, link.how, link.created_at, now);
    }
    sqlite.prepare("DELETE FROM entity_contacts WHERE entity_id = ?").run(from.id);
    // A person merged into a project stays a person: kind of the target kept.
    return row;
  })();
  markPeopleStale(userId);
  return merged;
}

/// « Séparer »: one of their names, or one of their cards, into a person
/// of their own; or a merge undone (its name back, its memories linked
/// again by their words — relations stay where they are).
export function splitPerson(userId: string, id: string, what: { alias?: string; contact_id?: string; merged_id?: string }, now = Date.now()): EntityRow {
  const entity = findEntity(userId, id);
  if (!entity) throw new PeopleError(404, "not_found");
  const made = sqlite.transaction(() => {
    if (what.merged_id) {
      const row = sqlite.prepare("SELECT * FROM entities WHERE id = ? AND user_id = ? AND merged_into = ?").get(what.merged_id, userId, entity.id) as EntityRow | undefined;
      if (!row) throw new PeopleError(404, "not_found");
      sqlite.prepare("UPDATE entities SET merged_into = NULL, kind = CASE WHEN kind = 'self' THEN 'person' ELSE kind END, updated_at = ? WHERE id = ?").run(now, row.id);
      sqlite.prepare("DELETE FROM entity_aliases WHERE entity_id = ? AND norm = ?").run(entity.id, row.norm);
      return findEntity(userId, row.id)!;
    }
    if (what.alias) {
      const norm = normaliseName(what.alias);
      const alias = sqlite.prepare("SELECT alias FROM entity_aliases WHERE entity_id = ? AND norm = ?").get(entity.id, norm) as { alias: string } | undefined;
      if (!alias) throw new PeopleError(404, "alias_not_found");
      sqlite.prepare("DELETE FROM entity_aliases WHERE entity_id = ? AND norm = ?").run(entity.id, norm);
      const newId = randomUUID();
      sqlite.prepare("INSERT INTO entities (id, user_id, kind, name, norm, note, source, created_at, updated_at) VALUES (?, ?, 'person', ?, ?, NULL, 'manual', ?, ?)").run(newId, userId, alias.alias, norm, now, now);
      return findEntity(userId, newId)!;
    }
    if (what.contact_id) {
      const link = sqlite.prepare("SELECT how FROM entity_contacts WHERE entity_id = ? AND contact_id = ? AND how != 'refused'").get(entity.id, what.contact_id) as { how: string } | undefined;
      const contact = contactRow(userId, what.contact_id);
      if (!link || !contact?.name) throw new PeopleError(404, "contact_not_found");
      sqlite.prepare("UPDATE entity_contacts SET how = 'refused', created_at = ?, updated_at = ? WHERE entity_id = ? AND contact_id = ?").run(now, now, entity.id, what.contact_id);
      const norm = normaliseName(contact.name);
      const named = sqlite.prepare("SELECT * FROM entities WHERE user_id = ? AND norm = ? AND merged_into IS NULL AND id != ? LIMIT 1").get(userId, norm, entity.id) as EntityRow | undefined;
      const target = named ?? (() => {
        const newId = randomUUID();
        sqlite.prepare("INSERT INTO entities (id, user_id, kind, name, norm, note, source, created_at, updated_at) VALUES (?, ?, 'person', ?, ?, NULL, 'manual', ?, ?)").run(newId, userId, contact.name, norm === entity.norm ? `${norm} 2` : norm, now, now);
        return findEntity(userId, newId)!;
      })();
      sqlite.prepare("INSERT OR REPLACE INTO entity_contacts (entity_id, contact_id, how, created_at, updated_at) VALUES (?, ?, 'manual', ?, ?)").run(target.id, what.contact_id, now, now);
      return target;
    }
    throw new PeopleError(422, "split_what");
  })();
  markLinksStale(userId);
  markPeopleStale(userId);
  return made;
}

// ── Linking cards and finding duplicates (§3) ────────────────────────────

const stale = new Set<string>();
const fresh = new Set<string>();

/// Cards or people changed: links and proposals worked out again when next
/// asked for.
export function markPeopleStale(userId: string) {
  stale.add(userId);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/// A name sure enough to link a card by: two words or more, or two CJK
/// characters.
function fullName(norm: string): boolean {
  return CJK.test(norm) ? norm.replace(/\s+/g, "").length >= 2 : norm.split(" ").length >= 2;
}

function refusedKeys(userId: string): Set<string> {
  return new Set((sqlite.prepare("SELECT norm FROM memory_candidates WHERE user_id = ? AND candidate_type IN ('person_link', 'person_duplicate')").all(userId) as Array<{ norm: string }>).map((row) => row.norm));
}

function propose(userId: string, type: "person_link" | "person_duplicate", norm: string, content: string, payload: Record<string, unknown>, now: number) {
  sqlite.prepare(`INSERT INTO memory_candidates (id, user_id, content, norm, kind, category, confidence, sensitive, evidence, supersedes_id, discussion_id, status, created_at, candidate_type, payload)
    VALUES (?, ?, ?, ?, 'user', 'family', 0.6, 0, NULL, NULL, NULL, 'pending', ?, ?, ?)`).run(randomUUID(), userId, content.slice(0, 400), norm, now, type, JSON.stringify(payload));
}

export const linkKey = (entityId: string, contactId: string) => `link:${entityId}:${contactId}`;
export const duplicateKey = (a: string, b: string) => (a < b ? `dup:${a}:${b}` : `dup:${b}:${a}`);

/// Links the cards that are surely someone's, and proposes the others and
/// the possible duplicates. Returns what it did.
export function refreshPeople(userId: string, now = Date.now()): { linked: number; proposed: number } {
  stale.delete(userId);
  fresh.add(userId);
  const result = { linked: 0, proposed: 0 };
  const self = selfOf(userId);
  const entities = listEntities(userId).filter((entity) => entity.kind === "person" || entity.kind === "other");
  if (!entities.length) return result;
  const links = linksOf(entities.map((entity) => entity.id), true);
  const linkedTo = new Map<string, Map<string, LinkHow>>();
  for (const link of links) {
    const map = linkedTo.get(link.entity_id) ?? new Map<string, LinkHow>();
    map.set(link.contact_id, link.how);
    linkedTo.set(link.entity_id, map);
  }
  const takenCards = new Set(links.filter((link) => link.how !== "refused").map((link) => link.contact_id));
  const contacts = (sqlite.prepare("SELECT id, name, first_name, last_name, email, emails FROM contacts WHERE user_id = ?").all(userId) as Array<{ id: string; name: string | null; first_name: string | null; last_name: string | null; email: string | null; emails: string | null }>);
  const byFullName = new Map<string, string[]>();
  const byFirstName = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();
  const nameOf = new Map<string, string>();
  for (const contact of contacts) {
    const name = contact.name || [contact.first_name, contact.last_name].filter(Boolean).join(" ");
    if (name) nameOf.set(contact.id, name);
    const norm = normaliseName(name);
    if (norm && fullName(norm)) byFullName.set(norm, [...(byFullName.get(norm) ?? []), contact.id]);
    const first = normaliseName(contact.first_name || (norm && !CJK.test(norm) ? norm.split(" ")[0]! : ""));
    if (first && first.length >= 2) byFirstName.set(first, [...(byFirstName.get(first) ?? []), contact.id]);
    for (const address of [contact.email, ...(contact.emails ? storedValues(contact.emails) : [])]) {
      if (!address) continue;
      const key = address.trim().toLowerCase();
      const ids = byEmail.get(key) ?? [];
      if (!ids.includes(contact.id)) byEmail.set(key, [...ids, contact.id]);
    }
  }
  // The addresses each person's note and memories give.
  const memoryText = sqlite.prepare("SELECT m.content FROM memories m JOIN memory_entities l ON l.memory_id = m.id WHERE l.entity_id = ? AND m.superseded_by_id IS NULL");
  const addressesOf = new Map<string, Set<string>>();
  for (const entity of entities) {
    const texts = [entity.note ?? "", ...(memoryText.all(entity.id) as Array<{ content: string }>).map((row) => row.content)];
    addressesOf.set(entity.id, new Set(texts.flatMap((text) => (text.match(EMAIL) ?? []).map((address) => address.toLowerCase()))));
  }
  const addressOwners = new Map<string, string[]>();
  for (const [entityId, addresses] of addressesOf) for (const address of addresses) addressOwners.set(address, [...(addressOwners.get(address) ?? []), entityId]);
  const refused = refusedKeys(userId);
  const put = sqlite.prepare("INSERT OR IGNORE INTO entity_contacts (entity_id, contact_id, how, created_at, updated_at) VALUES (?, ?, 'auto', ?, ?)");
  // People with a relation to the person, or already known by a card: the
  // others (a project's stub) are not proposed cards.
  const related = new Set(self ? (sqlite.prepare("SELECT to_id FROM entity_relations WHERE from_id = ?").all(self.id) as Array<{ to_id: string }>).map((row) => row.to_id) : []);
  sqlite.transaction(() => {
    for (const entity of entities) {
      const mine = linkedTo.get(entity.id) ?? new Map<string, LinkHow>();
      const names = [entity.norm, ...aliasesOf(entity.id).map(normaliseName)].filter(Boolean);
      const sure = new Set<string>();
      for (const name of names) {
        if (!fullName(name)) continue;
        const ids = byFullName.get(name) ?? [];
        if (ids.length === 1) sure.add(ids[0]!);
      }
      for (const address of addressesOf.get(entity.id) ?? []) {
        const ids = byEmail.get(address) ?? [];
        if (ids.length === 1 && (addressOwners.get(address) ?? []).length === 1) sure.add(ids[0]!);
      }
      for (const contactId of sure) {
        if (mine.has(contactId) || takenCards.has(contactId)) continue;
        if (put.run(entity.id, contactId, now, now).changes) {
          result.linked += 1;
          takenCards.add(contactId);
          mine.set(contactId, "auto");
        }
      }
      // Not sure: one card with that first name, for someone the person relates to.
      if ([...mine.values()].some((how) => how !== "refused") || !(entity.kind === "person" || related.has(entity.id))) continue;
      const single = names.filter((name) => !fullName(name) && !CJK.test(name) && name.length >= 3);
      for (const name of single) {
        const ids = (byFirstName.get(name) ?? []).filter((id) => !takenCards.has(id));
        if (ids.length !== 1) continue;
        const contactId = ids[0]!;
        const key = linkKey(entity.id, contactId);
        if (mine.has(contactId) || refused.has(key)) continue;
        propose(userId, "person_link", key, `${entity.name} = ${nameOf.get(contactId) ?? "?"}`, { entity_id: entity.id, contact_id: contactId, name: entity.name, contact_name: nameOf.get(contactId) ?? null }, now);
        refused.add(key);
        result.proposed += 1;
        break;
      }
    }
    // « Doublons possibles »: the same card on two people; a one-word name
    // that is another's first name (one only), or another's alias.
    const people = entities.filter((entity) => entity.kind === "person");
    const holders = new Map<string, string[]>();
    for (const link of links) if (link.how !== "refused") holders.set(link.contact_id, [...(holders.get(link.contact_id) ?? []), link.entity_id]);
    const pairs: Array<[EntityRow, EntityRow]> = [];
    const byId = new Map(people.map((entity) => [entity.id, entity] as const));
    for (const ids of holders.values()) {
      const live = ids.map((id) => byId.get(id)).filter((entity): entity is EntityRow => !!entity);
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) pairs.push([live[i]!, live[j]!]);
    }
    for (const one of people) {
      if (fullName(one.norm) || CJK.test(one.norm) || one.norm.length < 3) continue;
      const firsts = people.filter((other) => other.id !== one.id && fullName(other.norm) && other.norm.split(" ")[0] === one.norm && !aliasesOf(other.id).map(normaliseName).includes(one.norm));
      if (firsts.length === 1) pairs.push([one, firsts[0]!]);
      for (const other of people) {
        if (other.id !== one.id && aliasesOf(other.id).map(normaliseName).includes(one.norm)) pairs.push([one, other]);
      }
    }
    const seen = new Set<string>();
    for (const [a, b] of pairs) {
      const key = duplicateKey(a.id, b.id);
      if (seen.has(key) || refused.has(key)) continue;
      seen.add(key);
      propose(userId, "person_duplicate", key, `${a.name} = ${b.name}`, { a: a.id, b: b.id, names: [a.name, b.name] }, now);
      refused.add(key);
      result.proposed += 1;
    }
  })();
  return result;
}

/// Worked out again if anything changed since.
export function ensurePeople(userId: string) {
  if (stale.has(userId) || !fresh.has(userId)) refreshPeople(userId);
}

// ── « À confirmer » for people ───────────────────────────────────────────

export const PEOPLE_CANDIDATES = ["relation", "person_link", "person_duplicate"] as const;

/// Whether a proposal of these types still means something (its people are
/// there, unmerged): one about a person gone is not shown.
export function candidateLive(userId: string, type: string, payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  if (type === "person_link") {
    const entity = typeof payload.entity_id === "string" ? findEntity(userId, payload.entity_id) : null;
    return !!entity && entity.id === payload.entity_id && !entity.archived_at;
  }
  if (type === "person_duplicate") {
    const a = typeof payload.a === "string" ? findEntity(userId, payload.a) : null;
    const b = typeof payload.b === "string" ? findEntity(userId, payload.b) : null;
    return !!a && !!b && a.id !== b.id && !a.archived_at && !b.archived_at;
  }
  // A relation about someone removed waits, unseen, until they are restored.
  if (type === "relation") {
    return !(typeof payload.to_name === "string" && removedNamed(userId, payload.to_name))
      && !(typeof payload.from_name === "string" && payload.from_name.trim() && removedNamed(userId, payload.from_name));
  }
  return true;
}

export interface RelationProposal {
  /// null: the person themselves.
  from_name: string | null;
  to_name: string;
  kind: RelationKind;
  label: string;
}

export const relationKey = (proposal: { from_name: string | null; to_name: string; kind: RelationKind }) =>
  `relation:${proposal.from_name ? normaliseName(proposal.from_name) : "self"}:${proposal.kind}:${normaliseName(proposal.to_name)}`;

/// Whether the graph says it already: the same kind (or one it is part of)
/// from the same one to someone of that name.
export function relationKnown(userId: string, proposal: RelationProposal): boolean {
  const from = proposal.from_name === null ? selfOf(userId) : namedEntity(userId, proposal.from_name);
  const to = namedEntity(userId, proposal.to_name);
  if (!from || !to) return false;
  const rows = sqlite.prepare("SELECT label, kind FROM entity_relations WHERE from_id = ? AND to_id = ?").all(from.id, to.id) as Array<{ label: string; kind: string | null }>;
  return rows.some((row) => {
    const kind = relationKind(row.kind, row.label);
    return kind === proposal.kind || (kind !== null && kindWords(kind).includes(normaliseName(proposal.label)));
  });
}

export function namedEntity(userId: string, name: string): EntityRow | null {
  const norm = normaliseName(name);
  if (!norm) return null;
  return (sqlite.prepare("SELECT * FROM entities WHERE user_id = ? AND norm = ? AND merged_into IS NULL AND archived_at IS NULL ORDER BY kind = 'person' DESC, created_at LIMIT 1").get(userId, norm) as EntityRow | undefined)
    ?? (sqlite.prepare("SELECT e.* FROM entity_aliases a JOIN entities e ON e.id = a.entity_id WHERE e.user_id = ? AND a.norm = ? AND e.merged_into IS NULL AND e.archived_at IS NULL ORDER BY e.created_at LIMIT 1").get(userId, norm) as EntityRow | undefined)
    ?? null;
}

/// The person said yes to a proposal about their people. Returns the id of
/// the person it is about.
export function acceptPeopleCandidate(userId: string, type: string, payload: Record<string, unknown>, now = Date.now()): string {
  if (type === "relation") {
    const kind = payload.kind;
    if (!isRelationKind(kind) || typeof payload.to_name !== "string") throw new PeopleError(409, "invalid_proposal");
    const label = typeof payload.label === "string" && payload.label.trim() ? payload.label.trim().slice(0, MAX_LABEL) : kindWord(kind, null);
    const fromName = typeof payload.from_name === "string" && payload.from_name.trim() ? payload.from_name : null;
    const toName = payload.to_name;
    return sqlite.transaction(() => {
      const from = fromName ? personNamed(userId, fromName, "learned", now) : ensureSelf(userId, now);
      const to = personNamed(userId, toName, "learned", now);
      if (from.id === to.id) throw new PeopleError(409, "invalid_proposal");
      putRelation(from.id, to.id, label, kind, "learned", now);
      sqlite.prepare("UPDATE entities SET updated_at = ? WHERE id IN (?, ?)").run(now, from.id, to.id);
      markLinksStale(userId);
      markPeopleStale(userId);
      return to.id;
    })();
  }
  if (type === "person_link") {
    if (typeof payload.entity_id !== "string" || typeof payload.contact_id !== "string") throw new PeopleError(409, "invalid_proposal");
    linkContact(userId, payload.entity_id, payload.contact_id, "confirmed", now);
    return payload.entity_id;
  }
  if (type === "person_duplicate") {
    if (typeof payload.a !== "string" || typeof payload.b !== "string") throw new PeopleError(409, "invalid_proposal");
    const a = findEntity(userId, payload.a);
    const b = findEntity(userId, payload.b);
    if (!a || !b || a.id === b.id) throw new PeopleError(409, "gone");
    // The one-word name goes into the full one; else the newer into the older.
    const [from, into] = !fullName(a.norm) && fullName(b.norm) ? [a, b] : !fullName(b.norm) && fullName(a.norm) ? [b, a] : a.created_at <= b.created_at ? [b, a] : [a, b];
    return mergePeople(userId, from.id, into.id, now).id;
  }
  throw new PeopleError(409, "invalid_proposal");
}
