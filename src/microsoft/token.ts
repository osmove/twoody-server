import { createHash } from "node:crypto";
import { GraphDoorClosedError, MailDoorClosedError, MICROSOFT_TOKEN_URL, microsoftTokenDoor, microsoftTokenFetch, type MicrosoftTokenDoorState } from "../outbound.js";

// Microsoft's sign-in, renewed (04/10/2026). Twoody's app at Microsoft is a
// public client; the Desktop's main process signs the person in (twoody-
// desktop src/main/microsoftSignIn.ts: the browser, PKCE, a loopback
// redirect) and hands this server a refresh token and nothing else — for
// their mailbox (src/email/microsoft.ts, read over IMAP), or for their
// calendar and contacts (src/microsoft/sync.ts, read through Microsoft
// Graph). Two grants, each kept apart with its own life.
//
// Here an access token is got with a refresh token, for one resource — the
// scope says which — at Microsoft's token endpoint, the one address the door
// of src/outbound.ts opens for it, while the grant's capability is on. It is
// kept in memory, never on disk, until shortly before it expires. Microsoft
// may give a new refresh token with it: the newest is handed back, for the
// caller to keep. What Microsoft refuses is said as a code, from its error
// and its AADSTS numbers, never its text (it may name the account): a grant
// it no longer honours (revoked, expired, a new password, a new
// verification) is `signin_required`; one that waits for an approval, the
// organisation's above all, `admin_consent_required`.

/// Twoody's app at Microsoft (registered 04/10/2026): a public client, no
/// secret; work, school and personal accounts.
export const MICROSOFT_CLIENT_ID = "804f73f0-5611-4e2e-a8da-fd5efb0293ea";
/// An access token is used until this long before it expires.
const EXPIRY_MARGIN_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 30_000;

/// AADSTS numbers of an approval the sign-in waits for: consent to Twoody
/// (65001; an administrator's: 90094, 90095), the app assigned to the
/// person (50105) or allowed by the organisation's access policies
/// (53000–53003), a service the organisation lacks (650052, 500011), the
/// app disabled there (7000112).
const APPROVAL_CODES = new Set([65001, 90094, 90095, 50105, 53000, 53001, 53002, 53003, 650052, 500011, 7000112]);

/// What went wrong with a sign-in: to do again, an approval it waits for, a
/// refusal of another kind, or Microsoft out of reach.
export type MicrosoftSignInCode = "signin_required" | "admin_consent_required" | "signin_failed" | "signin_unreachable";

export class MicrosoftSignInError extends Error {
  constructor(public code: MicrosoftSignInCode) {
    super(code);
    this.name = "MicrosoftSignInError";
  }
}

/// What Microsoft's refusal at its token endpoint means.
export function microsoftErrorCode(answer: unknown): Exclude<MicrosoftSignInCode, "signin_unreachable"> {
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
  /// The one it was got with.
  from: string;
}

/// Access tokens in memory, by resource (its scope) and the refresh token
/// they were got with (its hash) — and by the one given back with them.
const accesses = new Map<string, Access>();
/// One request at a time per resource and refresh token.
const pending = new Map<string, Promise<Access>>();

const keyOf = (scope: string, refreshToken: string) => createHash("sha256").update(scope).update("\0").update(refreshToken).digest("base64url");

type Transport = (target: string, init: RequestInit, door: MicrosoftTokenDoorState) => Promise<Response>;

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

export interface MicrosoftAccessRequest {
  /// The resource's permissions, and offline_access for a new refresh token.
  scope: string;
  /// The grant, as the door of src/outbound.ts reads it, now.
  door: MicrosoftTokenDoorState;
}

/// An access token with this sign-in, for this resource: from memory until
/// shortly before it expires — unless `fresh`, the resource having refused
/// it — else from Microsoft, through the door. Throws the door's refusal
/// (MailDoorClosedError, GraphDoorClosedError) or a MicrosoftSignInError.
export async function microsoftAccess(refreshToken: string, request: MicrosoftAccessRequest, options: { fresh?: boolean } = {}): Promise<MicrosoftAccess> {
  const key = keyOf(request.scope, refreshToken);
  const known = accesses.get(key);
  if (known && !options.fresh && known.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return { accessToken: known.token, refreshToken: known.refreshToken, cached: true };
  }
  let asked = pending.get(key);
  if (!asked) {
    asked = refresh(refreshToken, request).finally(() => pending.delete(key));
    pending.set(key, asked);
  }
  const got = await asked;
  return { accessToken: got.token, refreshToken: got.refreshToken, cached: false };
}

/// What memory holds for this sign-in, forgotten (its grant removed).
export function forgetMicrosoftAccess(refreshToken: string): void {
  for (const [key, access] of accesses) if (access.from === refreshToken || access.refreshToken === refreshToken) accesses.delete(key);
}

async function refresh(refreshToken: string, request: MicrosoftAccessRequest): Promise<Access> {
  let response: Response;
  try {
    // The door first, whoever answers.
    microsoftTokenDoor(MICROSOFT_TOKEN_URL, request.door);
    response = await transport(MICROSOFT_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken, scope: request.scope }).toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    }, request.door);
  } catch (err) {
    if (err instanceof MailDoorClosedError || err instanceof GraphDoorClosedError) throw err;
    throw new MicrosoftSignInError("signin_unreachable");
  }
  const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || typeof answer?.access_token !== "string" || !answer.access_token) throw new MicrosoftSignInError(microsoftErrorCode(answer));
  const seconds = Number(answer.expires_in);
  const now = Date.now();
  const access: Access = {
    token: answer.access_token,
    // A lifetime Microsoft did not say: used for this session only.
    expiresAt: now + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0),
    refreshToken: typeof answer.refresh_token === "string" && answer.refresh_token ? answer.refresh_token : refreshToken,
    from: refreshToken,
  };
  for (const [key, kept] of accesses) if (kept.expiresAt <= now) accesses.delete(key);
  accesses.set(keyOf(request.scope, refreshToken), access);
  accesses.set(keyOf(request.scope, access.refreshToken), access);
  return access;
}
