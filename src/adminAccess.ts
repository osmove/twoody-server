import { createHash, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import { allowSecretAttempt } from "./rateLimit.js";
import { VIA_TUNNEL_HEADER } from "./tunnel/host.js";
import { fromOtherPage } from "./webOrigin.js";

// Who may open `/admin`.
//
//   - No TWOODY_ADMIN_TOKEN: only requests from this machine. That is
//     the desktop-embedded case, where nothing should answer the LAN.
//   - TWOODY_ADMIN_TOKEN set: every request needs it, loopback included,
//     so a reverse proxy on the same host (where every client looks
//     local) cannot open the page to the world. A browser passes it
//     once as `/admin?token=…`; the server answers with an HttpOnly
//     cookie and a redirect, which keeps the token out of the address
//     bar, the history and the page's 10-second auto-refresh.
//
// Requests a browser sent from another page (another Origin, or
// Sec-Fetch-Site other than none / same-origin) are refused outright,
// token or not (webOrigin.ts). And what arrived through the tunnel — the
// relay's or the LAN's /tunnel, a paired phone or another computer of the
// account — comes from 127.0.0.1 but is not this machine: without the
// token, it is refused like any other device.

const COOKIE_NAME = "twoody_admin";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

export function isLoopbackAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const candidate = mapped ? mapped[1] : address;
  const family = isIP(candidate);
  if (family === 0) return false;
  return loopback.check(candidate, family === 4 ? "ipv4" : "ipv6");
}

export function adminToken(): string | null {
  const token = process.env.TWOODY_ADMIN_TOKEN?.trim();
  return token ? token : null;
}

/// Returns true when the request may see the admin page. Otherwise the
/// reply (401 / 403 / 429, or the post-login redirect) has been sent.
export function requireAdminAccess(req: FastifyRequest, reply: FastifyReply): boolean {
  if (fromOtherPage(req)) {
    reply.code(403).send({ error: "cross_site_forbidden" });
    return false;
  }

  const token = adminToken();
  if (!token) {
    // A reverse proxy on this host makes every client look local: a
    // request it forwarded is not this machine's. Nor is one the tunnel
    // served.
    if (isLoopbackAddress(req.ip) && !forwardedByProxy(req) && !viaTunnel(req)) return true;
    reply.code(403).send({
      error: "admin_local_only",
      message: "The admin page is only served to the machine running Twoody Server. " +
        "Set TWOODY_ADMIN_TOKEN to open it from another device.",
    });
    return false;
  }

  const fromQuery = (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof fromQuery === "string" && fromQuery) {
    if (!safeEqual(fromQuery, token)) return refuse(req, reply);
    reply
      .code(303)
      .header(
        "Set-Cookie",
        `${COOKIE_NAME}=${cookieValue(token)}; Path=/admin; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict`,
      )
      .header("Location", "/admin")
      .send();
    return false;
  }

  const authorization = headerValue(req.headers.authorization);
  const fromHeader = authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : headerValue(req.headers["x-admin-token"]);
  if (fromHeader) {
    return safeEqual(fromHeader, token) ? true : refuse(req, reply);
  }

  const fromCookie = readCookie(headerValue(req.headers.cookie), COOKIE_NAME);
  if (fromCookie) {
    return safeEqual(fromCookie, cookieValue(token)) ? true : refuse(req, reply);
  }

  reply.code(401).send({
    error: "admin_token_required",
    message: "Open /admin?token=<TWOODY_ADMIN_TOKEN> once, or send it as a Bearer token.",
  });
  return false;
}

// Only failures count against the limit: the page refreshes itself
// every 10 seconds, which a per-request counter would soon lock out.
function refuse(req: FastifyRequest, reply: FastifyReply): false {
  if (allowSecretAttempt(req, reply, "admin")) {
    reply.code(401).send({ error: "invalid_admin_token" });
  }
  return false;
}

// The cookie holds a digest so the token itself is not kept in the browser.
function cookieValue(token: string): string {
  return createHash("sha256").update(`twoody-admin:${token}`).digest("hex");
}

/// Compared in constant time: both sides are hashed first, so neither the
/// content nor the length of the secret shows in how long it takes.
export function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest) && left === right;
}

/// Whether the tunnel served this request (tunnel/host.ts marks every one,
/// whatever the other end sent).
export function viaTunnel(req: FastifyRequest): boolean {
  return req.headers[VIA_TUNNEL_HEADER] !== undefined;
}

/// Whether a proxy says it forwarded the request (X-Forwarded-For,
/// Forwarded, X-Real-IP): then 127.0.0.1 is the proxy, not the client.
export function forwardedByProxy(req: FastifyRequest): boolean {
  return ["x-forwarded-for", "forwarded", "x-real-ip"].some((name) => req.headers[name] !== undefined);
}

function headerValue(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return (Array.isArray(value) ? value[0] : value)?.trim() || null;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}
