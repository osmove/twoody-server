import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireAuth } from "../auth.js";
import { forwardedByProxy, isLoopbackAddress, viaTunnel } from "../adminAccess.js";
import { VaultError } from "../vault/crypto.js";
import { pinVaultAnchor, vaultIdentity } from "../vault/service.js";

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
//     from what the account says. → {anchors}
//
//   404 not_enrolled               no vault device yet (not linked, or no vault)
//   403 pinned_channel_required    not through the tunnel
//   409 desktop_custody            (anchor) inside Twoody Desktop, which keeps the keys

/// Served by the tunnel (tunnel/host.ts marks it and sends it from this
/// machine): the marker alone could be typed by anyone on the network, the
/// loopback address and no proxy in between cannot.
export function throughTunnel(req: FastifyRequest): boolean {
  return viaTunnel(req) && isLoopbackAddress(req.ip) && !forwardedByProxy(req);
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
      if (!throughTunnel(req)) return reply.code(403).send(refuse);
      try {
        return reply.send(pinVaultAnchor({ id: req.body.vault_device_id.toLowerCase(), sign_public: req.body.sign_public }));
      } catch (err) {
        const code = err instanceof VaultError ? err.code : "error";
        return reply.code(code === "desktop_custody" ? 409 : code === "bad_anchor" ? 422 : 404).send({ error: code === "not_registered" ? "not_enrolled" : code });
      }
    },
  });
}
