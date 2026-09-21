import type { FastifyReply, FastifyRequest } from "fastify";

// Fixed-window attempt counter for the routes that accept a secret
// (password, pairing code, setup token, admin token). In-memory on
// purpose: the server is a single process, and a restart wiping the
// counters costs an attacker far more than it gains them.

interface Window {
  count: number;
  resetAt: number;
}

export function createRateLimiter(options: { limit: number; windowMs: number; now?: () => number }) {
  const { limit, windowMs } = options;
  const now = options.now ?? Date.now;
  const windows = new Map<string, Window>();

  return {
    /// Number of tracked windows, expired ones included until the next sweep.
    size: () => windows.size,

    /// Records one attempt for `key`. `retryAfterSeconds` is 0 while
    /// the caller is within its budget.
    hit(key: string): { allowed: boolean; retryAfterSeconds: number } {
      const time = now();
      // Bound memory: expired windows are dropped as soon as the map
      // grows, so a scan over many source addresses cannot pile up.
      if (windows.size > 1_000) {
        for (const [entry, window] of windows) {
          if (window.resetAt <= time) windows.delete(entry);
        }
      }

      let window = windows.get(key);
      if (!window || window.resetAt <= time) {
        window = { count: 0, resetAt: time + windowMs };
        windows.set(key, window);
      }
      window.count += 1;

      if (window.count <= limit) return { allowed: true, retryAfterSeconds: 0 };
      return { allowed: false, retryAfterSeconds: Math.ceil((window.resetAt - time) / 1000) };
    },
  };
}

const secretAttempts = createRateLimiter({
  limit: envInt("TWOODY_AUTH_ATTEMPTS_LIMIT", 10),
  windowMs: 5 * 60 * 1000,
});

/// Call first in any handler that checks a secret. Sends the 429 and
/// returns false once the caller's address has used up its attempts
/// for that route.
export function allowSecretAttempt(req: FastifyRequest, reply: FastifyReply, route: string): boolean {
  const verdict = secretAttempts.hit(`${route}:${req.ip}`);
  if (verdict.allowed) return true;
  reply
    .code(429)
    .header("Retry-After", String(verdict.retryAfterSeconds))
    .send({ error: "too_many_attempts", retry_after_seconds: verdict.retryAfterSeconds });
  return false;
}

function envInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
