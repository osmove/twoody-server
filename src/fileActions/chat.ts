import { eq } from "drizzle-orm";
import { generateId } from "../auth.js";
import { messageLanguage, type MessageLanguage } from "../chatContext.js";
import { db, discussions, messages } from "../db.js";
import { publish as publishEvent } from "../events.js";
import { capabilityOn } from "../localCapabilities.js";
import { fileActionIntent, requestLanguage, saysNo, saysYes } from "./intent.js";
import { buildPlan, findFolder, PlanError, type FileActionPlan } from "./plan.js";
import { runFileAction } from "./run.js";
import { createFileAction, fileAction, lastActionFolder, transition, waitingProposal, type FileActionResult, type FileActionRow } from "./store.js";
import { mayDecide, type Viewer } from "./view.js";
import { languageOf, quote, reasonText, say, type Language, type Reason, REASON_CODES } from "./words.js";

// « Agir dans vos dossiers » in a chat turn (docs/agent-in-chat.md of
// twoody-desktop): routes/queries.ts asks this first; when it answers, the
// answer is this text — a proposal, a refusal, how to switch it on, or the
// result of a « oui » — written here, never by the model, and the model is
// not asked at all.

export interface FileTurnContext {
  userId: string;
  discussionId: string;
  /// What the person typed or said.
  text: string;
  /// The app's language (« fr-FR »).
  locale: string | null;
  /// A walled-off project's conversation.
  isolated: boolean;
  /// « Agir dans vos dossiers » switched off in « Outils » for this message.
  leftOut: boolean;
  /// This computer's app, or one of the person's own devices.
  person: boolean;
  asker: Viewer;
  /// The model chosen for the conversation: it writes a draft or a table.
  model: string | null;
  /// The conversation's last answer before this message.
  lastAnswerId: string | null;
}

export type FileTurnOutcome =
  | "proposed" | "done" | "failed" | "declined"
  | "refused_delete" | "off" | "left_out" | "walled" | "not_person" | "no_folders" | "not_found" | "nothing";

export interface FileTurn {
  text: string;
  outcome: FileTurnOutcome;
  /// The action proposed (or answered by a « oui »): its card.
  action: FileActionRow | null;
}

function folderName(language: Language, plan: FileActionPlan): string {
  return quote(language, plan.folder.shown);
}

/// The proposal, said in the person's language.
export function proposalText(language: Language, plan: FileActionPlan): string {
  const folder = folderName(language, plan);
  let head: string;
  if (plan.kind === "sort") {
    const targets = new Set(plan.moves.map((move) => move.to.split("/")[0]));
    head = say(language, plan.by === "year" ? "sortYear" : plan.by === "type" ? "sortType" : "sortMonth", { folder, n: plan.moves.length, k: targets.size });
  } else if (plan.kind === "rename") {
    head = say(language, "rename", { folder, n: plan.moves.length });
  } else {
    head = say(language, plan.kind, { folder, name: quote(language, plan.create!.name), n: plan.reads.length });
  }
  const more = plan.left > 0 ? ` ${say(language, "more", { n: plan.moves.length })}` : "";
  return `${head}${more}\n\n${say(language, "waits")}`;
}

function reasonOf(code: string | undefined): Reason {
  return (REASON_CODES as string[]).includes(code ?? "") ? (code as Reason) : "failed";
}

/// What was done, said from the result — never from what a model wrote.
export function resultText(row: FileActionRow, result: FileActionResult): string {
  const language = row.language;
  const plan = row.plan;
  const folder = folderName(language, plan);
  if (result.failure) {
    const reason = reasonText(language, reasonOf(result.failure.reason));
    if (result.done > 0 && (plan.kind === "sort" || plan.kind === "rename")) {
      return say(language, "stopped", { done: result.done, total: result.total, name: quote(language, result.failure.at ?? "?"), reason });
    }
    return say(language, "failed", { reason });
  }
  let head: string;
  if (plan.kind === "sort") {
    const targets = new Set(result.items.filter((item) => item.kind === "moved").map((item) => item.to.split("/")[0]));
    head = say(language, "sorted", { n: result.done, k: targets.size, folder });
  } else if (plan.kind === "rename") {
    head = say(language, "renamed", { n: result.done, folder });
  } else {
    const created = result.items.find((item) => item.kind === "created")?.to ?? plan.create!.name;
    head = say(language, "created", { name: quote(language, created), folder, n: result.items.filter((item) => item.kind === "read").length });
  }
  return `${head} ${say(language, "nothingLost")}`;
}

/// An answer of Twoody's own in the conversation (the result of an action
/// agreed to with « Faire »), as the model's answers are kept.
export function appendAnswer(userId: string, discussionId: string, text: string): string {
  const id = generateId();
  db.insert(messages).values({ id, discussionId, userId, role: "assistant", content: text, provider: "twoody", model: null, createdAt: new Date() }).run();
  db.update(discussions).set({ lastActivityAt: new Date() }).where(eq(discussions.id, discussionId)).run();
  publishEvent({ kind: "message.appended", userId, discussionId, role: "assistant" });
  return id;
}

/// Runs an action the person agreed to (« Faire », or « oui »): false when
/// it was not waiting any more (answered already, or by someone else).
export async function agree(row: FileActionRow, viewer: Viewer): Promise<{ row: FileActionRow; result: FileActionResult } | null> {
  if (!mayDecide(row, viewer)) return null;
  if (!transition(row.id, ["proposed"], "running")) return null;
  const result = await runFileAction(row);
  return { row: fileAction(row.userId, row.id) ?? row, result };
}

export function refuse(row: FileActionRow, viewer: Viewer): FileActionRow | null {
  if (!mayDecide(row, viewer)) return null;
  if (!transition(row.id, ["proposed"], "declined")) return null;
  return fileAction(row.userId, row.id);
}

/// The answer to this message, when it is about acting in a folder; null
/// when the chat goes on as usual.
export async function fileActionTurn(context: FileTurnContext): Promise<FileTurn | null> {
  const text = context.text.trim();
  if (!text) return null;
  // The words of the request tell its language first (« Rinomina le
  // scansioni… » read as French by the chat's word counts); then the chat's
  // reading of it; then the app's.
  const language = languageOf((requestLanguage(text) as MessageLanguage | null) ?? messageLanguage(text, context.locale), context.locale);

  // « oui » / « non » right after a proposal, from whoever may answer it.
  if (saysYes(text) || saysNo(text)) {
    const waiting = waitingProposal(context.userId, context.discussionId);
    if (waiting && waiting.messageId && waiting.messageId === context.lastAnswerId && mayDecide(waiting, context.asker) && !context.isolated) {
      if (saysNo(text)) {
        const declined = refuse(waiting, context.asker);
        return declined ? { text: say(waiting.language, "declined"), outcome: "declined", action: declined } : null;
      }
      const done = await agree(waiting, context.asker);
      if (done) return { text: resultText(done.row, done.result), outcome: done.result.failure ? "failed" : "done", action: done.row };
    }
    return null;
  }

  const intent = fileActionIntent(text);
  if (!intent) return null;
  const answer = (outcome: FileTurnOutcome, sentence: Parameters<typeof say>[1], vars: Record<string, string | number> = {}): FileTurn => ({ text: say(language, sentence, vars), outcome, action: null });
  if (intent.kind === "delete") return answer("refused_delete", "delete");
  if (context.isolated) return answer("walled", "walled");
  if (!context.person) return answer("not_person", "notPerson");
  if (!capabilityOn(context.userId, "agent")) return answer("off", "off");
  if (context.leftOut) return answer("left_out", "leftOut");
  if (!capabilityOn(context.userId, "documents")) return answer("no_folders", "noFolders");

  const folder = await findFolder(context.userId, intent.words, lastActionFolder(context.userId, context.discussionId));
  if (folder.status === "none") return answer("no_folders", "noFolders");
  if (folder.status === "not_found") {
    const roots = folder.roots.map((root) => quote(language, root)).join(", ");
    return folder.word ? answer("not_found", "notFound", { word: quote(language, folder.word), roots }) : answer("not_found", "whichFolder", { roots });
  }
  let plan: FileActionPlan;
  try {
    plan = await buildPlan({ userId: context.userId, intent, folder, request: text, language });
  } catch (err) {
    if (!(err instanceof PlanError)) throw err;
    const shown = quote(language, folder.shown);
    if (err.code === "no_documents") return answer("nothing", "noDocuments", { folder: shown });
    if (err.code === "folder_gone") return answer("not_found", "notFound", { word: shown, roots: shown });
    return answer("nothing", intent.kind === "rename" ? "alreadyDated" : "alreadySorted", { folder: shown });
  }
  const row = createFileAction({ userId: context.userId, discussionId: context.discussionId, plan, askerSession: context.asker.sessionId, askerApp: context.asker.thisComputersApp, model: context.model, language });
  return { text: proposalText(language, plan), outcome: "proposed", action: row };
}
