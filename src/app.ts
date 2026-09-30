import { mobileAgentRoutes } from "./routes/mobileAgent.js";
import { remoteCodeRoutes } from "./routes/remoteCode.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import { healthRoutes } from "./routes/health.js";
import { capabilitiesRoutes } from "./routes/capabilities.js";
import { deploymentRoutes } from "./routes/deployment.js";
import { sessionRoutes } from "./routes/session.js";
import { pairedDeviceRoutes } from "./routes/pairedDevices.js";
import { queryRoutes } from "./routes/queries.js";
import { deviceRoutes } from "./routes/devices.js";
import { providerRoutes } from "./routes/providers.js";
import { bridgeRoutes, bridgeSnapshot } from "./routes/bridge.js";
import { bridgeClientHistory, readBridgeClientEnv } from "./bridgeClient.js";
import { hostname as osHostname } from "node:os";
import { realtimeRoutes } from "./routes/realtime.js";
import { memberRoutes } from "./routes/members.js";
import { toolCallRoutes } from "./routes/toolCalls.js";
import { meRoutes } from "./routes/me.js";
import { agentRoutes } from "./routes/agents.js";
import { localLlmRoutes } from "./routes/localLlm.js";
import { llmModelsRoutes } from "./routes/llmModels.js";
import { builtInCapabilitiesRoutes } from "./routes/builtInCapabilities.js";
import { calendarEventRoutes } from "./routes/calendarEvents.js";
import { contactRoutes } from "./routes/contacts.js";
import { localSyncRoutes } from "./routes/localSync.js";
import { discussionRoutes } from "./routes/discussions.js";
import { memoryRoutes } from "./routes/memories.js";
import { usageRoutes } from "./routes/usage.js";
import { noteRoutes } from "./routes/notes.js";
import { reminderRoutes } from "./routes/reminders.js";
import { taskRoutes } from "./routes/tasks.js";
import { transcriptionRoutes } from "./routes/transcriptions.js";
import { voiceRoutes } from "./routes/voices.js";
import { wsRoutes } from "./routes/ws.js";
import { tunnelDirectRoutes } from "./routes/tunnelDirect.js";
import { localDocumentRoutes } from "./routes/localDocuments.js";
import { accountLinkRoutes } from "./routes/accountLink.js";
import { peerRoutes } from "./routes/peer.js";
import { peersRoutes } from "./routes/peers.js";
import { peerDocumentRoutes } from "./routes/peerDocuments.js";
import { runtimeRoutes } from "./routes/runtime.js";
import { requireAdminAccess } from "./adminAccess.js";
import { requireAuth } from "./auth.js";
import { outboundFetch } from "./outbound.js";
import { enforcePeerScope } from "./peerSessions.js";
import { corsOriginAllowed, hostGuard } from "./webOrigin.js";

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  // A request that says it carries JSON and carries nothing is refused
  // by Fastify 5, where Fastify 4 shrugged. That is defensible in the
  // abstract and wrong here: the mobile app's `apiDelete` sets
  // `Content-Type: application/json` on every call and sends no body,
  // so upgrading would have answered 400 to every deletion from a
  // phone. An empty body is read as no body, which is what it is.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body.trim() : "";
    if (text === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      const failure = err as Error & { statusCode?: number };
      failure.statusCode = 400;
      done(failure, undefined);
    }
  });

  // Only the names this server goes by (webOrigin.ts): a web page that
  // rebinds its own domain to this machine is refused before anything.
  app.addHook("onRequest", hostGuard);
  // A WebSocket upgrade refused by a hook (a wrong Host, a peer session)
  // is answered on the raw socket, which nothing else would ever close.
  app.addHook("onResponse", async (req, reply) => {
    if (req.headers.upgrade && reply.statusCode >= 400) req.raw.socket?.destroy();
  });

  // Another computer of the account, paired as a peer, reaches
  // /api/v1/peer/* and nothing else (peerSessions.ts).
  app.addHook("onRequest", enforcePeerScope);

  // Answers readable by the Desktop's window and pages served from this
  // machine, not by any site (webOrigin.ts).
  await app.register(cors, {
    origin: (origin, callback) => callback(null, corsOriginAllowed(origin)),
    credentials: true,
  });

  // Multipart upload support — `/queries` accepts an inline audio_file
  // from the watch / iPhone voice path, parsed as a Buffer for
  // shell-out to whisper-cpp. 25 MB ceiling matches OpenAI's
  // /v1/audio/transcriptions limit so a recording too long for the
  // cloud also gets rejected here, with a clear error.
  await app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024,
      files: 1,
    },
  });

  // WebSocket plumbing — `/ws` fans out per-user server events
  // (discussion created/touched, message appended) so the chat UI
  // refreshes without polling. The plugin owns the upgrade
  // handshake; route logic lives in `routes/ws.ts`.
  await app.register(websocket);

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Twoody Server API",
        description: "Local-first API surface for Twoody Server.",
        version: "0.1.0",
      },
      servers: [{ url: "http://localhost:3000" }],
      tags: [
        { name: "health", description: "Server health and status" },
        { name: "session", description: "Pairing and auth sessions" },
        { name: "queries", description: "SSE chat and inference routes" },
        { name: "devices", description: "Device pairing and firmware routes" },
        { name: "providers", description: "Local-first LLM providers" },
        { name: "bridge", description: "Mac Bridge polling and task queue" },
        { name: "realtime", description: "Realtime voice session proxies" },
        { name: "members", description: "Household members and enrollment assets" },
        { name: "documents", description: "Granted folders, local index and search" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "Bearer token",
          },
          userTokenAuth: {
            type: "apiKey",
            in: "header",
            name: "X-User-Token",
          },
        },
      },
    },
  });

  await app.register(swaggerUi, { routePrefix: "/docs" });

  await app.register(healthRoutes);
  await app.register(capabilitiesRoutes);
  await app.register(deploymentRoutes);
  await app.register(sessionRoutes);
  await app.register(pairedDeviceRoutes);
  await app.register(queryRoutes);
  await app.register(deviceRoutes);
  await app.register(providerRoutes);
  await app.register(bridgeRoutes);
  await app.register(realtimeRoutes);
  await app.register(memberRoutes);
  await app.register(toolCallRoutes);
  await app.register(meRoutes);
  await app.register(agentRoutes);
  await app.register(localLlmRoutes);
  await app.register(llmModelsRoutes);
  await app.register(calendarEventRoutes);
  await app.register(contactRoutes);
  await app.register(localSyncRoutes);
  await app.register(discussionRoutes);
  await app.register(memoryRoutes);
  await app.register(usageRoutes);
  await app.register(taskRoutes);
  await app.register(reminderRoutes);
  await app.register(noteRoutes);
  await app.register(builtInCapabilitiesRoutes);
  await app.register(voiceRoutes);
  await app.register(transcriptionRoutes);
  await app.register(localDocumentRoutes);
  await app.register(wsRoutes);
  await app.register(tunnelDirectRoutes);
  await app.register(remoteCodeRoutes);
  await app.register(accountLinkRoutes);
  await app.register(runtimeRoutes);

  // Versioned aliases for API clients migrating away from root-level
  // Rails-style paths. Health, docs, admin, MCP and WebSocket routes stay
  // at the root; the HTTP API surface gets `/api/v1`.
  await app.register(capabilitiesRoutes, { prefix: "/api/v1" });
  await app.register(deploymentRoutes, { prefix: "/api/v1" });
  await app.register(sessionRoutes, { prefix: "/api/v1" });
  await app.register(pairedDeviceRoutes, { prefix: "/api/v1" });
  await app.register(queryRoutes, { prefix: "/api/v1" });
  await app.register(deviceRoutes, { prefix: "/api/v1" });
  await app.register(providerRoutes, { prefix: "/api/v1" });
  await app.register(bridgeRoutes, { prefix: "/api/v1" });
  await app.register(realtimeRoutes, { prefix: "/api/v1" });
  await app.register(memberRoutes, { prefix: "/api/v1" });
  await app.register(toolCallRoutes, { prefix: "/api/v1" });
  await app.register(meRoutes, { prefix: "/api/v1" });
  await app.register(agentRoutes, { prefix: "/api/v1" });
  await app.register(localLlmRoutes, { prefix: "/api/v1" });
  await app.register(llmModelsRoutes, { prefix: "/api/v1" });
  await app.register(calendarEventRoutes, { prefix: "/api/v1" });
  await app.register(contactRoutes, { prefix: "/api/v1" });
  await app.register(localSyncRoutes, { prefix: "/api/v1" });
  await app.register(discussionRoutes, { prefix: "/api/v1" });
  await app.register(memoryRoutes, { prefix: "/api/v1" });
  await app.register(usageRoutes, { prefix: "/api/v1" });
  await app.register(taskRoutes, { prefix: "/api/v1" });
  await app.register(reminderRoutes, { prefix: "/api/v1" });
  await app.register(noteRoutes, { prefix: "/api/v1" });
  await app.register(builtInCapabilitiesRoutes, { prefix: "/api/v1" });
  await app.register(voiceRoutes, { prefix: "/api/v1" });
  await app.register(transcriptionRoutes, { prefix: "/api/v1" });
  await app.register(localDocumentRoutes, { prefix: "/api/v1" });
  await app.register(mobileAgentRoutes, { prefix: "/api/v1" });
  await app.register(remoteCodeRoutes, { prefix: "/api/v1" });
  await app.register(accountLinkRoutes, { prefix: "/api/v1" });
  await app.register(runtimeRoutes, { prefix: "/api/v1" });
  // The account's other computers: what this one answers them
  // (/api/v1/peer/*), and those it sends questions to (/api/v1/peers).
  await app.register(peerRoutes, { prefix: "/api/v1" });
  await app.register(peersRoutes, { prefix: "/api/v1" });
  // This computer's documents, for the account's computers it trusts
  // (docs/mesh-design.md §2).
  await app.register(peerDocumentRoutes, { prefix: "/api/v1" });

  app.get("/admin", {
    schema: {
      tags: ["health"],
      summary: "Admin dashboard (server status + recent bridge activity)",
      response: { 200: { type: "string" } },
    },
    handler: async (req, reply) => {
      if (!requireAdminAccess(req, reply)) return;

      const snapshot = bridgeSnapshot();
      const bridgeOpts = readBridgeClientEnv();
      const upstream = bridgeOpts?.backendUrl ?? null;
      const advertisedCaps = bridgeOpts?.capabilities ?? [];
      const hostname = osHostname();

      const escape = (value: unknown) =>
        String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");

      const taskRows = snapshot.recent.length === 0
        ? `<tr><td colspan="4" class="muted">No bridge tasks yet.</td></tr>`
        : snapshot.recent.map((task) => `
          <tr class="status-${task.status}">
            <td><code>${escape(task.id.slice(0, 8))}</code></td>
            <td>${escape(task.kind)}</td>
            <td>${escape(task.status)}${task.error_message ? ` <span class="muted">— ${escape(task.error_message.slice(0, 80))}</span>` : ""}</td>
            <td class="muted">${escape(task.enqueued_at)}</td>
          </tr>`).join("");

      const clientHistory = bridgeClientHistory();
      const clientRows = clientHistory.length === 0
        ? `<tr><td colspan="5" class="muted">No upstream tasks claimed yet.</td></tr>`
        : clientHistory.map((entry) => `
          <tr class="status-${entry.status}">
            <td><code>${escape(entry.id.slice(0, 8))}</code></td>
            <td>${escape(entry.kind)}</td>
            <td>${escape(entry.status)}${entry.error_message ? ` <span class="muted">— ${escape(entry.error_message.slice(0, 80))}</span>` : ""}</td>
            <td class="muted">${entry.elapsed_ms != null ? `${entry.elapsed_ms} ms` : "—"}</td>
            <td class="muted">${escape(entry.claimed_at)}</td>
          </tr>`).join("");

      const presenceRows = snapshot.presence.length === 0
        ? `<tr><td colspan="3" class="muted">No external bridge workers polling.</td></tr>`
        : snapshot.presence.map((entry) => `
          <tr>
            <td>${escape(entry.nickname ?? entry.device_id.slice(0, 8))}</td>
            <td>${entry.capabilities.map((c) => `<code>${escape(c)}</code>`).join(" ")}</td>
            <td class="muted">${escape(entry.last_seen)}</td>
          </tr>`).join("");

      const capsHtml = advertisedCaps.length === 0
        ? `<span class="muted">none — set TWOODY_SELF_BRIDGE=1 + BRIDGE_LOCAL_LLM_ENDPOINT + HOME_ASSISTANT_URL etc.</span>`
        : advertisedCaps.map((c) => `<code>${escape(c)}</code>`).join(" ");

      reply.type("text/html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Twoody Server — ${escape(hostname)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="10">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 980px; margin: 2rem auto; padding: 0 1rem; color: #1f2937; }
    h1 { font-size: 1.5rem; }
    h2 { font-size: 1rem; margin-top: 2rem; border-bottom: 1px solid #e5e7eb; padding-bottom: .25rem; }
    .green { color: #22c55e; }
    .muted { color: #6b7280; font-size: .9em; }
    code { background: #f3f4f6; padding: .1rem .35rem; border-radius: 3px; font-size: .85em; }
    table { width: 100%; border-collapse: collapse; font-size: .9em; }
    th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
    th { color: #6b7280; font-weight: 500; font-size: .8em; text-transform: uppercase; letter-spacing: .04em; }
    tr.status-done td { }
    tr.status-error td { background: #fef2f2; }
    tr.status-pending td, tr.status-streaming td { background: #fffbeb; }
    .pair { display: grid; grid-template-columns: 180px 1fr; gap: .25rem .75rem; margin: .5rem 0; }
    a { color: #3b82f6; }
  </style>
</head>
<body>
  <h1><span class="green">●</span> Twoody Server <span class="muted">— ${escape(hostname)}</span></h1>

  <div class="pair">
    <div class="muted">Upstream backend</div>
    <div>${upstream ? `<code>${escape(upstream)}</code>` : `<span class="muted">none (local-only mode)</span>`}</div>
    <div class="muted">Advertised capabilities</div>
    <div>${capsHtml}</div>
  </div>

  <h2>External bridge workers (polling this server)</h2>
  <table>
    <thead><tr><th>Device</th><th>Capabilities</th><th>Last seen</th></tr></thead>
    <tbody>${presenceRows}</tbody>
  </table>

  <h2>Tasks this Pi claimed from the upstream backend (last 50)</h2>
  <table>
    <thead><tr><th>ID</th><th>Kind</th><th>Status</th><th>Elapsed</th><th>Claimed</th></tr></thead>
    <tbody>${clientRows}</tbody>
  </table>

  <h2>Local in-process bridge tasks (last 50)</h2>
  <p class="muted">Enqueued directly to this server (e.g. CLI / Desktop on the LAN).</p>
  <table>
    <thead><tr><th>ID</th><th>Kind</th><th>Status</th><th>Enqueued</th></tr></thead>
    <tbody>${taskRows}</tbody>
  </table>

  <p class="muted" style="margin-top:2rem">
    Auto-refresh every 10 s ·
    <a href="/health">/health</a> ·
    <a href="/docs">/docs</a> ·
    <a href="/openapi.json">/openapi.json</a>
  </p>
</body>
</html>`);
    },
  });

  app.get("/openapi.json", {
    schema: {
      tags: ["health"],
      summary: "OpenAPI contract",
      response: { 200: { type: "object", additionalProperties: true } },
    },
    handler: async (_req, reply) => {
      reply.send(app.swagger());
    },
  });

  app.all("/mcp", {
    schema: {
      tags: ["queries"],
      summary: "Proxy to external MCP server",
      description: "Forwards requests to TWOODY_MCP_URL when configured.",
    },
    handler: async (req, reply) => {
      // The MCP adapter behind this proxy acts with the user's own
      // token, so an open proxy would hand every tool to anyone who can
      // reach the port.
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const mcpUrl = process.env.TWOODY_MCP_URL;
      if (!mcpUrl) {
        return reply.code(501).send({
          error: "MCP server not configured",
          hint: "Set TWOODY_MCP_URL or run `twoody mcp` separately",
        });
      }

      // Forward only what MCP's HTTP transport needs. The caller's
      // Twoody bearer stays here, and hop-by-hop headers such as `host`
      // or `content-length` no longer describe the re-serialized body.
      const forwarded: Record<string, string> = {};
      for (const name of ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
        const value = req.headers[name];
        if (typeof value === "string") forwarded[name] = value;
      }

      const upstream = await outboundFetch(mcpUrl, {
        method: req.method,
        headers: forwarded,
        body: req.method !== "GET" ? JSON.stringify(req.body) : undefined,
      });

      reply.code(upstream.status);
      for (const name of ["content-type", "mcp-session-id"]) {
        const value = upstream.headers.get(name);
        if (value) reply.header(name, value);
      }
      const body = await upstream.text();
      reply.send(body);
    },
  });

  return app;
}
