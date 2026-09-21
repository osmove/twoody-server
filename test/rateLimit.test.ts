import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/rateLimit.js";

test("allows up to the limit, then blocks until the window ends", () => {
  let time = 1_000_000;
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => time });

  assert.deepEqual(limiter.hit("a"), { allowed: true, retryAfterSeconds: 0 });
  assert.equal(limiter.hit("a").allowed, true);
  assert.equal(limiter.hit("a").allowed, true);

  const blocked = limiter.hit("a");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 60);

  time += 45_000;
  assert.equal(limiter.hit("a").retryAfterSeconds, 15);

  time += 15_000;
  assert.equal(limiter.hit("a").allowed, true, "a new window starts once the old one has expired");
});

test("keys are independent", () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
  assert.equal(limiter.hit("signin:10.0.0.1").allowed, true);
  assert.equal(limiter.hit("signin:10.0.0.1").allowed, false);
  assert.equal(limiter.hit("signin:10.0.0.2").allowed, true);
  assert.equal(limiter.hit("pair:10.0.0.1").allowed, true);
});

test("expired windows are dropped so a scan cannot grow the map forever", () => {
  let time = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => time });
  for (let i = 0; i < 1_500; i += 1) limiter.hit(`scan:${i}`);
  assert.equal(limiter.size(), 1_500);

  time += 5_000;
  // The next hit sweeps every expired window before recording itself.
  assert.equal(limiter.hit("scan:0").allowed, true);
  assert.equal(limiter.size(), 1);
});
