import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  db,
  devices,
  pairingCodes,
  authSessions,
} from "../db.js";
import { createRequire } from "module";
import {
  authenticate,
  requireAuth,
  generateId,
  generateToken,
  sha256,
  ensureDefaultUser,
} from "../auth.js";

const { version } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

export async function deviceRoutes(app: FastifyInstance) {
  // POST /devices/pair — device firmware calls this with a 6-digit code
  app.post<{
    Body: { code: string; device_name?: string; client_kind?: string };
  }>("/devices/pair", async (req, reply) => {
    const { code, device_name, client_kind = "twoody" } = req.body ?? {};
    if (!code) return reply.code(422).send({ error: "code is required" });

    // Accept env-var pairing code (created by `twoody serve`)
    const activeCode = process.env.TWOODY_PAIRING_CODE;
    let userId: string;

    if (activeCode && code === activeCode) {
      userId = ensureDefaultUser();
    } else {
      const [row] = db
        .select()
        .from(pairingCodes)
        .where(eq(pairingCodes.code, code))
        .limit(1)
        .all();

      if (!row || row.claimedAt || !row.userId) {
        return reply.code(422).send({ error: "Invalid or expired pairing code" });
      }
      if (row.expiresAt < new Date()) {
        return reply.code(422).send({ error: "Pairing code expired" });
      }

      userId = row.userId;
      db.update(pairingCodes)
        .set({ claimedAt: new Date(), claimedBy: "device" })
        .where(eq(pairingCodes.code, code))
        .run();
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

    reply.send({
      device_id: deviceId,
      user_token: token,
      user_id: userId,
    });
  });

  // GET /devices/pair/status — CLI polls this while waiting for a device
  app.get<{ Querystring: { code: string } }>(
    "/devices/pair/status",
    async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const { code } = req.query;
      const [row] = db
        .select()
        .from(pairingCodes)
        .where(eq(pairingCodes.code, code))
        .limit(1)
        .all();

      if (!row) return reply.code(404).send({ error: "Code not found" });

      reply.send({
        paired: Boolean(row.claimedAt),
        device_id: row.claimedBy ?? null,
      });
    }
  );

  // POST /devices/pair/register — CLI registers a code for a device to claim
  app.post<{ Body: { code: string; device_name?: string } }>(
    "/devices/pair/register",
    async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const { code, device_name } = req.body ?? {};
      if (!code) return reply.code(422).send({ error: "code is required" });

      const now = new Date();
      const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 min

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
          set: { expiresAt, claimedAt: null, claimedBy: null },
        })
        .run();

      reply.send({ ok: true, expires_at: expiresAt.toISOString() });
    }
  );

  // GET /devices/:id/update_check — firmware polls this for OTA kill-switch
  app.get<{ Params: { id: string } }>(
    "/devices/:id/update_check",
    async (req, reply) => {
      const blocked =
        process.env.TWOODY_DEVICE_UPDATES_BLOCKED === "true";
      reply.send({
        update_available: false,
        force_update: false,
        blocked,
        min_sha: process.env.TWOODY_DEVICE_MIN_SHA ?? null,
        server_version: version,
      });
    }
  );

  // POST /devices/:id/update_events — OTA telemetry
  app.post<{
    Params: { id: string };
    Body: { event: string; from_sha?: string; to_sha?: string; error?: string };
  }>("/devices/:id/update_events", async (req, reply) => {
    const { event, from_sha, to_sha } = req.body ?? {};
    app.log.info({ device_id: req.params.id, event, from_sha, to_sha }, "OTA event");
    reply.code(204).send();
  });

  // POST /devices/:id/transcripts — save transcript (stored as log for now)
  app.post<{
    Params: { id: string };
    Body: { transcript?: string; messages?: unknown[] };
  }>("/devices/:id/transcripts", async (req, reply) => {
    app.log.info({ device_id: req.params.id }, "Transcript saved");
    reply.code(201).send({ ok: true });
  });

  // GET /devices/llm_keys — device fetches user's LLM API keys
  app.get("/devices/llm_keys", async (req, reply) => {
    // No stored per-device keys in local-server — just relay env vars
    reply.send({
      openai_api_key: process.env.OPENAI_API_KEY ?? null,
      anthropic_api_key: process.env.ANTHROPIC_API_KEY ?? null,
      gemini_api_key: process.env.GEMINI_API_KEY ?? null,
    });
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
