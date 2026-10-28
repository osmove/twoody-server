import type { FastifyInstance } from "fastify";
import { generateId, requireAuth } from "../auth.js";
import { sqlite } from "../db.js";
import { requirePerson } from "./memories.js";
import { telemetryOf, traceOfMessage } from "../diagnostics/traces.js";
import { modelLabel } from "../diagnostics/installation.js";
import { reachesWalledProjects, walledConversation } from "../projects/walledAccess.js";

// 👍 / 👎 under an answer (Jimmy, 28/10/2026): the person's opinion of it,
// kept on this computer (migration 18, `answer_votes`) — one per answer,
// changed or taken back at will — and handed back as what may go to Osmove
// (`share`), which the Desktop or the phone sends to the account itself
// (twoody-backend AnswerVotesController): the vote, the reason picked for a
// 👎 and the comment if one was written, the model's name, and the answer's
// technical details (`telemetryOf`: names, counts, sizes, times, never a word
// of the conversation) — which the app sends only while « Partager des
// diagnostics » is ticked. A walled-off project's answers: kept here, given
// only from where its conversations are reached, and never shared (`share`
// is null: nothing of a walled-off project leaves the computer).

export const ANSWER_VOTES = ["up", "down"] as const;
export const VOTE_REASONS = ["wrong", "not_done", "said_done", "language", "too_long", "other"] as const;
export type VoteReason = (typeof VOTE_REASONS)[number];
export const MAX_VOTE_COMMENT = 2000;

export interface AnswerVote {
  id: string;
  message_id: string;
  vote: "up" | "down";
  reason: VoteReason | null;
  comment: string | null;
  updated_at: string;
}

interface VoteRow { id: string; message_id: string; discussion_id: string | null; vote: "up" | "down"; reason: string | null; comment: string | null; model: string | null; updated_at: number; deleted_at: number | null }

const voteOf = (row: VoteRow): AnswerVote => ({
  id: row.id,
  message_id: row.message_id,
  vote: row.vote,
  reason: (VOTE_REASONS as readonly string[]).includes(row.reason ?? "") ? (row.reason as VoteReason) : null,
  comment: row.comment,
  updated_at: new Date(row.updated_at).toISOString(),
});

/// What the account may receive for this vote: nothing the person wrote but
/// their comment; nothing at all for a walled-off project's answer.
export function shareOf(row: VoteRow, userId: string): Record<string, unknown> | null {
  if (walledConversation(row.discussion_id)) return null;
  const trace = traceOfMessage(userId, row.message_id, true);
  return {
    id: row.id,
    message_id: row.message_id,
    vote: row.deleted_at ? null : row.vote,
    reason: row.deleted_at || row.vote !== "down" ? null : row.reason,
    comment: row.deleted_at || row.vote !== "down" ? null : row.comment,
    model: row.model,
    ...(trace ? { telemetry: telemetryOf(trace) } : {}),
  };
}

function cleanComment(value: unknown): string | null {
  const text = typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
  return text ? text.slice(0, MAX_VOTE_COMMENT) : null;
}

export async function answerVoteRoutes(app: FastifyInstance) {
  app.put<{ Params: { id: string }; Body: { vote?: unknown; reason?: unknown; comment?: unknown } }>("/messages/:id/vote", {
    schema: {
      tags: ["discussions"],
      summary: "Give, change or take back the person's 👍 / 👎 on an answer",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: {
          vote: { type: ["string", "null"], enum: ["up", "down", null] },
          reason: { type: ["string", "null"] },
          comment: { type: ["string", "null"], maxLength: 20000 },
        },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      const message = sqlite.prepare("SELECT id, discussion_id AS discussionId, role, model FROM messages WHERE id = ? AND user_id = ?").get(req.params.id, auth.userId) as
        | { id: string; discussionId: string; role: string; model: string | null }
        | undefined;
      if (!message || message.role !== "assistant") return reply.code(404).send({ error: "not_found" });
      if (walledConversation(message.discussionId) && !(await reachesWalledProjects(req, auth))) return reply.code(404).send({ error: "not_found" });
      const vote = req.body?.vote === "up" || req.body?.vote === "down" ? req.body.vote : null;
      const reason = vote === "down" && (VOTE_REASONS as readonly string[]).includes(String(req.body?.reason)) ? String(req.body?.reason) : null;
      const comment = vote === "down" ? cleanComment(req.body?.comment) : null;
      const now = Date.now();
      const existing = sqlite.prepare("SELECT * FROM answer_votes WHERE user_id = ? AND message_id = ?").get(auth.userId, message.id) as VoteRow | undefined;
      if (!existing && !vote) return reply.send({ vote: null, share: null });
      const trace = traceOfMessage(auth.userId, message.id);
      const model = modelLabel(trace?.model ?? message.model ?? null) || null;
      if (existing) {
        sqlite
          .prepare("UPDATE answer_votes SET vote = COALESCE(?, vote), reason = ?, comment = ?, model = ?, updated_at = ?, deleted_at = ? WHERE id = ?")
          .run(vote, reason, comment, model, now, vote ? null : now, existing.id);
      } else {
        sqlite
          .prepare("INSERT INTO answer_votes (id, user_id, message_id, discussion_id, vote, reason, comment, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(generateId(), auth.userId, message.id, message.discussionId, vote, reason, comment, model, now, now);
      }
      const row = sqlite.prepare("SELECT * FROM answer_votes WHERE user_id = ? AND message_id = ?").get(auth.userId, message.id) as VoteRow;
      reply.send({ vote: row.deleted_at ? null : voteOf(row), share: shareOf(row, auth.userId) });
    },
  });

  app.get<{ Params: { id: string } }>("/discussions/:id/votes", {
    schema: { tags: ["discussions"], summary: "The person's 👍 / 👎 on the answers of a conversation", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      if (walledConversation(req.params.id) && !(await reachesWalledProjects(req, auth))) return reply.code(404).send({ error: "not_found" });
      const rows = sqlite.prepare("SELECT * FROM answer_votes WHERE user_id = ? AND discussion_id = ? AND deleted_at IS NULL").all(auth.userId, req.params.id) as VoteRow[];
      reply.send({ votes: rows.map(voteOf) });
    },
  });
}
