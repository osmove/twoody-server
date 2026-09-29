import { and, eq, isNull } from "drizzle-orm";
import { db, memories } from "./db.js";
import { generateId } from "./auth.js";

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
  const trimmed = text.trim();
  const match = ASKED.exec(trimmed);
  if (!match || match[0].length === 0) return null;
  const fact = trimmed.slice(match[0].length).replace(/[.!\s]+$/, "").trim();
  return fact.length >= 3 && fact.length <= 500 ? capitalize(fact) : null;
}

// First-person statements that are usually lasting facts about someone.
const PERSONAL = /\b(?:je m'appelle|mon nom est|j'habite|je vis [àa]|je travaille|je suis (?:n[ée]e?|m[ée]decin|avocat|ing[ée]nieur|d[ée]veloppeur|consultant|[ée]tudiant|professeur|mari[ée]e?|c[ée]libataire|v[ée]g[ée]tarien|allergique)|j'ai \d+ ans|mes enfants|ma femme|mon mari|ma fille|mon fils|mon (?:chien|chat)|je pr[ée]f[èe]re|je d[ée]teste|j'adore|my name is|i live in|i work (?:at|for|as)|i am (?:a|an) |i'm (?:a|an) |my (?:wife|husband|son|daughter|kids|dog|cat)|i prefer|i'm allergic)\b/i;

/// Whether a message says something lasting about the person, worth asking
/// the model about.
export function saysSomethingPersonal(text: string): boolean {
  return text.length <= 2000 && PERSONAL.test(text);
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
    const now = new Date();
    db.insert(memories)
      .values({
        id: generateId(),
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

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

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
    let line = raw.trim().replace(/^(?:[-•*·–—]|\d{1,3}[.)])\s+/, "").replace(/^\*\*(.+?)\*\*\s*:?\s*/, "$1 : ").trim();
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
    const id = generateId();
    db.insert(memories).values({
      id, userId, kind: kindOfFact(fact),
      title: fact.length > 60 ? `${fact.slice(0, 57).trimEnd()}…` : fact,
      content: fact, tagsJson: JSON.stringify(["import", source]),
      source: "import", sourceRef: source, createdAt: now, updatedAt: now,
    }).run();
    ids.push(id);
  }
  const archiveId = generateId();
  const day = now.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  db.insert(memories).values({
    id: archiveId, userId, kind: "reference",
    title: `Import ${SOURCE_NAMES[source] === "un autre assistant" ? "d’un autre assistant" : SOURCE_NAMES[source]} du ${day}`,
    content: text.trim().slice(0, 50_000), tagsJson: JSON.stringify(["import", source, "archive"]),
    source: "import", sourceRef: source, createdAt: now, updatedAt: now,
  }).run();
  return { ids, skipped, archiveId };
}
