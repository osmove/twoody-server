import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { db, llmEndpoints } from "../db.js";
import { generateId, requireAuth } from "../auth.js";
import { offeredModels, probeRuntime, type RuntimeProbe } from "../localRuntime.js";
import { modelLoadState, noteModelReady, startModelLoad, startModelPreparation } from "../modelLoads.js";
import { conversationStartPending, prepareConversationStart } from "./queries.js";
import { requirePerson } from "./runtime.js";
import { ownerRequest } from "../localAccess.js";
import { choosesForThePerson } from "../sessionTrust.js";
import { meshRoster } from "../vault/roster.js";
import { listComputers, type ComputerEntry } from "../router/index.js";
import { accountCredentials } from "../account/service.js";
import { activeEngine, engine, engineDefaultModel, engineName, engineRoute } from "../engine.js";

type ProviderPatchBody = {
  name?: string;
  url?: string;
  base_url?: string;
  model?: string;
  enabled?: boolean;
};

function serializeProvider(provider: typeof llmEndpoints.$inferSelect) {
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
async function engineProvider(stored: Array<typeof llmEndpoints.$inferSelect>) {
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

/// How long /providers waits for the account's computers before answering
/// with the last list it had. They come from the account (the vault's
/// roster, then `account_computers`), through the Desktop's main process
/// when this server is embedded, which waits up to 20 s and 13 s: on
/// 05/10/2026 api.twoody.com took 2.5 to 13.6 s to answer and every
/// /providers took 13 to 33 s — and with it the model line under the
/// composer, its icons and the model picker of Twoody Desktop.
export const COMPUTERS_WAIT_MS = 1_500;
const knownComputers = new Map<string, ComputerEntry[]>();
const computersAsking = new Map<string, Promise<ComputerEntry[] | null>>();

/// The account's computers for /providers: the fresh list when it comes in
/// time, else the last one known (none before a first answer). The question
/// goes on, one at a time per person, and its answer is kept for the next.
async function computersFor(userId: string, waitMs = COMPUTERS_WAIT_MS): Promise<ComputerEntry[] | null> {
  // No account any more: nothing known is still true.
  if (!accountCredentials()) {
    knownComputers.delete(userId);
    return null;
  }
  let asking = computersAsking.get(userId);
  if (!asking) {
    asking = listComputers(userId)
      .catch(() => null)
      .then((computers) => {
        // null: no account any more, nothing to remember.
        if (computers) knownComputers.set(userId, computers);
        else knownComputers.delete(userId);
        return computers;
      })
      .finally(() => computersAsking.delete(userId));
    computersAsking.set(userId, asking);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), waitMs);
    timer.unref?.();
  });
  try {
    const answer = await Promise.race([asking, late]);
    return answer === "late" ? knownComputers.get(userId) ?? null : answer;
  } finally {
    clearTimeout(timer);
  }
}

function modelName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 300 && trimmed !== "local" && trimmed !== "auto" ? trimmed : null;
}

/// The runtime of this computer that holds `model`, as /queries would send
/// it there (queries.ts resolveProvider): the provider naming it, then one
/// whose runtime lists it, then the engine. Null when none does.
async function runtimeHolding(userId: string, model: string): Promise<{ baseUrl: string; model: string; runtime: string | null; probe: RuntimeProbe | null } | null> {
  const stored = db
    .select()
    .from(llmEndpoints)
    .where(eq(llmEndpoints.userId, userId))
    .all()
    .filter((p): p is typeof p & { baseUrl: string } => p.enabled && p.kind === "local_openai" && Boolean(p.baseUrl));
  const ask = (baseUrl: string) => probeRuntime(baseUrl, { fresh: true }).catch(() => null);
  const naming = stored.find((p) => p.model === model);
  if (naming) return { baseUrl: naming.baseUrl, model, runtime: naming.name, probe: await ask(naming.baseUrl) };
  for (const p of stored) {
    const probe = await ask(p.baseUrl);
    if (probe?.models?.includes(model)) return { baseUrl: p.baseUrl, model, runtime: p.name, probe };
  }
  const route = await engineRoute(model).catch(() => null);
  if (route?.model === model) {
    // The built-in runtime may be stopped (asleep): it is started to load.
    const probe: RuntimeProbe = route.engine === "builtin"
      ? { reachable: true, ok: true, models: [model], loaded: null, latency_ms: null, checked_at: new Date().toISOString() }
      : (await ask(route.baseUrl)) ?? { reachable: false, ok: false, models: null, latency_ms: null, checked_at: new Date().toISOString() };
    return { baseUrl: route.baseUrl, model, runtime: engineName(route.engine), probe };
  }
  return null;
}

/// Where this computer's conversations go, with what it knows of its person
/// in the prompt: decided by this machine's console, or by the person
/// (sessionTrust.ts choosesForThePerson: the Desktop, the CLI, one of the
/// person's own devices) — never a firmware device's token nor a device that
/// is no member of the person's history, such as a household member's
/// phone, which could otherwise send the owner's conversations to a machine
/// of theirs (docs/trust-routes-review.md). Reading the list and loading a
/// model stay open to any device paired with this computer.
async function requireChooser(req: FastifyRequest, reply: FastifyReply): Promise<{ userId: string } | null> {
  const auth = await requireAuth(req, reply);
  if (!auth) return null;
  if (ownerRequest(req) || (await choosesForThePerson(req, auth, () => meshRoster().get()))) return auth;
  reply.code(403).send({ error: "not_the_person", message: "This computer's models are chosen by its person: on it, from the CLI, or from one of the person's own devices." });
  return null;
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
        .from(llmEndpoints)
        .where(eq(llmEndpoints.userId, auth.userId))
        .all();

      // Asked alongside the runtimes, not after them.
      const computersAsked = computersFor(auth.userId);
      const engineAsked = engineProvider(rows).catch(() => null);

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
            const status = { available: false, reachable: false, latency_ms: null, checked_at: new Date().toISOString() };
            return { ...serializeProvider(provider), status, models: provider.model ? [provider.model] : [] };
          }
          // `reachable`: something answers at its address (a runtime that is
          // not running does not); `loaded_models`: what it holds in memory,
          // when it says (llama.cpp's router) — null when it does not.
          const status = { available: probe.ok, reachable: probe.reachable, latency_ms: probe.latency_ms, checked_at: probe.checked_at };
          return { ...serializeProvider(provider), status, models: offeredModels(provider.model, probe), loaded_models: probe.loaded ?? null };
        })
      );

      // The account's computers, when this server knows its account: the
      // picker's « Automatique » (provider "auto") and one section per
      // computer (provider "computer:<id>"). Absent, the clients behave as
      // before.
      const computers = await computersAsked;
      const fromEngine = await engineAsked;
      const listed = fromEngine ? (fromEngine.is_default ? [fromEngine, ...serialized] : [...serialized, fromEngine]) : serialized;
      reply.send({ providers: listed, ...(computers ? { auto: true, computers } : {}) });
    },
  });

  // A model picked on a paired phone, loaded now rather than on the first
  // question (modelLoads.ts): {model} only — never an address, never a
  // file — and only a model one of this computer's runtimes lists.
  //   POST /providers/load {model} → 200 {load} in memory already,
  //     202 {load} loading, 503 runtime_unreachable {runtime}: what runs it
  //     does not answer (mlx-lm not started), 404 unknown_model.
  //   GET  /providers/load?model=  → {load}
  // Once in memory, the start of the asking device's new conversation is
  // read with that model (« preparing »), then it is « ready »: the first
  // question reads only itself (prepareConversationStart, queries.ts). A
  // runtime holds one model: loading this one lets go of the one before.
  // This computer's person only (runtime.ts requirePerson): the Desktop, a
  // paired device, its console — never another computer of the account.
  app.post<{ Body: { model?: unknown } }>("/providers/load", {
    schema: {
      tags: ["providers"],
      summary: "Load a model of this computer's runtimes into memory",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      if (!(await requirePerson(req, reply))) return;
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const model = modelName(req.body?.model);
      if (!model) return reply.code(422).send({ error: "model_required" });
      const target = await runtimeHolding(auth.userId, model);
      if (!target) return reply.code(404).send({ error: "unknown_model", model });
      if (!target.probe?.reachable) {
        return reply.code(503).send({ error: "runtime_unreachable", model, runtime: target.runtime, message: `${target.runtime ?? "The runtime"} does not answer on this computer.` });
      }
      const prepare = (fresh: boolean) => prepareConversationStart(auth, model, { fresh });
      if (target.probe.loaded?.includes(model)) {
        if (!(await conversationStartPending(auth, model).catch(() => false))) return reply.send({ load: noteModelReady(target) });
        return reply.code(202).send({ load: startModelPreparation(target, prepare) });
      }
      const load = startModelLoad(target, undefined, prepare);
      return reply.code(load.state === "ready" ? 200 : 202).send({ load });
    },
  });

  app.get<{ Querystring: { model?: unknown } }>("/providers/load", {
    schema: {
      tags: ["providers"],
      summary: "Where the load of a model is",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      if (!(await requirePerson(req, reply))) return;
      const model = modelName(req.query?.model);
      if (!model) return reply.code(422).send({ error: "model_required" });
      reply.send({ load: modelLoadState(model) });
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
      const auth = await requireChooser(req, reply);
      if (!auth) return;

      const baseUrl = normalizeProviderUrl(req.body.base_url ?? req.body.url ?? "");
      const model = nonEmpty(req.body.model);
      const name = nonEmpty(req.body.name) || "Local LLM";

      if (!baseUrl || !model) {
        return reply.code(422).send({ error: "url and model are required" });
      }

      const duplicate = db
        .select({ id: llmEndpoints.id })
        .from(llmEndpoints)
        .where(and(eq(llmEndpoints.userId, auth.userId), eq(llmEndpoints.baseUrl, baseUrl), eq(llmEndpoints.model, model)))
        .limit(1)
        .all();
      if (duplicate.length > 0) {
        return reply.code(409).send({ error: "provider_already_exists" });
      }

      const existing = db
        .select({ id: llmEndpoints.id })
        .from(llmEndpoints)
        .where(eq(llmEndpoints.userId, auth.userId))
        .limit(1)
        .all();

      const now = new Date();
      const id = generateId();
      db.insert(llmEndpoints)
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
        .from(llmEndpoints)
        .where(eq(llmEndpoints.id, id))
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
        const auth = await requireChooser(req, reply);
        if (!auth) return;

        const [provider] = db
          .select()
          .from(llmEndpoints)
          .where(and(eq(llmEndpoints.id, req.params.id), eq(llmEndpoints.userId, auth.userId)))
          .limit(1)
          .all();

        if (!provider) return reply.code(404).send({ error: "provider_not_found" });

        const updates: Partial<typeof llmEndpoints.$inferInsert> = {
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

        db.update(llmEndpoints)
          .set(updates)
          .where(eq(llmEndpoints.id, provider.id))
          .run();

        const [updated] = db
          .select()
          .from(llmEndpoints)
          .where(eq(llmEndpoints.id, provider.id))
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
      const auth = await requireChooser(req, reply);
      if (!auth) return;

      const [provider] = db
        .select()
        .from(llmEndpoints)
        .where(and(eq(llmEndpoints.id, req.params.id), eq(llmEndpoints.userId, auth.userId)))
        .limit(1)
        .all();

      if (!provider) return reply.code(404).send({ error: "provider_not_found" });

      db.update(llmEndpoints)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(llmEndpoints.userId, auth.userId))
        .run();
      db.update(llmEndpoints)
        .set({ isDefault: true, enabled: true, updatedAt: new Date() })
        .where(eq(llmEndpoints.id, provider.id))
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
      const auth = await requireChooser(req, reply);
      if (!auth) return;

      const [provider] = db
        .select()
        .from(llmEndpoints)
        .where(and(eq(llmEndpoints.id, req.params.id), eq(llmEndpoints.userId, auth.userId)))
        .limit(1)
        .all();

      if (!provider) return reply.code(404).send({ error: "provider_not_found" });

      db.delete(llmEndpoints).where(eq(llmEndpoints.id, provider.id)).run();

      if (provider.isDefault) {
        const [nextProvider] = db
          .select()
          .from(llmEndpoints)
          .where(and(eq(llmEndpoints.userId, auth.userId), eq(llmEndpoints.enabled, true)))
          .limit(1)
          .all();
        if (nextProvider) {
          db.update(llmEndpoints)
            .set({ isDefault: true, updatedAt: new Date() })
            .where(eq(llmEndpoints.id, nextProvider.id))
            .run();
        }
      }

      reply.send({ ok: true });
    },
  });
}
