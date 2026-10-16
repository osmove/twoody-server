import { link, lstat, mkdir, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { capabilityOn } from "../localCapabilities.js";
import { fold } from "../intentText.js";
import { reindex } from "../documents/library.js";
import { walledAt } from "../documents/fileListing.js";
import { actionRoots, documentText, touchesWall, type FileActionPlan, type PlannedMove } from "./plan.js";
import { setResult, transition, type FileActionItem, type FileActionResult, type FileActionRow } from "./store.js";
import { spreadsheetFile, type MainLocale, type SheetTable } from "./spreadsheetFile.js";
import { wordDocument } from "./wordFile.js";
import type { Reason } from "./words.js";

// Doing what the person agreed to (docs/agent-in-chat.md of
// twoody-desktop), with everything checked again first: the capability,
// the folder still granted and walled off from nothing, its real path the
// same, each file still a regular file inside it, each destination free.
// Nothing is ever deleted and no file is ever written over: a move is a
// hard link then the old name's removal (the link fails if the destination
// exists), or a rename once the destination is known to be free where links
// are not possible; a new document is written with « wx ». The first
// failure stops it; what was done stays, and is said.

export class ActionError extends Error {
  constructor(public readonly reason: Reason, public readonly at: string | null = null) {
    super(reason);
  }
}

/// The model writes a draft's or a table's content: one call, no tools, a
/// model of this computer (routes/queries.ts gives it).
export type ActionModelCall = (userId: string, model: string | null, messages: Array<{ role: "system" | "user"; content: string }>, signal?: AbortSignal) => Promise<string>;
let modelCall: ActionModelCall | null = null;
export function setFileActionModel(call: ActionModelCall | null) {
  modelCall = call;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/// A relative path of the plan, as an absolute path inside the folder:
/// never `..`, never absolute, never a hidden name.
function within(folder: string, rel: string): string {
  const segments = rel.split("/");
  if (!rel || isAbsolute(rel) || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".") || segment.includes("\\") || segment.includes(sep))) throw new ActionError("failed", rel);
  const path = join(folder, ...segments);
  if (!inside(folder, path)) throw new ActionError("failed", rel);
  return path;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true).catch(() => false);
}

/// The folder, checked again: still granted here, not walled off, the same
/// real path.
export async function checkedFolder(userId: string, plan: FileActionPlan): Promise<string> {
  if (!capabilityOn(userId, "agent")) throw new ActionError("capability_off");
  const { roots, walls } = actionRoots(userId);
  const root = roots.find((each) => each.id === plan.folder.root);
  if (!root) throw new ActionError("not_granted");
  const real = await realpath(plan.folder.real).catch(() => null);
  if (!real) throw new ActionError("folder_gone");
  if (real !== plan.folder.real || !inside(root.path, real)) throw new ActionError("folder_gone");
  if (touchesWall(real, walls) || walledAt(root, real)) throw new ActionError("walled");
  return real;
}

/// Makes the folders on the way to `dir` that are missing, noting the ones
/// it made (relative to the folder).
async function folderFor(folder: string, dir: string, made: string[]) {
  const missing: string[] = [];
  for (let current = dir; current !== folder && inside(folder, current); current = dirname(current)) {
    if (await exists(current)) {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ActionError("destination_exists", relative(folder, current));
      break;
    }
    missing.unshift(current);
  }
  for (const path of missing) {
    await mkdir(path);
    made.push(relative(folder, path).split(sep).join("/"));
  }
}

/// One file moved without ever landing on another.
async function moveFile(from: string, to: string) {
  try {
    await link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new ActionError("destination_exists");
    // Another volume, a share or a file system without hard links.
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS", "EACCES"].includes(code ?? "")) throw err;
    if (await exists(to)) throw new ActionError("destination_exists");
    await rename(from, to);
    return;
  }
  try {
    await unlink(from);
  } catch {
    // Two names for one file: nothing lost, the old one stays.
  }
}

async function runMoves(userId: string, row: FileActionRow, folder: string, result: FileActionResult) {
  const moves = row.plan.moves;
  for (const move of moves) {
    const from = within(folder, move.from);
    const to = within(folder, move.to);
    const info = await lstat(from).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink()) throw new ActionError("source_missing", move.from);
    if (await exists(to)) throw new ActionError("destination_exists", move.to);
    await folderFor(folder, dirname(to), result.folders);
    await moveFile(from, to);
    result.done += 1;
    result.items.push({ kind: "moved", from: move.from, to: move.to });
    setResult(row.id, result);
  }
}

// ── Drafts and tables ───────────────────────────────────────────────────────

/// The words of the request worth finding in a document.
function requestTerms(request: string): string[] {
  return [...new Set(fold(request).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4))].slice(0, 20);
}

/// What a document gives the model: its start, and its passages that hold
/// the request's words, within `budget` characters, in its own order.
export function excerptFor(text: string, request: string, budget: number): string {
  if (text.length <= budget) return text;
  const terms = requestTerms(request).map((term) => (term.length > 6 ? term.slice(0, term.length - 2) : term));
  const paragraphs = text.split(/\n\s*\n|\n(?=\[page \d+\])/);
  const scored = paragraphs.map((paragraph, index) => {
    const folded = fold(paragraph);
    return { index, paragraph, score: index === 0 ? 1_000 : terms.filter((term) => folded.includes(term)).length };
  });
  const chosen = new Set<number>();
  let used = 0;
  for (const each of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (each.score <= 0) break;
    if (used + each.paragraph.length > budget) continue;
    chosen.add(each.index);
    used += each.paragraph.length + 2;
  }
  if (!chosen.size) return text.slice(0, budget);
  return [...chosen].sort((a, b) => a - b).map((index, i, all) => (i > 0 && all[i - 1]! < index - 1 ? `[…]\n${paragraphs[index]}` : paragraphs[index])).join("\n\n");
}

const LANGUAGE_NAMES: Record<string, string> = { en: "English", fr: "French", de: "German", es: "Spanish", it: "Italian", pt: "Brazilian Portuguese", nl: "Dutch", ja: "Japanese", zh: "Simplified Chinese", ko: "Korean" };

/// The documents, as the model is given them.
async function sources(userId: string, folder: string, plan: FileActionPlan, budget: number): Promise<{ block: string; read: string[] }> {
  const per = Math.max(2_000, Math.floor(budget / Math.max(1, plan.reads.length)));
  const blocks: string[] = [];
  const read: string[] = [];
  for (const rel of plan.reads) {
    const path = within(folder, rel);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    const text = await documentText(userId, path);
    if (!text?.trim()) continue;
    read.push(rel);
    blocks.push(`<document name="${rel.replace(/"/g, "'")}">\n${excerptFor(text.trim(), plan.request, per)}\n</document>`);
  }
  return { block: blocks.join("\n\n"), read };
}

/// What the model wrote, without its reasoning or a fence around it.
function cleaned(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, "$1").trim();
}

/// Markdown tables in a text: their header and rows.
export function markdownTables(text: string): Array<{ header: string[]; rows: string[][] }> {
  const tables: Array<{ header: string[]; rows: string[][] }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]!.trim().startsWith("|")) continue;
    const block: string[] = [];
    while (i < lines.length && lines[i]!.trim().startsWith("|")) block.push(lines[i++]!.trim());
    const cells = block.map((line) => line.replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim()));
    const rows = cells.filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell)));
    if (rows.length >= 2) tables.push({ header: rows[0]!, rows: rows.slice(1) });
  }
  return tables;
}

async function writeDocument(userId: string, row: FileActionRow, folder: string, result: FileActionResult, signal?: AbortSignal) {
  const plan = row.plan;
  const create = plan.create!;
  const target = within(folder, create.name);
  if (await exists(target)) throw new ActionError("destination_exists", create.name);
  if (!modelCall) throw new ActionError("model_unavailable");
  const { block, read } = await sources(userId, folder, plan, 24_000);
  if (!read.length) throw new ActionError("source_missing", plan.reads[0] ?? null);
  for (const rel of read) result.items.push({ kind: "read", to: rel });
  const language = LANGUAGE_NAMES[row.language] ?? "the language of the request";
  const table = create.format === "xlsx";
  const system = [
    table
      ? `You make a comparison table for the user from their documents. Answer with Markdown tables only: a header row, then one row per item compared. No text before or after the tables.`
      : `You write the content of a Word document for the user from their documents, in simple Markdown: a # title, ## headings, paragraphs, - lists and | tables |. No text before or after the document.`,
    `Write in ${language}. Use only what the documents say; when a document does not say something, write that it does not say it (« non précisé », « not stated »…), never a guess. Name the document each fact comes from.`,
  ].join(" ");
  const user = `${table ? "Table" : "Document"} asked: ${plan.request}\nTitle: ${create.title}\n\nThe documents:\n\n${block}`;
  let written: string;
  try {
    written = cleaned(await modelCall(userId, row.model, [{ role: "system", content: system }, { role: "user", content: user }], signal));
  } catch (err) {
    throw err instanceof ActionError ? err : new ActionError("model_unavailable");
  }
  if (!written) throw new ActionError("empty");
  let bytes: Uint8Array;
  if (table) {
    const tables = markdownTables(written);
    if (!tables.length) throw new ActionError("no_table");
    const sheets: SheetTable[] = tables.map((each, i) => ({ name: tables.length > 1 ? `${create.title.slice(0, 26)} ${i + 1}` : create.title, header: each.header, rows: each.rows }));
    bytes = spreadsheetFile(sheets, { language: row.language as MainLocale, title: create.title });
  } else {
    bytes = wordDocument(written, create.title);
  }
  await folderFor(folder, dirname(target), result.folders);
  try {
    await writeFile(target, bytes, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new ActionError("destination_exists", create.name);
    throw err;
  }
  result.done = 1;
  result.items.push({ kind: "created", to: create.name });
  setResult(row.id, result);
}

/// Runs an action the person agreed to; resolves once it is done or failed
/// (its row says which, with what was done).
export async function runFileAction(row: FileActionRow, options: { signal?: AbortSignal } = {}): Promise<FileActionResult> {
  const total = row.plan.create ? 1 : row.plan.moves.length;
  const result: FileActionResult = { done: 0, total, items: [], folders: [], failure: null };
  try {
    const folder = await checkedFolder(row.userId, row.plan);
    if (row.plan.kind === "sort" || row.plan.kind === "rename") await runMoves(row.userId, row, folder, result);
    else await writeDocument(row.userId, row, folder, result, options.signal);
    transition(row.id, ["running"], "done", { result });
    void reindex(row.userId).catch(() => undefined);
  } catch (err) {
    result.failure = err instanceof ActionError ? { reason: err.reason, ...(err.at ? { at: err.at } : {}) } : { reason: "failed" };
    transition(row.id, ["running"], "failed", { result });
    if (result.done > 0) void reindex(row.userId).catch(() => undefined);
  }
  return result;
}

/// Puts back what a sort or a rename moved: each file still where Twoody
/// put it, its old place still free; then the folders it made, if empty.
export async function undoFileAction(row: FileActionRow): Promise<FileActionResult> {
  const result: FileActionResult = row.result ?? { done: 0, total: 0, items: [], folders: [] };
  const folder = await checkedFolder(row.userId, row.plan);
  let restored = 0;
  let left = 0;
  const moved = result.items.filter((item): item is FileActionItem & { from: string } => item.kind === "moved" && typeof item.from === "string");
  for (const item of [...moved].reverse()) {
    try {
      const now = within(folder, item.to);
      const before = within(folder, item.from);
      const info = await lstat(now).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || (await exists(before))) {
        left += 1;
        continue;
      }
      await folderFor(folder, dirname(before), []);
      await moveFile(now, before);
      restored += 1;
    } catch {
      left += 1;
    }
  }
  // The folders it made, deepest first, only when nothing is in them.
  for (const rel of [...result.folders].sort((a, b) => b.length - a.length)) {
    try {
      const path = within(folder, rel);
      if ((await readdir(path)).length === 0) await rmdir(path);
    } catch {
      // kept
    }
  }
  const next: FileActionResult = { ...result, undo: { restored, left } };
  transition(row.id, ["done", "failed"], "undone", { result: next });
  void reindex(row.userId).catch(() => undefined);
  return next;
}
