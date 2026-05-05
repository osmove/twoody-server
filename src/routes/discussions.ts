import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../auth.js";
import { db, discussions, messages } from "../db.js";

// `/discussions` mirrors the cloud's chat-history surface. The RN app
// hits this on chat boot to render the recent-conversations drawer
// and on tapping a row to hydrate the bubble list. Self-hosted mode
// reads straight from SQLite — no Action Cable, no live cursors. The
// inactivity-window resolver in /queries clusters short follow-ups
// into the same discussion, same as cloud DiscussionResolver, so
// the listing matches what the iPhone shows for cloud accounts.
export async function discussionRoutes(app: FastifyInstance) {
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

      rows = rows.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
      if (before) {
        rows = rows.filter((row) => row.lastActivityAt.getTime() < before.getTime());
      }
      const page = rows.slice(0, limit);

      reply.send({
        discussions: page.map((row) => ({
          id:               row.id,
          title:            row.title ?? null,
          channel:          row.channel,
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

      reply.send({
        id:               discussion.id,
        title:            discussion.title ?? null,
        channel:          discussion.channel,
        created_at:       discussion.createdAt.toISOString(),
        last_activity_at: discussion.lastActivityAt.toISOString(),
        messages: rows.map((row) => ({
          id:         row.id,
          role:       row.role,
          content:    row.content,
          provider:   row.provider,
          model:      row.model,
          created_at: row.createdAt.toISOString(),
        })),
      });
    },
  });
}
