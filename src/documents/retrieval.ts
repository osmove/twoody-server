import { capabilityOn } from "../localCapabilities.js";
import { semanticPassages } from "./semantic.js";
import { fusePassages } from "./vectorMath.js";
import { sqlite } from "../db.js";
import { queryTerms, metadataScore, smallTalk, termsFound } from "./query.js";
import { folderName, listFolders, searchPassages, type Passage } from "./library.js";
import { folderRisk } from "./folderRisk.js";
import { spotlightCandidates } from "./spotlightRetrieval.js";
import type { DocumentAccess } from "./access.js";
import type { WallPrints } from "./wallIdentity.js";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, sep } from "node:path";

interface Turn { role: string; content: string; sourcesJson?: string | null }
interface FileRow { id: string; name: string; modified_at: string; chars: number }
/** A passage that may leave this computer: where it is said relative to its granted folder. */
export type RelativePassage = Omit<Passage, "path"> & { folder: string; rel_path: string };
export type RelativeFileRow = FileRow & { folder: string; rel_path: string };
export interface RetrieveOptions {
  /** false: passages and files say `folder` (the granted root's name) and `rel_path`, never an absolute path. */
  absolutePaths?: boolean;
  /** false: lexical search only (a peer's search while this computer generates, docs/mesh-design.md §2). */
  semantic?: boolean;
  /** The semantic half is given up after this long; the lexical passages stand. */
  semanticDeadlineMs?: number;
  /** Passages wanted, 6 by default. */
  limit?: number;
}
/** What became of the semantic half: run, given up at the deadline, switched off, or not needed. */
export type SemanticOutcome = "used" | "deadline" | "off" | "not_needed";
type Retrieved<P, F> = { passages: P[]; files: F[]; total: number; semantic?: SemanticOutcome; spotlight?: { found: number; read_now: number; added: number } };

/**
 * The folders a caller may search here: its scope (DocumentAccess, with this
 * computer's folder ids) ∩ this computer's grants, a selected folder taking
 * the grants nested in it, and never a folder folderRisk refuses on this
 * machine now, whatever was granted before. Unknown ids are ignored.
 *
 * An isolated project's folders (src/projects/isolation.ts) are left out —
 * for another computer, the account's tools, a conversation outside it —
 * unless `project` names it (its conversations), or `withIsolated` is set
 * (this computer's own app, browsing or opening a document it cited).
 */
export function scopedFolders(userId: string, scope: Pick<DocumentAccess, "mode" | "folderIds">, options: FolderScopeOptions = {}): Array<{ id: string; name: string; path: string; documents: number; indexed: number; walled: string[]; walledIds: string[]; walledPrints: WallPrints | null; paused: boolean }> {
  // Documents switched off in Capabilities: no folder is searched, for
  // anyone (localCapabilities.ts).
  if (scope.mode === "off" || !capabilityOn(userId, "documents")) return [];
  const granted = listFolders(userId).filter((folder) => inProjectScope(folder.project_id, options));
  const selected = scope.mode === "all" && !scope.folderIds ? granted : granted.filter(folder => scope.folderIds?.includes(folder.id));
  const within = granted.filter(folder => scope.mode === "all" && !scope.folderIds ? true : selected.some(parent => {
    const path = relative(parent.path, folder.path);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  }));
  let home: string;
  try { home = realpathSync(homedir()); } catch { home = homedir(); }
  return within.filter(folder => folderRisk(folder.path, home, process.platform, folder.path === home) === null)
    .map(folder => ({ id: folder.id, name: folder.name, path: folder.path, documents: folder.documents, indexed: folder.indexed, walled: folder.walled, walledIds: folder.walledIds, walledPrints: folder.walledPrints, paused: folder.paused }));
}

export interface FolderScopeOptions {
  /// The isolated project whose conversation searches: its folders only.
  project?: string | null;
  /// Every folder, isolated projects' included: this computer's own app.
  withIsolated?: boolean;
}

/// Whether a folder of this isolated project (null: of none) may be read
/// here.
export function inProjectScope(folderProject: string | null, options: FolderScopeOptions = {}): boolean {
  if (options.withIsolated) return true;
  return (options.project ?? null) === folderProject;
}

/** `path` said from its granted folder, with forward slashes; the bare name if it is not inside. */
export function relativeToFolder(folderPath: string, path: string): string {
  const rel = relative(folderPath, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return basename(path);
  return rel.split(sep).join("/");
}

/** Where each document lives, said without its absolute path. */
export function documentLocations(userId: string, ids: string[]): Map<string, { folder: string; rel_path: string }> {
  const out = new Map<string, { folder: string; rel_path: string }>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const rows = sqlite.prepare(`SELECT d.id, d.path, f.path AS folder_path FROM documents d
      JOIN document_folders f ON f.id=d.folder_id AND f.user_id=d.user_id
      WHERE d.user_id=? AND d.id IN (${batch.map(() => "?").join(",")})`).all(userId, ...batch) as Array<{ id: string; path: string; folder_path: string }>;
    for (const row of rows) out.set(row.id, { folder: folderName(row.folder_path), rel_path: relativeToFolder(row.folder_path, row.path) });
  }
  return out;
}

async function withinDeadline<T>(work: Promise<T>, ms: number | undefined): Promise<{ value: T } | null> {
  if (ms === undefined) return { value: await work };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, ms)); });
  try { return await Promise.race([work.then(value => ({ value })), late]); } finally { clearTimeout(timer); }
}
export function followUpQuestion(question: string): boolean {
  return /\b(résum\w*|resum\w*|summari\w*|celui|celle|lequel|laquelle|celui-ci|celui-là|ce document|ce fichier|it|that document|this file|plus récent|latest|most recent)\b/i.test(question);
}
/** Revalidate grants on each turn, including any source carried from history. */
export async function retrieveDocuments(userId: string, question: string, history: Turn[], folderIds: string[], options?: RetrieveOptions & { absolutePaths?: true }): Promise<Retrieved<Passage, FileRow>>;
export async function retrieveDocuments(userId: string, question: string, history: Turn[], folderIds: string[], options: RetrieveOptions & { absolutePaths: false }): Promise<Retrieved<RelativePassage, RelativeFileRow>>;
export async function retrieveDocuments(userId: string, question: string, history: Turn[], folderIds: string[], options: RetrieveOptions = {}): Promise<Retrieved<Passage | RelativePassage, FileRow | RelativeFileRow>> {
  const found = await retrieve(userId, question, history, folderIds, options);
  if (options.absolutePaths !== false) return found;
  const where = documentLocations(userId, [...found.passages.map(p => p.document_id), ...found.files.map(f => f.id)]);
  const place = (id: string, name: string) => where.get(id) ?? { folder: "", rel_path: name };
  return {
    passages: found.passages.map(({ path: _path, ...passage }) => ({ ...passage, ...place(passage.document_id, passage.name) })),
    files: found.files.map(file => ({ ...file, ...place(file.id, file.name) })),
    total: found.total,
    semantic: found.semantic,
    ...(found.spotlight ? { spotlight: found.spotlight } : {}),
  };
}

async function retrieve(userId: string, question: string, history: Turn[], folderIds: string[], options: RetrieveOptions): Promise<Retrieved<Passage, FileRow>> {
  const limit = Math.max(1, Math.min(options.limit ?? 6, 20));
  if (!folderIds.length) return { passages: [] as Passage[], files: [] as FileRow[], total: 0, semantic: "not_needed" };
  const scope = folderIds.map(() => "?").join(",");
  const followUpEarly = followUpQuestion(question);
  const inventoryEarly = /(?:dossiers?.*(?:accès|acces|access)|(?:accès|acces|access).*dossiers?)/i.test(question);
  // Spotlight (a Mac): files whose text or name match, inside these folders,
  // read into the index now when it has not read them yet. Asked while the
  // search below runs; its documents the search left out are added after.
  const spotlightAsked = !inventoryEarly && (followUpEarly || !smallTalk(question))
    ? spotlightCandidates(
        userId,
        queryTerms(question.replace(/\bcvs\b/gi, "cv")),
        sqlite.prepare(`SELECT id, path FROM document_folders WHERE user_id=? AND id IN (${scope})`).all(userId, ...folderIds).map((row) => {
          const f = row as { id: string; path: string };
          return { id: f.id, name: folderName(f.path), path: f.path };
        }),
        Math.min(1_500, options.semanticDeadlineMs !== undefined ? Math.max(100, options.semanticDeadlineMs / 2) : 1_500),
      ).catch(() => null)
    : Promise.resolve(null);
  const all = sqlite.prepare(`SELECT d.id, d.name, d.mtime_ms, d.chars FROM documents d
    JOIN document_folders f ON f.id=d.folder_id AND f.user_id=d.user_id
    WHERE d.user_id=? AND d.folder_id IN (${scope}) AND d.status='indexed'
    ORDER BY d.mtime_ms DESC, d.name`).all(userId, ...folderIds) as Array<{id: string; name: string; mtime_ms: number; chars: number}>;
  const priorUser = [...history].reverse().find(row => row.role === "user")?.content ?? "";
  const priorAssistant = [...history].reverse().find(row => row.role === "assistant");
  const followUp = followUpQuestion(question);
  const normalized = question.replace(/\bcvs\b/gi, "cv");
  const contextual = followUp ? `${normalized}\n${priorUser.slice(-1500)}` : normalized;
  const terms = queryTerms(contextual);
  const matching = all.filter(file => metadataScore(file.name, "", terms) > 0);
  let files = matching.length ? matching : all;
  const explicit = all.filter(file => question.toLocaleLowerCase().includes(file.name.toLocaleLowerCase()));
  const currentTerms = queryTerms(normalized);
  const scores = all.map(file => termsFound(file.name, currentTerms));
  const best = Math.max(0, ...scores);
  // A named variant (e.g. CV Product Owner) outranks generic CV matches.
  const variant = best >= 2 ? all.filter((_, index) => scores[index] === best) : [];
  let referenced = explicit.length ? explicit : variant;
  if (!referenced.length && followUp && priorAssistant) {
    // Only a file explicitly named in the previous answer becomes the referent.
    // Multiple cited sources do not license an arbitrary "first file" choice.
    referenced = all.filter(file => priorAssistant.content.toLocaleLowerCase().includes(file.name.toLocaleLowerCase()));
    if (!referenced.length && priorAssistant.sourcesJson) {
      try {
        const sources: unknown = JSON.parse(priorAssistant.sourcesJson);
        if (Array.isArray(sources)) {
          const citations = new Set([...priorAssistant.content.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1])));
          const used = sources.filter(s => s && typeof s.document_id === "string" && (!citations.size || citations.has(s.n)));
          const ids = new Set(used.map(s => s.document_id));
          if (ids.size === 1) referenced = all.filter(file => ids.has(file.id));
        }
      } catch { /* historical metadata can be absent or malformed */ }
    }
  }
  if (referenced.length) files = referenced;
  const folderInventory = /(?:dossiers?.*(?:accès|acces|access)|(?:accès|acces|access).*dossiers?)/i.test(question);
  // « Salut », « ça va ? »: nothing to look for, so no passage and no source.
  if (!followUp && !referenced.length && smallTalk(question)) return { passages: [] as Passage[], files: [] as FileRow[], total: 0, semantic: "not_needed" };
  let passages = folderInventory ? [] : searchPassages(userId, contextual, limit, folderIds);
  let semantic: SemanticOutcome = "not_needed";
  if (!folderInventory && referenced.length !== 1) {
    if (options.semantic === false) semantic = "off";
    else {
      const found = await withinDeadline(semanticPassages(userId, contextual, folderIds), options.semanticDeadlineMs);
      semantic = found ? "used" : "deadline";
      passages = fusePassages(passages, found?.value ?? [], limit);
    }
  }
  // A summary needs the actual document, not only the passages matching "résume".
  // Six chunks are bounded; disclose coverage instead of promising a full read.
  if (referenced.length === 1) {
    const file = referenced[0];
    passages = sqlite.prepare(`SELECT c.document_id,d.name,d.path,c.page,c.text,
      substr(c.text,1,240) AS snippet FROM document_chunks c JOIN documents d ON d.id=c.document_id
      WHERE c.user_id=? AND d.id=? AND d.folder_id IN (${scope}) ORDER BY c.position,c.rowid LIMIT ?`)
      .all(userId,file.id,...folderIds,limit) as Passage[];
  }
  // The documents Spotlight matched that the search left out: one passage
  // each (its best), in place of the last ones, two at most.
  const spotlight = await spotlightAsked;
  let added = 0;
  if (spotlight?.documentIds.length && referenced.length === 0 && !folderInventory) {
    const present = new Set(passages.map(passage => passage.document_id));
    const terms = queryTerms(contextual);
    const extra: Passage[] = [];
    for (const id of spotlight.documentIds) {
      if (present.has(id) || extra.length >= 2) continue;
      const chunks = sqlite.prepare(`SELECT c.document_id,d.name,d.path,c.page,c.text,substr(c.text,1,240) AS snippet
        FROM document_chunks c JOIN documents d ON d.id=c.document_id
        WHERE c.user_id=? AND d.id=? AND d.folder_id IN (${scope}) ORDER BY c.position,c.rowid LIMIT 200`).all(userId, id, ...folderIds) as Passage[];
      const best = chunks.map(chunk => ({ chunk, score: termsFound(chunk.text, terms) })).sort((a, b) => b.score - a.score)[0];
      if (best) extra.push({ ...best.chunk, match: "content" });
    }
    added = extra.length;
    passages = passages.length + extra.length <= limit ? [...passages, ...extra] : [...passages.slice(0, limit - extra.length), ...extra];
  }
  if (referenced.length > 1) {
    const ids = new Set(referenced.map(file => file.id));
    passages = passages.filter(passage => ids.has(passage.document_id));
    if (!passages.length) {
      for (const file of referenced.slice(0, limit)) {
        const first = sqlite.prepare(`SELECT c.document_id,d.name,d.path,c.page,c.text,
          substr(c.text,1,240) AS snippet FROM document_chunks c JOIN documents d ON d.id=c.document_id
          WHERE c.user_id=? AND d.id=? ORDER BY c.position,c.rowid LIMIT 1`).get(userId,file.id) as Passage | undefined;
        if (first) passages.push(first);
      }
    }
  }
  return {
    passages,
    files: files.slice(0,40).map(file => ({id:file.id,name:file.name,modified_at:new Date(file.mtime_ms).toISOString(),chars:file.chars})),
    total: files.length,
    semantic,
    ...(spotlight ? { spotlight: { found: spotlight.found, read_now: spotlight.readNow, added } } : {}),
  };
}
