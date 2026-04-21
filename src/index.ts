import Fastify from "fastify";
import cors from "@fastify/cors";
import { healthRoutes } from "./routes/health.js";
import { sessionRoutes } from "./routes/session.js";
import { queryRoutes } from "./routes/queries.js";
import { deviceRoutes } from "./routes/devices.js";
import { bridgeRoutes } from "./routes/bridge.js";
import { realtimeRoutes } from "./routes/realtime.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

await app.register(cors, {
  origin: true,
  credentials: true,
});

await app.register(healthRoutes);
await app.register(sessionRoutes);
await app.register(queryRoutes);
await app.register(deviceRoutes);
await app.register(bridgeRoutes);
await app.register(realtimeRoutes);

// Admin UI placeholder
app.get("/admin", async (_req, reply) => {
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
    <li><code>GET /session/me</code> — verify auth token</li>
    <li><code>POST /queries</code> — SSE chat stream</li>
    <li><code>GET /bridge/presence</code> — Mac Bridge status</li>
  </ul>
  <p style="color:#666;font-size:.85em">
    Full documentation: <a href="https://github.com/twoody/local-server">github.com/twoody/local-server</a>
  </p>
</body>
</html>`);
});

// MCP stub — full implementation in twoody-mcp; this proxies to it if configured
app.all("/mcp", async (req, reply) => {
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
});

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`\nTwoody local-server ready on http://${HOST}:${PORT}\n`);
  if (process.env.TWOODY_PAIRING_CODE) {
    console.log(`  Pairing code: ${process.env.TWOODY_PAIRING_CODE}`);
    console.log(`  (pass this to \`twoody setup\` or the mobile app)\n`);
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
