import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../db.js";
import type { MailServer } from "../outbound.js";
import { MailError, openMailSession, type MailSession } from "./imap.js";
import { forgetGoogleAccess } from "../google/token.js";
import { forgetMicrosoftAccess, microsoftAccess } from "./microsoft.js";
import type { EmailSource, MailAuth } from "./store.js";

// What opens the person's mailbox: its password — an app password — or,
// for a mailbox that signs in with Microsoft, the refresh token of that
// sign-in (microsoft.ts), the newest Microsoft gave. Kept as the connectors
// keep their tokens (connectors.json): on this computer, in a file of its
// own that only this account can read (0600), apart from the database and
// the copies saved before each migration. Never sent back to a screen,
// never given to a model, never written to a log. Removing the mailbox
// forgets it. A Gmail mailbox linked with « Se connecter avec Google » keeps
// Google's refresh token here the same way ({ kind: "google", refreshToken }),
// read through the Gmail API (gmailMailbox.ts), never over IMAP.

interface Kept {
  password?: string;
  refresh_token?: string;
  /// « google »: Google's sign-in, its refresh token in `refreshToken`.
  kind?: "google";
  refreshToken?: string;
  saved_at: number;
}

/// A mailbox's secret.
export type MailSecret = { kind: "password"; password: string } | { kind: "microsoft"; refreshToken: string } | { kind: "google"; refreshToken: string };

const FILE = () => join(DATA_DIR, "email-credentials.json");

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

export function mailSecret(sourceId: string): MailSecret | null {
  const kept = readAll()[sourceId];
  if (kept?.kind === "google") return typeof kept.refreshToken === "string" && kept.refreshToken ? { kind: "google", refreshToken: kept.refreshToken } : null;
  if (typeof kept?.refresh_token === "string" && kept.refresh_token) return { kind: "microsoft", refreshToken: kept.refresh_token };
  if (typeof kept?.password === "string" && kept.password) return { kind: "password", password: kept.password };
  return null;
}

/// Kept in place of whatever was kept for this mailbox.
export function keepMailSecret(sourceId: string, secret: MailSecret): void {
  const kept: Kept = secret.kind === "password"
    ? { password: secret.password, saved_at: Date.now() }
    : secret.kind === "google"
      ? { kind: "google", refreshToken: secret.refreshToken, saved_at: Date.now() }
      : { refresh_token: secret.refreshToken, saved_at: Date.now() };
  writeAll({ ...readAll(), [sourceId]: kept });
}

/// The refresh token Microsoft gave back in place of `used`, kept — if
/// `used` is still the one kept: never after the mailbox was removed, nor
/// over a sign-in done again meanwhile.
export function renewMailRefreshToken(sourceId: string, used: string, newest: string): void {
  if (used === newest) return;
  const all = readAll();
  if (all[sourceId]?.refresh_token !== used) return;
  all[sourceId] = { refresh_token: newest, saved_at: Date.now() };
  writeAll(all);
}

export function forgetMailSecret(sourceId: string): void {
  const all = readAll();
  const kept = all[sourceId];
  if (!kept) return;
  // The access tokens got with it, from memory too.
  if (kept.refresh_token) forgetMicrosoftAccess(kept.refresh_token);
  if (kept.kind === "google" && kept.refreshToken) forgetGoogleAccess(kept.refreshToken);
  delete all[sourceId];
  writeAll(all);
}

/// A session on a mailbox, opened with its secret: its password, or an
/// access token got with its Microsoft sign-in — the newest refresh token
/// Microsoft gave is handed to `renewed`, to keep in place of the one used.
/// A token from memory that the server refuses was perhaps withdrawn before
/// its time (a new password): a new one is got, once. Refused again, or
/// refused when new, it is the mailbox's IMAP access that is refused.
export async function openMailbox(
  mailbox: MailServer & { username: string; secret: MailSecret },
  door: { configured: { host: string; port: number; auth: MailAuth } | null; emailOn: boolean },
  renewed: (used: string, newest: string) => void = () => undefined,
): Promise<MailSession> {
  const { secret, ...server } = mailbox;
  if (secret.kind === "password") return openMailSession({ ...server, password: secret.password }, door);
  // Google's sign-in opens no IMAP session: the Gmail API reads the mailbox.
  if (secret.kind === "google") throw new MailError("failed");
  // Microsoft's token endpoint: for a mailbox set up (or being set up) to
  // sign in with Microsoft, while E-mails is on (outbound.ts).
  const tokenDoor = { microsoftMailbox: door.configured?.auth === "microsoft", emailOn: door.emailOn };
  let access = await microsoftAccess(secret.refreshToken, tokenDoor);
  if (access.refreshToken !== secret.refreshToken) renewed(secret.refreshToken, access.refreshToken);
  try {
    return await openMailSession({ ...server, accessToken: access.accessToken }, door);
  } catch (err) {
    if (!(err instanceof MailError) || err.code !== "auth_failed") throw err;
  }
  if (access.cached) {
    const used = access.refreshToken;
    access = await microsoftAccess(used, tokenDoor, { fresh: true });
    if (access.refreshToken !== used) renewed(used, access.refreshToken);
    try {
      return await openMailSession({ ...server, accessToken: access.accessToken }, door);
    } catch (err) {
      if (!(err instanceof MailError) || err.code !== "auth_failed") throw err;
    }
  }
  throw new MailError("imap_refused");
}

/// The mailbox set up, opened with the secret kept for it.
export function openSourceMailbox(source: EmailSource, emailOn: boolean): Promise<MailSession> {
  // One read through Microsoft Graph, or the Gmail API, opens no IMAP
  // session (graphMailbox.ts, gmailMailbox.ts).
  if (source.auth === "graph" || source.auth === "gmail") return Promise.reject(new MailError("failed"));
  const secret = mailSecret(source.id);
  if (!secret) return Promise.reject(new MailError(source.auth === "microsoft" ? "signin_required" : "password_missing"));
  return openMailbox(
    { host: source.imap_host, port: source.imap_port, security: source.imap_security, username: source.username, secret },
    { configured: { host: source.imap_host, port: source.imap_port, auth: source.auth }, emailOn },
    (used, newest) => renewMailRefreshToken(source.id, used, newest),
  );
}
