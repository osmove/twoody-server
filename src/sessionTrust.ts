import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { forwardedByProxy, isLoopbackAddress, viaTunnel } from "./adminAccess.js";
import { isOwnerSession, isPeerSessionKind } from "./auth.js";
import { authSessions, db, tunnelPeers } from "./db.js";
import { TUNNEL_PEER_HEADER } from "./tunnel/host.js";
import { desktopBindingOf, verifiedIds, type Anchor, type VaultDevice } from "./vault/client.js";
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
//            pinned), and its expiry too: a statement past its `exp` no
//            longer says who the session is. It counts only for a request
//            that came through the tunnel from the session's own key.
//
// Anyone else — a device paired by code, a household member's phone
// endorsed by a pinned approver (rule 2), one the console approved, a
// firmware device's token, another computer's `peer:` session — is none of
// these.
//
// One peer session may name itself as this computer's vault anchor
// (routes/peerVault.ts), nothing else: a Twoody Desktop's embedded server,
// which asks as the Desktop's computer of the account and carries a
// device-access/v2 the Desktop's person device signed
// (peerSessionIsDesktop below) — and only for a person device this
// computer already reaches from the anchors it holds: a peer never starts
// this computer's trust, it only names itself once that trust reaches it.

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
/// The rules under which a peer session may name its person device as an
/// anchor (peerSessionIsDesktop): the approver key proved at login, or a
/// request it endorsed. Never the console's, nor rule 4's.
const PEER_PIN_RULES = new Set(["approver", "endorsed"]);

/// The device-access a session kept, for its own vault device and tunnel key.
function keptAccess(row: SessionRow): (DeviceAccessV2 & { signature: string }) | null {
  if (!row.approvalRule || !PERSON_RULES.has(row.approvalRule)) return null;
  return keptStatement(row);
}

/// The device-access a session kept, whatever let it in, while it has not
/// expired: it says who the session is only until its `exp`.
function keptStatement(row: SessionRow, now = Date.now()): (DeviceAccessV2 & { signature: string }) | null {
  if (!row.deviceAccessJson || !row.vaultDeviceId) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.deviceAccessJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { vault_device_id, tunnel_public_key, account_computer_id, exp, signature } = parsed ?? {};
  if (vault_device_id !== row.vaultDeviceId || typeof tunnel_public_key !== "string" || typeof account_computer_id !== "string" || typeof exp !== "number" || typeof signature !== "string") return null;
  if (!Number.isSafeInteger(exp) || exp * 1000 <= now) return null;
  if (!sessionTunnelKeys(row.id).includes(tunnel_public_key)) return null;
  return { vault_device_id, tunnel_public_key, account_computer_id, exp, signature };
}

/// Whether the session's vault device, holding `signPublic`, signed the
/// device-access it came with (rule 1 or 5), not yet expired: the session
/// is that device.
export function sessionIsVaultDevice(row: SessionRow | null, userId: string | number, vaultDeviceId: string, signPublic: string): boolean {
  if (!row || isPeerSessionKind(row.kind) || row.requesterComputerId || row.vaultDeviceId !== vaultDeviceId) return false;
  const access = keptAccess(row);
  if (!access) return false;
  const { signature, ...stated } = access;
  try {
    return deviceAccessV2Valid({ userId, access: stated, signerSignPublic: fromHex(signPublic), signature });
  } catch {
    return false;
  }
}

/// Whether a peer session is a Twoody Desktop's embedded server, the
/// Desktop's person device `anchor` (its id and signing key) asking as its
/// own computer of the account — for that device to name itself as this
/// computer's vault anchor, before this computer trusts anyone:
///
///   - a `peer:` session naming its requester computer (the account checked
///     that computer's credential), that kept a device-access/v2 for this
///     computer and one of the session's own tunnel keys, naming `anchor`
///     and signed by `anchor`'s key;
///   - the session let in by rule 1 (`approver`: its key is the one that
///     approved this computer's login, proved with the console's secret,
///     account/link.ts) or rule 2 (`endorsed` by such a key) — never by
///     the console (`twoody-server approve`, where only a name the account
///     chose is shown) nor as a computer of the roster (rule 4);
///   - `anchor` listed in the vault (`devices`, GET /vault) under that very
///     key, a person device this computer already reaches by walking
///     forward from the anchors it holds (`anchors`, vault/client.ts
///     verifiedIds) — never a device that only approves itself, which
///     the account could make up — whose desktop-binding, signed by that
///     same key (vault/client.ts desktopBindingOf), names the requester
///     computer and the tunnel key the statement is for.
///
/// Everything rests on `anchor`'s key, which the anchors already held
/// vouch for: the account cannot forge either statement, only withhold
/// them. With no anchor yet, no peer pins. A computer's own
/// vault device (a Pi, bound by a person device) never has a desktop-
/// binding that counts, and a peer without one — a Pi, a household's
/// computer — is refused. Whether the anchor then counts is the walk's
/// (vault/client.ts anchorHolds).
export function peerSessionIsDesktop(
  row: SessionRow | null,
  args: { userId: string | number; selfComputerId: string; anchor: { id: string; sign_public: string }; devices: VaultDevice[]; anchors: Anchor[] },
): boolean {
  if (!row || !isPeerSessionKind(row.kind) || !row.requesterComputerId || row.requesterComputerId === args.selfComputerId) return false;
  if (!row.approvalRule || !PEER_PIN_RULES.has(row.approvalRule)) return false;
  if (row.vaultDeviceId !== args.anchor.id) return false;
  const access = keptStatement(row);
  if (!access || access.account_computer_id !== args.selfComputerId) return false;
  const { signature, ...stated } = access;
  let signed = false;
  try {
    signed = deviceAccessV2Valid({ userId: args.userId, access: stated, signerSignPublic: fromHex(args.anchor.sign_public), signature });
  } catch {
    signed = false;
  }
  if (!signed) return false;
  const byId = new Map(args.devices.map((d) => [d.id, d]));
  const device = byId.get(args.anchor.id);
  if (!device || device.sign_public !== args.anchor.sign_public) return false;
  // Reached from the anchors already held, never on its own say.
  if (args.anchors.length === 0 || !verifiedIds(args.userId, args.devices, args.anchors).has(args.anchor.id)) return false;
  const binding = desktopBindingOf(args.userId, device, byId);
  return !!binding && binding.account_computer_id === row.requesterComputerId && binding.tunnel_public_key === access.tunnel_public_key;
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
/// computers' documents through it, read the synchronised history and the
/// memories, or write one. Null for anyone else. A person's device counts
/// only for a request that came through the tunnel from the very key its
/// session was given to (a token alone, over the network, is not that
/// device), with its device-access not expired. `roster` is only asked for
/// when the session is not the owner's.
export async function meshRequester(req: FastifyRequest, auth: { sessionId?: string | null }, roster: () => Promise<Roster | null> | Roster | null): Promise<Requester | null> {
  if (!auth.sessionId) return null;
  const row = sessionRow(auth.sessionId);
  if (isOwnerSession(auth.sessionId)) return { id: "owner", name: nameOf(row) };
  if (!row || isPeerSessionKind(row.kind) || !row.vaultDeviceId || !row.approvalRule || !PERSON_RULES.has(row.approvalRule)) return null;
  if (!sealedFromSessionKey(req, auth.sessionId)) return null;
  const device = personDeviceOf(auth.sessionId, await Promise.resolve(roster()).catch(() => null));
  return device ? { id: `person:${device}`, name: nameOf(row) } : null;
}

export async function isPersonOrOwner(req: FastifyRequest, auth: { sessionId?: string | null }, roster: () => Promise<Roster | null> | Roster | null): Promise<boolean> {
  return (await meshRequester(req, auth, roster)) !== null;
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
