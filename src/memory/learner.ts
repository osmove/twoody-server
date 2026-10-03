import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, memories, sqlite } from "../db.js";
import { inflight, onChatGeneration } from "../account/inflight.js";
import { typedText } from "../documentBlocks.js";
import { normaliseMemoryContent } from "../vault/contracts.js";
import { isForgottenFact, learnedFactId, memoryWritten } from "../vault/memories.js";
import { firstPerson, memoryWords, sameWord } from "./rank.js";
import { askedToRemember } from "../memoryLearning.js";
import { recordTrace } from "../diagnostics/traces.js";
import { createProject, knownProjects, PROJECT_SIZES, updateProject, type ProjectSize } from "../projects/projects.js";

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
//   - after each answer (learnAfterAnswer): what was just said, with the
//     messages before it as context, so « Mémoire enregistrée » shows
//     seconds later (Jimmy, 01/10/2026: « C'est noté » and nothing kept).
//     The next message stops it at once (yieldToAnswer) and it starts over
//     after: an answer never waits for it;
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
/// Messages already read, given again before the new ones so that « ils »,
/// « elle » or « en 2019 » read right; never learned from twice.
const EARLIER_MESSAGES = 6;
const EARLIER_CHARS = 3_000;

export const SENSITIVE_CATEGORIES = new Set(["health", "finances", "religion", "politics", "sexuality", "legal", "ids", "address"]);
const CATEGORIES = new Set([...SENSITIVE_CATEGORIES, "identity", "family", "work", "home", "preference", "habit", "pet", "project", "date", "other"]);
const KINDS = new Set(["user", "feedback", "project"]);

// Sensitive whatever category the model gave: health, money, beliefs,
// justice, identity numbers, a precise address.
const SENSITIVE_TEXT = /\b(?:maladie|malade|diagnosti\w*|traitement|m[ée]dicament\w*|cancer|diab[èe]t\w*|d[ée]pression|enceinte|grossesse|th[ée]rapie|psychiatr\w*|hospitalis\w*|handicap\w*|salaire|dettes?|cr[ée]dit|emprunt|revenus?|d[ée]couvert|imp[ôo]ts?|religion|religieu\w*|croyant|pratiquant|vote|votes|parti politique|orientation sexuelle|homosexu\w*|bisexu\w*|proc[èe]s|condamn\w*|plainte|casier|num[ée]ro de s[ée]curit[ée] sociale|passeport|iban|carte bancaire|code pin|mot de passe|illness|diagnos\w*|medication|pregnan\w*|therapy|salary|debts?|loan|income|religio\w*|lawsuit|convicted|passport|password|social security)\b/i;
const STREET = /\b\d{1,4}\s*(?:bis|ter)?,?\s+(?:rue|avenue|av\.|boulevard|bd|all[ée]e|impasse|chemin|place|quai|street|st\.|road|rd\.|avenue)\b/i;
// The person was not sure, or imagined it.
const HEDGING = /\b(?:je crois|je pense|il me semble|peut-[êe]tre|probablement|sans doute|je ne sais (?:pas|plus)|si j'avais|si j'[ée]tais|si un jour|un jour peut|j'aimerais|je voudrais|j'\w+erais|je \w+erais|on verra|i think|i guess|maybe|probably|perhaps|not sure|if i had|if i were|i'd like|i would like|someday|one day)\b/i;

// A wish or a hypothesis, not something under way.
const HYPOTHESIS = /\b(?:si un jour|un jour peut|si j'avais|si j'[ée]tais|si (?:je|j'|on) (?:gagne|avai)|j'\w+erais|je \w+erais|on \w+erait|j'aimerais|je voudrais|je r[êe]ve|someday|one day|if i had|if i were|i would|i'd love)\b/i;

export type LearnMessages = Array<{ role: "system" | "user"; content: string }>;
/// Runs the learning prompt on a model (src/routes/queries.ts gives it).
export type LearningModel = (userId: string, messages: LearnMessages, signal?: AbortSignal) => Promise<string>;

let model: LearningModel | null = null;
/// The model the learning reads with (memory/discover.ts too).
export function learningModel(): LearningModel | null {
  return model;
}

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

export function learningPrompt(lines: Array<{ role: "person" | "assistant"; content: string }>, known: KnownMemory[], projects: KnownProject[] = [], earlier: Array<{ role: "person" | "assistant"; content: string }> = []): LearnMessages {
  const asText = (rows: typeof lines) => rows.map((line) => `${line.role === "person" ? "PERSON" : "ASSISTANT"}: ${line.content}`).join("\n");
  const transcript = asText(lines);
  const knownText = known.length ? known.map((memory) => `${memory.ref}: ${memory.text}`).join("\n") : "(none)";
  const projectsText = projects.length ? projects.map((project) => `${project.ref}: ${project.title} (${project.status})`).join("\n") : "(none)";
  return [
    {
      role: "system",
      content:
        "You read a conversation between a person and their assistant and list the lasting facts about the person it reveals, " +
        "to remember in later conversations: who they are, their family and people around them, work, home, pets, projects, " +
        "lasting preferences, habits, important dates, and how they like to be answered.\n" +
        "Rules:\n" +
        "- Only from PERSON lines. ASSISTANT lines are context: never take a fact from them, even one the person does not contradict, and never mix one into a fact the person says.\n" +
        "- EARLIER, when given, was read already: take no fact from it, only who « he », « they », « il », « ils » are in CONVERSATION (« et ils se sont mariés en 2019 » after « David est marié à Dafna » → « David et Dafna se sont mariés en 2019 »).\n" +
        "- The people in their life count too: a relative's or a colleague's name, what happens to them (« Son collègue Paul a eu une fille, Lina »).\n" +
        "- Not questions, hypotheses, wishes, plans that may not happen, today's mood or task, facts about the world, nor a one-off happening (« Pixel a renversé mon verre hier soir », a delay, a spill): only what will still be true in months.\n" +
        "- Not what KNOWN already says. When the person changes a KNOWN fact, give the new fact and set \"supersedes\" to its ref. A fact that adds to a KNOWN one without contradicting it (a date, a detail) supersedes nothing.\n" +
        "- When the person corrects themselves, only the corrected fact.\n" +        "- Never guess what is not said: who someone is, an animal's species, a relation, a date.\n" +
        "- text: one short sentence about the person, in the language the PERSON writes in, never translated (« A une fille, Léa, 7 ans », « Préfère des réponses courtes »). About someone else, name them: « David travaille chez Check Point », never « Travaille chez Check Point ».\n" +
        "- evidence: the exact words of the PERSON line it comes from, copied character for character.\n" +
        "- kind: \"feedback\" for how to answer, \"project\" for something they work on, else \"user\".\n" +
        `- category: one of ${[...CATEGORIES].join(", ")} (health, finances, religion, politics, sexuality, legal, ids — identity or account numbers — and address — their precise home address — are sensitive).\n` +
        "- confidence: 0 to 1, how sure you are the person said it about themselves and it will still be true in months.\n" +
        "Projects: also list what the person is working towards over days or months — a purchase (a house, a car, a Mac mini), a wedding, a move, a trip, a job search, a renovation, a project at work — " +
        "only when the PERSON says they are doing or planning it themselves, not someone else's, not a mere wish or hypothesis. " +
        "title: a short name in their language (« Achat d'un Mac mini »); name: how they call it in a sentence (« Mac mini »); kind: one of purchase, event, home, travel, work, health, learning, admin, other; " +
        "size: \"critical\" when much rides on it and it cannot slip (their health, their job or company, a legal or tax deadline, their home), \"large\" for months of effort or a big budget, \"medium\" for weeks of effort or a real budget, else \"small\"; status: idea, active, paused, done or dropped; due: a date YYYY-MM-DD if they say one, else null; evidence and confidence as for facts. " +
        "When it is one of PROJECTS, set \"ref\" to its ref and give it only if its status or due date changes. A project never replaces the facts: still list in facts what the person said about it.\n" +
        "Answer with JSON only: {\"facts\":[{\"text\":\"…\",\"kind\":\"user\",\"category\":\"…\",\"confidence\":0.9,\"evidence\":\"…\",\"supersedes\":null}],\"projects\":[{\"title\":\"…\",\"name\":\"…\",\"kind\":\"purchase\",\"size\":\"small\",\"status\":\"idea\",\"due\":null,\"evidence\":\"…\",\"confidence\":0.8,\"ref\":null}]}. " +
        "Most conversations hold nothing to remember: then {\"facts\":[],\"projects\":[]}.",
    },
    { role: "user", content: `KNOWN:\n${knownText}\n\nPROJECTS:\n${projectsText}\n\n${earlier.length ? `EARLIER:\n${asText(earlier)}\n\n` : ""}CONVERSATION:\n${transcript}` },
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

export interface KnownProject {
  ref: string;
  id: string;
  title: string;
  status: string;
  name: string | null;
}

export interface LearnedProject {
  title: string;
  name: string;
  kind: string;
  size: ProjectSize;
  status: "idea" | "active" | "paused" | "done" | "dropped";
  due: string | null;
  evidence: string;
  confidence: number;
  ref: string | null;
}

const PROJECT_KINDS_LEARNED = new Set(["purchase", "event", "home", "travel", "work", "health", "learning", "admin", "other"]);
const PROJECT_STATUSES_LEARNED = new Set(["idea", "active", "paused", "done", "dropped"]);

/// The projects of the model's answer (docs/projects-design.md §3).
export function parseProjects(answer: string): LearnedProject[] {
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
  const projects = (parsed as { projects?: unknown })?.projects;
  if (!Array.isArray(projects)) return [];
  const out: LearnedProject[] = [];
  for (const raw of projects.slice(0, 4)) {
    const project = raw as Record<string, unknown> | null;
    const title = typeof project?.title === "string" ? project.title.trim().replace(/\s+/g, " ") : "";
    if (title.length < 3 || title.length > 120) continue;
    const name = typeof project!.name === "string" && project!.name.trim() ? project!.name.trim().slice(0, 80) : title;
    const confidence = typeof project!.confidence === "number" ? project!.confidence : Number(project!.confidence);
    const due = typeof project!.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(project!.due) && !Number.isNaN(Date.parse(project!.due)) ? project!.due : null;
    out.push({
      title: title.charAt(0).toUpperCase() + title.slice(1),
      name,
      kind: typeof project!.kind === "string" && PROJECT_KINDS_LEARNED.has(project!.kind) ? project!.kind : "other",
      size: typeof project!.size === "string" && (PROJECT_SIZES as readonly string[]).includes(project!.size) ? (project!.size as ProjectSize) : "small",
      status: typeof project!.status === "string" && PROJECT_STATUSES_LEARNED.has(project!.status) ? (project!.status as LearnedProject["status"]) : "active",
      due,
      evidence: typeof project!.evidence === "string" ? project!.evidence : "",
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6,
      ref: typeof project!.ref === "string" && project!.ref.trim() ? project!.ref.trim() : null,
    });
  }
  return out;
}

export interface JudgedProject {
  project: LearnedProject;
  confidence: number;
  /// A known project it changes (its status or due date), else a new one.
  updates: KnownProject | null;
}

/// What becomes of each project the model gave: always proposed, never
/// made on its own (docs/projects-design.md §3); dropped without the
/// person's words, hedged below PROPOSE_AT, or the same as a known one.
export function judgeProjects(projects: LearnedProject[], context: { personLines: string[]; known: KnownProject[]; refused?: ReadonlySet<string> }): { propose: JudgedProject[]; dropped: Array<{ project: LearnedProject; reason: string }> } {
  const out: { propose: JudgedProject[]; dropped: Array<{ project: LearnedProject; reason: string }> } = { propose: [], dropped: [] };
  const seen = new Set<string>();
  for (const project of projects) {
    const key = normaliseMemoryContent(project.title);
    if (!key || seen.has(key)) { out.dropped.push({ project, reason: "repeated" }); continue; }
    seen.add(key);
    const found = evidenceFound(project.evidence, context.personLines);
    if (!found) { out.dropped.push({ project, reason: "no_evidence" }); continue; }
    // A wish or a hypothesis (« si un jour… j'achèterais ») is no project.
    if (HYPOTHESIS.test(found.around)) { out.dropped.push({ project, reason: "hypothesis" }); continue; }
    let confidence = project.confidence;
    if (firstPerson(project.evidence)) confidence += 0.1;
    if (HEDGING.test(found.around)) confidence -= 0.3;
    confidence = Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;
    if (confidence < PROPOSE_AT) { out.dropped.push({ project, reason: "unsure" }); continue; }
    const byRef = project.ref ? context.known.find((known) => known.ref === project.ref) ?? null : null;
    const byName = context.known.find((known) =>
      [known.title, known.name].some((name) => name && (normaliseMemoryContent(name) === key || normaliseMemoryContent(name) === normaliseMemoryContent(project.name) || overlap(name, project.title) >= 0.6))) ?? null;
    const updates = byRef ?? byName;
    if (updates) {
      // Known, and nothing changes: nothing to propose.
      if (project.status === updates.status && !project.due) { out.dropped.push({ project, reason: "known" }); continue; }
    } else if (context.refused?.has(`project:${key}`)) {
      out.dropped.push({ project, reason: "refused" });
      continue;
    }
    out.propose.push({ project, confidence, updates });
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

/// A word of the fact the person never wrote and a known memory holds
/// (« A un chien nommé Pixel » from « Pixel a renversé mon verre » and the
/// known « Le chien de Mathieu s'appelle Pixel »): what is already known,
/// said again.
function fromKnown(text: string, personLines: string[], known: KnownMemory[]): boolean {
  if (!known.length) return false;
  const said = memoryWords(personLines.join(" "));
  const knownWords = memoryWords(known.map((memory) => memory.text).join(" "));
  // Names aside (the person's own, « Mathieu », is in every memory), and
  // short words (« fait »): what describes.
  const names = new Set((text.match(/\p{Lu}[\p{L}'-]+/gu) ?? []).flatMap((name) => memoryWords(name)));
  return memoryWords(text)
    .filter((word) => word.length >= 5 && !names.has(word))
    .some((word) => !said.some((other) => sameWord(word, other)) && knownWords.some((other) => sameWord(word, other)));
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
  context: { personLines: string[]; assistantLines?: string[]; known: KnownMemory[]; refused?: ReadonlySet<string>; forgotten?: (text: string) => boolean; askedLines?: ReadonlySet<string>; earlierPersonLines?: string[] },
): Judgement {
  // What the person said before (EARLIER) names who « ils » are: their
  // words, never the evidence of a fact.
  const saidLines = [...context.personLines, ...(context.earlierPersonLines ?? [])];
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
    if (fromAssistant(fact.text, saidLines, context.assistantLines ?? [])) { out.dropped.push({ fact, reason: "from_assistant" }); continue; }
    if (context.refused?.has(norm)) { out.dropped.push({ fact, reason: "refused" }); continue; }
    if (context.forgotten?.(fact.text)) { out.dropped.push({ fact, reason: "forgotten" }); continue; }
    const supersedes = fact.supersedes ? context.known.find((memory) => memory.ref === fact.supersedes) ?? null : null;
    // Said again, in other words or the same: known already.
    if (knownNorms.has(norm) || context.known.some((memory) => memory !== supersedes && overlap(memory.text, fact.text) >= 0.75)) {
      out.dropped.push({ fact, reason: "known" });
      continue;
    }
    if (fromKnown(fact.text, saidLines, context.known)) { out.dropped.push({ fact, reason: "from_known" }); continue; }
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

interface MessageRow { rowid: number; role: string; content: string; provider?: string | null }

/// The memories the model is shown, so that it neither learns them again
/// nor misses one it changes: the ones sharing the most words with what the
/// person said.
function knownFor(userId: string, said: string): KnownMemory[] {
  const rows = sqlite.prepare(
    "SELECT id, title, content, tags FROM memories WHERE user_id = ? AND superseded_by_id IS NULL ORDER BY updated_at DESC LIMIT 2000",
  ).all(userId) as Array<{ id: string; title: string | null; content: string; tags: string }>;
  const words = new Set(memoryWords(said));
  const scored = rows
    .filter((row) => !row.tags.includes("\"archive\"") && row.content.length <= 600)
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
/// The learning call running now, stopped when an answer starts.
let current: AbortController | null = null;
/// Conversations to read as soon as the computer answers nothing.
const soonDiscussions = new Set<string>();

/// An answer starts: the learning running now stops at once, and starts
/// over after it (src/routes/queries.ts).
export function yieldToAnswer() {
  current?.abort();
}
onChatGeneration(yieldToAnswer);

/// Whether this conversation is being read or waits to be (the app asks
/// again for « Mémoire enregistrée » while it is).
export function isLearning(discussionId: string): boolean {
  return busyDiscussions.has(discussionId) || soonDiscussions.has(discussionId);
}

/// The person's message was answered: what was said is read at once, once
/// the computer is free (none for a conversation whose memory mode is
/// « Aucune », learnable() says).
export function learnAfterAnswer(discussionId: string) {
  if (!started) return;
  soonDiscussions.add(discussionId);
  schedule(AFTER_ANSWER_MS);
}

/// Learns from what was said in this conversation since last time.
export async function learnDiscussion(discussionId: string, options: { ask?: LearningModel | null; now?: number } = {}): Promise<LearnResult | null> {
  const ask = options.ask ?? model;
  const row = sqlite.prepare("SELECT id, user_id, learned_through FROM discussions WHERE id = ?").get(discussionId) as
    { id: string; user_id: string; learned_through: number | null } | undefined;
  if (!row || busyDiscussions.has(discussionId)) return null;
  const result: LearnResult = { discussion_id: row.id, read: 0, saved: [], proposed: [], dropped: 0 };
  const rows = sqlite.prepare("SELECT rowid, role, content, provider FROM messages WHERE discussion_id = ? AND rowid > ? ORDER BY rowid").all(row.id, row.learned_through ?? 0) as MessageRow[];
  if (!rows.length) return result;
  const through = rows.at(-1)!.rowid;
  const advance = () => sqlite.prepare("UPDATE discussions SET learned_through = ? WHERE id = ? AND COALESCE(learned_through, 0) < ?").run(through, row.id, through);
  // Exchanges another computer answered, brought by the encrypted history:
  // that computer learned them, and its memories come here the same way.
  // Read again here, they cost the Pi two minutes of its four cores each —
  // its fan — for nothing (315 such conversations, 02/10/2026).
  if (rows.some((message) => message.role === "assistant") && rows.every((message) => message.role !== "assistant" || message.provider === "vault")) {
    advance();
    return result;
  }
  if (!learnable(row.id)) {
    // Never read; and not later either, should its mode change.
    advance();
    return result;
  }
  const lineOf = (message: { role: string; content: string }): { role: "person" | "assistant"; content: string } | null => {
    if (message.role === "user") {
      const text = typedText(message.content).replace(/\s+/g, " ").trim().slice(0, PERSON_LINE_CHARS);
      return text ? { role: "person", content: text } : null;
    }
    if (message.role === "assistant") {
      const text = message.content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/\s+/g, " ").trim();
      return text ? { role: "assistant", content: text.length > ASSISTANT_LINE_CHARS ? `${text.slice(0, ASSISTANT_LINE_CHARS - 1)}…` : text } : null;
    }
    return null;
  };
  const lines = rows.map(lineOf).filter((line): line is NonNullable<typeof line> => line !== null);
  // The messages read before, as context only (newest kept when long).
  const before = (sqlite.prepare("SELECT role, content FROM messages WHERE discussion_id = ? AND rowid <= ? ORDER BY rowid DESC LIMIT ?")
    .all(row.id, row.learned_through ?? 0, EARLIER_MESSAGES) as Array<{ role: string; content: string }>).reverse();
  let earlier = before.map(lineOf).filter((line): line is NonNullable<typeof line> => line !== null);
  while (earlier.length && earlier.reduce((sum, line) => sum + line.content.length + 12, 0) > EARLIER_CHARS) earlier = earlier.slice(1);
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
    const projects = knownProjects(row.user_id);
    let answer: string;
    try {
      current = new AbortController();
      answer = await ask(row.user_id, learningPrompt(shown, known, projects, earlier), current.signal);
    } catch (err) {
      // Stopped for an answer: read again once it is written, not later.
      if (current?.signal.aborted) {
        soonDiscussions.add(row.id);
        return null;
      }
      failedAt.set(row.id, options.now ?? Date.now());
      throw err;
    } finally {
      current = null;
    }
    failedAt.delete(row.id);
    const assistantLines = shown.filter((line) => line.role === "assistant").map((line) => line.content);
    const askedLines = new Set(personLines.filter((line) => askedToRemember(line) !== null));
    const facts = parseLearning(answer);
    const refused = refusedNorms(row.user_id);
    const earlierPersonLines = earlier.filter((line) => line.role === "person").map((line) => line.content);
    const judged = judgeFacts(facts, { personLines, assistantLines, known, refused, forgotten: isForgottenFact, askedLines, earlierPersonLines });
    const judgedProjects = judgeProjects(parseProjects(answer), { personLines, known: projects, refused });
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
        projects: {
          proposed: judgedProjects.propose.map((j) => ({ title: j.project.title, status: j.project.status, confidence: j.confidence, updates: j.updates?.id ?? null })),
          dropped: judgedProjects.dropped.map((d) => ({ title: d.project.title, reason: d.reason })),
        },
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
    for (const project of judgedProjects.propose) result.proposed.push(proposeProject(row.user_id, project, row.id, options.now ?? Date.now()));
    if (result.saved.length || result.proposed.length) {
      sqlite.prepare("INSERT INTO memory_notices (id, user_id, discussion_id, saved, proposed, created_at) VALUES (?, ?, ?, ?, ?, ?)")
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

/// A project found in a conversation, new or changed: always « À confirmer ».
function proposeProject(userId: string, judged: JudgedProject, discussionId: string, now: number): string {
  const id = randomUUID();
  const { project, updates } = judged;
  const payload = updates
    ? { project_id: updates.id, title: updates.title, status: project.status, due: project.due, previous_status: updates.status }
    : { title: project.title, name: project.name, kind: project.kind, size: project.size, status: project.status, due: project.due };
  sqlite.prepare(`INSERT INTO memory_candidates (id, user_id, content, norm, kind, category, confidence, sensitive, evidence, supersedes_id, discussion_id, status, created_at, candidate_type, payload)
    VALUES (?, ?, ?, ?, 'project', NULL, ?, 0, ?, NULL, ?, 'pending', ?, ?, ?)`).run(
    id, userId, updates ? updates.title : project.title, `project:${normaliseMemoryContent(project.title)}`, judged.confidence,
    project.evidence.slice(0, 500), discussionId, now, updates ? "project_update" : "project", JSON.stringify(payload),
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
  /// A fact, a new project, or a change of a known one (status, due date).
  type: "fact" | "project" | "project_update";
  /// What was found of the project (title, name, kind, size, status, due).
  project: Record<string, unknown> | null;
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
    type: (row.candidate_type as CandidateRow["type"] | undefined) ?? "fact",
    project: row.payload ? (() => { try { return JSON.parse(String(row.payload)); } catch { return null; } })() : null,
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
  const project = (sqlite.prepare("SELECT candidate_type, payload FROM memory_candidates WHERE id = ?").get(id) as { candidate_type: string; payload: string | null });
  if (project.candidate_type === "project" || project.candidate_type === "project_update") {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(project.payload ?? "{}"); } catch { /* empty */ }
    const title = typeof content === "string" && content.trim() ? content.trim().slice(0, 200) : String(payload.title ?? row.content);
    const due = typeof payload.due === "string" ? `${payload.due}T12:00:00.000Z` : undefined;
    let projectId: string;
    if (project.candidate_type === "project_update" && typeof payload.project_id === "string") {
      projectId = payload.project_id;
      updateProject(userId, projectId, { status: payload.status as never, ...(due ? { due_at: due } : {}) }, now);
    } else {
      projectId = createProject(userId, {
        title, name: typeof payload.name === "string" ? payload.name : undefined,
        kind: payload.kind as never, size: payload.size as never, status: payload.status as never, ...(due ? { due_at: due } : {}),
      }, "learned", now);
    }
    // The conversation it came from is about it.
    if (row.discussion_id) sqlite.prepare("UPDATE discussions SET project_id = COALESCE(project_id, ?) WHERE id = ? AND user_id = ?").run(projectId, row.discussion_id, userId);
    sqlite.prepare("UPDATE memory_candidates SET status = 'accepted', memory_id = ?, decided_at = ? WHERE id = ?").run(projectId, now, id);
    return projectId;
  }
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
  const before = now - options.idleMs;
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
const AFTER_ANSWER_MS = 300;
const AFTER_BUSY_MS = 1_000;

async function runOnce(now = Date.now()) {
  if (running || !model) return;
  running = true;
  try {
    const urgent = [...soon.entries()];
    soon.clear();
    const justAnswered = [...soonDiscussions];
    soonDiscussions.clear();
    const queue = [
      ...justAnswered,
      ...urgent.flatMap(([userId, except]) => pendingDiscussions({ userId, idleMs: 0, except, now })),
      ...pendingDiscussions({ idleMs: LEARN_IDLE_MS, now }),
    ];
    for (const id of [...new Set(queue)]) {
      // An answer goes first: what is left waits for the computer to be quiet.
      if (inflight() > 0) {
        for (const [userId, except] of urgent) soon.set(userId, except);
        for (const waiting of justAnswered) soonDiscussions.add(waiting);
        // What was just said is looked at again soon after the answer.
        schedule(soonDiscussions.size ? AFTER_BUSY_MS : BUSY_RETRY_MS);
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
      if (!timer) schedule(soonDiscussions.size ? AFTER_BUSY_MS : soon.size ? BUSY_RETRY_MS : TICK_MS);
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

function readNotices(rows: Array<{ id: string; discussion_id: string; title: string | null; saved: string; proposed: number; created_at: number }>, userId: string): MemoryNotice[] {
  const content = sqlite.prepare("SELECT content FROM memories WHERE id = ? AND user_id = ?");
  return rows.map((row) => {
    let ids: string[] = [];
    try { ids = JSON.parse(row.saved); } catch { /* none */ }
    const saved = ids.flatMap((id) => {
      const memory = content.get(id, userId) as { content: string } | undefined;
      return memory ? [{ id, content: memory.content }] : [];
    });
    return { id: row.id, discussion_id: row.discussion_id, discussion_title: row.title, saved, proposed: row.proposed, created_at: new Date(row.created_at).toISOString() };
  }).filter((notice) => notice.saved.length || notice.proposed);
}

/// What was learned from this conversation, oldest first.
export function noticesOf(userId: string, discussionId: string): MemoryNotice[] {
  return readNotices(sqlite.prepare(`SELECT n.id, n.discussion_id, d.title, n.saved, n.proposed, n.created_at FROM memory_notices n
    LEFT JOIN discussions d ON d.id = n.discussion_id WHERE n.user_id = ? AND n.discussion_id = ? ORDER BY n.created_at`).all(userId, discussionId) as never, userId);
}

/// What was learned and not told yet — told now, once, whichever device
/// asks first. `except`: the conversation open (it says so itself).
export function takeMemoryNews(userId: string, except: string | null = null): MemoryNotice[] {
  const rows = sqlite.prepare(`SELECT n.id, n.discussion_id, d.title, n.saved, n.proposed, n.created_at FROM memory_notices n
    LEFT JOIN discussions d ON d.id = n.discussion_id WHERE n.user_id = ? AND n.announced = 0 AND n.discussion_id IS NOT ? ORDER BY n.created_at LIMIT 20`).all(userId, except) as Array<{ id: string }>;
  const mark = sqlite.prepare("UPDATE memory_notices SET announced = 1 WHERE id = ?");
  for (const row of rows) mark.run(row.id);
  return readNotices(rows as never, userId);
}
