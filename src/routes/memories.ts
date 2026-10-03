import { applyDiscovery, discoverFromMemories, DiscoveryError, type Discovery } from "../memory/discover.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import { db, memories, sqlite } from "../db.js";
import { requireAuth } from "../auth.js";
import { ownerRequest } from "../localAccess.js";
import { isPersonOrOwner } from "../sessionTrust.js";
import { meshRoster } from "../vault/roster.js";
import { factsFromImport, importAccountMemories, importMemories, IMPORT_SOURCES, MAX_ACCOUNT_MEMORIES, type AccountMemory, type ImportSource } from "../memoryLearning.js";
import { memoryDeleted, memoryWritten, newMemoryId, possibleDuplicates } from "../vault/memories.js";
import { acceptCandidate, CandidateError, learnDiscussion, listCandidates, pendingDiscussions, rejectCandidate, takeMemoryNews, type LearnResult } from "../memory/learner.js";
import { dismissPair, similarMemories } from "../memory/similar.js";

// Cloud-shape /memories CRUD against the local SQLite store. Wire
// shape mirrors `app/views/memories/_memory.json.jbuilder` on Rails:
// top-level array on index, `{memory: ...}` payload on create/update,
// 204 on destroy. The iPhone's MemoriesScreen and the desktop's
// Memories tab can drive both backends without branching.
//
// `tags` is serialized as a JSON array on disk (`tags` column);
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
  // « À confirmer »: what the learner was not sure enough of to keep on its
  // own, a fact that changes a known one, anything sensitive
  // (src/memory/learner.ts).
  app.get("/memories/candidates", {
    schema: { tags: ["memories"], summary: "Facts learned from conversations, waiting for the person", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      reply.send({ candidates: listCandidates(auth.userId) });
    },
  });

  app.post<{ Params: { id: string }; Body: { content?: unknown } | null }>("/memories/candidates/:id/accept", {
    schema: { tags: ["memories"], summary: "Keep a learned fact, as proposed or corrected", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      const content = typeof req.body?.content === "string" ? req.body.content : null;
      try {
        const id = acceptCandidate(auth.userId, req.params.id, content);
        const [row] = db.select().from(memories).where(eq(memories.id, id)).limit(1).all();
        // A project kept (docs/projects-design.md): its id.
        const project = row ? null : (sqlite.prepare("SELECT id FROM projects WHERE id = ? AND user_id = ?").get(id, auth.userId) as { id: string } | undefined);
        reply.send({ memory: row ? serialize(row) : null, ...(project ? { project_id: project.id } : {}) });
      } catch (err) {
        if (err instanceof CandidateError) return reply.code(err.status).send({ error: err.code });
        throw err;
      }
    },
  });

  app.post<{ Params: { id: string } }>("/memories/candidates/:id/reject", {
    schema: { tags: ["memories"], summary: "Refuse a learned fact: never proposed again", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      try {
        rejectCandidate(auth.userId, req.params.id);
        reply.code(204).send();
      } catch (err) {
        if (err instanceof CandidateError) return reply.code(err.status).send({ error: err.code });
        throw err;
      }
    },
  });

  // What was learned from the conversations and not told yet: told once
  // (« Twoody a retenu 2 choses de votre conversation précédente »).
  app.get<{ Querystring: { except?: string } }>("/memories/news", {
    schema: { tags: ["memories"], summary: "What Twoody learned and has not said yet", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      const except = typeof req.query.except === "string" && req.query.except ? req.query.except : null;
      reply.send({ notices: takeMemoryNews(auth.userId, except), candidates: listCandidates(auth.userId).length });
    },
  });

  // After an import: the projects, people and dates its memories speak of,
  // proposed (memory/discover.ts) — made only once ticked (…/apply).
  app.post<{ Body: { memory_ids?: unknown } }>("/memories/discover", {
    schema: { tags: ["memories"], summary: "Projects, contacts and dates found in these memories", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      const ids = Array.isArray(req.body?.memory_ids) ? req.body.memory_ids.filter((id): id is string => typeof id === "string") : [];
      if (!ids.length) return reply.code(422).send({ error: "memory_ids_required" });
      try {
        reply.send(await discoverFromMemories(auth.userId, ids));
      } catch (err) {
        if (err instanceof DiscoveryError) return reply.code(err.code === "no_model" ? 503 : 422).send({ error: err.code });
        throw err;
      }
    },
  });

  app.post<{ Body: Partial<Discovery> }>("/memories/discover/apply", {
    schema: { tags: ["memories"], summary: "Make the projects, contacts and dates the person ticked", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      const made = applyDiscovery(auth.userId, req.body ?? {});
      reply.code(201).send({ projects: made.projects.length, contacts: made.contacts.length, events: made.events.length });
    },
  });

  // « Doublons possibles » (src/memory/similar.ts).
  app.get("/memories/similar", {
    schema: { tags: ["memories"], summary: "Pairs of memories that say much the same", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      reply.send({ pairs: similarMemories(auth.userId) });
    },
  });

  app.post<{ Body: { ids?: unknown } | null }>("/memories/similar/dismiss", {
    schema: { tags: ["memories"], summary: "These two memories differ: never shown as a pair again", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      const ids = Array.isArray(req.body?.ids) ? req.body!.ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64) : [];
      if (ids.length !== 2 || ids[0] === ids[1]) return reply.code(422).send({ error: "two_ids_required" });
      dismissPair(auth.userId, ids[0]!, ids[1]!);
      reply.code(204).send();
    },
  });

  // Learn now from one conversation, or from every one with something new,
  // without waiting for them to be idle (the memory bench; a client that
  // closes a conversation).
  app.post<{ Body: { discussion_id?: unknown } | null }>("/memories/learn", {
    schema: { tags: ["memories"], summary: "Learn now from what was said in conversations", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      const wanted = typeof req.body?.discussion_id === "string" ? req.body.discussion_id : null;
      if (wanted && !sqlite.prepare("SELECT 1 FROM discussions WHERE id = ? AND user_id = ?").get(wanted, auth.userId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const ids = wanted ? [wanted] : pendingDiscussions({ userId: auth.userId, idleMs: 0, limit: 20 });
      const results: LearnResult[] = [];
      try {
        for (const id of ids) {
          const result = await learnDiscussion(id);
          if (result) results.push(result);
        }
      } catch (err) {
        return reply.code(503).send({ error: "learning_failed", message: err instanceof Error ? err.message : String(err), results });
      }
      reply.send({ results });
    },
  });

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
        // Newest first, by when it was learned or written: an import keeps
        // each memory's own date.
        .orderBy(desc(memories.createdAt), desc(memories.updatedAt))
        .limit(1000)
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
