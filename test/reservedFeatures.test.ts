import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// E-mails and Google Analytics / Search Console are kept for the accounts
// Osmove chooses (16/10/2026, Jimmy: not offered to everyone at the public
// launch — a v2; the code stays). The account says who may; Twoody Desktop
// tells this server (src/reservedFeatures.ts). Not offered: E-mails reads as
// off and cannot be switched on, the Google link reads as off, is not listed
// among the connectors, cannot be made nor switched on, no tool is offered.
// The person's own switches are kept until the Desktop's word is final; then
// what was on is switched off, its data kept, and said once.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-reserved-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.TWOODY_RESERVED_FEATURES;

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { localCapabilities, storedCapabilityOn, setLocalCapability } = await import("../src/localCapabilities.js");
const { reservedFeatureOffered, reservedFeaturesFrom, reservedWordFrom, resetReservedFeatures, setReservedFeatures } = await import("../src/reservedFeatures.js");
const { applyReservedWord } = await import("../src/reservedWithdrawal.js");
const { googleDataLink, googleDataSwitchedOn, keepGoogleDataLink } = await import("../src/google/dataLink.js");
const { googleDataChatTools, googleDataConnectorView } = await import("../src/google/dataTools.js");
const { emailToolsAvailable } = await import("../src/email/chat.js");

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
assert.equal(paired.statusCode, 201);
const owner = paired.json().user_id as string;
const desktop = { authorization: `Bearer ${paired.json().token}` };
const phone = { authorization: `Bearer ${createAuthSession(owner, "pair:iPhone").token}` };

const ANALYTICS = "https://www.googleapis.com/auth/analytics.readonly";
const NONE = { email: false, google_data: false };
const BOTH = { email: true, google_data: true };

test("the environment's list: email, google_data, all; nothing else counts", () => {
  assert.deepEqual(reservedFeaturesFrom(undefined), NONE);
  assert.deepEqual(reservedFeaturesFrom("email"), { email: true, google_data: false });
  assert.deepEqual(reservedFeaturesFrom(" Google_Data, email "), BOTH);
  assert.deepEqual(reservedFeaturesFrom("all"), BOTH);
  assert.deepEqual(reservedFeaturesFrom("bank"), NONE);
  // The Desktop's message: only `true` counts, `final` only when true.
  assert.deepEqual(reservedWordFrom({ email: "true", google_data: 1, final: "yes" }), { ...NONE, final: false });
  assert.deepEqual(reservedWordFrom(null), { ...NONE, final: false });
  assert.deepEqual(reservedWordFrom({ email: true, google_data: false, final: true }), { email: true, google_data: false, final: true });
});

test("not offered (no word, no environment): E-mails off and refused, Google not listed, not linked, no tool", async (t) => {
  t.after(() => resetReservedFeatures());
  resetReservedFeatures();
  assert.equal(reservedFeatureOffered("email"), false);
  const read = await app.inject({ method: "GET", url: "/local_capabilities", headers: desktop });
  assert.deepEqual(read.json().reserved, NONE);
  assert.equal(read.json().capabilities.email, false);
  assert.deepEqual((await app.inject({ method: "GET", url: "/local_capabilities", headers: phone })).json().reserved, NONE, "the phone reads it too");

  const on = await app.inject({ method: "PATCH", url: "/local_capabilities/email", headers: desktop, payload: { enabled: true } });
  assert.equal(on.statusCode, 403);
  assert.equal(on.json().error, "reserved_feature");
  assert.equal(storedCapabilityOn(owner, "email"), false);
  // Switching it off is never refused.
  assert.equal((await app.inject({ method: "PATCH", url: "/local_capabilities/email", headers: desktop, payload: { enabled: false } })).statusCode, 200);

  const link = await app.inject({ method: "POST", url: "/google_data/link", headers: desktop, payload: { address: "claire.martin@tessane.example", refresh_token: "not-a-real-token", scopes: ANALYTICS } });
  assert.equal(link.statusCode, 403);
  assert.equal(link.json().error, "reserved_feature");
  assert.equal(googleDataLink(owner), null, "nothing kept");
  assert.equal((await app.inject({ method: "GET", url: "/google_data", headers: desktop })).json().offered, false);
});

test("offered by the Desktop's word: E-mails switches on; taken back without a final word, it only reads as off — the switch kept", async (t) => {
  t.after(() => {
    resetReservedFeatures();
    setLocalCapability(owner, "email", false);
  });
  applyReservedWord({ type: "reserved-features", email: true, google_data: false, final: true });
  const on = await app.inject({ method: "PATCH", url: "/local_capabilities/email", headers: desktop, payload: { enabled: true } });
  assert.equal(on.statusCode, 200);
  assert.equal(on.json().capabilities.email, true);

  // The Desktop's last known word at start: hidden, nothing changed.
  assert.deepEqual(applyReservedWord({ type: "reserved-features", email: false, google_data: false, final: false }), []);
  assert.equal(localCapabilities(owner).email, false);
  assert.equal(storedCapabilityOn(owner, "email"), true, "the person's switch is kept");
  assert.equal(emailToolsAvailable(owner), false, "no e-mail tool while not offered");
  assert.deepEqual((await app.inject({ method: "GET", url: "/local_capabilities", headers: desktop })).json().withdrawn, []);

  // The account says yes again: as it was.
  applyReservedWord({ type: "reserved-features", email: true, google_data: false, final: true });
  assert.equal(localCapabilities(owner).email, true);
});

test("a final word that takes E-mails away switches it off, data kept, and says so once", async (t) => {
  t.after(() => resetReservedFeatures());
  applyReservedWord({ email: true, google_data: false, final: true });
  setLocalCapability(owner, "email", true);

  assert.deepEqual(applyReservedWord({ type: "reserved-features", email: false, google_data: false, final: true }), ["email"]);
  assert.equal(storedCapabilityOn(owner, "email"), false, "switched off");
  const read = (await app.inject({ method: "GET", url: "/local_capabilities", headers: desktop })).json();
  assert.deepEqual(read.withdrawn, ["email"]);
  // Said again by the next word: not twice in the list, nothing more switched off.
  assert.deepEqual(applyReservedWord({ email: false, google_data: false, final: true }), []);
  assert.deepEqual((await app.inject({ method: "GET", url: "/local_capabilities", headers: desktop })).json().withdrawn, ["email"]);

  // Only this computer's app says it was read.
  assert.equal((await app.inject({ method: "DELETE", url: "/local_capabilities/withdrawn", headers: phone })).statusCode, 403);
  const seen = await app.inject({ method: "DELETE", url: "/local_capabilities/withdrawn", headers: desktop });
  assert.equal(seen.statusCode, 200);
  assert.deepEqual(seen.json().withdrawn, []);
  assert.deepEqual((await app.inject({ method: "GET", url: "/local_capabilities", headers: desktop })).json().withdrawn, []);
});

test("Google Analytics and Search Console: hidden and shut while not offered, switched off by a final word, the link kept", async (t) => {
  t.after(() => resetReservedFeatures());
  setReservedFeatures(BOTH);
  keepGoogleDataLink(owner, { address: "claire.martin@tessane.example", scopes: [ANALYTICS], refreshToken: "not-a-real-token" });
  assert.equal(googleDataLink(owner)?.enabled, true);
  assert.ok(googleDataChatTools(owner).length > 0);
  assert.ok(googleDataConnectorView(owner));
  assert.ok(((await app.inject({ method: "GET", url: "/connectors", headers: desktop })).json().connectors as Array<{ id: string }>).some((row) => row.id === "google"));

  applyReservedWord({ email: false, google_data: false, final: false });
  assert.equal(googleDataLink(owner)?.enabled, false, "reads as off: the door stays shut");
  assert.deepEqual(googleDataChatTools(owner), []);
  assert.equal(googleDataConnectorView(owner), null);
  assert.ok(!((await app.inject({ method: "GET", url: "/connectors", headers: desktop })).json().connectors as Array<{ id: string }>).some((row) => row.id === "google"), "not listed");
  assert.equal((await app.inject({ method: "PATCH", url: "/google_data", headers: desktop, payload: { enabled: true } })).json().error, "reserved_feature");
  assert.equal((await app.inject({ method: "PATCH", url: "/connectors/google", headers: desktop, payload: { enabled: true } })).statusCode, 403);
  assert.equal(googleDataSwitchedOn(owner), true, "the person's switch is kept until the word is final");

  assert.deepEqual(applyReservedWord({ email: false, google_data: false, final: true }), ["google_data"]);
  assert.equal(googleDataSwitchedOn(owner), false);
  assert.ok(googleDataLink(owner), "the link itself is kept");
  assert.ok(((await app.inject({ method: "GET", url: "/local_capabilities", headers: desktop })).json().withdrawn as string[]).includes("google_data"));
});

test("inside Twoody Desktop the server takes the Desktop's word by message", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /if \(type === "reserved-features"\) \{\n\s*try \{\n\s*const off = applyReservedWord\(data\);/);
});
