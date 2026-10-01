import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../auth.js";
import { ownerRequest } from "../localAccess.js";
import { isPersonOrOwner } from "../sessionTrust.js";
import { meshRoster } from "../vault/roster.js";
import { db, discussions, messages, sqlite } from "../db.js";
import { generateId } from "../auth.js";
import { publish as publishEvent } from "../events.js";
import { discussionContext } from "./queries.js";
import { readMemoryMode } from "../chatContext.js";

// `/discussions` mirrors the cloud's chat-history surface. The RN app
// hits this on chat boot to render the recent-conversations drawer
// and on tapping a row to hydrate the bubble list. Self-hosted mode
// reads straight from SQLite — no Action Cable, no live cursors. The
// inactivity-window resolver in /queries clusters short follow-ups
// into the same discussion, same as cloud DiscussionResolver, so
// the listing matches what the iPhone shows for cloud accounts.
//
// The synchronised history (a conversation with a vault id: the person's
// encrypted history, opened here) is only for this server's owner or one
// of the person's own devices (sessionTrust.ts, however paired, once it
// sent a device-access its vault person device signed): anyone else — a
// household member's phone, a device paired by code that is no member of
// the history, one the console approved, a firmware device — lists, opens,
// deletes and imports only this computer's own conversations.

/// Whether this request may reach the synchronised history.
export async function mayReachHistory(req: FastifyRequest, auth: { sessionId?: string }): Promise<boolean> {
  return ownerRequest(req) || (await isPersonOrOwner(req, auth, () => meshRoster().get()));
}

export async function discussionRoutes(app: FastifyInstance) {
  await deleteDiscussion(app);
  await importDiscussion(app);
  await patchDiscussion(app);
  app.get<{
    Querystring: { q?: string; limit?: string; before?: string };
  }>("/discussions", {
    schema: {
      tags: ["session"],
      summary: "List the user's recent discussions (with optional search + pagination)",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      querystring: {
        type: "object",
        properties: {
          q:      { type: "string", description: "Substring match against title and any message body" },
          limit:  { type: "string", description: "Max rows to return (default 50, capped at 200)" },
          before: { type: "string", description: "ISO8601 cursor — return rows whose last_activity_at is strictly before this" },
        },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit ?? "50", 10) || 50));
      const before = req.query.before ? new Date(req.query.before) : null;
      const queryStr = (req.query.q ?? "").trim().toLowerCase();

      // Pull every discussion for this user. Self-hosted volumes
      // are tiny (a power user has hundreds, not millions), so an
      // in-memory filter is far simpler than building proper SQL
      // for the LIKE-or-message-match-or-cursor combo. Pagination
      // is best-effort cursor-based: `before` skips rows past the
      // cursor, then we slice up to `limit`. When the user scrolls
      // beyond the cap they fall through to an empty page rather
      // than a 4xx — same shape the iPhone expects.
      let rows = db
        .select()
        .from(discussions)
        .where(eq(discussions.userId, auth.userId))
        .all();
      if (rows.some((row) => row.vaultId) && !(await mayReachHistory(req, auth))) rows = rows.filter((row) => !row.vaultId);

      if (queryStr) {
        // Title hits are free (already in `rows`). For body hits we
        // pull the content of every matching message in one shot
        // and bucket by discussion_id, so the loop stays O(n) in
        // total messages instead of O(discussions × messages).
        const titleHits = new Set(
          rows
            .filter((row) => (row.title ?? "").toLowerCase().includes(queryStr))
            .map((row) => row.id),
        );
        // Drizzle has no built-in `LIKE`, but a raw `%substring%` via
        // `sql` would do the same job. We stay JS-side for now —
        // self-hosted message volumes are small (thousands at most),
        // and switching to SQL means accepting injection-safe SQL
        // composition. Worth doing once we hit perf trouble.
        const allMessages = db
          .select({
            discussionId: messages.discussionId,
            content:      messages.content,
          })
          .from(messages)
          .all();
        const bodyHits = new Set<string>();
        for (const row of allMessages) {
          if (row.content.toLowerCase().includes(queryStr)) {
            bodyHits.add(row.discussionId);
          }
        }
        rows = rows.filter((row) => titleHits.has(row.id) || bodyHits.has(row.id));
      }

      // Most recent first. Timestamps have one-second resolution: two
      // conversations active within the same second are told apart by
      // insertion order (the table scan returns rows oldest first), so
      // the one started last still comes first.
      const position = new Map(rows.map((row, index) => [row.id, index]));
      rows = rows.sort(
        (a, b) =>
          b.lastActivityAt.getTime() - a.lastActivityAt.getTime() ||
          (position.get(b.id) ?? 0) - (position.get(a.id) ?? 0),
      );
      if (before) {
        rows = rows.filter((row) => row.lastActivityAt.getTime() < before.getTime());
      }
      const page = rows.slice(0, limit);

      reply.send({
        discussions: page.map((row) => ({
          id:               row.id,
          title:            row.title ?? null,
          channel:          row.channel,
          vault_id:         row.vaultId ?? null,
          memory_mode:      readMemoryMode(row.memoryMode),
          created_at:       row.createdAt.toISOString(),
          last_activity_at: row.lastActivityAt.toISOString(),
        })),
        // Cursor for the next page — null when we've reached the
        // tail. The client uses this verbatim as `?before=`.
        next_before:        page.length === limit
          ? page[page.length - 1].lastActivityAt.toISOString()
          : null,
        total_unfiltered:   queryStr ? rows.length : null,
      });
    },
  });

  app.get<{ Params: { id: string } }>("/discussions/:id", {
    schema: {
      tags: ["session"],
      summary: "Discussion + ordered messages",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const [discussion] = db
        .select()
        .from(discussions)
        .where(and(
          eq(discussions.id, req.params.id),
          eq(discussions.userId, auth.userId),
        ))
        .limit(1)
        .all();
      if (!discussion || (discussion.vaultId && !(await mayReachHistory(req, auth)))) {
        return reply.code(404).send({ error: "not_found" });
      }

      const rows = db
        .select()
        .from(messages)
        .where(eq(messages.discussionId, discussion.id))
        .all()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      // A compaction: where its summary stops, and what the model is given
      // of the conversation now (the gauge under the composer).
      const context = discussionContext(auth.userId, discussion.id);
      // Which memories an answer was given is the person's to read (like
      // /memories): counted for anyone else, not listed.
      const listsMemories = rows.some((row) => row.memoryJson) && (await mayReachHistory(req, auth));
      reply.send({
        id:               discussion.id,
        title:            discussion.title ?? null,
        channel:          discussion.channel,
        vault_id:         discussion.vaultId ?? null,
        // Its own memory mode (Mémoire v2); null follows the person's (/me).
        memory_mode:      readMemoryMode(discussion.memoryMode),
        summary:          context.summary,
        summary_through:  context.summaryThrough,
        context_tokens_estimate: context.tokensEstimate,
        created_at:       discussion.createdAt.toISOString(),
        last_activity_at: discussion.lastActivityAt.toISOString(),
        messages: rows.map((row) => ({
          id:         row.id,
          role:       row.role,
          content:    row.content,
          provider:   row.provider,
          model:      row.model,
          sources:    parseSources(row.sourcesJson),
          reasoning:  row.reasoning ?? null,
          reasoning_ms: row.reasoningMs ?? null,
          prompt_tokens: row.promptTokens ?? null,
          completion_tokens: row.completionTokens ?? null,
          tokens_estimated: row.tokensEstimated ?? null,
          // Which of the account's computers wrote it (router/, /queries).
          answered_by: parseAnsweredBy(row.answeredByJson),
          // What an answer was given of the memories (/queries final.memory).
          memory:     memoryOf(row.memoryJson, listsMemories),
          created_at: row.createdAt.toISOString(),
        })),
      });
    },
  });
}

/// A conversation's memory mode (Mémoire v2, L4a): « Complète » ("full"),
/// « Profil seulement » ("profile"), « Aucune » ("none"), or null to follow
/// the person's (/me). Its next turn freezes the memories again for it.
async function patchDiscussion(app: FastifyInstance) {
  app.patch<{ Params: { id: string }; Body: { memory_mode?: unknown } }>("/discussions/:id", {
    schema: {
      tags: ["session"],
      summary: "Change a discussion's memory mode",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", properties: { memory_mode: { type: ["string", "null"] } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [owned] = db
        .select({ id: discussions.id, vaultId: discussions.vaultId, memoryMode: discussions.memoryMode })
        .from(discussions)
        .where(and(eq(discussions.id, req.params.id), eq(discussions.userId, auth.userId)))
        .limit(1)
        .all();
      if (!owned || (owned.vaultId && !(await mayReachHistory(req, auth)))) return reply.code(404).send({ error: "not_found" });
      const body = req.body ?? {};
      let memoryMode = readMemoryMode(owned.memoryMode);
      if ("memory_mode" in body) {
        if (body.memory_mode !== null && !readMemoryMode(body.memory_mode)) return reply.code(422).send({ error: "invalid_memory_mode" });
        memoryMode = readMemoryMode(body.memory_mode);
        db.update(discussions).set({ memoryMode }).where(eq(discussions.id, owned.id)).run();
      }
      reply.send({ id: owned.id, memory_mode: memoryMode });
    },
  });
}

/// Deletes a discussion and its messages — what "Supprimer" in the
/// desktop's sidebar does, as in ChatGPT and Claude.
async function deleteDiscussion(app: FastifyInstance) {
  app.delete<{ Params: { id: string } }>("/discussions/:id", {
    schema: {
      tags: ["session"],
      summary: "Delete a discussion and its messages",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const owned = db
        .select({ id: discussions.id, vaultId: discussions.vaultId })
        .from(discussions)
        .where(and(eq(discussions.id, req.params.id), eq(discussions.userId, auth.userId)))
        .limit(1)
        .all();
      if (owned.length === 0 || (owned[0]!.vaultId && !(await mayReachHistory(req, auth)))) return reply.code(404).send({ error: "not_found" });
      db.transaction((tx) => {
        tx.delete(messages).where(eq(messages.discussionId, req.params.id)).run();
        tx.delete(discussions).where(eq(discussions.id, req.params.id)).run();
      });
      publishEvent({ kind: "discussion.touched", userId: auth.userId, discussionId: req.params.id, lastActivityAt: new Date().toISOString() });
      reply.code(204).send();
    },
  });
}

/// Document excerpts an assistant reply was given, so its [1], [2]…
/// citations still resolve when the discussion is reopened.
function parseSources(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const VAULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// An encrypted conversation brought to this computer (twoody-app
// utils/vaultSync.js, twoody-desktop src/shared/vaultSync.ts): the client
// opened its exchanges with its own keys and hands them over so that the
// conversation can go on here, with its history. Idempotent: the
// conversation is found by its vault id, an exchange by its ref; importing
// again adds only what is new. Only for the signed-in owner of this
// server — nothing here comes from or goes to the account.
async function importDiscussion(app: FastifyInstance) {
  app.post<{ Body: { vault_id: string; discussion_id?: string; title?: string; turns: Array<{ ref: string; text: string; reply: string; model?: string | null; created_at?: string }> } }>("/discussions/import", {
    schema: {
      tags: ["session"],
      summary: "Create or extend a conversation from its decrypted exchanges",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        required: ["vault_id", "turns"],
        properties: {
          vault_id: { type: "string", maxLength: 36 },
          // A conversation already here that starts being synchronised:
          // it takes the vault id, so later imports extend it.
          discussion_id: { type: "string", maxLength: 100 },
          title: { type: "string", maxLength: 200 },
          turns: {
            type: "array", maxItems: 500,
            items: {
              type: "object", required: ["ref", "text", "reply"],
              properties: {
                ref: { type: "string", minLength: 1, maxLength: 200 },
                text: { type: "string", maxLength: 100000 },
                reply: { type: "string", maxLength: 200000 },
                model: { type: ["string", "null"], maxLength: 200 },
                created_at: { type: "string", maxLength: 40 },
              },
            },
          },
        },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await mayReachHistory(req, auth))) return reply.code(403).send({ error: "person_device_required" });
      const vaultId = req.body.vault_id.toLowerCase();
      if (!VAULT_ID.test(vaultId)) return reply.code(422).send({ error: "invalid_vault_id" });

      const result = importVaultConversation(auth.userId, { ...req.body, vault_id: vaultId });
      if ("error" in result) return reply.code(result.error === "unknown_discussion" ? 404 : 409).send({ error: result.error });
      reply.send({ discussion_id: result.id, added: result.added, created: result.created });
    },
  });
}

export type ImportedTurn = {
  ref: string; text: string; reply: string; model?: string | null; created_at?: string;
  /// Kept with the reply when the vault carries them (src/vault/sync.ts): who
  /// answered, and the excerpts it cited (never a path).
  answered_by?: unknown; sources?: unknown[];
};
export type ImportBody = { vault_id: string; discussion_id?: string; title?: string; turns: ImportedTurn[] };

/// POST /discussions/import's work, for this computer's own vault sync too
/// (src/vault/sync.ts): the same conversation by its vault id, the same
/// exchange by its ref, so importing again adds only what is new.
export function importVaultConversation(userId: string, body: ImportBody): { error: "unknown_discussion" | "already_synchronised" | "invalid_vault_id" } | { id: string; added: number; created: boolean } {
  const vaultId = body.vault_id.toLowerCase();
  if (!VAULT_ID.test(vaultId)) return { error: "invalid_vault_id" };
  const run = sqlite.transaction(() => {
    let found = sqlite.prepare("SELECT id FROM discussions WHERE user_id = ? AND vault_id = ?").get(userId, vaultId) as { id: string } | undefined;
    if (found && body.discussion_id && found.id !== body.discussion_id) return { error: "already_synchronised" as const };
    if (!found && body.discussion_id) {
      const own = sqlite.prepare("SELECT id, vault_id FROM discussions WHERE user_id = ? AND id = ?").get(userId, body.discussion_id) as { id: string; vault_id: string | null } | undefined;
      if (!own) return { error: "unknown_discussion" as const };
      if (own.vault_id && own.vault_id !== vaultId) return { error: "already_synchronised" as const };
      sqlite.prepare("UPDATE discussions SET vault_id = ? WHERE id = ?").run(vaultId, own.id);
      found = { id: own.id };
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const id = found?.id ?? generateId();
    if (!found) {
      sqlite.prepare("INSERT INTO discussions (id, user_id, channel, title, created_at, last_activity_at, vault_id) VALUES (?, ?, 'vault', ?, ?, ?, ?)")
        .run(id, userId, body.title?.slice(0, 200) || body.turns[0]?.text.slice(0, 60) || null, nowSeconds, nowSeconds, vaultId);
    } else if (body.title) {
      sqlite.prepare("UPDATE discussions SET title = ? WHERE id = ?").run(body.title.slice(0, 200), id);
    }
    const known = new Set((sqlite.prepare("SELECT vault_ref FROM messages WHERE discussion_id = ? AND vault_ref IS NOT NULL").all(id) as Array<{ vault_ref: string }>).map((row) => row.vault_ref));
    const insert = sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, provider, model, vault_ref, created_at, sources_json, answered_by_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    let added = 0;
    let latest = 0;
    const turns = [...body.turns].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
    const adopt = sqlite.prepare("SELECT id, rowid AS position FROM messages WHERE discussion_id = ? AND id = ? AND role = 'user' AND vault_ref IS NULL");
    const replyAfter = sqlite.prepare("SELECT id FROM messages WHERE discussion_id = ? AND role = 'assistant' AND vault_ref IS NULL AND rowid > ? ORDER BY rowid LIMIT 1");
    const setRef = sqlite.prepare("UPDATE messages SET vault_ref = ? WHERE id = ?");
    for (const turn of turns) {
      if (known.has(turn.ref)) continue;
      // An exchange already here, now being synchronised (its ref is the
      // question's message id): it takes the ref instead of a copy.
      const existing = adopt.get(id, turn.ref) as { id: string; position: number } | undefined;
      if (existing) {
        setRef.run(turn.ref, existing.id);
        const answer = replyAfter.get(id, existing.position) as { id: string } | undefined;
        if (answer) setRef.run(`${turn.ref}#reply`, answer.id);
        known.add(turn.ref);
        continue;
      }
      const at = Math.floor((Date.parse(turn.created_at ?? "") || Date.now()) / 1000);
      const sources = Array.isArray(turn.sources) && turn.sources.length > 0 ? JSON.stringify(turn.sources.slice(0, 12)) : null;
      const answeredBy = turn.answered_by && typeof turn.answered_by === "object" ? JSON.stringify(turn.answered_by) : null;
      insert.run(generateId(), id, userId, "user", turn.text, null, null, turn.ref, at, null, null);
      insert.run(generateId(), id, userId, "assistant", turn.reply, "vault", turn.model ?? null, `${turn.ref}#reply`, at, sources, answeredBy);
      known.add(turn.ref);
      latest = Math.max(latest, at);
      added += 1;
    }
    if (latest) sqlite.prepare("UPDATE discussions SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?").run(latest, id);
    return { id, added, created: !found };
  });
  const result = run();
  if ("error" in result) return result;
  if (result.created) publishEvent({ kind: "discussion.created", userId, discussionId: result.id, title: body.title ?? null });
  else if (result.added > 0) publishEvent({ kind: "discussion.touched", userId, discussionId: result.id, lastActivityAt: new Date().toISOString() });
  return result;
}

/// A conversation deleted on another device (a vault tombstone): its copy
/// here goes, as DELETE /discussions/:id does. Returns how many went.
export function deleteVaultConversation(userId: string, vaultId: string): number {
  const rows = sqlite.prepare("SELECT id FROM discussions WHERE user_id = ? AND vault_id = ?").all(userId, vaultId.toLowerCase()) as Array<{ id: string }>;
  for (const row of rows) {
    db.transaction((tx) => {
      tx.delete(messages).where(eq(messages.discussionId, row.id)).run();
      tx.delete(discussions).where(eq(discussions.id, row.id)).run();
    });
    publishEvent({ kind: "discussion.touched", userId, discussionId: row.id, lastActivityAt: new Date().toISOString() });
  }
  return rows.length;
}

function parseJson(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function memoryOf(json: string | null, listed: boolean): unknown {
  const memory = parseJson(json);
  if (!memory || typeof memory !== "object" || listed) return memory;
  return { ...(memory as Record<string, unknown>), items: [] };
}

function parseAnsweredBy(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
