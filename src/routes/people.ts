import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../auth.js";
import { requirePerson } from "./memories.js";
import { EntityError, ensureLinked, relinkMemories } from "../memory/entities.js";
import { listCandidates } from "../memory/learner.js";
import { RELATION_KINDS, KIND_GROUP, LANGUAGES } from "../people/kinship.js";
import {
  createPerson, ensurePeople, linkContact, mergePeople, PeopleError, PEOPLE_CANDIDATES, personDetail, listPeople, readLinks, readPersonInput,
  setLinks, splitPerson, unlinkContact, updatePerson,
} from "../people/people.js";
import { deleteEntity, findEntity } from "../memory/entities.js";

// /people — « Proches » (docs/people-design.md §7): the person's people
// with their relation to them, their links to one another, their contact
// cards, what Twoody knows of them and what comes next. Like /entities and
// /memories, the person's only: this server's owner or one of their own
// devices (requirePerson, sessionTrust.ts) — 403 person_device_required
// otherwise. The iPhone reads them through its computer (COMPUTER_PATHS).

const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];
const body = { type: "object", additionalProperties: true } as const;

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof PeopleError || err instanceof EntityError) {
    return reply.code(err.status).send({ error: err.code, ...(err instanceof EntityError && err.entityId ? { person_id: err.entityId } : {}) });
  }
  throw err;
}

/// The language a label is written in when the person picked a kind only.
function localeOf(req: FastifyRequest): string | null {
  const asked = (req.body as { locale?: unknown } | null)?.locale ?? (req.query as { locale?: unknown } | null)?.locale ?? req.headers["accept-language"];
  const code = typeof asked === "string" ? asked.split(/[,;-]/)[0]!.trim().toLowerCase() : "";
  return (LANGUAGES as readonly string[]).includes(code) ? code : null;
}

async function person(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const auth = await requireAuth(req, reply);
  if (!auth) return null;
  if (!(await requirePerson(req, reply, auth))) return null;
  return auth.userId;
}

export async function peopleRoutes(app: FastifyInstance) {
  app.get("/people", {
    schema: { tags: ["memories"], summary: "The user's people: their relation to the user, links, contact cards, birthday", security },
    handler: async (req, reply) => {
      const userId = await person(req, reply);
      if (!userId) return;
      ensureLinked(userId);
      ensurePeople(userId);
      const candidates = listCandidates(userId).filter((candidate) => (PEOPLE_CANDIDATES as readonly string[]).includes(candidate.type));
      reply.send({ ...listPeople(userId), candidates, kinds: RELATION_KINDS.map((kind) => ({ kind, group: KIND_GROUP[kind] })) });
    },
  });

  app.get<{ Params: { id: string } }>("/people/:id", {
    schema: { tags: ["memories"], summary: "One of the user's people, with their memories and coming events", security },
    handler: async (req, reply) => {
      const userId = await person(req, reply);
      if (!userId) return;
      ensureLinked(userId);
      const found = personDetail(userId, req.params.id);
      if (!found) return reply.code(404).send({ error: "not_found" });
      reply.send({ person: found });
    },
  });

  app.post<{ Body: unknown }>("/people", {
    schema: { tags: ["memories"], summary: "Add a person: {person: {name, relation?: {kind, label?}, aliases?, note?, contact_id?}}", security, body },
    handler: async (req, reply) => {
      const userId = await person(req, reply);
      if (!userId) return;
      try {
        const made = createPerson(userId, readPersonInput(req.body, true), localeOf(req));
        relinkMemories(userId);
        reply.code(201).send({ person: personDetail(userId, made.id) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/people/:id", {
    schema: { tags: ["memories"], summary: "Change a person: name, aliases, note, relation to the user ({kind, label} or null), contact_id to link", security, body },
    handler: async (req, reply) => {
      const userId = await person(req, reply);
      if (!userId) return;
      try {
        const changed = updatePerson(userId, req.params.id, readPersonInput(req.body, false), localeOf(req));
        relinkMemories(userId);
        reply.send({ person: personDetail(userId, changed.id) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/people/:id/links", {
    schema: { tags: ["memories"], summary: "Replace a person's links to others: {links: [{person: id or name, kind, label?, side: of|has}]}", security, body },
    handler: async (req, reply) => {
      const userId = await person(req, reply);
      if (!userId) return;
      try {
        setLinks(userId, req.params.id, readLinks(req.body), localeOf(req));
        relinkMemories(userId);
        reply.send({ person: personDetail(userId, req.params.id) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  app.post<{ Params: { id: string }; Body: { contact_id?: unknown } | null }>("/people/:id/contacts", {
    schema: { tags: ["memories"], summary: "Link a contact card to this person: {contact_id}", security, body },
    handler: async (req, reply) => {
      const userId = await person(req, reply);
      if (!userId) return;
      const contactId = typeof req.body?.contact_id === "string" ? req.body.contact_id : "";
      if (!contactId) return reply.code(422).send({ error: "invalid_contact" });
      try {
        linkContact(userId, req.params.id, contactId, "manual");
        reply.send({ person: personDetail(userId, req.params.id) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  app.delete<{ Params: { id: string; contactId: string } }>("/people/:id/contacts/:contactId", {
    schema: { tags: ["memories"], summary: "Unlink a contact card (never linked to them again on its own)", security },
    handler: async (req, reply) => {
      const userId = await person(req, reply);
      if (!userId) return;
      try {
        unlinkContact(userId, req.params.id, req.params.contactId);
        reply.send({ person: personDetail(userId, req.params.id) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  app.post<{ Params: { id: string }; Body: { into?: unknown } | null }>("/people/:id/merge", {
    schema: { tags: ["memories"], summary: "Merge this person into another ({into}): names become aliases, relations, memories and cards move", security, body },
    handler: async (req, reply) => {
      const userId = await person(req, reply);
      if (!userId) return;
      try {
        const into = mergePeople(userId, req.params.id, String(req.body?.into ?? ""));
        relinkMemories(userId);
        reply.send({ person: personDetail(userId, into.id) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  app.post<{ Params: { id: string }; Body: { alias?: unknown; contact_id?: unknown; merged_id?: unknown } | null }>("/people/:id/split", {
    schema: { tags: ["memories"], summary: "Split: one of their names ({alias}), cards ({contact_id}) or a merged person ({merged_id}) into a person of their own", security, body },
    handler: async (req, reply) => {
      const userId = await person(req, reply);
      if (!userId) return;
      const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
      try {
        const made = splitPerson(userId, req.params.id, { alias: text(req.body?.alias), contact_id: text(req.body?.contact_id), merged_id: text(req.body?.merged_id) });
        relinkMemories(userId);
        reply.code(201).send({ person: personDetail(userId, made.id) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  app.delete<{ Params: { id: string } }>("/people/:id", {
    schema: { tags: ["memories"], summary: "Remove a person from the graph (their memories stay)", security },
    handler: async (req, reply) => {
      const userId = await person(req, reply);
      if (!userId) return;
      if (findEntity(userId, req.params.id)?.kind === "self") return reply.code(422).send({ error: "self" });
      if (!deleteEntity(userId, req.params.id)) return reply.code(404).send({ error: "not_found" });
      relinkMemories(userId);
      reply.code(204).send();
    },
  });
}
