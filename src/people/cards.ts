import { sqlite } from "../db.js";
import { aliasesOf, entitiesInText, listEntities, normaliseName, relationKind, selfOf, type EntityRow } from "../memory/entities.js";
import { compatibleKinds, kinshipMentions, kindWord, type RelationKind } from "./kinship.js";
import { contactsOf, linksOf, nextBirthday } from "./people.js";

// The person card (docs/people-design.md §6): a message that names someone
// of the person's (their name, an alias, their card's name) or a relation
// of theirs (« ma sœur », « mi madre », « 母 », « 우리 엄마 ») gets, on its
// last message, who that one is to them, their other names, their birthday
// and how to reach them (only when Contacts is on for the turn), and their
// links to the others — like the project cards, never in the system prompt
// (the prompt cache holds). « la sœur de ma femme » goes one hop: ma femme
// → Élodie, « sœur » of Élodie → Claire.

const MAX_CARDS = 3;
const CARD_CHARS = 600;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/// What a relation is called from the other side: Nadine → Claire
/// « daughter » makes Nadine Claire's « mother » or « parent ».
const INVERSE: Partial<Record<RelationKind, RelationKind[]>> = {
  mother: ["child", "son", "daughter"], father: ["child", "son", "daughter"], parent: ["child", "son", "daughter"],
  son: ["parent", "mother", "father"], daughter: ["parent", "mother", "father"], child: ["parent", "mother", "father"],
  sister: ["sibling", "sister", "brother"], brother: ["sibling", "sister", "brother"], sibling: ["sibling", "sister", "brother"],
  wife: ["spouse", "husband", "wife", "partner"], husband: ["spouse", "wife", "husband", "partner"], spouse: ["spouse", "wife", "husband", "partner"], partner: ["partner", "spouse"],
  grandmother: ["grandchild", "grandson", "granddaughter"], grandfather: ["grandchild", "grandson", "granddaughter"], grandparent: ["grandchild", "grandson", "granddaughter"],
  grandson: ["grandparent", "grandmother", "grandfather"], granddaughter: ["grandparent", "grandmother", "grandfather"], grandchild: ["grandparent", "grandmother", "grandfather"],
  aunt: ["niece", "nephew"], uncle: ["niece", "nephew"], niece: ["aunt", "uncle"], nephew: ["aunt", "uncle"], cousin: ["cousin"],
  mother_in_law: ["son_in_law", "daughter_in_law"], father_in_law: ["son_in_law", "daughter_in_law"],
  son_in_law: ["mother_in_law", "father_in_law"], daughter_in_law: ["mother_in_law", "father_in_law"],
  sister_in_law: ["sister_in_law", "brother_in_law"], brother_in_law: ["sister_in_law", "brother_in_law"],
  godparent: ["godchild"], godchild: ["godparent"],
  friend: ["friend"], colleague: ["colleague"], neighbour: ["neighbour"], manager: ["employee"], employee: ["manager"],
};

interface Edge { from: string; to: string; label: string; kind: RelationKind | null }

function edgesOf(ids: string[]): Edge[] {
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  return (sqlite.prepare(`SELECT r.from_id AS "from", r.to_id AS "to", r.label, r.kind FROM entity_relations r
    JOIN entities f ON f.id = r.from_id JOIN entities t ON t.id = r.to_id
    WHERE (r.from_id IN (${marks}) OR r.to_id IN (${marks})) AND f.merged_into IS NULL AND t.merged_into IS NULL ORDER BY r.rowid`).all(...ids, ...ids) as Array<{ from: string; to: string; label: string; kind: string | null }>)
    .map((row) => ({ ...row, kind: relationKind(row.kind, row.label) }));
}

const english = (kind: RelationKind | null, label: string) => (kind ? kindWord(kind, "en").replace(/_/g, "-") : label);

/// The people a message reaches, most direct first.
export function peopleReached(userId: string, text: string): EntityRow[] {
  const self = selfOf(userId);
  const people = listEntities(userId).filter((entity) => entity.id !== self?.id && (entity.kind === "person" || entity.kind === "other"));
  if (!people.length) return [];
  const byId = new Map(people.map((entity) => [entity.id, entity] as const));
  const reached: string[] = [];
  const reach = (id: string) => { if (byId.has(id) && !reached.includes(id)) reached.push(id); };
  // Names, aliases, and the person's own relations said (« ma femme »,
  // « meine Frau », « 妻 »): entities.ts's linker, in the ten languages.
  for (const link of entitiesInText(userId, text)) reach(link.entity_id);
  // A first name alone (« Nadine » for « Nadine Douieb »), when it is one
  // person's only, written with its capital.
  const words = new Set((text.match(/\p{Lu}[\p{L}'’-]+/gu) ?? []).map((word) => normaliseName(word)));
  const firsts = new Map<string, string[]>();
  for (const entity of people) {
    const first = entity.norm.split(" ")[0]!;
    if (entity.norm.includes(" ") && first.length >= 3 && !CJK.test(first)) firsts.set(first, [...(firsts.get(first) ?? []), entity.id]);
  }
  for (const [first, ids] of firsts) if (ids.length === 1 && words.has(first)) reach(ids[0]!);
  // A card's full name (« Nadine Douieb » for a person called « Nadine »).
  const padded = ` ${normaliseName(text)} `;
  const links = linksOf(people.map((entity) => entity.id));
  if (links.length) {
    const cards = contactsOf(userId, [...new Set(links.map((link) => link.contact_id))]);
    for (const link of links) {
      const name = cards.get(link.contact_id)?.name;
      const norm = name ? normaliseName(name) : "";
      if (norm && (norm.includes(" ") || (CJK.test(norm) && norm.length >= 2)) && (CJK.test(norm) ? padded.includes(norm) : padded.includes(` ${norm} `))) reach(link.entity_id);
    }
  }
  // One hop, when the message says the relation: « la sœur de ma femme ».
  const said = kinshipMentions(text).filter((mention) => !mention.own || mention.owner).flatMap((mention) => mention.kinds);
  if (said.length) {
    for (const edge of edgesOf([...reached])) {
      if (edge.from === self?.id || edge.to === self?.id || !edge.kind) continue;
      const kind = edge.kind;
      if (reached.includes(edge.from) && said.some((one) => compatibleKinds(one, kind))) reach(edge.to);
      if (reached.includes(edge.to) && said.some((one) => (INVERSE[kind] ?? []).some((inverse) => compatibleKinds(one, inverse)))) reach(edge.from);
    }
  }
  return reached.map((id) => byId.get(id)!).filter(Boolean);
}

/// « 12 March 1958 »: a birthday as the card says it.
function birthdayText(birthday: string, now: Date): string | null {
  const next = nextBirthday(birthday, now);
  if (!next) return null;
  const [, month, day] = /^(?:\d{4}|--)-(\d{2})-(\d{2})$/.exec(birthday)!;
  const date = new Date(Date.UTC(2000, Number(month) - 1, Number(day))).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  return next.age !== null ? `${date} ${birthday.slice(0, 4)} (turns ${next.age} on ${next.date})` : `${date} (next on ${next.date})`;
}

/// The cards of the people a message is about. `contacts`: whether their
/// cards' details may be given (Contacts on for the turn).
export function personCards(userId: string, text: string, options: { contacts: boolean; now?: Date }): Array<{ id: string; name: string; card: string }> {
  const reached = peopleReached(userId, text).slice(0, MAX_CARDS);
  if (!reached.length) return [];
  const now = options.now ?? new Date();
  const self = selfOf(userId);
  const names = new Map(listEntities(userId).map((entity) => [entity.id, entity.name] as const));
  const edges = edgesOf(reached.map((entity) => entity.id));
  const toSelf = new Map<string, Edge>();
  if (self) for (const edge of edgesOf([self.id])) if (edge.from === self.id && !toSelf.has(edge.to)) toSelf.set(edge.to, edge);
  const links = options.contacts ? linksOf(reached.map((entity) => entity.id)) : [];
  const cards = options.contacts ? contactsOf(userId, links.map((link) => link.contact_id)) : new Map();
  const whose = (id: string) => {
    const edge = toSelf.get(id);
    return edge ? ` (the user's ${english(edge.kind, edge.label)})` : "";
  };
  return reached.map((entity) => {
    const relation = toSelf.get(entity.id);
    const head = relation
      ? `${entity.name} — the user's ${english(relation.kind, relation.label)}${relation.kind && normaliseName(relation.label) !== normaliseName(english(relation.kind, relation.label)) ? ` (they say « ${relation.label} »)` : ""}`
      : `${entity.name} — someone the user knows`;
    const aliases = aliasesOf(entity.id).slice(0, 3);
    const mine = links.filter((link) => link.entity_id === entity.id).map((link) => cards.get(link.contact_id)).filter(Boolean) as Array<{ name: string | null; emails: string[]; phones: string[]; birthday: string | null; organization: string | null }>;
    const birthday = mine.find((card) => card.birthday)?.birthday ?? null;
    const reach = [
      mine.flatMap((card) => card.emails).slice(0, 2).map((address) => `e-mail ${address}`).join(", "),
      mine.flatMap((card) => card.phones).slice(0, 1).map((phone) => `phone ${phone}`).join(""),
      mine.find((card) => card.organization)?.organization ? `works at ${mine.find((card) => card.organization)!.organization}` : "",
    ].filter(Boolean).join("; ");
    const said = edges
      .filter((edge) => (edge.from === entity.id || edge.to === entity.id) && edge.from !== self?.id && edge.to !== self?.id && edge.from !== edge.to)
      .slice(0, 6)
      .map((edge) => `${names.get(edge.to) ?? "?"} is ${names.get(edge.from) ?? "?"}'s ${english(edge.kind, edge.label)}${edge.to === entity.id ? "" : whose(edge.to)}`);
    const lines = [
      head,
      aliases.length ? `Also called: ${aliases.join(", ")}` : null,
      birthday ? `Birthday: ${birthdayText(birthday, now)}` : null,
      reach ? `Contact: ${reach}` : null,
      said.length ? `Links: ${said.join("; ")}` : null,
    ].filter(Boolean);
    return { id: entity.id, name: entity.name, card: lines.join("\n").slice(0, CARD_CHARS) };
  });
}
