import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { grantedPlace, listFolders } from "../documents/library.js";
import { foldPath, holds, spellingsOf, within as sameOrInside } from "../documents/samePath.js";
import { folderRisk } from "../documents/folderRisk.js";
import { scopedFolders } from "../documents/retrieval.js";
import { capabilityOn } from "../localCapabilities.js";
import { identityFingerprint } from "../compute/computeSeal.js";
import { createRateLimiter } from "../rateLimit.js";
import {
  accountId,
  sawGuestDevice,
  SHARE_UUID,
  shareById,
  type ShareRight,
  type ShareRow,
} from "./store.js";

// Whether a request on a share may be served, checked here, by this
// computer, every time (docs/sharing-contracts.md §3 « serve »), in this
// order — the first refusal is the answer:
//
//   1. the share exists here and is not revoked          unknown_share, revoked
//   2. not expired, by this computer's clock             expired
//   3. its folder still granted, in no isolated project,
//      let through by folderRisk                          folder_gone
//   4. Documents on                                       documents_off
//   5. a person share: the grantee the account names is
//      the share's (checked before the device is recorded,
//      so that the account cannot fill « Appareils en
//      attente » with people the owner never shared with) unknown_share
//   6. the guest's device approved by the owner for that
//      grantee — recorded « pending » the first time       device_not_approved
//   7. the operation allowed by the right held here        right
//   8. within 30 searches, 120 browses and 30 chunks of a
//      file a minute per (share, device)                  rate_limited
//
// What the account says of a share — its right, its expiry, its grantee's
// devices — counts for nothing here: it can only make the account stop
// relaying.

export type ShareError =
  | "unknown_share"
  | "revoked"
  | "expired"
  | "device_not_approved"
  | "right"
  | "folder_gone"
  | "documents_off"
  | "rate_limited"
  | "bad_request"
  | "not_found"
  | "too_large";

export type ShareOp = "folders" | "search" | "browse" | "text" | "raw";

/// What each right allows. « Poser des questions » is excerpts only;
/// « Lire les fichiers » also browses, reads the indexed text and the
/// originals (raw, lot L5).
const ALLOWED: Record<ShareRight, ReadonlySet<ShareOp>> = {
  ask: new Set(["folders", "search"]),
  read: new Set(["folders", "search", "browse", "text", "raw"]),
};

export const rightAllows = (right: ShareRight, op: ShareOp): boolean => ALLOWED[right]?.has(op) ?? false;

export const SHARE_SEARCHES_PER_MINUTE = 30;
export const SHARE_BROWSES_PER_MINUTE = 120;
/// Chunks of files (1 MiB each, shares/raw.ts): the account's own bound is
/// 30 requests a minute per share and device, of every kind.
export const SHARE_CHUNKS_PER_MINUTE = 30;
let searchLimiter = createRateLimiter({ limit: SHARE_SEARCHES_PER_MINUTE, windowMs: 60_000 });
let browseLimiter = createRateLimiter({ limit: SHARE_BROWSES_PER_MINUTE, windowMs: 60_000 });
let rawLimiter = createRateLimiter({ limit: SHARE_CHUNKS_PER_MINUTE, windowMs: 60_000 });

/// Tests: fresh budgets (with a clock of their own).
export function resetShareLimits(now?: () => number): void {
  searchLimiter = createRateLimiter({ limit: SHARE_SEARCHES_PER_MINUTE, windowMs: 60_000, now });
  browseLimiter = createRateLimiter({ limit: SHARE_BROWSES_PER_MINUTE, windowMs: 60_000, now });
  rawLimiter = createRateLimiter({ limit: SHARE_CHUNKS_PER_MINUTE, windowMs: 60_000, now });
}

/// The guest's public keys as the bridge task carries them, checked, with
/// their fingerprint.
export interface GuestKey {
  enc_public: string;
  sign_public: string;
  fingerprint: string;
}

const KEY_HEX = /^[0-9a-f]{64}$/;

export function readGuestKey(value: unknown): GuestKey | null {
  const key = value as { enc_public?: unknown; sign_public?: unknown } | null;
  if (!key || typeof key !== "object" || typeof key.enc_public !== "string" || typeof key.sign_public !== "string") return null;
  if (!KEY_HEX.test(key.enc_public) || !KEY_HEX.test(key.sign_public)) return null;
  try {
    return { enc_public: key.enc_public, sign_public: key.sign_public, fingerprint: identityFingerprint({ encPublic: key.enc_public, signPublic: key.sign_public }) };
  } catch {
    return null;
  }
}

/// Why a folder can no longer be shared from here, now: gone from Documents,
/// inside an isolated project (src/projects/isolation.ts — its own or by a
/// folder holding it), or refused by folderRisk. Null when it can be.
export function folderUnshareable(userId: string, folderId: string): "folder_gone" | "isolated" | "refused" | null {
  const folder = listFolders(userId).find((candidate) => candidate.id === folderId);
  if (!folder) return "folder_gone";
  if (folder.project_id) return "isolated";
  let home: string;
  try {
    home = realpathSync(homedir());
  } catch {
    home = homedir();
  }
  return folderRisk(folder.path, home, process.platform, folder.path === home) === null ? null : "refused";
}

/// The shared folder and every granted folder it holds that may be read
/// with it: scopedFolders' rules (no isolated project's folder, folderRisk
/// applied, Documents on), the shared folder first. Null when the shared
/// folder itself is not among them.
export function shareScope(userId: string, share: ShareRow): { root: { id: string; name: string; path: string }; folders: Array<{ id: string; name: string; path: string; documents: number; indexed: number }> } | null {
  const folders = scopedFolders(userId, { mode: "selected", folderIds: [share.folder_id] });
  const root = folders.find((folder) => folder.id === share.folder_id);
  if (!root) return null;
  // A granted folder nested in the shared one and isolated is already left
  // out by scopedFolders; a folder outside the shared one never comes in.
  return { root, folders: [root, ...folders.filter((folder) => folder.id !== root.id && within(root.path, folder.path))] };
}

/// The isolated projects' folders lying inside `rootPath`: never browsed
/// nor named through a share, though the file system holds them there —
/// each every way it may be met from the shared folder (documents/samePath.ts:
/// as granted, as the system resolves it, as written from `rootPath`).
export function isolatedInside(userId: string, rootPath: string): string[] {
  const root = grantedPlace(rootPath);
  return [
    ...new Set(
      listFolders(userId)
        .filter((folder) => folder.project_id)
        .flatMap((folder) => {
          const wall = grantedPlace(folder.path);
          return holds(root.place, wall.place, wall.ids) ? spellingsOf(wall.place, [root.place]) : [];
        }),
    ),
  ];
}

/// Whether `child` lies under `parent` (not the same folder), compared as
/// this disk does (documents/samePath.ts).
export function within(parent: string, child: string): boolean {
  return sameOrInside(parent, child) && foldPath(parent) !== foldPath(child);
}

export interface ShareRequest {
  shareUuid: string;
  granteeUserId: string;
  guest: GuestKey;
}

export type Verdict = { ok: true; share: ShareRow; scope: NonNullable<ReturnType<typeof shareScope>> } | { ok: false; error: ShareError; outcome: string };

const refuse = (error: ShareError, outcome: string = error): Verdict => ({ ok: false, error, outcome });

/// Checks 1 to 6, the same for every operation and for the check made
/// before a request is opened (`op` null), then 7 and 8 for an operation.
export function checkShareRequest(userId: string, request: ShareRequest, op: ShareOp | null, now = Date.now()): Verdict {
  if (!SHARE_UUID.test(request.shareUuid)) return refuse("unknown_share");
  const share = shareById(userId, request.shareUuid);
  if (!share) return refuse("unknown_share");
  if (share.revoked_at !== null) return refuse("revoked");
  if (share.expires_at !== null && share.expires_at <= now) return refuse("expired");
  const unshareable = folderUnshareable(userId, share.folder_id);
  if (unshareable) return refuse("folder_gone", unshareable === "folder_gone" ? "folder_gone" : `folder_${unshareable}`);
  if (!capabilityOn(userId, "documents")) return refuse("documents_off");
  const scope = shareScope(userId, share);
  if (!scope) return refuse("folder_gone", "folder_refused");
  if (share.kind === "person" && share.grantee_user_id !== request.granteeUserId) return refuse("unknown_share", "wrong_grantee");
  // An organization share is to every member the account names, each
  // through devices the owner approved for that member (until lot L8, the
  // membership itself is the account's word: the device approval is not).
  const device = sawGuestDevice(userId, request.granteeUserId, request.guest, now);
  if (device.state !== "approved") return refuse("device_not_approved", device.state === "refused" ? "device_refused" : "device_pending");
  if (op === null) return { ok: true, share, scope };
  if (!rightAllows(share.access_right, op)) return refuse("right");
  const limiter = op === "search" ? searchLimiter : op === "raw" ? rawLimiter : browseLimiter;
  if (!limiter.hit(`${share.id}:${request.guest.fingerprint}`).allowed) return refuse("rate_limited");
  return { ok: true, share, scope };
}

/// The request's who and which share, from the serve payload; null when it
/// is not one.
export function readShareRequest(payload: Record<string, unknown>): ShareRequest | null {
  const shareUuid = typeof payload.share_uuid === "string" ? payload.share_uuid : null;
  const granteeUserId = accountId(payload.grantee_user_id);
  const guest = readGuestKey(payload.guest);
  if (!shareUuid || !granteeUserId || !guest) return null;
  return { shareUuid, granteeUserId, guest };
}
