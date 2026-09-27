/** Per-turn library access. Missing means legacy all-folders access. Invalid input fails closed. */
export interface DocumentAccess { mode: "off" | "all" | "selected" | "only"; folderIds?: string[] }
export function documentAccess(value: unknown): DocumentAccess {
  if (value === undefined) return { mode: "all" };
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { throw new Error("invalid_document_access"); } }
  if (!value || typeof value !== "object") throw new Error("invalid_document_access");
  const v = value as Record<string, unknown>;
  if (!["off", "all", "selected", "only"].includes(String(v.mode))) throw new Error("invalid_document_access");
  if (v.folderIds !== undefined && (!Array.isArray(v.folderIds) || v.folderIds.length > 200 || v.folderIds.some(id => typeof id !== "string" || !id || id.length > 200))) throw new Error("invalid_document_access");
  if (v.mode === "selected" && !Array.isArray(v.folderIds)) throw new Error("invalid_document_access");
  return { mode: v.mode as DocumentAccess["mode"], ...(Array.isArray(v.folderIds) ? { folderIds: [...new Set(v.folderIds as string[])] } : {}) };
}
