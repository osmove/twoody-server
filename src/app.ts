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
import { queryRoutes } from "./routes/queries.js";
import { deviceRoutes } from "./routes/devices.js";
import { providerRoutes } from "./routes/providers.js";
import { bridgeRoutes } from "./routes/bridge.js";
import { realtimeRoutes } from "./routes/realtime.js";
import { memberRoutes } from "./routes/members.js";
import { toolCallRoutes } from "./routes/toolCalls.js";
import { meRoutes } from "./routes/me.js";
import { agentRoutes } from "./routes/agents.js";
import { localLlmRoutes } from "./routes/localLlm.js";
import { builtInCapabilitiesRoutes } from "./routes/builtInCapabilities.js";
import { discussionRoutes } from "./routes/discussions.js";
import { memoryRoutes } from "./routes/memories.js";
import { noteRoutes } from "./routes/notes.js";
import { reminderRoutes } from "./routes/reminders.js";
import { taskRoutes } from "./routes/tasks.js";
import { voiceRoutes } from "./routes/voices.js";
import { wsRoutes } from "./routes/ws.js";

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  await app.register(cors, {
    origin: true,
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
  await app.register(discussionRoutes);
  await app.register(memoryRoutes);
  await app.register(taskRoutes);
  await app.register(reminderRoutes);
  await app.register(noteRoutes);
  await app.register(builtInCapabilitiesRoutes);
  await app.register(voiceRoutes);
  await app.register(wsRoutes);

  // Versioned aliases for API clients migrating away from root-level
  // Rails-style paths. Health, docs, admin, MCP and WebSocket routes stay
  // at the root; the HTTP API surface gets `/api/v1`.
  await app.register(capabilitiesRoutes, { prefix: "/api/v1" });
  await app.register(deploymentRoutes, { prefix: "/api/v1" });
  await app.register(sessionRoutes, { prefix: "/api/v1" });
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
  await app.register(discussionRoutes, { prefix: "/api/v1" });
  await app.register(memoryRoutes, { prefix: "/api/v1" });
  await app.register(taskRoutes, { prefix: "/api/v1" });
  await app.register(reminderRoutes, { prefix: "/api/v1" });
  await app.register(noteRoutes, { prefix: "/api/v1" });
  await app.register(builtInCapabilitiesRoutes, { prefix: "/api/v1" });
  await app.register(voiceRoutes, { prefix: "/api/v1" });

  app.get("/admin", {
    schema: {
      tags: ["health"],
      summary: "Admin placeholder UI",
      response: { 200: { type: "string" } },
    },
    handler: async (_req, reply) => {
      reply.type("text/html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Twoody Server</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 1.5rem; }
    .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #22c55e; margin-right: .5rem; }
    code { background: #f4f4f4; padding: .1rem .3rem; border-radius: 3px; font-size: .9em; }
    a { color: #3b82f6; }
  </style>
</head>
<body>
  <h1><span class="status"></span>Twoody Server</h1>
  <p>Server is running. Create a local account, then pair using <code>twoody setup</code> or a device client.</p>
  <ul>
    <li><a href="/health">/health</a> — server status</li>
    <li><a href="/docs">/docs</a> — interactive API docs</li>
    <li><a href="/openapi.json">/openapi.json</a> — OpenAPI contract</li>
  </ul>
  <p style="color:#666;font-size:.85em">
    Full documentation: <a href="https://github.com/twoody/server">github.com/twoody/server</a>
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
      const mcpUrl = process.env.TWOODY_MCP_URL;
      if (!mcpUrl) {
        return reply.code(501).send({
          error: "MCP server not configured",
          hint: "Set TWOODY_MCP_URL or run `twoody mcp` separately",
        });
      }

      const upstream = await fetch(mcpUrl, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method !== "GET" ? JSON.stringify(req.body) : undefined,
      });

      reply.code(upstream.status);
      const body = await upstream.text();
      reply.send(body);
    },
  });

  return app;
}
