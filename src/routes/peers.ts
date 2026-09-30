import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { isOwnerSession, isPeerSessionKind, requireAuth } from "../auth.js";
import { BackendError } from "../account/backend.js";
import { accountPeers, authSessions, db } from "../db.js";
import { ownerRequest } from "../localAccess.js";
import { LocalOnlyError } from "../outbound.js";
import { listPeers, peerById, peerRequest, peerStatus, PeerUnavailableError, removePeer, requestPeer } from "../peers/index.js";
import { peerTrusted } from "../router/index.js";

// The account's other computers this one sends questions to
// (docs/multi-computer-design.md §3) — managed by Twoody Desktop, or by the
// owner of a headless server with the admin token; seen and switched on,
// off or trusted (GET, PATCH) by a device paired with it too:
//
//   GET    /api/v1/peers                 [{computer_id, name, kind, state, enabled, trusted, mesh, url?, error?, status?, status_at?}]
//          trusted: in the verified vault roster (vault/roster.ts), over its
//          bound tunnel key; mesh: the link was asked for because of it.
//   POST   /api/v1/peers {computer_id, name?, requester_computer_id?, requester_credential?}
//          → 202 {request_id, expires_at}
//          request_access (role "peer") with this server's tunnel key; the
//          Desktop then endorses request_id (POST /account_computers/:id/
//          authorizations/:rid/endorse) and this server picks up the sealed
//          answer by itself. Twoody Desktop, which signs in as its person,
//          says which computer of the account asks with that computer's id
//          and credential: sent on to the backend (X-Requester-Computer-
//          Credential), kept nowhere here. The backend then names the
//          request after that computer, or refuses it (403
//          invalid_requester_credential), never takes it for a device's.
//   PATCH  /api/v1/peers/:computer_id {enabled?, trusted?}  → 200 the peer
//          trusted is still stored but no longer decides (docs/mesh-design.md
//          §1): what the turns sent to a peer carry — memories, personal
//          data, document excerpts — follows the vault roster; « Faire
//          confiance » enrols the computer in the encrypted history.
//   DELETE /api/v1/peers/:computer_id
//   GET    /api/v1/peers/:computer_id/vault/identity  (Desktop only)
//          → {identity, pinned_tunnel_public_key}: the peer's GET
//          /api/v1/peer/vault/identity, asked through the sealed link this
//          server holds with it (peerRequest: its /tunnel on the LAN, else
//          the relay), never in clear; pinned_tunnel_public_key is the key
//          that link is sealed to. « Faire confiance à cet ordinateur » in
//          Twoody Desktop (docs/mesh-design.md §1, lot D1): the Desktop's
//          main process holds no tunnel of its own.
//   POST   /api/v1/peers/:computer_id/vault/anchor {vault_device_id, sign_public}
//          (Desktop only) → the peer's POST /api/v1/peer/vault/anchor, the
//          same way: the Desktop names its own vault device to it before
//          approving it.
//          Both: 409 not_linked (no sealed link with it), 502 unreachable,
//          else the peer's own status and error.

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
export async function requirePairedPerson(req: FastifyRequest, reply: FastifyReply): Promise<{ userId: string } | null> {
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
    // The verified vault roster decides (vault/roster.ts), not the switch
    // below: « Faire confiance » enrols the computer in the vault.
    trusted: peerTrusted(row),
    mesh: row.origin === "mesh",
    url: row.url,
    request_id: row.requestId,
    error: row.error,
    status: status?.status ?? null,
    status_at: status ? new Date(status.at).toISOString() : null,
  };
}

function failure(reply: FastifyReply, err: unknown) {
  if (err instanceof PeerUnavailableError) return reply.code(err.code === "not_linked" ? 409 : 422).send({ error: err.code, message: err.message });
  if (err instanceof BackendError && err.status === 403 && err.code === "invalid_requester_credential") return reply.code(403).send({ error: err.code, message: err.message });
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

  app.post<{ Body: { computer_id?: string | number; name?: string; requester_computer_id?: string | number; requester_credential?: string } }>("/peers", {
    schema: { tags: ["providers"], summary: "Ask another computer of the account for peer access (Desktop only)" },
    handler: async (req, reply) => {
      const auth = await requireDesktop(req, reply);
      if (!auth) return;
      const id = req.body?.computer_id;
      if ((typeof id !== "string" && typeof id !== "number") || String(id).length === 0 || String(id).length > 64) {
        return reply.code(422).send({ error: "computer_id is required" });
      }
      // Both or neither: a credential without its computer (or the other
      // way round) is not quietly sent as a device's request.
      const requesterId = req.body?.requester_computer_id;
      const credential = req.body?.requester_credential;
      const hasId = requesterId !== undefined && requesterId !== null;
      const hasCredential = credential !== undefined && credential !== null;
      if (hasId !== hasCredential) return reply.code(422).send({ error: "requester_computer_id and requester_credential go together" });
      let requester: { computerId: string; credential: string } | undefined;
      if (hasId) {
        if ((typeof requesterId !== "string" && typeof requesterId !== "number") || !/^[A-Za-z0-9-]{1,64}$/.test(String(requesterId))) {
          return reply.code(422).send({ error: "invalid requester_computer_id" });
        }
        if (typeof credential !== "string" || !/^[A-Za-z0-9_=-]{16,200}$/.test(credential)) return reply.code(422).send({ error: "invalid requester_credential" });
        requester = { computerId: String(requesterId), credential };
      }
      try {
        const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : undefined;
        return reply.code(202).send(await requestPeer(auth.userId, String(id), { name, requester }));
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

  // « Faire confiance à cet ordinateur » from Twoody Desktop: the peer's
  // vault identity and the Desktop's anchor, through the sealed link only.
  const throughLink = async (userId: string, computerId: string, path: string, init: { method?: string; body?: string }) => {
    const peer = peerById(userId, computerId);
    if (!peer || peer.state !== "linked" || !peer.token || !peer.tunnelKey) return { status: 409, body: { error: "not_linked" }, tunnelKey: null };
    try {
      const response = await peerRequest(peer, path, {
        ...init,
        headers: init.body !== undefined ? { "content-type": "application/json" } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      return { status: response.status, body: body && typeof body === "object" && !Array.isArray(body) ? body : {}, tunnelKey: peer.tunnelKey };
    } catch (err) {
      return { status: 502, body: { error: err instanceof PeerUnavailableError && err.code === "not_linked" ? "not_linked" : "unreachable" }, tunnelKey: null };
    }
  };
  const peerError = (body: Record<string, unknown>) => ({ error: typeof body.error === "string" ? body.error.slice(0, 64) : "peer_error" });
  // The peer's 401 (it no longer knows this computer) is not this session's.
  const peerStatusCode = (status: number) => (status === 401 ? 403 : status);

  app.get<{ Params: { id: string } }>("/peers/:id/vault/identity", {
    schema: { tags: ["providers"], summary: "A peer's vault identity, through the sealed link with it (Desktop only)" },
    handler: async (req, reply) => {
      const auth = await requireDesktop(req, reply);
      if (!auth) return;
      const answer = await throughLink(auth.userId, req.params.id, "/api/v1/peer/vault/identity", {});
      if (answer.status !== 200) return reply.code(peerStatusCode(answer.status)).send(peerError(answer.body));
      return reply.send({ identity: answer.body, pinned_tunnel_public_key: answer.tunnelKey });
    },
  });

  app.post<{ Params: { id: string }; Body: { vault_device_id: string; sign_public: string } }>("/peers/:id/vault/anchor", {
    schema: {
      tags: ["providers"],
      summary: "Name this Desktop's vault device to a peer, through the sealed link with it (Desktop only)",
      body: {
        type: "object",
        required: ["vault_device_id", "sign_public"],
        properties: {
          vault_device_id: { type: "string", minLength: 1, maxLength: 36 },
          sign_public: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireDesktop(req, reply);
      if (!auth) return;
      const body = JSON.stringify({ vault_device_id: req.body.vault_device_id, sign_public: req.body.sign_public });
      const answer = await throughLink(auth.userId, req.params.id, "/api/v1/peer/vault/anchor", { method: "POST", body });
      if (answer.status !== 200) return reply.code(peerStatusCode(answer.status)).send(peerError(answer.body));
      return reply.send({ anchored: true });
    },
  });
}
