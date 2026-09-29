import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull, like, or } from "drizzle-orm";
import { db, contacts } from "../db.js";
import { requireAuth, generateId } from "../auth.js";

// Small local /contacts surface. It preserves the Rails JSON names the
// clients use, but stores only the common fields needed for local search
// and CLI-created contacts.

interface ContactRow {
  id:                string;
  user_id:           string;
  name:              string | null;
  first_name:        string | null;
  middle_name:       string | null;
  last_name:         string | null;
  email:             string | null;
  phone_country_code: string | null;
  phone_number:      string | null;
  relation_type:     string | null;
  relation_subtype:  string | null;
  origin:            string;
  /// "macos" for a card copied from the Mac's Contacts: read-only here.
  source:            string | null;
  organization:      string | null;
  phones:            string[];
  emails:            string[];
  birthday:          string | null;
  read_only:         boolean;
  url:               string;
  created_at:        string;
  updated_at:        string;
}

function serialize(row: typeof contacts.$inferSelect): ContactRow {
  return {
    id:                 row.id,
    user_id:            row.userId,
    name:               row.name,
    first_name:         row.firstName,
    middle_name:        row.middleName,
    last_name:          row.lastName,
    email:              row.email,
    phone_country_code: row.phoneCountryCode,
    phone_number:       row.phoneNumber,
    relation_type:      row.relationType,
    relation_subtype:   row.relationSubtype,
    origin:             row.origin,
    source:             row.source,
    organization:       row.organization,
    phones:             row.phonesJson ? jsonList(row.phonesJson) : [row.phoneNumber].filter((phone): phone is string => Boolean(phone)),
    emails:             row.emailsJson ? jsonList(row.emailsJson) : [row.email].filter((email): email is string => Boolean(email)),
    birthday:           row.birthday,
    read_only:          row.source !== null,
    url:                `/contacts/${row.id}.json`,
    created_at:         row.createdAt.toISOString(),
    updated_at:         row.updatedAt.toISOString(),
  };
}

function jsonList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function displayName(row: typeof contacts.$inferSelect): string {
  return row.name || [row.firstName, row.lastName].filter(Boolean).join(" ") || "(unnamed contact)";
}

function searchRow(row: typeof contacts.$inferSelect) {
  return {
    id: row.id,
    name: displayName(row),
    email: row.email,
    source: "contact",
  };
}

function readBody(raw: unknown): {
  name?:               string | null;
  first_name?:         string | null;
  middle_name?:        string | null;
  last_name?:          string | null;
  email?:              string | null;
  phone_country_code?: string | null;
  phone_number?:       string | null;
  relation_type?:      string | null;
  relation_subtype?:   string | null;
  origin?:             string;
} {
  const body = (raw as { contact?: Record<string, unknown> } | null)?.contact ?? {};
  const out: Record<string, unknown> = {};
  if (typeof body.name === "string" || body.name === null) out.name = body.name;
  if (typeof body.first_name === "string" || body.first_name === null) out.first_name = body.first_name;
  if (typeof body.middle_name === "string" || body.middle_name === null) out.middle_name = body.middle_name;
  if (typeof body.last_name === "string" || body.last_name === null) out.last_name = body.last_name;
  if (typeof body.email === "string" || body.email === null) out.email = body.email;
  if (typeof body.phone_country_code === "string" || body.phone_country_code === null) {
    out.phone_country_code = body.phone_country_code;
  }
  if (typeof body.phone_number === "string" || body.phone_number === null) out.phone_number = body.phone_number;
  if (typeof body.relation_type === "string" || body.relation_type === null) out.relation_type = body.relation_type;
  if (typeof body.relation_subtype === "string" || body.relation_subtype === null) out.relation_subtype = body.relation_subtype;
  if (typeof body.origin === "string") out.origin = body.origin;
  return out as ReturnType<typeof readBody>;
}

export async function contactRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { q?: string; only_with_email?: string };
  }>("/contacts/search", {
    schema: {
      tags: ["contacts"],
      summary: "Search contacts",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const filters = [eq(contacts.userId, auth.userId)];
      if (req.query.q && req.query.q.trim()) {
        const pat = `%${req.query.q.trim()}%`;
        const text = or(
          like(contacts.name, pat),
          like(contacts.firstName, pat),
          like(contacts.lastName, pat),
          like(contacts.email, pat),
          like(contacts.organization, pat),
        );
        if (text) filters.push(text);
      }

      const rows = db
        .select()
        .from(contacts)
        .where(and(...filters))
        .orderBy(asc(contacts.name), asc(contacts.firstName))
        .limit(50)
        .all()
        .filter((row) => req.query.only_with_email !== "1" || Boolean(row.email));

      reply.send({ results: rows.slice(0, 20).map(searchRow) });
    },
  });

  app.get("/contacts", {
    schema: {
      tags: ["contacts"],
      summary: "List the current user's contacts",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const rows = db
        .select()
        .from(contacts)
        .where(eq(contacts.userId, auth.userId))
        .orderBy(asc(contacts.name), asc(contacts.firstName))
        .limit(200)
        .all();
      reply.send(rows.map(serialize));
    },
  });

  app.get<{ Params: { id: string } }>("/contacts/:id", {
    schema: {
      tags: ["contacts"],
      summary: "Show a single contact",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [row] = db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, req.params.id), eq(contacts.userId, auth.userId)))
        .limit(1)
        .all();
      if (!row) return reply.code(404).send({ error: "not_found" });
      reply.send(serialize(row));
    },
  });

  app.post<{ Body: unknown }>("/contacts", {
    schema: {
      tags: ["contacts"],
      summary: "Create a contact",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: { contact: { type: "object", additionalProperties: true } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const body = readBody(req.body);
      const name = body.name?.trim() || [body.first_name, body.last_name].filter(Boolean).join(" ").trim();
      if (!name && !body.email && !body.phone_number) {
        return reply.code(422).send({ errors: ["name, email, or phone_number is required"] });
      }

      const now = new Date();
      const id = generateId();
      db.insert(contacts)
        .values({
          id,
          userId:           auth.userId,
          name:             name || null,
          firstName:        body.first_name ?? null,
          middleName:       body.middle_name ?? null,
          lastName:         body.last_name ?? null,
          email:            body.email ?? null,
          phoneCountryCode: body.phone_country_code ?? null,
          phoneNumber:      body.phone_number ?? null,
          relationType:     body.relation_type ?? null,
          relationSubtype:  body.relation_subtype ?? null,
          origin:           body.origin ?? "local",
          createdAt:        now,
          updatedAt:        now,
        })
        .run();
      const [row] = db.select().from(contacts).where(eq(contacts.id, id)).limit(1).all();
      reply.code(201).send(serialize(row!));
    },
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/contacts/:id", {
    schema: {
      tags: ["contacts"],
      summary: "Update a contact",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: { contact: { type: "object", additionalProperties: true } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [existing] = db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, req.params.id), eq(contacts.userId, auth.userId)))
        .limit(1)
        .all();
      if (!existing) return reply.code(404).send({ error: "not_found" });
      // A card copied from the Mac is changed in the Mac's Contacts app.
      if (existing.source !== null) return reply.code(409).send({ error: "read_only", source: existing.source });

      const body = readBody(req.body);
      const next = {
        name:             body.name               !== undefined ? body.name : existing.name,
        firstName:        body.first_name         !== undefined ? body.first_name : existing.firstName,
        middleName:       body.middle_name        !== undefined ? body.middle_name : existing.middleName,
        lastName:         body.last_name          !== undefined ? body.last_name : existing.lastName,
        email:            body.email              !== undefined ? body.email : existing.email,
        phoneCountryCode: body.phone_country_code !== undefined ? body.phone_country_code : existing.phoneCountryCode,
        phoneNumber:      body.phone_number       !== undefined ? body.phone_number : existing.phoneNumber,
        relationType:     body.relation_type      !== undefined ? body.relation_type : existing.relationType,
        relationSubtype:  body.relation_subtype   !== undefined ? body.relation_subtype : existing.relationSubtype,
        origin:           body.origin             ?? existing.origin,
        updatedAt:        new Date(),
      };
      db.update(contacts).set(next).where(eq(contacts.id, existing.id)).run();
      const [row] = db.select().from(contacts).where(eq(contacts.id, existing.id)).limit(1).all();
      reply.send(serialize(row!));
    },
  });

  app.delete<{ Params: { id: string } }>("/contacts/:id", {
    schema: {
      tags: ["contacts"],
      summary: "Delete a contact",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const result = db
        .delete(contacts)
        .where(and(eq(contacts.id, req.params.id), eq(contacts.userId, auth.userId), isNull(contacts.source)))
        .run();
      if (result.changes === 0) return reply.code(404).send({ error: "not_found" });
      reply.code(204).send();
    },
  });
}
