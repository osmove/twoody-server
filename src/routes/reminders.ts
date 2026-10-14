import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, like, lt, or } from "drizzle-orm";
import { db, reminders } from "../db.js";
import { requireAuth, generateId } from "../auth.js";
import { hiddenWalledProjects, walledProjectIds } from "../projects/walledAccess.js";

// Cloud-shape /reminders CRUD against the local SQLite store. The local
// server does not schedule push notifications yet; it preserves the
// reminder state so CLI, desktop, and app local mode can use the same
// resource contract as Rails.

interface ReminderRow {
  id:             string;
  user_id:        string;
  project_id:     string | null;
  text:           string;
  title:          string | null;
  subtitle:       string | null;
  notify_at:      string | null;
  status:         string;
  channel:        string;
  reminder_type:  string;
  cron:           string | null;
  url:            string;
  created_at:     string;
  updated_at:     string;
}

const VALID_STATUSES = new Set(["active", "done", "notified", "deleted"]);

function serialize(row: typeof reminders.$inferSelect): ReminderRow {
  return {
    id:            row.id,
    user_id:       row.userId,
    project_id:    row.projectId,
    text:          row.text,
    title:         row.title,
    subtitle:      row.subtitle,
    notify_at:     row.notifyAt ? row.notifyAt.toISOString() : null,
    status:        row.status,
    channel:       row.channel,
    reminder_type: row.reminderType,
    cron:          row.cron,
    url:           `/reminders/${row.id}.json`,
    created_at:    row.createdAt.toISOString(),
    updated_at:    row.updatedAt.toISOString(),
  };
}

function parseTimestamp(raw: unknown): Date | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  if (raw === "") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function readBody(raw: unknown): {
  text?:          string;
  title?:         string | null;
  subtitle?:      string | null;
  notify_at?:     Date | null;
  status?:        string;
  channel?:       string;
  project_id?:    string | null;
  reminder_type?: string;
  cron?:          string | null;
} {
  const body = (raw as { reminder?: Record<string, unknown> } | null)?.reminder ?? {};
  const out: Record<string, unknown> = {};
  if (typeof body.text === "string") out.text = body.text;
  if (typeof body.title === "string" || body.title === null) out.title = body.title;
  if (typeof body.subtitle === "string" || body.subtitle === null) out.subtitle = body.subtitle;
  const notifyAt = parseTimestamp(body.notify_at);
  if (notifyAt !== undefined) out.notify_at = notifyAt;
  if (typeof body.status === "string" && VALID_STATUSES.has(body.status)) out.status = body.status;
  if (typeof body.channel === "string") out.channel = body.channel;
  if (typeof body.project_id === "string" || body.project_id === null) out.project_id = body.project_id;
  if (typeof body.reminder_type === "string") out.reminder_type = body.reminder_type;
  if (typeof body.cron === "string" || body.cron === null) out.cron = body.cron;
  return out as ReturnType<typeof readBody>;
}

export async function reminderRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { q?: string; filter?: string };
  }>("/reminders", {
    schema: {
      tags: ["reminders"],
      summary: "List the current user's reminders",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const filters = [eq(reminders.userId, auth.userId)];
      switch (req.query.filter) {
        case "done":
          filters.push(or(eq(reminders.status, "done"), eq(reminders.status, "notified"))!);
          break;
        case "deleted":
          filters.push(eq(reminders.status, "deleted"));
          break;
        case "all":
          filters.push(or(eq(reminders.status, "active"), eq(reminders.status, "done"), eq(reminders.status, "notified"))!);
          break;
        case "overdue":
          filters.push(eq(reminders.status, "active"));
          filters.push(lt(reminders.notifyAt, new Date()));
          break;
        default:
          filters.push(eq(reminders.status, "active"));
          break;
      }

      if (req.query.q && req.query.q.trim()) {
        const pat = `%${req.query.q.trim()}%`;
        const text = or(like(reminders.text, pat), like(reminders.title, pat), like(reminders.subtitle, pat));
        if (text) filters.push(text);
      }

      const rows = db
        .select()
        .from(reminders)
        .where(and(...filters))
        .orderBy(asc(reminders.notifyAt), desc(reminders.createdAt))
        .limit(200)
        .all();

      // A walled-off project's reminders: this computer's app's only.
      const hidden = await hiddenWalledProjects(req, auth);
      reply.send(rows.filter((row) => !(row.projectId && hidden.has(row.projectId))).map(serialize));
    },
  });

  app.get<{ Params: { id: string } }>("/reminders/:id", {
    schema: {
      tags: ["reminders"],
      summary: "Show a single reminder",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [row] = db
        .select()
        .from(reminders)
        .where(and(eq(reminders.id, req.params.id), eq(reminders.userId, auth.userId)))
        .limit(1)
        .all();
      if (!row || (row.projectId && (await hiddenWalledProjects(req, auth)).has(row.projectId))) return reply.code(404).send({ error: "not_found" });
      reply.send(serialize(row));
    },
  });

  app.post<{ Body: unknown }>("/reminders", {
    schema: {
      tags: ["reminders"],
      summary: "Create a reminder",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: { reminder: { type: "object", additionalProperties: true } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const body = readBody(req.body);
      const text = (body.text ?? body.title ?? "").trim();
      if (!text) return reply.code(422).send({ errors: ["text can't be blank"] });
      // Into a walled-off project, from this computer's app only.
      if (body.project_id && (await hiddenWalledProjects(req, auth)).has(body.project_id)) return reply.code(404).send({ error: "project_not_found" });

      const now = new Date();
      const id = generateId();
      db.insert(reminders)
        .values({
          id,
          userId:       auth.userId,
          projectId:    body.project_id ?? null,
          text,
          title:        body.title ?? null,
          subtitle:     body.subtitle ?? null,
          notifyAt:     body.notify_at ?? null,
          status:       body.status ?? "active",
          channel:      body.channel ?? "push",
          reminderType: body.reminder_type ?? "once",
          cron:         body.cron ?? null,
          createdAt:    now,
          updatedAt:    now,
        })
        .run();
      const [row] = db.select().from(reminders).where(eq(reminders.id, id)).limit(1).all();
      reply.code(201).send(serialize(row!));
    },
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/reminders/:id", {
    schema: {
      tags: ["reminders"],
      summary: "Update a reminder",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: { reminder: { type: "object", additionalProperties: true } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [existing] = db
        .select()
        .from(reminders)
        .where(and(eq(reminders.id, req.params.id), eq(reminders.userId, auth.userId)))
        .limit(1)
        .all();
      const hidden = await hiddenWalledProjects(req, auth);
      if (!existing || existing.status === "deleted" || (existing.projectId && hidden.has(existing.projectId))) return reply.code(404).send({ error: "not_found" });
      // A walled-off project's reminder stays in it, another one never
      // enters it (src/projects/isolation.ts).
      const askedProject = (readBody(req.body) as { project_id?: string | null }).project_id;
      if (askedProject !== undefined && askedProject !== existing.projectId) {
        const walled = walledProjectIds(auth.userId);
        if ((existing.projectId && walled.has(existing.projectId)) || (askedProject && walled.has(askedProject))) return reply.code(409).send({ error: "isolated_reminder" });
      }

      const body = readBody(req.body);
      const next = {
        projectId:    body.project_id    !== undefined ? body.project_id : existing.projectId,
        text:         body.text          !== undefined ? body.text.trim() || existing.text : existing.text,
        title:        body.title         !== undefined ? body.title : existing.title,
        subtitle:     body.subtitle      !== undefined ? body.subtitle : existing.subtitle,
        notifyAt:     body.notify_at     !== undefined ? body.notify_at : existing.notifyAt,
        status:       body.status        ?? existing.status,
        channel:      body.channel       ?? existing.channel,
        reminderType: body.reminder_type ?? existing.reminderType,
        cron:         body.cron          !== undefined ? body.cron : existing.cron,
        updatedAt:    new Date(),
      };
      db.update(reminders).set(next).where(eq(reminders.id, existing.id)).run();
      const [row] = db.select().from(reminders).where(eq(reminders.id, existing.id)).limit(1).all();
      reply.send(serialize(row!));
    },
  });

  app.delete<{ Params: { id: string } }>("/reminders/:id", {
    schema: {
      tags: ["reminders"],
      summary: "Soft-delete a reminder",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [existing] = db
        .select()
        .from(reminders)
        .where(and(eq(reminders.id, req.params.id), eq(reminders.userId, auth.userId)))
        .limit(1)
        .all();
      if (!existing || (existing.projectId && (await hiddenWalledProjects(req, auth)).has(existing.projectId))) return reply.code(404).send({ error: "not_found" });
      db.update(reminders)
        .set({ status: "deleted", updatedAt: new Date() })
        .where(eq(reminders.id, existing.id))
        .run();
      reply.code(204).send();
    },
  });
}
