import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

// Single gate for every outbound HTTP call the server makes.
//
// With TWOODY_LOCAL_ONLY=1 the server may only talk to this machine and
// to private-network hosts (a local LLM runtime, Home Assistant on the
// LAN, another box on the user's tailnet). Anything else — cloud LLMs,
// OpenAI Realtime, Spotify, an upstream Twoody backend — is refused
// here, whatever the rest of the configuration says. Clients read the
// flag from `/capabilities` and `/deployment` to show a truthful
// "local only" state.
//
// `test/outbound.test.ts` fails if a bare `fetch(` appears anywhere else
// in `src/`, so a new call site cannot bypass the gate by accident.

export const LOCAL_ONLY = ["1", "true"].includes(
  (process.env.TWOODY_LOCAL_ONLY ?? "").trim().toLowerCase(),
);

export class LocalOnlyError extends Error {
  constructor(host: string) {
    super(`Blocked by local-only mode: ${host} is not on this machine or a private network`);
    this.name = "LocalOnlyError";
  }
}

const privateRanges = new BlockList();
privateRanges.addSubnet("127.0.0.0", 8, "ipv4");
privateRanges.addSubnet("10.0.0.0", 8, "ipv4");
privateRanges.addSubnet("172.16.0.0", 12, "ipv4");
privateRanges.addSubnet("192.168.0.0", 16, "ipv4");
privateRanges.addSubnet("169.254.0.0", 16, "ipv4");
// Carrier-grade NAT space, which is where Tailscale addresses live.
privateRanges.addSubnet("100.64.0.0", 10, "ipv4");
privateRanges.addAddress("::1", "ipv6");
privateRanges.addSubnet("fc00::", 7, "ipv6");
privateRanges.addSubnet("fe80::", 10, "ipv6");

export function isPrivateAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const candidate = mapped ? mapped[1] : address;
  const family = isIP(candidate);
  if (family === 0) return false;
  return privateRanges.check(candidate, family === 4 ? "ipv4" : "ipv6");
}

/// True when every address the URL's host resolves to is loopback or
/// private. A name that does not resolve is treated as not private.
export async function isPrivateUrl(url: string | URL): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (hostname === "localhost") return true;
  if (isIP(hostname) !== 0) return isPrivateAddress(hostname);
  try {
    const addresses = await lookup(hostname, { all: true });
    return addresses.length > 0 && addresses.every((entry) => isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

export async function outboundFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  // Judged by where it goes; sent as it came, method and body included.
  const href = url instanceof Request ? url.url : url;
  if (LOCAL_ONLY && !(await isPrivateUrl(href))) {
    let host = String(href);
    try {
      host = new URL(href).host;
    } catch {
      // Keep the raw value in the message.
    }
    throw new LocalOnlyError(host);
  }
  return fetch(url, init);
}

// The one door local-only mode has, and only for the tunnel.
//
// Local-only promises that nothing readable leaves this machine. The
// tunnel keeps that promise — every frame is sealed with keys only the
// two paired devices hold, and the relay carries bytes it cannot open —
// but it cannot keep it without reaching one outside address: a
// computer at home has no port anyone can call, so it has to go and
// fetch what its phone left at the relay.
//
// So the gate gets exactly one door, as narrow as the transport allows:
// the relay's origin, the single path the transport uses, and nothing
// else. A different path on the same host, a look-alike host, another
// port — all go through the ordinary gate and are refused there. And the
// door does not open over cleartext to anything outside the private
// network, in any mode: the account token rides in a header beside the
// sealed frames, and it is not sealed.

/// The only path the tunnel's transport asks of the relay
/// (relayTransport.ts), under the relay's own base path.
export const RELAY_FRAMES_PATH = "/api/v1/tunnel/frames";
/// And, for the relay over a WebSocket (tunnel/cableLink.ts): the
/// single-use ticket the socket is opened with, and the socket itself.
export const RELAY_TICKETS_PATH = "/api/v1/cable/tickets";
export const RELAY_SOCKET_PATH = "/cable";

export class RelayRefusedError extends Error {
  constructor(reason: string) {
    super(`Refused on the way to the relay: ${reason}`);
    this.name = "RelayRefusedError";
  }
}

/// A fetch for the tunnel: the relay's frames endpoint goes through the
/// door, everything else through `outboundFetch` as usual.
export function relayFetch(relayUrl: string | URL): typeof fetch {
  const relay = new URL(relayUrl);
  const root = relay.pathname.replace(/\/+$/, "");
  const doors = new Set([`${root}${RELAY_FRAMES_PATH}`, `${root}${RELAY_TICKETS_PATH}`]);

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let target: URL | null = null;
    try {
      target = new URL(input instanceof Request ? input.url : input);
    } catch {
      // Not a URL: the ordinary gate will say so.
    }

    // The parser has already resolved "..", "%2e%2e" and the like, so
    // an exact comparison is a comparison of where the request really
    // goes, not of how it was spelled.
    if (target && target.origin === relay.origin && doors.has(target.pathname)) {
      if (target.protocol !== "https:" && !(await isPrivateUrl(target))) {
        throw new RelayRefusedError(`${target.host} is outside the private network and not reached over HTTPS`);
      }
      // Never followed: a redirect would send this request — account token
      // in its headers — wherever the relay pointed, past the check above.
      // The door is checked on the address asked for, so that has to be
      // the only address reached.
      return fetch(input, { ...init, redirect: "error" });
    }
    return outboundFetch(input, init);
  }) as typeof fetch;
}

/// The relay's WebSocket for `ticket`, or null where the door stays shut:
/// same origin as the relay, and over TLS unless the relay is on the
/// private network — as for its frames.
export async function relaySocketUrl(relayUrl: string | URL, ticket: string): Promise<URL | null> {
  const relay = new URL(relayUrl);
  if (relay.protocol !== "https:" && !(await isPrivateUrl(relay))) return null;
  const socket = new URL(`${relay.pathname.replace(/\/+$/, "")}${RELAY_SOCKET_PATH}`, relay);
  socket.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
  socket.searchParams.set("ticket", ticket);
  return socket;
}

// The door for connectors (Capacités → Connecteurs, 03/10/2026): the
// services the person added themselves — the address of each, and the
// sign-in service that address names (connectors/oauth.ts) — reached over
// https, never redirected elsewhere. Asked for by the person, as a model's
// download is: made in local-only mode too, to those origins only.
export function connectorFetch(origins: Iterable<string>): typeof outboundFetch {
  const allowed = new Set([...origins].filter(Boolean));
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let target: URL | null = null;
    try {
      target = new URL(input instanceof Request ? input.url : input);
    } catch {
      // Not a URL: the ordinary gate will say so.
    }
    if (target && allowed.has(target.origin) && (target.protocol === "https:" || (await isPrivateUrl(target)))) {
      return fetch(input, { ...init, redirect: "error" });
    }
    return outboundFetch(input, init);
  };
}

// The door for e-mail (Capacités → E-mails, 04/10/2026). IMAP is no HTTP:
// the gate above never sees it, so the one place that opens a connection
// to a mail server (src/email/imap.ts, test/emailDoor.test.ts keeps it the
// only one) asks this first. It opens only while E-mails is on, only
// towards the server the person set up themselves — its host and its port,
// exactly — and only over TLS; in clear to this machine alone (Proton Mail
// Bridge listens on 127.0.0.1). Asked for by the person when they set up
// their mailbox, as a connector is: made in local-only mode too.

export type MailSecurity = "tls" | "starttls";

export interface MailServer {
  host: string;
  port: number;
  security: MailSecurity;
}

export type MailDoorReason = "email_off" | "not_configured" | "invalid_server" | "other_server" | "tls_required";

export class MailDoorClosedError extends Error {
  constructor(public reason: MailDoorReason) {
    super(`Refused on the way to the mail server: ${reason}`);
    this.name = "MailDoorClosedError";
  }
}

const loopbackRanges = new BlockList();
loopbackRanges.addSubnet("127.0.0.0", 8, "ipv4");
loopbackRanges.addAddress("::1", "ipv6");

/// A host as compared: lower case, without an IPv6 literal's brackets or a
/// trailing dot.
export function mailHostKey(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

/// A name or an address, nothing else (no scheme, path, user or space).
export function validMailHost(host: string): boolean {
  const key = mailHostKey(host);
  if (isIP(key) !== 0) return true;
  return key.length > 0 && key.length <= 253 && key.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/// This machine only: 127.0.0.0/8, ::1, localhost.
export function isLoopbackHost(host: string): boolean {
  const key = mailHostKey(host);
  if (key === "localhost") return true;
  const mapped = key.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1] ?? key;
  const family = isIP(mapped);
  return family !== 0 && loopbackRanges.check(mapped, family === 4 ? "ipv4" : "ipv6");
}

/// Throws unless a connection to `target` may be opened now: E-mails on,
/// a server set up by the person, this one, over TLS.
export function mailServerDoor(target: MailServer, configured: { host: string; port: number } | null, emailOn: boolean): void {
  if (!emailOn) throw new MailDoorClosedError("email_off");
  if (!configured) throw new MailDoorClosedError("not_configured");
  if (!validMailHost(target.host) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65_535) throw new MailDoorClosedError("invalid_server");
  if (mailHostKey(target.host) !== mailHostKey(configured.host) || target.port !== configured.port) throw new MailDoorClosedError("other_server");
  if (target.security !== "tls" && !isLoopbackHost(target.host)) throw new MailDoorClosedError("tls_required");
}

// And for Microsoft's sign-in (src/microsoft/token.ts), renewed at its token
// endpoint — that address and no other (no other path of the host, no other
// host), over https, never redirected — for one of two grants, each with its
// own life: a mailbox linked with Microsoft's sign-in by Twoody 0.13.76 and
// read over IMAP (src/email/microsoft.ts), only while E-mails is on and the
// mailbox set up, or being set up, is one; and the link to Microsoft Graph
// (src/microsoft/), only while a capability that reads Graph is on and the
// link is kept, or being made. Made in local-only mode too, as the
// connection to the mail server.

/// The one address this door opens to.
export const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/// The capabilities that read Microsoft Graph (ids of src/localCapabilities.ts):
/// Agenda, Contacts and E-mails. Each declares its paths below (GRAPH_PATHS)
/// and its permissions in src/microsoft/link.ts (GRAPH_SCOPES).
export type GraphCapability = "calendar" | "contacts" | "email";

/// The capabilities that read Graph, each on or off, as they stand now.
export type GraphCapabilitiesOn = Partial<Record<GraphCapability, boolean>>;

/// Whose sign-in is renewed: the mailbox's, or the link to Graph.
export type MicrosoftTokenDoorState =
  | { microsoftMailbox: boolean; emailOn: boolean }
  | { graphLinked: boolean; capabilitiesOn: GraphCapabilitiesOn };

/// Throws unless Microsoft's token endpoint may be called now for this
/// grant, at that address exactly.
export function microsoftTokenDoor(target: string | URL, door: MicrosoftTokenDoorState): void {
  if ("emailOn" in door) {
    if (!door.emailOn) throw new MailDoorClosedError("email_off");
    if (!door.microsoftMailbox) throw new MailDoorClosedError("not_configured");
  } else {
    if (!Object.values(door.capabilitiesOn).some((on) => on === true)) throw new GraphDoorClosedError("capability_off");
    if (!door.graphLinked) throw new GraphDoorClosedError("not_linked");
  }
  let url: URL | null = null;
  try {
    url = new URL(target);
  } catch {
    // Not a URL: refused below.
  }
  // Compared once parsed: a port, a user, a query or another path is
  // another address; « .. » and the case of the host are not.
  if (!url || url.href !== MICROSOFT_TOKEN_URL) throw "emailOn" in door ? new MailDoorClosedError("other_server") : new GraphDoorClosedError("other_address");
}

/// A request to Microsoft's token endpoint, through that door.
export async function microsoftTokenFetch(target: string | URL, init: RequestInit, door: MicrosoftTokenDoorState): Promise<Response> {
  microsoftTokenDoor(target, door);
  // Never followed: the refresh token in the body would go wherever a
  // redirect pointed.
  return fetch(target, { ...init, redirect: "error" });
}

// The door for Microsoft Graph (04/10/2026), with the link's access token:
// to https://graph.microsoft.com/v1.0/me/ and, below it, the paths each
// capability that reads Graph declares here, with what may be done there —
// Agenda the calendars and each one's view (a repeating event there once per
// occurrence), Contacts the contacts and their folders, both read only;
// E-mails the Inbox, Sent Items and Drafts folders, the changes of the two
// read (delta), a message's attachments' names, and one write: a draft,
// created in Drafts — never sent, changed, moved or deleted — never
// redirected, only while that capability is on and the link is kept. The
// pages Graph links to (@odata.nextLink, @odata.deltaLink) go through it
// like the first. A capability that comes to read Graph adds its paths
// here, and its permissions to src/microsoft/link.ts. Asked for by the
// person when they link their account, as the mail server is: made in
// local-only mode too.

export const GRAPH_ORIGIN = "https://graph.microsoft.com";
/// Where every address this door opens starts.
export const GRAPH_ME = `${GRAPH_ORIGIN}/v1.0/me`;

export type GraphDoorReason = "capability_off" | "not_linked" | "other_address" | "method_not_allowed";

export class GraphDoorClosedError extends Error {
  constructor(public reason: GraphDoorReason) {
    super(`Refused on the way to Microsoft Graph: ${reason}`);
    this.name = "GraphDoorClosedError";
  }
}

/// The paths opened below /v1.0/me, by the capability each serves, and what
/// may be done there. An id is one segment; Graph does not mind the case of
/// the rest.
const GRAPH_PATHS: Record<GraphCapability, ReadonlyArray<{ path: RegExp; methods: readonly string[] }>> = {
  calendar: [
    { path: /^\/calendars$/i, methods: ["GET"] },
    { path: /^\/calendars\/[^/]+\/calendarView$/i, methods: ["GET"] },
  ],
  contacts: [
    { path: /^\/contacts$/i, methods: ["GET"] },
    { path: /^\/contactFolders$/i, methods: ["GET"] },
    { path: /^\/contactFolders\/[^/]+\/contacts$/i, methods: ["GET"] },
  ],
  email: [
    // The three folders Twoody uses, by their well-known names.
    { path: /^\/mailFolders\/(?:inbox|sentitems|drafts)$/i, methods: ["GET"] },
    // A folder's changes: the first page asked by the folder's id, the next
    // ones as Graph writes them (`mailfolders('…')`, its quotes as they come).
    { path: /^\/mailFolders(?:\/[^/()']+|\((?:'|%27)[^/()']+(?:'|%27)\))\/messages\/delta$/i, methods: ["GET"] },
    // What a message's attachments are called, their type and size.
    { path: /^\/messages\/[^/()']+\/attachments$/i, methods: ["GET"] },
    // A draft, created in Drafts: the only write, and never a send.
    { path: /^\/messages$/i, methods: ["POST"] },
  ],
};

/// What the door opens to at a Graph address — the capability it serves,
/// what may be done there — or null: another origin (scheme, host, port), a
/// user in it, a path no capability declares. Judged once parsed, « .. »
/// resolved.
export function graphRoute(target: string | URL): { capability: GraphCapability; methods: readonly string[] } | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.origin !== GRAPH_ORIGIN || url.username || url.password) return null;
  const root = "/v1.0/me/";
  if (url.pathname.slice(0, root.length).toLowerCase() !== root) return null;
  const rest = url.pathname.slice(root.length - 1);
  // No slash, backslash or dot hidden in an id, to be read as a path there.
  if (/%2f|%5c|%2e|\\/i.test(rest)) return null;
  for (const [capability, routes] of Object.entries(GRAPH_PATHS) as Array<[GraphCapability, (typeof GRAPH_PATHS)[GraphCapability]]>) {
    const route = routes.find((one) => one.path.test(rest));
    if (route) return { capability, methods: route.methods };
  }
  return null;
}

/// Throws unless this request may go to Graph now: an address the door
/// opens, what may be done there, the capability it serves on, the link
/// kept. Says which capability it serves.
export function graphDoor(target: string | URL, method: string | undefined, door: { linked: boolean; capabilitiesOn: GraphCapabilitiesOn }): GraphCapability {
  const route = graphRoute(target);
  if (!route) throw new GraphDoorClosedError("other_address");
  if (!route.methods.includes((method ?? "GET").toUpperCase())) throw new GraphDoorClosedError("method_not_allowed");
  if (door.capabilitiesOn[route.capability] !== true) throw new GraphDoorClosedError("capability_off");
  if (!door.linked) throw new GraphDoorClosedError("not_linked");
  return route.capability;
}

/// A request to Microsoft Graph, through that door.
export async function graphFetch(target: string | URL, init: RequestInit, door: { linked: boolean; capabilitiesOn: GraphCapabilitiesOn }): Promise<Response> {
  graphDoor(target, init.method, door);
  // Never followed: the access token in its headers would go wherever a
  // redirect pointed.
  return fetch(target, { ...init, redirect: "error" });
}
