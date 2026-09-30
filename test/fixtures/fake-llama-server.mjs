// Plays llama.cpp's server in router mode for test/builtinManager.test.ts
// and test/runtimeRoutes.test.ts.
// Copied as `llama-server` (with this Node as its interpreter) into a
// runtime folder. Records how it was started beside itself.
import { createServer } from "node:http";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
const here = dirname(process.argv[1]);
writeFileSync(join(here, `record-${process.pid}.json`), JSON.stringify({ argv, env: process.env, pid: process.pid }));
if (existsSync(join(here, "exit-127"))) process.exit(127);
if (existsSync(join(here, "crash-on-start"))) process.exit(1);

const key = process.env.LLAMA_API_KEY;
const modelsDir = arg("--models-dir");
let loaded = null;
// Something a log must not keep.
console.log(`request headers: Authorization: Bearer ${key}`);

const server = createServer((req, res) => {
  if (req.url === "/health") return res.end('{"status":"ok"}');
  if (req.headers.authorization !== `Bearer ${key}`) {
    res.writeHead(401);
    return res.end('{"error":"Invalid API Key"}');
  }
  if (req.url === "/v1/models") {
    const data = readdirSync(modelsDir)
      .filter((name) => name.endsWith(".gguf"))
      .map((name) => name.slice(0, -5))
      .map((id) => ({ id, status: { value: id === loaded ? "loaded" : "unloaded" } }));
    return res.end(JSON.stringify({ data, object: "list" }));
  }
  if (req.url === "/crash") process.exit(3);
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const json = JSON.parse(body || "{}");
    loaded = json.model ?? null;
    writeFileSync(join(here, `request-${Date.now()}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify({ url: req.url, body: json }));
    if (json.stream) {
      // As llama.cpp streams: deltas, then the usage, then [DONE].
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of ["Bonjour ", "depuis le moteur intégré."]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }], model: loaded })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 6 } })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    res.end('{"choices":[{"message":{"content":"ok"}}]}');
  });
});
server.listen(Number(arg("--port")), arg("--host"));
process.on("SIGTERM", () => process.exit(0));
