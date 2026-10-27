import { sqlite } from "../../db.js";
import { idleForMs, inflight, onChatGeneration } from "../../account/inflight.js";
import { capabilityOn } from "../../localCapabilities.js";
import { onIndexPass } from "../../documents/library.js";
import { documentText } from "../../fileActions/plan.js";
import { documentDate } from "../../fileActions/dates.js";
import { findQuote } from "./quotes.js";
import { documentPrompt, readLines, readPoints, SECTIONS, sectionPrompt, type SectionKind, type SectionPoint } from "./prompts.js";
import {
  digestsOf,
  dropAllDigests,
  dropDigests,
  latestVersion,
  overviewFor,
  overviewsOf,
  pointKey,
  projectDocuments,
  propose,
  saveDigest,
  saveDocumentsOnly,
  saveOverview,
  type Changes,
  type Digest,
  type DocumentsRead,
  type Line,
  type OverviewRow,
  type Point,
  type ProjectDocument,
  type Section,
  type Source,
} from "./store.js";

// Making and keeping a project's overview (docs/project-overview-design.md
// §3): each document read once by this computer's model (its points, each
// on the document's own words), each section written from the points of
// every document (each line on the points it names), and, once made, brought
// up to date by proposals the person applies or ignores. One project at a
// time, behind every answer.

/// One call to this computer's model: no tools, no reasoning, the
/// background slot. The documents never leave this computer (queries.ts
/// gives it, as for « Agir dans vos dossiers »).
export type OverviewCall = (userId: string, messages: Array<{ role: "system" | "user"; content: string }>, options: { maxTokens: number; signal: AbortSignal }) => Promise<{ text: string; model: string | null }>;
let modelCall: OverviewCall | null = null;
export function setOverviewModel(call: OverviewCall | null): void {
  modelCall = call;
}

export const PIECE_CHARS = 12_000;
export const MAX_PIECES = 4;
/// Points written in one call for a section; more are written in rounds.
export const MAX_POINTS_PER_CALL = 60;
/// After a change found by a pass, a project is brought up to date at most this often.
export const UPDATE_GAP_MS = 2 * 60_000;
let updateGapMs = UPDATE_GAP_MS;

export class OverviewError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export interface Progress {
  stage: "waiting" | "reading" | "writing";
  done: number;
  total: number;
  current: string | null;
  started_at: string;
}

export interface RunStats {
  documents_read: number;
  points: number;
  /// Points left out: their quote is not in the document.
  dropped: number;
  /// Lines left out: they named none of the points given.
  lines_dropped: number;
  calls: number;
  ms: number;
  outcome: "built" | "proposed" | "unchanged" | "failed";
  error?: string;
}

interface Job {
  userId: string;
  projectId: string;
  fresh: boolean;
}

const progress = new Map<string, Progress>();
const errors = new Map<string, string>();
const lastRun = new Map<string, RunStats>();
const lastChange = new Map<string, number>();
const queue: Job[] = [];
let running: Promise<void> | null = null;
/// The call under way: stopped when an answer starts (it is asked again).
let current: AbortController | null = null;
let stoppedForChat = false;
let quietPollMs = 1_500;
/// Nothing generated for this long before a call (an answer just given may have a follow-up).
let quietAfterMs = 1_000;

onChatGeneration(() => {
  if (!current) return;
  stoppedForChat = true;
  current.abort();
});

export function overviewProgress(projectId: string): Progress | null {
  return progress.get(projectId) ?? null;
}

export function overviewFailure(projectId: string): string | null {
  return errors.get(projectId) ?? null;
}

export function overviewLastRun(projectId: string): RunStats | null {
  return lastRun.get(projectId) ?? null;
}

/// Asks for the overview to be made, or brought up to date: queued, one
/// project at a time. `fresh`: everything read and written again.
export function requestOverview(userId: string, projectId: string, options: { fresh?: boolean; first?: boolean } = {}): void {
  errors.delete(projectId);
  const existing = queue.find((job) => job.projectId === projectId);
  if (existing) existing.fresh ||= options.fresh === true;
  else if (options.first) queue.unshift({ userId, projectId, fresh: options.fresh === true });
  else queue.push({ userId, projectId, fresh: options.fresh === true });
  if (!progress.has(projectId)) progress.set(projectId, { stage: "waiting", done: 0, total: 0, current: null, started_at: new Date().toISOString() });
  if (!running) running = drain().finally(() => { running = null; });
}

/// Resolves once nothing is queued (tests, the bench).
export async function overviewsIdle(): Promise<void> {
  while (running) await running;
}

/// For the tests: how often the runner looks whether the computer is quiet, and how quiet.
export function setQuietForTests(pollMs: number, afterMs: number, gapMs = UPDATE_GAP_MS): void {
  quietPollMs = pollMs;
  quietAfterMs = afterMs;
  updateGapMs = gapMs;
}

async function drain(): Promise<void> {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const started = Date.now();
    const stats: RunStats = { documents_read: 0, points: 0, dropped: 0, lines_dropped: 0, calls: 0, ms: 0, outcome: "unchanged" };
    try {
      stats.outcome = await runProject(job, stats);
    } catch (err) {
      stats.outcome = "failed";
      stats.error = err instanceof OverviewError ? err.code : "failed";
      errors.set(job.projectId, stats.error);
    } finally {
      stats.ms = Date.now() - started;
      lastRun.set(job.projectId, stats);
      progress.delete(job.projectId);
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/// The computer answering nothing: an answer always goes first.
async function quiet(): Promise<void> {
  while (inflight() > 0 || idleForMs() < quietAfterMs) await sleep(quietPollMs);
}

/// One call to the model, asked again when an answer stopped it.
async function ask(userId: string, messages: Array<{ role: "system" | "user"; content: string }>, maxTokens: number, stats: RunStats): Promise<{ text: string; model: string | null }> {
  if (!modelCall) throw new OverviewError(503, "model_unavailable");
  for (let attempt = 0; ; attempt += 1) {
    await quiet();
    current = new AbortController();
    stoppedForChat = false;
    try {
      stats.calls += 1;
      return await modelCall(userId, messages, { maxTokens, signal: AbortSignal.any([current.signal, AbortSignal.timeout(600_000)]) });
    } catch (err) {
      if (stoppedForChat && attempt < 50) continue;
      if (err instanceof OverviewError) throw err;
      throw new OverviewError(503, "model_unavailable");
    } finally {
      current = null;
    }
  }
}

const day = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().slice(0, 10));

/// A document's text in pieces of at most PIECE_CHARS, cut between paragraphs.
export function piecesOf(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > PIECE_CHARS) {
    const cut = rest.lastIndexOf("\n", PIECE_CHARS);
    const at = cut > PIECE_CHARS / 2 ? cut : PIECE_CHARS;
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest.trim()) pieces.push(rest);
  return pieces;
}

/// Where a quote is in a piece, with the page it is on when the text has
/// pages (« [page 3] », documentText).
function placeQuote(piece: string, quote: string): { page: number | null } | null {
  const parts = piece.split(/\n?\[page (\d+)\]\n/);
  // parts: text before any page, then page number, text, page number, text…
  const pages: Array<{ page: number | null; text: string }> = [{ page: null, text: parts[0] ?? "" }];
  for (let i = 1; i + 1 < parts.length; i += 2) pages.push({ page: Number(parts[i]), text: parts[i + 1]! });
  for (const each of pages) if (findQuote(each.text, quote)) return { page: each.page };
  return findQuote(piece, quote) ? { page: null } : null;
}

async function readDocument(userId: string, project: { title: string; brief: string | null }, document: ProjectDocument, language: string, stats: RunStats): Promise<{ digest: Omit<Digest, "id">; model: string | null }> {
  const text = (await documentText(userId, document.path, PIECE_CHARS * MAX_PIECES + 1)) ?? "";
  const partial = text.length > PIECE_CHARS * MAX_PIECES;
  const pieces = piecesOf(text.slice(0, PIECE_CHARS * MAX_PIECES));
  const found = documentDate(text, { language });
  const documentAt = found ? Date.UTC(found.year, found.month - 1, found.day, 12) : document.mtimeMs;
  const items: Point[] = [];
  const keys = new Set<string>();
  let model: string | null = null;
  for (const [index, piece] of pieces.entries()) {
    const answer = await ask(userId, documentPrompt({ project: project.title, brief: project.brief, language, name: document.name, date: day(documentAt), piece: index + 1, pieces: pieces.length, text: piece }), 1_200, stats);
    model = answer.model ?? model;
    for (const point of readPoints(answer.text)) {
      const place = placeQuote(piece, point.quote);
      if (!place) {
        stats.dropped += 1;
        continue;
      }
      const key = pointKey(document.id, point.kind, point.quote);
      if (keys.has(key)) continue;
      keys.add(key);
      items.push({ key, kind: point.kind, text: point.text, quote: point.quote, page: place.page });
    }
  }
  stats.points += items.length;
  stats.documents_read += 1;
  return { digest: { documentId: document.id, name: document.name, size: document.size, mtimeMs: document.mtimeMs, documentAt, items, pieces: pieces.length, partial, language }, model };
}

interface Candidate {
  ref: string;
  date: string | null;
  at: number;
  document: string;
  text: string;
  sources: Source[];
}

/// The other sections' points given with a section, newest first: what a
/// newer document changed elsewhere (the budget raised in an e-mail, a
/// question settled by a decision) shows there.
export const MAX_OTHER_POINTS = 80;

/// A section's lines from its points: in one call, or in rounds when there
/// are too many (the lines of a round are the points of the next).
async function writeSection(userId: string, project: string, language: string, kind: SectionKind, points: Candidate[], all: Record<SectionKind, Candidate[]>, currentLines: Line[] | null, stats: RunStats): Promise<Line[]> {
  if (!points.length) return [];
  let candidates = [...points].sort((a, b) => b.at - a.at);
  while (candidates.length > MAX_POINTS_PER_CALL) {
    const next: Candidate[] = [];
    for (let start = 0; start < candidates.length; start += MAX_POINTS_PER_CALL) {
      const group = candidates.slice(start, start + MAX_POINTS_PER_CALL);
      for (const line of await writeOnce(userId, project, language, kind, group, [], null, stats)) {
        const at = Math.max(...line.sources.map((source) => (source.date ? Date.parse(source.date) : 0)));
        next.push({ ref: "", date: day(at || null), at, document: [...new Set(line.sources.map((source) => source.name))].slice(0, 3).join(", "), text: line.text, sources: line.sources });
      }
    }
    // No progress (every line dropped): what is there is written as it is.
    if (next.length >= candidates.length || !next.length) break;
    candidates = next.sort((a, b) => b.at - a.at);
  }
  const others = SECTIONS.filter((other) => other !== kind)
    .flatMap((section) => all[section].map((candidate) => ({ ...candidate, section })))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_OTHER_POINTS);
  return writeOnce(userId, project, language, kind, candidates.slice(0, MAX_POINTS_PER_CALL * 2), others, currentLines, stats);
}

async function writeOnce(userId: string, project: string, language: string, kind: SectionKind, candidates: Candidate[], others: Array<Candidate & { section: SectionKind }>, currentLines: Line[] | null, stats: RunStats): Promise<Line[]> {
  const numbered = candidates.map((candidate, index) => ({ ...candidate, ref: `i${index + 1}` }));
  const context = others.map((candidate, index) => ({ ...candidate, ref: `i${numbered.length + index + 1}` }));
  // A line may rest on another section's point too (« 22 000 € instead of 18 000 € »).
  const byRef = new Map([...numbered, ...context].map((candidate) => [candidate.ref, candidate]));
  const refOfKey = new Map<string, string>();
  for (const candidate of [...numbered, ...context]) for (const source of candidate.sources) if (!refOfKey.has(source.key)) refOfKey.set(source.key, candidate.ref);
  const current = currentLines?.map((line) => ({ text: line.text, refs: [...new Set(line.sources.map((source) => refOfKey.get(source.key)).filter((ref): ref is string => !!ref))] }));
  const sectionPoints: SectionPoint[] = numbered.map((candidate) => ({ ref: candidate.ref, date: candidate.date, document: candidate.document, text: candidate.text }));
  const otherPoints = context.map((candidate) => ({ ref: candidate.ref, date: candidate.date, document: candidate.document, text: candidate.text, section: candidate.section }));
  const answer = await ask(userId, sectionPrompt({ project, language, kind, points: sectionPoints, ...(otherPoints.length ? { others: otherPoints } : {}), ...(current?.length ? { current } : {}) }), 1_500, stats);
  // A line stands on a point of its own section (another section's point
  // may only change it): the brief never fills up with the decisions.
  const own = new Set(numbered.map((candidate) => candidate.ref));
  const lines = readLines(answer.text, new Set(byRef.keys())).filter((line) => line.refs.some((ref) => own.has(ref)));
  const written = answer.text.split("\n").filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line)).length;
  stats.lines_dropped += Math.max(0, written - lines.length);
  return lines.map((line) => {
    const sources: Source[] = [];
    const seen = new Set<string>();
    for (const ref of line.refs) for (const source of byRef.get(ref)!.sources) if (!seen.has(source.key)) { seen.add(source.key); sources.push(source); }
    return { text: line.text, sources };
  });
}

function candidatesOf(digests: Digest[]): Record<SectionKind, Candidate[]> {
  const out = Object.fromEntries(SECTIONS.map((kind) => [kind, [] as Candidate[]])) as Record<SectionKind, Candidate[]>;
  for (const digest of digests) {
    for (const item of digest.items) {
      out[item.kind]?.push({
        ref: "", date: day(digest.documentAt), at: digest.documentAt ?? digest.mtimeMs, document: digest.name, text: item.text,
        sources: [{ key: item.key, document_id: digest.documentId, name: digest.name, page: item.page, quote: item.quote, date: day(digest.documentAt) }],
      });
    }
  }
  return out;
}

const sameSet = (a: readonly string[] | undefined, b: readonly string[] | undefined) => {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  return left.size === right.size && [...left].every((key) => right.has(key));
};

function projectRow(userId: string, projectId: string): { title: string; brief: string | null; isolated: boolean } | null {
  const row = sqlite.prepare("SELECT title, brief, isolated FROM projects WHERE id = ? AND user_id = ?").get(projectId, userId) as { title: string; brief: string | null; isolated: number } | undefined;
  return row ? { title: row.title, brief: row.brief, isolated: row.isolated === 1 } : null;
}

/// What an overview reads now: its documents, the readable ones, and what
/// it says of the others.
function documentsNow(userId: string, projectId: string, isolated: boolean, overview: OverviewRow) {
  const documents = projectDocuments(userId, projectId, isolated, overview.folder);
  const readable = documents.filter((document) => document.status === "indexed");
  const unreadable = documents
    .filter((document) => document.status !== "indexed")
    .map((document) => ({ document_id: document.id, name: document.name, reason: document.status === "empty" ? "no_text" : document.error === "too_large" ? "too_large" : "failed" }));
  return { readable, unreadable };
}

async function runProject(job: Job, stats: RunStats): Promise<RunStats["outcome"]> {
  const { userId, projectId } = job;
  const project = projectRow(userId, projectId);
  const overview = overviewFor(userId, projectId);
  if (!project || !overview) throw new OverviewError(404, "not_found");
  if (!capabilityOn(userId, "documents")) throw new OverviewError(409, "documents_off");
  if (!project.isolated && !overview.folder) throw new OverviewError(409, "no_folder");
  const { readable, unreadable } = documentsNow(userId, projectId, project.isolated, overview);
  if (!readable.length) throw new OverviewError(409, "no_documents");

  // Read in another language before, or asked from nothing: read again.
  let digests = digestsOf(projectId);
  if (job.fresh || digests.some((digest) => digest.language !== overview.language)) {
    dropAllDigests(projectId);
    digests = [];
  }
  const byDocument = new Map(digests.map((digest) => [digest.documentId, digest]));
  const ids = new Set(readable.map((document) => document.id));
  dropDigests(projectId, digests.filter((digest) => !ids.has(digest.documentId)).map((digest) => digest.documentId));
  const toRead = readable
    .filter((document) => { const known = byDocument.get(document.id); return !known || known.size !== document.size || known.mtimeMs !== document.mtimeMs; })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const state: Progress = { stage: "reading", done: 0, total: toRead.length, current: null, started_at: progress.get(projectId)?.started_at ?? new Date().toISOString() };
  progress.set(projectId, state);
  for (const document of toRead) {
    state.current = document.name;
    const { digest, model } = await readDocument(userId, project, document, overview.language, stats);
    // The project or its overview gone meanwhile: nothing more is kept.
    if (!overviewFor(userId, projectId)) throw new OverviewError(404, "not_found");
    saveDigest(userId, projectId, digest, model);
    state.done += 1;
  }

  digests = digestsOf(projectId).filter((digest) => ids.has(digest.documentId));
  const signatures = Object.fromEntries(digests.map((digest) => [digest.documentId, `${digest.size}:${digest.mtimeMs}`]));
  const candidates = candidatesOf(digests);
  const keys = Object.fromEntries(SECTIONS.map((kind) => [kind, candidates[kind].flatMap((candidate) => candidate.sources.map((source) => source.key))])) as Record<SectionKind, string[]>;
  const documents: DocumentsRead = {
    read: digests.length,
    unreadable,
    partial: digests.filter((digest) => digest.partial).map((digest) => ({ document_id: digest.documentId, name: digest.name })),
    signatures,
    keys,
  };

  state.stage = "writing";
  state.current = null;
  const fresh = overviewFor(userId, projectId)!;
  // The first one, or one asked from nothing: written whole, shown at once.
  if (!fresh.sections || job.fresh) {
    state.done = 0;
    state.total = SECTIONS.length;
    const sections: Section[] = [];
    for (const kind of SECTIONS) {
      sections.push({ kind, lines: await writeSection(userId, project.title, overview.language, kind, candidates[kind], candidates, null, stats) });
      state.done += 1;
    }
    saveOverview(fresh, sections, documents, "built");
    return "built";
  }

  // Brought up to date: nothing new since the last version (applied,
  // ignored or waiting) — nothing to propose.
  const latest = latestVersion(fresh.id);
  const sameAsLatest = SECTIONS.every((kind) => sameSet(keys[kind], latest?.documents?.keys?.[kind]));
  if (sameAsLatest) {
    if (JSON.stringify(signatures) !== JSON.stringify(latest?.documents?.signatures ?? {}) || JSON.stringify(unreadable) !== JSON.stringify(fresh.documents?.unreadable ?? [])) saveDocumentsOnly(fresh, { ...documents, keys: fresh.documents?.keys ?? keys });
    return "unchanged";
  }
  // Every section written again from its lines as they stand (kept word for
  // word where their points still say them): a point of one section may
  // change another's (an e-mail raising the budget is read as a decision; a
  // decision settles an open question). A section without points and
  // without lines costs no call.
  const changed = SECTIONS.filter((kind) => candidates[kind].length || (fresh.sections!.find((section) => section.kind === kind)?.lines.length ?? 0) > 0);
  state.done = 0;
  state.total = changed.length;
  const sections: Section[] = [];
  const diff: Changes["sections"] = [];
  for (const kind of SECTIONS) {
    const before = fresh.sections.find((section) => section.kind === kind)?.lines ?? [];
    if (!changed.includes(kind)) {
      sections.push({ kind, lines: before });
      continue;
    }
    const lines = await writeSection(userId, project.title, overview.language, kind, candidates[kind], candidates, before, stats);
    state.done += 1;
    sections.push({ kind, lines });
    const was = new Set(before.map((line) => line.text));
    const now = new Set(lines.map((line) => line.text));
    const added = lines.filter((line) => !was.has(line.text)).map((line) => line.text);
    const removed = before.filter((line) => !now.has(line.text)).map((line) => line.text);
    if (added.length || removed.length) diff.push({ kind, added, removed });
  }
  const seen = fresh.documents?.signatures ?? {};
  const names = new Map([...readable.map((document) => [document.id, document.name] as const), ...digestsOf(projectId).map((digest) => [digest.documentId, digest.name] as const)]);
  const known = new Map((fresh.sections.flatMap((section) => section.lines.flatMap((line) => line.sources))).map((source) => [source.document_id, source.name]));
  const changes: Changes = {
    documents: {
      added: Object.keys(signatures).filter((id) => !(id in seen)).map((id) => names.get(id) ?? id),
      changed: Object.keys(signatures).filter((id) => id in seen && seen[id] !== signatures[id]).map((id) => names.get(id) ?? id),
      removed: Object.keys(seen).filter((id) => !(id in signatures)).map((id) => known.get(id) ?? names.get(id) ?? "?"),
    },
    sections: diff,
  };
  if (!diff.length) {
    // Points moved, the lines did not: the overview stays, its sources follow.
    saveOverview(fresh, sections, documents, "applied");
    return "unchanged";
  }
  propose(fresh, sections, documents, changes);
  return "proposed";
}

/// Whether the documents of an overview changed since they were read.
export function overviewStale(userId: string, overview: OverviewRow): boolean {
  const project = projectRow(userId, overview.projectId);
  if (!project || (!project.isolated && !overview.folder)) return false;
  const { readable } = documentsNow(userId, overview.projectId, project.isolated, overview);
  const digests = new Map(digestsOf(overview.projectId).map((digest) => [digest.documentId, digest]));
  if (digests.size !== readable.length) return true;
  return readable.some((document) => {
    const known = digests.get(document.id);
    return !known || known.size !== document.size || known.mtimeMs !== document.mtimeMs;
  });
}

/// After a pass: the overviews whose documents changed are brought up to
/// date, at most every UPDATE_GAP_MS each.
export function overviewsAfterPass(userId: string, now = Date.now()): void {
  if (!capabilityOn(userId, "documents")) return;
  for (const overview of overviewsOf(userId)) {
    if (!overview.sections || progress.has(overview.projectId)) continue;
    if (!overviewStale(userId, overview)) continue;
    const last = lastChange.get(overview.projectId) ?? 0;
    if (now - last < updateGapMs) {
      const wait = setTimeout(() => overviewsAfterPass(userId), updateGapMs - (now - last) + 1_000);
      wait.unref?.();
      continue;
    }
    lastChange.set(overview.projectId, now);
    requestOverview(userId, overview.projectId);
  }
}

let watchingPasses = false;
/// On a running server (index.ts): every pass may bring an overview up to date.
export function startOverviewUpdates(): void {
  if (watchingPasses) return;
  watchingPasses = true;
  onIndexPass((userId) => overviewsAfterPass(userId));
}
