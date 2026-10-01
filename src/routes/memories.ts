import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import { db, memories } from "../db.js";
import { requireAuth } from "../auth.js";
import { ownerRequest } from "../localAccess.js";
import { isPersonOrOwner } from "../sessionTrust.js";
import { meshRoster } from "../vault/roster.js";
import { factsFromImport, importAccountMemories, importMemories, IMPORT_SOURCES, MAX_ACCOUNT_MEMORIES, type AccountMemory, type ImportSource } from "../memoryLearning.js";
import { memoryDeleted, memoryWritten, newMemoryId, possibleDuplicates } from "../vault/memories.js";

// Cloud-shape /memories CRUD against the local SQLite store. Wire
// shape mirrors `app/views/memories/_memory.json.jbuilder` on Rails:
// top-level array on index, `{memory: ...}` payload on create/update,
// 204 on destroy. The iPhone's MemoriesScreen and the desktop's
// Memories tab can drive both backends without branching.
//
// `tags` is serialized as a JSON array on disk (`tags_json` column);
// over the wire we expose it as `tags: string[]` so the cloud
// jbuilder shape is preserved.

interface MemoryRow {
  id:                string;
  user_id:           string;
  kind:              string;
  title:             string | null;
  content:           string;
  tags:              string[];
  source:            string;
  source_ref:        string | null;
  entity_type:       string | null;
  entity_id:         string | null;
  superseded_by_id:  string | null;
  created_at:        string;
  updated_at:        string;
}

const KINDS = new Set(["user", "feedback", "project", "reference"]);

/// The memories are the person's, and every one written here goes to every
/// computer of the vault: reading them or writing one is for this server's
/// owner (its session, this machine) or one of the person's own devices
/// (sessionTrust.ts: one that sent a device-access its vault person device
/// signed, however it was paired) — not a household member's phone, a
/// device paired by code that is no member of the history, one the console
/// approved or a firmware device. Replies 403 otherwise (the app then signs
/// a fresh device-access, POST /session/device-access).
export async function requirePerson(req: FastifyRequest, reply: FastifyReply, auth: { sessionId?: string }): Promise<boolean> {
  if (ownerRequest(req) || (await isPersonOrOwner(req, auth, () => meshRoster().get()))) return true;
  reply.code(403).send({ error: "person_device_required" });
  return false;
}

function serialize(row: typeof memories.$inferSelect): MemoryRow {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tagsJson);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    /* fall through to empty list — corrupted row shouldn't crash list */
  }
  return {
    id:               row.id,
    user_id:          row.userId,
    kind:             row.kind,
    title:            row.title,
    content:          row.content,
    tags,
    source:           row.source,
    source_ref:       row.sourceRef,
    entity_type:      row.entityType,
    entity_id:        row.entityId,
    superseded_by_id: row.supersededById,
    created_at:       row.createdAt.toISOString(),
    updated_at:       row.updatedAt.toISOString(),
  };
}

function readBody(raw: unknown): {
  kind?:        string;
  title?:       string | null;
  content?:     string;
  tags?:        string[];
  source?:      string;
  source_ref?:  string | null;
  entity_type?: string | null;
  entity_id?:   string | null;
} {
  const body = (raw as { memory?: Record<string, unknown> } | null)?.memory ?? {};
  const out: Record<string, unknown> = {};
  if (typeof body.kind === "string" && KINDS.has(body.kind)) out.kind = body.kind;
  if (typeof body.title === "string" || body.title === null) out.title = body.title;
  if (typeof body.content === "string") out.content = body.content;
  if (Array.isArray(body.tags)) {
    out.tags = body.tags.filter((t): t is string => typeof t === "string");
  }
  if (typeof body.source === "string") out.source = body.source;
  if (typeof body.source_ref === "string" || body.source_ref === null) out.source_ref = body.source_ref;
  if (typeof body.entity_type === "string" || body.entity_type === null) out.entity_type = body.entity_type;
  if (typeof body.entity_id === "string" || body.entity_id === null) out.entity_id = body.entity_id;
  return out as ReturnType<typeof readBody>;
}

export async function memoryRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      q?:                  string;
      kind?:               string;
      include_superseded?: string;
      entity_type?:        string;
      entity_id?:          string;
    };
  }>("/memories", {
    schema: {
      tags: ["memories"],
      summary: "List the current user's memories",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      const { q, kind, include_superseded, entity_type, entity_id } = req.query;

      const filters = [eq(memories.userId, auth.userId)];
      if (kind && KINDS.has(kind)) filters.push(eq(memories.kind, kind));
      if (include_superseded !== "1" && include_superseded !== "true") {
        filters.push(isNull(memories.supersededById));
      }
      if (entity_type && entity_id) {
        filters.push(eq(memories.entityType, entity_type));
        filters.push(eq(memories.entityId, entity_id));
      }
      if (q && q.trim()) {
        const pat = `%${q.trim()}%`;
        const text = or(like(memories.title, pat), like(memories.content, pat));
        if (text) filters.push(text);
      }

      const rows = db
        .select()
        .from(memories)
        .where(and(...filters))
        .orderBy(desc(memories.updatedAt), desc(memories.createdAt))
        .limit(200)
        .all();

      reply.send(rows.map(serialize));
    },
  });

  /// « Doublons possibles »: memories sharing a title whose contents
  /// differ — typically the same thing written on two computers before
  /// they shared their memories (src/vault/memories.ts). The screens show
  /// them side by side; the person keeps, edits or deletes.
  app.get("/memories/duplicates", {
    schema: {
      tags: ["memories"],
      summary: "Possible duplicates: memories with the same title and different contents",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      const groups = possibleDuplicates(auth.userId);
      const ids = groups.flatMap((g) => g.memory_ids);
      const rows = ids.length ? db.select().from(memories).where(inArray(memories.id, ids)).all() : [];
      const byId = new Map(rows.map((row) => [row.id, serialize(row)]));
      reply.send({
        groups: groups.map((g) => ({ title: g.title, memories: g.memory_ids.map((id) => byId.get(id)).filter((m): m is MemoryRow => !!m) })),
      });
    },
  });

  app.get<{ Params: { id: string } }>("/memories/:id", {
    schema: {
      tags: ["memories"],
      summary: "Show a single memory",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      const [row] = db
        .select()
        .from(memories)
        .where(and(eq(memories.id, req.params.id), eq(memories.userId, auth.userId)))
        .limit(1)
        .all();
      if (!row) return reply.code(404).send({ error: "not_found" });
      reply.send(serialize(row));
    },
  });

  app.post<{ Body: unknown }>("/memories", {
    schema: {
      tags: ["memories"],
      summary: "Create a new memory",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: {
          memory: { type: "object", additionalProperties: true },
        },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      const body = readBody(req.body);
      const content = (body.content ?? "").trim();
      if (!content) {
        return reply.code(422).send({ errors: ["content can't be blank"] });
      }
      const now = new Date();
      const created = newMemoryId();
      db.insert(memories)
        .values({
          id:            created,
          userId:        auth.userId,
          kind:          body.kind ?? "user",
          title:         body.title ?? null,
          content,
          tagsJson:      JSON.stringify(body.tags ?? []),
          source:        body.source ?? "manual",
          sourceRef:     body.source_ref ?? null,
          entityType:    body.entity_type ?? null,
          entityId:      body.entity_id ?? null,
          createdAt:     now,
          updatedAt:     now,
        })
        .run();
      // Through the vault too, when this computer is a trusted member.
      const id = memoryWritten(created);
      const [row] = db.select().from(memories).where(eq(memories.id, id)).limit(1).all();
      reply.code(201).send(serialize(row!));
    },
  });

  /// What another assistant knows of the person, pasted back after the
  /// prompt the Memories screens give (src/memoryLearning.ts): each fact
  /// becomes a memory, the known ones left out, and the whole answer is kept.
  /// With `source: "account"` and `memories`, the memories of the Twoody
  /// account instead, one each (importAccountMemories): no answer to keep.
  app.post<{ Body: { text?: unknown; source?: unknown; memories?: unknown } }>("/memories/import", {
    schema: { tags: ["memories"], summary: "Import what another assistant knows of the user", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      if (req.body?.source === "account") {
        const items = Array.isArray(req.body.memories) ? (req.body.memories as AccountMemory[]) : [];
        if (items.length === 0) return reply.code(400).send({ error: "empty" });
        if (items.length > MAX_ACCOUNT_MEMORIES) return reply.code(413).send({ error: "too_many", max: MAX_ACCOUNT_MEMORIES });
        const { ids, skipped } = importAccountMemories(auth.userId, items);
        const rows = ids.length ? db.select().from(memories).where(inArray(memories.id, ids)).all() : [];
        return reply.code(201).send({ imported: ids.length, skipped, memories: rows.map(serialize) });
      }
      const text = typeof req.body?.text === "string" ? req.body.text : "";
      if (factsFromImport(text).length === 0) return reply.code(400).send({ error: "empty" });
      const source = (IMPORT_SOURCES as readonly string[]).includes(String(req.body?.source)) ? (req.body!.source as ImportSource) : "other";
      const { ids, skipped, archiveId } = importMemories(auth.userId, text, source);
      const rows = ids.length ? db.select().from(memories).where(inArray(memories.id, ids)).all() : [];
      reply.code(201).send({ imported: ids.length, skipped, memories: rows.map(serialize), archive_id: archiveId });
    },
  });

  /// PATCH accepts `{memory: {...}}` like Rails. Only the fields the
  /// caller sends are updated — others stay as they are. Tags is a
  /// full replacement when present (matches Rails behaviour for an
  /// array-typed permitted attribute).
  app.patch<{ Params: { id: string }; Body: unknown }>("/memories/:id", {
    schema: {
      tags: ["memories"],
      summary: "Update an existing memory",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: {
          memory: { type: "object", additionalProperties: true },
        },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      const [existing] = db
        .select()
        .from(memories)
        .where(and(eq(memories.id, req.params.id), eq(memories.userId, auth.userId)))
        .limit(1)
        .all();
      if (!existing) return reply.code(404).send({ error: "not_found" });

      const body = readBody(req.body);
      const next = {
        kind:          body.kind          ?? existing.kind,
        title:         body.title         !== undefined ? body.title : existing.title,
        content:       body.content       ?? existing.content,
        tagsJson:      body.tags          ? JSON.stringify(body.tags) : existing.tagsJson,
        source:        body.source        ?? existing.source,
        sourceRef:     body.source_ref    !== undefined ? body.source_ref : existing.sourceRef,
        entityType:    body.entity_type   !== undefined ? body.entity_type : existing.entityType,
        entityId:      body.entity_id     !== undefined ? body.entity_id : existing.entityId,
        updatedAt:     new Date(),
      };
      db.update(memories).set(next).where(eq(memories.id, existing.id)).run();
      const id = memoryWritten(existing.id, "edit");
      const [row] = db.select().from(memories).where(eq(memories.id, id)).limit(1).all();
      reply.send(serialize(row!));
    },
  });

  app.delete<{ Params: { id: string } }>("/memories/:id", {
    schema: {
      tags: ["memories"],
      summary: "Delete a memory",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      // A deletion goes to every computer of the vault and forbids the fact
      // for good: only this server's owner or one of the person's own
      // devices (requirePerson above).
      if (!(await requirePerson(req, reply, auth))) return;
      const [existing] = db.select().from(memories).where(and(eq(memories.id, req.params.id), eq(memories.userId, auth.userId))).limit(1).all();
      const result = db
        .delete(memories)
        .where(and(eq(memories.id, req.params.id), eq(memories.userId, auth.userId)))
        .run();
      if (result.changes === 0 || !existing) return reply.code(404).send({ error: "not_found" });
      // Deleted on every computer of the vault, and never learned again.
      memoryDeleted({ id: existing.id, content: existing.content, vaultEventId: existing.vaultEventId, userId: existing.userId });
      reply.code(204).send();
    },
  });
}
