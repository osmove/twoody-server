import { eq } from "drizzle-orm";
import { computerName } from "../account/link.js";
import { accountCredentials } from "../account/service.js";
import { buildStatus, lastLoad } from "../account/statusSource.js";
import type { Purpose } from "../account/status.js";
import { db, providers } from "../db.js";
import { engineRoute } from "../engine.js";
import { accountComputers, linkedPeers, peerStatus, type PeerRow } from "../peers/index.js";
import { rank, STATUS_MAX_AGE_MS, type Choice, type ComputerView } from "./score.js";

// The router's view of the account's computers: this one, measured now,
// and its peers as they last said (peers/index.ts polls them). The
// choosing itself is score.ts.

export const SELF_ID = "self";

/// This computer's id among the account's computers ("self" when it does
/// not know it), and its name.
export function selfIdentity(): { id: string; name: string } {
  const creds = accountCredentials();
  return { id: creds?.computerId ?? SELF_ID, name: creds?.computerName ?? computerName() };
}

export function isSelf(computerId: string): boolean {
  return computerId === SELF_ID || computerId === selfIdentity().id;
}

/// The model this computer answers with unless told otherwise: its default
/// stored provider's, else its engine's (the built-in runtime's
/// `default_model`, engine.ts).
async function defaultModel(userId: string): Promise<string | null> {
  const rows = db.select().from(providers).where(eq(providers.userId, userId)).all().filter((p) => p.enabled);
  const chosen = rows.find((p) => p.isDefault) ?? rows[0];
  if (chosen?.model) return chosen.model;
  return (await engineRoute(null).catch(() => null))?.model ?? null;
}

export async function selfView(userId: string): Promise<ComputerView> {
  const me = selfIdentity();
  const status = await buildStatus(userId);
  return {
    id: me.id,
    name: me.name,
    self: true,
    platform: `${process.platform === "darwin" ? "macos" : process.platform}-${process.arch}`,
    kind: null,
    status,
    statusAgeMs: 0,
    loads: lastLoad(userId).map((l) => ({ cpu_pct: l.cpuPct, gpu_pct: l.gpuPct })),
    defaultModel: await defaultModel(userId),
  };
}

export function peerView(peer: PeerRow, now = Date.now()): ComputerView | null {
  const entry = peerStatus(peer.computerId);
  if (!entry) return null;
  return {
    id: peer.computerId,
    name: peer.name,
    self: false,
    platform: peer.platform,
    kind: peer.kind,
    status: entry.status,
    statusAgeMs: now - entry.at,
    loads: entry.loads.map((l) => ({ cpu_pct: l.cpu_pct, gpu_pct: l.gpu_pct })),
  };
}

export async function computerViews(userId: string, options: { withSelf?: boolean } = {}): Promise<ComputerView[]> {
  const views: ComputerView[] = [];
  if (options.withSelf !== false) views.push(await selfView(userId));
  for (const peer of linkedPeers(userId)) {
    const view = peerView(peer);
    if (view) views.push(view);
  }
  return views;
}

export const EXPECTED_TOKENS: Record<Purpose, number> = { chat: 300, background: 150 };

export async function pick(args: { userId: string; model: string | null; purpose: Purpose; tools?: boolean; previous?: string | null }): Promise<Choice[]> {
  return rank(await computerViews(args.userId), {
    model: args.model,
    tools: args.tools ?? false,
    purpose: args.purpose,
    tokens: EXPECTED_TOKENS[args.purpose],
    previous: args.previous ?? null,
  });
}

/// Where background work (memory extraction) runs: the computer set in
/// « Tâches de fond » (`background_computer`: "auto" | "self" |
/// "computer:<id>") when it is idle — nothing running, CPU under 50 % —
/// else this computer. Null means this computer. Only a trusted peer may
/// do it: the work reads what the person said and what is kept of them.
export async function pickBackground(args: { userId: string; preference: unknown; model: string | null }): Promise<Choice | null> {
  const preference = typeof args.preference === "string" ? args.preference : "auto";
  if (preference === "self") return null;
  const idle = (view: ComputerView) => view.status.inflight === 0 && (view.loads.at(-1)?.cpu_pct ?? view.status.load.cpu_pct ?? 0) < 50;
  const trusted = new Set(linkedPeers(args.userId).filter((peer) => peer.trusted).map((peer) => peer.computerId));
  const peers = (await computerViews(args.userId, { withSelf: false })).filter((v) => trusted.has(v.id) && v.statusAgeMs < STATUS_MAX_AGE_MS && idle(v));
  const wanted = preference.startsWith("computer:") ? preference.slice("computer:".length) : null;
  if (wanted && isSelf(wanted)) return null;
  const pool = wanted ? peers.filter((v) => v.id === wanted) : peers;
  if (pool.length === 0) return null;
  const self = await selfView(args.userId);
  const ranked = rank(wanted ? pool : [self, ...pool], { model: args.model, tools: false, purpose: "background", tokens: EXPECTED_TOKENS.background });
  const best = ranked[0];
  return best && !best.self ? best : null;
}

export interface ComputerEntry {
  id: string;
  name: string;
  kind: string | null;
  self: boolean;
  online: boolean;
  /// Linked as a peer: this computer can send it questions.
  peer: boolean;
  /// Whether the turns it answers carry this computer's person's data
  /// (memories, personal data, documents). Always so for this computer;
  /// for a peer, as the Desktop set it (false until then).
  trusted: boolean;
  models: Array<{ id: string; loaded: boolean; tps: number | null }>;
}

/// /providers `computers`: this computer, then the account's others —
/// the peers with what they said, the rest as the account lists them.
/// Null when this server knows no account.
export async function listComputers(userId: string): Promise<ComputerEntry[] | null> {
  if (!accountCredentials()) return null;
  const me = await selfView(userId);
  const models = (view: ComputerView) => view.status.models.map((m) => ({ id: m.id, loaded: m.loaded, tps: view.status.tps[m.id] ?? null }));
  const out: ComputerEntry[] = [{ id: me.id, name: me.name, kind: me.kind ?? null, self: true, online: true, peer: false, trusted: true, models: models(me) }];
  const peers = linkedPeers(userId);
  const listed = (await accountComputers()) ?? [];
  const seen = new Set<string>([me.id]);
  for (const peer of peers) {
    const view = peerView(peer);
    const listing = listed.find((c) => c.id === peer.computerId);
    seen.add(peer.computerId);
    out.push({
      id: peer.computerId,
      name: listing?.name ?? peer.name,
      kind: peer.kind ?? listing?.kind ?? null,
      self: false,
      online: view ? view.statusAgeMs < STATUS_MAX_AGE_MS : false,
      peer: true,
      trusted: peer.trusted,
      models: view ? models(view) : [],
    });
  }
  for (const computer of listed) {
    if (seen.has(computer.id)) continue;
    seen.add(computer.id);
    out.push({
      id: computer.id,
      name: computer.name,
      kind: computer.kind,
      self: false,
      online: computer.online,
      peer: false,
      trusted: false,
      models: computer.status ? computer.status.models.map((m) => ({ id: m.id, loaded: m.loaded, tps: computer.status!.tps[m.id] ?? null })) : [],
    });
  }
  return out;
}
