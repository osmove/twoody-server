import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { authenticate } from "../auth.js";
import { authSessions, db } from "../db.js";
import { desktopRemoteCode, type RemoteCodeBridge, type RemoteCodeSignal } from "../remoteCodeBridge.js";

// Twoody Code on this computer, driven from a paired phone. The Desktop
// app decides what is allowed (only while the person turned it on, only
// folders already open in Code — or, behind a second switch, folders of
// the home folder the phone browses, creates and opens there
// (twoody-desktop src/main/code/remoteFolders.ts) — every change and
// command asked, one decision at a time); this checks who asks — a phone
// paired with this computer, nothing else — and carries the answers and
// the events. It never touches a folder itself.

export interface RemoteCodeRouteOptions {
  /// The Desktop's Code (tests pass their own); null: not running under it.
  bridge?: () => RemoteCodeBridge | null;
  /// A stream ends after this long or this many bytes: the tunnel caps a
  /// response at 32 MB. The phone opens another and gets a fresh snapshot.
  streamMs?: number;
  streamBytes?: number;
}

const STATUS: Record<string, number> = {
  invalid_request: 400,
  invalid_name: 400,
  remote_code_off: 403,
  new_folders_off: 403,
  folder_refused: 403,
  folder_unavailable: 404,
  folder_exists: 409,
  session_unavailable: 404,
  approval_unavailable: 404,
  process_unavailable: 404,
  workspace_unavailable: 404,
  session_busy: 409,
  request_conflict: 409,
  local_model_required: 409,
  send_failed: 500,
  desktop_unavailable: 503,
  desktop_busy: 503,
  desktop_timeout: 503,
};

const STREAMED = new Set(["item", "output", "todos", "state", "approval", "usage", "session", "process", "process-output"]);
/// Event names as the phone reads them.
const EVENT_NAME: Record<string, string> = { "process-output": "process_output" };
const PROCESS_ID = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,40}$" };
const SESSION_ID = { type: "string", pattern: "^[0-9a-f-]{36}$" };
const REQUEST_ID = { type: "string", pattern: "^[a-zA-Z0-9_-]{16,80}$" };
const TEXT = { type: "string", minLength: 1, maxLength: 16000 };
const MODE = { type: "string", enum: ["ask", "auto-edit", "plan"] };
/// A folder as the phone names it: a root's id (the home folder, the
/// usual places) and a path relative to it; the Desktop checks the rest.
const FOLDER_ROOT = { type: "string", pattern: "^[a-z]{1,20}(-[0-9]{1,3})?$" };
const FOLDER_PATH = { type: "string", maxLength: 4096 };
const FOLDER_NAME = { type: "string", minLength: 1, maxLength: 255 };

function withoutSeq(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const { seq: _seq, ...rest } = snapshot as Record<string, unknown>;
  return rest;
}

export async function remoteCodeRoutes(app: FastifyInstance, options: RemoteCodeRouteOptions = {}) {
  const bridgeOf = options.bridge ?? desktopRemoteCode;
  const streamMs = options.streamMs ?? 10 * 60_000;
  const streamBytes = options.streamBytes ?? 8 * 1024 * 1024;

  /// The bridge, for a paired phone; null once an error was sent.
  async function paired(req: FastifyRequest, reply: FastifyReply): Promise<RemoteCodeBridge | null> {
    const auth = await authenticate(req);
    if (!auth) {
      reply.code(401).send({ error: "Unauthorized" });
      return null;
    }
    const session = auth.sessionId ? db.select().from(authSessions).where(eq(authSessions.id, auth.sessionId)).get() : null;
    if (!session?.clientKind.startsWith("pair:")) {
      reply.code(403).send({ error: "not_paired_phone" });
      return null;
    }
    const bridge = bridgeOf();
    if (!bridge) {
      reply.code(503).send({ error: "desktop_unavailable" });
      return null;
    }
    return bridge;
  }

  function failed(reply: FastifyReply, error: unknown) {
    const code = error instanceof Error ? error.message : "";
    if (STATUS[code]) return reply.code(STATUS[code]).send({ error: code });
    return reply.code(500).send({ error: "remote_code_failed" });
  }

  async function call(req: FastifyRequest, reply: FastifyReply, command: string, input: Record<string, unknown>, status = 200, shape: (result: unknown) => unknown = (result) => result) {
    const bridge = await paired(req, reply);
    if (!bridge) return reply;
    try {
      return reply.code(status).send(shape(await bridge.ask(command, input)));
    } catch (error) {
      return failed(reply, error);
    }
  }

  const tags = ["code"];
  const security = [{ bearerAuth: [] }];

  app.get("/code/sessions", {
    schema: { tags, security, summary: "Twoody Code: folders open on this computer and their sessions (paired phone)" },
  }, (req, reply) => call(req, reply, "list", {}));

  // Other folders (Desktop 0.13.80 and later), once the person allowed it.
  app.get("/code/folders", {
    schema: { tags, security, summary: "Twoody Code: whether the phone may open other folders, and where it may browse (paired phone)" },
  }, (req, reply) => call(req, reply, "folders", {}));

  app.get<{ Querystring: { root: string; path?: string } }>("/code/folders/browse", {
    schema: {
      tags, security, summary: "Twoody Code: the folders inside one (never its files)",
      querystring: { type: "object", additionalProperties: false, required: ["root"], properties: { root: FOLDER_ROOT, path: FOLDER_PATH } },
    },
  }, (req, reply) => call(req, reply, "browseFolder", { root: req.query.root, path: req.query.path ?? "" }));

  app.post<{ Body: { root: string; path?: string; name: string } }>("/code/folders", {
    schema: {
      tags, security, summary: "Twoody Code: create a folder, one level, inside one the phone may browse",
      body: { type: "object", additionalProperties: false, required: ["root", "name"], properties: { root: FOLDER_ROOT, path: FOLDER_PATH, name: FOLDER_NAME } },
    },
  }, (req, reply) => call(req, reply, "createFolder", { root: req.body.root, path: req.body.path ?? "", name: req.body.name }, 201));

  app.post<{ Body: { root: string; path?: string } }>("/code/folders/open", {
    schema: {
      tags, security, summary: "Twoody Code: open a folder in Code, to start a session there",
      body: { type: "object", additionalProperties: false, required: ["root"], properties: { root: FOLDER_ROOT, path: FOLDER_PATH } },
    },
  }, (req, reply) => call(req, reply, "openFolder", { root: req.body.root, path: req.body.path ?? "" }));

  app.get<{ Params: { id: string } }>("/code/sessions/:id", {
    schema: { tags, security, summary: "Twoody Code: one session, its items and pending decisions", params: { type: "object", required: ["id"], properties: { id: SESSION_ID } } },
  }, (req, reply) => call(req, reply, "session", { sessionId: req.params.id }, 200, withoutSeq));

  app.post<{ Body: { workspace: string; text: string; mode?: string; request_id?: string } }>("/code/sessions", {
    schema: {
      tags, security, summary: "Twoody Code: start a session in a folder already open in Code",
      body: { type: "object", additionalProperties: false, required: ["workspace", "text"], properties: { workspace: { type: "string", minLength: 1, maxLength: 4096 }, text: TEXT, mode: MODE, request_id: REQUEST_ID } },
    },
  }, (req, reply) => call(req, reply, "send", { workspace: req.body.workspace, text: req.body.text, mode: req.body.mode, requestId: req.body.request_id }, 201));

  app.post<{ Params: { id: string }; Body: { text: string; mode?: string; request_id?: string } }>("/code/sessions/:id/messages", {
    schema: {
      tags, security, summary: "Twoody Code: continue a session",
      params: { type: "object", required: ["id"], properties: { id: SESSION_ID } },
      body: { type: "object", additionalProperties: false, required: ["text"], properties: { text: TEXT, mode: MODE, request_id: REQUEST_ID } },
    },
  }, (req, reply) => call(req, reply, "send", { sessionId: req.params.id, text: req.body.text, mode: req.body.mode, requestId: req.body.request_id }, 202));

  app.post<{ Params: { id: string; callId: string }; Body: { decision: "allow" | "deny"; reason?: string } }>("/code/sessions/:id/approvals/:callId", {
    schema: {
      tags, security, summary: "Twoody Code: allow or deny one pending step",
      params: { type: "object", required: ["id", "callId"], properties: { id: SESSION_ID, callId: { type: "string", minLength: 1, maxLength: 200 } } },
      body: { type: "object", additionalProperties: false, required: ["decision"], properties: { decision: { type: "string", enum: ["allow", "deny"] }, reason: { type: "string", maxLength: 1000 } } },
    },
  }, (req, reply) => call(req, reply, "approve", { sessionId: req.params.id, callId: req.params.callId, decision: req.body.decision, reason: req.body.reason }));

  app.post<{ Params: { id: string } }>("/code/sessions/:id/stop", {
    schema: { tags, security, summary: "Twoody Code: stop the session's request", params: { type: "object", required: ["id"], properties: { id: SESSION_ID } } },
  }, (req, reply) => call(req, reply, "stop", { sessionId: req.params.id }));

  app.post<{ Params: { id: string; processId: string } }>("/code/sessions/:id/processes/:processId/stop", {
    schema: {
      tags, security, summary: "Twoody Code: stop a process the session keeps running in the background",
      params: { type: "object", required: ["id", "processId"], properties: { id: SESSION_ID, processId: PROCESS_ID } },
    },
  }, (req, reply) => call(req, reply, "stopProcess", { sessionId: req.params.id, id: req.params.processId }));

  // The session as it goes: a snapshot, then Code's events for it.
  app.post<{ Params: { id: string } }>("/code/sessions/:id/stream", {
    schema: { tags, security, summary: "Twoody Code: follow a session (text/event-stream)", params: { type: "object", required: ["id"], properties: { id: SESSION_ID } } },
  }, async (req, reply) => {
    const bridge = await paired(req, reply);
    if (!bridge) return reply;
    const id = req.params.id;

    // Heard from before the snapshot is asked for, so nothing falls
    // between the two; what the snapshot already holds is dropped below.
    const early: RemoteCodeSignal[] = [];
    let forward: ((signal: RemoteCodeSignal) => void) | null = null;
    const unfollow = bridge.follow((signal) => (forward ? forward(signal) : early.push(signal)));
    let snapshot: unknown;
    try {
      snapshot = await bridge.ask("session", { sessionId: id });
    } catch (error) {
      unfollow();
      return failed(reply, error);
    }
    const seen = typeof (snapshot as { seq?: unknown })?.seq === "number" ? (snapshot as { seq: number }).seq : -1;

    reply.hijack();
    const raw = reply.raw;
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) raw.setHeader(name, value);
    }
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // 8 KB of padding: iOS's URLSession holds the first 4 KB back.
    raw.write(":" + " ".repeat(8192) + "\n\n");

    let written = 0;
    let done = false;
    const keepalive = setInterval(() => raw.write(": ping\n\n"), 15_000);
    const timer = setTimeout(() => finish("time"), streamMs);
    function finish(reason: string | null) {
      if (done) return;
      done = true;
      unfollow();
      clearInterval(keepalive);
      clearTimeout(timer);
      if (reason && !raw.destroyed) raw.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
      raw.end();
    }
    function send(name: string, data: unknown) {
      if (done) return;
      const chunk = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      raw.write(chunk);
      written += Buffer.byteLength(chunk);
      if (written > streamBytes) finish("size");
    }
    raw.on("close", () => finish(null));

    send("snapshot", withoutSeq(snapshot));
    forward = (signal) => {
      if (signal.type === "off") {
        send("off", { error: "remote_code_off" });
        finish(null);
        return;
      }
      if (signal.seq <= seen || signal.event.sessionId !== id || !STREAMED.has(signal.event.type)) return;
      const { type, ...data } = signal.event;
      send(EVENT_NAME[type] ?? type, data);
    };
    for (const signal of early.splice(0)) forward(signal);
  });
}
