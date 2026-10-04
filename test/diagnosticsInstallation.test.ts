import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// « Partager des diagnostics »: what this server says of its installation
// for Twoody Desktop's daily `installation_active` (src/diagnostics/
// installation.ts) — ids, counts and families, never a name, an address or
// a path.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-installation-facts-"));

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { configureRuntimeKeys } = await import("../src/runtimeAuth.js");
const { modelLabel, providerFamily } = await import("../src/diagnostics/installation.js");

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
assert.equal(paired.statusCode, 201);
const owner = paired.json().user_id as string;
const desktop = { authorization: `Bearer ${paired.json().token}` };

const BUILTIN = "http://127.0.0.1:47831/v1";
const APPLE = "http://127.0.0.1:47851/v1";

function provider(id: string, kind: string, name: string, baseUrl: string | null, model: string | null, options: { enabled?: boolean; isDefault?: boolean; at?: number } = {}) {
  const at = options.at ?? Date.now();
  sqlite.prepare("INSERT INTO llm_endpoints (id, user_id, kind, name, base_url, model, enabled, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, owner, kind, name, baseUrl, model, options.enabled === false ? 0 : 1, options.isDefault ? 1 : 0, at, at);
}

test("a new installation: Mémoire on, nothing set up, no model, no phone", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1/diagnostics/installation", headers: desktop });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { capabilities_on: ["memory"], setup_kind: null, setup_team: null, default_model: null, providers_used: [], phones_paired: 0 });
});

test("capabilities, the first launch's answers, providers by family, the default model's name and the phones", async () => {
  configureRuntimeKeys({ [BUILTIN]: "key-builtin", [APPLE]: "key-apple" });
  for (const id of ["documents", "dictation"]) {
    assert.equal((await app.inject({ method: "PATCH", url: `/local_capabilities/${id}`, headers: desktop, payload: { enabled: true } })).statusCode, 200);
  }
  assert.equal((await app.inject({ method: "PUT", url: "/local_usage", headers: desktop, payload: { kind: "pro", team: true, profession: "lawyer" } })).statusCode, 200);
  provider("p-builtin", "local_openai", "Twoody", BUILTIN, "Qwen3.5-9B-Q4_K_M", { isDefault: true });
  provider("p-apple", "local_openai", "Apple Intelligence", APPLE, "apple-on-device", { at: Date.now() + 1 });
  provider("p-ollama", "local_openai", "Ollama", "http://127.0.0.1:11434/v1", "qwen3:8b", { at: Date.now() + 2 });
  provider("p-lms", "local_openai", "LM Studio de Jimmy", "http://127.0.0.1:1234/v1", "/Users/jimmy/models/Mon-Client/secret.gguf", { at: Date.now() + 3 });
  provider("p-mlx", "local_openai", "mlx-lm", "http://127.0.0.1:8080/v1", "mlx-community/Qwen3-8B", { enabled: false, at: Date.now() + 4 });
  provider("p-other", "local_openai", "Le serveur du bureau", "http://192.168.1.20:9000/v1", "llama", { at: Date.now() + 5 });
  for (const name of ["iPhone de Jimmy", "iPad"]) createAuthSession(owner, `pair:${name}`, "code");
  createAuthSession(owner, "pair:Montre", null);
  createAuthSession(owner, "peer:Mac mini", "account");

  const response = await app.inject({ method: "GET", url: "/diagnostics/installation", headers: desktop });
  assert.equal(response.statusCode, 200);
  const facts = response.json();
  assert.deepEqual(facts, {
    capabilities_on: ["documents", "dictation", "memory"],
    setup_kind: "pro",
    setup_team: "team",
    default_model: "Qwen3.5-9B-Q4_K_M",
    // The disabled mlx-lm provider is not used.
    providers_used: ["builtin", "apple", "ollama", "lmstudio", "custom"],
    phones_paired: 2,
  });
  // Nothing that names anyone or anything of theirs.
  const text = JSON.stringify(facts);
  for (const forbidden of ["Jimmy", "Mon-Client", "secret", "/Users", "127.0.0.1", "192.168", "Twoody Desktop", "iPhone", "LM Studio", "lawyer", "@"]) {
    assert.ok(!text.includes(forbidden), `${forbidden} must not be in ${text}`);
  }
});

test("personal use has no team; one phone is 1", async () => {
  assert.equal((await app.inject({ method: "PUT", url: "/local_usage", headers: desktop, payload: { kind: "personal" } })).statusCode, 200);
  sqlite.prepare("DELETE FROM auth_sessions WHERE client_kind IN ('pair:iPad', 'pair:Montre')").run();
  const facts = (await app.inject({ method: "GET", url: "/diagnostics/installation", headers: desktop })).json();
  assert.equal(facts.setup_kind, "personal");
  assert.equal(facts.setup_team, null);
  assert.equal(facts.phones_paired, 1);
});

test("a phone paired by code does not read it", async () => {
  const phone = { authorization: `Bearer ${createAuthSession(owner, "pair:Autre téléphone", "code").token}` };
  const refused = await app.inject({ method: "GET", url: "/diagnostics/installation", headers: phone, remoteAddress: "192.168.1.30" });
  assert.equal(refused.statusCode, 403);
  assert.deepEqual(refused.json(), { error: "person_device_required" });
  assert.equal((await app.inject({ method: "GET", url: "/diagnostics/installation" })).statusCode, 401);
});

test("families and model names", () => {
  configureRuntimeKeys({ [BUILTIN]: "key-builtin" });
  assert.equal(providerFamily("local_openai", BUILTIN, "Twoody"), "builtin");
  assert.equal(providerFamily("local_openai", `${BUILTIN}/`, "Twoody"), "builtin");
  assert.equal(providerFamily("local_openai", "http://127.0.0.1:11434/v1", "x"), "ollama");
  assert.equal(providerFamily("local_openai", "http://localhost:1234/v1", "x"), "lmstudio");
  assert.equal(providerFamily("local_openai", "http://127.0.0.1:8080/v1", "x"), "mlx");
  assert.equal(providerFamily("local_openai", "http://127.0.0.1:47851/v1", "Apple Intelligence"), "custom", "without its key, an address like any other");
  assert.equal(providerFamily("local_openai", "not a url", "x"), "custom");
  assert.equal(providerFamily("peer_openai", null, "Mac mini"), "peer");
  assert.equal(providerFamily("openai", "https://api.openai.com/v1", "OpenAI"), "cloud");
  // A model of the catalogue by its id, whatever the case or folder; any
  // other as « custom »: its name may be a file the person named.
  assert.equal(modelLabel("Qwen3.5-4B-Q4_K_M"), "Qwen3.5-4B-Q4_K_M");
  assert.equal(modelLabel("/Users/x/models/qwen3.5-9b-q4_k_m.gguf"), "Qwen3.5-9B-Q4_K_M");
  assert.equal(modelLabel("qwen3:8b"), "custom");
  assert.equal(modelLabel("C:\\Users\\Jimmy\\Models\\client x.GGUF"), "custom");
  assert.equal(modelLabel("lmstudio-community/Qwen3-8B-GGUF"), "custom");
  assert.equal(modelLabel(""), null);
  assert.equal(modelLabel(null), null);
});
