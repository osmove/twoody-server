import type { ComputerStatus, Purpose } from "../account/status.js";

// Which of the account's computers answers a turn (docs/multi-computer-
// design.md §3). Pure: the computers as they said they are, the turn, and
// the previous turn's computer in; the candidates in the order to try them
// out.
//
//   1. candidates: this computer and the enabled peers whose status is less
//      than 60 s old, holding the exact model (or, for « Automatique », the
//      model they have loaded), with tools when the turn uses tools, and
//      taking this purpose;
//   2. out: those at their limit of generations, and those whose memory is
//      over 90 % used when the model is not loaded;
//   3. est = tokens / tps_p50(model, computer) + (loaded ? 0 : 10 s)
//            + inflight × 15 s, × 1.5 when CPU or GPU was over 85 % in both
//      of the last two samples; a model never measured there counts 10 tok/s
//      on a Linux ARM machine, 30 elsewhere;
//   4. the previous turn's computer keeps the conversation unless another is
//      at least 30 % faster (its runtime holds the conversation in cache);
//      this computer wins within 20 % (nothing crosses the network).

export const STATUS_MAX_AGE_MS = 60_000;
export const MAX_INFLIGHT = 2;
export const LOAD_PENALTY_S = 10;
export const INFLIGHT_PENALTY_S = 15;
export const HOT_PCT = 85;
export const HOT_FACTOR = 1.5;
export const RAM_FULL_PCT = 90;
export const STICKY_BETTER = 0.7;
export const SELF_TIE = 1.2;

export interface ComputerView {
  id: string;
  name: string;
  self: boolean;
  /// e.g. "linux-arm64", "linux", "macos": the prior speed depends on it.
  platform: string | null;
  kind: string | null;
  status: ComputerStatus;
  /// How old the status is (0 for this computer, measured now).
  statusAgeMs: number;
  /// The last two load samples, oldest first.
  loads: Array<Pick<ComputerStatus["load"], "cpu_pct" | "gpu_pct">>;
  /// For this computer: the model its default provider names, which
  /// « Automatique » uses when nothing is loaded.
  defaultModel?: string | null;
}

export interface RouteAsk {
  /// null: « Automatique », each computer with the model it has loaded.
  model: string | null;
  tools: boolean;
  purpose: Purpose;
  /// Tokens the answer is expected to be.
  tokens: number;
  /// The computer that answered the previous turn of this conversation.
  previous?: string | null;
}

export interface Choice {
  computerId: string;
  name: string;
  self: boolean;
  model: string;
  loaded: boolean;
  est: number;
}

export function priorTps(view: Pick<ComputerView, "platform" | "kind" | "self">): number {
  const platform = (view.platform ?? "").toLowerCase();
  const linux = platform.startsWith("linux");
  const arm = /arm|aarch/.test(platform);
  // The backend knows a headless computer's OS, not its processor: a Linux
  // server is taken for what it most often is, a Raspberry Pi.
  if (linux && (arm || (!view.self && view.kind === "server" && !/x64|x86|amd64/.test(platform)))) return 10;
  return 30;
}

function hot(loads: ComputerView["loads"]): boolean {
  if (loads.length === 0) return false;
  const lastTwo = loads.slice(-2);
  return lastTwo.every((l) => (l.cpu_pct ?? 0) > HOT_PCT || (l.gpu_pct ?? 0) > HOT_PCT);
}

/// The model this computer would answer with, or null when it cannot.
function modelFor(view: ComputerView, ask: RouteAsk): { id: string; loaded: boolean } | null {
  const models = view.status.models;
  if (ask.model) {
    const exact = models.find((m) => m.id === ask.model);
    return exact ? { id: exact.id, loaded: exact.loaded } : null;
  }
  const loaded = models.find((m) => m.loaded);
  if (loaded) return { id: loaded.id, loaded: true };
  if (view.defaultModel) {
    const named = models.find((m) => m.id === view.defaultModel);
    if (named) return { id: named.id, loaded: named.loaded };
  }
  return models[0] ? { id: models[0].id, loaded: false } : null;
}

export function estimate(view: ComputerView, model: { id: string; loaded: boolean }, tokens: number): number {
  const tps = view.status.tps[model.id] ?? priorTps(view);
  let est = tokens / Math.max(tps, 0.1) + (model.loaded ? 0 : LOAD_PENALTY_S) + view.status.inflight * INFLIGHT_PENALTY_S;
  if (hot(view.loads)) est *= HOT_FACTOR;
  return Math.round(est * 100) / 100;
}

/// The candidates, best first; the first is the pick, the others the
/// fallbacks in order.
export function rank(computers: ComputerView[], ask: RouteAsk): Choice[] {
  const candidates: Choice[] = [];
  for (const view of computers) {
    if (!view.self && view.statusAgeMs >= STATUS_MAX_AGE_MS) continue;
    if (!view.self && !view.status.accepts.includes(ask.purpose)) continue;
    if (ask.tools && !view.status.tools) continue;
    const model = modelFor(view, ask);
    if (!model) continue;
    if (view.status.inflight >= MAX_INFLIGHT) continue;
    if (!model.loaded && (view.status.load.ram_used_pct ?? 0) > RAM_FULL_PCT) continue;
    candidates.push({ computerId: view.id, name: view.name, self: view.self, model: model.id, loaded: model.loaded, est: estimate(view, model, ask.tokens) });
  }
  candidates.sort((a, b) => a.est - b.est || Number(b.self) - Number(a.self));
  if (candidates.length < 2) return candidates;

  let chosen = candidates[0]!;
  const self = candidates.find((c) => c.self);
  if (self && !chosen.self && self.est <= chosen.est * SELF_TIE) chosen = self;
  const previous = ask.previous ? candidates.find((c) => c.computerId === ask.previous) : undefined;
  if (previous && previous !== chosen && !(chosen.est <= previous.est * STICKY_BETTER)) chosen = previous;
  return [chosen, ...candidates.filter((c) => c !== chosen)];
}
