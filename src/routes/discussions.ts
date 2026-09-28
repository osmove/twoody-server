import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../auth.js";
import { db, discussions, messages, sqlite } from "../db.js";
import { generateId } from "../auth.js";
import { publish as publishEvent } from "../events.js";
import { discussionContext } from "./queries.js";

// `/discussions` mirrors the cloud's chat-history surface. The RN app
// hits this on chat boot to render the recent-conversations drawer
// and on tapping a row to hydrate the bubble list. Self-hosted mode
// reads straight from SQLite — no Action Cable, no live cursors. The
// inactivity-window resolver in /queries clusters short follow-ups
// into the same discussion, same as cloud DiscussionResolver, so
// the listing matches what the iPhone shows for cloud accounts.
export async function discussionRoutes(app: FastifyInstance) {
  await deleteDiscussion(app);
  await importDiscussion(app);
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
      if (!discussion) {
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
      reply.send({
        id:               discussion.id,
        title:            discussion.title ?? null,
        channel:          discussion.channel,
        vault_id:         discussion.vaultId ?? null,
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
          created_at: row.createdAt.toISOString(),
        })),
      });
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
        .select({ id: discussions.id })
        .from(discussions)
        .where(and(eq(discussions.id, req.params.id), eq(discussions.userId, auth.userId)))
        .limit(1)
        .all();
      if (owned.length === 0) return reply.code(404).send({ error: "not_found" });
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
  app.post<{ Body: { vault_id: string; title?: string; turns: Array<{ ref: string; text: string; reply: string; model?: string | null; created_at?: string }> } }>("/discussions/import", {
    schema: {
      tags: ["session"],
      summary: "Create or extend a conversation from its decrypted exchanges",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        required: ["vault_id", "turns"],
        properties: {
          vault_id: { type: "string", maxLength: 36 },
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
      const vaultId = req.body.vault_id.toLowerCase();
      if (!VAULT_ID.test(vaultId)) return reply.code(422).send({ error: "invalid_vault_id" });

      const run = sqlite.transaction(() => {
        const found = sqlite.prepare("SELECT id FROM discussions WHERE user_id = ? AND vault_id = ?").get(auth.userId, vaultId) as { id: string } | undefined;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const id = found?.id ?? generateId();
        if (!found) {
          sqlite.prepare("INSERT INTO discussions (id, user_id, channel, title, created_at, last_activity_at, vault_id) VALUES (?, ?, 'vault', ?, ?, ?, ?)")
            .run(id, auth.userId, req.body.title?.slice(0, 200) || req.body.turns[0]?.text.slice(0, 60) || null, nowSeconds, nowSeconds, vaultId);
        } else if (req.body.title) {
          sqlite.prepare("UPDATE discussions SET title = ? WHERE id = ?").run(req.body.title.slice(0, 200), id);
        }
        const known = new Set((sqlite.prepare("SELECT vault_ref FROM messages WHERE discussion_id = ? AND vault_ref IS NOT NULL").all(id) as Array<{ vault_ref: string }>).map((row) => row.vault_ref));
        const insert = sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, provider, model, vault_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        let added = 0;
        let latest = 0;
        const turns = [...req.body.turns].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
        for (const turn of turns) {
          if (known.has(turn.ref)) continue;
          const at = Math.floor((Date.parse(turn.created_at ?? "") || Date.now()) / 1000);
          insert.run(generateId(), id, auth.userId, "user", turn.text, null, null, turn.ref, at);
          insert.run(generateId(), id, auth.userId, "assistant", turn.reply, "vault", turn.model ?? null, `${turn.ref}#reply`, at);
          known.add(turn.ref);
          latest = Math.max(latest, at);
          added += 1;
        }
        if (latest) sqlite.prepare("UPDATE discussions SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?").run(latest, id);
        return { id, added, created: !found };
      });
      const result = run();
      if (result.created) publishEvent({ kind: "discussion.created", userId: auth.userId, discussionId: result.id, title: req.body.title ?? null });
      else if (result.added > 0) publishEvent({ kind: "discussion.touched", userId: auth.userId, discussionId: result.id, lastActivityAt: new Date().toISOString() });
      reply.send({ discussion_id: result.id, added: result.added, created: result.created });
    },
  });
}
