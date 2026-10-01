import { and, eq, isNull } from "drizzle-orm";
import { db, memories } from "./db.js";
import { normaliseMemoryContent } from "./vault/contracts.js";
import { isForgottenFact, learnedFactId, memoryWritten, newMemoryId } from "./vault/memories.js";

// What the person asks Twoody to remember, kept as said and at once:
// « retiens que… », « souviens-toi que… », « remember that… » — no model
// involved. What is said in passing is learned once the conversation is
// over, from the whole of it (src/memory/learner.ts, Mémoire v2 L6): the
// model asked after every message (28/09/2026) slowed the next answer and
// took one message alone for a fact.
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

/// « j’habite », as a phone types it, is « j'habite »: the iPhone's
/// keyboard writes the curly apostrophe, and none of its messages matched
/// (30/09/2026).
function straightQuotes(text: string): string {
  return text.replace(/[’‘ʼ]/g, "'");
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

// What the account hands over is data about the person, never how to
// answer: a « feedback » memory (an instruction, chatContext.ts) is taken
// as a fact about the person. The account is not trusted with the model's
// instructions.
const ACCOUNT_KINDS = new Set(["user", "project", "reference"]);
export const MAX_ACCOUNT_MEMORIES = 500;
/// One memory from the account, at most (bytes of UTF-8).
export const MAX_ACCOUNT_MEMORY_BYTES = 8 * 1024;

/// `text` cut to `bytes` of UTF-8, never in the middle of a character.
function cutToBytes(text: string, bytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= bytes) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > bytes) break;
    out += char;
    used += size;
  }
  return out;
}

export function importAccountMemories(userId: string, items: AccountMemory[], now = new Date()) {
  const known = new Set(
    db.select({ content: memories.content }).from(memories)
      .where(and(eq(memories.userId, userId), isNull(memories.supersededById)))
      .all().map((row) => normalize(row.content)),
  );
  const ids: string[] = [];
  let skipped = 0;
  for (const item of items.slice(0, MAX_ACCOUNT_MEMORIES)) {
    const content = typeof item?.content === "string" ? cutToBytes(item.content.trim(), MAX_ACCOUNT_MEMORY_BYTES).trim() : "";
    const key = normalize(content);
    if (!content || !key) continue;
    // A test left it on the account (a `__…__` tag): never a fact about the
    // person (01/10/2026, « Ma fille Claire… » came to a Mac this way).
    if (Array.isArray(item.tags) && item.tags.some((tag) => typeof tag === "string" && /^__.+__$/.test(tag.trim()))) { skipped += 1; continue; }
    // Known here, or forgotten here on purpose (never learned again).
    if (known.has(key) || isForgottenFact(content)) { skipped += 1; continue; }
    known.add(key);
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 200) : null;
    const guessed = typeof item.kind === "string" && ACCOUNT_KINDS.has(item.kind) ? item.kind : kindOfFact(content);
    const kind = guessed === "feedback" ? "user" : guessed;
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
