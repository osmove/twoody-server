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
  app.get("/discussions", {
    schema: {
      tags: ["session"],
      summary: "List the user's recent discussions",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const rows = db
        .select()
        .from(discussions)
        .where(eq(discussions.userId, auth.userId))
        .all()
        .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
        .slice(0, 50);

      reply.send({
        discussions: rows.map((row) => ({
          id:               row.id,
          title:            row.title ?? null,
          channel:          row.channel,
          created_at:       row.createdAt.toISOString(),
          last_activity_at: row.lastActivityAt.toISOString(),
        })),
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
