import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { isOwnerSession, isPeerSessionKind, requireAuth } from "../auth.js";
import { BackendError } from "../account/backend.js";
import { accountPeers, authSessions, db } from "../db.js";
import { ownerRequest } from "../localAccess.js";
import { LocalOnlyError } from "../outbound.js";
import { listPeers, peerById, peerStatus, PeerUnavailableError, removePeer, requestPeer } from "../peers/index.js";

// The account's other computers this one sends questions to
// (docs/multi-computer-design.md §3) — managed by Twoody Desktop, or by the
// owner of a headless server with the admin token; seen and switched on,
// off or trusted (GET, PATCH) by a device paired with it too:
//
//   GET    /api/v1/peers                 [{computer_id, name, kind, state, enabled, trusted, url?, error?, status?, status_at?}]
//   POST   /api/v1/peers {computer_id, name?}  → 202 {request_id, expires_at}
//          request_access (role "peer") with this server's tunnel key; the
//          Desktop then endorses request_id (POST /account_computers/:id/
//          authorizations/:rid/endorse) and this server picks up the sealed
//          answer by itself.
//   PATCH  /api/v1/peers/:computer_id {enabled?, trusted?}  → 200 the peer
//          trusted (false until set): whether the turns sent to it carry this
//          computer's memories, personal data, document excerpts and
//          instructions from files — without it, the conversation only.
//   DELETE /api/v1/peers/:computer_id

/// The Desktop's own session — made by /auth/signup, /auth/signin or the
/// pairing with the setup token (auth_sessions.origin « owner ») — or this
/// machine / the admin token. Never by the name a device gave itself: a
/// phone approved through the account may call itself « Twoody Desktop ».
async function requireDesktop(req: FastifyRequest, reply: FastifyReply): Promise<{ userId: string } | null> {
  const auth = await requireAuth(req, reply);
  if (!auth) return null;
  if (isOwnerSession(auth.sessionId) || ownerRequest(req)) return auth;
  reply.code(403).send({ error: "desktop_only", message: "The account's computers are managed from Twoody Desktop." });
  return null;
}

/// Seeing the peers and choosing which to use or trust (GET, PATCH): the
/// Desktop as above, or a device paired with this computer — the iPhone,
/// by code or approved through the account — whose « Appareils » shows
/// them. Never a peer session (authenticate() refuses those here anyway),
/// never a session given to another computer of the account, and never a
/// firmware device's token.
async function requirePairedPerson(req: FastifyRequest, reply: FastifyReply): Promise<{ userId: string } | null> {
  const auth = await requireAuth(req, reply);
  if (!auth) return null;
  if (isOwnerSession(auth.sessionId) || ownerRequest(req)) return auth;
  if (auth.sessionId) {
    const [session] = db
      .select({ kind: authSessions.clientKind, requesterComputerId: authSessions.requesterComputerId })
      .from(authSessions)
      .where(eq(authSessions.id, auth.sessionId))
      .limit(1)
      .all();
    if (session && !isPeerSessionKind(session.kind) && !session.requesterComputerId) return auth;
  }
  reply.code(403).send({ error: "desktop_only", message: "The account's computers are managed from Twoody Desktop or a device paired with it." });
  return null;
}

function serialize(row: ReturnType<typeof listPeers>[number]) {
  const status = peerStatus(row.computerId);
  return {
    computer_id: row.computerId,
    name: row.name,
    kind: row.kind,
    platform: row.platform,
    state: row.state,
    enabled: row.enabled,
    trusted: row.trusted,
    url: row.url,
    request_id: row.requestId,
    error: row.error,
    status: status?.status ?? null,
    status_at: status ? new Date(status.at).toISOString() : null,
  };
}

function failure(reply: FastifyReply, err: unknown) {
  if (err instanceof PeerUnavailableError) return reply.code(err.code === "not_linked" ? 409 : 422).send({ error: err.code, message: err.message });
  if (err instanceof BackendError) return reply.code(err.status === 404 ? 404 : err.status === 429 ? 429 : 502).send({ error: err.code ?? "backend_error", message: err.message });
  if (err instanceof LocalOnlyError) return reply.code(403).send({ error: "local_only", message: err.message });
  return reply.code(502).send({ error: "backend_unreachable", message: err instanceof Error ? err.message : String(err) });
}

export async function peersRoutes(app: FastifyInstance) {
  app.get("/peers", {
    schema: { tags: ["providers"], summary: "The account's computers this one sends questions to (Desktop or a device paired with it)" },
    handler: async (req, reply) => {
      const auth = await requirePairedPerson(req, reply);
      if (!auth) return;
      return reply.send({ peers: listPeers(auth.userId).map(serialize) });
    },
  });

  app.post<{ Body: { computer_id?: string | number; name?: string } }>("/peers", {
    schema: { tags: ["providers"], summary: "Ask another computer of the account for peer access (Desktop only)" },
    handler: async (req, reply) => {
      const auth = await requireDesktop(req, reply);
      if (!auth) return;
      const id = req.body?.computer_id;
      if ((typeof id !== "string" && typeof id !== "number") || String(id).length === 0 || String(id).length > 64) {
        return reply.code(422).send({ error: "computer_id is required" });
      }
      try {
        const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : undefined;
        return reply.code(202).send(await requestPeer(auth.userId, String(id), { name }));
      } catch (err) {
        return failure(reply, err);
      }
    },
  });

  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; trusted?: boolean } }>("/peers/:id", {
    schema: { tags: ["providers"], summary: "Turn a peer on or off for the automatic choice, or trust it with this computer's person's data (Desktop or a device paired with it)" },
    handler: async (req, reply) => {
      const auth = await requirePairedPerson(req, reply);
      if (!auth) return;
      const peer = peerById(auth.userId, req.params.id);
      if (!peer) return reply.code(404).send({ error: "not_found" });
      const { enabled, trusted } = req.body ?? {};
      if ((enabled !== undefined && typeof enabled !== "boolean") || (trusted !== undefined && typeof trusted !== "boolean") || (enabled === undefined && trusted === undefined)) {
        return reply.code(422).send({ error: "enabled and trusted, when given, must be booleans; one of them is required" });
      }
      db.update(accountPeers)
        .set({ ...(enabled !== undefined ? { enabled } : {}), ...(trusted !== undefined ? { trusted } : {}), updatedAt: new Date() })
        .where(eq(accountPeers.computerId, peer.computerId))
        .run();
      return reply.code(200).send(serialize(peerById(auth.userId, req.params.id)!));
    },
  });

  app.delete<{ Params: { id: string } }>("/peers/:id", {
    schema: { tags: ["providers"], summary: "Forget a peer (Desktop only)" },
    handler: async (req, reply) => {
      const auth = await requireDesktop(req, reply);
      if (!auth) return;
      if (!(await removePeer(auth.userId, req.params.id))) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  });
}
