import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { generateId } from "../auth.js";
import { sqlite } from "../db.js";

// Local API keys (migration 21, docs/developer-api-design.md §3): what a
// program of this machine shows to call /v1/* (routes/developerApi.ts).
//
// A key is « twk_ » and 43 characters of randomness (256 bits). It is shown
// once, when it is made; only its SHA-256 is kept, with its first 12
// characters (« twk_ » and 8 more) to recognise it in a list. A key is not a
// session: auth.ts never finds it (its digest is in api_keys, not in
// auth_sessions nor devices), so it opens /v1/* and nothing else.

export const KEY_PREFIX = "twk_";
const SHOWN = KEY_PREFIX.length + 8;
const MAX_KEYS = 50;
const NAME_MAX = 60;

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

function digestOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function looksLikeKey(token: string): boolean {
  return /^twk_[A-Za-z0-9_-]{43}$/.test(token);
}

export class KeyLimitError extends Error {}

/// A new key for this server's person: the token, once, and its row.
export function createApiKey(userId: string, name: string | null | undefined, now = Date.now()): { token: string; key: ApiKeyRow } {
  const active = (sqlite.prepare("SELECT count(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL").get(userId) as { n: number }).n;
  if (active >= MAX_KEYS) throw new KeyLimitError(`at most ${MAX_KEYS} keys`);
  const token = KEY_PREFIX + randomBytes(32).toString("base64url");
  const id = generateId();
  const label = (typeof name === "string" ? name.trim().slice(0, NAME_MAX) : "") || "API key";
  const prefix = token.slice(0, SHOWN);
  sqlite
    .prepare("INSERT INTO api_keys (id, user_id, name, prefix, token_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, label, prefix, digestOf(token), now, now);
  return { token, key: { id, name: label, prefix, created_at: now, last_used_at: null, revoked_at: null } };
}

/// This person's keys, the revoked ones too (newest first): never a token.
export function listApiKeys(userId: string): ApiKeyRow[] {
  return sqlite
    .prepare("SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as ApiKeyRow[];
}

/// Revokes one of this person's keys (kept, marked). False when there is none.
export function revokeApiKey(userId: string, id: string, now = Date.now()): boolean {
  const result = sqlite.prepare("UPDATE api_keys SET revoked_at = coalesce(revoked_at, ?), updated_at = ? WHERE id = ? AND user_id = ?").run(now, now, id, userId);
  return result.changes > 0;
}

/// Whose key this is, when it is a live one. The digest is looked up by its
/// index and compared again in constant time.
export function verifyApiKey(token: string, now = Date.now()): { userId: string; keyId: string; name: string } | null {
  if (!looksLikeKey(token)) return null;
  const digest = digestOf(token);
  const row = sqlite.prepare("SELECT id, user_id, name, token_digest, revoked_at FROM api_keys WHERE token_digest = ?").get(digest) as
    | { id: string; user_id: string; name: string; token_digest: string; revoked_at: number | null }
    | undefined;
  if (!row || row.revoked_at !== null) return null;
  const expected = Buffer.from(row.token_digest, "hex");
  const given = Buffer.from(digest, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  // At most once a minute: the list says when a key was last used.
  sqlite.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)").run(now, row.id, now - 60_000);
  return { userId: row.user_id, keyId: row.id, name: row.name };
}
