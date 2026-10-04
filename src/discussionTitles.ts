import { sqlite } from "./db.js";
import { inflight, onChatGeneration } from "./account/inflight.js";
import { publish } from "./events.js";
import { languageName } from "./chatContext.js";
import { conversationLanguage } from "./memory/learner.js";
import { splitDocuments } from "./documentBlocks.js";

// A conversation's title, written by the model (Jimmy, 04/10/2026: like
// ChatGPT and Claude). The first ~60 characters of the first question are
// its title at once (src/routes/queries.ts setDiscussionTitle), so that the
// list shows something; once the first answer is stored, the model that
// wrote it (or this computer's default one) is asked for a short title in
// the conversation's language, and it replaces that one — never a title
// set on purpose (discussions.title_source, migration 3).
//
// Never in the way of an answer:
//   - only once the answer is written and stored, and the computer
//     generates nothing else (inflight() is 0) — waited for, up to
//     WAIT_MAX_MS, then given up;
//   - an answer that starts stops it at once (onChatGeneration), and it is
//     asked again after, up to ATTEMPTS times;
//   - reasoning off, a few tokens, the background slot (the caller's
//     TitleCall);
//   - whatever goes wrong, the first-question title stays: nothing is said.
//
// Only a model of this computer is asked (queries.ts titleCall): nothing
// leaves it for a title. A synchronised conversation's new title reaches
// the person's other devices sealed, as its exchanges do (onTitled: the
// headless vault; inside Twoody Desktop, the Desktop's own sync).

export type TitleMessages = Array<{ role: "system" | "user"; content: string }>;
/// Runs the title prompt on a model; throws or returns "" when it cannot.
export type TitleCall = (messages: TitleMessages, signal: AbortSignal) => Promise<string>;

/// Shorter than the first question's 60: the iPhone's drawer reads a title
/// of 60 characters as one cut short (« … », twoody-app discussionTitles.js).
export const TITLE_MAX_CHARS = 50;
const QUESTION_CHARS = 1_200;
const ANSWER_CHARS = 600;
const ATTEMPTS = 3;
const WAIT_MAX_MS = 10 * 60_000;
const BUSY_RETRY_MS = 1_000;
const CALL_TIMEOUT_MS = 90_000;

export function titlePrompt(question: string, answer: string, language: string | null): TitleMessages {
  const { text, documents } = splitDocuments(question);
  const names = documents.filter((document) => document.kind === "document").map((document) => document.name);
  const asked = text.replace(/\s+/g, " ").trim().slice(0, QUESTION_CHARS);
  const answered = answer.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/\s+/g, " ").trim().slice(0, ANSWER_CHARS);
  const written = language ? languageName(language) : null;
  return [
    {
      role: "system",
      content:
        "You name conversations between a person and their assistant, as a chat app's history lists them. " +
        "Write a title of 2 to 6 words saying what the conversation is about (« Recette de pâte à crêpes », « Trip to Lisbon in May »), " +
        "in the language the person wrote in, never translated; names and terms kept as they were. " +
        "Answer with the title alone, on one line: no quotes, no « Title: », no final period, no emoji.",
    },
    // The language last, with the conversation: the system message stays
    // the same for every conversation (the runtime reuses it).
    {
      role: "user",
      content: `${names.length ? `DOCUMENTS: ${names.join(", ")}\n\n` : ""}PERSON: ${asked || "(a document)"}\n\nASSISTANT: ${answered}\n\n` +
        `Title${written ? `, in ${written}` : ""}:`,
    },
  ];
}

/// The title in what the model wrote; null when there is none worth showing.
export function cleanTitle(raw: string): string | null {
  let text = raw
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/```[a-z]*\n?/gi, "")
    .trim();
  // The first line that says something (« Title: » on its own line, then
  // the title, happens).
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  text = lines.find((line) => !/^(?:\*\*)?(?:title|titre|t[ií]tulo|titolo|titel|タイトル|제목)\s*[:：]?\s*(?:\*\*)?$/i.test(line)) ?? "";
  text = text
    .replace(/^(?:\*\*)?(?:title|titre|t[ií]tulo|titolo|titel|タイトル|제목)\s*[:：]\s*/i, "")
    .replace(/^[#>*\-\s]+/, "")
    .replace(/\*\*/g, "")
    // Emoji and pictographs.
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  // Quotes around it, as many as there are.
  for (let i = 0; i < 3; i += 1) {
    const unquoted = text.replace(/^["'«“‘「『`]\s*/, "").replace(/\s*["'»”’」』`]$/, "").trim();
    if (unquoted === text) break;
    text = unquoted;
  }
  text = text.replace(/[.。:：;,\s]+$/u, "").trim();
  if (text.length > TITLE_MAX_CHARS) {
    const cut = text.slice(0, TITLE_MAX_CHARS);
    const space = cut.lastIndexOf(" ");
    text = (space >= TITLE_MAX_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:\-–—]+$/u, "");
  }
  // A letter at least; and not the model refusing or talking about itself.
  if (!/\p{L}/u.test(text) || text.length < 2) return null;
  if (/^(?:i (?:can(?:no|')t|am unable)|sorry|désolé|je ne peux|as an ai)/i.test(text)) return null;
  return text;
}

interface Job {
  userId: string;
  discussionId: string;
  question: string;
  answer: string;
  call: TitleCall;
  queuedAt: number;
  attempts: number;
}

let started = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
const queue: Job[] = [];
/// The title call running now, stopped when an answer starts.
let current: AbortController | null = null;
const titledListeners: Array<(discussionId: string, title: string) => void> = [];

/// An answer starts: the title being written stops, and is asked again after.
onChatGeneration(() => current?.abort());

/// Called with each title the model wrote (the headless vault seals it).
export function onTitled(listener: (discussionId: string, title: string) => void) {
  titledListeners.push(listener);
}

/// The first answer of a new conversation is stored: its title is asked for
/// once the computer generates nothing else. Only on a running server
/// (startTitles); a test's app asks when it started them.
export function titleAfterFirstAnswer(job: { userId: string; discussionId: string; question: string; answer: string; call: TitleCall }) {
  if (!started || !job.answer.trim()) return;
  queue.push({ ...job, queuedAt: Date.now(), attempts: 0 });
  schedule(0);
}

/// Whether this conversation's title may still be replaced by the model.
function stillAutomatic(discussionId: string): boolean {
  const row = sqlite.prepare("SELECT title_source FROM discussions WHERE id = ?").get(discussionId) as { title_source: string | null } | undefined;
  return row?.title_source === "question";
}

/// The model's title, kept when the title is still the first question's;
/// the clients are told. Returns whether it was kept.
export function applyGeneratedTitle(userId: string, discussionId: string, title: string): boolean {
  const changed = sqlite.prepare("UPDATE discussions SET title = ?, title_source = 'model' WHERE id = ? AND user_id = ? AND title_source = 'question'").run(title, discussionId, userId).changes;
  if (!changed) return false;
  publish({ kind: "discussion.updated", userId, discussionId, title });
  for (const listener of titledListeners) {
    try {
      listener(discussionId, title);
    } catch {
      // A seal that failed is not worth losing the title for.
    }
  }
  return true;
}

async function runOnce() {
  if (running) return;
  running = true;
  try {
    while (queue.length && started) {
      const job = queue[0]!;
      if (Date.now() - job.queuedAt > WAIT_MAX_MS || !stillAutomatic(job.discussionId)) {
        queue.shift();
        continue;
      }
      // An answer, or other background work, goes first.
      if (inflight() > 0) {
        schedule(BUSY_RETRY_MS);
        return;
      }
      queue.shift();
      const controller = new AbortController();
      current = controller;
      try {
        const language = conversationLanguage(job.userId, job.discussionId, [splitDocuments(job.question).text]);
        const raw = await job.call(titlePrompt(job.question, job.answer, language), AbortSignal.any([controller.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]));
        const title = cleanTitle(raw);
        if (title) applyGeneratedTitle(job.userId, job.discussionId, title);
      } catch {
        // Stopped for an answer: asked again once it is written.
        if (controller.signal.aborted && job.attempts + 1 < ATTEMPTS) queue.unshift({ ...job, attempts: job.attempts + 1 });
        // Else the first question stays its title.
      } finally {
        if (current === controller) current = null;
      }
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
      if (queue.length && !timer && !running) schedule(BUSY_RETRY_MS);
    });
  }, ms);
  timer.unref?.();
}

export function startTitles() {
  started = true;
  return {
    stop() {
      started = false;
      current?.abort();
      queue.length = 0;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/// Resolves once nothing waits or runs (tests).
export async function titlesIdle(timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while ((queue.length || running || timer) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
}
