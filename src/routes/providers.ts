import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { db, providers } from "../db.js";
import { generateId, requireAuth } from "../auth.js";

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

async function pingOpenAICompatible(baseUrl: string): Promise<{
  available: boolean;
  latency_ms: number | null;
}> {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(2500),
    });
    return {
      available: response.ok,
      latency_ms: Date.now() - started,
    };
  } catch {
    return { available: false, latency_ms: null };
  }
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

      const serialized = await Promise.all(
        rows.map(async (provider) => {
          const status =
            provider.kind === "local_openai" && provider.baseUrl
              ? await pingOpenAICompatible(provider.baseUrl)
              : { available: provider.enabled, latency_ms: null };

          return { ...serializeProvider(provider), status };
        })
      );

      reply.send({ providers: serialized });
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

      const baseUrl = (req.body.base_url ?? req.body.url ?? "").trim().replace(/\/$/, "");
      const model = req.body.model?.trim();
      const name = req.body.name?.trim() || "Local LLM";

      if (!baseUrl || !model) {
        return reply.code(422).send({ error: "url and model are required" });
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
        if (req.body.name !== undefined) updates.name = req.body.name.trim();
        if (req.body.model !== undefined) updates.model = req.body.model.trim();
        if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
        if (req.body.url !== undefined || req.body.base_url !== undefined) {
          updates.baseUrl = (req.body.base_url ?? req.body.url ?? "").trim().replace(/\/$/, "");
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
          .where(eq(providers.userId, auth.userId))
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
