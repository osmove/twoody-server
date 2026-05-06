import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { db, notes } from "../db.js";
import { requireAuth, generateId } from "../auth.js";

// Cloud-shape /notes CRUD against the local SQLite store. Same wire
// shape as Rails (id, title, body, pinned, archived, preview), so the
// iPhone's NotesScreen and the desktop's Notes tab can drive both
// backends without branching.

const PREVIEW_LEN = 120;

interface NoteRow {
  id:         string;
  user_id:    string;
  title:      string | null;
  body:       string;
  pinned:     boolean;
  archived:   boolean;
  preview:    string;
  created_at: string;
  updated_at: string;
}

function serialize(row: typeof notes.$inferSelect): NoteRow {
  // Strip newlines / collapse whitespace so the preview reads sanely
  // in a single-line UI cell. Truncate at PREVIEW_LEN with an ellipsis
  // when the body's longer.
  const compact = row.body.replace(/\s+/g, " ").trim();
  const preview = compact.length > PREVIEW_LEN
    ? `${compact.slice(0, PREVIEW_LEN - 1)}…`
    : compact;
  return {
    id:         row.id,
    user_id:    row.userId,
    title:      row.title,
    body:       row.body,
    pinned:     Boolean(row.pinned),
    archived:   Boolean(row.archived),
    preview,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function readBody(raw: unknown): {
  title?:    string | null;
  body?:     string;
  pinned?:   boolean;
  archived?: boolean;
} {
  const body = (raw as { note?: Record<string, unknown> } | null)?.note ?? {};
  const out: Record<string, unknown> = {};
  if (typeof body.title === "string" || body.title === null) out.title = body.title;
  if (typeof body.body === "string") out.body = body.body;
  if (typeof body.pinned === "boolean") out.pinned = body.pinned;
  if (typeof body.archived === "boolean") out.archived = body.archived;
  return out as ReturnType<typeof readBody>;
}

export async function noteRoutes(app: FastifyInstance) {
  app.get("/notes", {
    schema: {
      tags: ["notes"],
      summary: "List the current user's notes",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const rows = db
        .select()
        .from(notes)
        .where(eq(notes.userId, auth.userId))
        .orderBy(desc(notes.pinned), desc(notes.updatedAt))
        .all();
      reply.send(rows.map(serialize));
    },
  });

  app.get<{ Params: { id: string } }>("/notes/:id", {
    schema: {
      tags: ["notes"],
      summary: "Show a single note",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [row] = db
        .select()
        .from(notes)
        .where(and(eq(notes.id, req.params.id), eq(notes.userId, auth.userId)))
        .limit(1)
        .all();
      if (!row) return reply.code(404).send({ error: "not_found" });
      reply.send(serialize(row));
    },
  });

  app.post<{ Body: unknown }>("/notes", {
    schema: {
      tags: ["notes"],
      summary: "Create a note",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: { note: { type: "object", additionalProperties: true } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const body = readBody(req.body);
      const text = (body.body ?? "").trim();
      if (!text) return reply.code(422).send({ errors: ["body can't be blank"] });

      const now = new Date();
      const id = generateId();
      db.insert(notes)
        .values({
          id,
          userId:    auth.userId,
          title:     body.title ?? null,
          body:      text,
          pinned:    body.pinned ?? false,
          archived:  body.archived ?? false,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const [row] = db.select().from(notes).where(eq(notes.id, id)).limit(1).all();
      reply.code(201).send(serialize(row!));
    },
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/notes/:id", {
    schema: {
      tags: ["notes"],
      summary: "Update a note",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: { note: { type: "object", additionalProperties: true } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [existing] = db
        .select()
        .from(notes)
        .where(and(eq(notes.id, req.params.id), eq(notes.userId, auth.userId)))
        .limit(1)
        .all();
      if (!existing) return reply.code(404).send({ error: "not_found" });

      const body = readBody(req.body);
      const next = {
        title:     body.title    !== undefined ? body.title : existing.title,
        body:      body.body     !== undefined ? body.body : existing.body,
        pinned:    body.pinned   !== undefined ? body.pinned : existing.pinned,
        archived:  body.archived !== undefined ? body.archived : existing.archived,
        updatedAt: new Date(),
      };
      db.update(notes).set(next).where(eq(notes.id, existing.id)).run();
      const [row] = db.select().from(notes).where(eq(notes.id, existing.id)).limit(1).all();
      reply.send(serialize(row!));
    },
  });

  app.delete<{ Params: { id: string } }>("/notes/:id", {
    schema: {
      tags: ["notes"],
      summary: "Delete a note",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const result = db
        .delete(notes)
        .where(and(eq(notes.id, req.params.id), eq(notes.userId, auth.userId)))
        .run();
      if (result.changes === 0) return reply.code(404).send({ error: "not_found" });
      reply.code(204).send();
    },
  });
}
