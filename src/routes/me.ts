import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { requireAuth } from "../auth.js";
import { db, users } from "../db.js";
import { memoryModeFor, readMemoryMode } from "../chatContext.js";
import { memoryEmbeddingStatus } from "../memory/embeddings.js";
import { memoriesChanged } from "../memory/changes.js";

// `/me` is the iPhone/watch app's bootstrap call. The cloud Rails
// backend uses it for prefs, tier, quota, audio settings, local-LLM
// flags, and a bunch of derived state. The single-user Self-hosted
// edition doesn't have billing or quotas, so we serve a
// minimal-viable shape:
//
//   - id / email / name straight from the local user row
//   - effective_tier = "self_hosted" so paywall checks short-circuit
//   - quota = an "infinite remaining" snapshot (apps gracefully no-op
//     when remaining is high)
//   - prefs (default_provider, default_model, audio_voice, …) read
//     from the user's prefs blob
//   - local_llm_enabled = always true here (the whole point of
//     running this server is to route locally)
//
// The PATCH variant accepts the same shape the cloud accepts —
// `{user: {default_voice_mode, default_provider, default_model, ...}}`
// — and merges any provided keys into prefs. Keeping the wire
// shape identical means the RN app can flip its `apiBaseUrl` to a
// local server without re-implementing every PATCH /me call site.
export async function meRoutes(app: FastifyInstance) {
  app.get("/me", {
    schema: {
      tags: ["session"],
      summary: "Local user profile + prefs (cloud /me parity)",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send(serializeUser(auth.userId));
    },
  });

  app.get("/me.json", {
    schema: {
      tags: ["session"],
      summary: "Cloud-compat alias for /me",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send(serializeUser(auth.userId));
    },
  });

  app.patch<{ Body: PatchMeBody }>("/me", {
    schema: {
      tags: ["session"],
      summary: "Update prefs on the local user",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: {
          user: { type: "object", additionalProperties: true },
        },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      mergePrefs(auth.userId, req.body?.user ?? {});
      // Switched on: the memories get their vectors; off: they go.
      if (req.body?.user && "memory_embeddings" in req.body.user) memoriesChanged(auth.userId);
      reply.send(serializeUser(auth.userId));
    },
  });
}

type PatchMeBody = {
  user?: Record<string, unknown>;
};

function serializeUser(userId: string) {
  const [user] = db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .all();

  if (!user) {
    return null;
  }

  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(user.prefsJson || "{}");
  } catch {
    prefs = {};
  }

  // Best-effort prefs surface. Defaults are picked to mirror what the
  // cloud backend would send for a freshly-paired account, so the
  // RN/watch hydration logic can stay surface-agnostic.
  return {
    id:                  user.id,
    email:               user.email,
    name:                user.name ?? null,
    status:              "active",
    effective_tier:      "self_hosted",
    subscription_plan:   "self_hosted",
    has_completed_onboarding: true,
    local_llm_enabled:   true,
    memory_enabled:      readBool(prefs, "memory_enabled", true),
    // Mémoire v2: the memories a conversation is given unless it says
    // otherwise — "full", "profile" or "none" (memory_enabled: false).
    memory_mode:         memoryModeFor(prefs),
    // Memory embeddings on this computer: on by default, used once the
    // model files are here (the status says); false switches them off.
    memory_embeddings:   readBool(prefs, "memory_embeddings", true),
    memory_embedding_status: memoryEmbeddingStatus(user.id),
    transcribe_audio:    readBool(prefs, "transcribe_audio", true),
    audio_output:        readBool(prefs, "audio_output", false),
    default_voice_mode:  readString(prefs, "default_voice_mode", "tap"),
    default_provider:    readString(prefs, "default_provider", "openai"),
    default_model:       readString(prefs, "default_model", ""),
    default_audio_voice: readString(prefs, "default_audio_voice", "cedar"),
    default_agent_id:    null,
    stt_provider:        readString(prefs, "stt_provider", "google"),
    system_prompt:       readString(prefs, "system_prompt", ""),
    system_prompt_replace_base: readBool(prefs, "system_prompt_replace_base", false),
    tools_opt_in_only:   readBool(prefs, "tools_opt_in_only", false),
    default_temperature: prefs.default_temperature ?? null,
    // « Tâches de fond »: which computer of the account runs memory
    // extraction (router/index.ts): "auto", "self" or "computer:<id>".
    background_computer: readBackgroundComputer(prefs.background_computer),
    // « Préféré » (docs/mesh-design.md §3): the mesh's default coordinator
    // for ties, /providers computers[].preferred.
    preferred_computer: readBackgroundComputer(prefs.preferred_computer),
    quota: {
      // No quotas in self-hosted mode — surface a budget so high
      // it's effectively infinite, matching the shape the app
      // expects. Each window snapshot is the same: remaining is
      // null = no limit, used 0.
      chat:     unlimitedResource(),
      pipeline: unlimitedResource(),
    },
  };
}

/// "auto" (the default), "self", or "computer:<account computer id>".
export function readBackgroundComputer(value: unknown): string {
  if (value === "self" || value === "auto") return value;
  if (typeof value === "string" && /^computer:[\w-]{1,64}$/.test(value)) return value;
  return "auto";
}

function unlimitedResource() {
  return {
    burst_5h: { used: 0, limit: null, remaining: null },
    daily:    { used: 0, limit: null, remaining: null },
    weekly:   { used: 0, limit: null, remaining: null },
  };
}

function readBool(prefs: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = prefs[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true")  return true;
    if (value === "false") return false;
  }
  return fallback;
}

function readString(prefs: Record<string, unknown>, key: string, fallback: string): string {
  const value = prefs[key];
  return typeof value === "string" ? value : fallback;
}

function mergePrefs(userId: string, patch: Record<string, unknown>) {
  const [user] = db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .all();
  if (!user) return;

  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(user.prefsJson || "{}");
  } catch {
    current = {};
  }

  // Whitelist the keys we accept — anything else is silently dropped
  // so a curious caller can't stuff a megabyte of opaque data into
  // the prefs blob. Mirrors the Rails backend's user_params permit.
  const ACCEPTED = new Set([
    "default_voice_mode",
    "default_provider",
    "default_model",
    "default_audio_voice",
    "default_temperature",
    "transcribe_audio",
    "audio_output",
    "memory_enabled",
    "memory_embeddings",
    "stt_provider",
    "system_prompt",
    "system_prompt_replace_base",
    "tools_opt_in_only",
    "background_computer",
    "preferred_computer",
  ]);

  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (ACCEPTED.has(key)) {
      merged[key] = key === "background_computer" || key === "preferred_computer" ? readBackgroundComputer(value) : value;
    }
  }
  if (typeof merged.memory_embeddings !== "boolean") delete merged.memory_embeddings;
  // The memory mode and the older switch say the same thing: « Aucune » is
  // memory switched off, « Complète » or « Profil seulement » switches it on.
  const mode = readMemoryMode(patch.memory_mode);
  if (mode === "none") merged.memory_enabled = false;
  else if (mode) {
    merged.memory_enabled = true;
    merged.memory_mode = mode;
  }

  // Mirror name updates onto the dedicated column too — the cloud
  // backend updates user.name directly, and the RN app reads it
  // back from the canonical column rather than the prefs blob.
  const nameUpdate = typeof patch.name === "string" ? patch.name : null;

  db.update(users)
    .set({
      prefsJson: JSON.stringify(merged),
      ...(nameUpdate !== null ? { name: nameUpdate } : {}),
    })
    .where(eq(users.id, userId))
    .run();
}
