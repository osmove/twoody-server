import { semanticPassages } from "./semantic.js";
import { fusePassages } from "./vectorMath.js";
import { sqlite } from "../db.js";
import { queryTerms, metadataScore } from "./query.js";
import { searchPassages, type Passage } from "./library.js";

interface Turn { role: string; content: string; sourcesJson?: string | null }
interface FileRow { id: string; name: string; modified_at: string; chars: number }
export function followUpQuestion(question: string): boolean {
  return /\b(résum\w*|resum\w*|summari\w*|celui|celle|lequel|laquelle|celui-ci|celui-là|ce document|ce fichier|it|that document|this file|plus récent|latest|most recent)\b/i.test(question);
}
/** Revalidate grants on each turn, including any source carried from history. */
export async function retrieveDocuments(userId: string, question: string, history: Turn[], folderIds: string[]) {
  if (!folderIds.length) return { passages: [] as Passage[], files: [] as FileRow[], total: 0 };
  const scope = folderIds.map(() => "?").join(",");
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
  let referenced = explicit;
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
  let passages = folderInventory ? [] : searchPassages(userId, contextual, 6, folderIds);
  if (!folderInventory && referenced.length !== 1) passages = fusePassages(passages, await semanticPassages(userId, contextual, folderIds));
  // A summary needs the actual document, not only the passages matching "résume".
  // Six chunks are bounded; disclose coverage instead of promising a full read.
  if (referenced.length === 1) {
    const file = referenced[0];
    passages = sqlite.prepare(`SELECT c.document_id,d.name,d.path,c.page,c.text,
      substr(c.text,1,240) AS snippet FROM document_chunks c JOIN documents d ON d.id=c.document_id
      WHERE c.user_id=? AND d.id=? AND d.folder_id IN (${scope}) ORDER BY c.position,c.rowid LIMIT 6`)
      .all(userId,file.id,...folderIds) as Passage[];
  }
  return { passages, files: files.slice(0,40).map(file => ({id:file.id,name:file.name,modified_at:new Date(file.mtime_ms).toISOString(),chars:file.chars})), total: files.length };
}
