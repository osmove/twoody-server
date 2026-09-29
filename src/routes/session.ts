import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { allowSecretAttempt } from "../rateLimit.js";
import { forgetTunnelPeersOfSession } from "../tunnel/identity.js";
import { pairDevice } from "../pairing.js";
import { tunnelPeersChanged } from "../tunnel/index.js";
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
  hasUsers,
  matchesActivePairingCode,
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
      if (!allowSecretAttempt(req, reply, "auth/signup")) return;
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

      const { token, sessionId } = createAuthSession(userId, "desktop", "owner");
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
      if (!allowSecretAttempt(req, reply, "auth/signin")) return;
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

      // The password is the owner's, whatever the client calls itself.
      const { token, sessionId } = createAuthSession(
        user.id,
        req.body.client_kind ?? "desktop",
        "owner"
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
  //
  // This is also where the two devices exchange their tunnel keys, and
  // it is the only place they can: everything the tunnel promises rests
  // on these keys having met here, on the same network, with a token
  // the person read off their own screen. A device that sends its
  // `tunnel_public_key` gets this computer's back, and from then on
  // each recognises the other with no server in between — which is why
  // the relay can carry their traffic without being able to read it or
  // to stand in the middle of it. Sending no key pairs as before, and
  // the tunnel simply is not available to that device.
  app.post<{
    Body: { setup_token?: string; device_name?: string; tunnel_public_key?: string };
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
          tunnel_public_key: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      if (!allowSecretAttempt(req, reply, "auth/pair")) return;
      const setupToken = req.body.setup_token?.trim() ?? "";
      const deviceName = req.body.device_name?.trim() || "iPhone";

      if (!setupToken) {
        return reply.code(422).send({ error: "setup_token is required" });
      }
      // The first device pairs with the setup token, which the server
      // honours only while no account exists. After that, a device pairs
      // into the existing account with the code this server was started
      // with — shown on the computer's screen, new at every start.
      //
      // On Twoody Desktop "after that" is always: the desktop spends the
      // setup token on its own account at first launch. Its QR code went
      // on carrying that spent token, so every phone that scanned it was
      // refused here. The code is what it shows now, in the same field,
      // so a phone already in people's hands needs no update to use it.
      // The setup token makes the owner (the Desktop spends it on itself at
      // first launch); the code on the screen, another device.
      const bySetupToken = verifySetupToken(setupToken);
      if (!bySetupToken && !(hasUsers() && matchesActivePairingCode(setupToken))) {
        return reply.code(403).send({ error: "invalid_setup_token" });
      }

      // Checked before the account is touched: a device that sends
      // something that is not a key should change nothing here.
      const offered = req.body.tunnel_public_key?.trim().toLowerCase() ?? "";
      if (offered && !/^[0-9a-f]{64}$/.test(offered)) {
        return reply.code(422).send({ error: "tunnel_public_key must be 64 hexadecimal characters" });
      }

      // Reuse the existing account when there is one — which is the
      // case for every pairing by code. Otherwise a "self-hosted" account
      // is made on the fly so the iPhone doesn't have to ask for a name.
      // The key swap happens there too, when the device brought one: this
      // computer's key is handed over only after the setup token has been
      // checked, so a device that is refused learns nothing about it.
      const { token, sessionId, user: userRow, tunnelPublicKey } = pairDevice({ deviceName, tunnelPublicKey: offered || null, origin: bySetupToken ? "owner" : "code" });
      const userId = userRow.id;

      reply.code(201).send({
        token,
        user_id: userId,
        session_id: sessionId,
        user: { id: userRow.id, email: userRow.email, name: userRow.name },
        ...(tunnelPublicKey ? { tunnel_public_key: tunnelPublicKey } : {}),
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
      if (!allowSecretAttempt(req, reply, "session/cli")) return;
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

      const { token, sessionId } = createAuthSession(userId, "cli", "code");

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
      // A device that signs out forgets the key it paired with: this
      // computer stops waiting for it at the relay.
      if (forgetTunnelPeersOfSession(auth.sessionId) > 0) tunnelPeersChanged();

      reply.send({ ok: true });
    },
  });
}
