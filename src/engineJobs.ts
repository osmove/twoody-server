import { totalmem } from "node:os";

import {
  DownloadError,
  RuntimeError,
  RuntimeFetchError,
  catalogView,
  downloadModel,
  installRuntime,
  installedRuntime,
  isInstalled,
  loadCatalog,
  modelFits,
  removeModel,
  type CatalogEntryView,
  type CatalogModel,
  type InstalledRuntime,
} from "./builtin/index.js";
import { engine } from "./engine.js";
import { LOCAL_ONLY } from "./outbound.js";

// Installing the built-in runtime and its models (docs/builtin-runtime-design.md
// §4), for the /runtime routes and the `twoody-server runtime | models` commands.
//
// One job at a time: a model of several gigabytes, fetched from Hugging
// Face, checked against its pinned SHA-256 (builtin/downloads.ts). The
// runtime comes first when it is not there yet (runtime → downloading →
// verifying → done). These are the downloads the person asked for, so
// they are made in local-only mode too — to the allowlisted hosts only,
// and said in the log.

export type JobState = "runtime" | "downloading" | "verifying" | "done" | "failed" | "cancelled";

export interface ModelJob {
  id: string;
  model: string;
  state: JobState;
  received: number;
  total: number;
  bytes_per_second: number;
  error: string | null;
  message: string | null;
  started_at: string;
  finished_at: string | null;
}

let job: ModelJob | null = null;
let controller: AbortController | null = null;
let running: Promise<void> | null = null;

const log = (line: string) => console.log(`  ${line}`);

export class JobError extends Error {
  constructor(
    public code: "unknown_model" | "job_running" | "insufficient_memory" | "managed_by_desktop" | "not_installed",
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/// The catalogue as the model screens show it, for this computer.
export async function engineCatalog(): Promise<{ models: CatalogEntryView[]; overridden: boolean }> {
  const { models, overridden } = loadCatalog(engine().env);
  const installed = await engine().manager.installedModels();
  return { models: catalogView(models, installed, totalmem(), engine().platform), overridden };
}

/// The runtime for this computer, installed when it is not there.
export async function ensureRuntimeInstalled(options: { archive?: string; force?: boolean; signal?: AbortSignal; log?: (line: string) => void } = {}): Promise<InstalledRuntime & { fetched: boolean }> {
  const e = engine();
  if (e.managedByDesktop) throw new RuntimeError("managed_by_desktop", "the Desktop app runs this computer's runtime");
  const say = options.log ?? log;
  if (LOCAL_ONLY && !options.archive) say("[runtime] local-only mode: fetching the llama.cpp runtime the person asked for, from its pinned host only");
  return installRuntime({
    runtimeRoot: e.paths.runtimeRoot,
    platform: e.platform,
    arch: e.arch,
    archive: options.archive,
    force: options.force,
    signal: options.signal,
    log: say,
  });
}

export async function runtimeInstalled(): Promise<InstalledRuntime | null> {
  const e = engine();
  return installedRuntime(e.paths.runtimeRoot, e.platform, e.arch);
}

export function currentJob(): ModelJob | null {
  return job ? { ...job } : null;
}

/// Waits for the job in progress (the CLI, tests).
export async function jobSettled(): Promise<ModelJob | null> {
  await running?.catch(() => undefined);
  return currentJob();
}

export function cancelJob(): ModelJob | null {
  if (!job || !controller || ["done", "failed", "cancelled"].includes(job.state)) return currentJob();
  controller.abort();
  return currentJob();
}

function catalogModel(id: string): CatalogModel | null {
  return loadCatalog(engine().env).models.find((model) => model.id === id) ?? null;
}

/// Starts installing a model of the catalogue. The same model asked again
/// while it downloads is the same job.
export function startModelJob(id: string, options: { force?: boolean; log?: (line: string) => void } = {}): ModelJob {
  const e = engine();
  const say = options.log ?? log;
  if (e.managedByDesktop) throw new JobError("managed_by_desktop", 409, "the Desktop app installs this computer's models");
  const model = catalogModel(id);
  if (!model) throw new JobError("unknown_model", 404, `${id} is not in the catalogue`);
  if (job && !["done", "failed", "cancelled"].includes(job.state)) {
    if (job.model === id) return currentJob()!;
    throw new JobError("job_running", 409, `${job.model} is being installed`);
  }
  if (!options.force && !modelFits(model, totalmem())) {
    throw new JobError("insufficient_memory", 507, `${model.name} needs ${model.minRamGb} GB of memory; this computer has ${Math.round(totalmem() / 1024 ** 3)} GB`);
  }
  const { overridden } = loadCatalog(e.env);
  controller = new AbortController();
  const signal = controller.signal;
  const mine: ModelJob = {
    id: `job-${Date.now().toString(36)}`,
    model: id,
    state: "runtime",
    received: 0,
    total: model.bytes,
    bytes_per_second: 0,
    error: null,
    message: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  job = mine;
  const finish = (state: JobState, error: string | null = null, message: string | null = null) => {
    mine.state = state;
    mine.error = error;
    mine.message = message;
    mine.finished_at = new Date().toISOString();
  };
  running = (async () => {
    try {
      if (!(await runtimeInstalled())) await ensureRuntimeInstalled({ signal, log: say });
      if (signal.aborted) throw new DownloadError("cancelled", "cancelled");
      mine.state = "downloading";
      if (LOCAL_ONLY) say(`[runtime] local-only mode: downloading ${model.file}, which the person asked for, from Hugging Face only`);
      say(`[runtime] downloading ${model.file} (${Math.round(model.bytes / 1024 ** 2)} MB)`);
      await downloadModel(model, e.paths.modelsDir, {
        signal,
        allowLoopback: overridden,
        onProgress: (progress) => {
          mine.state = progress.state === "done" ? "verifying" : progress.state;
          mine.received = progress.received;
          mine.bytes_per_second = progress.bytesPerSecond;
        },
      });
      await afterModelsChanged({ installed: id });
      finish("done");
      say(`[runtime] ${model.file} installed`);
    } catch (err) {
      if (signal.aborted || (err instanceof DownloadError && err.code === "cancelled") || (err instanceof RuntimeFetchError && err.code === "cancelled")) {
        finish("cancelled", "cancelled", "cancelled");
        return;
      }
      const code = err instanceof DownloadError || err instanceof RuntimeFetchError || err instanceof RuntimeError ? err.code : "failed";
      finish("failed", code, err instanceof Error ? err.message : String(err));
      say(`[runtime] installing ${model.file} failed: ${mine.message}`);
    }
  })();
  return currentJob()!;
}

/// After a model is added or removed: the default model is one that is
/// there, and a running runtime is restarted (the router reads its folder
/// when it starts).
async function afterModelsChanged(change: { installed?: string; removed?: string }): Promise<void> {
  const e = engine();
  const installed = await e.manager.installedModels();
  const { prefs } = e.prefs.read();
  const current = prefs.builtin.default_model;
  if (!current || !installed.includes(current)) {
    const next = change.installed && installed.includes(change.installed) ? change.installed : installed[0];
    e.prefs.write({ builtin: next ? { default_model: next } : { ...prefs.builtin, default_model: undefined } });
  }
  if (e.manager.status().running) await e.manager.restart().catch(() => null);
}

/// Removes an installed model of the catalogue (or any GGUF of the models folder).
export async function removeEngineModel(id: string): Promise<void> {
  const e = engine();
  if (e.managedByDesktop) throw new JobError("managed_by_desktop", 409, "the Desktop app removes this computer's models");
  if (!/^[\w.-]{1,80}$/.test(id)) throw new JobError("unknown_model", 404, `${id} is not installed`);
  if (job && job.model === id && !["done", "failed", "cancelled"].includes(job.state)) cancelJob();
  const known = catalogModel(id);
  const installed = await e.manager.installedModels();
  if (!installed.includes(id) && !(known && (await isInstalled(e.paths.modelsDir, known)))) {
    throw new JobError("unknown_model", 404, `${id} is not installed`);
  }
  const model: CatalogModel = known ?? { id, name: id, file: `${id}.gguf`, url: "", bytes: 0, sha256: "", minRamGb: 0, publisher: "", license: "" };
  // Out of memory first: a runtime holding it would keep the file open.
  if ((await e.manager.loadedModel()) === id) await e.manager.stop();
  await removeModel(e.paths.modelsDir, model);
  await afterModelsChanged({ removed: id });
}
