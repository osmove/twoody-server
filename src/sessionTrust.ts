import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { forwardedByProxy, isLoopbackAddress, viaTunnel } from "./adminAccess.js";
import { isOwnerSession, isPeerSessionKind } from "./auth.js";
import { authSessions, db, tunnelPeers } from "./db.js";
import { TUNNEL_PEER_HEADER } from "./tunnel/host.js";
import { desktopBindingOf, verifiedIds, type Anchor, type VaultDevice } from "./vault/client.js";
import { deviceAccessUsable, deviceAccessV2Valid, type DeviceAccessV2 } from "./vault/contracts.js";
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
//   person   a device's session (never a `peer:` one) holding a
//            device-access/v2 that a person device of the verified roster
//            signed for this session's own tunnel key and this computer:
//            the one it came with (rule 1, the device that added this
//            computer, or rule 5, vouched for by the vault, of
//            account/approvals.ts), or a fresh one it sent since over the
//            tunnel (renewDeviceAccess below) — which is how a phone
//            paired by code or QR code (Jimmy's iPhone with his Mac) that
//            is a member of the history counts too. The signature is
//            checked, each time it counts, against that device's key in
//            the verified roster, and its expiry too: a statement past its
//            `exp` no longer says who the session is (the app signs a new
//            one before, POST /session/device-access). It counts only for
//            a request that came through the tunnel from the session's
//            own key.
//
// Anyone else — a device paired by code that is no member of the history,
// a household member's phone endorsed by a pinned approver (rule 2), one
// the console approved, a firmware device's token, another computer's
// `peer:` session — is none of these.
//
// Naming this computer's vault anchor (routes/peerVault.ts) stays with
// rules 1 and 5: a statement sent later never pins, but for a rule 1
// session's, which founds the first anchor (firstAnchorStatement below).
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

/// The device-access a session kept, for its own vault device and tunnel
/// key: whatever let a device's session in once it sent one
/// (`anyRule`, who the session is), or rules 1 and 5 only (who may pin).
function keptAccess(row: SessionRow, anyRule = false): (DeviceAccessV2 & { signature: string }) | null {
  if (!anyRule && (!row.approvalRule || !PERSON_RULES.has(row.approvalRule))) return null;
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
/// device-access it holds, not yet expired: the session is that device.
/// By default only one it came with (rule 1 or 5), as pinning an anchor
/// asks; `anyRule`: also one it sent since (renewDeviceAccess), as being
/// the person asks.
export function sessionIsVaultDevice(row: SessionRow | null, userId: string | number, vaultDeviceId: string, signPublic: string, options: { anyRule?: boolean } = {}): boolean {
  if (!row || isPeerSessionKind(row.kind) || row.requesterComputerId || row.vaultDeviceId !== vaultDeviceId) return false;
  const access = keptAccess(row, options.anyRule === true);
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
/// whose device is a person-device of the verified roster that signed the
/// device-access the session holds (the one it came with, or a renewed
/// one), not expired. Null otherwise.
export function personDeviceOf(sessionId: string | null | undefined, roster: Roster | null): string | null {
  const row = sessionRow(sessionId);
  if (!row || !roster || isPeerSessionKind(row.kind) || row.requesterComputerId || !row.vaultDeviceId) return null;
  const person = roster.persons.get(row.vaultDeviceId);
  if (!person) return null;
  return sessionIsVaultDevice(row, roster.userId, person.vaultDeviceId, person.signPublic, { anyRule: true }) ? person.vaultDeviceId : null;
}

// ── the first anchor ─────────────────────────────────────────────────────
// A computer linked with the one-time secret pinned the key of the device
// that approved its login (account.json `approvers`, rule 1): that device
// is the person's. But until a first anchor exists the verified roster is
// empty, so no device-access can be checked against it, and without one
// the anchor route refuses the device: neither could come first. So, and
// only while this computer holds NO anchor, a session let in by rule 1
// (`approver`, never the console's, never a `peer:` one, never the owner's)
// asking through the tunnel from its own key — a key still pinned as an
// approver — may bring a device-access/v2 for that very key and this
// computer, at most a day ahead, signed by the vault key it names: the
// session is that vault device, and that device may become the first
// anchor (routes/peerVault.ts). Once any anchor exists, everything is
// checked against the roster again.

export type FirstAnchorArgs = {
  userId: string | number;
  selfComputerId: string;
  /// account.json's pinned approver keys (lowercase hex).
  approvers: string[];
  /// The anchors this computer holds now; null without a headless vault.
  anchorsHeld: Anchor[] | null;
  access: DeviceAccessV2 & { signature: string };
  /// The key the statement must be signed by.
  signPublic: string;
  now?: number;
};

export function firstAnchorStatement(req: FastifyRequest, row: SessionRow | null, args: FirstAnchorArgs): boolean {
  if (!row || isPeerSessionKind(row.kind) || row.requesterComputerId || isOwnerSession(row.id)) return false;
  if (row.approvalRule !== "approver") return false;
  if (!args.anchorsHeld || args.anchorsHeld.length > 0) return false;
  const key = tunnelPeerKey(req);
  if (!key || !sessionTunnelKeys(row.id).includes(key)) return false;
  if (!args.approvers.map((k) => k.toLowerCase()).includes(key)) return false;
  const { signature, ...stated } = args.access;
  if (stated.tunnel_public_key !== key) return false;
  if (!deviceAccessUsable(stated, { accountComputerId: args.selfComputerId, nowMs: args.now ?? Date.now() })) return false;
  if (row.vaultDeviceId && row.vaultDeviceId !== stated.vault_device_id) return false;
  try {
    return deviceAccessV2Valid({ userId: args.userId, access: stated, signerSignPublic: fromHex(args.signPublic), signature });
  } catch {
    return false;
  }
}

/// The session is `access`'s vault device from now on, holding that statement.
export function keepDeviceAccess(sessionId: string, access: DeviceAccessV2 & { signature: string }): void {
  db.update(authSessions)
    .set({ vaultDeviceId: access.vault_device_id, deviceAccessJson: JSON.stringify(access) })
    .where(eq(authSessions.id, sessionId))
    .run();
}

// ── renewing a session's device-access ───────────────────────────────────
// A device-access/v2 is good for a day at most (vault/contracts.ts
// DEVICE_ACCESS_MAX_TTL_S): a phone would stop being the person a day
// after it signed one. It signs a fresh one for each computer it uses
// before then and sends it here, over the sealed tunnel — no account in
// between (POST /session/device-access, routes/session.ts). Taken only
// when, like rule 5:
//   - the request came through the tunnel from a key the session holds,
//     and the statement is for that very key;
//   - it is for this computer (`account_computer_id`), not expired, and
//     expires within a day;
//   - it is signed by a person device of the verified roster;
//   - the session names no other vault device already (a session is one
//     device, whatever it sends later).
// A `peer:` session never becomes a person. A Twoody Desktop's embedded
// server renews the statement its peer session holds the same way
// (POST /peer/session/device-access, routes/peerVault.ts): only for the
// vault device the session already names, let in by rule 1 or 2 as its
// computer, signed by that device's key as the vault lists it — what
// peerSessionIsDesktop checks in full whenever it counts.

export type DeviceAccessRenewal = { ok: true; vault_device_id: string; exp: number } | { ok: false; status: number; error: string };

const refused = (status: number, error: string): DeviceAccessRenewal => ({ ok: false, status, error });

export async function renewDeviceAccess(
  req: FastifyRequest,
  sessionId: string | null | undefined,
  access: (DeviceAccessV2 & { signature: string }) | null,
  deps: {
    selfComputerId: string | null | undefined;
    /// A device's session: the verified roster whose persons may sign.
    roster: () => Promise<Roster | null> | Roster | null;
    /// A peer session: the key the vault lists for a device id, and the user.
    listedSignKey?: (vaultDeviceId: string) => Promise<{ userId: string | number; signPublic: string } | null>;
    /// A device's session, while this computer holds no anchor: whether
    /// the statement founds its first one (firstAnchorStatement).
    firstAnchor?: (row: SessionRow, access: DeviceAccessV2 & { signature: string }) => Promise<boolean>;
    peer?: boolean;
    now?: number;
  },
): Promise<DeviceAccessRenewal> {
  if (!sessionId) return refused(401, "unauthorized");
  const row = sessionRow(sessionId);
  if (!row) return refused(401, "unauthorized");
  const peer = isPeerSessionKind(row.kind) || !!row.requesterComputerId;
  if (!deps.peer && isOwnerSession(sessionId)) return refused(409, "owner_session");
  if (peer !== (deps.peer === true)) return refused(403, peer ? "peer_session_forbidden" : "not_a_peer_session");
  const key = tunnelPeerKey(req);
  if (!key || !sessionTunnelKeys(row.id).includes(key)) return refused(403, "pinned_channel_required");
  if (!access) return refused(422, "invalid_device_access");
  if (access.tunnel_public_key !== key) return refused(403, "wrong_tunnel_key");
  const now = deps.now ?? Date.now();
  if (!deps.selfComputerId || !deviceAccessUsable(access, { accountComputerId: deps.selfComputerId, nowMs: now })) return refused(422, "device_access_not_usable");
  if (row.vaultDeviceId && row.vaultDeviceId !== access.vault_device_id) return refused(409, "other_vault_device");
  const { signature, ...stated } = access;
  let signer: { userId: string | number; signPublic: string } | null = null;
  if (peer) {
    // Only the Desktop's peer session, for the device it already names.
    if (!row.approvalRule || !PEER_PIN_RULES.has(row.approvalRule) || !row.vaultDeviceId) return refused(403, "not_a_desktop_session");
    signer = (await deps.listedSignKey?.(access.vault_device_id).catch(() => null)) ?? null;
  } else {
    const roster = await Promise.resolve(deps.roster()).catch(() => null);
    const person = roster?.persons.get(access.vault_device_id);
    signer = roster && person ? { userId: roster.userId, signPublic: person.signPublic } : null;
  }
  let valid = false;
  try {
    valid = !!signer && deviceAccessV2Valid({ userId: signer.userId, access: stated, signerSignPublic: fromHex(signer.signPublic), signature });
  } catch {
    valid = false;
  }
  if (!valid && !peer && deps.firstAnchor) valid = await deps.firstAnchor(row, access).catch(() => false);
  if (!valid) return refused(403, "not_a_person_device");
  // Never shortened by an older statement sent again.
  const kept = keptStatement(row, now);
  if (kept && kept.vault_device_id === access.vault_device_id && kept.exp > access.exp) return { ok: true, vault_device_id: kept.vault_device_id, exp: kept.exp };
  keepDeviceAccess(row.id, access);
  return { ok: true, vault_device_id: access.vault_device_id, exp: access.exp };
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
  if (!row || isPeerSessionKind(row.kind) || !row.vaultDeviceId) return null;
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
