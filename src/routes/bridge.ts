import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { executeLocalTool } from "../tools.js";

const BRIDGE_TASK_KINDS = [
  "search",
  "read",
  "list_folders",
  "list_dir",
  "open_document",
  "thumbnail",
  "llm_infer",
  "photos_recent",
  "photos_by_date",
  "app_open",
  "shortcut_run",
  "shortcut_list",
  "ocr_image",
] as const;

type BridgeTaskKind = (typeof BRIDGE_TASK_KINDS)[number];

const LOCAL_ONLY_TASK_KINDS = [
  "smart_home",
  "spotify",
  "device_command",
  "members_list",
  "list_household_members",
  "stereo_pair",
] as const;

type LocalOnlyTaskKind = (typeof LOCAL_ONLY_TASK_KINDS)[number];

// Bridge task queue — in-memory for Phase 1
// Phase 2 will move this to Redis for multi-process support
interface BridgeTask {
  id: string;
  kind: BridgeTaskKind | LocalOnlyTaskKind;
  args: Record<string, unknown>;
  enqueuedAt: Date;
  result?: unknown;
  status: "pending" | "streaming" | "done" | "error";
  delta?: string;
  errorMessage?: string;
}

const taskQueue: BridgeTask[] = [];
const taskMap = new Map<string, BridgeTask>();

// Mac-bridge heartbeat presence (keyed by device_id)
const bridgePresence = new Map<string, { nickname?: string; lastSeen: Date }>();

function hasActiveBridge() {
  const cutoff = new Date(Date.now() - 90_000);
  return [...bridgePresence.values()].some((entry) => entry.lastSeen > cutoff);
}

function isBridgeTaskKind(value: string): value is BridgeTaskKind {
  return (BRIDGE_TASK_KINDS as readonly string[]).includes(value);
}

function isLocalOnlyTaskKind(value: string): value is LocalOnlyTaskKind {
  return (LOCAL_ONLY_TASK_KINDS as readonly string[]).includes(value);
}

async function waitForTaskResult(taskId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = taskMap.get(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status === "done") return task.result;
    if (task.status === "error") throw new Error(task.errorMessage ?? "Bridge task failed");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Bridge task ${taskId} timed out after ${timeoutMs}ms`);
}

export async function bridgeRoutes(app: FastifyInstance) {
  // GET /bridge/tasks/next — Mac app long-polls this
  app.get<{ Querystring: { wait?: string } }>(
    "/bridge/tasks/next",
    {
      schema: {
        tags: ["bridge"],
        summary: "Long-poll the next bridge task",
      },
      handler: async (req, reply) => {
        const deviceId = req.headers["x-bridge-device-id"] as string | undefined;
        const nickname = req.headers["x-bridge-device-nickname"] as string | undefined;

        if (deviceId) {
          bridgePresence.set(deviceId, { nickname, lastSeen: new Date() });
        }

        const wait = Math.min(parseInt(req.query.wait ?? "0", 10), 30);
        const deadline = Date.now() + wait * 1000;

        while (true) {
          const task = taskQueue.find((t) => t.status === "pending");
          if (task) {
            task.status = "streaming";
            return reply.send({
              id: task.id,
              kind: task.kind,
              args: task.args,
              enqueued_at: task.enqueuedAt.toISOString(),
            });
          }

          if (Date.now() >= deadline) {
            return reply.code(204).send();
          }

          await new Promise((r) => setTimeout(r, 500));
        }
      },
    }
  );

  // PATCH /bridge/tasks/:id — Mac reports progress / result
  app.patch<{
    Params: { id: string };
    Body: {
      status: "streaming" | "done" | "error";
      delta?: string;
      result?: unknown;
      error_message?: string;
    };
  }>("/bridge/tasks/:id", {
    schema: {
      tags: ["bridge"],
      summary: "Report bridge task progress or completion",
    },
    handler: async (req, reply) => {
      const task = taskMap.get(req.params.id);
      if (!task) return reply.code(404).send({ error: "Task not found" });

      task.status = req.body.status;
      if (req.body.delta) task.delta = (task.delta ?? "") + req.body.delta;
      if (req.body.result) task.result = req.body.result;
      if (req.body.error_message) task.errorMessage = req.body.error_message;

      reply.code(204).send();
    },
  });

  // GET /bridge/tasks/:id — clients poll for task completion
  app.get<{ Params: { id: string } }>("/bridge/tasks/:id", {
    schema: {
      tags: ["bridge"],
      summary: "Poll task completion",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const task = taskMap.get(req.params.id);
      if (!task) return reply.code(404).send({ error: "Task not found" });

      reply.send({
        id: task.id,
        kind: task.kind,
        status: task.status,
        result: task.result ?? null,
        delta: task.delta ?? null,
        error_message: task.errorMessage ?? null,
        enqueued_at: task.enqueuedAt.toISOString(),
      });
    },
  });

  // GET /bridge/presence — CLI status check
  app.get("/bridge/presence", {
    schema: {
      tags: ["bridge"],
      summary: "Check active Mac Bridge presence",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const cutoff = new Date(Date.now() - 90_000);
      const active = [...bridgePresence.entries()].filter(([, v]) => v.lastSeen > cutoff);

      reply.send({
        active: active.length > 0,
        device_count: active.length,
        device_name: active[0]?.[1]?.nickname ?? null,
        devices: active.map(([id, v]) => ({
          id,
          nickname: v.nickname,
          last_seen: v.lastSeen.toISOString(),
        })),
      });
    },
  });

  app.get("/bridge/folders.json", {
    schema: {
      tags: ["bridge"],
      summary: "List granted local folders",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      if (!hasActiveBridge()) {
        return reply.code(503).send({ error: "bridge_offline" });
      }

      const id = Math.random().toString(36).slice(2);
      const task: BridgeTask = {
        id,
        kind: "list_folders",
        args: {},
        enqueuedAt: new Date(),
        status: "pending",
      };

      taskQueue.push(task);
      taskMap.set(id, task);

      try {
        const result = await waitForTaskResult(id, 15_000);
        reply.send(result ?? { folders: [] });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bridge error";
        if (message.includes("timed out")) {
          return reply.code(504).send({ error: "bridge_timeout" });
        }
        reply.code(502).send({ error: "bridge_error", message });
      }
    },
  });

  app.get<{ Params: { folder_id: string }; Querystring: { sub_path?: string } }>(
    "/bridge/folders/:folder_id/contents",
    {
      schema: {
        tags: ["bridge"],
        summary: "List the contents of a granted local folder",
        security: [{ bearerAuth: [] }],
      },
      handler: async (req, reply) => {
        const auth = await requireAuth(req, reply);
        if (!auth) return;

        if (!hasActiveBridge()) {
          return reply.code(503).send({ error: "bridge_offline" });
        }

        const id = Math.random().toString(36).slice(2);
        const task: BridgeTask = {
          id,
          kind: "list_dir",
          args: {
            folder_id: req.params.folder_id,
            sub_path: req.query.sub_path ?? "",
          },
          enqueuedAt: new Date(),
          status: "pending",
        };

        taskQueue.push(task);
        taskMap.set(id, task);

        try {
          const result = await waitForTaskResult(id, 20_000);
          reply.send(result ?? { items: [], folder_id: req.params.folder_id, sub_path: req.query.sub_path ?? "" });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Bridge error";
          if (message.includes("timed out")) {
            return reply.code(504).send({ error: "bridge_timeout" });
          }
          reply.code(502).send({ error: "bridge_error", message });
        }
      },
    },
  );

  // POST /bridge/tasks — enqueue a task (internal use by /queries processor)
  app.post<{
    Body: { kind: string; args?: Record<string, unknown> };
  }>("/bridge/tasks", {
    schema: {
      tags: ["bridge"],
      summary: "Enqueue a bridge task",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const { kind, args = {} } = req.body ?? {};
      if (!kind) return reply.code(422).send({ error: "kind is required" });
      if (!isBridgeTaskKind(kind) && !isLocalOnlyTaskKind(kind)) {
        return reply.code(422).send({
          error: "unsupported_kind",
          supported_bridge_kinds: BRIDGE_TASK_KINDS,
          supported_local_kinds: LOCAL_ONLY_TASK_KINDS,
        });
      }

      const id = Math.random().toString(36).slice(2);
      const task: BridgeTask = {
        id,
        kind,
        args,
        enqueuedAt: new Date(),
        status: "pending",
      };

      taskQueue.push(task);
      taskMap.set(id, task);

      if (isLocalOnlyTaskKind(kind)) {
        void executeLocalTool(kind, args, { userId: auth.userId })
          .then((result) => {
            task.status = "done";
            task.result = result;
          })
          .catch((error) => {
            task.status = "error";
            task.errorMessage = error instanceof Error ? error.message : "Tool execution failed";
          });
      }

      reply.code(201).send({ id });
    },
  });

  // GET /integrations/home_assistant/status — CLI status check
  app.get("/integrations/home_assistant/status", async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;

    const haUrl = process.env.HOME_ASSISTANT_URL;
    if (!haUrl) return reply.code(404).send({ error: "not_configured" });

    try {
      const res = await fetch(haUrl + "/api/", {
        headers: {
          Authorization: `Bearer ${process.env.HOME_ASSISTANT_TOKEN ?? ""}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      reply.send({ connected: res.ok, url: haUrl });
    } catch {
      reply.send({ connected: false, url: haUrl });
    }
  });
}
