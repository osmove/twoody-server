import { totalmem } from "node:os";

import { ENGINE_PREFERENCES, isHttpUrl, runtimeTarget, runtimeTargetUrl, type BuiltinPrefs, type EnginePreference, type RuntimePrefs } from "../builtin/index.js";
import { initEngine, type Engine } from "../engine.js";

// `twoody-server config | runtime | models` (bin/twoody-server.mjs), the
// console side of the « Moteur » and « Modèles » screens
// (docs/builtin-runtime-design.md §4):
//
//   twoody-server config get [key]
//   twoody-server config set runtime=builtin|ollama|lmstudio|mlx|auto|<url> [default_model=…] [idle_minutes=…] [ctx=…] [threads=…]
//   twoody-server runtime install [--force] [--archive <file>]
//   twoody-server runtime status
//   twoody-server models list | add <id> [--force] | rm <id>
//
// When the server runs on this machine, the commands that change what it
// runs ask it (/runtime on loopback): it restarts its runtime when needed
// and says what it did. When it does not, they work on the data directory
// directly, and the server finds it all at its next start. Installing the
// runtime is always done here: it is a folder, renamed into place whole.

const PORT = Number(process.env.PORT ?? 3000);

function headers(): Record<string, string> {
  const token = process.env.TWOODY_ADMIN_TOKEN?.trim();
  return { Accept: "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

type Answer = { status: number; body: any };

/// The server on this machine, or null when nothing answers there.
async function server(path: string, init: { method?: string; body?: unknown } = {}): Promise<Answer | null> {
  try {
    const response = await globalThis.fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: init.method ?? "GET",
      headers: headers(),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return null;
  }
}

function refused(answer: Answer): number {
  if (answer.status === 403 || answer.status === 401) {
    console.error("The server refused: set TWOODY_ADMIN_TOKEN to the server's admin token, or run this on the server's own machine.");
  } else {
    console.error(`The server answered ${answer.status}: ${answer.body?.message ?? answer.body?.error ?? "no reason given"}`);
  }
  return 1;
}

let local: Engine | null = null;
function engineHere(): Engine {
  local ??= initEngine({ log: (line) => console.log(line) });
  return local;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`;

function flag(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

function option(args: string[], name: string): string | null {
  const at = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (at < 0) return null;
  const arg = args[at]!;
  if (arg.includes("=")) {
    args.splice(at, 1);
    return arg.slice(name.length + 1);
  }
  const value = args[at + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

// ── config ────────────────────────────────────────────────────────────

const KEYS = ["runtime", "custom_url", "default_model", "idle_minutes", "ctx", "threads"] as const;
type Key = (typeof KEYS)[number];

function flatten(prefs: RuntimePrefs): Record<Key, string> {
  return {
    runtime: prefs.engine,
    custom_url: prefs.custom_url ?? "",
    default_model: prefs.builtin.default_model ?? "",
    idle_minutes: String(prefs.builtin.idle_minutes),
    ctx: prefs.builtin.ctx !== undefined ? String(prefs.builtin.ctx) : "",
    threads: prefs.builtin.threads !== undefined ? String(prefs.builtin.threads) : "",
  };
}

/// `key=value` pairs → the body of PUT /runtime.
export function parseAssignments(pairs: string[]): { engine?: EnginePreference; custom_url?: string; builtin?: Record<string, number | string | null> } {
  const update: { engine?: EnginePreference; custom_url?: string; builtin?: Record<string, number | string | null> } = {};
  if (pairs.length === 0) throw new Error("nothing to set: key=value, for example runtime=builtin");
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`${pair}: expected key=value`);
    const key = pair.slice(0, eq).trim().replace(/^builtin\./, "") as Key;
    const value = pair.slice(eq + 1).trim();
    switch (key) {
      case "runtime":
        if ((ENGINE_PREFERENCES as readonly string[]).includes(value)) update.engine = value as EnginePreference;
        else if (isHttpUrl(value)) {
          update.engine = "custom";
          update.custom_url = value;
        } else throw new Error(`runtime is one of ${ENGINE_PREFERENCES.join(", ")}, or an http(s) address`);
        break;
      case "custom_url":
        if (!isHttpUrl(value)) throw new Error("custom_url is an http(s) address");
        update.custom_url = value;
        break;
      case "default_model":
        if (!/^[\w.-]{1,80}$/.test(value)) throw new Error("default_model is the id of an installed model (twoody-server models list)");
        (update.builtin ??= {}).default_model = value;
        break;
      case "idle_minutes":
      case "ctx":
      case "threads": {
        if (value === "" || value === "default") {
          if (key === "idle_minutes") throw new Error("idle_minutes needs a number of minutes");
          (update.builtin ??= {})[key] = null;
          break;
        }
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1) throw new Error(`${key} is a whole number`);
        (update.builtin ??= {})[key] = number;
        break;
      }
      default:
        throw new Error(`unknown key ${key} (${KEYS.join(", ")})`);
    }
  }
  return update;
}

async function config(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === "get") {
    // The running server's, when there is one: it may have another data directory.
    const answer = await server("/runtime");
    const view = answer?.status === 200 ? answer.body : null;
    const { prefs, source } = view ? { prefs: view.preference as RuntimePrefs, source: view.preference.source as string } : engineHere().prefs.read();
    const values = flatten(prefs);
    if (rest[0]) {
      const key = rest[0].replace(/^builtin\./, "") as Key;
      if (!(KEYS as readonly string[]).includes(key)) {
        console.error(`unknown key ${rest[0]} (${KEYS.join(", ")})`);
        return 2;
      }
      console.log(values[key]);
      return 0;
    }
    for (const key of KEYS) if (values[key] !== "") console.log(`${key}=${values[key]}`);
    if (source === "env") console.log(`# runtime is forced by TWOODY_RUNTIME=${process.env.TWOODY_RUNTIME}`);
    else if (source === "migrated") console.log("# not chosen yet: what this server's configuration implies");
    return 0;
  }
  if (action === "set") {
    let update;
    try {
      update = parseAssignments(rest);
    } catch (err) {
      console.error((err as Error).message);
      return 2;
    }
    const answer = await server("/runtime", { method: "PUT", body: update });
    if (answer && answer.status !== 200) return refused(answer);
    if (!answer) {
      const store = engineHere().prefs;
      const builtin: Partial<BuiltinPrefs> = {};
      for (const [key, value] of Object.entries(update.builtin ?? {})) (builtin as Record<string, unknown>)[key] = value === null ? undefined : value;
      if (update.engine === "custom" && !update.custom_url && !store.read().prefs.custom_url) {
        console.error("runtime=custom needs custom_url=… (or runtime=<url>)");
        return 2;
      }
      store.write({ ...(update.engine ? { engine: update.engine } : {}), ...(update.custom_url ? { custom_url: update.custom_url } : {}), ...(update.builtin ? { builtin } : {}) });
    }
    const { prefs, source } = engineHere().prefs.read();
    for (const [key, value] of Object.entries(flatten(prefs))) if (value !== "") console.log(`${key}=${value}`);
    if (source === "env") console.log(`# note: TWOODY_RUNTIME=${process.env.TWOODY_RUNTIME} overrides runtime while it is set`);
    if (!answer) console.log("# saved; the server reads it when it starts or as soon as it changes");
    return 0;
  }
  console.error("usage: twoody-server config get [key] | config set key=value …");
  return 2;
}

// ── runtime ───────────────────────────────────────────────────────────

async function runtime(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === "install") {
    const force = flag(rest, "--force");
    let archive: string | null;
    try {
      archive = option(rest, "--archive");
    } catch (err) {
      console.error((err as Error).message);
      return 2;
    }
    const e = engineHere();
    if (e.managedByDesktop) {
      console.error("Twoody Desktop runs this computer's runtime (TWOODY_RUNTIME_OWNER=desktop).");
      return 1;
    }
    const target = runtimeTarget(e.platform, e.arch);
    if (!target) {
      console.error(`There is no built-in runtime for ${e.platform}-${e.arch}. Run Ollama or another OpenAI-compatible runtime and: twoody-server config set runtime=ollama`);
      return 1;
    }
    const { ensureRuntimeInstalled } = await import("../engineJobs.js");
    try {
      if (!archive) console.log(`llama.cpp ${target.asset}, from ${new URL(runtimeTargetUrl(target)).host}, SHA-256 ${target.sha256.slice(0, 16)}…`);
      const installed = await ensureRuntimeInstalled({ archive: archive ?? undefined, force, log: (line) => console.log(line) });
      console.log(installed.fetched ? `Installed in ${installed.dir}` : `Already installed in ${installed.dir}`);
      if (installed.missingLibraries.length) {
        console.error(`Missing system libraries: ${installed.missingLibraries.join(", ")}. Install them (apt) and try again.`);
        return 1;
      }
      const models = await e.manager.installedModels();
      if (models.length === 0) console.log("Next: twoody-server models list, then twoody-server models add <id>");
      return 0;
    } catch (err) {
      console.error(`Could not install the runtime: ${(err as Error).message}`);
      return 1;
    }
  }
  if (action === "status") {
    const answer = await server("/runtime");
    if (answer && answer.status !== 200) return refused(answer);
    if (answer) {
      const view = answer.body;
      console.log(`Engine: ${view.preference.engine}${view.preference.source === "env" ? " (TWOODY_RUNTIME)" : ""} → ${view.active.name ?? "none"} (${view.active.reason})${view.active.model ? `, model ${view.active.model}` : ""}`);
      for (const engine of view.engines) console.log(`  ${engine.reachable ? "●" : "○"} ${engine.name}: ${engine.models.length ? engine.models.join(", ") : "no model"}`);
      const b = view.builtin;
      console.log(`Built-in runtime: ${b.installed ? b.version : "not installed"} (${b.platform})${b.managed_by === "desktop" ? ", run by Twoody Desktop" : ""}`);
      if (b.installed) {
        console.log(`  ${b.running ? `running, ${b.loaded_model ? `${b.loaded_model} in memory` : "no model in memory"}` : "stopped (starts on the first question)"}; ctx ${b.ctx}, threads ${b.threads ?? "auto"}/${b.threads_batch ?? "auto"}, idle ${b.idle_minutes} min`);
        console.log(`  models: ${b.models.length ? b.models.join(", ") : "none (twoody-server models add <id>)"}${b.default_model ? `; default ${b.default_model}` : ""}`);
        if (b.failure) console.log(`  last failure: ${b.failure.reason} (exit ${b.failure.exitCode}); see runtime.log in the data directory`);
        if (b.missing_libraries.length) console.log(`  missing libraries: ${b.missing_libraries.join(", ")}`);
      }
      if (view.job && !["done"].includes(view.job.state)) console.log(`Job: ${view.job.model} ${view.job.state}${view.job.message ? ` (${view.job.message})` : ""}`);
      return 0;
    }
    const e = engineHere();
    const { runtimeInstalled } = await import("../engineJobs.js");
    const installed = await runtimeInstalled();
    const { prefs, source } = e.prefs.read();
    console.log(`The server is not running on port ${PORT}.`);
    console.log(`Engine: ${prefs.engine}${source === "env" ? " (TWOODY_RUNTIME)" : source === "migrated" ? " (not chosen yet)" : ""}`);
    console.log(`Built-in runtime: ${installed ? `${installed.version} in ${installed.dir}` : "not installed (twoody-server runtime install)"}`);
    if (installed?.missingLibraries.length) console.log(`  missing libraries: ${installed.missingLibraries.join(", ")}`);
    const models = await e.manager.installedModels();
    console.log(`Models: ${models.length ? models.join(", ") : "none"}${prefs.builtin.default_model ? `; default ${prefs.builtin.default_model}` : ""}`);
    return 0;
  }
  console.error("usage: twoody-server runtime install [--force] [--archive <file>] | runtime status");
  return 2;
}

// ── models ────────────────────────────────────────────────────────────

async function follow(read: () => Promise<any>): Promise<number> {
  let last = "";
  for (;;) {
    const job = await read();
    if (!job) {
      console.error("The installation is no longer known to the server.");
      return 1;
    }
    const line =
      job.state === "downloading"
        ? `  downloading ${Math.floor((job.received / Math.max(1, job.total)) * 100)} % (${mb(job.received)} of ${mb(job.total)}${job.bytes_per_second ? `, ${mb(job.bytes_per_second)}/s` : ""})`
        : `  ${job.state}`;
    if (line !== last && process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(72)}`);
    else if (job.state !== "downloading" && line !== last) console.log(line);
    last = line;
    if (job.state === "done") {
      if (process.stdout.isTTY) process.stdout.write("\n");
      console.log(`${job.model} is installed.`);
      return 0;
    }
    if (job.state === "failed" || job.state === "cancelled") {
      if (process.stdout.isTTY) process.stdout.write("\n");
      console.error(`${job.model}: ${job.state}${job.message ? ` (${job.message})` : ""}`);
      return 1;
    }
    await sleep(1_000);
  }
}

async function models(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  const force = flag(rest, "--force");
  if (action === "list" || action === undefined) {
    const answer = await server("/runtime/catalog");
    if (answer && answer.status !== 200) return refused(answer);
    const { engineCatalog } = await import("../engineJobs.js");
    const catalog = answer ? answer.body : (engineHere(), await engineCatalog());
    const ram = Math.round(totalmem() / 1024 ** 3);
    console.log(`Models for the built-in runtime (this computer: ${ram} GB of memory)${catalog.overridden ? " — catalogue from TWOODY_MODEL_CATALOG" : ""}:`);
    for (const model of catalog.models) {
      const marks = [model.installed ? "installed" : null, model.recommended ? "recommended" : null, model.fits ? null : `needs ${model.minRamGb} GB`].filter(Boolean).join(", ");
      console.log(`  ${model.installed ? "●" : "○"} ${model.id.padEnd(24)} ${model.name}, ${mb(model.bytes)}, ${model.license}${marks ? ` — ${marks}` : ""}`);
    }
    return 0;
  }
  const id = rest[0];
  if ((action === "add" || action === "rm") && !id) {
    console.error(`usage: twoody-server models ${action} <id> (twoody-server models list)`);
    return 2;
  }
  if (action === "add") {
    const answer = await server("/runtime/models", { method: "POST", body: { id, force } });
    if (answer) {
      if (answer.status !== 202) return refused(answer);
      console.log(`Installing ${id} on the running server…`);
      return follow(async () => (await server("/runtime/jobs/current"))?.body?.job ?? null);
    }
    engineHere();
    const { JobError, currentJob, startModelJob } = await import("../engineJobs.js");
    try {
      startModelJob(id!, { force, log: (line) => console.log(line) });
    } catch (err) {
      if (err instanceof JobError) {
        console.error(err.code === "insufficient_memory" ? `${err.message}. --force installs it anyway.` : err.message);
        return 1;
      }
      throw err;
    }
    return follow(async () => currentJob());
  }
  if (action === "rm") {
    const answer = await server(`/runtime/models/${encodeURIComponent(id!)}`, { method: "DELETE" });
    if (answer) {
      if (answer.status !== 204) return refused(answer);
    } else {
      engineHere();
      const { JobError, removeEngineModel } = await import("../engineJobs.js");
      try {
        await removeEngineModel(id!);
      } catch (err) {
        if (err instanceof JobError) {
          console.error(err.message);
          return 1;
        }
        throw err;
      }
    }
    console.log(`${id} removed.`);
    return 0;
  }
  console.error("usage: twoody-server models list | add <id> [--force] | rm <id>");
  return 2;
}

export async function runRuntimeCommand(command: string, args: string[]): Promise<number> {
  if (command === "config") return config(args);
  if (command === "runtime") return runtime(args);
  if (command === "models") return models(args);
  return 2;
}
