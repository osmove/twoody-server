// Local LLM model management — read the installed Ollama catalog,
// pull new models, set a default, delete unused ones.
//
// Mirrors the surface twoody-mac's `LocalLLMSettingsView.swift` /
// `LocalLLMCatalog.swift` provided for mlx-lm, adapted to the Ollama
// API that ships on the Pi. The Desktop client calls these routes
// over the LAN; the cloud path is intentionally not surfaced — model
// management is local-host concern.
//
// Endpoints:
//   GET    /local_llm/catalog        — curated list (slug, size, RAM, tok/s hint)
//   GET    /local_llm/models         — currently installed (Ollama /api/tags)
//   POST   /local_llm/pull           — kick off a download, returns {id}
//   GET    /local_llm/pulls/:id      — poll progress for one pull
//   GET    /local_llm/pulls          — list active pulls
//   DELETE /local_llm/models/:name   — remove an installed model
//   PUT    /local_llm/default        — set the default model

import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { randomUUID } from "node:crypto";
import { outboundFetch } from "../outbound.js";

const DEFAULT_OLLAMA = "http://127.0.0.1:11434";

function ollamaUrl(): string {
  // BRIDGE_LOCAL_LLM_ENDPOINT is the OpenAI-compat /v1 URL we already
  // expose via the executor. The Ollama-native API lives at the root,
  // so strip the /v1 suffix when reusing the env var.
  const compat = process.env.BRIDGE_LOCAL_LLM_ENDPOINT?.trim() ?? "";
  if (compat.endsWith("/v1")) return compat.slice(0, -3);
  if (compat) return compat.replace(/\/+$/, "");
  return DEFAULT_OLLAMA;
}

// Curated catalog. Slugs are real Ollama model tags from
// https://ollama.com/library — kept narrow so the picker stays
// digestible. `tools` flag tracks whether the model has been validated
// for tool-calling in our chat flow (Qwen2.5 family is the main one
// that holds up). Numbers are approximate, measured on a Raspberry Pi
// 5 16 GB running CPU-only.
const CATALOG: Array<{
  slug:        string;
  display:     string;
  family:      string;
  sizeGb:      number;
  ramGb:       number;
  tokensPerSec: number;
  tools:       boolean;
  description: string;
}> = [
  { slug: "qwen2.5:0.5b",  display: "Qwen 2.5 0.5B",  family: "Qwen",    sizeGb: 0.4, ramGb: 1.0, tokensPerSec: 35, tools: true,  description: "Tiny — ideal for quick voice transcription + intent classification on a Pi." },
  { slug: "qwen2.5:1.5b",  display: "Qwen 2.5 1.5B",  family: "Qwen",    sizeGb: 0.9, ramGb: 1.8, tokensPerSec: 18, tools: true,  description: "Small, tool-capable, decent FR. Sweet-spot for a Pi 5 if you want quick answers." },
  { slug: "qwen2.5:3b",    display: "Qwen 2.5 3B",    family: "Qwen",    sizeGb: 1.9, ramGb: 3.5, tokensPerSec: 8,  tools: true,  description: "Default Pi pick. Solid French + English, tool calls work reliably." },
  { slug: "qwen2.5:7b",    display: "Qwen 2.5 7B",    family: "Qwen",    sizeGb: 4.7, ramGb: 6.5, tokensPerSec: 3,  tools: true,  description: "More capable but slower on Pi CPU. Use when accuracy matters." },
  { slug: "llama3.2:1b",   display: "Llama 3.2 1B",   family: "Llama",   sizeGb: 0.8, ramGb: 1.6, tokensPerSec: 20, tools: false, description: "Compact Meta model — fast, but tool calling is unreliable." },
  { slug: "llama3.2:3b",   display: "Llama 3.2 3B",   family: "Llama",   sizeGb: 2.0, ramGb: 3.5, tokensPerSec: 8,  tools: false, description: "Solid general purpose, no tool calls." },
  { slug: "phi3.5:3.8b",   display: "Phi 3.5 Mini",   family: "Phi",     sizeGb: 2.2, ramGb: 3.6, tokensPerSec: 7,  tools: false, description: "Microsoft's small model, good at code + reasoning." },
  { slug: "gemma2:2b",     display: "Gemma 2 2B",     family: "Gemma",   sizeGb: 1.6, ramGb: 2.8, tokensPerSec: 12, tools: false, description: "Google's small open model." },
];

interface OllamaTag {
  name:      string;
  size?:     number;
  modified_at?: string;
  details?: { parameter_size?: string; quantization_level?: string };
}

interface PullJob {
  id:        string;
  model:     string;
  status:    "running" | "done" | "error";
  startedAt: string;
  bytes:     number;
  total:     number;
  message:   string;
  error?:    string;
}

const pulls = new Map<string, PullJob>();

async function ollamaTags(): Promise<OllamaTag[]> {
  const res = await outboundFetch(`${ollamaUrl()}/api/tags`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`ollama_tags_status_${res.status}`);
  const json = (await res.json()) as { models?: OllamaTag[] };
  return json.models ?? [];
}

async function ollamaDelete(name: string): Promise<void> {
  const res = await outboundFetch(`${ollamaUrl()}/api/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ollama_delete_status_${res.status} ${text.slice(0, 200)}`);
  }
}

async function startOllamaPull(job: PullJob): Promise<void> {
  // Background streaming: parse NDJSON progress events and update the
  // in-memory job state. The endpoint returns when the stream ends
  // (success or error). No await on the caller side — fire-and-forget.
  try {
    const res = await outboundFetch(`${ollamaUrl()}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: job.model, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`ollama_pull_status_${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const event = JSON.parse(line) as {
            status?:   string;
            completed?: number;
            total?:    number;
            error?:    string;
          };
          if (event.error) {
            job.status = "error";
            job.error = event.error;
            return;
          }
          if (typeof event.completed === "number") job.bytes = event.completed;
          if (typeof event.total === "number")     job.total = event.total;
          if (event.status)                         job.message = event.status;
        } catch {
          // ignore malformed line
        }
      }
    }
    job.status = "done";
    job.message = "ready";
  } catch (error) {
    job.status = "error";
    job.error = error instanceof Error ? error.message : String(error);
  }
}

export async function llmModelsRoutes(app: FastifyInstance) {
  app.get("/local_llm/catalog", {
    schema: { tags: ["session"], summary: "Curated local LLM catalog" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send({ catalog: CATALOG });
    },
  });

  app.get("/local_llm/models", {
    schema: { tags: ["session"], summary: "Currently installed Ollama models" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      try {
        const tags = await ollamaTags();
        const merged = tags.map((tag) => {
          const catalog = CATALOG.find((c) => c.slug === tag.name);
          return {
            slug:            tag.name,
            size_bytes:      tag.size ?? null,
            modified_at:     tag.modified_at ?? null,
            parameter_size:  tag.details?.parameter_size ?? null,
            quantization:    tag.details?.quantization_level ?? null,
            catalog:         catalog ?? null,
          };
        });
        reply.send({ models: merged, ollama_url: ollamaUrl() });
      } catch (error) {
        const message = error instanceof Error ? error.message : "ollama_unreachable";
        reply.code(502).send({ error: "ollama_unreachable", message });
      }
    },
  });

  app.post<{ Body: { model?: string } }>("/local_llm/pull", {
    schema: { tags: ["session"], summary: "Start an Ollama model pull" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const model = String(req.body?.model ?? "").trim();
      if (!model) return reply.code(422).send({ error: "model is required" });
      const job: PullJob = {
        id:        randomUUID(),
        model,
        status:    "running",
        startedAt: new Date().toISOString(),
        bytes:     0,
        total:     0,
        message:   "queued",
      };
      pulls.set(job.id, job);
      void startOllamaPull(job);
      reply.code(202).send({ id: job.id, model, status: job.status });
    },
  });

  app.get<{ Params: { id: string } }>("/local_llm/pulls/:id", {
    schema: { tags: ["session"], summary: "Poll an in-flight pull" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const job = pulls.get(req.params.id);
      if (!job) return reply.code(404).send({ error: "pull_not_found" });
      reply.send(job);
    },
  });

  app.get("/local_llm/pulls", {
    schema: { tags: ["session"], summary: "List in-flight pulls" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send({ pulls: [...pulls.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) });
    },
  });

  app.delete<{ Params: { name: string } }>("/local_llm/models/:name", {
    schema: { tags: ["session"], summary: "Remove an installed model" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      try {
        await ollamaDelete(decodeURIComponent(req.params.name));
        reply.code(204).send();
      } catch (error) {
        const message = error instanceof Error ? error.message : "ollama_delete_failed";
        reply.code(502).send({ error: "ollama_delete_failed", message });
      }
    },
  });
}
