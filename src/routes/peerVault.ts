import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isOwnerSession, isPeerSessionKind, requireAuth } from "../auth.js";
import { forwardedByProxy, isLoopbackAddress, viaTunnel } from "../adminAccess.js";
import { linkedAccount } from "../account/store.js";
import { fromThisMachine, ownerRequest } from "../localAccess.js";
import { firstAnchorStatement, keepDeviceAccess, peerSessionIsDesktop, renewDeviceAccess, sealedFromSessionKey, sessionIsVaultDevice, sessionRow, type SessionRow } from "../sessionTrust.js";
import { readDeviceAccess } from "../account/approvals.js";
import { accountCredentials } from "../account/service.js";
import { VaultError } from "../vault/crypto.js";
import { pinVaultAnchor, vaultAnchorsHeld, vaultIdentity, vaultRosterInput } from "../vault/service.js";
import type { DeviceAccessV2 } from "../vault/contracts.js";

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
//     The first anchor (sessionTrust.ts firstAnchorStatement): while this
//     computer holds none, the roster is empty and no device-access can be
//     checked against it. A session let in by rule 1 (its tunnel key is a
//     pinned approver key, proved at login with the one-time secret) may
//     then send {vault_device_id, sign_public, device_access}: a
//     device-access/v2 for its own tunnel key and this computer, signed
//     by `sign_public`, naming `vault_device_id`. The anchor is pinned and
//     the session becomes that device in one step. Or it renews its
//     device-access first (POST /session/device-access takes it on the
//     same terms, against the key the vault lists) and anchors after.
//     Never a peer's, the console's or the owner's session, never once an
//     anchor exists, never without a pinned approver key.
//
//   POST /api/v1/peer/session/device-access {device-access/v2}
//     a Twoody Desktop's embedded server renews the statement its peer
//     session holds (sessionTrust.ts renewDeviceAccess), before naming its
//     person device as this computer's anchor: only for the vault device
//     the session already names, signed by that device's key as the vault
//     lists it. Whether it then pins is peerSessionIsDesktop's, in full.
//     → {vault_device_id, exp}
//
//   404 not_enrolled               no vault device yet (not linked, or no vault)
//   403 pinned_channel_required    not through the tunnel (nor from this machine)
//   403 anchor_not_allowed         (anchor) neither the owner nor that device
//                                  (nor that Desktop's embedded server)
//   403 no_anchor_yet              (anchor) a peer, while this computer trusts
//                                  no device yet: its first anchor is named
//                                  from the person's phone, or on its console
//                                  (`twoody-server approve`), never by a peer
//   403 approver_not_pinned        (anchor, and POST /session/device-access)
//                                  this computer trusts no device yet and was
//                                  linked before the one-time secret: no
//                                  approver key is pinned, so no phone can
//                                  name its first anchor until it is linked
//                                  again (`twoody-server login`)
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

/// The first anchor, pinned together with the statement that proves the
/// session is that device (firstAnchorStatement): all synchronous, so no
/// other anchor can come in between the check and the pin. Null when the
/// request does not qualify; throws what pinVaultAnchor throws.
function pinFirstAnchor(req: FastifyRequest, row: SessionRow | null, anchor: { id: string; sign_public: string }, access: (DeviceAccessV2 & { signature: string }) | null) {
  const account = linkedAccount();
  if (!row || !account || account.account_id === undefined || account.account_id === null || !access || access.vault_device_id !== anchor.id) return null;
  const ok = firstAnchorStatement(req, row, {
    userId: account.account_id,
    selfComputerId: account.computer.id,
    approvers: account.approvers.map((a) => a.public_key),
    anchorsHeld: vaultAnchorsHeld(),
    access,
    signPublic: anchor.sign_public,
  });
  if (!ok) return null;
  const result = pinVaultAnchor(anchor);
  keepDeviceAccess(row.id, access);
  return result;
}

/// POST /session/device-access, while this computer holds no anchor: the
/// statement is checked against the key the vault lists for the device it
/// names (the anchor route checks it again against the key it pins).
export async function firstAnchorRenewal(req: FastifyRequest, row: SessionRow, access: DeviceAccessV2 & { signature: string }): Promise<boolean> {
  const account = linkedAccount();
  const held = vaultAnchorsHeld();
  if (!account || account.account_id === undefined || account.account_id === null || !held || held.length > 0 || account.approvers.length === 0) return false;
  const input = await vaultRosterInput().catch(() => null);
  const device = input?.devices.find((d) => d.id === access.vault_device_id && d.status !== "revoked");
  if (!device) return false;
  return firstAnchorStatement(req, row, {
    userId: account.account_id,
    selfComputerId: account.computer.id,
    approvers: account.approvers.map((a) => a.public_key),
    anchorsHeld: vaultAnchorsHeld(),
    access,
    signPublic: device.sign_public,
  });
}

const refuse = { error: "pinned_channel_required", message: "Only through the tunnel, so that the account cannot change these keys." };

/// Whether a refused anchor came from a peer session while this computer,
/// enrolled in the history, holds no anchor at all: what no peer can change.
async function peerWithoutAnchor(sessionId: string | null | undefined): Promise<boolean> {
  const row = sessionRow(sessionId);
  if (!row || !isPeerSessionKind(row.kind) || !vaultIdentity()?.vault_device_id) return false;
  const input = await vaultRosterInput().catch(() => null);
  return !!input && input.anchors.length === 0;
}

/// Whether this computer, enrolled in the history, trusts no device yet and
/// pinned no approver key when it was linked (a link from before the
/// one-time secret, account/link.ts approverProved): then no device's
/// session can name its first anchor, and only linking it again helps.
/// Said as such (approver_not_pinned) so the phone or Desktop can tell the
/// person, instead of a bare refusal.
export async function approverNotPinned(): Promise<boolean> {
  if (!vaultIdentity()?.vault_device_id) return false;
  if ((linkedAccount()?.approvers.length ?? 0) > 0) return false;
  const input = await vaultRosterInput().catch(() => null);
  return !!input && input.anchors.length === 0;
}

function sendPinError(req: FastifyRequest, reply: FastifyReply, anchor: { id: string }, err: unknown) {
  const code = err instanceof VaultError ? err.code : "error";
  if (code === "anchor_conflict") req.log.warn({ vault_device_id: anchor.id }, "vault anchor refused: that device is pinned with another key");
  const status = ["desktop_custody", "already_approved", "anchor_conflict", "too_many_anchors"].includes(code) ? 409 : code === "bad_anchor" ? 422 : 404;
  return reply.code(status).send({ error: code === "not_registered" ? "not_enrolled" : code });
}

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

  app.post<{ Body: unknown }>("/peer/session/device-access", {
    schema: { tags: ["providers"], summary: "A Desktop's embedded server renews its peer session's device-access (tunnel only)" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!throughTunnel(req)) return reply.code(403).send(refuse);
      const result = await renewDeviceAccess(req, auth.sessionId, readDeviceAccess(req.body), {
        peer: true,
        selfComputerId: accountCredentials()?.computerId ?? null,
        roster: () => null,
        listedSignKey: async (vaultDeviceId) => {
          const input = await vaultRosterInput();
          const device = input?.devices.find((d) => d.id === vaultDeviceId && d.status !== "revoked");
          return input && device ? { userId: input.userId, signPublic: device.sign_public } : null;
        },
      });
      if (!result.ok) return reply.code(result.status).send({ error: result.error });
      return reply.send({ vault_device_id: result.vault_device_id, exp: result.exp });
    },
  });

  app.post<{ Body: { vault_device_id: string; sign_public: string; device_access?: unknown } }>("/peer/vault/anchor", {
    schema: {
      tags: ["providers"],
      summary: "The person device approving this computer names itself (tunnel only)",
      body: {
        type: "object",
        required: ["vault_device_id", "sign_public"],
        properties: {
          vault_device_id: { type: "string", maxLength: 36 },
          sign_public: { type: "string", pattern: "^[0-9a-f]{64}$" },
          device_access: { type: "object" },
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
        let first: ReturnType<typeof pinVaultAnchor> | null = null;
        try {
          first = req.body.device_access === undefined ? null : pinFirstAnchor(req, sessionRow(auth.sessionId), anchor, readDeviceAccess(req.body.device_access));
        } catch (err) {
          return sendPinError(req, reply, anchor, err);
        }
        if (first) {
          req.log.info({ vault_device_id: anchor.id, session: auth.sessionId ?? null }, "vault anchor: first anchor pinned by the approver device");
          return reply.send(first);
        }
        req.log.warn({ vault_device_id: anchor.id, session: auth.sessionId ?? null }, "vault anchor refused: neither the owner nor that device");
        // A peer (a Twoody Desktop) never gives this computer its first
        // anchor: said as such, for the Desktop to tell the person where to
        // start instead (« Faire confiance »).
        if (await approverNotPinned()) return reply.code(403).send({ error: "approver_not_pinned" });
        if (await peerWithoutAnchor(auth.sessionId)) return reply.code(403).send({ error: "no_anchor_yet" });
        return reply.code(403).send({ error: "anchor_not_allowed" });
      }
      try {
        return reply.send(pinVaultAnchor(anchor));
      } catch (err) {
        return sendPinError(req, reply, anchor, err);
      }
    },
  });
}
