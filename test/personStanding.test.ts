import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeMailServer, rfc822 } from "./helpers/fakeMailServer.js";

// Jimmy's iPhone on 11/10/2026 (Desktop 0.13.95): « Outils » greyed his
// connectors with « Pour l'instant, les connecteurs ne servent que dans le
// chat de Twoody sur votre ordinateur », showed no « Recherche Internet »
// and no E-mails. His Mac's database said why: the device-access his
// iPhone's session held had run out the day before (exp 10/10 07:10 UTC)
// and no fresh one had come — nothing told the phone, nothing told him.
//
// - sessionTrust.ts personStanding says, for the device asking about
//   itself, whether it is the person here and if not why — always as
//   meshRequester decides (held equal below, case by case);
// - GET /local_capabilities `devices` and GET /connectors `person` carry it,
//   so the phone signs a fresh device-access and says why meanwhile;
// - E-mails is offered to the person's own devices exactly as the
//   connectors are (routes/queries.ts offersEmail): never to a household
//   member's phone, a device paired by code, nor the iPhone's token without
//   its tunnel key; a draft is asked on the device that sent the message
//   and answered only by that session (or this computer's app).

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-person-standing-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_BACKEND_URL;
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;
delete process.env.TWOODY_WEB_BRIDGE_URL;
delete process.env.TWOODY_WEB_BRIDGE_KEY;

// ── A model of the person's, on this computer, that drafts when told to ──
type Body = { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }>; max_tokens?: number; tool_choice?: string };
const bodies: Body[] = [];
let call: (() => { name: string; arguments: object }) | null = null;
const llm = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "qwen" }] })); return; }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw) as Body;
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const answered = body.messages.some((message) => message.role === "tool");
    const next = call?.();
    if (next && !answered && body.tools?.some((tool) => tool.function.name === next.name) && body.tool_choice !== "none" && body.max_tokens !== 1) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: next.name, arguments: JSON.stringify(next.arguments) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ choices: [{ delta: { content: "Réponse." } }] });
    }
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
const llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;

// ── The mailbox, in memory ───────────────────────────────────────────────
const DAY = 86_400_000;
const now = Date.now();
const mail = new FakeMailServer();
mail.folder("INBOX", "\\Inbox", null);
mail.folder("Sent", "\\Sent");
mail.folder("Drafts", "\\Drafts");
mail.deliver("INBOX", rfc822({ from: "René Dupont <rene@example.com>", to: "Jimmy <jimmy@example.org>", subject: "Réunion de lundi", messageId: "<reunion@example.com>", date: new Date(now - 2 * DAY), text: "Bonjour Jimmy,\n\nOn se voit lundi à 10h ?\n\nRené" }), { at: now - 2 * DAY });

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken, createAuthSession, authenticate } = await import("../src/auth.js");
const { pairDevice } = await import("../src/pairing.js");
const { setDesktopAccount } = await import("../src/account/service.js");
const { setRosterSource, meshRoster } = await import("../src/vault/roster.js");
const { meshRequester, personStanding } = await import("../src/sessionTrust.js");
const { waitingApprovals } = await import("../src/connectors/connectors.js");
const { useMailConnectorForTests } = await import("../src/email/imap.js");
const { syncMailbox } = await import("../src/email/sync.js");
const { searchEmails } = await import("../src/email/store.js");
const { authSessions, db } = await import("../src/db.js");
const { meshVault } = await import("./helpers/meshVault.js");
const { eq } = await import("drizzle-orm");
useMailConnectorForTests(mail.connector);

const MAC = "0b8c7d6e-5f4a-4b3c-9d2e-1f0a9b8c7d6e";
setDesktopAccount({ backendUrl: "http://127.0.0.1:9", userToken: "unused", computerId: MAC, computerName: "Mac de Jimmy" });
const app = await buildApp();

const desktop = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const mac = { authorization: `Bearer ${desktop.json().token}` };
const userId = desktop.json().user_id as string;
await app.inject({ method: "POST", url: "/providers/local", headers: mac, payload: { url: llmUrl, model: "qwen", name: "llama.cpp" } });

const vault = meshVault(userId);
const iphone = vault.person("iPhone de Jimmy");
vault.desktop("Mac de Jimmy", MAC, iphone);
const stranger = meshVault(userId).person("Pas de l'historique");
await setRosterSource(async () => vault.input([iphone])).refresh();

const sealedFrom = (key: string) => ({ "x-twoody-via-tunnel": "direct", "x-twoody-tunnel-peer": key });
const nowS = () => Math.floor(Date.now() / 1000);

/// Paired by the code the Mac shows, as Jimmy's iPhone was (origin « code », no rule).
async function pairByCode(name: string) {
  const key = randomBytes(32).toString("hex");
  process.env.TWOODY_PAIRING_CODE = "K7M2Q9XR";
  const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: "k7m2q9xr", device_name: name, tunnel_public_key: key } });
  assert.equal(paired.statusCode, 201, paired.body);
  return { key, sessionId: paired.json().session_id as string, headers: { authorization: `Bearer ${paired.json().token}`, ...sealedFrom(key) }, bare: { authorization: `Bearer ${paired.json().token}` } };
}
const phone = await pairByCode("iPhone");
const renewed = await app.inject({ method: "POST", url: "/api/v1/session/device-access", headers: phone.headers, payload: vault.deviceAccess(iphone, phone.key, MAC, nowS() + 23 * 3600) });
assert.equal(renewed.statusCode, 200, renewed.body);
const kitchen = await pairByCode("iPad de la cuisine");
const householdKey = randomBytes(32).toString("hex");
const household = { authorization: `Bearer ${pairDevice({ deviceName: "iPhone de Claire", tunnelPublicKey: householdKey, origin: "account", approvalRule: "endorsed" }).token}`, ...sealedFrom(householdKey) };
const peerKey = randomBytes(32).toString("hex");
const peer = { authorization: `Bearer ${pairDevice({ deviceName: "peer:Raspberry Pi", tunnelPublicKey: peerKey, origin: "account" }).token}`, ...sealedFrom(peerKey) };
// The owner's token from another machine of the network.
const ownerFromNetwork = { ...mac, "x-forwarded-for": "192.168.1.50" };

test.after(async () => {
  setRosterSource(null);
  setDesktopAccount(null);
  useMailConnectorForTests(null);
  delete process.env.TWOODY_PAIRING_CODE;
  await app.close();
  await new Promise((resolve) => llm.close(resolve));
});

/// What GET /local_capabilities and GET /connectors say of the device asking.
async function said(headers: Record<string, string>) {
  const capabilities = await app.inject({ url: "/api/v1/local_capabilities", headers });
  const connectors = await app.inject({ url: "/api/v1/connectors", headers });
  return { devices: capabilities.json().devices, connectors: connectors.statusCode === 200 ? connectors.json().person : connectors.statusCode };
}

/// personStanding and meshRequester on the same request: always the same answer.
async function standingOf(headers: Record<string, string>) {
  // What these functions read of a request inject() makes: its address and headers.
  const request = { ip: "127.0.0.1", url: "/api/v1/connectors", headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])) } as unknown as import("fastify").FastifyRequest;
  const auth = await authenticate(request);
  const roster = () => meshRoster().get();
  const standing = await personStanding(request, auth ?? {}, roster);
  const requester = auth ? await meshRequester(request, auth, roster) : null;
  assert.equal(standing.person, requester !== null, `personStanding mirrors meshRequester (${standing.reason})`);
  return standing;
}

test("each kind of session: whether it is the person here and if not why — always as meshRequester decides", async () => {
  assert.deepEqual(await standingOf(mac), { person: true, reason: null, until: null });
  assert.equal((await standingOf(phone.headers)).person, true);
  assert.ok(((await standingOf(phone.headers)).until ?? 0) > nowS() + 22 * 3600, "the person device's statement: when it runs out");
  assert.equal((await standingOf(ownerFromNetwork)).reason, "owner_elsewhere");
  assert.equal((await standingOf(phone.bare)).reason, "not_sealed");
  assert.equal((await standingOf({ ...phone.bare, ...sealedFrom(randomBytes(32).toString("hex")) })).reason, "not_sealed", "through the tunnel from another key");
  assert.equal((await standingOf(kitchen.headers)).reason, "no_device_access");
  assert.equal((await standingOf(household)).reason, "no_device_access");
  assert.equal((await standingOf({ authorization: `Bearer ${createAuthSession(userId, "pair:Ordinateur").token}` })).reason, "not_sealed");
  // A computer's peer session never reaches these routes; asked here all the same.
  assert.equal((await standingOf(peer)).person, false);
});

test("what the iPhone's « Outils » reads: devices (web, email, person, reason, until) and the connectors' person", async () => {
  assert.deepEqual(await said(phone.headers), { devices: { web: false, email: false, person: true, reason: null, until: (await standingOf(phone.headers)).until }, connectors: { person: true, reason: null } });
  assert.deepEqual(await said(kitchen.headers), { devices: { web: false, email: false, person: false, reason: "no_device_access", until: null }, connectors: { person: false, reason: "no_device_access" } });
  assert.deepEqual((await said(household)).connectors, { person: false, reason: "no_device_access" });
  assert.deepEqual((await said(mac)).devices, { web: false, email: false, person: true, reason: null, until: null });
});

test("Jimmy's iPhone on 11/10/2026: its device-access ran out — said, and a fresh one makes it the person again", async () => {
  const row = db.select().from(authSessions).where(eq(authSessions.id, phone.sessionId)).all()[0]!;
  const kept = row.deviceAccessJson;
  // As in his Mac's database: the statement it holds is a day old.
  const stale = { ...vault.deviceAccess(iphone, phone.key, MAC, nowS() - 24 * 3600) };
  db.update(authSessions).set({ deviceAccessJson: JSON.stringify(stale) }).where(eq(authSessions.id, phone.sessionId)).run();
  assert.deepEqual(await said(phone.headers), { devices: { web: false, email: false, person: false, reason: "device_access_expired", until: null }, connectors: { person: false, reason: "device_access_expired" } });
  assert.equal((await standingOf(phone.headers)).reason, "device_access_expired");
  const sent = await app.inject({ method: "POST", url: "/api/v1/session/device-access", headers: phone.headers, payload: vault.deviceAccess(iphone, phone.key, MAC, nowS() + 23 * 3600) });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal((await said(phone.headers)).connectors.person, true);
  // The same statement sent without its tunnel key, or for another key: refused, nothing changes.
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/session/device-access", headers: phone.bare, payload: vault.deviceAccess(iphone, phone.key, MAC) })).statusCode, 403);
  assert.ok(kept, "it had one before");
});

test("the history unreadable here, or the device not in it: said apart", async () => {
  await setRosterSource(async () => null).refresh();
  assert.equal((await standingOf(phone.headers)).reason, "history_unreadable");
  assert.equal((await said(phone.headers)).connectors.reason, "history_unreadable");
  await setRosterSource(async () => vault.input([iphone])).refresh();
  // A device-access the iPhone's session holds, signed by a key the history does not list for it.
  const row = db.select().from(authSessions).where(eq(authSessions.id, phone.sessionId)).all()[0]!;
  const forged = { ...meshVault(userId).deviceAccess(stranger, phone.key, MAC, nowS() + 3600), vault_device_id: iphone.id };
  db.update(authSessions).set({ deviceAccessJson: JSON.stringify(forged) }).where(eq(authSessions.id, phone.sessionId)).run();
  assert.equal((await standingOf(phone.headers)).reason, "not_in_history");
  db.update(authSessions).set({ deviceAccessJson: row.deviceAccessJson }).where(eq(authSessions.id, phone.sessionId)).run();
  assert.equal((await standingOf(phone.headers)).person, true);
});

// ── E-mails from the person's own devices ────────────────────────────────
const ask = (headers: Record<string, string>, text: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: "/queries", headers, payload: { text, channel: "ios", force_new_discussion: true, document_access: { mode: "off" }, ...extra } });
const offered = () => (bodies.at(-1)?.tools ?? []).map((tool) => tool.function.name);
const eventOf = (body: string, name: string) => {
  const block = body.split("\n\n").find((one) => one.startsWith(`event: ${name}\n`));
  return block ? (JSON.parse(block.slice(block.indexOf("data: ") + 6)) as Record<string, unknown>) : null;
};
const approve = (headers: Record<string, string>, id: string, allow: boolean) => app.inject({ method: "POST", url: "/queries/approval", headers, payload: { id, allow } });
async function waitingId(): Promise<string> {
  for (let i = 0; i < 300; i += 1) {
    const [id] = waitingApprovals(userId);
    if (id) return id;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no approval asked");
}

test("setup: E-mails on, a mailbox linked, from this computer's app only", async () => {
  await app.inject({ method: "PATCH", url: "/local_capabilities/email", headers: mac, payload: { enabled: true } });
  assert.equal((await app.inject({ method: "POST", url: "/email/account", headers: phone.headers, payload: { address: "jimmy@example.org", host: "imap.gmail.com", port: 993, password: mail.password, preset: "gmail" } })).statusCode, 403, "linked on the computer, never from the phone");
  const saved = await app.inject({ method: "POST", url: "/email/account", headers: mac, payload: { address: "jimmy@example.org", host: "imap.gmail.com", port: 993, password: mail.password, preset: "gmail" } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(await syncMailbox(userId), { ok: true, imported: 1 });
});

test("offered to a message from the person's own devices; never to a household member's phone, a device paired by code, nor a token without its tunnel key", async () => {
  for (const [who, headers, expected] of [
    ["this computer's app", mac, true],
    ["Jimmy's iPhone", phone.headers, true],
    ["a household member's phone (rule 2)", household, false],
    ["a device paired by code, no member", kitchen.headers, false],
    ["the iPhone's token, not through its tunnel key", phone.bare, false],
    ["the owner's token from the network", ownerFromNetwork, false],
  ] as const) {
    await ask(headers, "Qu'est-ce que René m'a écrit ?");
    assert.equal(offered().includes("search_emails"), expected, who);
    if (headers !== mac && headers !== ownerFromNetwork) assert.equal((await said(headers)).devices.email, expected, `${who}: devices.email`);
  }
  // Left out of a message, as in « Outils ».
  await ask(phone.headers, "Qu'est-ce que René m'a écrit ?", { capabilities_off: ["email"] });
  assert.ok(!offered().includes("search_emails"));
  // What e-mails say outside the chat stays for this computer's app.
  assert.equal((await app.inject({ url: "/email/recent", headers: phone.headers })).statusCode, 403);
});

test("a draft asked from the iPhone is shown on the iPhone: only its session answers; refused, nothing reaches the mailbox; allowed, the draft only — nothing sent", async () => {
  const [reunion] = searchEmails(userId, { from: "rene", query: "reunion" });
  call = () => ({ name: "draft_email", arguments: { in_reply_to: reunion!.id, body: "Bonjour René,\n\nC'est noté pour lundi 10h.\n\nJimmy" } });
  const refusing = ask(phone.headers, "Réponds à René que c'est d'accord pour lundi");
  const id = await waitingId();
  for (const [who, headers] of [["the household phone", household], ["the iPad paired by code", kitchen.headers], ["the iPhone's token without its key", phone.bare]] as const) {
    assert.equal((await approve(headers, id, true)).statusCode, 404, who);
  }
  assert.equal((await approve(phone.headers, id, false)).statusCode, 200);
  const refused = await refusing;
  assert.equal(eventOf(refused.body, "approval")?.kind, "email_draft");
  assert.equal(eventOf(refused.body, "approval_done")?.allowed, false);
  assert.ok(!mail.log.some((line) => line.startsWith("APPEND")));

  const allowing = ask(phone.headers, "Réponds à René que c'est d'accord pour lundi");
  assert.equal((await approve(phone.headers, await waitingId(), true)).statusCode, 200);
  const allowed = await allowing;
  call = null;
  assert.equal(eventOf(allowed.body, "approval_done")?.allowed, true);
  assert.equal(mail.folders.get("Drafts")!.messages.length, 1);
  assert.ok(!mail.log.some((line) => /SEND|SMTP/i.test(line)), "nothing sent");
});
