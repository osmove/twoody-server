import { createHash, randomBytes } from "crypto";
import { eq, and, gt } from "drizzle-orm";
import { db, users, authSessions, pairingCodes, devices } from "./db.js";
import type { FastifyRequest, FastifyReply } from "fastify";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generateId(): string {
  return randomBytes(16).toString("hex");
}

export async function authenticate(
  req: FastifyRequest
): Promise<{ userId: string; sessionId: string } | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  const digest = sha256(token);
  const now = new Date();

  const [session] = db
    .select()
    .from(authSessions)
    .where(
      and(
        eq(authSessions.tokenDigest, digest),
        // null expiresAt = never expires
        gt(authSessions.expiresAt, now as unknown as Date)
      )
    )
    .limit(1)
    .all();

  // Also check sessions with no expiry
  if (!session) {
    const [neverExpires] = db
      .select()
      .from(authSessions)
      .where(eq(authSessions.tokenDigest, digest))
      .limit(1)
      .all();
    if (!neverExpires || neverExpires.expiresAt !== null) return null;
    return { userId: neverExpires.userId, sessionId: neverExpires.id };
  }

  return { userId: session.userId, sessionId: session.id };
}

export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{ userId: string } | null> {
  const auth = await authenticate(req);
  if (!auth) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return { userId: auth.userId };
}

export function getActivePairingCode(): string | null {
  return process.env.TWOODY_PAIRING_CODE ?? null;
}

export function ensureDefaultUser(): string {
  const existing = db.select().from(users).limit(1).all();
  if (existing.length > 0) return existing[0]!.id;

  const id = generateId();
  db.insert(users)
    .values({
      id,
      email: process.env.TWOODY_USER_EMAIL ?? "admin@twoody.local",
      name: process.env.TWOODY_USER_NAME ?? "Admin",
      createdAt: new Date(),
    })
    .run();

  return id;
}
