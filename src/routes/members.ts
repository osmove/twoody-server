import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  db,
  faceEmbeddings,
  members,
  voiceProfiles,
  wakeWordSamples,
} from "../db.js";
import { generateId, requireAuth } from "../auth.js";
import { listMembers } from "../tools.js";

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 64);
}

export async function memberRoutes(app: FastifyInstance) {
  app.get("/members", {
    schema: {
      tags: ["members"],
      summary: "List household members",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send({ members: await listMembers(auth.userId) });
    },
  });

  app.get<{ Params: { id: string } }>("/members/:id", {
    schema: {
      tags: ["members"],
      summary: "Fetch one household member",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const rows = await listMembers(auth.userId);
      const member = rows.find((row) => row.id === req.params.id);
      if (!member) return reply.code(404).send({ error: "Member not found" });
      reply.send({ member });
    },
  });

  app.post<{
    Body: { member: { name: string; relationship?: string; email?: string; slug?: string; enrollment_state?: Record<string, unknown> } };
  }>("/members", {
    schema: {
      tags: ["members"],
      summary: "Create a household member",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const payload = req.body?.member;
      if (!payload?.name?.trim()) {
        return reply.code(422).send({ error: "member.name is required" });
      }

      const now = new Date();
      const id = generateId();
      db.insert(members)
        .values({
          id,
          userId: auth.userId,
          name: payload.name.trim(),
          relationship: payload.relationship ?? null,
          slug: payload.slug?.trim() || slugify(payload.name),
          email: payload.email ?? null,
          enrollmentState: JSON.stringify(payload.enrollment_state ?? {}),
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const rows = await listMembers(auth.userId);
      reply.code(201).send({ member: rows.find((row) => row.id === id) });
    },
  });

  app.patch<{
    Params: { id: string };
    Body: { member: { name?: string; relationship?: string; email?: string; enrollment_state?: Record<string, unknown> } };
  }>("/members/:id", {
    schema: {
      tags: ["members"],
      summary: "Update a household member",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const existing = db.select().from(members).where(eq(members.id, req.params.id)).get();
      if (!existing || existing.userId !== auth.userId) {
        return reply.code(404).send({ error: "Member not found" });
      }

      const payload = req.body?.member ?? {};
      const enrollmentState = payload.enrollment_state
        ? JSON.stringify({
            ...JSON.parse(existing.enrollmentState || "{}"),
            ...payload.enrollment_state,
          })
        : existing.enrollmentState;

      db.update(members)
        .set({
          name: payload.name?.trim() || existing.name,
          relationship:
            payload.relationship === undefined ? existing.relationship : payload.relationship,
          email: payload.email === undefined ? existing.email : payload.email,
          enrollmentState,
          updatedAt: new Date(),
        })
        .where(eq(members.id, req.params.id))
        .run();

      const rows = await listMembers(auth.userId);
      reply.send({ member: rows.find((row) => row.id === req.params.id) });
    },
  });

  app.delete<{ Params: { id: string } }>("/members/:id", {
    schema: {
      tags: ["members"],
      summary: "Delete a household member",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const existing = db.select().from(members).where(eq(members.id, req.params.id)).get();
      if (!existing || existing.userId !== auth.userId) {
        return reply.code(404).send({ error: "Member not found" });
      }

      db.delete(wakeWordSamples).where(eq(wakeWordSamples.memberId, req.params.id)).run();
      db.delete(voiceProfiles).where(eq(voiceProfiles.memberId, req.params.id)).run();
      db.delete(faceEmbeddings).where(eq(faceEmbeddings.memberId, req.params.id)).run();
      db.delete(members).where(eq(members.id, req.params.id)).run();
      reply.code(204).send();
    },
  });

  app.get<{ Params: { member_id: string } }>("/members/:member_id/wake_word_samples", {
    schema: {
      tags: ["members"],
      summary: "List wake-word samples for a member",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const member = db.select().from(members).where(eq(members.id, req.params.member_id)).get();
      if (!member || member.userId !== auth.userId) return reply.code(404).send({ error: "Member not found" });
      const samples = db.select().from(wakeWordSamples).where(eq(wakeWordSamples.memberId, member.id)).all();
      reply.send({ wake_word_samples: samples });
    },
  });

  app.post<{
    Params: { member_id: string };
    Body: { word: string; prefix?: string; filename?: string; content_type?: string; audio_base64?: string; duration_ms?: number; sample_rate?: number; source?: string };
  }>("/members/:member_id/wake_word_samples", {
    schema: {
      tags: ["members"],
      summary: "Create a wake-word sample",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const member = db.select().from(members).where(eq(members.id, req.params.member_id)).get();
      if (!member || member.userId !== auth.userId) return reply.code(404).send({ error: "Member not found" });

      const id = generateId();
      db.insert(wakeWordSamples)
        .values({
          id,
          memberId: member.id,
          word: req.body.word,
          prefix: req.body.prefix ?? null,
          filename: req.body.filename ?? null,
          contentType: req.body.content_type ?? null,
          audioBase64: req.body.audio_base64 ?? null,
          durationMs: req.body.duration_ms ?? null,
          sampleRate: req.body.sample_rate ?? null,
          source: req.body.source ?? "app",
          createdAt: new Date(),
        })
        .run();

      const sample = db.select().from(wakeWordSamples).where(eq(wakeWordSamples.id, id)).get();
      reply.code(201).send({ wake_word_sample: sample });
    },
  });

  app.delete<{ Params: { member_id: string; id: string } }>("/members/:member_id/wake_word_samples/:id", {
    schema: {
      tags: ["members"],
      summary: "Delete a wake-word sample",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const member = db.select().from(members).where(eq(members.id, req.params.member_id)).get();
      if (!member || member.userId !== auth.userId) return reply.code(404).send({ error: "Member not found" });
      db.delete(wakeWordSamples).where(eq(wakeWordSamples.id, req.params.id)).run();
      reply.code(204).send();
    },
  });

  app.get<{ Params: { member_id: string } }>("/members/:member_id/voice_profile", {
    schema: {
      tags: ["members"],
      summary: "Get a member voice profile",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const member = db.select().from(members).where(eq(members.id, req.params.member_id)).get();
      if (!member || member.userId !== auth.userId) return reply.code(404).send({ error: "Member not found" });
      const profile = db.select().from(voiceProfiles).where(eq(voiceProfiles.memberId, member.id)).get();
      if (!profile) return reply.code(404).send({ error: "Voice profile not found" });
      reply.send({ voice_profile: profile });
    },
  });

  app.patch<{
    Params: { member_id: string };
    Body: { method?: string; source?: string; filename?: string; content_type?: string; file_base64?: string };
  }>("/members/:member_id/voice_profile", {
    schema: {
      tags: ["members"],
      summary: "Create or update a member voice profile",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const member = db.select().from(members).where(eq(members.id, req.params.member_id)).get();
      if (!member || member.userId !== auth.userId) return reply.code(404).send({ error: "Member not found" });

      const existing = db.select().from(voiceProfiles).where(eq(voiceProfiles.memberId, member.id)).get();
      const now = new Date();
      const values = {
        id: existing?.id ?? generateId(),
        memberId: member.id,
        method: req.body.method ?? existing?.method ?? "raw",
        source: req.body.source ?? existing?.source ?? "app",
        filename: req.body.filename ?? existing?.filename ?? null,
        contentType: req.body.content_type ?? existing?.contentType ?? null,
        fileBase64: req.body.file_base64 ?? existing?.fileBase64 ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      if (existing) {
        db.update(voiceProfiles).set(values).where(eq(voiceProfiles.id, existing.id)).run();
      } else {
        db.insert(voiceProfiles).values(values).run();
      }

      reply.send({
        voice_profile: db.select().from(voiceProfiles).where(eq(voiceProfiles.memberId, member.id)).get(),
      });
    },
  });

  app.delete<{ Params: { member_id: string } }>("/members/:member_id/voice_profile", {
    schema: {
      tags: ["members"],
      summary: "Delete a member voice profile",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const member = db.select().from(members).where(eq(members.id, req.params.member_id)).get();
      if (!member || member.userId !== auth.userId) return reply.code(404).send({ error: "Member not found" });
      db.delete(voiceProfiles).where(eq(voiceProfiles.memberId, member.id)).run();
      reply.code(204).send();
    },
  });

  app.get<{ Params: { member_id: string } }>("/members/:member_id/face_embedding", {
    schema: {
      tags: ["members"],
      summary: "Get a member face embedding",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const member = db.select().from(members).where(eq(members.id, req.params.member_id)).get();
      if (!member || member.userId !== auth.userId) return reply.code(404).send({ error: "Member not found" });
      const face = db.select().from(faceEmbeddings).where(eq(faceEmbeddings.memberId, member.id)).get();
      if (!face) return reply.code(404).send({ error: "Face embedding not found" });
      reply.send({ face_embedding: { ...face, embedding: face.embeddingJson ? JSON.parse(face.embeddingJson) : null } });
    },
  });

  app.patch<{
    Params: { member_id: string };
    Body: { model?: string; source?: string; filename?: string; content_type?: string; image_base64?: string; embedding?: number[] | string };
  }>("/members/:member_id/face_embedding", {
    schema: {
      tags: ["members"],
      summary: "Create or update a member face embedding",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const member = db.select().from(members).where(eq(members.id, req.params.member_id)).get();
      if (!member || member.userId !== auth.userId) return reply.code(404).send({ error: "Member not found" });

      const existing = db.select().from(faceEmbeddings).where(eq(faceEmbeddings.memberId, member.id)).get();
      const now = new Date();
      const embedding =
        req.body.embedding === undefined
          ? existing?.embeddingJson ?? null
          : typeof req.body.embedding === "string"
            ? req.body.embedding
            : JSON.stringify(req.body.embedding);

      const values = {
        id: existing?.id ?? generateId(),
        memberId: member.id,
        model: req.body.model ?? existing?.model ?? "insightface",
        source: req.body.source ?? existing?.source ?? "app",
        imageBase64: req.body.image_base64 ?? existing?.imageBase64 ?? null,
        embeddingJson: embedding,
        filename: req.body.filename ?? existing?.filename ?? null,
        contentType: req.body.content_type ?? existing?.contentType ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      if (existing) {
        db.update(faceEmbeddings).set(values).where(eq(faceEmbeddings.id, existing.id)).run();
      } else {
        db.insert(faceEmbeddings).values(values).run();
      }

      const face = db.select().from(faceEmbeddings).where(eq(faceEmbeddings.memberId, member.id)).get();
      reply.send({ face_embedding: { ...face, embedding: face?.embeddingJson ? JSON.parse(face.embeddingJson) : null } });
    },
  });

  app.delete<{ Params: { member_id: string } }>("/members/:member_id/face_embedding", {
    schema: {
      tags: ["members"],
      summary: "Delete a member face embedding",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const member = db.select().from(members).where(eq(members.id, req.params.member_id)).get();
      if (!member || member.userId !== auth.userId) return reply.code(404).send({ error: "Member not found" });
      db.delete(faceEmbeddings).where(eq(faceEmbeddings.memberId, member.id)).run();
      reply.code(204).send();
    },
  });
}
