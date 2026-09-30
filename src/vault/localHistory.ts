import { sqlite } from "../db.js";
import { deleteVaultConversation, importVaultConversation } from "../routes/discussions.js";
import type { LocalHistory } from "./sync.js";

// This server's discussions as the vault sync sees them (src/vault/sync.ts):
// imported through the same idempotent import as POST /discussions/import,
// read back by their vault ids and refs.

function parse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function sqliteHistory(userId: string): LocalHistory {
  return {
    import: (body) => importVaultConversation(userId, body),
    deleteByVaultId: (vaultId) => deleteVaultConversation(userId, vaultId),
    byVaultId(vaultId) {
      const row = sqlite.prepare("SELECT id FROM discussions WHERE user_id = ? AND vault_id = ?").get(userId, vaultId.toLowerCase()) as { id: string } | undefined;
      if (!row) return null;
      const refs = (sqlite.prepare("SELECT vault_ref FROM messages WHERE discussion_id = ? AND role = 'user' AND vault_ref IS NOT NULL").all(row.id) as Array<{ vault_ref: string }>).map((r) => r.vault_ref);
      return { id: row.id, refs: new Set(refs) };
    },
    vaultIdOf(discussionId) {
      const row = sqlite.prepare("SELECT vault_id FROM discussions WHERE user_id = ? AND id = ?").get(userId, discussionId) as { vault_id: string | null } | undefined;
      return row?.vault_id ?? null;
    },
    turn(discussionId, ref) {
      const question = sqlite.prepare("SELECT content, created_at FROM messages WHERE discussion_id = ? AND role = 'user' AND vault_ref = ? LIMIT 1").get(discussionId, ref) as { content: string; created_at: number } | undefined;
      const answer = sqlite.prepare("SELECT content, model, sources_json, answered_by_json FROM messages WHERE discussion_id = ? AND role = 'assistant' AND vault_ref = ? LIMIT 1").get(discussionId, `${ref}#reply`) as { content: string; model: string | null; sources_json: string | null; answered_by_json: string | null } | undefined;
      if (!question || !answer) return null;
      const sources = parse(answer.sources_json);
      return {
        text: question.content,
        reply: answer.content,
        model: answer.model,
        // Stored in seconds (drizzle's timestamp mode).
        created_at: new Date(Number(question.created_at) * 1000).toISOString(),
        sources: Array.isArray(sources) ? sources : [],
        answered_by: parse(answer.answered_by_json),
      };
    },
  };
}
