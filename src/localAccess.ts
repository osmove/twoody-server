import type { FastifyReply, FastifyRequest } from "fastify";
import { adminToken, forwardedByProxy, isLoopbackAddress, requireAdminAccess, safeEqual, viaTunnel } from "./adminAccess.js";
import { fromOtherPage } from "./webOrigin.js";

// Routes for this machine's owner at its console (twoody-server login,
// approve, logout) or with the admin token: /account/link, /account/approvals.
//
// A request from the tunnel arrives from 127.0.0.1 too, but comes from a
// paired device elsewhere: the tunnel host marks it (tunnel/host.ts), and
// it is not this machine.
//
// Behind a reverse proxy on the same host every client arrives from
// 127.0.0.1 as well. A request carrying X-Forwarded-For, Forwarded or
// X-Real-IP is taken for one such, not for this machine — which is also
// why a server published through a proxy should be given
// TWOODY_ADMIN_TOKEN: then only the token counts, wherever the request
// comes from (a proxy that strips these headers would otherwise open the
// console's routes to the world).
//
// Nor is a request a browser sent from a web page (webOrigin.ts): any
// site open in the person's browser can send one to 127.0.0.1. The
// console, the CLI and the Desktop's main process send no Origin and no
// Sec-Fetch-Site; a page other than this server's own always does.

export function fromThisMachine(req: FastifyRequest): boolean {
  return isLoopbackAddress(req.ip) && !viaTunnel(req) && !forwardedByProxy(req) && !fromOtherPage(req);
}

/// Whether the request may act as the owner. Without an admin token only
/// this machine may; with one, as for /admin, the token is required.
export function ownerRequest(req: FastifyRequest): boolean {
  const token = adminToken();
  if (!token) return fromThisMachine(req);
  const authorization = req.headers.authorization;
  const given = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : req.headers["x-admin-token"];
  return typeof given === "string" && safeEqual(given, token);
}

/// Replies 403 (or what requireAdminAccess replies) when it is not the owner.
export function requireOwner(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!adminToken()) {
    if (fromThisMachine(req)) return true;
    reply.code(403).send({ error: "local_only", message: "Only this machine, or the admin token, may do this." });
    return false;
  }
  return requireAdminAccess(req, reply);
}
