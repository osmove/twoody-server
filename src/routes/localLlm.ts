import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { hostname as osHostname } from "node:os";

// `/local_llm/status` mirrors the cloud's fleet-status endpoint so
// the RN app's "Twoody Private" indicator can show "Mac connected ·
// <hostname>" without changing client code. In self-hosted mode the
// fleet is always size 1 (the Mac running this server), and presence
// is whether the configured local-LLM endpoint (mlx-lm by default)
// answers the OpenAI-compat `GET /v1/models` probe within ~1.5 s.
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
      reply.send(await buildStatus());
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
      reply.send(await buildStatus());
    },
  });
}

type ModelsListResponse = {
  data?: Array<{ id?: string }>;
};

async function buildStatus() {
  const endpoint = process.env.BRIDGE_LOCAL_LLM_ENDPOINT?.trim();
  const nickname = osHostname()?.split(".")[0] ?? "this-mac";
  const probe = endpoint ? await probeOpenAICompatible(endpoint) : null;
  const online = probe?.ok === true;
  const loadedModel = probe?.loadedModel ?? null;
  const downloadedModels = probe?.models ?? [];

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

/// Probe an OpenAI-compatible server (mlx-lm, Ollama, vLLM, …) for
/// its model catalog. mlx-lm exposes `--port 8080` by default and
/// answers `/v1/models` with the currently-loaded plus downloaded
/// HF ids. Failures (timeout, connection refused, malformed JSON)
/// flip `online: false` — the app's UI handles that gracefully.
async function probeOpenAICompatible(endpoint: string): Promise<{
  ok: boolean;
  loadedModel: string | null;
  models: string[];
}> {
  const base = endpoint.replace(/\/+$/, "");
  const url = `${base}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, loadedModel: null, models: [] };
    const json = (await res.json()) as ModelsListResponse;
    const ids = (json.data ?? [])
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    // mlx-lm only ever loads one at a time (memory ceiling), so the
    // first id in the response is "the loaded one". Apps that read
    // `loaded_model` get that; `downloaded_models` gets the full
    // list so the picker can offer alternatives.
    return {
      ok: true,
      loadedModel: ids[0] ?? null,
      models: ids,
    };
  } catch {
    clearTimeout(timer);
    return { ok: false, loadedModel: null, models: [] };
  }
}
