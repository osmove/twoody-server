import {
  createHash,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { eq } from "drizzle-orm";
import { db, users, authSessions, devices, DATA_DIR } from "./db.js";
import type { FastifyRequest, FastifyReply } from "fastify";

const scryptAsync = promisify(scrypt);
const SETUP_TOKEN_PATH = join(DATA_DIR, "setup-token");
const PAIRING_CODE_PATTERN = /^[A-Z0-9]{8}$/;

/// Name given to the account `/auth/pair` creates when none exists yet.
/// It is a label for the UI, not something the assistant should call
/// its owner.
export const PLACEHOLDER_USER_NAME = "Self-hosted user";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generateId(): string {
  return randomBytes(16).toString("hex");
}

export function normalizePairingCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidPairingCode(code: string): boolean {
  return PAIRING_CODE_PATTERN.test(normalizePairingCode(code));
}

export function generatePairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i += 1) {
    code += alphabet[randomInt(alphabet.length)];
  }
  return code;
}

function readHeaderValue(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

export function extractAuthToken(req: FastifyRequest): string | null {
  const authorization = readHeaderValue(req.headers.authorization);
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice(7).trim();
  }

  return readHeaderValue(req.headers["x-user-token"])?.trim() ?? null;
}

export function hasUsers(): boolean {
  return db.select({ id: users.id }).from(users).limit(1).all().length > 0;
}

export function ensureSetupToken(): { token: string; path: string } | null {
  if (hasUsers()) return null;

  const envToken = process.env.TWOODY_SETUP_TOKEN?.trim();
  if (envToken) {
    writeFileSync(SETUP_TOKEN_PATH, `${envToken}\n`, { mode: 0o600 });
    return { token: envToken, path: SETUP_TOKEN_PATH };
  }

  if (existsSync(SETUP_TOKEN_PATH)) {
    const existing = readFileSync(SETUP_TOKEN_PATH, "utf8").trim();
    if (existing) return { token: existing, path: SETUP_TOKEN_PATH };
  }

  const token = randomBytes(18).toString("base64url");
  writeFileSync(SETUP_TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  return { token, path: SETUP_TOKEN_PATH };
}

export function verifySetupToken(token: string): boolean {
  const setup = ensureSetupToken();
  return Boolean(setup && timingSafeStringEqual(setup.token, token.trim()));
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  digest: string | null
): Promise<boolean> {
  if (!digest) return false;

  const [algorithm, salt, expected] = digest.split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;

  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const expectedBuffer = Buffer.from(expected, "base64url");
  if (derived.length !== expectedBuffer.length) return false;
  return timingSafeEqual(derived, expectedBuffer);
}

export function createAuthSession(
  userId: string,
  clientKind = "cli"
): { token: string; sessionId: string } {
  const token = generateToken();
  const sessionId = generateId();

  db.insert(authSessions)
    .values({
      id: sessionId,
      userId,
      tokenDigest: sha256(token),
      clientKind,
      createdAt: new Date(),
      expiresAt: null,
    })
    .run();

  return { token, sessionId };
}

export async function authenticate(
  req: FastifyRequest
): Promise<{ userId: string; sessionId?: string; deviceId?: string } | null> {
  const token = extractAuthToken(req);
  if (!token) return null;
  const digest = sha256(token);
  const now = new Date();

  const [session] = db
    .select()
    .from(authSessions)
    .where(eq(authSessions.tokenDigest, digest))
    .limit(1)
    .all();

  if (session) {
    if (!session.expiresAt || session.expiresAt > now) {
      return { userId: session.userId, sessionId: session.id };
    }
  }

  const [device] = db
    .select()
    .from(devices)
    .where(eq(devices.tokenDigest, digest))
    .limit(1)
    .all();

  if (!device) return null;

  db.update(devices)
    .set({ lastSeenAt: now })
    .where(eq(devices.id, device.id))
    .run();

  return { userId: device.userId, deviceId: device.id };
}

export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{ userId: string; sessionId?: string; deviceId?: string } | null> {
  const auth = await authenticate(req);
  if (!auth) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  // Which session or device asked, too: the answers' usage says who.
  return { userId: auth.userId, sessionId: auth.sessionId, deviceId: auth.deviceId };
}

export function getActivePairingCode(): string | null {
  const code = process.env.TWOODY_PAIRING_CODE;
  if (!code) return null;
  const normalized = normalizePairingCode(code);
  return isValidPairingCode(normalized) ? normalized : null;
}

/// Whether `candidate` is the code this server was started with, compared
/// in constant time. It is what a second device pairs with once an account
/// exists: new at every start, and shown on the computer's own screen.
export function matchesActivePairingCode(candidate: string): boolean {
  const active = getActivePairingCode();
  return active !== null && timingSafeStringEqual(active, normalizePairingCode(candidate));
}
