import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";
import { normaliseName, selfOf } from "../memory/entities.js";
import { compatibleKinds, fold, hypothetical, isRelationKind, KIND_GROUP, kindsOfWord, kindWord, kinshipMentions, narrower, RELATION_KINDS, type KinshipMention, type RelationKind } from "./kinship.js";
import { relationKey, relationKnown, type RelationProposal } from "./people.js";

// The relations the learner finds in a conversation (docs/people-design.md
// §5): « ma mère s'appelle Nadine », « my boss Bruno », « la sœur de Nadine,
// Claire », in the app's ten languages. Always proposed in « À confirmer »,
// never kept on their own (family is sensitive: Jimmy, 16/10/2026), and
// only on the person's own words: the line quoted word for word names the
// person and says the relation — as the person's own when it is theirs,
// never someone else's relative (« la mère de mon ami »), never a
// hypothesis (« si j'avais une sœur »).

export interface LearnedPerson {
  name: string;
  relation: RelationKind;
  /// null: the person themselves; else whom they are the relation of.
  of: string | null;
  label: string | null;
  evidence: string;
  confidence: number;
}

/// What the learning prompt asks for people (appended to its rules).
export const PEOPLE_RULES =
  "People: also list the people of their life whose relation the PERSON states, to themselves (« ma mère s'appelle Nadine », « my boss is Bruno ») " +
  "or to someone else they name (« Claire, la sœur de Nadine »). name: as the PERSON says it; " +
  `relation: one of ${RELATION_KINDS.join(", ")}; ` +
  "of: \"me\" when it is the person's own relation, else the name of whom they are the relation of (« la sœur de Nadine » → \"Nadine\"); " +
  "label: the PERSON's own word for the relation (« maman », « Schwester », « 엄마 »), else null; evidence and confidence as for facts. " +
  "Only a relation the PERSON says, with a name: never a guessed one, never a relative of someone else as theirs (« la mère de mon ami Paul » is Paul's mother, and Paul their friend), never a hypothesis or a wish (« si j'avais une sœur »).\n";

const MAX_PEOPLE = 8;

/// The people of the model's answer; [] when there are none or it cannot be read.
export function parsePeople(answer: string): LearnedPerson[] {
  const text = answer.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/```(?:json)?/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const people = (parsed as { people?: unknown })?.people;
  if (!Array.isArray(people)) return [];
  const out: LearnedPerson[] = [];
  for (const raw of people.slice(0, MAX_PEOPLE)) {
    const person = raw as Record<string, unknown> | null;
    const name = typeof person?.name === "string" ? person.name.trim().replace(/\s+/g, " ") : "";
    const relation = typeof person?.relation === "string" ? person.relation.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
    if (!name || name.length > 100 || !isRelationKind(relation)) continue;
    const of = typeof person!.of === "string" ? person!.of.trim() : "";
    const confidence = typeof person!.confidence === "number" ? person!.confidence : Number(person!.confidence);
    out.push({
      name,
      relation,
      of: !of || /^(?:me|moi|myself|self|the person|person|user|i)$/i.test(of) ? null : of.slice(0, 100),
      label: typeof person!.label === "string" && person!.label.trim() ? person!.label.trim().slice(0, 64) : null,
      evidence: typeof person!.evidence === "string" ? person!.evidence : "",
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6,
    });
  }
  return out;
}

const loose = (text: string) => text.normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[’‘ʼ`]/g, "'").replace(/[«»“”"「」]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/// Doubt said around it (French and English; the hypotheses of the ten
/// languages are kinship.ts `hypothetical`).
const HEDGING = /\b(?:je crois|je pense|il me semble|probablement|sans doute|je ne sais (?:pas|plus)|i think|i guess|probably|not sure)\b/i;

/// The line of the person the evidence is in, with a little around it.
function evidenceIn(evidence: string, lines: string[]): { line: string; around: string } | null {
  const wanted = loose(evidence).replace(/^[\s.,;:!?…。、-]+|[\s.,;:!?…。、-]+$/g, "");
  if (wanted.length < 3) return null;
  for (const line of lines) {
    const text = loose(line);
    const at = text.indexOf(wanted);
    if (at >= 0) return { line, around: text.slice(Math.max(0, at - 60), at + wanted.length + 20) };
  }
  return null;
}

/// Where a name is in the text, in the coordinates of a mention of that
/// script (folded text for Latin, the text for CJK); -1 when absent.
/// « Nadines Schwester »: the genitive's -s is allowed.
function nameAt(text: string, name: string, script: KinshipMention["script"]): number {
  if (script === "cjk" || CJK.test(name)) {
    const at = text.normalize("NFC").indexOf(name.normalize("NFC"));
    return at;
  }
  const folded = ` ${fold(text)} `;
  const wanted = fold(name);
  if (!wanted) return -1;
  for (const variant of [` ${wanted} `, ` ${wanted}s `]) {
    const at = folded.indexOf(variant);
    if (at >= 0) return at;
  }
  return -1;
}

function says(text: string, name: string): boolean {
  return nameAt(text, name, "latin") >= 0 || (CJK.test(name) && text.normalize("NFC").includes(name.normalize("NFC")));
}

export interface JudgedPerson {
  person: LearnedPerson;
  /// The kind kept: the narrower of the model's and the words said (« ma
  /// sœur » given as « sibling » is « sister »).
  kind: RelationKind;
  label: string;
  confidence: number;
}

/// What becomes of each person the model gave: proposed or dropped. No
/// database but through the callbacks given.
export function judgePeople(
  people: LearnedPerson[],
  context: { personLines: string[]; language?: string | null; selfNames?: string[]; known?: (proposal: RelationProposal) => boolean; refused?: ReadonlySet<string> },
): { propose: JudgedPerson[]; dropped: Array<{ person: LearnedPerson; reason: string }> } {
  const out: { propose: JudgedPerson[]; dropped: Array<{ person: LearnedPerson; reason: string }> } = { propose: [], dropped: [] };
  const seen = new Set<string>();
  const selfNames = new Set((context.selfNames ?? []).map(normaliseName).filter(Boolean));
  for (const person of people) {
    const drop = (reason: string) => out.dropped.push({ person, reason });
    const nameNorm = normaliseName(person.name);
    // A relative's word is no name (« maman », « my boss »).
    if (!nameNorm || kindsOfWord(person.name).length > 0) { drop("no_name"); continue; }
    if (selfNames.has(nameNorm) || (person.of && normaliseName(person.of) === nameNorm)) { drop("self"); continue; }
    const found = evidenceIn(person.evidence, context.personLines);
    if (!found) { drop("no_evidence"); continue; }
    const evidence = person.evidence;
    if (!says(evidence, person.name)) { drop("name_not_said"); continue; }
    if (hypothetical(found.around) || hypothetical(evidence)) { drop("hypothesis"); continue; }
    const mentions = kinshipMentions(evidence);
    let kind: RelationKind | null = null;
    if (person.of === null) {
      // The person's own: the relative's word closest to the name, said as
      // theirs, not the owner of another relative unless the name follows it
      // (« la mère de mon ami Paul »: Paul is the friend).
      const ranked = mentions
        .map((mention) => {
          const at = nameAt(evidence, person.name, mention.script);
          return { mention, at, distance: at < 0 ? Infinity : at >= mention.end ? at - mention.end : mention.start - (at + fold(person.name).length) };
        })
        .filter((entry) => entry.at >= 0)
        .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance));
      const closest = ranked[0];
      if (!closest) { drop("relation_not_said"); continue; }
      const { mention, distance } = closest;
      const adjacent = distance >= 0 && distance <= 2;
      if (!mention.own || (mention.owner && !adjacent)) { drop("not_theirs"); continue; }
      const match = mention.kinds.find((said) => compatibleKinds(said, person.relation));
      if (!match) { drop("relation_not_said"); continue; }
      kind = narrower(match, person.relation);
      // A word of several kinds (« copine »): the model's choice among them.
      if (mention.kinds.length > 1 && mention.kinds.includes(person.relation)) kind = person.relation;
    } else {
      // Of a relative named by their relation only (« my colleague's
      // daughter », « la madre de mi novia »): whom is not known by name.
      if (kindsOfWord(person.of).length > 0) { drop("of_unnamed"); continue; }
      if (!says(evidence, person.of)) { drop("of_not_said"); continue; }
      // Someone else's relative, said as theirs: « la sœur de Nadine »,
      // « Nadines Schwester », « ナディーンの妹 ».
      const match = mentions.filter((mention) => !mention.own || mention.owner).flatMap((mention) => mention.kinds).find((said) => compatibleKinds(said, person.relation));
      if (!match) { drop("relation_not_said"); continue; }
      kind = narrower(match, person.relation);
    }
    let confidence = person.confidence;
    if (HEDGING.test(found.around)) confidence -= 0.3;
    confidence = Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;
    if (confidence < 0.5) { drop("unsure"); continue; }
    const label = person.label && loose(evidence).includes(loose(person.label)) ? person.label : kindWord(kind, context.language ?? null);
    const proposal: RelationProposal = { from_name: person.of, to_name: person.name, kind, label };
    const key = relationKey(proposal);
    if (seen.has(key)) { drop("repeated"); continue; }
    seen.add(key);
    if (context.refused?.has(key)) { drop("refused"); continue; }
    if (context.known?.(proposal)) { drop("known"); continue; }
    out.propose.push({ person, kind, label, confidence });
  }
  return out;
}

/// The proposals already made (pending or refused), never made again.
export function relationKeysSeen(userId: string): Set<string> {
  return new Set((sqlite.prepare("SELECT norm FROM memory_candidates WHERE user_id = ? AND candidate_type = 'relation'").all(userId) as Array<{ norm: string }>).map((row) => row.norm));
}

/// The names the person is known by (their own entity's, their account's).
export function selfNames(userId: string): string[] {
  const self = selfOf(userId);
  const user = sqlite.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string | null } | undefined;
  return [self?.name, user?.name].filter((name): name is string => !!name && !!name.trim());
}

/// A relation found, into « À confirmer ».
export function proposeRelation(userId: string, judged: JudgedPerson, discussionId: string | null, now = Date.now()): string {
  const id = randomUUID();
  const proposal: RelationProposal = { from_name: judged.person.of, to_name: judged.person.name, kind: judged.kind, label: judged.label };
  const content = judged.person.of ? `${judged.person.name} — ${judged.label} (${judged.person.of})` : `${judged.person.name} — ${judged.label}`;
  const family = KIND_GROUP[judged.kind] === "family" || KIND_GROUP[judged.kind] === "couple";
  sqlite.prepare(`INSERT INTO memory_candidates (id, user_id, content, norm, kind, category, confidence, sensitive, evidence, supersedes_id, discussion_id, status, created_at, candidate_type, payload)
    VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, NULL, ?, 'pending', ?, 'relation', ?)`).run(
    id, userId, content, relationKey(proposal), family ? "family" : "other", judged.confidence, family ? 1 : 0, judged.person.evidence.slice(0, 500), discussionId, now, JSON.stringify(proposal),
  );
  return id;
}

/// The people of a conversation's answer, judged and proposed.
export function learnPeople(userId: string, answer: string, context: { personLines: string[]; language: string | null; discussionId: string | null; now?: number }): { proposed: string[]; judged: ReturnType<typeof judgePeople> } {
  const judged = judgePeople(parsePeople(answer), {
    personLines: context.personLines,
    language: context.language,
    selfNames: selfNames(userId),
    known: (proposal) => relationKnown(userId, proposal),
    refused: relationKeysSeen(userId),
  });
  const proposed = judged.propose.map((one) => proposeRelation(userId, one, context.discussionId, context.now ?? Date.now()));
  return { proposed, judged };
}
