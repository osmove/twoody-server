import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { requirePerson } from "./memories.js";
import {
  aliasesOf, createEntity, deleteEntity, ensureLinked, EntityError, findEntity, listEntities, memoryIdsOf, mergeEntities,
  readEntityInput, relatedFrom, relationsOf, relinkMemories, updateEntity, type EntityRow,
} from "../memory/entities.js";

// /entities (docs/memory-v2-design.md §2, lot L2): the people, projects and
// places of the person's memories, their other names, how they relate, and
// « Fusionner » for two that are one. Like the memories, they are the
// person's: this server's owner or one of the person's own devices only
// (requirePerson, sessionTrust.ts) — 403 person_device_required otherwise.
//
// Wire shape, like /memories: a top-level array on index, `{entity: …}` in
// and out on create/update, 204 on delete.

function serialize(row: EntityRow, withMemories = false) {
  const memoryIds = memoryIdsOf(row.id);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    note: row.note,
    source: row.source,
    aliases: aliasesOf(row.id),
    relations: relationsOf(row.id),
    related_from: relatedFrom(row.id),
    merged_into: row.merged_into,
    memory_count: memoryIds.length,
    ...(withMemories ? { memory_ids: memoryIds } : {}),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof EntityError) return reply.code(err.status).send({ error: err.code, ...(err.entityId ? { entity_id: err.entityId } : {}) });
  throw err;
}

const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

export async function entityRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { include_merged?: string } }>("/entities", {
    schema: { tags: ["memories"], summary: "List the people, projects and places of the user's memories", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      ensureLinked(auth.userId);
      const merged = req.query.include_merged === "1" || req.query.include_merged === "true";
      reply.send(listEntities(auth.userId, merged).map((row) => serialize(row)));
    },
  });

  app.get<{ Params: { id: string } }>("/entities/:id", {
    schema: { tags: ["memories"], summary: "Show an entity, with the memories that name it", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      ensureLinked(auth.userId);
      const row = findEntity(auth.userId, req.params.id);
      if (!row) return reply.code(404).send({ error: "not_found" });
      reply.send(serialize(row, true));
    },
  });

  app.post<{ Body: unknown }>("/entities", {
    schema: {
      tags: ["memories"],
      summary: "Create an entity: {entity: {kind, name, note?, aliases?, relations?: [{to: id or name, label}]}}",
      security,
      body: { type: "object", properties: { entity: { type: "object", additionalProperties: true } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      try {
        const { entity, created } = createEntity(auth.userId, readEntityInput(req.body, true));
        relinkMemories(auth.userId);
        reply.code(created ? 201 : 200).send({ entity: serialize(entity) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/entities/:id", {
    schema: {
      tags: ["memories"],
      summary: "Update an entity: the fields given; aliases and relations are replaced whole",
      security,
      body: { type: "object", properties: { entity: { type: "object", additionalProperties: true } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      try {
        const entity = updateEntity(auth.userId, req.params.id, readEntityInput(req.body, false));
        relinkMemories(auth.userId);
        reply.send({ entity: serialize(entity) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  app.delete<{ Params: { id: string } }>("/entities/:id", {
    schema: { tags: ["memories"], summary: "Delete an entity, its other names and relations (its memories stay)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      if (!deleteEntity(auth.userId, req.params.id)) return reply.code(404).send({ error: "not_found" });
      relinkMemories(auth.userId);
      reply.code(204).send();
    },
  });

  app.post<{ Params: { id: string }; Body: { into?: unknown } }>("/entities/:id/merge", {
    schema: {
      tags: ["memories"],
      summary: "Merge this entity into another ({into: id}): its names become aliases there, its relations and memories move",
      security,
      body: { type: "object", required: ["into"], properties: { into: { type: "string" } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      try {
        const into = mergeEntities(auth.userId, req.params.id, String(req.body?.into ?? ""));
        relinkMemories(auth.userId);
        reply.send({ entity: serialize(into) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });
}
