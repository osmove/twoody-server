import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { isLoopbackAddress, requireAdminAccess } from "../src/adminAccess.js";

const LAN = "192.168.1.20";
const TOKEN = "correct-horse-battery-staple-42"; // gitleaks:allow — a test value, not a secret

function buildApp() {
  const app = Fastify();
  app.get("/admin", async (req, reply) => {
    if (!requireAdminAccess(req, reply)) return;
    reply.send("admin page");
  });
  return app;
}

beforeEach(() => {
  delete process.env.TWOODY_ADMIN_TOKEN;
});
after(() => {
  delete process.env.TWOODY_ADMIN_TOKEN;
});

test("loopback detection", () => {
  for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ["192.168.1.20", "10.0.0.1", "::ffff:192.168.1.20", "fe80::1", "", "localhost"]) {
    assert.equal(isLoopbackAddress(address), false, address);
  }
});

test("without a token the page is served to this machine only", async () => {
  const app = buildApp();
  assert.equal((await app.inject({ url: "/admin" })).statusCode, 200);

  const fromLan = await app.inject({ url: "/admin", remoteAddress: LAN });
  assert.equal(fromLan.statusCode, 403);
  assert.equal(fromLan.json().error, "admin_local_only");
});

test("cross-site requests are refused even from loopback", async () => {
  const app = buildApp();
  const response = await app.inject({ url: "/admin", headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(response.statusCode, 403);
  // A direct navigation and a same-origin refresh are fine.
  assert.equal((await app.inject({ url: "/admin", headers: { "sec-fetch-site": "none" } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/admin", headers: { "sec-fetch-site": "same-origin" } })).statusCode, 200);
});

test("with a token, everyone needs it — loopback included", async () => {
  process.env.TWOODY_ADMIN_TOKEN = TOKEN;
  const app = buildApp();

  const anonymous = await app.inject({ url: "/admin" });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error, "admin_token_required");

  const bearer = await app.inject({ url: "/admin", remoteAddress: LAN, headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(bearer.statusCode, 200);

  const header = await app.inject({ url: "/admin", remoteAddress: LAN, headers: { "x-admin-token": TOKEN } });
  assert.equal(header.statusCode, 200);
});

test("?token= sets a cookie holding a digest and redirects to a clean URL", async () => {
  process.env.TWOODY_ADMIN_TOKEN = TOKEN;
  const app = buildApp();

  const login = await app.inject({ url: `/admin?token=${TOKEN}`, remoteAddress: LAN });
  assert.equal(login.statusCode, 303);
  assert.equal(login.headers.location, "/admin");
  const setCookie = String(login.headers["set-cookie"]);
  assert.match(setCookie, /^twoody_admin=[0-9a-f]{64}; Path=\/admin; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
  assert.ok(!setCookie.includes(TOKEN), "the raw token must not be stored in the browser");

  const cookie = setCookie.split(";")[0];
  const page = await app.inject({ url: "/admin", remoteAddress: LAN, headers: { cookie } });
  assert.equal(page.statusCode, 200);
  assert.equal(page.body, "admin page");
});

test("wrong tokens are refused, then rate limited; valid visits never count", async () => {
  process.env.TWOODY_ADMIN_TOKEN = TOKEN;
  const app = buildApp();
  const attacker = "192.168.1.66";

  // A page that refreshes every 10 s must not lock its own user out.
  for (let i = 0; i < 25; i += 1) {
    const ok = await app.inject({ url: "/admin", remoteAddress: LAN, headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.statusCode, 200);
  }

  const statuses: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    const response = await app.inject({ url: "/admin?token=nope", remoteAddress: attacker });
    statuses.push(response.statusCode);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.deepEqual(statuses.slice(10), [429, 429]);

  const lockedOut = await app.inject({ url: "/admin?token=nope", remoteAddress: attacker });
  assert.ok(Number(lockedOut.headers["retry-after"]) > 0);

  // Other addresses are unaffected.
  const bystander = await app.inject({ url: "/admin", remoteAddress: LAN, headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(bystander.statusCode, 200);
});
