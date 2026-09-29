import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migratedPreference, ollamaBaseUrl, resolveEngine, surveyEngines, type BuiltinSource, type EngineProbe } from "../src/builtin/engine.js";
import { createPrefsStore, parsePrefs, type RuntimePrefs } from "../src/builtin/prefs.js";

const OLLAMA = "http://127.0.0.1:11434/v1";
const LMSTUDIO = "http://127.0.0.1:1234/v1";
const MLX = "http://127.0.0.1:8080/v1";

type World = { builtin?: string[] | null; up?: Record<string, string[] | "empty"> };

function world({ builtin = null, up = {} }: World) {
  const asked: string[] = [];
  const source: BuiltinSource | null = builtin
    ? { available: () => true, installedModels: async () => builtin, address: async () => ({ baseUrl: "http://127.0.0.1:47831/v1" }) }
    : null;
  const probe = async (baseUrl: string): Promise<EngineProbe> => {
    asked.push(baseUrl);
    const models = up[baseUrl];
    if (!models) return { reachable: false, models: null };
    return { reachable: true, models: models === "empty" ? [] : models };
  };
  return { source, probe, asked };
}

const prefs = (engine: RuntimePrefs["engine"], extra: Partial<RuntimePrefs> = {}): RuntimePrefs => ({ engine, builtin: { idle_minutes: 30 }, ...extra });

const table: Array<{ name: string; prefs: RuntimePrefs; world: World; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; want: { id: string | null; baseUrl: string | null; reason: string; models?: string[] } }> = [
  { name: "auto: built-in with a model comes first", prefs: prefs("auto"), world: { builtin: ["Qwen3.5-4B-Q4_K_M"], up: { [OLLAMA]: ["qwen3.5:4b"] } }, want: { id: "builtin", baseUrl: "http://127.0.0.1:47831/v1", reason: "auto", models: ["Qwen3.5-4B-Q4_K_M"] } },
  { name: "auto: built-in without a model gives way to Ollama", prefs: prefs("auto"), world: { builtin: [], up: { [OLLAMA]: ["qwen3.5:4b"] } }, want: { id: "ollama", baseUrl: OLLAMA, reason: "auto", models: ["qwen3.5:4b"] } },
  { name: "auto: Ollama up without a model gives way to LM Studio", prefs: prefs("auto"), world: { up: { [OLLAMA]: "empty", [LMSTUDIO]: ["qwen3-8b"] } }, want: { id: "lmstudio", baseUrl: LMSTUDIO, reason: "auto" } },
  { name: "auto: mlx-lm on a Mac", prefs: prefs("auto"), platform: "darwin", world: { up: { [MLX]: ["mlx-community/Qwen3-8B"] } }, want: { id: "mlx", baseUrl: MLX, reason: "auto" } },
  { name: "auto: mlx-lm is not looked for on Linux", prefs: prefs("auto"), platform: "linux", world: { up: { [MLX]: ["x"] } }, want: { id: null, baseUrl: null, reason: "none_available" } },
  { name: "auto: TWOODY_OLLAMA_URL is where Ollama is", prefs: prefs("auto"), env: { TWOODY_OLLAMA_URL: "http://ollama:11434" }, world: { up: { "http://ollama:11434/v1": ["qwen3.5:4b"] } }, want: { id: "ollama", baseUrl: "http://ollama:11434/v1", reason: "auto" } },
  { name: "auto: nothing anywhere", prefs: prefs("auto"), world: {}, want: { id: null, baseUrl: null, reason: "none_available" } },
  { name: "auto: a custom URL is not part of the auto order", prefs: prefs("auto", { custom_url: "http://10.0.0.2:8000/v1" }), world: { up: { "http://10.0.0.2:8000/v1": ["m"] } }, want: { id: null, baseUrl: null, reason: "none_available" } },
  { name: "ollama preferred and down: said so, not replaced", prefs: prefs("ollama"), world: { builtin: ["Qwen3.5-4B-Q4_K_M"] }, want: { id: "ollama", baseUrl: OLLAMA, reason: "unreachable" } },
  { name: "ollama preferred, up, no chat model", prefs: prefs("ollama"), world: { up: { [OLLAMA]: "empty" } }, want: { id: "ollama", baseUrl: OLLAMA, reason: "no_models" } },
  { name: "builtin preferred, not installed", prefs: prefs("builtin"), world: { up: { [OLLAMA]: ["x"] } }, want: { id: "builtin", baseUrl: null, reason: "not_installed" } },
  { name: "builtin preferred, no model yet", prefs: prefs("builtin"), world: { builtin: [] }, want: { id: "builtin", baseUrl: "http://127.0.0.1:47831/v1", reason: "no_models" } },
  { name: "builtin preferred, with a model", prefs: prefs("builtin"), world: { builtin: ["Qwen3.5-4B-Q4_K_M"] }, want: { id: "builtin", baseUrl: "http://127.0.0.1:47831/v1", reason: "preference" } },
  { name: "custom without a URL", prefs: prefs("custom"), world: {}, want: { id: "custom", baseUrl: null, reason: "custom_url_missing" } },
  { name: "custom, its /v1 added", prefs: prefs("custom", { custom_url: "http://10.0.0.2:8000" }), world: { up: { "http://10.0.0.2:8000/v1": ["m"] } }, want: { id: "custom", baseUrl: "http://10.0.0.2:8000/v1", reason: "preference" } },
  { name: "lmstudio preferred", prefs: prefs("lmstudio"), world: { up: { [LMSTUDIO]: ["m"] } }, want: { id: "lmstudio", baseUrl: LMSTUDIO, reason: "preference" } },
];

for (const row of table) {
  test(`resolveEngine — ${row.name}`, async () => {
    const { source, probe } = world(row.world);
    const got = await resolveEngine({ prefs: row.prefs, builtin: source, probe, platform: row.platform ?? "linux", env: row.env ?? {} });
    assert.equal(got.id, row.want.id);
    assert.equal(got.baseUrl, row.want.baseUrl);
    assert.equal(got.reason, row.want.reason);
    if (row.want.models) assert.deepEqual(got.models, row.want.models);
  });
}

test("the built-in engine is judged by its files, never by asking it (it may be stopped)", async () => {
  const { source, probe, asked } = world({ builtin: ["Qwen3.5-4B-Q4_K_M"] });
  await resolveEngine({ prefs: prefs("auto"), builtin: source, probe, platform: "linux", env: {} });
  assert.deepEqual(asked, []);
  const survey = await surveyEngines({ prefs: prefs("auto", { custom_url: "http://10.0.0.2:8000/v1" }), builtin: source, probe, platform: "darwin", env: {} });
  assert.deepEqual(survey.map((engine) => [engine.id, engine.reachable]), [["builtin", true], ["ollama", false], ["lmstudio", false], ["mlx", false], ["custom", false]]);
  assert.ok(!asked.includes("http://127.0.0.1:47831/v1"));
});

test("migration: a server pointed at Ollama keeps Ollama, one pointed elsewhere keeps it as custom, a fresh one is auto", () => {
  assert.deepEqual(migratedPreference({ BRIDGE_LOCAL_LLM_ENDPOINT: "http://127.0.0.1:11434/v1" }), { engine: "ollama" });
  assert.deepEqual(migratedPreference({ BRIDGE_LOCAL_LLM_ENDPOINT: "http://192.168.1.20:11434/v1" }), { engine: "ollama" });
  assert.deepEqual(migratedPreference({ BRIDGE_LOCAL_LLM_ENDPOINT: "http://127.0.0.1:8080/v1/" }), { engine: "custom", custom_url: "http://127.0.0.1:8080/v1" });
  assert.deepEqual(migratedPreference({}), { engine: "auto" });
  assert.deepEqual(migratedPreference({ BRIDGE_LOCAL_LLM_ENDPOINT: "  " }), { engine: "auto" });
  // Ollama on another box, found through the bridge's endpoint.
  assert.equal(ollamaBaseUrl({ BRIDGE_LOCAL_LLM_ENDPOINT: "http://192.168.1.20:11434/v1" }), "http://192.168.1.20:11434/v1");
  assert.equal(ollamaBaseUrl({ BRIDGE_LOCAL_LLM_ENDPOINT: "http://127.0.0.1:8080/v1" }), OLLAMA);
  assert.equal(ollamaBaseUrl({ TWOODY_OLLAMA_URL: "http://ollama:11434/", BRIDGE_LOCAL_LLM_ENDPOINT: "http://x:11434/v1" }), "http://ollama:11434/v1");
});

test("runtime.json: absent means migrated; written 0600; re-read when changed; TWOODY_RUNTIME overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-prefs-"));
  try {
    const env: NodeJS.ProcessEnv = { BRIDGE_LOCAL_LLM_ENDPOINT: "http://127.0.0.1:11434/v1" };
    const store = createPrefsStore({ dataDir: dir, env });
    assert.deepEqual(store.read(), { prefs: { engine: "ollama", builtin: { idle_minutes: 30 } }, source: "migrated" });

    assert.equal(store.migrate().written, true);
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.equal(store.migrate().written, false);
    assert.equal(store.read().source, "file");

    const next = store.write({ engine: "builtin", builtin: { default_model: "Qwen3.5-4B-Q4_K_M", threads: 4 } });
    assert.deepEqual(next, { engine: "builtin", builtin: { idle_minutes: 30, default_model: "Qwen3.5-4B-Q4_K_M", threads: 4 } });
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(store.path, "utf8")), next);

    // Edited by hand (or by the CLI in another process): seen without a restart.
    writeFileSync(store.path, JSON.stringify({ engine: "custom", custom_url: "http://10.0.0.2:8000/v1/", builtin: { idle_minutes: 5, ctx: 4096 } }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(store.path, later, later);
    assert.deepEqual(store.read().prefs, { engine: "custom", custom_url: "http://10.0.0.2:8000/v1", builtin: { idle_minutes: 5, ctx: 4096 } });

    env.TWOODY_RUNTIME = "builtin";
    assert.deepEqual(store.read(), { prefs: { engine: "builtin", custom_url: "http://10.0.0.2:8000/v1", builtin: { idle_minutes: 5, ctx: 4096 } }, source: "env" });
    env.TWOODY_RUNTIME = "http://127.0.0.1:9999/v1";
    assert.deepEqual(store.read().prefs.engine, "custom");
    assert.deepEqual(store.read().prefs.custom_url, "http://127.0.0.1:9999/v1");
    env.TWOODY_RUNTIME = "nonsense";
    assert.equal(store.read().source, "file");

    // A broken file is the default, not a crash.
    writeFileSync(store.path, "{ not json");
    utimesSync(store.path, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    assert.equal(store.read().prefs.engine, "auto");
    chmodSync(store.path, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a preference is validated field by field", () => {
  assert.deepEqual(parsePrefs(null), { engine: "auto", builtin: { idle_minutes: 30 } });
  assert.deepEqual(
    parsePrefs({ engine: "gpt", custom_url: "ftp://x", builtin: { idle_minutes: 0, ctx: 10, threads: 1.5, default_model: "../x" } }),
    { engine: "auto", builtin: { idle_minutes: 30 } },
  );
  assert.equal(parsePrefs({ custom_url: "http://user:pw@host/v1" }).custom_url, undefined);
  assert.deepEqual(parsePrefs({ engine: "mlx", builtin: { idle_minutes: 90, ctx: 16384, threads: 8 } }), { engine: "mlx", builtin: { idle_minutes: 90, ctx: 16384, threads: 8 } });
});
