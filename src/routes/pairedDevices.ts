import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { authenticate, isPeerSessionKind } from "../auth.js";
import { authSessions, db, tunnelPeers } from "../db.js";
import { forgetTunnelPeer, forgetTunnelPeersOfSession } from "../tunnel/identity.js";
import { tunnelPeersChanged } from "../tunnel/index.js";

// The devices paired with this computer — the phone that scanned its QR
// code, another computer — and a way to remove one: its session goes, and
// so does the key it would reach this computer with from outside.
//
// Twoody Desktop lists them in its settings. Before this there was no way
// to undo a pairing short of the device signing itself out, and even then
// this computer kept waiting for it at the relay.

const PAIRED = "pair:";
const KEY_ID = /^key:([0-9a-f]{64})$/;

export async function pairedDeviceRoutes(app: FastifyInstance) {
  app.get("/paired_devices", {
    schema: {
      tags: ["session"],
      summary: "Devices paired with this computer",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      // The session too, to tell this device from the others.
      const auth = await authenticate(req);
      if (!auth) return reply.code(401).send({ error: "Unauthorized" });
      const all = db.select().from(authSessions).where(eq(authSessions.userId, auth.userId)).all();
      const sessions = all.filter((session) => session.clientKind.startsWith(PAIRED));
      // Another computer's key goes with its peer session: not a device,
      // and not a key left from before sessions and keys were linked.
      const peerSessionIds = new Set(all.filter((session) => isPeerSessionKind(session.clientKind)).map((session) => session.id));
      const peers = db.select().from(tunnelPeers).where(eq(tunnelPeers.userId, auth.userId)).all();
      const sessionIds = new Set(sessions.map((session) => session.id));

      const devices = sessions.map((session) => {
        const peer = peers.find((candidate) => candidate.sessionId === session.id);
        return {
          id: session.id,
          name: session.clientKind.slice(PAIRED.length) || null,
          paired_at: session.createdAt.toISOString(),
          this_device: session.id === auth.sessionId,
          reachable_from_outside: Boolean(peer),
          last_seen_at: peer?.lastSeenAt?.toISOString() ?? null,
        };
      });
      // Keys paired before sessions and keys were linked: listed so they
      // can be removed too.
      for (const peer of peers) {
        if (peer.sessionId && (sessionIds.has(peer.sessionId) || peerSessionIds.has(peer.sessionId))) continue;
        devices.push({
          id: `key:${peer.publicKey}`,
          name: peer.name,
          paired_at: peer.pairedAt.toISOString(),
          this_device: false,
          reachable_from_outside: true,
          last_seen_at: peer.lastSeenAt?.toISOString() ?? null,
        });
      }
      // This device first, then the most recently paired.
      devices.sort((a, b) => Number(b.this_device) - Number(a.this_device) || b.paired_at.localeCompare(a.paired_at));
      reply.send({ devices });
    },
  });

  app.delete<{ Params: { id: string } }>("/paired_devices/:id", {
    schema: {
      tags: ["session"],
      summary: "Remove a paired device: its session and its tunnel key",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    handler: async (req, reply) => {
      // The session too, to tell this device from the others.
      const auth = await authenticate(req);
      if (!auth) return reply.code(401).send({ error: "Unauthorized" });
      const key = KEY_ID.exec(req.params.id);
      if (key) {
        const known = db
          .select()
          .from(tunnelPeers)
          .where(and(eq(tunnelPeers.publicKey, key[1]!), eq(tunnelPeers.userId, auth.userId)))
          .all();
        if (known.length === 0) return reply.code(404).send({ error: "not_found" });
        forgetTunnelPeer({ userId: auth.userId, publicKey: Buffer.from(key[1]!, "hex") });
        tunnelPeersChanged();
        return reply.code(204).send();
      }
      if (req.params.id === auth.sessionId) {
        // Signing this device out is DELETE /session.
        return reply.code(409).send({ error: "this_device" });
      }
      const [session] = db
        .select()
        .from(authSessions)
        .where(and(eq(authSessions.id, req.params.id), eq(authSessions.userId, auth.userId)))
        .all();
      // A peer session (`peer:`, given to another computer of the account)
      // is not listed here but can be removed the same way: Twoody Desktop
      // does when that computer leaves the account.
      if (!session || !(session.clientKind.startsWith(PAIRED) || isPeerSessionKind(session.clientKind))) return reply.code(404).send({ error: "not_found" });
      db.delete(authSessions).where(eq(authSessions.id, session.id)).run();
      if (forgetTunnelPeersOfSession(session.id) > 0) tunnelPeersChanged();
      reply.code(204).send();
    },
  });
}
