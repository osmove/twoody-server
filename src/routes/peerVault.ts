import type { FastifyInstance, FastifyRequest } from "fastify";
import { isOwnerSession, isPeerSessionKind, requireAuth } from "../auth.js";
import { forwardedByProxy, isLoopbackAddress, viaTunnel } from "../adminAccess.js";
import { linkedAccount } from "../account/store.js";
import { fromThisMachine, ownerRequest } from "../localAccess.js";
import { peerSessionIsDesktop, sealedFromSessionKey, sessionIsVaultDevice, sessionRow } from "../sessionTrust.js";
import { VaultError } from "../vault/crypto.js";
import { pinVaultAnchor, vaultIdentity, vaultRosterInput } from "../vault/service.js";

// This computer as a member of the encrypted history (docs/mesh-design.md
// §1, lot S1), for the person device about to approve it — over the sealed
// tunnel only (relay or direct), the one channel the account cannot put
// itself in the middle of. Never over plain HTTP on the network: the phone
// or Desktop reads these keys to sign them.
//
//   GET  /api/v1/peer/vault/identity
//     {custody: "server"|"desktop", vault_device_id, enc_public, sign_public,
//      fingerprint, status, kind?, account_computer_id?, can_approve?,
//      tunnel_public_key?, pairing_public_key?}   public keys only
//   POST /api/v1/peer/vault/anchor {vault_device_id, sign_public}
//     the approving person device names itself: this computer's trust in
//     the history starts there (src/vault/client.ts verifiedIds), never
//     from what the account says. → {anchors, pinned}
//     Only this server's owner (its session, this machine, the admin
//     token), or the very device being pinned: a session let in by rule 1
//     or 5 (account/approvals.ts) whose device-access/v2 names that vault
//     device and is signed by the key being pinned, asking through the
//     tunnel from the key the session was given to (sessionTrust.ts); or a
//     Twoody Desktop's embedded server, a peer session let in by rule 1 or
//     2 naming the Desktop's computer, carrying the same statement by the
//     key being pinned, for a person device the anchors already held
//     reach, whose desktop-binding (in the vault, signed by that key)
//     names that computer and the session's tunnel key (sessionTrust.ts
//     peerSessionIsDesktop). Any other peer — one the console approved, a
//     computer of the roster, one naming a device that only approves
//     itself, any peer before the first anchor — refused.
//     Only while this computer is not approved yet; a pinned anchor is
//     never replaced nor pushed out.
//
//   404 not_enrolled               no vault device yet (not linked, or no vault)
//   403 pinned_channel_required    not through the tunnel (nor from this machine)
//   403 anchor_not_allowed         (anchor) neither the owner nor that device
//                                  (nor that Desktop's embedded server)
//   409 desktop_custody            (anchor) inside Twoody Desktop, which keeps the keys
//   409 already_approved           (anchor) this computer holds epoch keys already
//   409 anchor_conflict            (anchor) that device is pinned with another key
//   409 too_many_anchors           (anchor) 8 are pinned

/// Served by the tunnel (tunnel/host.ts marks it and sends it from this
/// machine): the marker alone could be typed by anyone on the network, the
/// loopback address and no proxy in between cannot.
export function throughTunnel(req: FastifyRequest): boolean {
  return viaTunnel(req) && isLoopbackAddress(req.ip) && !forwardedByProxy(req);
}

/// Who may name an anchor: the owner (its session, or this machine / the
/// admin token), or the device being pinned itself, proved by the
/// device-access its session carries, signed by the key being pinned, over
/// the tunnel from that session's own key.
async function mayPin(req: FastifyRequest, auth: { sessionId?: string }, anchor: { id: string; sign_public: string }): Promise<boolean> {
  if (isOwnerSession(auth.sessionId) || ownerRequest(req)) return true;
  if (!auth.sessionId || !sealedFromSessionKey(req, auth.sessionId)) return false;
  const row = sessionRow(auth.sessionId);
  const account = linkedAccount();
  const userId = account?.account_id;
  if (!row || !account || userId === undefined || userId === null) return false;
  if (!isPeerSessionKind(row.kind)) return sessionIsVaultDevice(row, userId, anchor.id, anchor.sign_public);
  // A Desktop asking as its computer: its person device's desktop-binding
  // is read from the vault (signed by the key being pinned), and that
  // device must be one the anchors already held reach.
  const input = await vaultRosterInput().catch(() => null);
  return peerSessionIsDesktop(row, { userId, selfComputerId: account.computer.id, anchor, devices: input?.devices ?? [], anchors: input?.anchors ?? [] });
}

const refuse = { error: "pinned_channel_required", message: "Only through the tunnel, so that the account cannot change these keys." };

export async function peerVaultRoutes(app: FastifyInstance) {
  app.get("/peer/vault/identity", {
    schema: { tags: ["providers"], summary: "This computer's vault public keys, for the device that approves it (tunnel only)" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!throughTunnel(req)) return reply.code(403).send(refuse);
      const identity = vaultIdentity();
      if (!identity?.vault_device_id) return reply.code(404).send({ error: "not_enrolled" });
      return reply.send(identity);
    },
  });

  app.post<{ Body: { vault_device_id: string; sign_public: string } }>("/peer/vault/anchor", {
    schema: {
      tags: ["providers"],
      summary: "The person device approving this computer names itself (tunnel only)",
      body: {
        type: "object",
        required: ["vault_device_id", "sign_public"],
        properties: {
          vault_device_id: { type: "string", maxLength: 36 },
          sign_public: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const local = fromThisMachine(req);
      if (!throughTunnel(req) && !local) return reply.code(403).send(refuse);
      const anchor = { id: req.body.vault_device_id.toLowerCase(), sign_public: req.body.sign_public };
      if (!(await mayPin(req, auth, anchor))) {
        req.log.warn({ vault_device_id: anchor.id, session: auth.sessionId ?? null }, "vault anchor refused: neither the owner nor that device");
        return reply.code(403).send({ error: "anchor_not_allowed" });
      }
      try {
        return reply.send(pinVaultAnchor(anchor));
      } catch (err) {
        const code = err instanceof VaultError ? err.code : "error";
        if (code === "anchor_conflict") req.log.warn({ vault_device_id: anchor.id }, "vault anchor refused: that device is pinned with another key");
        const status = ["desktop_custody", "already_approved", "anchor_conflict", "too_many_anchors"].includes(code) ? 409 : code === "bad_anchor" ? 422 : 404;
        return reply.code(status).send({ error: code === "not_registered" ? "not_enrolled" : code });
      }
    },
  });
}
