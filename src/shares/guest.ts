import type { DocumentAccess } from "../documents/access.js";

// The grantee's side of folder sharing on this computer (docs/sharing-
// contracts.md §3 « Grantee side », lot L4): folders someone else shares
// with the person, searched for a turn when the turn's document access
// names them — "share:<uuid>" among `folderIds`, never part of « all ».
//
// This server holds no key of the person's account: the Desktop's main
// process seals each request with the person's device keys, sends it
// through the account and opens the answer (twoody-desktop
// computeGuest.prepareShare). Here only the call is made, by message on
// the Desktop's port (account/desktopRelay.ts):
//
//   {type: "share-call", id, share_uuid, op}
//     → {type: "share-call-result", id, result}       the answer of §2, plus
//                                                       share: {label, owner_name}
//     → {type: "share-call-result", id, error: {code}, share?: {label, owner_name}}
//
// Run without the Desktop (a Pi), no share is reachable. Only the search
// query leaves this computer, never the conversation.

export const SHARE_PREFIX = "share:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/// Shared folders one turn asks, at most.
export const MAX_SHARES_PER_TURN = 8;
/// How long a shared folder is waited for (its owner's computer, through
/// the account, sealed both ways).
export const SHARE_DEADLINE_MS = 4_000;
let deadline = SHARE_DEADLINE_MS;

export function shareDeadlineMs(): number {
  return deadline;
}

/// Tests: a shorter wait; null puts the 4 s back.
export function setShareDeadline(ms: number | null): void {
  deadline = ms ?? SHARE_DEADLINE_MS;
}

export interface ShareLabel {
  label: string;
  owner_name: string;
}

export type ShareCallOutcome = { ok: true; result: unknown; share: ShareLabel | null } | { ok: false; code: string; share: ShareLabel | null };

/// One call through the Desktop; resolves within `timeoutMs` or rejects.
export type ShareCaller = (shareUuid: string, op: Record<string, unknown>, timeoutMs: number) => Promise<ShareCallOutcome>;

let caller: ShareCaller | null = null;

/// Installed by the Desktop's port (account/desktopRelay.ts), or a test's
/// stand-in; null: no shared folder can be reached.
export function setShareCaller(next: ShareCaller | null): void {
  caller = next;
}

export function shareCaller(): ShareCaller | null {
  return caller;
}

/// The shared folders a turn's access names: only when folders are chosen
/// one by one (selected, or « only »), never with « all » or « off ».
export function sharedFolderUuids(access: DocumentAccess): string[] {
  if ((access.mode !== "selected" && access.mode !== "only") || !access.folderIds) return [];
  const uuids = access.folderIds
    .filter((id) => id.startsWith(SHARE_PREFIX))
    .map((id) => id.slice(SHARE_PREFIX.length))
    .filter((uuid) => UUID.test(uuid));
  return [...new Set(uuids)].slice(0, MAX_SHARES_PER_TURN);
}

/// The link a citation of a shared document opens (with `read` only).
export function shareCitationLink(shareUuid: string, documentId: string): string {
  return `twoody://share/${encodeURIComponent(shareUuid)}/${encodeURIComponent(documentId)}`;
}

const DISPLAY = /^[^\u0000-\u001f]{1,120}$/;

/// The label and owner the Desktop adds from the account's list; null when
/// it is not one.
export function readShareLabel(value: unknown): ShareLabel | null {
  const share = value as { label?: unknown; owner_name?: unknown } | null;
  if (!share || typeof share !== "object") return null;
  const label = typeof share.label === "string" ? share.label.trim().slice(0, 120) : "";
  const owner = typeof share.owner_name === "string" ? share.owner_name.trim().slice(0, 120) : "";
  return DISPLAY.test(label) && DISPLAY.test(owner) ? { label, owner_name: owner } : null;
}

/// « Contrats · de Jimmy »: how a shared folder's passages are named.
export function shareDisplayName(share: ShareLabel | null): string {
  return share ? `${share.label} · de ${share.owner_name}` : "Dossier partagé";
}

/// The sentence the model is given when a shared folder could not be
/// searched, as the person would say it.
export function shareMissingSentence(share: ShareLabel | null, status: "late" | "unreachable" | "refused" | "pending"): string {
  const folder = share ? `Le dossier « ${share.label} » de ${share.owner_name}` : "Un dossier partagé";
  switch (status) {
    case "pending":
      return `${folder} n'est pas encore accessible depuis cet ordinateur : ${share ? share.owner_name : "son propriétaire"} doit d'abord l'autoriser.`;
    case "refused":
      return `${folder} n'est plus accessible.`;
    default:
      return `${folder} n'est pas joignable : son ordinateur est éteint ou hors ligne.`;
  }
}
