import { createHash } from "node:crypto";
import { GmailDoorClosedError, GOOGLE_TOKEN_URL, googleTokenDoor, googleTokenFetch, type GmailDoorState } from "../outbound.js";
import { googleClient } from "./client.js";

// Google's sign-in, renewed (« Se connecter avec Google », Capacités →
// E-mails, 05/10/2026). The Desktop's main process signs the person in
// (twoody-desktop src/main/googleSignIn.ts: the browser, PKCE, a loopback
// redirect) and hands this server a refresh token and nothing else; it is
// kept as a password is (src/email/credentials.ts, { kind: "google" }).
//
// Here an access token to the Gmail API is got with it, at Google's token
// endpoint — the one address the door of src/outbound.ts opens for it, while
// E-mails is on and the mailbox signs in with Google — with Twoody's client
// (client.ts). It is kept in memory only, never on disk, until shortly
// before it expires. What Google refuses is said as a code, from its
// `error` alone, never its text: a sign-in Google no longer honours
// (revoked, expired, a new password, too long unused) is `signin_required`;
// one an organisation's administrator restricts, `admin_consent_required`.

/// An access token is used until this long before it expires.
const EXPIRY_MARGIN_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 30_000;

/// What went wrong with the sign-in: to do again, an approval it waits for,
/// a refusal of another kind, or Google out of reach.
export type GoogleSignInCode = "signin_required" | "admin_consent_required" | "signin_failed" | "signin_unreachable";

export class GoogleSignInError extends Error {
  constructor(public code: GoogleSignInCode) {
    super(code);
    this.name = "GoogleSignInError";
  }
}

/// What Google's refusal at its token endpoint means, from its `error`
/// (RFC 6749 5.2, and Google's own words for an organisation's policy).
export function googleErrorCode(answer: unknown): Exclude<GoogleSignInCode, "signin_unreachable"> {
  const body = (answer && typeof answer === "object" ? answer : {}) as { error?: unknown; error_subtype?: unknown };
  const error = typeof body.error === "string" ? body.error : "";
  // A Google Workspace administrator restricts the app, or keeps the
  // organisation's data to its own apps.
  if (["admin_policy_enforced", "org_internal", "access_denied", "restricted_client", "consent_required"].includes(error)) return "admin_consent_required";
  // Revoked, expired, a new password, a re-authentication the organisation
  // asks for (invalid_rapt): signing in again mends it.
  if (error === "invalid_grant" || error === "interaction_required") return "signin_required";
  return "signin_failed";
}

interface Access {
  token: string;
  expiresAt: number;
}

/// Access tokens in memory, by the refresh token they were got with (its hash).
const accesses = new Map<string, Access>();
/// One request at a time per refresh token.
const pending = new Map<string, Promise<Access>>();

const keyOf = (refreshToken: string) => createHash("sha256").update(refreshToken).digest("base64url");

type Transport = (target: string, init: RequestInit, door: GmailDoorState) => Promise<Response>;

let transport: Transport = googleTokenFetch;

/// For the tests: Google's token endpoint answered by a fake (null: the real
/// one), memory emptied. The door is asked all the same.
export function useGoogleTokenEndpointForTests(fake: ((init: RequestInit) => Promise<Response>) | null): void {
  transport = fake ? (_target, init) => fake(init) : googleTokenFetch;
  accesses.clear();
  pending.clear();
}

export interface GoogleAccess {
  accessToken: string;
  /// Got earlier, from memory.
  cached: boolean;
}

/// An access token with this sign-in: from memory until shortly before it
/// expires — unless `fresh`, the Gmail API having refused it — else from
/// Google, through the door. Throws the door's refusal (GmailDoorClosedError)
/// or a GoogleSignInError.
export async function googleAccess(refreshToken: string, door: GmailDoorState, options: { fresh?: boolean } = {}): Promise<GoogleAccess> {
  const key = keyOf(refreshToken);
  const known = accesses.get(key);
  if (known && !options.fresh && known.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    // The door all the same: E-mails turned off meanwhile is not got round
    // by a token in memory.
    googleTokenDoor(GOOGLE_TOKEN_URL, door);
    return { accessToken: known.token, cached: true };
  }
  let asked = pending.get(key);
  if (!asked) {
    asked = refresh(refreshToken, door).finally(() => pending.delete(key));
    pending.set(key, asked);
  }
  const got = await asked;
  return { accessToken: got.token, cached: false };
}

/// What memory holds for this sign-in, forgotten (the mailbox removed).
export function forgetGoogleAccess(refreshToken: string): void {
  accesses.delete(keyOf(refreshToken));
}

async function refresh(refreshToken: string, door: GmailDoorState): Promise<Access> {
  const client = googleClient();
  if (!client) throw new GoogleSignInError("signin_failed");
  let response: Response;
  try {
    // The door first, whoever answers.
    googleTokenDoor(GOOGLE_TOKEN_URL, door);
    response = await transport(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    }, door);
  } catch (err) {
    if (err instanceof GmailDoorClosedError) throw err;
    throw new GoogleSignInError("signin_unreachable");
  }
  const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || typeof answer?.access_token !== "string" || !answer.access_token) throw new GoogleSignInError(googleErrorCode(answer));
  const seconds = Number(answer.expires_in);
  const now = Date.now();
  const access: Access = {
    token: answer.access_token,
    // A lifetime Google did not say: used for this session only.
    expiresAt: now + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0),
  };
  for (const [key, kept] of accesses) if (kept.expiresAt <= now) accesses.delete(key);
  accesses.set(keyOf(refreshToken), access);
  return access;
}
