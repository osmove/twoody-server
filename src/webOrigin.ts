import { isIP } from "node:net";
import { hostname as osHostname } from "node:os";
import type { FastifyReply, FastifyRequest } from "fastify";

// What a web page open in the person's browser may do to this server.
//
// A page on any site can send requests to http://127.0.0.1:<port>, and
// with DNS rebinding it can even make them same-origin: evil.example
// resolves to 127.0.0.1 a moment after the page loaded. Three checks keep
// such a page out:
//
//   1. the Host header (hostGuard, every request): only the names this
//      server may be reached by — its addresses, localhost, the names of
//      the local network (single-label, .local, .lan, .home.arpa…), this
//      machine's own name, TWOODY_PUBLIC_URL and TWOODY_ALLOWED_HOSTS. A
//      rebinding page always sends its own domain; an IP address is never
//      one (the page's origin would then be that address, not a site
//      pretending to be it), so every address is accepted, which is what
//      Docker's port mapping and a LAN IP typed by hand need;
//   2. CORS (corsOriginAllowed): answers are readable only by the Desktop's
//      window and by pages served from this machine (dev servers), not by
//      any site;
//   3. the routes that trust this machine's own requests
//      (localAccess.ts, /admin) never trust one a browser sent from another
//      page (fromOtherPage): the owner's console, curl and the Desktop's
//      main process send no Origin and no Sec-Fetch-Site.

/// Hostnames of the local network that no one on the internet can make a
/// browser resolve (they are not in public DNS).
const LOCAL_SUFFIXES = [".localhost", ".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain"];

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/// The name in a Host header, without its port or IPv6 brackets.
export function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : value;
  }
  // "a:b:c" with no brackets is a bare IPv6 address, not host:port.
  if (value.split(":").length > 2) return value;
  return normalizeHost(value.replace(/:\d*$/, ""));
}

function configuredHosts(): string[] {
  const names: string[] = [];
  const publicUrl = process.env.TWOODY_PUBLIC_URL?.trim();
  if (publicUrl) {
    try {
      names.push(normalizeHost(new URL(publicUrl).hostname.replace(/^\[|\]$/g, "")));
    } catch {
      // not a URL: nothing to add
    }
  }
  for (const entry of (process.env.TWOODY_ALLOWED_HOSTS ?? "").split(",")) {
    const name = normalizeHost(entry);
    if (name) names.push(name);
  }
  return names;
}

function machineNames(): string[] {
  const names = new Set<string>();
  for (const value of [osHostname(), process.env.HOSTNAME]) {
    if (!value) continue;
    const name = normalizeHost(value);
    names.add(name);
    const short = name.split(".")[0];
    if (short) {
      names.add(short);
      names.add(`${short}.local`);
    }
  }
  return [...names];
}

/// Whether this server answers to that Host header.
export function isAllowedHost(hostHeader: string | undefined): boolean {
  // HTTP/1.0 and some tools send none; no browser does.
  if (hostHeader === undefined || hostHeader.trim() === "") return true;
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (isIP(name) !== 0) return true;
  if (name === "localhost") return true;
  if (!name.includes(".")) return true;
  if (LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if (machineNames().includes(name)) return true;
  for (const allowed of configuredHosts()) {
    if (allowed === "*") return true;
    if (allowed === name) return true;
    // ".example.com" allows every name under it.
    if (allowed.startsWith(".") && name.endsWith(allowed)) return true;
  }
  return false;
}

const warned = new Set<string>();

/// Fastify onRequest hook: 421 for a Host this server does not go by.
export async function hostGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const host = headerValue(req.headers.host);
  if (isAllowedHost(host ?? undefined)) return;
  const name = hostnameOf(host ?? "");
  if (!warned.has(name) && warned.size < 100) {
    warned.add(name);
    req.log.warn(`Refused a request for the host "${name}". If this server is reached by that name, add it to TWOODY_ALLOWED_HOSTS (or TWOODY_PUBLIC_URL).`);
  }
  await reply.code(421).send({
    error: "host_not_allowed",
    message: "This Twoody server does not answer to that name. Add it to TWOODY_ALLOWED_HOSTS on the server if it should.",
  });
}

/// The origins whose pages may read this server's answers (CORS):
///
///   - "null": Twoody Desktop's window, loaded from a file (file://) —
///     which is also what a sandboxed frame sends, so a page could read the
///     answers to what it may ask without a token (/health, the network's
///     view of /account/link) and nothing more. Until the Desktop serves
///     its window from its own scheme (app://twoody, accepted here);
///   - pages served from this machine over http (the Desktop's and the
///     app's development servers, e.g. http://127.0.0.1:5173,
///     http://localhost:8081);
///   - TWOODY_CORS_ORIGINS, comma-separated, exactly as the browser sends them.
const APP_ORIGINS = new Set(["null", "app://twoody"]);

export function corsOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (APP_ORIGINS.has(origin)) return true;
  const extra = (process.env.TWOODY_CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  if (extra.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/// Whether a browser sent this request from a page that is not this
/// server's own: an Origin other than this server's, or Sec-Fetch-Site
/// other than « none » (typed in the address bar) or « same-origin ». Such a
/// request never counts as this machine's, whatever address it comes from.
export function fromOtherPage(req: FastifyRequest): boolean {
  const fetchSite = headerValue(req.headers["sec-fetch-site"]);
  if (fetchSite && fetchSite !== "none" && fetchSite !== "same-origin") return true;
  const origin = headerValue(req.headers.origin);
  if (origin === null) return false;
  const host = headerValue(req.headers.host);
  if (!host) return true;
  // The server's own pages (/admin, /docs) are served over http only.
  return origin.toLowerCase() !== `http://${host.toLowerCase()}`;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? null : first.trim();
}
