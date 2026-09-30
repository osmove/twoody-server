import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { forwardedByProxy, isLoopbackAddress, viaTunnel } from "./adminAccess.js";
import { isOwnerSession, isPeerSessionKind } from "./auth.js";
import { authSessions, db, tunnelPeers } from "./db.js";
import { TUNNEL_PEER_HEADER } from "./tunnel/host.js";
import { deviceAccessV2Valid, type DeviceAccessV2 } from "./vault/contracts.js";
import { fromHex } from "./vault/crypto.js";
import type { Roster } from "./vault/roster.js";

// Who a session is, for what only the person's own devices may do
// (docs/mesh-design.md §1): name this computer's vault anchors, have this
// computer seal turns into the encrypted history, reach the documents of
// the person's other computers, delete a memory. Never a name a device
// chose, never what the account lists:
//
//   owner    this server's owner (auth.ts isOwnerSession: signup, signin,
//            the setup token — the Desktop that started it);
//   person   a session let in by rule 1 (the device that added this
//            computer) or rule 5 (vouched for by the vault) of
//            account/approvals.ts, carrying a device-access/v2 that its
//            vault device signed for this session's own tunnel key — the
//            signature checked, each time it counts, against that device's
//            key in the verified roster (or, for an anchor, the key being
//            pinned).
//
// Anyone else — a device paired by code, a household member's phone
// endorsed by a pinned approver (rule 2), one the console approved, a
// firmware device's token, another computer's `peer:` session — is none of
// these.

export type SessionRow = {
  id: string;
  kind: string;
  origin: string | null;
  vaultDeviceId: string | null;
  approvalRule: string | null;
  deviceAccessJson: string | null;
  requesterComputerId: string | null;
};

export function sessionRow(sessionId: string | null | undefined): SessionRow | null {
  if (!sessionId) return null;
  const [row] = db
    .select({
      id: authSessions.id,
      kind: authSessions.clientKind,
      origin: authSessions.origin,
      vaultDeviceId: authSessions.vaultDeviceId,
      approvalRule: authSessions.approvalRule,
      deviceAccessJson: authSessions.deviceAccessJson,
      requesterComputerId: authSessions.requesterComputerId,
    })
    .from(authSessions)
    .where(eq(authSessions.id, sessionId))
    .limit(1)
    .all();
  return row ?? null;
}

/// The tunnel keys a session was given with (lowercase hex).
export function sessionTunnelKeys(sessionId: string): string[] {
  return db
    .select({ publicKey: tunnelPeers.publicKey })
    .from(tunnelPeers)
    .where(eq(tunnelPeers.sessionId, sessionId))
    .all()
    .map((k) => k.publicKey.toLowerCase());
}

/// The key of the device at the other end of the tunnel that carried this
/// request, as tunnel/host.ts stamped it: only for a request the tunnel
/// really served (its marker, from this machine, no proxy in between —
/// the stamp alone could be typed by anyone on the network). Null
/// otherwise.
export function tunnelPeerKey(req: FastifyRequest): string | null {
  if (!viaTunnel(req) || !isLoopbackAddress(req.ip) || forwardedByProxy(req)) return null;
  const raw = req.headers[TUNNEL_PEER_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/// Whether this request came through the tunnel from the very key the
/// session was given to.
export function sealedFromSessionKey(req: FastifyRequest, sessionId: string): boolean {
  const key = tunnelPeerKey(req);
  return !!key && sessionTunnelKeys(sessionId).includes(key);
}

const PERSON_RULES = new Set(["approver", "device_access"]);

/// The device-access a session kept, for its own vault device and tunnel key.
function keptAccess(row: SessionRow): (DeviceAccessV2 & { signature: string }) | null {
  if (!row.deviceAccessJson || !row.vaultDeviceId || !row.approvalRule || !PERSON_RULES.has(row.approvalRule)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.deviceAccessJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { vault_device_id, tunnel_public_key, account_computer_id, exp, signature } = parsed ?? {};
  if (vault_device_id !== row.vaultDeviceId || typeof tunnel_public_key !== "string" || typeof account_computer_id !== "string" || typeof exp !== "number" || typeof signature !== "string") return null;
  if (!sessionTunnelKeys(row.id).includes(tunnel_public_key)) return null;
  return { vault_device_id, tunnel_public_key, account_computer_id, exp, signature };
}

/// Whether the session's vault device, holding `signPublic`, signed the
/// device-access it came with (rule 1 or 5): the session is that device.
/// The expiry was the approval's to check; this is about who it is.
export function sessionIsVaultDevice(row: SessionRow | null, userId: string | number, vaultDeviceId: string, signPublic: string): boolean {
  if (!row || row.vaultDeviceId !== vaultDeviceId) return false;
  const access = keptAccess(row);
  if (!access) return false;
  const { signature, ...stated } = access;
  try {
    return deviceAccessV2Valid({ userId, access: stated, signerSignPublic: fromHex(signPublic), signature });
  } catch {
    return false;
  }
}

/// The vault device of a person's own device session: a non-peer session
/// of rule 1 or 5 whose device is a person-device of the verified roster
/// that signed the session's device-access. Null otherwise.
export function personDeviceOf(sessionId: string | null | undefined, roster: Roster | null): string | null {
  const row = sessionRow(sessionId);
  if (!row || !roster || isPeerSessionKind(row.kind) || row.requesterComputerId || !row.vaultDeviceId) return null;
  const person = roster.persons.get(row.vaultDeviceId);
  if (!person) return null;
  return sessionIsVaultDevice(row, roster.userId, person.vaultDeviceId, person.signPublic) ? person.vaultDeviceId : null;
}

/// Who asked, as another computer's audit names them: this server's owner,
/// or the person's device by its vault device id; with the name the device
/// was paired under.
export type Requester = { id: string; name: string | null };

const nameOf = (row: SessionRow | null): string | null => {
  const name = row?.kind.includes(":") ? row.kind.slice(row.kind.indexOf(":") + 1) : null;
  const clean = name?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100);
  return clean || null;
};

/// This server's owner, or one of the person's own devices (above): who may
/// have this computer seal into the encrypted history, reach the other
/// computers' documents through it, or delete a memory. Null for anyone
/// else. `roster` is only asked for when the session is not the owner's.
export async function meshRequester(auth: { sessionId?: string | null }, roster: () => Promise<Roster | null> | Roster | null): Promise<Requester | null> {
  if (!auth.sessionId) return null;
  const row = sessionRow(auth.sessionId);
  if (isOwnerSession(auth.sessionId)) return { id: "owner", name: nameOf(row) };
  if (!row || isPeerSessionKind(row.kind) || !row.vaultDeviceId || !row.approvalRule || !PERSON_RULES.has(row.approvalRule)) return null;
  const device = personDeviceOf(auth.sessionId, await Promise.resolve(roster()).catch(() => null));
  return device ? { id: `person:${device}`, name: nameOf(row) } : null;
}

export async function isPersonOrOwner(auth: { sessionId?: string | null }, roster: () => Promise<Roster | null> | Roster | null): Promise<boolean> {
  return (await meshRequester(auth, roster)) !== null;
}

/// Sent by the computer passing a request on (documents/remote.ts) to the
/// one that holds the documents, for its audit: who asked it, as above.
export const REQUESTER_HEADER = "x-twoody-requester";
export const REQUESTER_NAME_HEADER = "x-twoody-requester-name";

export function requesterHeaders(requester: Requester | null | undefined): Record<string, string> {
  if (!requester) return {};
  return { [REQUESTER_HEADER]: requester.id, ...(requester.name ? { [REQUESTER_NAME_HEADER]: encodeURIComponent(requester.name) } : {}) };
}

/// What a computer of the roster says it asked for (never trusted for
/// anything but the audit's line), or null.
export function readRequester(headers: Record<string, string | string[] | undefined>): Requester | null {
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  const id = one(headers[REQUESTER_HEADER]).toLowerCase();
  if (!/^(owner|person:[0-9a-f-]{1,64})$/.test(id)) return null;
  let name: string | null = null;
  try {
    name = decodeURIComponent(one(headers[REQUESTER_NAME_HEADER])).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) || null;
  } catch {
    name = null;
  }
  return { id, name };
}
