import { randomUUID } from "node:crypto";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../db.js";
import { readSecretFile, removeSecretFile, secretFileContent } from "../secretFile.js";
import { GRAPH_ORIGIN, type GraphCapability } from "../outbound.js";
import { forgetMicrosoftAccess } from "./token.js";

// The link to the person's Microsoft account, for Microsoft Graph
// (04/10/2026): the account's address, the permissions Microsoft granted,
// and the refresh token of that sign-in — the newest Microsoft gave. One
// link for every capability that reads Graph (Agenda, Contacts, and the
// mailbox of E-mails): each declares the permissions it needs
// (GRAPH_SCOPES), a sign-in asks those of the page it starts from with
// those the link holds, and the link holds their union. Kept as a mailbox's
// password is (email/credentials.ts), but apart from it: on this computer,
// in a file of its own that only this account can read (0600), apart from
// the database and the copies saved before each migration. Never sent back
// to a screen, never given to a model, never written to a log. With it, how
// each copy of Agenda and Contacts went the last time (the mailbox keeps
// its own in the database). Unlinking forgets it all.

/// What each capability that reads Graph needs of it (Graph's delegated
/// permissions, declared in Twoody's registration at Microsoft). The
/// mailbox needs Mail.ReadWrite rather than Mail.Read: Graph writes a draft
/// with it alone; Twoody never asks Mail.Send. A capability that comes to
/// read Graph adds its own here, and its paths to the door (src/outbound.ts).
export const GRAPH_SCOPES: Record<GraphCapability, readonly string[]> = {
  calendar: ["Calendars.Read"],
  contacts: ["Contacts.Read"],
  email: ["Mail.ReadWrite"],
};
export const GRAPH_CAPABILITIES = Object.keys(GRAPH_SCOPES) as GraphCapability[];
/// The capabilities whose copy the link notes the state of: Agenda's and
/// Contacts' (the mailbox keeps its own with its copy, in the database).
export type GraphCopy = Exclude<GraphCapability, "email">;
const COPIES = GRAPH_CAPABILITIES.filter((capability): capability is GraphCopy => capability !== "email");
/// Every permission a link may hold.
const PERMISSIONS = [...new Set(Object.values(GRAPH_SCOPES).flat())];
/// Graph's own name for its permissions' resource.
const GRAPH_RESOURCE = `${GRAPH_ORIGIN}/`;

export interface CopySync {
  /// The last copy kept.
  last_synced_at: number | null;
  /// The last try, kept or not.
  last_attempt_at: number | null;
  last_error: string | null;
}

export interface GraphLink {
  /// This link: a copy read with an older one is never kept.
  id: string;
  address: string;
  /// The permissions it holds, as named in GRAPH_SCOPES.
  scopes: string[];
  linked_at: number;
  sync: Record<GraphCopy, CopySync>;
}

interface Kept {
  id: string;
  address: string;
  scopes: string[];
  linked_at: number;
  refresh_token: string;
  saved_at: number;
  sync?: Partial<Record<GraphCopy, Partial<CopySync>>>;
}

/// The permissions Microsoft says it granted (the token response's
/// `scope`, words apart, or a list), as GRAPH_SCOPES names them: those a
/// capability needs, whatever their case or prefix; OpenID's and the rest
/// left out.
export function graphPermissions(value: unknown): string[] {
  const words = Array.isArray(value) ? value.filter((word): word is string => typeof word === "string") : typeof value === "string" ? value.split(/\s+/) : [];
  const names = new Set(words.map((word) => word.trim().toLowerCase().replace(GRAPH_RESOURCE, "")));
  return PERMISSIONS.filter((permission) => names.has(permission.toLowerCase()));
}

/// What a refresh asks of Microsoft: the link's permissions, and a new
/// refresh token.
export function graphScope(scopes: readonly string[]): string {
  return [...scopes.map((permission) => `${GRAPH_RESOURCE}${permission}`), "offline_access"].join(" ");
}

/// Whether the link holds every permission a capability needs.
export function linkGrants(link: Pick<GraphLink, "scopes">, capability: GraphCapability): boolean {
  return GRAPH_SCOPES[capability].every((permission) => link.scopes.includes(permission));
}

const FILE = () => join(DATA_DIR, "microsoft-graph.json");

function readAll(): Record<string, Kept> {
  try {
    const parsed = JSON.parse(readSecretFile(FILE()) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Kept>) : {};
  } catch {
    return {};
  }
}

/// Written whole, then put in place: a crash never leaves half a file, and
/// the mode is the new file's own (a mode given to writeFileSync only
/// applies when it creates the file).
function writeAll(all: Record<string, Kept>) {
  const path = FILE();
  if (Object.keys(all).length === 0) {
    removeSecretFile(path);
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  // Sealed inside Twoody Desktop (secretFile.ts).
  writeFileSync(temporary, secretFileContent(path, JSON.stringify(all, null, 2)), { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Filesystems without POSIX modes.
  }
  renameSync(temporary, path);
}

const never = (): CopySync => ({ last_synced_at: null, last_attempt_at: null, last_error: null });

function linkOf(kept: Kept): GraphLink {
  const sync = Object.fromEntries(COPIES.map((capability) => [capability, { ...never(), ...(kept.sync?.[capability] ?? {}) }])) as Record<GraphCopy, CopySync>;
  return { id: kept.id, address: kept.address, scopes: graphPermissions(kept.scopes), linked_at: kept.linked_at, sync };
}

function keptFor(userId: string): Kept | null {
  const kept = readAll()[userId];
  return kept && typeof kept.id === "string" && typeof kept.refresh_token === "string" && kept.refresh_token ? kept : null;
}

/// The person's link, never its token.
export function graphLink(userId: string): GraphLink | null {
  const kept = keptFor(userId);
  return kept ? linkOf(kept) : null;
}

/// The refresh token of this link — if it is still the one kept.
export function graphRefreshToken(userId: string, linkId: string): string | null {
  const kept = keptFor(userId);
  return kept && kept.id === linkId ? kept.refresh_token : null;
}

/// A new link, in place of the one before (whose sign-in is forgotten).
export function keepGraphLink(userId: string, given: { address: string; scopes: readonly string[]; refreshToken: string }, now = Date.now()): GraphLink {
  const all = readAll();
  const before = all[userId];
  if (before?.refresh_token && before.refresh_token !== given.refreshToken) forgetMicrosoftAccess(before.refresh_token);
  const kept: Kept = { id: randomUUID(), address: given.address, scopes: [...given.scopes], linked_at: now, refresh_token: given.refreshToken, saved_at: now };
  all[userId] = kept;
  writeAll(all);
  return linkOf(kept);
}

/// The refresh token Microsoft gave back in place of `used`, kept — if
/// `used` is still the one kept for this link: never after it was removed,
/// nor over a sign-in done again meanwhile.
export function renewGraphRefreshToken(userId: string, linkId: string, used: string, newest: string): void {
  if (used === newest) return;
  const all = readAll();
  const kept = all[userId];
  if (!kept || kept.id !== linkId || kept.refresh_token !== used) return;
  all[userId] = { ...kept, refresh_token: newest, saved_at: Date.now() };
  writeAll(all);
}

/// How a capability's copy went, noted on this link — if it is still the
/// one kept.
export function noteGraphSync(userId: string, linkId: string, capability: GraphCopy, patch: Partial<CopySync>): void {
  const all = readAll();
  const kept = all[userId];
  if (!kept || kept.id !== linkId) return;
  all[userId] = { ...kept, sync: { ...kept.sync, [capability]: { ...never(), ...(kept.sync?.[capability] ?? {}), ...patch } } };
  writeAll(all);
}

/// A copy removed (its capability turned off): nothing noted any more, so
/// that it is read again as soon as it is back on.
export function resetGraphSync(userId: string, capability: GraphCopy): void {
  const all = readAll();
  const kept = all[userId];
  if (!kept?.sync?.[capability]) return;
  const sync = { ...kept.sync };
  delete sync[capability];
  all[userId] = { ...kept, sync };
  writeAll(all);
}

/// A capability that no longer uses the link (the mailbox removed while
/// Agenda or Contacts keep it): its permissions are no longer asked when the
/// link is renewed, nor held by it — a new sign-in from its page asks them
/// again. What memory holds for this sign-in goes, so that no access token
/// got with them is used. The consent given at Microsoft stays until the
/// person withdraws it there.
export function releaseGraphPermissions(userId: string, capability: GraphCapability): GraphLink | null {
  const all = readAll();
  const kept = all[userId];
  if (!kept?.refresh_token) return null;
  const still = new Set(GRAPH_CAPABILITIES.filter((other) => other !== capability).flatMap((other) => GRAPH_SCOPES[other]));
  const scopes = graphPermissions(kept.scopes).filter((permission) => still.has(permission) || !GRAPH_SCOPES[capability].includes(permission));
  forgetMicrosoftAccess(kept.refresh_token);
  all[userId] = { ...kept, scopes, saved_at: Date.now() };
  writeAll(all);
  return linkOf(all[userId]!);
}

/// The link forgotten: its sign-in, in the file and in memory.
export function forgetGraphLink(userId: string): boolean {
  const all = readAll();
  const kept = all[userId];
  if (!kept) return false;
  if (kept.refresh_token) forgetMicrosoftAccess(kept.refresh_token);
  delete all[userId];
  writeAll(all);
  return true;
}

/// The people who linked an account.
export function usersWithGraphLinks(): string[] {
  return Object.entries(readAll()).filter(([, kept]) => kept && typeof kept.refresh_token === "string" && kept.refresh_token).map(([userId]) => userId);
}
