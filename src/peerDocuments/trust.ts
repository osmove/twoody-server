import { and, eq, ne } from "drizzle-orm";
import { accountPeers, authSessions, db } from "../db.js";
import { isPeerSessionKind } from "../auth.js";

// Who may search and read this computer's documents (docs/mesh-design.md
// §1-§2): another computer of the account that this one trusts, asking
// with the `peer:` session it was given here. Nobody else — not the phone
// (it has /local_documents), not a firmware device, not a peer this
// computer does not trust.
//
// The one question every peer document route asks is isTrustedComputer().
// Today it reads the signal this computer has: account_peers.trusted for
// that computer, switched on from « Appareils » (routes/peers.ts). Lot S2
// replaces it with the verified vault roster (src/vault/roster.ts:
// requester_computer_id in the roster the person-devices approved, cached
// 60 s) — then the backend or a switch flipped here alone no longer
// decides. Callers do not change: they keep asking this function.

export type TrustCheck = (requesterComputerId: string) => Promise<boolean>;

/// Today's signal: a peer this computer knows, not removed from the
/// account, and trusted.
const accountPeersTrust: TrustCheck = async (requesterComputerId) => {
  const [peer] = db
    .select({ trusted: accountPeers.trusted })
    .from(accountPeers)
    .where(and(eq(accountPeers.computerId, requesterComputerId), ne(accountPeers.state, "removed")))
    .limit(1)
    .all();
  return peer?.trusted === true;
};

let check: TrustCheck = accountPeersTrust;

export function isTrustedComputer(requesterComputerId: string): Promise<boolean> {
  if (!requesterComputerId) return Promise.resolve(false);
  return check(requesterComputerId);
}

/// For lot S2 (the roster) and for tests: the check every route asks.
/// `null` puts today's back.
export function setTrustCheck(next: TrustCheck | null): void {
  check = next ?? accountPeersTrust;
}

export type PeerCaller = { userId: string; sessionId: string; computerId: string };
/// Said to the caller as « not_trusted » either way (the contract's error,
/// test/fixtures/peer-documents-search.schema.json); `reason` is for logs.
export type PeerRefusal = { status: 403; error: "not_trusted"; reason: "peer_session_required" | "untrusted_computer" };

/// The calling computer, from its session only (never from the body):
/// a `peer:` session given to a computer of the account, which this
/// computer trusts.
export async function trustedPeerCaller(auth: { userId: string; sessionId?: string }): Promise<PeerCaller | PeerRefusal> {
  if (!auth.sessionId) return { status: 403, error: "not_trusted", reason: "peer_session_required" };
  const [session] = db
    .select({ kind: authSessions.clientKind, requesterComputerId: authSessions.requesterComputerId })
    .from(authSessions)
    .where(eq(authSessions.id, auth.sessionId))
    .limit(1)
    .all();
  if (!session || !isPeerSessionKind(session.kind) || !session.requesterComputerId) return { status: 403, error: "not_trusted", reason: "peer_session_required" };
  if (!(await isTrustedComputer(session.requesterComputerId))) return { status: 403, error: "not_trusted", reason: "untrusted_computer" };
  return { userId: auth.userId, sessionId: auth.sessionId, computerId: session.requesterComputerId };
}
