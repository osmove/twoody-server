// The status object a computer publishes (heartbeat, /api/v1/peer/status),
// test/fixtures/computer-status.schema.json. What this computer says of
// itself is built by `buildStatus` (account/statusSource.ts); what a peer
// says is read back through `readStatus`, which keeps only what the schema
// allows and drops the whole object when it is not one.

export type Purpose = "chat" | "background";

export interface ComputerStatus {
  app_version: string;
  models: Array<{ id: string; loaded: boolean }>;
  load: { cpu_pct: number | null; gpu_pct: number | null; ram_used_pct: number | null; at: string | null };
  tps: Record<string, number>;
  inflight: number;
  accepts: Purpose[];
  tools: boolean;
}

export const STATUS_MAX_BYTES = 4096;
const MAX_MODELS = 32;

const pct = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined;

/// A status from elsewhere, or null when it is not one.
export function readStatus(raw: unknown): ComputerStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.app_version !== "string" || s.app_version.length > 32) return null;
  if (!Array.isArray(s.models) || s.models.length > MAX_MODELS) return null;
  const models: ComputerStatus["models"] = [];
  for (const m of s.models) {
    if (!m || typeof m !== "object") return null;
    const { id, loaded } = m as Record<string, unknown>;
    if (typeof id !== "string" || !id || id.length > 80 || typeof loaded !== "boolean") return null;
    models.push({ id, loaded });
  }
  const load = s.load as Record<string, unknown> | null;
  if (!load || typeof load !== "object") return null;
  const cpu = pct(load.cpu_pct);
  const gpu = pct(load.gpu_pct);
  const ram = pct(load.ram_used_pct);
  if (cpu === undefined || gpu === undefined || ram === undefined) return null;
  if (!(load.at === null || (typeof load.at === "string" && load.at.length <= 32))) return null;
  if (!s.tps || typeof s.tps !== "object" || Array.isArray(s.tps)) return null;
  const tps: Record<string, number> = {};
  const entries = Object.entries(s.tps as Record<string, unknown>);
  if (entries.length > MAX_MODELS) return null;
  for (const [model, value] of entries) {
    if (model.length > 80 || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100000) return null;
    tps[model] = value;
  }
  if (!Number.isInteger(s.inflight) || (s.inflight as number) < 0 || (s.inflight as number) > 64) return null;
  if (!Array.isArray(s.accepts) || s.accepts.length > 2) return null;
  const accepts: Purpose[] = [];
  for (const a of s.accepts) {
    if ((a !== "chat" && a !== "background") || accepts.includes(a)) return null;
    accepts.push(a);
  }
  if (typeof s.tools !== "boolean") return null;
  const status: ComputerStatus = {
    app_version: s.app_version,
    models,
    load: { cpu_pct: cpu, gpu_pct: gpu, ram_used_pct: ram, at: (load.at as string | null) ?? null },
    tps,
    inflight: s.inflight as number,
    accepts,
    tools: s.tools,
  };
  return Buffer.byteLength(JSON.stringify(status)) <= STATUS_MAX_BYTES ? status : null;
}

/// Trims what this computer is about to publish so it always fits:
/// fewer models (loaded first) until it is under the size limit.
export function boundStatus(status: ComputerStatus): ComputerStatus {
  const round = (v: number | null) => (v === null ? null : Math.round(Math.min(100, Math.max(0, v)) * 10) / 10);
  const models = [...status.models]
    .filter((m) => m.id && m.id.length <= 80)
    .sort((a, b) => Number(b.loaded) - Number(a.loaded))
    .slice(0, MAX_MODELS);
  const out: ComputerStatus = {
    app_version: status.app_version.slice(0, 32),
    models,
    load: {
      cpu_pct: round(status.load.cpu_pct),
      gpu_pct: round(status.load.gpu_pct),
      ram_used_pct: round(status.load.ram_used_pct),
      at: status.load.at,
    },
    tps: Object.fromEntries(
      Object.entries(status.tps)
        .filter(([m, v]) => m.length <= 80 && Number.isFinite(v) && v >= 0)
        .slice(0, MAX_MODELS)
        .map(([m, v]) => [m, Math.round(Math.min(v, 100000) * 10) / 10]),
    ),
    inflight: Math.max(0, Math.min(64, Math.floor(status.inflight))),
    accepts: status.accepts,
    tools: status.tools,
  };
  while (Buffer.byteLength(JSON.stringify(out)) > STATUS_MAX_BYTES && out.models.length > 0) {
    const dropped = out.models.pop()!;
    delete out.tps[dropped.id];
  }
  return out;
}
