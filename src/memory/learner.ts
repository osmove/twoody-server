import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, memories, sqlite } from "../db.js";
import { inflight } from "../account/inflight.js";
import { typedText } from "../documentBlocks.js";
import { normaliseMemoryContent } from "../vault/contracts.js";
import { isForgottenFact, learnedFactId, memoryWritten } from "../vault/memories.js";
import { firstPerson, memoryWords } from "./rank.js";
import { askedToRemember } from "../memoryLearning.js";
import { recordTrace } from "../diagnostics/traces.js";

// What Twoody learns from a conversation, once it is over (Mémoire v2, L6,
// docs/memory-v2-design.md §4). Jimmy, 01/10/2026: learn from everything
// said, but only what is worth keeping.
//
// The whole conversation is read at once, never one message alone: a
// message corrected two lines later (« 40 ans… enfin 41 »), a hypothesis
// (« si j'avais trois enfants ») or a doubt (« je crois que c'est mardi »)
// only reads right with what surrounds it, and one model call per message
// slowed the next answer on a small computer. When:
//
//   - a conversation idle for LEARN_IDLE_MS, looked for every TICK_MS;
//   - at once when the person starts a new conversation (learnSoon), so that
//     the one before is known in the next — once the computer answers
//     nothing;
//   - « retiens que… » is kept as said, at once (memoryLearning.ts).
//
// Only the person's words are learned from: the assistant's (≤300 chars
// each) are context, documents and web results are left out. Every fact
// must quote, word for word, the line of the person it comes from. Sure
// facts are kept (tag « learned »); doubtful ones, a fact that changes a
// known one, and anything sensitive go to « À confirmer »
// (memory_candidates); the rest is dropped. Conversations whose memory mode
// is « Aucune » (private ones included) are never read.

export const LEARN_IDLE_MS = 10 * 60_000;
export const TICK_MS = 5 * 60_000;
/// Kept on its own from this confidence, proposed from PROPOSE_AT.
export const SAVE_AT = 0.8;
export const PROPOSE_AT = 0.5;
/// What the model is given of a conversation (the latest part when longer).
const TRANSCRIPT_CHARS = 8_000;
const PERSON_LINE_CHARS = 2_000;
const ASSISTANT_LINE_CHARS = 300;
const MAX_FACTS = 8;
const MAX_KNOWN = 20;
const RETRY_AFTER_MS = 30 * 60_000;

export const SENSITIVE_CATEGORIES = new Set(["health", "finances", "religion", "politics", "sexuality", "legal", "ids", "address"]);
const CATEGORIES = new Set([...SENSITIVE_CATEGORIES, "identity", "family", "work", "home", "preference", "habit", "pet", "project", "date", "other"]);
const KINDS = new Set(["user", "feedback", "project"]);

// Sensitive whatever category the model gave: health, money, beliefs,
// justice, identity numbers, a precise address.
const SENSITIVE_TEXT = /\b(?:maladie|malade|diagnosti\w*|traitement|m[ée]dicament\w*|cancer|diab[èe]t\w*|d[ée]pression|enceinte|grossesse|th[ée]rapie|psychiatr\w*|hospitalis\w*|handicap\w*|salaire|dettes?|cr[ée]dit|emprunt|revenus?|d[ée]couvert|imp[ôo]ts?|religion|religieu\w*|croyant|pratiquant|vote|votes|parti politique|orientation sexuelle|homosexu\w*|bisexu\w*|proc[èe]s|condamn\w*|plainte|casier|num[ée]ro de s[ée]curit[ée] sociale|passeport|iban|carte bancaire|code pin|mot de passe|illness|diagnos\w*|medication|pregnan\w*|therapy|salary|debts?|loan|income|religio\w*|lawsuit|convicted|passport|password|social security)\b/i;
const STREET = /\b\d{1,4}\s*(?:bis|ter)?,?\s+(?:rue|avenue|av\.|boulevard|bd|all[ée]e|impasse|chemin|place|quai|street|st\.|road|rd\.|avenue)\b/i;
// The person was not sure, or imagined it.
const HEDGING = /\b(?:je crois|je pense|il me semble|peut-[êe]tre|probablement|sans doute|je ne sais (?:pas|plus)|si j'avais|si j'[ée]tais|j'aimerais|je voudrais|on verra|i think|i guess|maybe|probably|perhaps|not sure|if i had|if i were|i'd like|i would like)\b/i;

export type LearnMessages = Array<{ role: "system" | "user"; content: string }>;
/// Runs the learning prompt on a model (src/routes/queries.ts gives it).
export type LearningModel = (userId: string, messages: LearnMessages) => Promise<string>;

let model: LearningModel | null = null;
export function setLearningModel(fn: LearningModel | null) {
  model = fn;
}

export interface LearnedFact {
  text: string;
  kind: "user" | "feedback" | "project";
  category: string;
  confidence: number;
  evidence: string;
  /// The ref (« m3 ») of the known memory it changes.
  supersedes: string | null;
}

export interface KnownMemory {
  ref: string;
  id: string;
  text: string;
}

export function learningPrompt(lines: Array<{ role: "person" | "assistant"; content: string }>, known: KnownMemory[]): LearnMessages {
  const transcript = lines.map((line) => `${line.role === "person" ? "PERSON" : "ASSISTANT"}: ${line.content}`).join("\n");
  const knownText = known.length ? known.map((memory) => `${memory.ref}: ${memory.text}`).join("\n") : "(none)";
  return [
    {
      role: "system",
      content:
        "You read a conversation between a person and their assistant and list the lasting facts about the person it reveals, " +
        "to remember in later conversations: who they are, their family and people around them, work, home, pets, projects, " +
        "lasting preferences, habits, important dates, and how they like to be answered.\n" +
        "Rules:\n" +
        "- Only from PERSON lines. ASSISTANT lines are context: never take a fact from them, even one the person does not contradict, and never mix one into a fact the person says.\n" +
        "- The people in their life count too: a relative's or a colleague's name, what happens to them (« Son collègue Paul a eu une fille, Lina »).\n" +
        "- Not questions, hypotheses, wishes, plans that may not happen, today's mood or task, facts about the world.\n" +
        "- Not what KNOWN already says. When the person changes a KNOWN fact, give the new fact and set \"supersedes\" to its ref.\n" +
        "- When the person corrects themselves, only the corrected fact.\n" +        "- Never guess what is not said: who someone is, an animal's species, a relation, a date.\n" +
        "- text: one short sentence about the person, in the language the PERSON writes in, never translated (« A une fille, Léa, 7 ans », « Préfère des réponses courtes »).\n" +
        "- evidence: the exact words of the PERSON line it comes from, copied character for character.\n" +
        "- kind: \"feedback\" for how to answer, \"project\" for something they work on, else \"user\".\n" +
        `- category: one of ${[...CATEGORIES].join(", ")} (health, finances, religion, politics, sexuality, legal, ids — identity or account numbers — and address — their precise home address — are sensitive).\n` +
        "- confidence: 0 to 1, how sure you are the person said it about themselves and it will still be true in months.\n" +
        "Answer with JSON only: {\"facts\":[{\"text\":\"…\",\"kind\":\"user\",\"category\":\"…\",\"confidence\":0.9,\"evidence\":\"…\",\"supersedes\":null}]}. " +
        "Most conversations hold nothing to remember: then {\"facts\":[]}.",
    },
    { role: "user", content: `KNOWN:\n${knownText}\n\nCONVERSATION:\n${transcript}` },
  ];
}

/// The facts of the model's answer; [] when it says none or cannot be read.
export function parseLearning(answer: string): LearnedFact[] {
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
  const facts = (parsed as { facts?: unknown })?.facts;
  if (!Array.isArray(facts)) return [];
  const out: LearnedFact[] = [];
  for (const raw of facts.slice(0, MAX_FACTS)) {
    const fact = raw as Record<string, unknown> | null;
    const factText = typeof fact?.text === "string" ? fact.text.trim().replace(/\s+/g, " ") : "";
    if (factText.length < 3 || factText.length > 300) continue;
    const confidence = typeof fact!.confidence === "number" ? fact!.confidence : Number(fact!.confidence);
    out.push({
      text: factText.charAt(0).toUpperCase() + factText.slice(1),
      kind: typeof fact!.kind === "string" && KINDS.has(fact!.kind) ? (fact!.kind as LearnedFact["kind"]) : "user",
      category: typeof fact!.category === "string" && CATEGORIES.has(fact!.category) ? fact!.category : "other",
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6,
      evidence: typeof fact!.evidence === "string" ? fact!.evidence : "",
      supersedes: typeof fact!.supersedes === "string" && fact!.supersedes.trim() ? fact!.supersedes.trim() : null,
    });
  }
  return out;
}

/// For finding the evidence in what was said: case, accents, quotes and
/// spacing aside.
export function looseText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[’‘ʼ`]/g, "'")
    .replace(/[«»“”"]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/// Where the evidence is in what the person said: the line, and the words
/// around it (for a doubt said just before it, « je crois que… »).
function evidenceFound(evidence: string, personLines: string[]): { line: string; around: string } | null {
  const wanted = looseText(evidence).replace(/^[\s.,;:!?…-]+|[\s.,;:!?…-]+$/g, "");
  if (wanted.length < 3) return null;
  for (const line of personLines) {
    const loose = looseText(line);
    const at = loose.indexOf(wanted);
    if (at >= 0) return { line, around: loose.slice(Math.max(0, at - 60), at + wanted.length + 20) };
  }
  return null;
}

/// Words two facts share, over the words of both (Jaccard).
function overlap(a: string, b: string): number {
  const left = new Set(memoryWords(a));
  const right = new Set(memoryWords(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/// A name or number of the fact that the person never wrote and the
/// assistant did (« le 29 novembre », restated from a memory): taken from
/// the assistant's words.
function fromAssistant(text: string, personLines: string[], assistantLines: string[]): boolean {
  if (!assistantLines.length) return false;
  const person = looseText(personLines.join(" "));
  const assistant = looseText(assistantLines.join(" "));
  const tokens = text.match(/\p{N}+|(?<=\s)\p{Lu}[\p{L}'-]+/gu) ?? [];
  return tokens.some((token) => {
    const loose = looseText(token);
    const word = new RegExp(`(^|[^\\p{L}\\p{N}])${loose.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u");
    return !word.test(person) && word.test(assistant);
  });
}

export interface Judged {
  fact: LearnedFact;
  confidence: number;
  sensitive: boolean;
  supersedesId: string | null;
}

export interface Judgement {
  save: Judged[];
  propose: Judged[];
  dropped: Array<{ fact: LearnedFact; reason: string }>;
}

/// What becomes of each fact the model gave: kept, proposed or dropped.
/// No database: what it needs is handed to it.
export function judgeFacts(
  facts: LearnedFact[],
  context: { personLines: string[]; assistantLines?: string[]; known: KnownMemory[]; refused?: ReadonlySet<string>; forgotten?: (text: string) => boolean; askedLines?: ReadonlySet<string> },
): Judgement {
  const out: Judgement = { save: [], propose: [], dropped: [] };
  const seen = new Set<string>();
  const knownNorms = new Map(context.known.map((memory) => [normaliseMemoryContent(memory.text), memory]));
  for (const fact of facts) {
    const norm = normaliseMemoryContent(fact.text);
    if (!norm || seen.has(norm)) { out.dropped.push({ fact, reason: "repeated" }); continue; }
    seen.add(norm);
    const found = evidenceFound(fact.evidence, context.personLines);
    if (!found) { out.dropped.push({ fact, reason: "no_evidence" }); continue; }
    // « Retiens que… »: kept as said already, at once (memoryLearning.ts).
    if (context.askedLines?.has(found.line)) { out.dropped.push({ fact, reason: "asked" }); continue; }
    if (fromAssistant(fact.text, context.personLines, context.assistantLines ?? [])) { out.dropped.push({ fact, reason: "from_assistant" }); continue; }
    if (context.refused?.has(norm)) { out.dropped.push({ fact, reason: "refused" }); continue; }
    if (context.forgotten?.(fact.text)) { out.dropped.push({ fact, reason: "forgotten" }); continue; }
    const supersedes = fact.supersedes ? context.known.find((memory) => memory.ref === fact.supersedes) ?? null : null;
    // Said again, in other words or the same: known already.
    if (knownNorms.has(norm) || context.known.some((memory) => memory !== supersedes && overlap(memory.text, fact.text) >= 0.75)) {
      out.dropped.push({ fact, reason: "known" });
      continue;
    }
    let confidence = fact.confidence;
    if (firstPerson(fact.evidence)) confidence += 0.15;
    if (HEDGING.test(found.around)) confidence -= 0.3;
    confidence = Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;
    const loose = looseText(fact.text);
    const sensitive = SENSITIVE_CATEGORIES.has(fact.category) || SENSITIVE_TEXT.test(loose) || STREET.test(loose);
    const judged: Judged = { fact, confidence, sensitive, supersedesId: supersedes?.id ?? null };
    if (confidence < PROPOSE_AT) out.dropped.push({ fact, reason: "unsure" });
    else if (confidence >= SAVE_AT && !sensitive && !supersedes) out.save.push(judged);
    else out.propose.push(judged);
  }
  return out;
}

// ── Reading a conversation ─────────────────────────────────────────────

interface MessageRow { rowid: number; role: string; content: string }

/// The memories the model is shown, so that it neither learns them again
/// nor misses one it changes: the ones sharing the most words with what the
/// person said.
function knownFor(userId: string, said: string): KnownMemory[] {
  const rows = sqlite.prepare(
    "SELECT id, title, content, tags_json FROM memories WHERE user_id = ? AND superseded_by_id IS NULL ORDER BY updated_at DESC LIMIT 2000",
  ).all(userId) as Array<{ id: string; title: string | null; content: string; tags_json: string }>;
  const words = new Set(memoryWords(said));
  const scored = rows
    .filter((row) => !row.tags_json.includes("\"archive\"") && row.content.length <= 600)
    .map((row) => ({ row, shared: memoryWords(row.content).filter((word) => words.has(word)).length }))
    .filter((entry) => entry.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, MAX_KNOWN);
  return scored.map(({ row }, index) => ({ ref: `m${index + 1}`, id: row.id, text: row.content.replace(/\s+/g, " ").trim() }));
}

function refusedNorms(userId: string): Set<string> {
  const rows = sqlite.prepare("SELECT norm FROM memory_candidates WHERE user_id = ? AND status IN ('pending', 'rejected')").all(userId) as Array<{ norm: string }>;
  return new Set(rows.map((row) => row.norm));
}

/// Whether this conversation may be learned from: its memory mode (its
/// own, else the person's) is not « Aucune », nor memory switched off.
function learnable(discussionId: string): boolean {
  return !!sqlite.prepare("SELECT 1 FROM message_fts_conversations WHERE discussion_id = ?").get(discussionId);
}

export interface LearnResult {
  discussion_id: string;
  read: number;
  saved: string[];
  proposed: string[];
  dropped: number;
}

const failedAt = new Map<string, number>();
const busyDiscussions = new Set<string>();

/// Learns from what was said in this conversation since last time.
export async function learnDiscussion(discussionId: string, options: { ask?: LearningModel | null; now?: number } = {}): Promise<LearnResult | null> {
  const ask = options.ask ?? model;
  const row = sqlite.prepare("SELECT id, user_id, learned_through FROM discussions WHERE id = ?").get(discussionId) as
    { id: string; user_id: string; learned_through: number | null } | undefined;
  if (!row || busyDiscussions.has(discussionId)) return null;
  const result: LearnResult = { discussion_id: row.id, read: 0, saved: [], proposed: [], dropped: 0 };
  const rows = sqlite.prepare("SELECT rowid, role, content FROM messages WHERE discussion_id = ? AND rowid > ? ORDER BY rowid").all(row.id, row.learned_through ?? 0) as MessageRow[];
  if (!rows.length) return result;
  const through = rows.at(-1)!.rowid;
  const advance = () => sqlite.prepare("UPDATE discussions SET learned_through = ? WHERE id = ? AND COALESCE(learned_through, 0) < ?").run(through, row.id, through);
  if (!learnable(row.id)) {
    // Never read; and not later either, should its mode change.
    advance();
    return result;
  }
  const lines: Array<{ role: "person" | "assistant"; content: string }> = [];
  for (const message of rows) {
    if (message.role === "user") {
      const text = typedText(message.content).replace(/\s+/g, " ").trim().slice(0, PERSON_LINE_CHARS);
      if (text) lines.push({ role: "person", content: text });
    } else if (message.role === "assistant") {
      const text = message.content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/\s+/g, " ").trim();
      if (text) lines.push({ role: "assistant", content: text.length > ASSISTANT_LINE_CHARS ? `${text.slice(0, ASSISTANT_LINE_CHARS - 1)}…` : text });
    }
  }
  // The latest part, when the conversation is long.
  let total = 0;
  let from = lines.length;
  while (from > 0 && total + lines[from - 1]!.content.length + 12 <= TRANSCRIPT_CHARS) total += lines[--from]!.content.length + 12;
  const shown = lines.slice(from);
  const personLines = shown.filter((line) => line.role === "person").map((line) => line.content);
  result.read = personLines.length;
  if (!personLines.length) {
    advance();
    return result;
  }
  if (!ask) return null;
  busyDiscussions.add(row.id);
  const learnStarted = Date.now();
  try {
    const known = knownFor(row.user_id, personLines.join(" "));
    let answer: string;
    try {
      answer = await ask(row.user_id, learningPrompt(shown, known));
    } catch (err) {
      failedAt.set(row.id, options.now ?? Date.now());
      throw err;
    }
    failedAt.delete(row.id);
    const assistantLines = shown.filter((line) => line.role === "assistant").map((line) => line.content);
    const askedLines = new Set(personLines.filter((line) => askedToRemember(line) !== null));
    const facts = parseLearning(answer);
    const judged = judgeFacts(facts, { personLines, assistantLines, known, refused: refusedNorms(row.user_id), forgotten: isForgottenFact, askedLines });
    // What it made of the conversation, for the Diagnostic screen.
    recordTrace(row.user_id, {
      kind: "learn",
      discussionId: row.id,
      outcome: "answered",
      totalMs: Date.now() - learnStarted,
      detail: {
        lines: { person: personLines.length, assistant: assistantLines.length, known: known.length },
        facts: facts.length,
        saved: judged.save.map((j) => ({ text: j.fact.text, confidence: j.confidence })),
        proposed: judged.propose.map((j) => ({ text: j.fact.text, confidence: j.confidence, sensitive: j.sensitive, supersedes: !!j.supersedesId })),
        dropped: judged.dropped.map((d) => ({ text: d.fact.text, reason: d.reason })),
      },
    });
    result.dropped = judged.dropped.length;
    for (const fact of judged.save) {
      const id = keepLearned(row.user_id, fact, row.id);
      if (id) result.saved.push(id);
    }
    for (const fact of judged.propose) {
      const id = proposeLearned(row.user_id, fact, row.id, options.now ?? Date.now());
      if (id) result.proposed.push(id);
    }
    if (result.saved.length || result.proposed.length) {
      sqlite.prepare("INSERT INTO memory_notices (id, user_id, discussion_id, saved_json, proposed, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), row.user_id, row.id, JSON.stringify(result.saved), result.proposed.length, options.now ?? Date.now());
    }
    advance();
    return result;
  } finally {
    busyDiscussions.delete(row.id);
  }
}

/// A learned fact kept as a memory, unless one with that content is there.
function keepLearned(userId: string, judged: Judged, discussionId: string, extraTags: string[] = []): string | null {
  const text = judged.fact.text;
  const norm = normaliseMemoryContent(text);
  const present = (sqlite.prepare("SELECT content FROM memories WHERE user_id = ? AND superseded_by_id IS NULL").all(userId) as Array<{ content: string }>)
    .some((memory) => normaliseMemoryContent(memory.content) === norm);
  if (present) return null;
  const id = learnedFactId(text);
  if (db.select({ id: memories.id }).from(memories).where(eq(memories.id, id)).limit(1).all().length) return null;
  const now = new Date();
  db.insert(memories).values({
    id,
    userId,
    kind: judged.fact.kind,
    title: text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text,
    content: text,
    tagsJson: JSON.stringify(["learned", ...extraTags]),
    source: "conversation",
    sourceRef: discussionId,
    createdAt: now,
    updatedAt: now,
  }).run();
  return memoryWritten(id);
}

function proposeLearned(userId: string, judged: Judged, discussionId: string, now: number): string {
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO memory_candidates (id, user_id, content, norm, kind, category, confidence, sensitive, evidence, supersedes_id, discussion_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
    id, userId, judged.fact.text, normaliseMemoryContent(judged.fact.text), judged.fact.kind, judged.fact.category,
    judged.confidence, judged.sensitive ? 1 : 0, judged.fact.evidence.slice(0, 500), judged.supersedesId, discussionId, now,
  );
  return id;
}

// ── « À confirmer » ─────────────────────────────────────────────────────

export interface CandidateRow {
  id: string;
  content: string;
  kind: string;
  category: string | null;
  confidence: number;
  sensitive: boolean;
  evidence: string | null;
  supersedes: { id: string; content: string } | null;
  discussion_id: string | null;
  created_at: string;
}

export function listCandidates(userId: string): CandidateRow[] {
  const rows = sqlite.prepare(`SELECT c.*, m.content AS superseded_content FROM memory_candidates c
    LEFT JOIN memories m ON m.id = c.supersedes_id AND m.user_id = c.user_id
    WHERE c.user_id = ? AND c.status = 'pending' ORDER BY c.created_at DESC LIMIT 200`).all(userId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    content: String(row.content),
    kind: String(row.kind),
    category: (row.category as string | null) ?? null,
    confidence: Number(row.confidence),
    sensitive: row.sensitive === 1,
    evidence: (row.evidence as string | null) ?? null,
    supersedes: row.supersedes_id && typeof row.superseded_content === "string" ? { id: String(row.supersedes_id), content: row.superseded_content } : null,
    discussion_id: (row.discussion_id as string | null) ?? null,
    created_at: new Date(Number(row.created_at)).toISOString(),
  }));
}

export class CandidateError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

/// The person keeps it — as proposed, or as they corrected it. A fact that
/// changes a known one replaces that one's content. Returns the memory's id.
export function acceptCandidate(userId: string, id: string, content?: string | null, now = Date.now()): string {
  const row = sqlite.prepare("SELECT * FROM memory_candidates WHERE id = ? AND user_id = ? AND status = 'pending'").get(id, userId) as
    { content: string; kind: string; category: string | null; confidence: number; sensitive: number; evidence: string | null; supersedes_id: string | null; discussion_id: string | null } | undefined;
  if (!row) throw new CandidateError(404, "not_found");
  const text = typeof content === "string" && content.trim() ? content.trim().replace(/\s+/g, " ").slice(0, 2000) : row.content;
  const tags = row.sensitive ? ["sensitive"] : [];
  let memoryId: string | null = null;
  const replaced = row.supersedes_id
    ? db.select().from(memories).where(eq(memories.id, row.supersedes_id)).limit(1).all().find((memory) => memory.userId === userId) ?? null
    : null;
  if (replaced) {
    let kept: string[] = [];
    try { kept = JSON.parse(replaced.tagsJson); } catch { /* none */ }
    db.update(memories).set({
      content: text,
      title: text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text,
      tagsJson: JSON.stringify([...new Set([...kept.filter((tag) => typeof tag === "string"), ...tags])]),
      updatedAt: new Date(now),
    }).where(eq(memories.id, replaced.id)).run();
    memoryId = memoryWritten(replaced.id, "edit");
  } else {
    const judged: Judged = {
      fact: { text, kind: (KINDS.has(row.kind) ? row.kind : "user") as LearnedFact["kind"], category: row.category ?? "other", confidence: row.confidence, evidence: row.evidence ?? "", supersedes: null },
      confidence: row.confidence, sensitive: row.sensitive === 1, supersedesId: null,
    };
    memoryId = keepLearned(userId, judged, row.discussion_id ?? "", tags);
    if (!memoryId) {
      // The same content is there already.
      const norm = normaliseMemoryContent(text);
      const existing = (sqlite.prepare("SELECT id, content FROM memories WHERE user_id = ? AND superseded_by_id IS NULL").all(userId) as Array<{ id: string; content: string }>)
        .find((memory) => normaliseMemoryContent(memory.content) === norm);
      memoryId = existing?.id ?? null;
    }
  }
  sqlite.prepare("UPDATE memory_candidates SET status = 'accepted', memory_id = ?, decided_at = ? WHERE id = ?").run(memoryId, now, id);
  if (!memoryId) throw new CandidateError(409, "not_kept");
  return memoryId;
}

/// The person does not want it: never proposed again.
export function rejectCandidate(userId: string, id: string, now = Date.now()): void {
  const result = sqlite.prepare("UPDATE memory_candidates SET status = 'rejected', decided_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'").run(now, id, userId);
  if (result.changes === 0) throw new CandidateError(404, "not_found");
}

// ── When ───────────────────────────────────────────────────────────────

/// Conversations with something new the person said, quiet since `idleMs`
/// (0: any), oldest first.
export function pendingDiscussions(options: { userId?: string; idleMs: number; now?: number; except?: string | null; limit?: number }): string[] {
  const now = options.now ?? Date.now();
  const before = Math.floor((now - options.idleMs) / 1000);
  const rows = sqlite.prepare(`SELECT d.id FROM discussions d
    WHERE (? IS NULL OR d.user_id = ?) AND d.id IS NOT ? AND d.last_activity_at <= ?
      AND EXISTS (SELECT 1 FROM messages m WHERE m.discussion_id = d.id AND m.role = 'user' AND m.rowid > COALESCE(d.learned_through, 0))
    ORDER BY d.last_activity_at LIMIT ?`).all(options.userId ?? null, options.userId ?? null, options.except ?? null, before, options.limit ?? 10) as Array<{ id: string }>;
  return rows
    .map((row) => row.id)
    .filter((id) => {
      const failed = failedAt.get(id);
      return failed === undefined || now - failed >= RETRY_AFTER_MS;
    });
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let started = false;
const soon = new Map<string, string | null>();
const BUSY_RETRY_MS = 5_000;
const SOON_MS = 2_000;

async function runOnce(now = Date.now()) {
  if (running || !model) return;
  running = true;
  try {
    const urgent = [...soon.entries()];
    soon.clear();
    const queue = [
      ...urgent.flatMap(([userId, except]) => pendingDiscussions({ userId, idleMs: 0, except, now })),
      ...pendingDiscussions({ idleMs: LEARN_IDLE_MS, now }),
    ];
    for (const id of [...new Set(queue)]) {
      // An answer goes first: what is left waits for the computer to be quiet.
      if (inflight() > 0) {
        for (const [userId, except] of urgent) soon.set(userId, except);
        schedule(BUSY_RETRY_MS);
        return;
      }
      await learnDiscussion(id).catch(() => null);
    }
  } finally {
    running = false;
  }
}

function schedule(ms: number) {
  if (!started) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runOnce().finally(() => {
      if (!timer) schedule(soon.size ? BUSY_RETRY_MS : TICK_MS);
    });
  }, ms);
  timer.unref?.();
}

/// The person started a new conversation: the ones before are read as soon
/// as the computer answers nothing (the new one's first answer included).
export function learnSoon(userId: string, except: string | null = null) {
  // Only on a running server (startLearning); a test's app learns when asked.
  if (!started) return;
  soon.set(userId, except);
  schedule(SOON_MS);
}

export function startLearning(options: { firstTickMs?: number } = {}) {
  started = true;
  schedule(options.firstTickMs ?? 60_000);
  return {
    stop() {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/// One pass now (tests).
export async function learnPendingNow(now?: number) {
  await runOnce(now);
}

// ── Telling the person ─────────────────────────────────────────────────
// « Mémoire mise à jour » in the conversation a memory came from, and
// « Twoody a retenu 2 choses de votre conversation précédente » once, in
// the next one (Jimmy, 01/10/2026: like ChatGPT and Claude).

export interface MemoryNotice {
  id: string;
  discussion_id: string;
  discussion_title: string | null;
  /// What was kept, as it reads now (a memory deleted since is left out).
  saved: Array<{ id: string; content: string }>;
  /// How many went to « À confirmer ».
  proposed: number;
  created_at: string;
}

function readNotices(rows: Array<{ id: string; discussion_id: string; title: string | null; saved_json: string; proposed: number; created_at: number }>, userId: string): MemoryNotice[] {
  const content = sqlite.prepare("SELECT content FROM memories WHERE id = ? AND user_id = ?");
  return rows.map((row) => {
    let ids: string[] = [];
    try { ids = JSON.parse(row.saved_json); } catch { /* none */ }
    const saved = ids.flatMap((id) => {
      const memory = content.get(id, userId) as { content: string } | undefined;
      return memory ? [{ id, content: memory.content }] : [];
    });
    return { id: row.id, discussion_id: row.discussion_id, discussion_title: row.title, saved, proposed: row.proposed, created_at: new Date(row.created_at).toISOString() };
  }).filter((notice) => notice.saved.length || notice.proposed);
}

/// What was learned from this conversation, oldest first.
export function noticesOf(userId: string, discussionId: string): MemoryNotice[] {
  return readNotices(sqlite.prepare(`SELECT n.id, n.discussion_id, d.title, n.saved_json, n.proposed, n.created_at FROM memory_notices n
    LEFT JOIN discussions d ON d.id = n.discussion_id WHERE n.user_id = ? AND n.discussion_id = ? ORDER BY n.created_at`).all(userId, discussionId) as never, userId);
}

/// What was learned and not told yet — told now, once, whichever device
/// asks first. `except`: the conversation open (it says so itself).
export function takeMemoryNews(userId: string, except: string | null = null): MemoryNotice[] {
  const rows = sqlite.prepare(`SELECT n.id, n.discussion_id, d.title, n.saved_json, n.proposed, n.created_at FROM memory_notices n
    LEFT JOIN discussions d ON d.id = n.discussion_id WHERE n.user_id = ? AND n.announced = 0 AND n.discussion_id IS NOT ? ORDER BY n.created_at LIMIT 20`).all(userId, except) as Array<{ id: string }>;
  const mark = sqlite.prepare("UPDATE memory_notices SET announced = 1 WHERE id = ?");
  for (const row of rows) mark.run(row.id);
  return readNotices(rows as never, userId);
}
