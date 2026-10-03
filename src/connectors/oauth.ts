import { createHash, randomBytes } from "node:crypto";
import { outboundFetch } from "../outbound.js";

// Signing in to a connector's service (Jimmy, 03/10/2026: « ajoute le
// support OAuth pour les connecteurs »), as the MCP authorization spec
// asks of a client: the server answers 401 and names its protected
// resource metadata (RFC 9728), which names its authorization server
// (RFC 8414); this computer registers itself there (RFC 7591) unless the
// person gave an app's id, opens the sign-in page in the person's browser
// with PKCE (S256) and the resource it is for (RFC 8707), and receives the
// code at its own loopback address (RFC 8252). The tokens stay on this
// computer (connectors.json, 0600) and are renewed with the refresh token.

export interface OAuthState {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string | null;
  client_id: string;
  client_secret?: string | null;
  redirect_uri: string;
  scope?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  /// Milliseconds since the epoch.
  expires_at?: number | null;
}

export class OAuthError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

type Fetch = typeof outboundFetch;
const TIMEOUT_MS = 20_000;

/// `resource_metadata="…"` of a WWW-Authenticate header, when given.
export function resourceMetadataUrl(header: string | null | undefined): string | null {
  const match = /resource_metadata="([^"]+)"/i.exec(header ?? "");
  return match?.[1] ?? null;
}

async function getJson(url: string, fetchImpl: Fetch): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/// The well-known addresses for `base` (an origin and maybe a path), the
/// path-inserted form first as RFC 8414 and RFC 9728 say.
function wellKnown(base: string, name: string): string[] {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  const urls = path && path !== "/" ? [`${url.origin}/.well-known/${name}${path}`] : [];
  urls.push(`${url.origin}/.well-known/${name}`);
  return urls;
}

export interface AuthorizationServer {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  scopes: string[];
}

/// Where to sign in for the MCP server at `serverUrl`, from what it said
/// with its 401 (`wwwAuthenticate`).
export async function discover(serverUrl: string, wwwAuthenticate: string | null, fetchImpl: Fetch = outboundFetch): Promise<AuthorizationServer> {
  let prm: Record<string, unknown> | null = null;
  const named = resourceMetadataUrl(wwwAuthenticate);
  for (const url of named ? [named] : wellKnown(serverUrl, "oauth-protected-resource")) {
    prm = await getJson(url, fetchImpl);
    if (prm) break;
  }
  const servers = Array.isArray(prm?.authorization_servers) ? (prm!.authorization_servers as unknown[]).filter((value): value is string => typeof value === "string") : [];
  // Without its metadata (an older server), the server's own origin.
  const issuer = servers[0] ?? new URL(serverUrl).origin;
  let meta: Record<string, unknown> | null = null;
  for (const url of [...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration")]) {
    meta = await getJson(url, fetchImpl);
    if (meta) break;
  }
  const origin = new URL(issuer).origin;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  const scopes = [...(Array.isArray(prm?.scopes_supported) ? (prm!.scopes_supported as unknown[]) : [])].filter((value): value is string => typeof value === "string");
  return {
    issuer: text(meta?.issuer) ?? issuer,
    authorization_endpoint: text(meta?.authorization_endpoint) ?? `${origin}/authorize`,
    token_endpoint: text(meta?.token_endpoint) ?? `${origin}/token`,
    registration_endpoint: text(meta?.registration_endpoint) ?? (meta ? null : `${origin}/register`),
    scopes,
  };
}

/// This computer, registered with the authorization server for `redirectUri`.
export async function register(server: AuthorizationServer, redirectUri: string, fetchImpl: Fetch = outboundFetch): Promise<{ client_id: string; client_secret: string | null }> {
  if (!server.registration_endpoint) throw new OAuthError("client_id_required", "this service does not let an app register itself: give the id of an app made for Twoody there");
  const response = await fetchImpl(server.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Twoody",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new OAuthError("registration_failed", `the service refused to register Twoody (HTTP ${response.status})`);
  const body = (await response.json()) as { client_id?: unknown; client_secret?: unknown };
  if (typeof body.client_id !== "string" || !body.client_id) throw new OAuthError("registration_failed", "the service gave no client id");
  return { client_id: body.client_id, client_secret: typeof body.client_secret === "string" ? body.client_secret : null };
}

const base64url = (bytes: Buffer) => bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

/// The sign-in page's address.
export function authorizationUrl(oauth: OAuthState, { state, challenge, resource }: { state: string; challenge: string; resource: string }): string {
  const url = new URL(oauth.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", oauth.client_id);
  url.searchParams.set("redirect_uri", oauth.redirect_uri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", resource);
  if (oauth.scope) url.searchParams.set("scope", oauth.scope);
  return url.toString();
}

async function tokenRequest(oauth: OAuthState, fields: Record<string, string>, fetchImpl: Fetch): Promise<Partial<OAuthState>> {
  const form = new URLSearchParams({ ...fields, client_id: oauth.client_id });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (oauth.client_secret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(oauth.client_id)}:${encodeURIComponent(oauth.client_secret)}`).toString("base64")}`;
  const response = await fetchImpl(oauth.token_endpoint, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown };
  if (!response.ok || typeof body.access_token !== "string") {
    throw new OAuthError(typeof body.error === "string" ? body.error : "token_failed", typeof body.error_description === "string" ? body.error_description : `the service refused (HTTP ${response.status})`);
  }
  const seconds = Number(body.expires_in);
  return {
    access_token: body.access_token,
    // A refresh without a new refresh token keeps the old one.
    ...(typeof body.refresh_token === "string" ? { refresh_token: body.refresh_token } : {}),
    expires_at: Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : null,
  };
}

/// The code the sign-in page gave, for tokens.
export function exchangeCode(oauth: OAuthState, { code, verifier, resource }: { code: string; verifier: string; resource: string }, fetchImpl: Fetch = outboundFetch) {
  return tokenRequest(oauth, { grant_type: "authorization_code", code, redirect_uri: oauth.redirect_uri, code_verifier: verifier, resource }, fetchImpl);
}

/// New tokens from the refresh token.
export function refreshTokens(oauth: OAuthState, resource: string, fetchImpl: Fetch = outboundFetch) {
  if (!oauth.refresh_token) return Promise.reject(new OAuthError("signed_out"));
  return tokenRequest(oauth, { grant_type: "refresh_token", refresh_token: oauth.refresh_token, resource }, fetchImpl);
}

/// Whether the access token is still good for a minute.
export function tokenFresh(oauth: OAuthState | null | undefined, now = Date.now()): boolean {
  return !!oauth?.access_token && (!oauth.expires_at || oauth.expires_at - 60_000 > now);
}

// ── Sign-ins under way: the browser comes back with `state` ────────────
const PENDING_MS = 10 * 60_000;
const pending = new Map<string, { userId: string; connectorId: string; verifier: string; at: number }>();

export function rememberSignIn(userId: string, connectorId: string, verifier: string): string {
  for (const [key, entry] of pending) if (Date.now() - entry.at > PENDING_MS) pending.delete(key);
  const state = base64url(randomBytes(24));
  pending.set(state, { userId, connectorId, verifier, at: Date.now() });
  return state;
}

/// The sign-in `state` names, once (null when unknown or too old).
export function takeSignIn(state: string): { userId: string; connectorId: string; verifier: string } | null {
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry || Date.now() - entry.at > PENDING_MS) return null;
  return entry;
}
