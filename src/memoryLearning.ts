import { and, eq, isNull } from "drizzle-orm";
import { db, memories } from "./db.js";
import { normaliseMemoryContent } from "./vault/contracts.js";
import { isForgottenFact, learnedFactId, memoryWritten, newMemoryId } from "./vault/memories.js";

// What Twoody learns from a conversation (Jimmy, 28/09/2026: the Memories
// screen stayed empty — the « memory » tools were announced to the model
// but nothing ran them). Two ways in, both after the answer, never in its
// way:
//
//   - asked outright: « retiens que… », « souviens-toi que… », « remember
//     that… » — kept as said, no model involved;
//   - said in passing: « je m'appelle… », « ma fille s'appelle… », « je
//     travaille chez… » — the model that answered is asked, once the answer
//     is written, which lasting facts about the person the message holds.
//
// Kept on this computer like the rest (source « conversation »), shown and
// editable in Memories, and never the same fact twice.

const ASKED = /^(?:(?:est-ce que\s+)?(?:tu\s+peux|peux-tu|pourrais-tu)\s+)?(?:retiens|retenir|souviens[- ]toi|rappelle[- ]toi|note|noter|m[ée]morise|m[ée]moriser|n'oublie pas|remember|keep in mind|note that|don't forget)\s*(?:bien\s+)?(?:que|qu'|:|,|that)?\s*/i;

/// What the person asked to be remembered, as they said it; null when the
/// message asks nothing of the kind.
export function askedToRemember(text: string): string | null {
  const trimmed = straightQuotes(text).trim();
  const match = ASKED.exec(trimmed);
  if (!match || match[0].length === 0) return null;
  const fact = trimmed.slice(match[0].length).replace(/[.!\s]+$/, "").trim();
  return fact.length >= 3 && fact.length <= 500 ? capitalize(fact) : null;
}

// First-person statements that are usually lasting facts about someone.
const PERSONAL = /\b(?:je m'appelle|mon nom est|mon pr[ée]nom|j'habite|je vis [àa]|je travaille|je suis originaire|mon anniversaire|je suis (?:n[ée]e?|m[ée]decin|avocat|ing[ée]nieur|d[ée]veloppeur|consultant|[ée]tudiant|professeur|mari[ée]e?|c[ée]libataire|v[ée]g[ée]tarien|allergique)|j'ai \d+ ans|mes enfants|ma femme|mon mari|ma fille|mon fils|ma compagne|mon compagnon|mes parents|ma m[èe]re|mon p[èe]re|ma s(?:œ|oe)ur|mon fr[èe]re|mon entreprise|ma soci[ée]t[ée]|mon (?:chien|chat)|je pr[ée]f[èe]re|je d[ée]teste|j'adore|my name is|i live in|i work (?:at|for|as)|i am (?:a|an) |i'm (?:a|an) |my (?:wife|husband|son|daughter|kids|dog|cat)|i prefer|i'm allergic)\b/i;

/// Whether a message says something lasting about the person, worth asking
/// the model about.
export function saysSomethingPersonal(text: string): boolean {
  return text.length <= 2000 && PERSONAL.test(straightQuotes(text));
}

/// « j’habite », as a phone types it, is « j'habite »: the iPhone's
/// keyboard writes the curly apostrophe, and none of its messages matched
/// (30/09/2026).
function straightQuotes(text: string): string {
  return text.replace(/[’‘ʼ]/g, "'");
}

/// The request the answering model gets, once its answer is written.
export function extractionPrompt(message: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content:
        "You extract lasting facts about the user from one of their messages: their name, family, work, where they live, " +
        "preferences, allergies, important dates. Not the question itself, not temporary states, not facts about other topics. " +
        "Answer with one fact per line, each a short sentence in the language of the message, starting with « - ». " +
        "If there is none, answer exactly: NONE",
    },
    { role: "user", content: message.slice(0, 2000) },
  ];
}

/// The facts in the model's answer to extractionPrompt.
export function parseFacts(answer: string): string[] {
  if (/^\s*NONE\s*$/i.test(answer)) return [];
  return answer
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-•*]\s+/.test(line))
    .map((line) => capitalize(line.replace(/^[-•*]\s+/, "").replace(/\s+$/, "")))
    .filter((fact) => fact.length >= 3 && fact.length <= 300)
    .slice(0, 5);
}

/// Keeps these facts as memories of the person, the ones already known
/// left out. Returns how many were added.
export function rememberFacts(userId: string, facts: string[], sourceRef: string | null = null): number {
  const known = new Set(
    db
      .select({ content: memories.content })
      .from(memories)
      .where(and(eq(memories.userId, userId), isNull(memories.supersededById)))
      .all()
      .map((row) => normalize(row.content)),
  );
  let added = 0;
  for (const fact of facts) {
    const key = normalize(fact);
    if (!key || known.has(key)) continue;
    known.add(key);
    // Deleted by the person, here or on another of their computers: not again.
    if (isForgottenFact(fact)) continue;
    // Learned on another computer of the vault already: the same id.
    const id = learnedFactId(fact);
    if (db.select({ id: memories.id }).from(memories).where(eq(memories.id, id)).limit(1).all().length) continue;
    const now = new Date();
    db.insert(memories)
      .values({
        id,
        userId,
        kind: "user",
        title: fact.length > 60 ? `${fact.slice(0, 57).trimEnd()}…` : fact,
        content: fact,
        tagsJson: "[]",
        source: "conversation",
        sourceRef,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // To the other computers of the vault, when this one is a member.
    memoryWritten(id);
    added += 1;
  }
  return added;
}

/// After an answer: what the message asked to be remembered, or the lasting
/// facts it holds, kept. `ask` runs the extraction on the answering model.
export async function learnFromMessage(args: {
  userId: string;
  message: string;
  sourceRef?: string | null;
  ask: (messages: ReturnType<typeof extractionPrompt>) => Promise<string>;
}): Promise<number> {
  const asked = askedToRemember(args.message);
  if (asked) return rememberFacts(args.userId, [asked], args.sourceRef ?? null);
  if (!saysSomethingPersonal(args.message)) return 0;
  const facts = parseFacts(await args.ask(extractionPrompt(args.message)));
  return rememberFacts(args.userId, facts, args.sourceRef ?? null);
}

/// The vault's normalisation (src/vault/contracts.ts): the same fact
/// written differently is known, in any script — the older a-z0-9 one made
/// every Hebrew or Cyrillic fact the same empty string, never learned.
const normalize = normaliseMemoryContent;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── Imported from another assistant ────────────────────────────────────
// ChatGPT, Claude, Gemini, Copilot… asked, with the prompt the Memories
// screens give, to list what they know of the person, one fact per line.
// The answer is pasted back here (Jimmy, 29/09/2026: « importer la
// mémoire, et sauvegarder tous les éléments utiles »): each line becomes a
// memory, and the whole answer is kept too, so that nothing is lost to the
// splitting.

export const IMPORT_SOURCES = ["chatgpt", "claude", "gemini", "copilot", "other"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

const SOURCE_NAMES: Record<ImportSource, string> = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", copilot: "Copilot", other: "un autre assistant" };

/// The facts of a pasted answer: one per line, bullets and numbering
/// stripped, headings and blank or very short lines left out, never twice.
export function factsFromImport(text: string): string[] {
  const seen = new Set<string>();
  const facts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim().replace(/^(?:[-•*·–—]|\d{1,3}[.)])\s+/, "").replace(/^\*\*(.+?)\s*:?\*\*\s*:?\s*/, "$1 : ").trim();
    line = line.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    if (line.length < 8 || line.length > 600) continue;
    if (/^#{1,6}\s/.test(raw.trim()) || /:$/.test(line)) continue; // a heading
    const key = normalize(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    facts.push(capitalize(line));
    if (facts.length >= 200) break;
  }
  return facts;
}

/// user / feedback (how to answer) / project, as the Memories screens sort them.
export function kindOfFact(fact: string): "user" | "feedback" | "project" {
  if (/\b(pr[ée]f[èe]re|r[ée]ponds?|r[ée]pondre|tutoie|vouvoie|ton |format|langue|concis|d[ée]taill|prefers?|respond|reply|replies|tone|concise|language|format)\b/i.test(fact)) return "feedback";
  if (/\b(projets?|travaille sur|d[ée]veloppe|construit|startup|lance|project|working on|building|launch)/i.test(fact)) return "project";
  return "user";
}

/// Keeps a pasted answer: its facts as memories (the known ones left out)
/// and the whole answer as one « reference » memory.
export function importMemories(userId: string, text: string, source: ImportSource, now = new Date()) {
  const facts = factsFromImport(text);
  const known = new Set(
    db.select({ content: memories.content }).from(memories)
      .where(and(eq(memories.userId, userId), isNull(memories.supersededById)))
      .all().map((row) => normalize(row.content)),
  );
  const ids: string[] = [];
  let skipped = 0;
  for (const fact of facts) {
    const key = normalize(fact);
    if (known.has(key)) { skipped += 1; continue; }
    known.add(key);
    const id = newMemoryId();
    db.insert(memories).values({
      id, userId, kind: kindOfFact(fact),
      title: fact.length > 60 ? `${fact.slice(0, 57).trimEnd()}…` : fact,
      content: fact, tagsJson: JSON.stringify(["import", source]),
      source: "import", sourceRef: source, createdAt: now, updatedAt: now,
    }).run();
    ids.push(memoryWritten(id));
  }
  const archiveId = newMemoryId();
  const day = now.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  db.insert(memories).values({
    id: archiveId, userId, kind: "reference",
    title: `Import ${SOURCE_NAMES[source] === "un autre assistant" ? "d’un autre assistant" : SOURCE_NAMES[source]} du ${day}`,
    content: text.trim().slice(0, 50_000), tagsJson: JSON.stringify(["import", source, "archive"]),
    source: "import", sourceRef: source, createdAt: now, updatedAt: now,
  }).run();
  // Longer than a memory event may be, the whole answer usually stays here.
  return { ids, skipped, archiveId: memoryWritten(archiveId) };
}

// ── Taken over from the account ────────────────────────────────────────
// The memories the Twoody account learned before this computer kept them
// (twoody-backend GET /api/v1/account_memories): the iPhone or the Desktop
// reads them there and hands them here, one memory each, title, kind and
// date kept; the known ones left out, by the same normalisation. The
// account forgets them afterwards, when the person says so.

export interface AccountMemory {
  kind?: unknown;
  title?: unknown;
  content?: unknown;
  tags?: unknown;
  created_at?: unknown;
}

const MEMORY_KINDS = new Set(["user", "feedback", "project", "reference"]);
export const MAX_ACCOUNT_MEMORIES = 500;

export function importAccountMemories(userId: string, items: AccountMemory[], now = new Date()) {
  const known = new Set(
    db.select({ content: memories.content }).from(memories)
      .where(and(eq(memories.userId, userId), isNull(memories.supersededById)))
      .all().map((row) => normalize(row.content)),
  );
  const ids: string[] = [];
  let skipped = 0;
  for (const item of items.slice(0, MAX_ACCOUNT_MEMORIES)) {
    const content = typeof item?.content === "string" ? item.content.trim().slice(0, 50_000) : "";
    const key = normalize(content);
    if (!content || !key) continue;
    // Known here, or forgotten here on purpose (never learned again).
    if (known.has(key) || isForgottenFact(content)) { skipped += 1; continue; }
    known.add(key);
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 200) : null;
    const kind = typeof item.kind === "string" && MEMORY_KINDS.has(item.kind) ? item.kind : kindOfFact(content);
    const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string" && tag !== "import" && tag !== "account").slice(0, 20) : [];
    const created = typeof item.created_at === "string" && !Number.isNaN(Date.parse(item.created_at)) ? new Date(item.created_at) : now;
    const id = newMemoryId();
    db.insert(memories).values({
      id, userId, kind, title, content,
      tagsJson: JSON.stringify([...tags, "import", "account"]),
      source: "import", sourceRef: "account", createdAt: created, updatedAt: now,
    }).run();
    ids.push(memoryWritten(id));
  }
  return { ids, skipped };
}
