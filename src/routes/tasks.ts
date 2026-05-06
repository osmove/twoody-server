import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { db, tasks } from "../db.js";
import { requireAuth, generateId } from "../auth.js";

// Cloud-shape /tasks CRUD against the local SQLite store. Wire shape
// mirrors `app/views/tasks/_task.json.jbuilder` on Rails (id, title,
// notes, due_at, done_at, priority + derived done/overdue/priority_label).
// One TasksScreen / Tasks tab on the client, two backends behind.

interface TaskRow {
  id:              string;
  user_id:         string;
  title:           string;
  notes:           string | null;
  due_at:          string | null;
  done_at:         string | null;
  priority:        number | null;
  priority_label:  string | null;
  done:            boolean;
  overdue:         boolean;
  project_id:      null;
  created_at:      string;
  updated_at:      string;
}

const PRIORITY_LABELS: Record<number, string> = {
  0: "Low",
  1: "Medium",
  2: "High",
};

function priorityLabel(priority: number | null | undefined): string | null {
  if (priority == null) return null;
  return PRIORITY_LABELS[priority] ?? String(priority);
}

function serialize(row: typeof tasks.$inferSelect): TaskRow {
  const done = row.doneAt != null;
  const dueMs = row.dueAt instanceof Date ? row.dueAt.getTime() : null;
  return {
    id:             row.id,
    user_id:        row.userId,
    title:          row.title,
    notes:          row.notes,
    due_at:         row.dueAt ? row.dueAt.toISOString() : null,
    done_at:        row.doneAt ? row.doneAt.toISOString() : null,
    priority:       row.priority,
    priority_label: priorityLabel(row.priority),
    done,
    overdue:        !done && dueMs != null && dueMs < Date.now(),
    project_id:     null,
    created_at:     row.createdAt.toISOString(),
    updated_at:     row.updatedAt.toISOString(),
  };
}

/// Accept ISO-8601 strings (`2026-05-06T13:30:00Z`) or `null` to
/// clear. Rejects other shapes by returning undefined — callers
/// preserve the existing value when undefined.
function parseTimestamp(raw: unknown): Date | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  if (raw === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function readBody(raw: unknown): {
  title?:    string;
  notes?:    string | null;
  due_at?:   Date | null;
  done_at?:  Date | null;
  priority?: number | null;
} {
  const body = (raw as { task?: Record<string, unknown> } | null)?.task ?? {};
  const out: Record<string, unknown> = {};
  if (typeof body.title === "string") out.title = body.title;
  if (typeof body.notes === "string" || body.notes === null) out.notes = body.notes;
  const due = parseTimestamp(body.due_at);
  if (due !== undefined) out.due_at = due;
  const done = parseTimestamp(body.done_at);
  if (done !== undefined) out.done_at = done;
  if (typeof body.priority === "number") out.priority = body.priority;
  else if (body.priority === null) out.priority = null;
  return out as ReturnType<typeof readBody>;
}

export async function taskRoutes(app: FastifyInstance) {
  app.get("/tasks", {
    schema: {
      tags: ["tasks"],
      summary: "List the current user's tasks",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      // Sorted: not-done first (by due_at asc, NULL last), done last.
      // SQLite's NULLS LAST isn't supported pre-3.30; emulate via a
      // secondary column. drizzle has no `nullsLast` helper either,
      // so order in JS after the fetch — list size is bounded.
      const rows = db
        .select()
        .from(tasks)
        .where(eq(tasks.userId, auth.userId))
        .orderBy(asc(tasks.doneAt), asc(tasks.dueAt))
        .all();
      const sorted = rows.sort((a, b) => {
        const aDone = a.doneAt ? 1 : 0;
        const bDone = b.doneAt ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        const aDue = a.dueAt ? a.dueAt.getTime() : Number.POSITIVE_INFINITY;
        const bDue = b.dueAt ? b.dueAt.getTime() : Number.POSITIVE_INFINITY;
        return aDue - bDue;
      });
      reply.send(sorted.map(serialize));
    },
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", {
    schema: {
      tags: ["tasks"],
      summary: "Show a single task",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [row] = db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, req.params.id), eq(tasks.userId, auth.userId)))
        .limit(1)
        .all();
      if (!row) return reply.code(404).send({ error: "not_found" });
      reply.send(serialize(row));
    },
  });

  app.post<{ Body: unknown }>("/tasks", {
    schema: {
      tags: ["tasks"],
      summary: "Create a task",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: { task: { type: "object", additionalProperties: true } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const body = readBody(req.body);
      const title = (body.title ?? "").trim();
      if (!title) return reply.code(422).send({ errors: ["title can't be blank"] });

      const now = new Date();
      const id = generateId();
      db.insert(tasks)
        .values({
          id,
          userId:    auth.userId,
          title,
          notes:     body.notes ?? null,
          dueAt:     body.due_at ?? null,
          doneAt:    body.done_at ?? null,
          priority:  body.priority ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const [row] = db.select().from(tasks).where(eq(tasks.id, id)).limit(1).all();
      reply.code(201).send(serialize(row!));
    },
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/tasks/:id", {
    schema: {
      tags: ["tasks"],
      summary: "Update a task",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: { task: { type: "object", additionalProperties: true } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [existing] = db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, req.params.id), eq(tasks.userId, auth.userId)))
        .limit(1)
        .all();
      if (!existing) return reply.code(404).send({ error: "not_found" });

      const body = readBody(req.body);
      const next = {
        title:     body.title     !== undefined ? body.title!.trim() || existing.title : existing.title,
        notes:     body.notes     !== undefined ? body.notes : existing.notes,
        dueAt:     body.due_at    !== undefined ? body.due_at : existing.dueAt,
        doneAt:    body.done_at   !== undefined ? body.done_at : existing.doneAt,
        priority:  body.priority  !== undefined ? body.priority : existing.priority,
        updatedAt: new Date(),
      };
      db.update(tasks).set(next).where(eq(tasks.id, existing.id)).run();
      const [row] = db.select().from(tasks).where(eq(tasks.id, existing.id)).limit(1).all();
      reply.send(serialize(row!));
    },
  });

  app.delete<{ Params: { id: string } }>("/tasks/:id", {
    schema: {
      tags: ["tasks"],
      summary: "Delete a task",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const result = db
        .delete(tasks)
        .where(and(eq(tasks.id, req.params.id), eq(tasks.userId, auth.userId)))
        .run();
      if (result.changes === 0) return reply.code(404).send({ error: "not_found" });
      reply.code(204).send();
    },
  });
}
