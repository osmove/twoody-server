import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { healthRoutes } from "./routes/health.js";
import { sessionRoutes } from "./routes/session.js";
import { queryRoutes } from "./routes/queries.js";
import { deviceRoutes } from "./routes/devices.js";
import { bridgeRoutes } from "./routes/bridge.js";
import { realtimeRoutes } from "./routes/realtime.js";

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Twoody Local Server API",
        description: "Self-hosted API surface for Twoody Local.",
        version: "0.1.0",
      },
      servers: [{ url: "http://localhost:3000" }],
      tags: [
        { name: "health", description: "Server health and status" },
        { name: "session", description: "Pairing and auth sessions" },
        { name: "queries", description: "SSE chat and inference routes" },
        { name: "devices", description: "Device pairing and firmware routes" },
        { name: "bridge", description: "Mac Bridge polling and task queue" },
        { name: "realtime", description: "Realtime voice session proxies" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "Bearer token",
          },
        },
      },
    },
  });

  await app.register(swaggerUi, { routePrefix: "/docs" });

  await app.register(healthRoutes);
  await app.register(sessionRoutes);
  await app.register(queryRoutes);
  await app.register(deviceRoutes);
  await app.register(bridgeRoutes);
  await app.register(realtimeRoutes);

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
  <title>Twoody Local Server</title>
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
  <h1><span class="status"></span>Twoody Local Server</h1>
  <p>Server is running. Pair using <code>twoody setup</code> or the mobile app.</p>
  <ul>
    <li><a href="/health">/health</a> — server status</li>
    <li><a href="/docs">/docs</a> — interactive API docs</li>
    <li><a href="/openapi.json">/openapi.json</a> — OpenAPI contract</li>
  </ul>
  <p style="color:#666;font-size:.85em">
    Full documentation: <a href="https://github.com/twoody/local-server">github.com/twoody/local-server</a>
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
