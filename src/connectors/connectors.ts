import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../db.js";
import { connectorFetch } from "../outbound.js";
import { fetchConnectorIcon } from "./icons.js";
import { McpAuthRequiredError, McpClient, type McpToolInfo, type McpTransportConfig } from "./mcpClient.js";
import { authorizationUrl, discover, exchangeCode, OAuthError, pkce, refreshTokens, register, rememberSignIn, takeSignIn, tokenFresh, type OAuthState } from "./oauth.js";

// « Connecteurs » in Capacités (Jimmy, 03/10/2026): the person's services
// — Notion, GitHub, a database, a home tool… — through MCP servers, whose
// tools the chat may use, each call asked first in the chat
// (`waitForApproval`, answered by POST /queries/approval).
//
// Added only from this computer's app: a connector is a command this
// computer runs, or an address it calls with the person's token. Kept
// apart from the preferences, in DATA_DIR/connectors.json (0600): the
// values of its environment and headers (tokens) never come back to a
// screen, only their names.

/// What a tool's server says of it (MCP tool annotations), as kept: the
/// two hints « Toujours autoriser » rests on, booleans only. `{}` when it
/// said nothing; absent on a tool listed before 11/10/2026 (not yet read
/// again).
export interface ToolHints { readOnlyHint?: boolean; destructiveHint?: boolean }

export interface StoredTool { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: ToolHints }

/// The hints kept from what a server listed: `true`/`false` only.
export function toolHints(raw: unknown): ToolHints {
  const out: ToolHints = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const { readOnlyHint, destructiveHint } = raw as Record<string, unknown>;
  if (typeof readOnlyHint === "boolean") out.readOnlyHint = readOnlyHint;
  if (typeof destructiveHint === "boolean") out.destructiveHint = destructiveHint;
  return out;
}

/// Whether a tool may be allowed once and for all (« Toujours autoriser »,
/// Jimmy, 11/10/2026): only one its server says only reads
/// (`readOnlyHint: true`) and does not say destroys. Every other tool —
/// one that writes, sends, deletes, or whose server says nothing — is
/// asked at each call, whatever was allowed before: a prompt injection in
/// a document, an e-mail, a web page or another tool's result can talk the
/// model into calling it (docs/connectors-security-review.md). The hints
/// are the server's own word: a lying server is the residual risk.
export function mayAlwaysAllow(tool: Pick<StoredTool, "annotations"> | null | undefined): boolean {
  return tool?.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;
}

/// Whether a stored « always » counts for this tool: given, and the tool
/// may be (mayAlwaysAllow). A grant on another tool stays stored, ignored.
function alwaysAllowed(connector: Pick<Connector, "auto_tools">, tool: StoredTool): boolean {
  return (connector.auto_tools ?? []).includes(tool.name) && mayAlwaysAllow(tool);
}

export interface Connector {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  /// The tools the person turned off.
  disabled_tools: string[];
  /// The tools the person allowed once and for all: called without asking
  /// (Jimmy, 03/10/2026: « Toujours autoriser », for the ones that only read).
  /// Since 11/10/2026 only a read-only tool's counts (mayAlwaysAllow); one
  /// given before to another tool stays here, ignored.
  auto_tools?: string[];
  /// Its tools when it last started, offered to the chat without starting it.
  tools: StoredTool[];
  error: string | null;
  created_at: string;
  /// Signed in to its service (connectors/oauth.ts): never shown.
  oauth?: OAuthState | null;
  /// An app's id the person made for Twoody at a service that does not
  /// let apps register themselves.
  oauth_client?: { client_id: string; client_secret?: string | null } | null;
  /// The service answered that it wants a sign-in, and what it said.
  auth_required?: boolean;
  www_authenticate?: string | null;
  /// An http connector's icon, from its own origin (icons.ts): a data URI.
  icon?: string | null;
  /// When it was last asked for: at most once a day.
  icon_checked_at?: string | null;
}

export class ConnectorError extends Error {
  constructor(public code: string, public status = 422) {
    super(code);
  }
}

const FILE = () => join(DATA_DIR, "connectors.json");
/// Tools offered to a chat in all: each costs tokens in every message.
export const MAX_CHAT_TOOLS = 40;
/// A connector with more tools than this starts with none offered: the
/// person picks the ones they need (Jimmy, 03/10/2026: J-Way's 58 tools all
/// went to every message).
export const PICK_ABOVE_TOOLS = 15;

/// About how many tokens a tool's definition adds to every message (its
/// name, description and parameters as the model reads them).
export function toolTokens(tool: Pick<StoredTool, "name" | "description" | "inputSchema">): number {
  return Math.ceil(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.inputSchema }).length / 3.6);
}
const DESCRIPTION_CHARS = 500;

function readAll(): Record<string, Connector[]> {
  try {
    const parsed = JSON.parse(readFileSync(FILE(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Connector[]>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Connector[]>) {
  writeFileSync(FILE(), JSON.stringify(all, null, 2), { mode: 0o600 });
}

export function listConnectors(userId: string): Connector[] {
  return (readAll()[userId] ?? []).filter((connector) => connector && typeof connector.id === "string");
}

function saveConnectors(userId: string, connectors: Connector[]) {
  const all = readAll();
  all[userId] = connectors;
  writeAll(all);
}

function update(userId: string, id: string, change: (connector: Connector) => Connector): Connector {
  const connectors = listConnectors(userId);
  const index = connectors.findIndex((connector) => connector.id === id);
  if (index < 0) throw new ConnectorError("not_found", 404);
  connectors[index] = change(connectors[index]!);
  saveConnectors(userId, connectors);
  return connectors[index]!;
}

const stringMap = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/^[A-Za-z_][A-Za-z0-9_-]{0,100}$/.test(key) && typeof raw === "string") out[key] = raw.slice(0, 4_000);
  }
  return Object.keys(out).length ? out : undefined;
};

/// A connector as asked: a name, and a command (with its arguments and
/// environment) or an https address (with its headers).
export function readConnectorInput(body: unknown, existing?: Connector): Pick<Connector, "name" | "command" | "args" | "env" | "url" | "headers" | "oauth_client"> {
  const input = (body && typeof body === "object" ? (body as { connector?: unknown }).connector ?? body : {}) as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : existing?.name ?? "";
  if (!name) throw new ConnectorError("name_required");
  const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : undefined;
  const command = typeof input.command === "string" && input.command.trim() ? input.command.trim() : undefined;
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConnectorError("invalid_url");
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) throw new ConnectorError("https_required");
    // Headers left out keep theirs (the token is never sent back to show).
    const clientId = typeof input.oauth_client_id === "string" ? input.oauth_client_id.trim().slice(0, 300) : "";
    const clientSecret = typeof input.oauth_client_secret === "string" ? input.oauth_client_secret.trim().slice(0, 1_000) : "";
    return {
      name, url,
      headers: input.headers === undefined ? existing?.headers : stringMap(input.headers),
      oauth_client: clientId ? { client_id: clientId, client_secret: clientSecret || null } : input.oauth_client_id === undefined ? existing?.oauth_client ?? null : null,
    };
  }
  if (!command) throw new ConnectorError("command_or_url_required");
  const args = Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === "string").map((arg) => arg.slice(0, 2_000)).slice(0, 50) : [];
  return { name, command: command.slice(0, 500), args, env: input.env === undefined ? existing?.env : stringMap(input.env) };
}

export function addConnector(userId: string, body: unknown): Connector {
  const connectors = listConnectors(userId);
  if (connectors.length >= 20) throw new ConnectorError("too_many");
  const connector: Connector = { id: randomUUID(), ...readConnectorInput(body), enabled: true, disabled_tools: [], tools: [], error: null, created_at: new Date().toISOString() };
  saveConnectors(userId, [...connectors, connector]);
  return connector;
}

export function changeConnector(userId: string, id: string, body: unknown): Connector {
  const input = (body && typeof body === "object" ? (body as { connector?: unknown }).connector ?? body : {}) as Record<string, unknown>;
  const changed = update(userId, id, (connector) => {
    let next = connector;
    if (typeof input.name === "string" || input.command !== undefined || input.url !== undefined) {
      // A new command or address replaces the old one; a new name alone keeps it.
      const base = input.command !== undefined || input.url !== undefined ? { name: connector.name } : { name: connector.name, command: connector.command, args: connector.args, url: connector.url };
      const how = readConnectorInput({ ...base, ...input }, connector);
      // Another address: the sign-in to the old one goes.
      const sameService = how.url && how.url === connector.url;
      // Another address: its icon is asked of it again.
      // Another program, other arguments, another environment or address:
      // « Toujours autoriser » was given to what ran before, not to this —
      // every tool asks again.
      const same = how.command === connector.command && JSON.stringify(how.args ?? []) === JSON.stringify(connector.args ?? []) && JSON.stringify(how.env ?? {}) === JSON.stringify(connector.env ?? {}) && how.url === connector.url && JSON.stringify(how.headers ?? {}) === JSON.stringify(connector.headers ?? {});
      next = { ...next, command: undefined, args: undefined, env: undefined, url: undefined, headers: undefined, oauth_client: null, ...how, tools: [], error: null, ...(same ? {} : { auto_tools: [] }), ...(sameService ? {} : { oauth: null, auth_required: false, www_authenticate: null, icon: null, icon_checked_at: null }) };
    }
    if (typeof input.enabled === "boolean") next = { ...next, enabled: input.enabled };
    if (Array.isArray(input.disabled_tools)) next = { ...next, disabled_tools: input.disabled_tools.filter((tool): tool is string => typeof tool === "string").slice(0, 500) };
    if (Array.isArray(input.auto_tools)) {
      // Only the tools that may be (read-only, as last listed) are taken;
      // what was given before to another one stays stored, ignored.
      const eligible = new Set(next.tools.filter(mayAlwaysAllow).map((tool) => tool.name));
      const asked = input.auto_tools.filter((tool): tool is string => typeof tool === "string" && eligible.has(tool));
      const kept = (next.auto_tools ?? []).filter((tool) => !eligible.has(tool));
      next = { ...next, auto_tools: [...new Set([...asked, ...kept])].slice(0, 500) };
    }
    return next;
  });
  // Which tools are offered or asked about changes nothing of the server
  // itself: it keeps running (a call may be under way).
  const restart = Object.keys(input).some((key) => !["disabled_tools", "auto_tools"].includes(key));
  if (restart) stopConnector(userId, id);
  return changed;
}

export function removeConnector(userId: string, id: string) {
  const connectors = listConnectors(userId);
  if (!connectors.some((connector) => connector.id === id)) throw new ConnectorError("not_found", 404);
  stopConnector(userId, id);
  saveConnectors(userId, connectors.filter((connector) => connector.id !== id));
}

/// What a screen shows: never a value of its environment or headers.
/// `fromDevices`: whether the device asking may use it in its own
/// messages — this computer's app, or one of the person's own devices
/// (queries.ts, 08/10/2026); never a household member's or a device paired
/// by code. `detail`: what it runs — its command, arguments (which may
/// hold a token or a database's password), address, the names of its
/// environment and headers, and what went wrong (the end of its error
/// output) — for this computer's app only; any other device gets its
/// name, its tools and whether something is wrong.
export function connectorView(userId: string, connector: Connector, fromDevices = true, detail = true) {
  // What the chat really gets, across all the connectors (MAX_CHAT_TOOLS).
  const offered = new Set(connectorChatTools(userId).filter((tool) => tool.connectorId === connector.id).map((tool) => tool.tool));
  // `may_always`: whether « Toujours autoriser » may be offered for it (a
  // read-only tool); `always`: given, and counting.
  const tools = connector.tools.map((tool) => ({ name: tool.name, description: tool.description, enabled: !connector.disabled_tools.includes(tool.name), offered: offered.has(tool.name), tokens: toolTokens(tool), always: alwaysAllowed(connector, tool), may_always: mayAlwaysAllow(tool), read_only: tool.annotations?.readOnlyHint === true }));
  return {
    id: connector.id,
    name: connector.name,
    kind: connector.url ? "http" : "command",
    command: detail ? connector.command ?? null : null,
    args: detail ? connector.args ?? [] : [],
    url: detail ? connector.url ?? null : null,
    env_keys: detail ? Object.keys(connector.env ?? {}) : [],
    header_keys: detail ? Object.keys(connector.headers ?? {}) : [],
    enabled: connector.enabled,
    running: clients.get(runningKey(userId, connector.id))?.client.running === true,
    error: connector.error && !detail ? "unavailable" : connector.error,
    tools,
    /// The tools the chat gets from it, and about what they add to every message.
    offered_tools: tools.filter((tool) => tool.offered).length,
    offered_tokens: tools.filter((tool) => tool.offered).reduce((sum, tool) => sum + tool.tokens, 0),
    max_chat_tools: MAX_CHAT_TOOLS,
    oauth: connector.url ? {
      required: connector.auth_required === true,
      connected: !!(connector.oauth?.access_token || connector.oauth?.refresh_token),
      service: detail && connector.oauth?.issuer ? new URL(connector.oauth.issuer).host : null,
      client_id_given: !!connector.oauth_client?.client_id,
    } : null,
    /// Its icon as a data URI (icons.ts), or null: the app shows its plug.
    icon: connector.url ? connector.icon ?? null : null,
    /// Usable from the person's own devices too, each call asked on the
    /// device that sent the message (08/10/2026).
    from_devices: fromDevices,
  };
}

/// Where this connector may go: its address, and the sign-in service it
/// named (outbound.ts connectorFetch).
export function connectorOrigins(connector: Pick<Connector, "url" | "oauth">): string[] {
  const origin = (url: string | null | undefined) => {
    try {
      return url ? new URL(url).origin : null;
    } catch {
      return null;
    }
  };
  return [connector.url, connector.oauth?.issuer, connector.oauth?.token_endpoint, connector.oauth?.registration_endpoint]
    .map(origin)
    .filter((value): value is string => !!value);
}

// ── Running ────────────────────────────────────────────────────────────
const clients = new Map<string, { client: McpClient; userId: string }>();
let makeClient = (config: McpTransportConfig, origins: string[] = []) => new McpClient(config, { fetchImpl: connectorFetch(origins) });

/// For the tests: a client that does not start a process.
export function useClientForTests(factory: (config: McpTransportConfig, origins?: string[]) => McpClient) {
  makeClient = factory;
}

function runningKey(userId: string, id: string) {
  return `${userId}:${id}`;
}

/// Every connector's program stopped (this server closing).
export function stopAllConnectors() {
  for (const { client } of clients.values()) client.stop();
  clients.clear();
}

export function stopConnector(userId: string, id: string) {
  const running = clients.get(runningKey(userId, id));
  running?.client.stop();
  clients.delete(runningKey(userId, id));
}

/// Started (once), its tools read again and kept.
export async function startConnector(userId: string, id: string): Promise<{ client: McpClient; connector: Connector }> {
  const connector = listConnectors(userId).find((one) => one.id === id);
  if (!connector) throw new ConnectorError("not_found", 404);
  // Its icon, when it is started (added, signed in, restarted): at most once a day.
  void refreshConnectorIcon(userId, id);
  const running = clients.get(runningKey(userId, id));
  if (running?.client.running) return { client: running.client, connector };
  const client = makeClient({ command: connector.command, args: connector.args, env: connector.env, url: connector.url, headers: connector.headers, ...(connector.url ? { bearer: () => bearerFor(userId, id), renewBearer: () => renewBearer(userId, id) } : {}) }, connectorOrigins(connector));
  try {
    await client.start();
    const listed = await client.listTools();
    clients.set(runningKey(userId, id), { client, userId });
    const tools = listed.slice(0, 200).map((tool: McpToolInfo) => ({
      name: tool.name,
      description: (tool.description ?? "").slice(0, 2_000),
      inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
      annotations: toolHints(tool.annotations),
    }));
    // Many tools, read for the first time: none offered until the person picks.
    // A tool allowed once and for all whose description, parameters or
    // hints changed since (an updated package, a server that rewrites
    // itself): asked again — « Toujours autoriser » was given to what it
    // said then. The hints compared only when they were kept then (a tool
    // listed before 11/10/2026 has none: its grant is not dropped for that).
    const definition = (tool: StoredTool, hints: boolean) => JSON.stringify([tool.description, tool.inputSchema, ...(hints ? [tool.annotations ?? {}] : [])]);
    const updated = update(userId, id, (stored) => ({
      ...stored, tools, error: null, auth_required: false,
      ...(stored.tools.length === 0 && tools.length > PICK_ABOVE_TOOLS ? { disabled_tools: tools.map((tool) => tool.name) } : {}),
      ...(stored.auto_tools?.length ? { auto_tools: stored.auto_tools.filter((name) => {
        const before = stored.tools.find((tool) => tool.name === name);
        const now = tools.find((tool) => tool.name === name);
        const hints = before?.annotations !== undefined;
        return !!before && !!now && definition(before, hints) === definition(now, hints);
      }) } : {}),
    }));
    return { client, connector: updated };
  } catch (err) {
    client.stop();
    if (err instanceof McpAuthRequiredError) {
      update(userId, id, (stored) => ({ ...stored, auth_required: true, www_authenticate: err.wwwAuthenticate, error: null }));
      throw new ConnectorError("sign_in_required", 409);
    }
    const message = err instanceof Error ? err.message : String(err);
    update(userId, id, (stored) => ({ ...stored, error: message.slice(0, 300) }));
    throw new ConnectorError(`start_failed: ${message.slice(0, 200)}`, 502);
  }
}

// ── Its icon ───────────────────────────────────────────────────────────
const ICON_REFRESH_MS = 24 * 3600 * 1000;
const iconsUnderWay = new Map<string, Promise<void>>();
let iconFetcher: (url: string) => Promise<string | null> = (url) => fetchConnectorIcon(url);

/// For the tests: the icon asked of another door (a site on this machine).
export function useIconFetchForTests(fetcher: ((url: string) => Promise<string | null>) | null) {
  iconFetcher = fetcher ?? ((url) => fetchConnectorIcon(url));
}

/// An http connector's icon asked of its own origin, kept with it; not
/// again within a day, nor twice at once. A failure keeps the one it had.
export function refreshConnectorIcon(userId: string, id: string, now = Date.now()): Promise<void> {
  const connector = stored(userId, id);
  if (!connector?.url) return Promise.resolve();
  const checked = connector.icon_checked_at ? Date.parse(connector.icon_checked_at) : NaN;
  if (Number.isFinite(checked) && now - checked < ICON_REFRESH_MS && now >= checked) return Promise.resolve();
  const key = runningKey(userId, id);
  const underWay = iconsUnderWay.get(key);
  if (underWay) return underWay;
  const url = connector.url;
  const done = iconFetcher(url)
    .catch(() => null)
    .then((icon) => {
      try {
        // Changed or removed meanwhile: not kept.
        update(userId, id, (one) => (one.url === url ? { ...one, icon: icon ?? one.icon ?? null, icon_checked_at: new Date(now).toISOString() } : one));
      } catch {
        /* removed */
      }
    })
    .finally(() => iconsUnderWay.delete(key));
  iconsUnderWay.set(key, done);
  return done;
}

// ── Signed in to its service (OAuth) ───────────────────────────────────

function stored(userId: string, id: string): Connector | undefined {
  return listConnectors(userId).find((connector) => connector.id === id);
}

/// The access token to send, renewed first when it is about to expire.
async function bearerFor(userId: string, id: string): Promise<string | null> {
  const connector = stored(userId, id);
  if (!connector?.oauth) return null;
  if (tokenFresh(connector.oauth)) return connector.oauth.access_token ?? null;
  return connector.oauth.refresh_token ? renewBearer(userId, id) : connector.oauth.access_token ?? null;
}

async function renewBearer(userId: string, id: string): Promise<string | null> {
  const connector = stored(userId, id);
  if (!connector?.oauth?.refresh_token || !connector.url) return null;
  try {
    const fresh = await refreshTokens(connector.oauth, connector.url, connectorFetch(connectorOrigins(connector)));
    update(userId, id, (one) => ({ ...one, oauth: { ...one.oauth!, ...fresh } }));
    return fresh.access_token ?? null;
  } catch {
    // Refused: the person signs in again.
    update(userId, id, (one) => ({ ...one, oauth: one.oauth ? { ...one.oauth, access_token: null, refresh_token: null, expires_at: null } : null, auth_required: true }));
    return null;
  }
}

/// The sign-in page's address for this connector; the browser comes back
/// to `redirectUri` (this server's /connectors/oauth/callback).
export async function beginSignIn(userId: string, id: string, redirectUri: string): Promise<string> {
  const connector = stored(userId, id);
  if (!connector) throw new ConnectorError("not_found", 404);
  if (!connector.url) throw new ConnectorError("not_http");
  try {
    // Its address, then the sign-in service it names, may be reached.
    const origins = new Set(connectorOrigins({ url: connector.url, oauth: null }));
    const door: typeof fetch = (input, init) => connectorFetch(origins)(input, init);
    const server = await discover(connector.url, connector.www_authenticate ?? null, door, (origin) => origins.add(origin));
    for (const endpoint of [server.token_endpoint, server.registration_endpoint]) {
      if (endpoint?.startsWith("https://")) origins.add(new URL(endpoint).origin);
    }
    const given = connector.oauth_client;
    // Registered again when the address it comes back to changed.
    const reuse = connector.oauth && connector.oauth.issuer === server.issuer && connector.oauth.redirect_uri === redirectUri && (!given || connector.oauth.client_id === given.client_id);
    const client = given ?? (reuse ? { client_id: connector.oauth!.client_id, client_secret: connector.oauth!.client_secret ?? null } : await register(server, redirectUri, door));
    const oauth: OAuthState = {
      ...(reuse ? connector.oauth! : {}),
      issuer: server.issuer,
      authorization_endpoint: server.authorization_endpoint,
      token_endpoint: server.token_endpoint,
      registration_endpoint: server.registration_endpoint,
      client_id: client.client_id,
      client_secret: client.client_secret ?? null,
      redirect_uri: redirectUri,
      scope: server.scopes.length ? server.scopes.join(" ") : null,
    };
    update(userId, id, (one) => ({ ...one, oauth }));
    const { verifier, challenge } = pkce();
    const state = rememberSignIn(userId, id, verifier);
    return authorizationUrl(oauth, { state, challenge, resource: connector.url });
  } catch (err) {
    if (err instanceof OAuthError) throw new ConnectorError(err.code === "client_id_required" ? "client_id_required" : `sign_in_failed: ${err.message.slice(0, 200)}`, 502);
    throw new ConnectorError(`sign_in_failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`, 502);
  }
}

/// The browser came back with a code: tokens, and the connector started.
export async function completeSignIn(state: string, code: string): Promise<{ userId: string; connector: Connector }> {
  const signIn = takeSignIn(state);
  if (!signIn) throw new ConnectorError("sign_in_expired", 400);
  const connector = stored(signIn.userId, signIn.connectorId);
  if (!connector?.oauth || !connector.url) throw new ConnectorError("not_found", 404);
  const tokens = await exchangeCode(connector.oauth, { code, verifier: signIn.verifier, resource: connector.url }, connectorFetch(connectorOrigins(connector))).catch((err: unknown) => {
    throw new ConnectorError(`sign_in_failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`, 502);
  });
  const signedIn = update(signIn.userId, signIn.connectorId, (one) => ({ ...one, oauth: { ...one.oauth!, ...tokens }, auth_required: false, error: null }));
  stopConnector(signIn.userId, signIn.connectorId);
  return { userId: signIn.userId, connector: signedIn };
}

/// Signed out: the tokens go (the registration stays, for the next sign-in).
export function signOut(userId: string, id: string): Connector {
  stopConnector(userId, id);
  return update(userId, id, (one) => ({ ...one, oauth: one.oauth ? { ...one.oauth, access_token: null, refresh_token: null, expires_at: null } : null }));
}

// ── In the chat ────────────────────────────────────────────────────────

/// A name the model can call: letters, digits, _ and -, 64 at most.
export function chatToolName(connector: Pick<Connector, "name">, tool: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${clean(connector.name).slice(0, 20)}__${clean(tool)}`.slice(0, 64);
}

export interface ConnectorChatTool {
  definition: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
  connectorId: string;
  connectorName: string;
  tool: string;
  /// Allowed once and for all, and it may be (read-only): called without asking.
  always: boolean;
  /// Whether « Toujours autoriser » may be offered when it is asked.
  mayAlways: boolean;
}

/// The tools of the connectors switched on, as the chat offers them: the
/// same from one message to the next (the runtime's cache), MAX_CHAT_TOOLS
/// at most.
export function connectorChatTools(userId: string): ConnectorChatTool[] {
  const out: ConnectorChatTool[] = [];
  for (const connector of listConnectors(userId)) {
    if (!connector.enabled) continue;
    for (const tool of connector.tools) {
      if (connector.disabled_tools.includes(tool.name) || out.length >= MAX_CHAT_TOOLS) continue;
      out.push({
        definition: {
          type: "function",
          function: {
            name: chatToolName(connector, tool.name),
            description: `[${connector.name}] ${tool.description || tool.name}`.slice(0, DESCRIPTION_CHARS),
            parameters: tool.inputSchema,
          },
        },
        connectorId: connector.id,
        connectorName: connector.name,
        tool: tool.name,
        always: alwaysAllowed(connector, tool),
        mayAlways: mayAlwaysAllow(tool),
      });
    }
  }
  return out;
}

/// Calls a connector's tool (started if it is not).
export async function callConnectorTool(userId: string, connectorId: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const { client } = await startConnector(userId, connectorId);
  try {
    return await client.callTool(tool, args);
  } catch (err) {
    // A server that stopped is started again at the next call.
    if (!client.running) stopConnector(userId, connectorId);
    throw err;
  }
}

// ── The person's say, asked in the chat ────────────────────────────────
const APPROVAL_TIMEOUT_MS = 120_000;

/// Who asked: the session whose message made the call (its stream got the
/// question), and whether it is this computer's app.
export interface ApprovalAsker { sessionId: string | null; thisComputersApp: boolean }

const approvals = new Map<string, { userId: string; asker: ApprovalAsker; resolve: (allowed: boolean) => void; timer: NodeJS.Timeout; connectorId?: string; tool?: string }>();

/// Waits for the person to allow or refuse this call (or for the chat to
/// close, or two minutes): refused unless allowed. Answered only by the
/// session that asked, or by this computer's app (answerApproval).
export function waitForApproval(userId: string, id: string, signal: AbortSignal | undefined, asker: ApprovalAsker, timeoutMs = APPROVAL_TIMEOUT_MS, call?: { connectorId: string; tool: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (allowed: boolean) => {
      const entry = approvals.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      approvals.delete(id);
      resolve(allowed);
    };
    approvals.set(id, { userId, asker, resolve: done, timer: setTimeout(() => done(false), timeoutMs), ...call });
    signal?.addEventListener("abort", () => done(false), { once: true });
  });
}

/// The calls waiting for this person's answer (their ids).
export function waitingApprovals(userId: string): string[] {
  return [...approvals].filter(([, entry]) => entry.userId === userId).map(([id]) => id);
}

/// The person's answer; false when nothing waits for it (too late, or not
/// theirs to give). Since the person's own devices ask too (08/10/2026),
/// an answer counts only from the session that asked — the stream that
/// showed the question — or from this computer's app, as before: never
/// from another device of the account (a household member's, one paired
/// by code), nor from another session of the same device, whatever id it
/// sends. « Toujours autoriser » (`always`) allows this call and, from now
/// on, every call of that tool without asking — for a read-only tool only
/// (mayAlwaysAllow): for any other, this call alone is allowed. Null when
/// nothing waits; otherwise whether « always » was kept.
export function answerApproval(userId: string, id: string, allowed: boolean, always: boolean, answerer: ApprovalAsker): { always: boolean } | null {
  const entry = approvals.get(id);
  if (!entry || entry.userId !== userId) return null;
  const sameSession = !!entry.asker.sessionId && entry.asker.sessionId === answerer.sessionId;
  if (!sameSession && !answerer.thisComputersApp) return null;
  let kept = false;
  if (allowed && always && entry.connectorId && entry.tool) {
    const tool = entry.tool;
    try {
      update(userId, entry.connectorId, (connector) => {
        // As listed now, not as it was when the call was asked.
        if (!mayAlwaysAllow(connector.tools.find((one) => one.name === tool))) return connector;
        kept = true;
        return { ...connector, auto_tools: [...new Set([...(connector.auto_tools ?? []), tool])] };
      });
    } catch {
      /* removed meanwhile: this call is still allowed */
    }
  }
  entry.resolve(allowed);
  return { always: kept };
}
