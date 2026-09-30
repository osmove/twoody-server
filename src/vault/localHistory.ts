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
    // Only an exchange this computer answered itself: one question and one
    // answer under the ref, the answer written here (an exchange imported
    // from the vault or inlined by a client as prior_turns is answered
    // « vault »: it is context, never sealed again as this computer's).
    turn(discussionId, ref) {
      const questions = sqlite.prepare("SELECT content, created_at FROM messages WHERE discussion_id = ? AND role = 'user' AND vault_ref = ? ORDER BY rowid LIMIT 2").all(discussionId, ref) as Array<{ content: string; created_at: number }>;
      const answers = sqlite.prepare("SELECT content, model, provider, sources_json, answered_by_json FROM messages WHERE discussion_id = ? AND role = 'assistant' AND vault_ref = ? ORDER BY rowid LIMIT 2").all(discussionId, `${ref}#reply`) as Array<{ content: string; model: string | null; provider: string | null; sources_json: string | null; answered_by_json: string | null }>;
      if (questions.length !== 1 || answers.length !== 1) return null;
      const [question, answer] = [questions[0]!, answers[0]!];
      if (!answer.provider || answer.provider === "vault") return null;
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
