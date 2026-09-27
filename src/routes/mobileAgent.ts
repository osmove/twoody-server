import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { authenticate } from "../auth.js";
import { authSessions, db } from "../db.js";
import { askDesktopAgent } from "../mobileAgentBridge.js";

export async function mobileAgentRoutes(app: FastifyInstance, options: { request?: typeof askDesktopAgent } = {}) {
  const request = options.request ?? askDesktopAgent;
  async function owner(req: FastifyRequest, reply: FastifyReply) {
    const auth = await authenticate(req);
    if (!auth) { reply.code(401).send({ error: "Unauthorized" }); return null; }
    const session = auth.sessionId ? db.select().from(authSessions).where(eq(authSessions.id, auth.sessionId)).get() : null;
    if (!session?.clientKind.startsWith("pair:")) { reply.code(403).send({ error: "paired_device_required" }); return null; }
    return `${auth.userId}:${session.id}`;
  }
  async function call(req: FastifyRequest, reply: FastifyReply, command: string, input: Record<string, unknown>) {
    const principal = await owner(req, reply); if (!principal) return;
    try { return await request(principal, command, input); }
    catch (error) {
      const code = error instanceof Error ? error.message : "agent_unavailable";
      const known = ["desktop_required", "local_model_required", "folder_unavailable", "session_unavailable", "approval_unavailable", "agent_busy", "agent_timeout", "invalid_request", "request_conflict"];
      return reply.code(code === "agent_busy" || code === "request_conflict" ? 409 : 503).send({ error: known.includes(code) ? code : "agent_unavailable" });
    }
  }
  app.get("/mobile_agent", { schema: { tags: ["agent"], summary: "Agent folders explicitly granted on the paired desktop" } }, (req, reply) => call(req, reply, "list", {}));
  app.post<{ Body: { command: string; sessionId?: string; folderId?: string; text?: string; requestId?: string; model?: string; callId?: string; decision?: string } }>("/mobile_agent", {
    schema: { tags: ["agent"], summary: "Run or review a paired desktop Agent turn", body: { type: "object", additionalProperties: false, required: ["command"], properties: {
      command: { type: "string", enum: ["send", "session", "approve", "stop"] },
      sessionId: { type: "string", maxLength: 80 }, folderId: { type: "string", maxLength: 80 },
      text: { type: "string", minLength: 1, maxLength: 16000 }, requestId: { type: "string", pattern: "^[a-zA-Z0-9_-]{16,80}$" },
      model: { type: "string", maxLength: 200 }, callId: { type: "string", maxLength: 200 }, decision: { type: "string", enum: ["allow", "deny"] },
    } } },
  }, (req, reply) => call(req, reply, req.body.command, req.body));
}
