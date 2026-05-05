import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  db,
  authSessions,
  users,
  pairingCodes,
} from "../db.js";
import {
  authenticate,
  generateId,
  getActivePairingCode,
  normalizePairingCode,
  isValidPairingCode,
  verifySetupToken,
  hashPassword,
  verifyPassword,
  createAuthSession,
} from "../auth.js";

export async function sessionRoutes(app: FastifyInstance) {
  app.post<{
    Body: {
      email?: string;
      password?: string;
      name?: string;
      setup_token?: string;
    };
  }>("/auth/signup", {
    schema: {
      tags: ["session"],
      summary: "Create the first local Server account with the setup token",
      body: {
        type: "object",
        required: ["email", "password", "setup_token"],
        properties: {
          email: { type: "string" },
          password: { type: "string" },
          name: { type: "string" },
          setup_token: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const email = req.body.email?.trim().toLowerCase();
      const password = req.body.password ?? "";
      const name = req.body.name?.trim() || null;
      const setupToken = req.body.setup_token ?? "";

      if (!email || !password || !setupToken) {
        return reply
          .code(422)
          .send({ error: "email, password, and setup_token are required" });
      }
      if (password.length < 8) {
        return reply.code(422).send({ error: "password must be at least 8 characters" });
      }

      const existing = db.select({ id: users.id }).from(users).limit(1).all();
      if (existing.length > 0) {
        return reply.code(409).send({ error: "local_setup_complete" });
      }
      if (!verifySetupToken(setupToken)) {
        return reply.code(403).send({ error: "invalid_setup_token" });
      }

      const userId = generateId();
      db.insert(users)
        .values({
          id: userId,
          email,
          name,
          passwordDigest: await hashPassword(password),
          createdAt: new Date(),
        })
        .run();

      const { token, sessionId } = createAuthSession(userId, "desktop");
      reply.code(201).send({
        token,
        user_id: userId,
        session_id: sessionId,
        user: { id: userId, email, name },
      });
    },
  });

  app.post<{
    Body: { email?: string; password?: string; client_kind?: string };
  }>("/auth/signin", {
    schema: {
      tags: ["session"],
      summary: "Sign in to a local Server account",
      body: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string" },
          password: { type: "string" },
          client_kind: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const email = req.body.email?.trim().toLowerCase();
      const password = req.body.password ?? "";
      if (!email || !password) {
        return reply.code(422).send({ error: "email and password are required" });
      }

      const [user] = db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
        .all();

      if (!user || !(await verifyPassword(password, user.passwordDigest))) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      const { token, sessionId } = createAuthSession(
        user.id,
        req.body.client_kind ?? "desktop"
      );
      reply.send({
        token,
        user_id: user.id,
        session_id: sessionId,
        user: { id: user.id, email: user.email, name: user.name },
      });
    },
  });

  // One-tap pairing flow for the iPhone/watch app: user pastes the
  // setup token printed at first boot, app calls /auth/pair, server
  // creates (or reuses) a single self-hosted user and returns a
  // session token. No email/password dance — the network boundary
  // is the trust boundary on a LAN-only deployment, and the user
  // already proved possession of the setup token printed only on
  // their Mac's terminal.
  app.post<{
    Body: { setup_token?: string; device_name?: string };
  }>("/auth/pair", {
    schema: {
      tags: ["session"],
      summary: "Trade a setup token for a session token (no email/password)",
      body: {
        type: "object",
        required: ["setup_token"],
        properties: {
          setup_token: { type: "string" },
          device_name: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const setupToken = req.body.setup_token?.trim() ?? "";
      const deviceName = req.body.device_name?.trim() || "iPhone";

      if (!setupToken) {
        return reply.code(422).send({ error: "setup_token is required" });
      }
      if (!verifySetupToken(setupToken)) {
        return reply.code(403).send({ error: "invalid_setup_token" });
      }

      // Reuse the existing first-account when the setup token has
      // already been consumed once (e.g. the user paired via /auth/signup
      // earlier). Otherwise create a "self-hosted" account on the
      // fly so the iPhone doesn't have to ask for a name.
      const [existing] = db.select().from(users).limit(1).all();
      let userId: string;
      let userRow: typeof users.$inferSelect;
      if (existing) {
        userId = existing.id;
        userRow = existing;
      } else {
        userId = generateId();
        db.insert(users)
          .values({
            id: userId,
            email: `local-${userId.slice(0, 8)}@self-hosted.twoody`,
            name: "Self-hosted user",
            // No password set; signin remains blocked unless the
            // user later flips this via a future /auth/set_password
            // flow. Pair-token-only access is the design here.
            passwordDigest: null,
            createdAt: new Date(),
          })
          .run();
        const [created] = db.select().from(users).where(eq(users.id, userId)).limit(1).all();
        userRow = created!;
      }

      const { token, sessionId } = createAuthSession(userId, `pair:${deviceName}`);
      reply.code(201).send({
        token,
        user_id: userId,
        session_id: sessionId,
        user: { id: userRow.id, email: userRow.email, name: userRow.name },
      });
    },
  });

  app.get("/auth/me", {
    schema: {
      tags: ["session"],
      summary: "Verify current local Server token",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
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
    },
  });

  // POST /session/cli — pair a CLI client with an 8-character code
  app.post<{ Body: { code: string } }>("/session/cli", {
    schema: {
      tags: ["session"],
      summary: "Pair a CLI client with an 8-character code",
      body: {
        type: "object",
        required: ["code"],
        properties: { code: { type: "string" } },
      },
      response: {
        200: {
          type: "object",
          properties: {
            token: { type: "string" },
            user_id: { type: "string" },
            session_id: { type: "string" },
          },
          required: ["token", "user_id", "session_id"],
        },
      },
    },
    handler: async (req, reply) => {
      const code = normalizePairingCode(req.body.code ?? "");
      if (!isValidPairingCode(code)) {
        return reply.code(422).send({ error: "invalid_pairing_code" });
      }

      // Accept: active env-var code OR a stored pairing_codes row
      const activeCode = getActivePairingCode();
      let userId: string;

      if (activeCode && code === activeCode) {
        const [user] = db.select({ id: users.id }).from(users).limit(1).all();
        if (!user) {
          return reply.code(409).send({ error: "local_setup_required" });
        }
        userId = user.id;
      } else {
        // Look up stored code
        const [row] = db
          .select()
          .from(pairingCodes)
          .where(eq(pairingCodes.code, code))
          .limit(1)
          .all();

        if (!row || row.claimedAt || !row.userId) {
          return reply.code(422).send({ error: "invalid_or_expired_code" });
        }

        const now = new Date();
        if (row.expiresAt < now) {
          return reply.code(422).send({ error: "code_expired" });
        }

        userId = row.userId;
        db.update(pairingCodes)
          .set({ claimedAt: now, claimedBy: "cli" })
          .where(eq(pairingCodes.code, code))
          .run();
      }

      const { token, sessionId } = createAuthSession(userId, "cli");

      reply.send({ token, user_id: userId, session_id: sessionId });
    },
  });

  // GET /session/me — verify current token
  app.get("/session/me", {
    schema: {
      tags: ["session"],
      summary: "Verify current bearer token",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
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
    },
  });

  app.delete("/session", {
    schema: {
      tags: ["session"],
      summary: "Revoke current bearer token",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await authenticate(req);
      if (!auth) return reply.code(401).send({ error: "Unauthorized" });
      if (!auth.sessionId) {
        return reply.code(401).send({ error: "session_token_required" });
      }

      db.delete(authSessions)
        .where(eq(authSessions.id, auth.sessionId))
        .run();

      reply.send({ ok: true });
    },
  });
}
