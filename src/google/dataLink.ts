import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../db.js";
import type { GoogleDataFamily } from "../outbound.js";
import { forgetGoogleAccess } from "./token.js";

// The link to the person's Google account for Google Analytics and Search
// Console (Connecteurs › Google, 08/10/2026: « Google Analytics et Search
// Console comme connecteurs, ajoutés en un clic avec Se connecter avec
// Google »): the account's address, the permissions Google granted, and the
// refresh token of that sign-in — done by the Desktop's main process
// (twoody-desktop src/main/googleSignIn.ts, purpose « google_data ») and
// handed over, apart from the Gmail mailbox's own sign-in. Read only:
// analytics.readonly and webmasters.readonly, nothing else. Kept as
// microsoft/link.ts keeps its own: on this computer, in a file of its own
// that only this account can read (0600), apart from the database and the
// copies saved before each migration. Never sent back to a screen, never
// given to a model, never written to a log. Switched off, it is kept but
// nothing is asked of Google (the door of src/outbound.ts stays shut);
// removed, it is forgotten, in the file and in memory. The consent given
// at Google stays until the person withdraws it there.

/// The permission each family of tools needs (Google's scopes).
export const GOOGLE_DATA_SCOPES: Record<GoogleDataFamily, string> = {
  analytics: "https://www.googleapis.com/auth/analytics.readonly",
  search_console: "https://www.googleapis.com/auth/webmasters.readonly",
};
export const GOOGLE_DATA_FAMILIES = Object.keys(GOOGLE_DATA_SCOPES) as GoogleDataFamily[];

export interface GoogleDataLink {
  /// This link: a token renewed for an older one is never used.
  id: string;
  address: string;
  /// The permissions it holds, among GOOGLE_DATA_SCOPES.
  scopes: string[];
  /// What they open.
  granted: GoogleDataFamily[];
  linked_at: number;
  enabled: boolean;
}

interface Kept {
  id: string;
  address: string;
  scopes: string[];
  linked_at: number;
  refresh_token: string;
  enabled?: boolean;
  saved_at: number;
}

/// The permissions Google says it granted (the token response's `scope`,
/// words apart, or a list), among those the link may hold; OpenID's and
/// the rest left out.
export function googleDataScopes(value: unknown): string[] {
  const words = Array.isArray(value) ? value.filter((word): word is string => typeof word === "string") : typeof value === "string" ? value.split(/\s+/) : [];
  const given = new Set(words.map((word) => word.trim()));
  return Object.values(GOOGLE_DATA_SCOPES).filter((scope) => given.has(scope));
}

/// The families of tools these permissions open.
export function grantedFamilies(scopes: readonly string[]): GoogleDataFamily[] {
  return GOOGLE_DATA_FAMILIES.filter((family) => scopes.includes(GOOGLE_DATA_SCOPES[family]));
}

const FILE = () => join(DATA_DIR, "google-data.json");

function readAll(): Record<string, Kept> {
  try {
    const parsed = JSON.parse(readFileSync(FILE(), "utf8")) as unknown;
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
    rmSync(path, { force: true });
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Filesystems without POSIX modes.
  }
  renameSync(temporary, path);
}

function linkOf(kept: Kept): GoogleDataLink {
  const scopes = googleDataScopes(kept.scopes);
  return { id: kept.id, address: kept.address, scopes, granted: grantedFamilies(scopes), linked_at: kept.linked_at, enabled: kept.enabled !== false };
}

function keptFor(userId: string): Kept | null {
  const kept = readAll()[userId];
  return kept && typeof kept.id === "string" && typeof kept.refresh_token === "string" && kept.refresh_token ? kept : null;
}

/// The person's link, never its token.
export function googleDataLink(userId: string): GoogleDataLink | null {
  const kept = keptFor(userId);
  return kept ? linkOf(kept) : null;
}

/// The refresh token of this link — if it is still the one kept.
export function googleDataRefreshToken(userId: string, linkId: string): string | null {
  const kept = keptFor(userId);
  return kept && kept.id === linkId ? kept.refresh_token : null;
}

/// A new link, in place of the one before (whose sign-in is forgotten),
/// switched on.
export function keepGoogleDataLink(userId: string, given: { address: string; scopes: readonly string[]; refreshToken: string }, now = Date.now()): GoogleDataLink {
  const all = readAll();
  const before = all[userId];
  if (before?.refresh_token && before.refresh_token !== given.refreshToken) forgetGoogleAccess(before.refresh_token);
  const kept: Kept = { id: randomUUID(), address: given.address, scopes: googleDataScopes([...given.scopes]), linked_at: now, refresh_token: given.refreshToken, enabled: true, saved_at: now };
  all[userId] = kept;
  writeAll(all);
  return linkOf(kept);
}

/// Switched on or off; null when there is no link.
export function setGoogleDataEnabled(userId: string, enabled: boolean): GoogleDataLink | null {
  const all = readAll();
  const kept = all[userId];
  if (!kept?.refresh_token) return null;
  all[userId] = { ...kept, enabled, saved_at: Date.now() };
  writeAll(all);
  // Off: no access token got with it is used any more.
  if (!enabled) forgetGoogleAccess(kept.refresh_token);
  return linkOf(all[userId]!);
}

/// The link forgotten: its sign-in, in the file and in memory.
export function forgetGoogleDataLink(userId: string): boolean {
  const all = readAll();
  const kept = all[userId];
  if (!kept) return false;
  if (kept.refresh_token) forgetGoogleAccess(kept.refresh_token);
  delete all[userId];
  writeAll(all);
  return true;
}
