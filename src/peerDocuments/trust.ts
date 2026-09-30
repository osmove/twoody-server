import { eq } from "drizzle-orm";
import { authSessions, db, tunnelPeers } from "../db.js";
import type { FastifyRequest } from "fastify";
import { isPeerSessionKind } from "../auth.js";
import { tunnelPeerKey } from "../sessionTrust.js";
import { tunnelKeyOf } from "../vault/roster.js";

// Who may search and read this computer's documents (docs/mesh-design.md
// §1-§2): another computer of the account in the verified vault roster
// (src/vault/roster.ts, lot S2), asking with the `peer:` session it was
// given here, over the tunnel key its binding names. Nobody else — not the
// phone (it has /local_documents), not a firmware device, not a computer
// the person devices did not vouch for, whatever the backend lists or a
// switch flipped here says (account_peers.trusted no longer counts).
//
// The one question every peer document route asks is isTrustedComputer().

export type TrustCheck = (requesterComputerId: string, context?: { sessionId?: string; tunnelKey?: string }) => Promise<boolean>;

/// The roster's answer: that computer is in it and, when a session asks,
/// the session came with the tunnel key the computer's binding names — a
/// session the account labelled with a roster computer's id but given to
/// another key (another device approved by the console, say) is not it.
/// With `tunnelKey` (the key the tunnel stamped on the request), that key
/// must be the binding's too.
const rosterTrust: TrustCheck = async (requesterComputerId, context) => {
  const key = await tunnelKeyOf(requesterComputerId);
  if (!key) return false;
  if (context?.tunnelKey !== undefined && context.tunnelKey !== key) return false;
  if (!context?.sessionId) return true;
  const keys = db.select({ publicKey: tunnelPeers.publicKey }).from(tunnelPeers).where(eq(tunnelPeers.sessionId, context.sessionId)).all();
  return keys.some((k) => k.publicKey.toLowerCase() === key);
};

let check: TrustCheck = rosterTrust;

export function isTrustedComputer(requesterComputerId: string, context?: { sessionId?: string; tunnelKey?: string }): Promise<boolean> {
  if (!requesterComputerId) return Promise.resolve(false);
  return check(requesterComputerId, context);
}

/// For tests: the check every route asks. `null` puts the roster back.
export function setTrustCheck(next: TrustCheck | null): void {
  check = next ?? rosterTrust;
}

export type PeerCaller = { userId: string; sessionId: string; computerId: string };
/// Said to the caller as « not_trusted » either way (the contract's error,
/// test/fixtures/peer-documents-search.schema.json); `reason` is for logs.
export type PeerRefusal = { status: 403; error: "not_trusted"; reason: "peer_session_required" | "untrusted_computer" | "tunnel_required" };

/// The calling computer, from its session only (never from the body):
/// a `peer:` session given to a computer of the account, which this
/// computer trusts, asking through the sealed tunnel from the very key the
/// session was given to (tunnel/host.ts stamps it on the request). A peer
/// token carried over plain HTTP on the network — sniffed, or replayed by
/// anyone who got it — reaches nothing here.
export async function trustedPeerCaller(auth: { userId: string; sessionId?: string }, req: FastifyRequest): Promise<PeerCaller | PeerRefusal> {
  if (!auth.sessionId) return { status: 403, error: "not_trusted", reason: "peer_session_required" };
  const tunnelKey = tunnelPeerKey(req);
  if (!tunnelKey) return { status: 403, error: "not_trusted", reason: "tunnel_required" };
  const [session] = db
    .select({ kind: authSessions.clientKind, requesterComputerId: authSessions.requesterComputerId })
    .from(authSessions)
    .where(eq(authSessions.id, auth.sessionId))
    .limit(1)
    .all();
  if (!session || !isPeerSessionKind(session.kind) || !session.requesterComputerId) return { status: 403, error: "not_trusted", reason: "peer_session_required" };
  const sessionKeys = db.select({ publicKey: tunnelPeers.publicKey }).from(tunnelPeers).where(eq(tunnelPeers.sessionId, auth.sessionId)).all();
  if (!sessionKeys.some((k) => k.publicKey.toLowerCase() === tunnelKey)) return { status: 403, error: "not_trusted", reason: "tunnel_required" };
  if (!(await isTrustedComputer(session.requesterComputerId, { sessionId: auth.sessionId, tunnelKey }))) return { status: 403, error: "not_trusted", reason: "untrusted_computer" };
  return { userId: auth.userId, sessionId: auth.sessionId, computerId: session.requesterComputerId };
}
