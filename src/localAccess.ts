import type { FastifyReply, FastifyRequest } from "fastify";
import { adminToken, isLoopbackAddress, requireAdminAccess } from "./adminAccess.js";
import { VIA_TUNNEL_HEADER } from "./tunnel/host.js";

// Routes for this machine's owner at its console (twoody-server login,
// approve, logout) or with the admin token: /account/link, /account/approvals.
//
// A request from the tunnel arrives from 127.0.0.1 too, but comes from a
// paired device elsewhere: the tunnel host marks it (tunnel/host.ts), and
// it is not this machine.

export function fromThisMachine(req: FastifyRequest): boolean {
  return isLoopbackAddress(req.ip) && req.headers[VIA_TUNNEL_HEADER] === undefined;
}

/// Whether the request may act as the owner. Without an admin token only
/// this machine may; with one, as for /admin, the token is required.
export function ownerRequest(req: FastifyRequest): boolean {
  if (!adminToken()) return fromThisMachine(req);
  const authorization = req.headers.authorization;
  const given = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : req.headers["x-admin-token"];
  return typeof given === "string" && given === adminToken();
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
