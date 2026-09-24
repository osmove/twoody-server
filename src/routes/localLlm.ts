import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { hostname as osHostname } from "node:os";
import { eq } from "drizzle-orm";
import { db, providers } from "../db.js";
import { offeredModels, probeRuntime } from "../localRuntime.js";

// `/local_llm/status` mirrors the cloud's fleet-status endpoint so
// the RN app's "Twoody Private" indicator can show "Mac connected ·
// <hostname>" without changing client code. In self-hosted mode the
// fleet is always size 1 (the Mac running this server), and presence
// is whether its runtime answers the OpenAI-compat `GET /v1/models`.
//
// The runtime is the one its default local provider points at — what
// Twoody Desktop sets up — or, on a server set up by hand, the endpoint
// in BRIDGE_LOCAL_LLM_ENDPOINT. Only the latter was read, and the
// desktop never sets it: a phone paired with a Mac was told the Mac had
// no model and was offline.
//
// Output shape kept narrow but compatible with the RN hook
// `useLocalLLM` (twoody-app/hooks/useLocalLLM.js): devices[] entries
// carry id/nickname/online + heartbeat.{loaded_model, downloaded_models}.
export async function localLlmRoutes(app: FastifyInstance) {
  app.get("/local_llm/status", {
    schema: {
      tags: ["session"],
      summary: "Local LLM fleet status (self-hosted Mac shape)",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send(await buildStatus(auth.userId));
    },
  });

  app.get("/local_llm/status.json", {
    schema: {
      tags: ["session"],
      summary: "Cloud-compat alias for /local_llm/status",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send(await buildStatus(auth.userId));
    },
  });
}

async function buildStatus(userId: string) {
  const configured = db
    .select()
    .from(providers)
    .where(eq(providers.userId, userId))
    .all()
    .filter((provider) => provider.enabled && provider.kind === "local_openai" && provider.baseUrl);
  const chosen = configured.find((provider) => provider.isDefault) ?? configured[0];
  const endpoint = chosen?.baseUrl ?? process.env.BRIDGE_LOCAL_LLM_ENDPOINT?.trim() ?? null;
  const nickname = osHostname()?.split(".")[0] ?? "this-mac";
  const probe = endpoint ? await probeRuntime(endpoint, { fresh: true }).catch(() => null) : null;
  const online = probe?.ok === true;
  // The model it answers with unless told otherwise. mlx-lm lists the
  // models of its cache in no particular order, so the first of the list
  // is not the loaded one; without a provider, it is all there is to go by.
  const loadedModel = chosen?.model ?? probe?.models?.[0] ?? null;
  const downloadedModels = probe ? offeredModels(chosen?.model ?? null, probe) : chosen?.model ? [chosen.model] : [];

  return {
    enabled: true,
    preferred_device_id: "self",
    devices: [
      {
        id:        "self",
        nickname,
        online,
        last_seen_at: new Date().toISOString(),
        heartbeat: {
          loaded_model:      loadedModel,
          downloaded_models: downloadedModels,
        },
      },
    ],
    stats: {
      queries_24h:                null,
      queries_7d:                 null,
      avg_latency_ms:             null,
      fallback_count_24h:         null,
      total_tokens_in_24h:        null,
      total_tokens_out_24h:       null,
      estimated_savings_usd_7d:   null,
    },
  };
}
