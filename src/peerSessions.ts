import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { extractAuthToken, isPeerSessionKind, peerMayReach, sha256 } from "./auth.js";
import { authSessions, db } from "./db.js";

// A session given to another of the account's computers (`peer:<name>`,
// pairing.ts) is for sending it questions, nothing else: it reaches
// /api/v1/peer/* and is refused everywhere else — the conversations,
// memories, documents and settings of this computer stay its own person's
// business, even from the same account's other machine.

// authenticate() (auth.ts) refuses a peer session outside /api/v1/peer/*
// whatever carries its token; this hook answers 403 rather than 401 to the
// ones that carry it in a header, which says why.

export { isPeerSessionKind, PEER_PREFIX, peerMayReach } from "./auth.js";

/// The kind of the session a request carries, when it carries one.
export function sessionKindOf(req: FastifyRequest): string | null {
  const token = extractAuthToken(req);
  if (!token) return null;
  const [session] = db
    .select({ kind: authSessions.clientKind })
    .from(authSessions)
    .where(eq(authSessions.tokenDigest, sha256(token)))
    .limit(1)
    .all();
  return session?.kind ?? null;
}

/// Fastify onRequest hook: a peer session outside /api/v1/peer/* is 403.
export async function enforcePeerScope(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (peerMayReach(req.url)) return;
  if (!isPeerSessionKind(sessionKindOf(req))) return;
  await reply.code(403).send({ error: "peer_session_forbidden", message: "A computer of the account may only use /api/v1/peer/* here." });
}
