import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";

import { isOwnerSession, isPeerSessionKind, requireAuth } from "../auth.js";
import { ENGINE_PREFERENCES, RuntimeError, RuntimeFetchError, isHttpUrl, runtimeTarget, type BuiltinPrefs, type EnginePreference } from "../builtin/index.js";
import { authSessions, db } from "../db.js";
import { activeEngine, engine, engineDefaultModel, engineName, engineSurvey } from "../engine.js";
import { JobError, cancelJob, currentJob, engineCatalog, ensureRuntimeInstalled, removeEngineModel, runtimeInstalled, startModelJob } from "../engineJobs.js";
import { ownerRequest } from "../localAccess.js";

// « Moteur » and « Modèles » of this computer (docs/builtin-runtime-design.md §4):
//
//   GET    /runtime                  the preference, the engine in use, every engine, the built-in runtime
//   PUT    /runtime                  {engine?, custom_url?, builtin?: {default_model?, idle_minutes?, ctx?, threads?}}
//   POST   /runtime/install          the built-in runtime (llama.cpp, pinned), when it is not there
//   GET    /runtime/catalog          the models Twoody offers: installed, recommended, fits
//   POST   /runtime/models {id}      → 202 {job}: runtime → downloading → verifying → done
//   GET    /runtime/jobs/current     {job} (null when none ran since the start)
//   DELETE /runtime/jobs/current     cancels it
//   DELETE /runtime/models/:id
//
// This computer's person only: its console (twoody-server runtime …, on
// loopback) or the admin token, the Desktop's own session, or a device the
// person paired with it (the iPhone, by code or approved through the
// account). Never another computer of the account — a peer session is
// refused before any route (peerSessions.ts), and a session asked for by
// another computer here — nor a firmware device's token.
//
// Refusals: 409 managed_by_desktop (the Desktop runs this computer's
// runtime), 507 insufficient_memory, 404 not_installed / unknown_model,
// 503 start_failed, 409 job_running.

async function requirePerson(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (ownerRequest(req)) return true;
  const auth = await requireAuth(req, reply);
  if (!auth) return false;
  if (auth.sessionId) {
    if (isOwnerSession(auth.sessionId)) return true;
    const [session] = db
      .select({ kind: authSessions.clientKind, requesterComputerId: authSessions.requesterComputerId })
      .from(authSessions)
      .where(eq(authSessions.id, auth.sessionId))
      .limit(1)
      .all();
    if (session && !isPeerSessionKind(session.kind) && !session.requesterComputerId) return true;
  }
  reply.code(403).send({ error: "person_only", message: "This computer's engine and models are managed by its person: the Desktop, a paired device, or its console." });
  return false;
}

function refuse(reply: FastifyReply, err: unknown) {
  if (err instanceof JobError) return reply.code(err.status).send({ error: err.code, message: err.message });
  if (err instanceof RuntimeError) return reply.code(err.status).send({ error: err.code, message: err.message, ...err.details });
  if (err instanceof RuntimeFetchError) {
    const status = err.code === "unsupported_platform" ? 501 : err.code === "cancelled" ? 409 : 502;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  throw err;
}

export async function runtimeView() {
  const e = engine();
  const { prefs, source } = e.prefs.read();
  const [active, engines, installed] = await Promise.all([activeEngine(), engineSurvey(), runtimeInstalled()]);
  const status = e.manager.status();
  const models = await e.manager.installedModels();
  return {
    preference: { ...prefs, source },
    active: { id: active.id, name: engineName(active.id), reason: active.reason, model: engineDefaultModel(active), models: active.models },
    engines: engines.map((engine) => ({ id: engine.id, name: engine.name, reachable: engine.reachable, models: engine.models })),
    builtin: {
      supported: installed !== null || runtimeTarget(e.platform, e.arch) !== null,
      installed: installed !== null,
      version: installed?.version ?? null,
      platform: `${e.platform}-${e.arch}`,
      missing_libraries: installed?.missingLibraries ?? [],
      acceleration: status.acceleration,
      running: status.running,
      starting: status.starting,
      loaded_model: status.running ? await e.manager.loadedModel() : null,
      failure: status.failure,
      managed_by: status.managedBy,
      crash_restarts: status.crashRestarts,
      models,
      default_model: prefs.builtin.default_model ?? null,
      ctx: status.ctx,
      threads: status.threads,
      threads_batch: status.threadsBatch,
      idle_minutes: Math.round(status.idleSeconds / 60),
    },
    job: currentJob(),
  };
}

type PutBody = { engine?: unknown; custom_url?: unknown; builtin?: unknown };

export async function runtimeRoutes(app: FastifyInstance) {
  app.get("/runtime", {
    schema: { tags: ["providers"], summary: "This computer's engine (« Moteur »): the preference, the engine in use, the built-in llama.cpp runtime" },
    handler: async (req, reply) => {
      if (!(await requirePerson(req, reply))) return;
      return reply.send(await runtimeView());
    },
  });

  app.put<{ Body: PutBody }>("/runtime", {
    schema: { tags: ["providers"], summary: "Choose this computer's engine: auto, builtin, ollama, lmstudio, mlx or custom (with custom_url)" },
    handler: async (req, reply) => {
      if (!(await requirePerson(req, reply))) return;
      const body = (req.body ?? {}) as PutBody;
      const e = engine();
      const update: { engine?: EnginePreference; custom_url?: string; builtin?: Partial<BuiltinPrefs> } = {};
      if (body.engine !== undefined) {
        if (typeof body.engine !== "string" || !(ENGINE_PREFERENCES as readonly string[]).includes(body.engine)) {
          return reply.code(422).send({ error: "invalid_engine", message: `engine is one of ${ENGINE_PREFERENCES.join(", ")}` });
        }
        update.engine = body.engine as EnginePreference;
      }
      if (body.custom_url !== undefined) {
        if (!isHttpUrl(body.custom_url)) return reply.code(422).send({ error: "invalid_custom_url", message: "custom_url is an http(s) address" });
        update.custom_url = body.custom_url;
      }
      const stored = e.prefs.read().prefs;
      if (update.engine === "custom" && !update.custom_url && !stored.custom_url) {
        return reply.code(422).send({ error: "custom_url_missing", message: "custom needs custom_url" });
      }
      let restart = false;
      if (body.builtin !== undefined) {
        if (!body.builtin || typeof body.builtin !== "object") return reply.code(422).send({ error: "invalid_builtin" });
        const given = body.builtin as Record<string, unknown>;
        const builtin: Partial<BuiltinPrefs> = {};
        if (given.default_model !== undefined) {
          const models = await e.manager.installedModels();
          if (typeof given.default_model !== "string" || !models.includes(given.default_model)) {
            return reply.code(422).send({ error: "unknown_model", message: "default_model is one of the installed models" });
          }
          builtin.default_model = given.default_model;
        }
        for (const [key, min, max] of [["idle_minutes", 1, 1440], ["ctx", 512, 262_144], ["threads", 1, 256]] as const) {
          const value = given[key];
          if (value === undefined) continue;
          if (value === null) {
            if (key === "idle_minutes") return reply.code(422).send({ error: `invalid_${key}` });
            builtin[key] = undefined;
          } else if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) {
            builtin[key] = value;
          } else {
            return reply.code(422).send({ error: `invalid_${key}`, message: `${key} is an integer from ${min} to ${max}` });
          }
          restart = true;
        }
        update.builtin = builtin;
      }
      e.prefs.write(update);
      // Context, threads and idle time are the runtime's command line.
      if (restart && e.manager.status().running) await e.manager.restart().catch(() => null);
      const view = await runtimeView();
      return reply.send({ ...view, ...(view.preference.source === "env" ? { overridden_by: "TWOODY_RUNTIME" } : {}) });
    },
  });

  app.post("/runtime/install", {
    schema: { tags: ["providers"], summary: "Install the built-in llama.cpp runtime (pinned release, checked against its SHA-256)" },
    handler: async (req, reply) => {
      if (!(await requirePerson(req, reply))) return;
      try {
        const installed = await ensureRuntimeInstalled();
        return reply.send({ installed: true, fetched: installed.fetched, version: installed.version, platform: installed.platform, missing_libraries: installed.missingLibraries });
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });

  app.get("/runtime/catalog", {
    schema: { tags: ["providers"], summary: "The models Twoody offers for the built-in runtime: installed, recommended, fits in this computer's memory" },
    handler: async (req, reply) => {
      if (!(await requirePerson(req, reply))) return;
      return reply.send(await engineCatalog());
    },
  });

  app.post<{ Body: { id?: unknown; force?: unknown } }>("/runtime/models", {
    schema: { tags: ["providers"], summary: "Install a model of the catalogue (and the runtime first when needed): 202 with the job" },
    handler: async (req, reply) => {
      if (!(await requirePerson(req, reply))) return;
      const id = req.body?.id;
      if (typeof id !== "string" || !id) return reply.code(422).send({ error: "id_required" });
      try {
        return reply.code(202).send({ job: startModelJob(id, { force: req.body?.force === true }) });
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });

  app.get("/runtime/jobs/current", {
    schema: { tags: ["providers"], summary: "The model installation in progress, or the last one" },
    handler: async (req, reply) => {
      if (!(await requirePerson(req, reply))) return;
      return reply.send({ job: currentJob() });
    },
  });

  app.delete("/runtime/jobs/current", {
    schema: { tags: ["providers"], summary: "Cancel the model installation in progress (what was downloaded is kept for the next try)" },
    handler: async (req, reply) => {
      if (!(await requirePerson(req, reply))) return;
      return reply.send({ job: cancelJob() });
    },
  });

  app.delete<{ Params: { id: string } }>("/runtime/models/:id", {
    schema: { tags: ["providers"], summary: "Remove an installed model of the built-in runtime" },
    handler: async (req, reply) => {
      if (!(await requirePerson(req, reply))) return;
      try {
        await removeEngineModel(req.params.id);
        return reply.code(204).send();
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });
}
