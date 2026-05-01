import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  db,
  devices,
  pairingCodes,
  users,
} from "../db.js";
import { createRequire } from "module";
import {
  authenticate,
  requireAuth,
  generateId,
  generateToken,
  sha256,
  normalizePairingCode,
  isValidPairingCode,
  generatePairingCode,
  getActivePairingCode,
} from "../auth.js";

const { version } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

export async function deviceRoutes(app: FastifyInstance) {
  async function requireDeviceAccess(
    req: FastifyRequest,
    reply: FastifyReply,
    deviceId: string
  ): Promise<{ userId: string } | null> {
    const auth = await authenticate(req);
    if (!auth) {
      reply.code(401).send({ error: "Unauthorized" });
      return null;
    }
    if (auth.deviceId && auth.deviceId !== deviceId) {
      reply.code(403).send({ error: "device_token_mismatch" });
      return null;
    }
    const [device] = db
      .select({ id: devices.id, userId: devices.userId })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, auth.userId)))
      .limit(1)
      .all();
    if (!device) {
      reply.code(404).send({ error: "device_not_found" });
      return null;
    }
    return { userId: auth.userId };
  }

  // POST /devices/pair — device firmware calls this with an 8-character code
  app.post<{
    Body: { code: string; device_name?: string; client_kind?: string };
  }>("/devices/pair", {
    schema: {
      tags: ["devices"],
      summary: "Pair a firmware device with an 8-character code",
      body: {
        type: "object",
        required: ["code"],
        properties: {
          code: { type: "string" },
          device_name: { type: "string" },
          client_kind: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const { device_name, client_kind = "twoody" } = req.body ?? {};
      const code = normalizePairingCode(req.body?.code ?? "");
      if (!code) return reply.code(422).send({ error: "code is required" });
      if (!isValidPairingCode(code)) {
        return reply.code(422).send({ error: "invalid_pairing_code" });
      }

      // Accept env-var pairing code (created by `twoody serve`)
      const activeCode = getActivePairingCode();
      let userId: string;
      let storedCode: string | null = null;

      if (activeCode && code === activeCode) {
        const [user] = db.select({ id: users.id }).from(users).limit(1).all();
        if (!user) {
          return reply.code(409).send({ error: "local_setup_required" });
        }
        userId = user.id;
      } else {
        const [row] = db
          .select()
          .from(pairingCodes)
          .where(eq(pairingCodes.code, code))
          .limit(1)
          .all();

        if (!row || row.claimedAt || !row.userId) {
          return reply.code(422).send({ error: "invalid_or_expired_pairing_code" });
        }
        if (row.expiresAt < new Date()) {
          return reply.code(422).send({ error: "pairing_code_expired" });
        }

        userId = row.userId;
        storedCode = row.code;
      }

      const deviceId = generateId();
      const token = generateToken();

      db.insert(devices)
        .values({
          id: deviceId,
          userId,
          name: device_name ?? null,
          clientKind: client_kind,
          tokenDigest: sha256(token),
          createdAt: new Date(),
          lastSeenAt: new Date(),
        })
        .run();

      if (storedCode) {
        db.update(pairingCodes)
          .set({ claimedAt: new Date(), claimedBy: deviceId })
          .where(eq(pairingCodes.code, storedCode))
          .run();
      }

      reply.send({
        device_id: deviceId,
        user_token: token,
        user_id: userId,
      });
    },
  });

  // GET /devices/pair/status — CLI polls this while waiting for a device
  app.get<{ Querystring: { code: string } }>("/devices/pair/status", {
    schema: {
      tags: ["devices"],
      summary: "Poll pairing status for a device code",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const code = normalizePairingCode(req.query.code ?? "");
      if (!isValidPairingCode(code)) {
        return reply.code(422).send({ error: "invalid_pairing_code" });
      }

      const [row] = db
        .select()
        .from(pairingCodes)
        .where(eq(pairingCodes.code, code))
        .limit(1)
        .all();

      if (!row || row.userId !== auth.userId) {
        return reply.code(404).send({ error: "Code not found" });
      }

      reply.send({
        paired: Boolean(row.claimedAt),
        device_id: row.claimedBy ?? null,
      });
    },
  });

  // POST /devices/pair/register — CLI registers a code for a device to claim
  app.post<{ Body: { code?: string; device_name?: string } }>("/devices/pair/register", {
    schema: {
      tags: ["devices"],
      summary: "Register a pairing code for a device to claim",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const rawCode = req.body?.code ?? generatePairingCode();
      const code = normalizePairingCode(rawCode);
      if (!isValidPairingCode(code)) {
        return reply.code(422).send({ error: "invalid_pairing_code" });
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 min
      const [existing] = db
        .select()
        .from(pairingCodes)
        .where(eq(pairingCodes.code, code))
        .limit(1)
        .all();
      if (existing && existing.userId !== auth.userId && !existing.claimedAt && existing.expiresAt > now) {
        return reply.code(409).send({ error: "pairing_code_in_use" });
      }

      db.insert(pairingCodes)
        .values({
          code,
          userId: auth.userId,
          purpose: "device",
          createdAt: now,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: pairingCodes.code,
          set: {
            userId: auth.userId,
            purpose: "device",
            expiresAt,
            claimedAt: null,
            claimedBy: null,
          },
        })
        .run();

      reply.send({ ok: true, code, expires_at: expiresAt.toISOString() });
    },
  });

  // GET /devices/:id/update_check — firmware polls this for OTA kill-switch
  app.get<{ Params: { id: string } }>("/devices/:id/update_check", {
    schema: {
      tags: ["devices"],
      summary: "Check for device OTA updates",
    },
    handler: async (req, reply) => {
      const access = await requireDeviceAccess(req, reply, req.params.id);
      if (!access) return;
      const blocked =
        process.env.TWOODY_DEVICE_UPDATES_BLOCKED === "true";
      reply.send({
        update_available: false,
        force_update: false,
        blocked,
        min_sha: process.env.TWOODY_DEVICE_MIN_SHA ?? null,
        server_version: version,
      });
    },
  });

  // POST /devices/:id/update_events — OTA telemetry
  app.post<{
    Params: { id: string };
    Body: { event: string; from_sha?: string; to_sha?: string; error?: string };
  }>("/devices/:id/update_events", async (req, reply) => {
    const access = await requireDeviceAccess(req, reply, req.params.id);
    if (!access) return;
    const { event, from_sha, to_sha } = req.body ?? {};
    app.log.info({ device_id: req.params.id, event, from_sha, to_sha }, "OTA event");
    reply.code(204).send();
  });

  // POST /devices/:id/transcripts — save transcript (stored as log for now)
  app.post<{
    Params: { id: string };
    Body: { transcript?: string; messages?: unknown[] };
  }>("/devices/:id/transcripts", async (req, reply) => {
    const access = await requireDeviceAccess(req, reply, req.params.id);
    if (!access) return;
    app.log.info({ device_id: req.params.id }, "Transcript saved");
    reply.code(201).send({ ok: true });
  });

  // GET /devices/llm_keys — device fetches user's LLM API keys
  app.get("/devices/llm_keys", {
    schema: {
      tags: ["devices"],
      summary: "Fetch user LLM keys for direct provider use",
    },
    handler: async (req, reply) => {
      const auth = await authenticate(req);
      if (!auth) return reply.code(401).send({ error: "Unauthorized" });
      reply.send({
        openai_api_key: process.env.OPENAI_API_KEY ?? null,
        anthropic_api_key: process.env.ANTHROPIC_API_KEY ?? null,
        gemini_api_key: process.env.GEMINI_API_KEY ?? null,
      });
    },
  });

  // POST /devices/stereo_pair — pair two devices for stereo
  app.post<{ Body: { master_id: string; slave_id: string } }>(
    "/devices/stereo_pair",
    async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const { master_id, slave_id } = req.body ?? {};
      if (!master_id || !slave_id) {
        return reply.code(422).send({ error: "master_id and slave_id required" });
      }
      if (master_id === slave_id) {
        return reply.code(422).send({ error: "master_id and slave_id must differ" });
      }

      const owned = db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.userId, auth.userId))
        .all()
        .map((device) => device.id);
      if (!owned.includes(master_id) || !owned.includes(slave_id)) {
        return reply.code(404).send({ error: "device_not_found" });
      }

      const pairId = `stereo-${master_id.slice(0, 8)}-${slave_id.slice(0, 8)}`;
      app.log.info({ pair_id: pairId, master_id, slave_id }, "Stereo pair registered");

      // Update device names to reflect stereo role
      db.update(devices)
        .set({ name: "Twoody (L)" })
        .where(eq(devices.id, master_id))
        .run();
      db.update(devices)
        .set({ name: "Twoody (R)" })
        .where(eq(devices.id, slave_id))
        .run();

      reply.send({ pair_id: pairId, master_id, slave_id });
    }
  );
}
