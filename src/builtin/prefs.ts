import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { migratedPreference } from "./engine.js";

// « Moteur »: which engine this computer answers with, in
// DATA_DIR/runtime.json (0600), per computer.
//
//   {"engine":"auto"|"builtin"|"ollama"|"lmstudio"|"mlx"|"custom",
//    "custom_url"?: "http://…/v1",
//    "builtin": {"default_model"?, "idle_minutes"?, "preload"?, "ctx"?, "threads"?}}
//
// `idle_minutes`: how long the model stays in memory with nothing asked, 0
// for as long as the server runs; unset, the server decides (engine.ts,
// preloadBuiltin): kept loaded on a computer without the Desktop whose free
// memory holds the model twice over, else 30 minutes. `preload`: false stops
// the server from loading the default model when it starts (default true).
// A file written before these (no "v": 2) holds the old default,
// idle_minutes 30, which is read as unset.
//
// TWOODY_RUNTIME overrides the engine (an engine id, or a URL, which means
// `custom` at that URL). The file is read again whenever its mtime or size
// changes, so an edit by `twoody-server config set` or by hand is seen
// without a restart. Without a file, the preference is the one the
// environment implies (engine.ts, migratedPreference).

export const ENGINE_PREFERENCES = ["auto", "builtin", "ollama", "lmstudio", "mlx", "custom"] as const;
export type EnginePreference = (typeof ENGINE_PREFERENCES)[number];

export interface BuiltinPrefs {
  default_model?: string;
  /// 0: never unloaded. Unset: decided by the server (see above).
  idle_minutes?: number;
  /// Load the default model at startup (headless only); default true.
  preload?: boolean;
  ctx?: number;
  threads?: number;
}

export interface RuntimePrefs {
  engine: EnginePreference;
  custom_url?: string;
  builtin: BuiltinPrefs;
}

export type PrefsSource = "file" | "env" | "migrated";

export const DEFAULT_IDLE_MINUTES = 30;
export const PREFS_FILE = "runtime.json";
/// Files written with idle_minutes optional and preload.
const FILE_VERSION = 2;

function isEngine(value: unknown): value is EnginePreference {
  return typeof value === "string" && (ENGINE_PREFERENCES as readonly string[]).includes(value);
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

/// A preference from anything: what does not hold together is left out
/// (a wrong engine means auto; a custom engine without a URL stays custom
/// and resolves to nothing, rather than to an engine not chosen).
export function parsePrefs(raw: unknown): RuntimePrefs {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const builtin = value.builtin && typeof value.builtin === "object" ? (value.builtin as Record<string, unknown>) : {};
  const prefs: RuntimePrefs = {
    engine: isEngine(value.engine) ? value.engine : "auto",
    builtin: {},
  };
  const idle = integer(builtin.idle_minutes, 0, 24 * 60);
  // Before version 2, every file carried the default (30) written at the
  // first start: read as not chosen.
  if (idle !== undefined && !(value.v !== FILE_VERSION && idle === DEFAULT_IDLE_MINUTES)) prefs.builtin.idle_minutes = idle;
  if (typeof builtin.preload === "boolean") prefs.builtin.preload = builtin.preload;
  if (isHttpUrl(value.custom_url)) prefs.custom_url = value.custom_url.trim().replace(/\/+$/, "");
  if (typeof builtin.default_model === "string" && /^[\w.-]{1,80}$/.test(builtin.default_model)) prefs.builtin.default_model = builtin.default_model;
  const ctx = integer(builtin.ctx, 512, 262_144);
  if (ctx !== undefined) prefs.builtin.ctx = ctx;
  const threads = integer(builtin.threads, 1, 256);
  if (threads !== undefined) prefs.builtin.threads = threads;
  return prefs;
}

/// The engine TWOODY_RUNTIME forces, if any.
export function envOverride(env: NodeJS.ProcessEnv): { engine: EnginePreference; custom_url?: string } | null {
  const value = env.TWOODY_RUNTIME?.trim();
  if (!value) return null;
  if (isEngine(value)) return { engine: value };
  if (isHttpUrl(value)) return { engine: "custom", custom_url: value.replace(/\/+$/, "") };
  return null;
}

export interface PrefsStore {
  readonly path: string;
  /// The preference in force and where it comes from.
  read(): { prefs: RuntimePrefs; source: PrefsSource };
  /// Merges `update` into the stored preference (not the env override) and writes it.
  write(update: Partial<Omit<RuntimePrefs, "builtin">> & { builtin?: Partial<BuiltinPrefs> | null }): RuntimePrefs;
  /// Writes the migrated preference when there is no file yet (first start).
  migrate(): { prefs: RuntimePrefs; written: boolean };
}

export function createPrefsStore({ dataDir, env = process.env }: { dataDir: string; env?: NodeJS.ProcessEnv }): PrefsStore {
  const path = join(dataDir, PREFS_FILE);
  let cache: { mtimeMs: number; size: number; prefs: RuntimePrefs } | null = null;

  function readFile(): RuntimePrefs | null {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      cache = null;
      return null;
    }
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.prefs;
    let prefs: RuntimePrefs;
    try {
      prefs = parsePrefs(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      // A file cut short or edited wrong: the default, until it is fixed.
      prefs = parsePrefs({});
    }
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, prefs };
    return prefs;
  }

  function writeFile(prefs: RuntimePrefs): void {
    const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: FILE_VERSION, ...prefs }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    cache = null;
  }

  return {
    path,
    read() {
      const stored = readFile();
      const base = stored ?? parsePrefs(migratedPreference(env));
      const override = envOverride(env);
      if (override) {
        const prefs: RuntimePrefs = { ...base, engine: override.engine, builtin: { ...base.builtin } };
        if (override.custom_url) prefs.custom_url = override.custom_url;
        return { prefs, source: "env" };
      }
      return { prefs: base, source: stored ? "file" : "migrated" };
    },
    write(update) {
      const current = readFile() ?? parsePrefs(migratedPreference(env));
      const builtin = update.builtin === null ? {} : { ...current.builtin, ...(update.builtin ?? {}) };
      // What is read is already of this version: nothing of it is legacy.
      const merged: Record<string, unknown> = { ...current, ...update, builtin, v: FILE_VERSION };
      const next = parsePrefs(merged);
      writeFile(next);
      return next;
    },
    migrate() {
      const stored = readFile();
      if (stored) return { prefs: stored, written: false };
      const prefs = parsePrefs(migratedPreference(env));
      writeFile(prefs);
      return { prefs, written: true };
    },
  };
}
