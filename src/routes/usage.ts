import type { FastifyInstance } from "fastify";
import { and, eq, gte, isNotNull } from "drizzle-orm";
import { authSessions, db, devices, messages, tunnelPeers } from "../db.js";
import { requireAuth } from "../auth.js";

// What this computer's models answered, and for whom: the Devices screen of
// the Mac and of the iPhone (Jimmy, 28/09/2026, « ajoute-y aussi l'usage »).
// Counted from the answers kept with their tokens (messages.prompt_tokens,
// completion_tokens), so nothing is sent anywhere to know it.

/// Who asked, as the Devices screen names it: the paired phone by the name
/// it paired with, a device by its name, and this computer's own app as
/// « this-computer » (each screen says it in its language).
export function clientOf(auth: { sessionId?: string; deviceId?: string }): string | null {
  if (auth.deviceId) {
    const [device] = db.select({ name: devices.name }).from(devices).where(eq(devices.id, auth.deviceId)).limit(1).all();
    return device?.name ?? "device";
  }
  if (!auth.sessionId) return null;
  const [peer] = db.select({ name: tunnelPeers.name }).from(tunnelPeers).where(eq(tunnelPeers.sessionId, auth.sessionId)).limit(1).all();
  if (peer?.name) return peer.name;
  const [session] = db.select({ kind: authSessions.clientKind }).from(authSessions).where(eq(authSessions.id, auth.sessionId)).limit(1).all();
  if (!session) return null;
  if (session.kind.startsWith("pair:")) {
    const name = session.kind.slice("pair:".length);
    return name === "Twoody Desktop" ? "this-computer" : name || "device";
  }
  return session.kind === "desktop" ? "this-computer" : session.kind;
}

type Tally = { prompt_tokens: number; completion_tokens: number; messages: number };
const empty = (): Tally => ({ prompt_tokens: 0, completion_tokens: 0, messages: 0 });

export interface UsageSummary {
  days: number;
  totals: Tally;
  by_day: Array<Tally & { day: string }>;
  by_model: Array<Tally & { model: string }>;
  by_device: Array<Tally & { device: string }>;
}

/// The last `days` days of answers for this user, newest day first.
export function usageSummary(userId: string, days: number, now = new Date()): UsageSummary {
  const since = new Date(now.getTime() - days * 24 * 3600 * 1000);
  const rows = db
    .select({
      prompt: messages.promptTokens,
      completion: messages.completionTokens,
      model: messages.model,
      client: messages.client,
      at: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.role, "assistant"), isNotNull(messages.completionTokens), gte(messages.createdAt, since)))
    .all();
  const totals = empty();
  const byDay = new Map<string, Tally>();
  const byModel = new Map<string, Tally>();
  const byDevice = new Map<string, Tally>();
  const add = (map: Map<string, Tally>, key: string, prompt: number, completion: number) => {
    const tally = map.get(key) ?? empty();
    tally.prompt_tokens += prompt;
    tally.completion_tokens += completion;
    tally.messages += 1;
    map.set(key, tally);
  };
  for (const row of rows) {
    const prompt = row.prompt ?? 0;
    const completion = row.completion ?? 0;
    totals.prompt_tokens += prompt;
    totals.completion_tokens += completion;
    totals.messages += 1;
    add(byDay, row.at.toISOString().slice(0, 10), prompt, completion);
    add(byModel, row.model ?? "unknown", prompt, completion);
    add(byDevice, row.client ?? "unknown", prompt, completion);
  }
  const heaviest = <T extends Tally>(list: T[]) => list.sort((a, b) => b.prompt_tokens + b.completion_tokens - (a.prompt_tokens + a.completion_tokens));
  return {
    days,
    totals,
    by_day: [...byDay].map(([day, tally]) => ({ day, ...tally })).sort((a, b) => b.day.localeCompare(a.day)),
    by_model: heaviest([...byModel].map(([model, tally]) => ({ model, ...tally }))),
    by_device: heaviest([...byDevice].map(([device, tally]) => ({ device, ...tally }))),
  };
}

export async function usageRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { days?: string } }>("/usage", {
    schema: {
      tags: ["usage"],
      summary: "Tokens this computer's models spent answering, by day, model and device",
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const asked = Number.parseInt(req.query.days ?? "30", 10);
      const days = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 365) : 30;
      reply.send(usageSummary(auth.userId, days));
    },
  });
}
