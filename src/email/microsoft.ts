import { createHash } from "node:crypto";
import { MailDoorClosedError, MICROSOFT_TOKEN_URL, microsoftTokenDoor, microsoftTokenFetch } from "../outbound.js";
import { MailError, type MailErrorCode } from "./imap.js";

// « Se connecter avec Microsoft » (Capacités → E-mails, 04/10/2026): an
// Outlook.com or Microsoft 365 mailbox takes no password over IMAP, only
// Microsoft's own sign-in (OAuth 2.0). It is linked with that sign-in and
// read over IMAP with XOAUTH2.
//
// The sign-in itself runs in the Desktop's main process (twoody-desktop
// src/main/microsoftSignIn.ts: the browser, PKCE, a loopback redirect),
// which hands this server the refresh token and nothing else; it is kept
// as a password is (credentials.ts). Here, before each session on the
// mailbox, an access token is got with it at Microsoft's token endpoint —
// the one address the door of src/outbound.ts opens for it — and kept in
// memory, never on disk, until shortly before it expires. Microsoft may
// give a new refresh token with it: the newest is the one kept. What
// Microsoft refuses is said as a code, from its error and its AADSTS
// numbers, never its text (it may name the account): a grant it no longer
// honours (revoked, expired, a new password, a new verification) is
// `signin_required`; one that waits for an approval, the organisation's
// above all, `admin_consent_required`.

/// Twoody's app at Microsoft (registered 04/10/2026): a public client, no
/// secret; work, school and personal accounts.
export const MICROSOFT_CLIENT_ID = "804f73f0-5611-4e2e-a8da-fd5efb0293ea";
/// Outlook.com and Microsoft 365 mailboxes alike.
export const MICROSOFT_IMAP = { host: "outlook.office365.com", port: 993, security: "tls" } as const;
const REFRESH_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All offline_access";
/// An access token is used until this long before it expires.
const EXPIRY_MARGIN_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 30_000;

/// AADSTS numbers of an approval the sign-in waits for: consent to Twoody
/// (65001; an administrator's: 90094, 90095), the app assigned to the
/// person (50105) or allowed by the organisation's access policies
/// (53000–53003), a service the organisation lacks (650052, 500011), the
/// app disabled there (7000112).
const APPROVAL_CODES = new Set([65001, 90094, 90095, 50105, 53000, 53001, 53002, 53003, 650052, 500011, 7000112]);

/// What Microsoft's refusal at its token endpoint means.
export function microsoftErrorCode(answer: unknown): MailErrorCode {
  const body = (answer && typeof answer === "object" ? answer : {}) as { error?: unknown; error_codes?: unknown; error_description?: unknown };
  const codes = new Set<number>(Array.isArray(body.error_codes) ? body.error_codes.filter((code): code is number => Number.isInteger(code)) : []);
  if (typeof body.error_description === "string") for (const match of body.error_description.matchAll(/AADSTS(\d+)/g)) codes.add(Number(match[1]));
  if ([...codes].some((code) => APPROVAL_CODES.has(code)) || body.error === "consent_required") return "admin_consent_required";
  if (body.error === "invalid_grant" || body.error === "interaction_required") return "signin_required";
  return "signin_failed";
}

interface Access {
  token: string;
  expiresAt: number;
  /// The newest refresh token: the one it was got with, or the one
  /// Microsoft gave back in its place.
  refreshToken: string;
}

/// Access tokens in memory, by the refresh token they were got with (its
/// hash) and by the one given back with them.
const accesses = new Map<string, Access>();
/// One request at a time per refresh token.
const pending = new Map<string, Promise<Access>>();

const keyOf = (refreshToken: string) => createHash("sha256").update(refreshToken).digest("base64url");

type TokenDoor = { microsoftMailbox: boolean; emailOn: boolean };
type Transport = (target: string, init: RequestInit, door: TokenDoor) => Promise<Response>;

let transport: Transport = microsoftTokenFetch;

/// For the tests: Microsoft's token endpoint answered by a fake (null: the
/// real one), memory emptied. The door is asked all the same.
export function useMicrosoftTokenEndpointForTests(fake: ((init: RequestInit) => Promise<Response>) | null): void {
  transport = fake ? (_target, init) => fake(init) : microsoftTokenFetch;
  accesses.clear();
  pending.clear();
}

export interface MicrosoftAccess {
  accessToken: string;
  /// The newest refresh token, to keep in place of the one given.
  refreshToken: string;
  /// Got earlier, from memory.
  cached: boolean;
}

/// An access token to the mailbox (IMAP) with this sign-in: from memory
/// until shortly before it expires — unless `fresh`, the server having
/// refused it — else from Microsoft, through the door. `microsoftMailbox`:
/// the mailbox set up, or being set up, signs in with Microsoft.
export async function microsoftAccess(refreshToken: string, door: TokenDoor, options: { fresh?: boolean } = {}): Promise<MicrosoftAccess> {
  const key = keyOf(refreshToken);
  const known = accesses.get(key);
  if (known && !options.fresh && known.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return { accessToken: known.token, refreshToken: known.refreshToken, cached: true };
  }
  let asked = pending.get(key);
  if (!asked) {
    asked = refresh(refreshToken, door).finally(() => pending.delete(key));
    pending.set(key, asked);
  }
  const got = await asked;
  return { accessToken: got.token, refreshToken: got.refreshToken, cached: false };
}

/// What memory holds for this sign-in, forgotten (the mailbox removed).
export function forgetMicrosoftAccess(refreshToken: string): void {
  const key = keyOf(refreshToken);
  for (const [one, access] of accesses) if (one === key || access.refreshToken === refreshToken) accesses.delete(one);
}

async function refresh(refreshToken: string, door: TokenDoor): Promise<Access> {
  let response: Response;
  try {
    // The door first, whoever answers.
    microsoftTokenDoor(MICROSOFT_TOKEN_URL, door.microsoftMailbox, door.emailOn);
    response = await transport(MICROSOFT_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken, scope: REFRESH_SCOPE }).toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    }, door);
  } catch (err) {
    if (err instanceof MailDoorClosedError) throw new MailError(err.reason);
    throw new MailError("signin_unreachable");
  }
  const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || typeof answer?.access_token !== "string" || !answer.access_token) throw new MailError(microsoftErrorCode(answer));
  const seconds = Number(answer.expires_in);
  const now = Date.now();
  const access: Access = {
    token: answer.access_token,
    // A lifetime Microsoft did not say: used for this session only.
    expiresAt: now + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0),
    refreshToken: typeof answer.refresh_token === "string" && answer.refresh_token ? answer.refresh_token : refreshToken,
  };
  for (const [key, kept] of accesses) if (kept.expiresAt <= now) accesses.delete(key);
  accesses.set(keyOf(refreshToken), access);
  accesses.set(keyOf(access.refreshToken), access);
  return access;
}
