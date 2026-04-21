import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  authSessions,
  users,
  pairingCodes,
} from "../db.js";
import {
  authenticate,
  generateId,
  generateToken,
  sha256,
  getActivePairingCode,
  ensureDefaultUser,
} from "../auth.js";

export async function sessionRoutes(app: FastifyInstance) {
  // POST /session/cli — pair a CLI client with a 6-digit code
  app.post<{ Body: { code: string } }>("/session/cli", {
    schema: {
      body: {
        type: "object",
        required: ["code"],
        properties: { code: { type: "string" } },
      },
    },
    handler: async (req, reply) => {
      const { code } = req.body;

      // Accept: active env-var code OR a stored pairing_codes row
      const activeCode = getActivePairingCode();
      let userId: string;

      if (activeCode && code === activeCode) {
        userId = ensureDefaultUser();
      } else {
        // Look up stored code
        const [row] = db
          .select()
          .from(pairingCodes)
          .where(eq(pairingCodes.code, code))
          .limit(1)
          .all();

        if (!row || row.claimedAt || !row.userId) {
          return reply.code(422).send({ error: "Invalid or expired code" });
        }

        const now = new Date();
        if (row.expiresAt < now) {
          return reply.code(422).send({ error: "Code expired" });
        }

        userId = row.userId;
        db.update(pairingCodes)
          .set({ claimedAt: now, claimedBy: "cli" })
          .where(eq(pairingCodes.code, code))
          .run();
      }

      const token = generateToken();
      const sessionId = generateId();
      db.insert(authSessions)
        .values({
          id: sessionId,
          userId,
          tokenDigest: sha256(token),
          clientKind: "cli",
          createdAt: new Date(),
          expiresAt: null,
        })
        .run();

      reply.send({ token, user_id: userId, session_id: sessionId });
    },
  });

  // GET /session/me — verify current token
  app.get("/session/me", async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth) return reply.code(401).send({ error: "Unauthorized" });

    const [user] = db
      .select()
      .from(users)
      .where(eq(users.id, auth.userId))
      .limit(1)
      .all();

    if (!user) return reply.code(401).send({ error: "User not found" });

    reply.send({ id: user.id, email: user.email, name: user.name });
  });

  // DELETE /session — revoke current token
  app.delete("/session", async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth) return reply.code(401).send({ error: "Unauthorized" });

    db.delete(authSessions)
      .where(eq(authSessions.id, auth.sessionId))
      .run();

    reply.send({ ok: true });
  });
}
