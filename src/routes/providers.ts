import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { db, providers } from "../db.js";
import { generateId, requireAuth } from "../auth.js";
import { offeredModels, probeRuntime } from "../localRuntime.js";
import { listComputers } from "../router/index.js";
import { activeEngine, engine, engineDefaultModel, engineName } from "../engine.js";

type ProviderPatchBody = {
  name?: string;
  url?: string;
  base_url?: string;
  model?: string;
  enabled?: boolean;
};

function serializeProvider(provider: typeof providers.$inferSelect) {
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    base_url: provider.baseUrl,
    model: provider.model,
    enabled: provider.enabled,
    is_default: provider.isDefault,
    created_at: provider.createdAt.toISOString(),
    updated_at: provider.updatedAt.toISOString(),
  };
}

function normalizeProviderUrl(value: string): string | null {
  const normalized = value.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return normalized;
  } catch {
    return null;
  }
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/// This computer's engine (« Moteur », engine.ts) as a provider that is not
/// stored: `id: "engine"`, which /queries takes as `provider: "engine"`. Its
/// address is not given (the built-in runtime's is a loopback port with a
/// key). Left out when the Desktop runs the runtime, when no engine is
/// resolved, and when a stored provider already points at it.
async function engineProvider(stored: Array<typeof providers.$inferSelect>) {
  if (engine().managedByDesktop) return null;
  const resolved = await activeEngine();
  if (!resolved.id || !resolved.baseUrl) return null;
  const base = resolved.baseUrl.replace(/\/+$/, "");
  if (stored.some((p) => p.enabled && p.baseUrl?.replace(/\/+$/, "") === base)) return null;
  const available = resolved.reason === "preference" || resolved.reason === "auto";
  return {
    id: "engine",
    kind: "local_openai",
    name: engineName(resolved.id),
    engine: resolved.id,
    stored: false,
    base_url: null,
    model: engineDefaultModel(resolved),
    enabled: true,
    is_default: !stored.some((p) => p.enabled && p.isDefault),
    created_at: null,
    updated_at: null,
    status: { available, latency_ms: null, checked_at: new Date().toISOString(), reason: resolved.reason },
    models: resolved.models,
  };
}

export async function providerRoutes(app: FastifyInstance) {
  app.get("/providers", {
    schema: {
      tags: ["providers"],
      summary: "List configured LLM providers",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const rows = db
        .select()
        .from(providers)
        .where(eq(providers.userId, auth.userId))
        .all();

      // One question to each runtime gives both its status and every
      // model it holds — which a paired phone offers in its picker.
      const serialized = await Promise.all(
        rows.map(async (provider) => {
          if (!(provider.enabled && provider.kind === "local_openai" && provider.baseUrl)) {
            const status = { available: provider.enabled, latency_ms: null, checked_at: new Date().toISOString() };
            return { ...serializeProvider(provider), status, models: provider.model ? [provider.model] : [] };
          }
          // Refused in local-only mode (a public address): unavailable.
          const probe = await probeRuntime(provider.baseUrl, { fresh: true }).catch(() => null);
          if (!probe) {
            const status = { available: false, latency_ms: null, checked_at: new Date().toISOString() };
            return { ...serializeProvider(provider), status, models: provider.model ? [provider.model] : [] };
          }
          const status = { available: probe.ok, latency_ms: probe.latency_ms, checked_at: probe.checked_at };
          return { ...serializeProvider(provider), status, models: offeredModels(provider.model, probe) };
        })
      );

      // The account's computers, when this server knows its account: the
      // picker's « Automatique » (provider "auto") and one section per
      // computer (provider "computer:<id>"). Absent, the clients behave as
      // before.
      const computers = await listComputers(auth.userId).catch(() => null);
      const fromEngine = await engineProvider(rows).catch(() => null);
      const listed = fromEngine ? (fromEngine.is_default ? [fromEngine, ...serialized] : [...serialized, fromEngine]) : serialized;
      reply.send({ providers: listed, ...(computers ? { auto: true, computers } : {}) });
    },
  });

  app.post<{
    Body: { url?: string; base_url?: string; model?: string; name?: string };
  }>("/providers/local", {
    schema: {
      tags: ["providers"],
      summary: "Add a local OpenAI-compatible provider",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const baseUrl = normalizeProviderUrl(req.body.base_url ?? req.body.url ?? "");
      const model = nonEmpty(req.body.model);
      const name = nonEmpty(req.body.name) || "Local LLM";

      if (!baseUrl || !model) {
        return reply.code(422).send({ error: "url and model are required" });
      }

      const duplicate = db
        .select({ id: providers.id })
        .from(providers)
        .where(and(eq(providers.userId, auth.userId), eq(providers.baseUrl, baseUrl), eq(providers.model, model)))
        .limit(1)
        .all();
      if (duplicate.length > 0) {
        return reply.code(409).send({ error: "provider_already_exists" });
      }

      const existing = db
        .select({ id: providers.id })
        .from(providers)
        .where(eq(providers.userId, auth.userId))
        .limit(1)
        .all();

      const now = new Date();
      const id = generateId();
      db.insert(providers)
        .values({
          id,
          userId: auth.userId,
          kind: "local_openai",
          name,
          baseUrl,
          model,
          enabled: true,
          isDefault: existing.length === 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const [provider] = db
        .select()
        .from(providers)
        .where(eq(providers.id, id))
        .limit(1)
        .all();

      reply.code(201).send({ provider: serializeProvider(provider!) });
    },
  });

  app.patch<{ Params: { id: string }; Body: ProviderPatchBody }>(
    "/providers/:id",
    {
      schema: {
        tags: ["providers"],
        summary: "Update a provider",
        security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      },
      handler: async (req, reply) => {
        const auth = await requireAuth(req, reply);
        if (!auth) return;

        const [provider] = db
          .select()
          .from(providers)
          .where(and(eq(providers.id, req.params.id), eq(providers.userId, auth.userId)))
          .limit(1)
          .all();

        if (!provider) return reply.code(404).send({ error: "provider_not_found" });

        const updates: Partial<typeof providers.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (req.body.name !== undefined) {
          const name = nonEmpty(req.body.name);
          if (!name) return reply.code(422).send({ error: "name cannot be empty" });
          updates.name = name;
        }
        if (req.body.model !== undefined) {
          const model = nonEmpty(req.body.model);
          if (!model) return reply.code(422).send({ error: "model cannot be empty" });
          updates.model = model;
        }
        if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
        if (req.body.url !== undefined || req.body.base_url !== undefined) {
          const baseUrl = normalizeProviderUrl(req.body.base_url ?? req.body.url ?? "");
          if (!baseUrl) return reply.code(422).send({ error: "url must be http or https" });
          updates.baseUrl = baseUrl;
        }

        db.update(providers)
          .set(updates)
          .where(eq(providers.id, provider.id))
          .run();

        const [updated] = db
          .select()
          .from(providers)
          .where(eq(providers.id, provider.id))
          .limit(1)
          .all();

        reply.send({ provider: serializeProvider(updated!) });
      },
    }
  );

  app.post<{ Params: { id: string } }>("/providers/:id/default", {
    schema: {
      tags: ["providers"],
      summary: "Set the default LLM provider",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const [provider] = db
        .select()
        .from(providers)
        .where(and(eq(providers.id, req.params.id), eq(providers.userId, auth.userId)))
        .limit(1)
        .all();

      if (!provider) return reply.code(404).send({ error: "provider_not_found" });

      db.update(providers)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(providers.userId, auth.userId))
        .run();
      db.update(providers)
        .set({ isDefault: true, enabled: true, updatedAt: new Date() })
        .where(eq(providers.id, provider.id))
        .run();

      reply.send({ ok: true });
    },
  });

  app.delete<{ Params: { id: string } }>("/providers/:id", {
    schema: {
      tags: ["providers"],
      summary: "Delete a provider",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const [provider] = db
        .select()
        .from(providers)
        .where(and(eq(providers.id, req.params.id), eq(providers.userId, auth.userId)))
        .limit(1)
        .all();

      if (!provider) return reply.code(404).send({ error: "provider_not_found" });

      db.delete(providers).where(eq(providers.id, provider.id)).run();

      if (provider.isDefault) {
        const [nextProvider] = db
          .select()
          .from(providers)
          .where(and(eq(providers.userId, auth.userId), eq(providers.enabled, true)))
          .limit(1)
          .all();
        if (nextProvider) {
          db.update(providers)
            .set({ isDefault: true, updatedAt: new Date() })
            .where(eq(providers.id, nextProvider.id))
            .run();
        }
      }

      reply.send({ ok: true });
    },
  });
}
