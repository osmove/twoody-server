// End to end, the built-in engine with a real llama.cpp and a tiny model
// (docs/builtin-runtime-design.md §6): what `npm run smoke:builtin` and CI
// run after `npm run build`.
//
//   twoody-server runtime install      the pinned llama.cpp for this computer
//   twoody-server (the server)          on a free port, its own data directory
//   twoody-server models add stories260K
//                                       through the server, from a one-entry
//                                       catalogue (TWOODY_MODEL_CATALOG): a 1 MB
//                                       story model on Hugging Face, pinned
//   POST /queries {provider: "engine"}  starts llama-server, writes something
//   GET /runtime, /providers            say so
//   SIGTERM                             the runtime goes with the server
//
// Needs the internet (GitHub, Hugging Face). TWOODY_RUNTIME_ARCHIVE gives
// the runtime archive from a file instead (a Pi before downloads.twoody.com
// has it); it is still checked against the pinned SHA-256.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.SMOKE_PORT || "4330";
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "twoody-builtin-smoke-"));
const catalog = join(dataDir, "..", `${dataDir.split(/[\\/]/).pop()}-catalog.json`);
// ggml-org's test models, at a fixed revision (tinyllamas/stories260K.gguf).
writeFileSync(
  catalog,
  JSON.stringify([
    {
      id: "stories260K",
      name: "Stories 260K (test)",
      file: "stories260K.gguf",
      url: "https://huggingface.co/ggml-org/models-moved/resolve/499bc8821c6b12b4e53c5bffcb21ec206f212d81/tinyllamas/stories260K.gguf",
      bytes: 1185376,
      sha256: "270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d",
      minRamGb: 1,
      publisher: "ggml-org",
      license: "MIT",
    },
  ]),
);

const env = {
  ...process.env,
  PORT,
  HOST: "127.0.0.1",
  TWOODY_DATA_DIR: dataDir,
  TWOODY_MODEL_CATALOG: catalog,
  TWOODY_BONJOUR_DISABLED: "1",
  TWOODY_MACHINE_SAMPLER: "0",
  LOG_LEVEL: "error",
};
delete env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete env.TWOODY_RUNTIME;
delete env.TWOODY_ADMIN_TOKEN;

const cli = (...args) => {
  const run = spawnSync(process.execPath, ["bin/twoody-server.mjs", ...args], { env, encoding: "utf8", timeout: 300_000 });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.status !== 0) throw new Error(`twoody-server ${args.join(" ")} exited ${run.status}`);
  return run.stdout;
};

async function json(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const text = await response.text();
  if (init.expect && response.status !== init.expect) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return { status: response.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

let server = null;
let logs = "";
try {
  const archive = process.env.TWOODY_RUNTIME_ARCHIVE;
  cli("runtime", "install", ...(archive ? ["--archive", archive] : []));

  server = spawn(process.execPath, ["bin/twoody-server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (chunk) => (logs += chunk));
  server.stderr.on("data", (chunk) => (logs += chunk));
  for (let i = 0; ; i++) {
    if (i > 100) throw new Error("the server did not start");
    const ok = await fetch(`${BASE}/health`).then((r) => r.ok, () => false);
    if (ok) break;
    await sleep(200);
  }

  cli("models", "add", "stories260K");
  cli("runtime", "status");

  const setupToken = readFileSync(join(dataDir, "setup-token"), "utf8").trim();
  const signup = await json("/auth/signup", {
    method: "POST",
    expect: 201,
    body: JSON.stringify({ email: "smoke@example.com", password: "correct horse battery staple", name: "Smoke", setup_token: setupToken }),
  });
  const auth = { "x-user-token": signup.body.token };

  const providers = (await json("/providers", { headers: auth, expect: 200 })).body.providers;
  const engine = providers.find((p) => p.id === "engine");
  if (!engine || engine.engine !== "builtin" || !engine.models.includes("stories260K")) throw new Error(`no built-in engine provider: ${JSON.stringify(providers)}`);

  const started = Date.now();
  const answer = await json("/queries", { method: "POST", headers: auth, expect: 200, body: JSON.stringify({ content: "Once upon a time", provider: "engine" }) });
  const final = answer.text.split("\n\n").find((block) => block.startsWith("event: final"));
  if (!final) throw new Error(`no final event: ${answer.text.slice(0, 500)}`);
  const payload = JSON.parse(final.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n"));
  const text = payload.text ?? payload.content ?? payload.message?.content ?? "";
  console.log(`answer in ${Date.now() - started} ms (${payload.usage?.completion_tokens ?? "?"} tokens): ${JSON.stringify(String(text).slice(0, 120))}`);
  if (!String(text).trim()) throw new Error(`empty answer: ${final.slice(0, 500)}`);

  const view = (await json("/runtime", { headers: auth, expect: 200 })).body;
  if (!view.builtin.running || view.builtin.loaded_model !== "stories260K" || view.active.id !== "builtin") {
    throw new Error(`/runtime does not show the running engine: ${JSON.stringify(view.builtin)}`);
  }
  const pid = Number(readFileSync(join(dataDir, "runtime.pid"), "utf8"));

  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  server = null;
  await sleep(300);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (alive) throw new Error(`llama-server (pid ${pid}) outlived the server`);
  if (existsSync(join(dataDir, "runtime.pid"))) throw new Error("runtime.pid left behind");
  console.log("Built-in engine smoke test passed.");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  if (logs) console.error(`--- server output ---\n${logs.slice(-4000)}`);
  const runtimeLog = join(dataDir, "runtime.log");
  if (existsSync(runtimeLog)) console.error(`--- runtime.log ---\n${readFileSync(runtimeLog, "utf8").slice(-4000)}`);
  process.exitCode = 1;
} finally {
  server?.kill("SIGKILL");
  if (process.env.SMOKE_KEEP === "1") {
    console.log(`kept: ${dataDir}`);
  } else {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(catalog, { force: true });
  }
}
