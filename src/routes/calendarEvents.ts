import type { FastifyInstance } from "fastify";
import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { db, calendarEvents } from "../db.js";
import { requireAuth, generateId } from "../auth.js";

// Local /events implementation. Index returns the same agenda envelope
// Rails uses (`{events, providers, range}`), while show/create/update
// return a single local event shape.

interface CalendarEventRow {
  id:          string;
  user_id:     string;
  name:        string;
  description: string | null;
  status:      string;
  kind:        string;
  notes:       string | null;
  start_time:  string;
  end_time:    string | null;
  all_day:     boolean;
  location:    string | null;
  url:         string;
  created_at:  string;
  updated_at:  string;
}

interface AgendaEventRow extends CalendarEventRow {
  local_id:     string;
  provider_id:  null;
  provider:     "twoody" | "apple";
  /// "macos": copied from the Mac's Calendar app, changed there only.
  source:       "twoody" | "macos";
  source_label: string;
  calendar:     string | null;
  read_only:    boolean;
}

const DEFAULT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function serialize(row: typeof calendarEvents.$inferSelect): CalendarEventRow {
  return {
    id:          row.id,
    user_id:     row.userId,
    name:        row.name,
    description: row.description,
    status:      row.status,
    kind:        row.kind,
    notes:       row.notes,
    start_time:  row.startTime.toISOString(),
    end_time:    row.endTime ? row.endTime.toISOString() : null,
    all_day:     Boolean(row.allDay),
    location:    row.location,
    url:         `/events/${row.id}.json`,
    created_at:  row.createdAt.toISOString(),
    updated_at:  row.updatedAt.toISOString(),
  };
}

function serializeAgenda(row: typeof calendarEvents.$inferSelect): AgendaEventRow {
  const fromMac = row.source === "macos";
  return {
    ...serialize(row),
    id:           fromMac ? `macos:${row.id}` : `twoody:${row.id}`,
    local_id:     row.id,
    provider_id:  null,
    provider:     fromMac ? "apple" : "twoody",
    source:       fromMac ? "macos" : "twoody",
    source_label: fromMac ? (row.calendar ?? "Calendar") : "Twoody",
    calendar:     row.calendar,
    read_only:    row.source !== null,
  };
}

function parseTimestamp(raw: unknown): Date | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  if (raw === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dayStart(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function dayEnd(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(23, 59, 59, 999);
  return copy;
}

function agendaRange(query: { start_time?: string; start_date?: string; end_time?: string; end_date?: string }) {
  const start = parseTimestamp(query.start_time ?? query.start_date) ?? dayStart(new Date());
  const end = parseTimestamp(query.end_time ?? query.end_date) ?? dayEnd(new Date(start.getTime() + DEFAULT_WINDOW_MS));
  return end < start ? { start, end: dayEnd(new Date(start.getTime() + DEFAULT_WINDOW_MS)) } : { start, end };
}

function normalizeId(id: string): string {
  return id.replace(/^(?:twoody|macos):/, "");
}

function readBody(raw: unknown): {
  calendar_provider?: string;
  name?:              string;
  description?:       string | null;
  status?:            string;
  kind?:              string;
  notes?:             string | null;
  start_time?:        Date | null;
  end_time?:          Date | null;
  all_day?:           boolean;
  location?:          string | null;
} {
  const root = raw as ({ calendar_provider?: unknown; sync_provider?: unknown; event?: Record<string, unknown> } | null);
  const body = root?.event ?? {};
  const out: Record<string, unknown> = {};
  const provider = root?.calendar_provider ?? root?.sync_provider ?? body.calendar_provider;
  if (typeof provider === "string") out.calendar_provider = provider;
  if (typeof body.name === "string") out.name = body.name;
  if (typeof body.description === "string" || body.description === null) out.description = body.description;
  if (typeof body.status === "string") out.status = body.status;
  if (typeof body.kind === "string") out.kind = body.kind;
  if (typeof body.notes === "string" || body.notes === null) out.notes = body.notes;
  const start = parseTimestamp(body.start_time);
  if (start !== undefined) out.start_time = start;
  const end = parseTimestamp(body.end_time);
  if (end !== undefined) out.end_time = end;
  if (typeof body.all_day === "boolean") out.all_day = body.all_day;
  if (typeof body.location === "string" || body.location === null) out.location = body.location;
  return out as ReturnType<typeof readBody>;
}

export async function calendarEventRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { start_time?: string; start_date?: string; end_time?: string; end_date?: string; include_holidays?: string };
  }>("/events", {
    schema: {
      tags: ["events"],
      summary: "List local calendar events in agenda format",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const { start, end } = agendaRange(req.query);
      const rows = db
        .select()
        .from(calendarEvents)
        .where(and(
          eq(calendarEvents.userId, auth.userId),
          gte(calendarEvents.startTime, start),
          lte(calendarEvents.startTime, end),
        ))
        .orderBy(asc(calendarEvents.startTime), asc(calendarEvents.name))
        .limit(1_000)
        .all();

      reply.send({
        events: rows.map(serializeAgenda),
        providers: [
          { id: "twoody", name: "Twoody", connected: true, status: "connected" },
          { id: "google", name: "Google Calendar", connected: false, status: "not_configured" },
          {
            id: "holidays",
            name: "Public holidays",
            connected: req.query.include_holidays !== "0",
            status: "not_available_local",
          },
        ],
        range: { start_time: start.toISOString(), end_time: end.toISOString() },
      });
    },
  });

  app.get<{ Params: { id: string } }>("/events/:id", {
    schema: {
      tags: ["events"],
      summary: "Show a single local calendar event",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [row] = db
        .select()
        .from(calendarEvents)
        .where(and(eq(calendarEvents.id, normalizeId(req.params.id)), eq(calendarEvents.userId, auth.userId)))
        .limit(1)
        .all();
      if (!row) return reply.code(404).send({ error: "not_found" });
      reply.send(serialize(row));
    },
  });

  app.post<{ Body: unknown }>("/events", {
    schema: {
      tags: ["events"],
      summary: "Create a local calendar event",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: { event: { type: "object", additionalProperties: true } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const body = readBody(req.body);
      if (body.calendar_provider && !["twoody", "local"].includes(body.calendar_provider)) {
        return reply.code(422).send({ error: "provider_not_available" });
      }
      const name = (body.name ?? "").trim();
      if (!name) return reply.code(422).send({ errors: ["name can't be blank"] });
      if (!body.start_time) return reply.code(422).send({ errors: ["start_time can't be blank"] });

      const now = new Date();
      const id = generateId();
      db.insert(calendarEvents)
        .values({
          id,
          userId:      auth.userId,
          name,
          description: body.description ?? null,
          status:      body.status ?? "confirmed",
          kind:        body.kind ?? "event",
          notes:       body.notes ?? null,
          startTime:   body.start_time,
          endTime:     body.end_time ?? null,
          allDay:      body.all_day ?? false,
          location:    body.location ?? null,
          createdAt:   now,
          updatedAt:   now,
        })
        .run();
      const [row] = db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).limit(1).all();
      reply.code(201).send(serialize(row!));
    },
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/events/:id", {
    schema: {
      tags: ["events"],
      summary: "Update a local calendar event",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: { event: { type: "object", additionalProperties: true } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [existing] = db
        .select()
        .from(calendarEvents)
        .where(and(eq(calendarEvents.id, normalizeId(req.params.id)), eq(calendarEvents.userId, auth.userId)))
        .limit(1)
        .all();
      if (!existing) return reply.code(404).send({ error: "not_found" });
      // An event copied from the Mac is changed in the Mac's Calendar app.
      if (existing.source !== null) return reply.code(409).send({ error: "read_only", source: existing.source });

      const body = readBody(req.body);
      const next = {
        name:        body.name        !== undefined ? body.name.trim() || existing.name : existing.name,
        description: body.description !== undefined ? body.description : existing.description,
        status:      body.status      ?? existing.status,
        kind:        body.kind        ?? existing.kind,
        notes:       body.notes       !== undefined ? body.notes : existing.notes,
        startTime:   body.start_time  ?? existing.startTime,
        endTime:     body.end_time    !== undefined ? body.end_time : existing.endTime,
        allDay:      body.all_day     ?? existing.allDay,
        location:    body.location    !== undefined ? body.location : existing.location,
        updatedAt:   new Date(),
      };
      db.update(calendarEvents).set(next).where(eq(calendarEvents.id, existing.id)).run();
      const [row] = db.select().from(calendarEvents).where(eq(calendarEvents.id, existing.id)).limit(1).all();
      reply.send(serialize(row!));
    },
  });

  app.delete<{ Params: { id: string } }>("/events/:id", {
    schema: {
      tags: ["events"],
      summary: "Delete a local calendar event",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const result = db
        .delete(calendarEvents)
        .where(and(eq(calendarEvents.id, normalizeId(req.params.id)), eq(calendarEvents.userId, auth.userId), isNull(calendarEvents.source)))
        .run();
      if (result.changes === 0) return reply.code(404).send({ error: "not_found" });
      reply.code(204).send();
    },
  });
}
