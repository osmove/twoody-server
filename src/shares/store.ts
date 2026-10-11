import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";

// The folder shares this computer holds (migration 8, docs/sharing-design.md
// §2, docs/sharing-contracts.md §3): the shares themselves, the grantees'
// devices the owner approved or not, and what each request did. This
// computer is their authority. The account lists the shares and relays the
// requests, and what it says can only restrict them (`syncShares`): it never
// creates, extends or retargets one, and never approves a device.

export type ShareKind = "person" | "organization";
export type ShareRight = "ask" | "read";
export type RevokedBy = "owner" | "grantee" | "organization" | "eligibility";
export type DeviceState = "pending" | "approved" | "refused";

export const SHARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/// The account's ids (users, organizations), as text whatever their type there.
export const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/// computeSeal's fingerprint of a pair of public keys: five groups of four hex digits.
export const FINGERPRINT = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){4}$/;
export const LABEL_MAX = 120;
const NAME_MAX = 120;

export interface ShareRow {
  id: string;
  user_id: string;
  folder_id: string;
  kind: ShareKind;
  grantee_user_id: string | null;
  grantee_name: string | null;
  organization_id: string | null;
  organization_name: string | null;
  label: string;
  right: ShareRight;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  revision: number;
  revoked_at: number | null;
  revoked_by: RevokedBy | null;
  published_at: number | null;
}

export interface GuestDeviceRow {
  id: number;
  user_id: string;
  grantee_user_id: string;
  fingerprint: string;
  enc_public: string;
  sign_public: string;
  state: DeviceState;
  first_seen_at: number;
  last_seen_at: number;
  approved_at: number | null;
  verified_at: number | null;
}

/// An account id as text, or null when it is not one.
export function accountId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && ACCOUNT_ID.test(value) ? value : null;
}

/// A name shown to the owner (a grantee's, an organization's, a label):
/// one line, bounded; null when nothing is left.
export function cleanText(value: unknown, max = NAME_MAX): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return text || null;
}

const SELECT = `SELECT id, user_id, folder_id, kind, grantee_user_id, grantee_name, organization_id, organization_name, label, "right" AS right,
  expires_at, created_at, updated_at, revision, revoked_at, revoked_by, published_at FROM folder_shares`;

export function shareById(userId: string, id: string): ShareRow | null {
  return (sqlite.prepare(`${SELECT} WHERE user_id = ? AND id = ?`).get(userId, id) as ShareRow | undefined) ?? null;
}

export function sharesOf(userId: string): ShareRow[] {
  return sqlite.prepare(`${SELECT} WHERE user_id = ? ORDER BY created_at, id`).all(userId) as ShareRow[];
}

export interface NewShare {
  folderId: string;
  kind: ShareKind;
  granteeUserId: string | null;
  granteeName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  label: string;
  right: ShareRight;
  expiresAt: number | null;
}

/// A new share, its uuid made here: the account only learns it when the
/// owner's app publishes it.
export function insertShare(userId: string, share: NewShare, now = Date.now()): ShareRow {
  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO folder_shares (id, user_id, folder_id, kind, grantee_user_id, grantee_name, organization_id, organization_name, label, "right",
         expires_at, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(id, userId, share.folderId, share.kind, share.granteeUserId, share.granteeName, share.organizationId, share.organizationName, share.label, share.right, share.expiresAt, now, now);
  return shareById(userId, id)!;
}

/// The owner's change: a new revision whenever what the share allows or
/// shows changes; `published` only marks that the account was told.
export function updateShare(
  userId: string,
  id: string,
  patch: { right?: ShareRight; expiresAt?: number | null; label?: string; published?: boolean },
  now = Date.now(),
): ShareRow | null {
  const share = shareById(userId, id);
  if (!share) return null;
  const right = patch.right ?? share.right;
  const expiresAt = patch.expiresAt !== undefined ? patch.expiresAt : share.expires_at;
  const label = patch.label ?? share.label;
  const changed = right !== share.right || expiresAt !== share.expires_at || label !== share.label;
  sqlite
    .prepare(`UPDATE folder_shares SET "right" = ?, expires_at = ?, label = ?, revision = revision + ?, updated_at = ?, published_at = ? WHERE user_id = ? AND id = ?`)
    .run(right, expiresAt, label, changed ? 1 : 0, changed || patch.published ? now : share.updated_at, patch.published ? now : share.published_at, userId, id);
  return shareById(userId, id);
}

/// Revoked, never deleted: the row says who stopped it and when. A share
/// already revoked keeps its first revocation.
export function revokeShare(userId: string, id: string, by: RevokedBy, now = Date.now()): ShareRow | null {
  sqlite
    .prepare("UPDATE folder_shares SET revoked_at = ?, revoked_by = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND id = ? AND revoked_at IS NULL")
    .run(now, by, now, userId, id);
  return shareById(userId, id);
}

// ── sync with the account ───────────────────────────────────────────────────

/// How the account says a share was revoked, as this computer records it.
/// « host » is this computer's own doing; anything unknown is taken as a loss
/// of eligibility — still a revocation, which is all the account may cause.
const REVOKED_BY: Record<string, RevokedBy> = { owner: "owner", host: "owner", grantee: "grantee", organization: "organization", eligibility: "eligibility" };

export interface AccountShare {
  uuid: string;
  status: "active" | "revoked";
  revoked_reason: string | null;
}

/// The account's `given` list, checked: each entry a uuid and a status.
/// Anything else in it is ignored — notably a right, an expiry, a grantee or
/// a device, which the account never decides.
export function readAccountShares(value: unknown): AccountShare[] | null {
  if (!Array.isArray(value) || value.length > 5_000) return null;
  const out: AccountShare[] = [];
  for (const raw of value) {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object" || typeof entry.uuid !== "string" || !SHARE_UUID.test(entry.uuid)) return null;
    out.push({
      uuid: entry.uuid,
      status: entry.status === "revoked" ? "revoked" : "active",
      revoked_reason: typeof entry.revoked_reason === "string" ? entry.revoked_reason : null,
    });
  }
  return out;
}

/// Reconciles this computer's shares with what the account lists
/// (docs/sharing-contracts.md §3 « Sync »):
///   - revoked there → revoked here, by the reason the account gives;
///   - active here, unexpired, and absent there → to publish again
///     (published once or never: the account must list it to relay it);
///   - there and unknown here → ignored.
/// Nothing the account says extends, widens or brings back a share.
export function syncShares(userId: string, account: AccountShare[], now = Date.now()): { republish: ShareRow[]; revoked: string[] } {
  const there = new Map(account.map((entry) => [entry.uuid, entry]));
  const republish: ShareRow[] = [];
  const revoked: string[] = [];
  for (const share of sharesOf(userId)) {
    if (share.revoked_at !== null) continue;
    const listed = there.get(share.id);
    if (listed?.status === "revoked") {
      revokeShare(userId, share.id, REVOKED_BY[listed.revoked_reason ?? ""] ?? "eligibility", now);
      revoked.push(share.id);
    } else if (!listed && (share.expires_at === null || share.expires_at > now)) {
      republish.push(share);
    }
  }
  return { republish, revoked };
}

// ── the grantees' devices ───────────────────────────────────────────────────

export function guestDevice(userId: string, granteeUserId: string, fingerprint: string): GuestDeviceRow | null {
  return (sqlite.prepare("SELECT * FROM share_guest_devices WHERE user_id = ? AND grantee_user_id = ? AND fingerprint = ?").get(userId, granteeUserId, fingerprint) as GuestDeviceRow | undefined) ?? null;
}

export function guestDevices(userId: string): GuestDeviceRow[] {
  return sqlite.prepare("SELECT * FROM share_guest_devices WHERE user_id = ? ORDER BY first_seen_at, id").all(userId) as GuestDeviceRow[];
}

/// A grantee's device that reached this computer: recorded « pending » the
/// first time (the owner approves it or not), seen again otherwise. Its keys
/// never change under a fingerprint, which is their hash.
export function sawGuestDevice(userId: string, granteeUserId: string, guest: { fingerprint: string; enc_public: string; sign_public: string }, now = Date.now()): GuestDeviceRow {
  sqlite
    .prepare(
      `INSERT INTO share_guest_devices (user_id, grantee_user_id, fingerprint, enc_public, sign_public, state, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT (user_id, grantee_user_id, fingerprint) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    )
    .run(userId, granteeUserId, guest.fingerprint, guest.enc_public, guest.sign_public, now, now);
  return guestDevice(userId, granteeUserId, guest.fingerprint)!;
}

/// The owner's decision on a device: approve, refuse, or say the safety
/// numbers were compared (which approves it too).
export function decideGuestDevice(userId: string, granteeUserId: string, fingerprint: string, decision: "approve" | "refuse" | "verify", now = Date.now()): GuestDeviceRow | null {
  const device = guestDevice(userId, granteeUserId, fingerprint);
  if (!device) return null;
  if (decision === "refuse") {
    sqlite.prepare("UPDATE share_guest_devices SET state = 'refused', approved_at = NULL, verified_at = NULL WHERE id = ?").run(device.id);
  } else {
    sqlite
      .prepare("UPDATE share_guest_devices SET state = 'approved', approved_at = COALESCE(approved_at, ?), verified_at = ? WHERE id = ?")
      .run(now, decision === "verify" ? now : device.verified_at, device.id);
  }
  return guestDevice(userId, granteeUserId, fingerprint);
}

// ── what was asked ──────────────────────────────────────────────────────────

export interface ShareAuditEntry {
  shareId: string | null;
  guestUserId: string | null;
  guestFingerprint: string | null;
  /// The operation asked (folders, search, browse, text), or « request » for
  /// one refused before it was opened.
  op: string;
  /// « ok » or the refusal (unknown_share, revoked, device_not_approved…).
  outcome: string;
  at?: number;
  /// A document read (text, raw): its id in the index (null when it has
  /// none), its name, the bytes sent.
  document?: { document_id: string | null; name: string | null; bytes: number | null };
}

/// One row per request, whatever became of it. In the same table as the
/// computers' reads (peerDocuments/audit.ts), under a computer id of its own
/// that no computer has; never a question, never a path. A document read
/// whole (text) or in part (raw, lot L5) is named, as a computer's read is:
/// « Consultations » says who opened what.
export function recordShareAccess(userId: string, entry: ShareAuditEntry): void {
  sqlite
    .prepare(
      `INSERT INTO peer_document_audit (user_id, computer_id, session_id, action, at, share_id, guest_user_id, guest_fingerprint, outcome, document_id, name, bytes)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      `share:${entry.shareId ?? "unknown"}`,
      entry.op,
      entry.at ?? Date.now(),
      entry.shareId,
      entry.guestUserId,
      entry.guestFingerprint,
      entry.outcome,
      entry.document?.document_id ?? null,
      entry.document?.name ?? null,
      entry.document?.bytes ?? null,
    );
}

export interface ShareAuditRow {
  id: number;
  at: string;
  share_id: string | null;
  guest_user_id: string | null;
  guest_fingerprint: string | null;
  op: string;
  outcome: string;
  /// The document read (text, raw): null for every other request.
  document_id: string | null;
  name: string | null;
  bytes: number | null;
}

/// Newest first; `before` is the last id of the page before.
export function shareAudit(userId: string, options: { shareId?: string; before?: number; limit?: number } = {}): ShareAuditRow[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const where = ["user_id = ?", "share_id IS NOT NULL OR computer_id = 'share:unknown'"];
  const args: unknown[] = [userId];
  if (options.shareId) {
    where.push("share_id = ?");
    args.push(options.shareId);
  }
  if (options.before) {
    where.push("id < ?");
    args.push(options.before);
  }
  const rows = sqlite
    .prepare(`SELECT id, at, share_id, guest_user_id, guest_fingerprint, action AS op, outcome, document_id, name, bytes FROM peer_document_audit WHERE ${where.map((w) => `(${w})`).join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit) as Array<Omit<ShareAuditRow, "at"> & { at: number }>;
  return rows.map((row) => ({ ...row, at: new Date(row.at).toISOString() }));
}
