import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";

// Bridge task queue — in-memory for Phase 1
// Phase 2 will move this to Redis for multi-process support
interface BridgeTask {
  id: string;
  kind: string;
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

export async function bridgeRoutes(app: FastifyInstance) {
  // GET /bridge/tasks/next — Mac app long-polls this
  app.get<{ Querystring: { wait?: string } }>(
    "/bridge/tasks/next",
    async (req, reply) => {
      const deviceId = req.headers["x-bridge-device-id"] as string | undefined;
      const nickname = req.headers["x-bridge-device-nickname"] as string | undefined;

      // Record presence
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

        // Poll every 500ms
        await new Promise((r) => setTimeout(r, 500));
      }
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
  }>("/bridge/tasks/:id", async (req, reply) => {
    const task = taskMap.get(req.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });

    task.status = req.body.status;
    if (req.body.delta) task.delta = (task.delta ?? "") + req.body.delta;
    if (req.body.result) task.result = req.body.result;
    if (req.body.error_message) task.errorMessage = req.body.error_message;

    reply.code(204).send();
  });

  // GET /bridge/tasks/:id — clients poll for task completion
  app.get<{ Params: { id: string } }>("/bridge/tasks/:id", async (req, reply) => {
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
  });

  // GET /bridge/presence — CLI status check
  app.get("/bridge/presence", async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;

    const cutoff = new Date(Date.now() - 90_000); // 90s window (3× the 25s poll)
    const active = [...bridgePresence.entries()].filter(
      ([, v]) => v.lastSeen > cutoff
    );

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
  });

  // GET /bridge/folders — list granted local folders (stub for phase 1)
  app.get("/bridge/folders.json", async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;
    reply.send({ folders: [], note: "Mac Bridge not connected" });
  });

  // POST /bridge/tasks — enqueue a task (internal use by /queries processor)
  app.post<{
    Body: { kind: string; args?: Record<string, unknown> };
  }>("/bridge/tasks", async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;

    const { kind, args = {} } = req.body ?? {};
    if (!kind) return reply.code(422).send({ error: "kind is required" });

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

    reply.code(201).send({ id });
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
