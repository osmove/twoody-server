import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Walled-off projects on the person's iPhone (phase 2 of « Cloisonner ce
// projet », 14/10/2026, docs/walled-projects-phone-review.md): the person's
// own device — its device-access signed by a person device of the verified
// roster, not expired, through the tunnel from its own key — lists, opens
// and continues them; nobody else does. Attack tests, one per threat of the
// review: the account (no tunnel, another key's tunnel, a forged or expired
// statement), another computer of the network, a household member's device,
// a device paired by code that is no member of the history, the owner's
// token from the network, a removed device, and the phone itself trying to
// widen the walls. Every name, date and amount is made up.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-walled-phone-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
for (const name of ["TWOODY_USER_TOKEN", "TWOODY_BACKEND_URL", "BRIDGE_LOCAL_LLM_ENDPOINT", "TWOODY_EMBEDDING_BINARY", "TWOODY_EMBEDDING_MODEL", "TWOODY_WEB_BRIDGE_URL", "TWOODY_WEB_BRIDGE_KEY"]) delete process.env[name];

type Body = { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }>; max_tokens?: number };
const bodies: Body[] = [];
const llm = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "qwen" }] })); return; }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    bodies.push(JSON.parse(raw) as Body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Two pieces: the phone's walled-off chat shows them as they come (16/10/2026).
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "La clôture est fixée au 31 mars." } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " Le bilan suit en avril." } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
const llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken, createAuthSession } = await import("../src/auth.js");
const { pairDevice } = await import("../src/pairing.js");
const { setDesktopAccount } = await import("../src/account/service.js");
const { setRosterSource } = await import("../src/vault/roster.js");
const { authSessions, db, sqlite } = await import("../src/db.js");
const { indexStatus, reindex } = await import("../src/documents/library.js");
const { meshVault } = await import("./helpers/meshVault.js");
const { eq } = await import("drizzle-orm");

const MAC = "3e2d1c0b-9a8f-4e7d-8c6b-5a4f3e2d1c0b";
setDesktopAccount({ backendUrl: "http://127.0.0.1:9", userToken: "unused", computerId: MAC, computerName: "Mac" });
const app = await buildApp();
const desktop = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const mac = { authorization: `Bearer ${desktop.json().token}` };
const userId = desktop.json().user_id as string;
await app.inject({ method: "POST", url: "/providers/local", headers: mac, payload: { url: llmUrl, model: "qwen", name: "llama.cpp" } });

const vault = meshVault(userId);
const iphone = vault.person("iPhone de Claire");
vault.desktop("Mac", MAC, iphone);
const outsider = meshVault(userId).person("Pas de l'historique");
await setRosterSource(async () => vault.input([iphone])).refresh();

const sealedFrom = (key: string) => ({ "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": key });
const nowS = () => Math.floor(Date.now() / 1000);
async function pairByCode(name: string) {
  const key = randomBytes(32).toString("hex");
  process.env.TWOODY_PAIRING_CODE = "K7M2Q9XR";
  const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: "k7m2q9xr", device_name: name, tunnel_public_key: key } });
  assert.equal(paired.statusCode, 201, paired.body);
  return { key, sessionId: paired.json().session_id as string, headers: { authorization: `Bearer ${paired.json().token}`, ...sealedFrom(key) }, bare: { authorization: `Bearer ${paired.json().token}` } };
}
// The person's iPhone, its statement signed by its person device.
const phone = await pairByCode("iPhone de Claire");
assert.equal((await app.inject({ method: "POST", url: "/api/v1/session/device-access", headers: phone.headers, payload: vault.deviceAccess(iphone, phone.key, MAC, nowS() + 23 * 3600) })).statusCode, 200);
// A device paired by code with no statement; a household member's phone (endorsed); another computer's peer session.
const kitchen = await pairByCode("iPad de la cuisine");
const householdKey = randomBytes(32).toString("hex");
const household = { authorization: `Bearer ${pairDevice({ deviceName: "iPhone de Paul", tunnelPublicKey: householdKey, origin: "account", approvalRule: "endorsed" }).token}`, ...sealedFrom(householdKey) };
const peerKey = randomBytes(32).toString("hex");
const peer = { authorization: `Bearer ${pairDevice({ deviceName: "peer:Mac mini", role: "peer", origin: "account", requesterComputerId: "4001", tunnelPublicKey: peerKey }).token}`, ...sealedFrom(peerKey) };
const ownerFromNetwork = { ...mac, "x-forwarded-for": "192.168.1.50" };
const ownerOnLan = { authorization: mac.authorization };

// The firm's folder and the walled-off project « Tessane SAS ».
const firm = mkdtempSync(join(process.cwd(), "tmp-walled-phone-"));
mkdirSync(join(firm, "Tessane"));
writeFileSync(join(firm, "Tessane", "lettre-de-mission.txt"), "Lettre de mission Tessane SAS. Honoraires forfaitaires de 7 450 euros hors taxes.");
writeFileSync(join(firm, "procedures.txt"), "Procédures internes du cabinet : archivage dix ans.");
assert.equal((await app.inject({ method: "POST", url: "/local_documents/folders", headers: mac, payload: { path: firm } })).statusCode, 201);
const tessane = (await app.inject({ method: "POST", url: "/api/v1/projects", headers: mac, payload: { title: "Tessane SAS", isolated: true, folder_path: join(firm, "Tessane") } })).json().project as { id: string };
await reindex(userId);
while (indexStatus(userId).running) await new Promise((resolve) => setTimeout(resolve, 20));
const fromMac = await app.inject({ method: "POST", url: "/queries", headers: mac, payload: { text: "Quels honoraires ?", force_new_discussion: true, project_id: tessane.id, document_access: { mode: "all" } } });
const macConversation = /"discussion_id":"([^"]+)"/.exec(fromMac.body)![1]!;
await app.inject({ method: "POST", url: `/api/v1/projects/${tessane.id}/notes`, headers: mac, payload: { content: "La DAF est Mme Varlin." } });

test.after(async () => {
  setRosterSource(null);
  setDesktopAccount(null);
  delete process.env.TWOODY_PAIRING_CODE;
  await app.close();
  await new Promise((resolve) => llm.close(resolve));
  rmSync(firm, { recursive: true, force: true });
});

async function ask(headers: Record<string, string>, payload: Record<string, unknown>) {
  const before = bodies.length;
  const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { channel: "keyboard", ...payload } });
  return { response, discussionId: /"discussion_id":"([^"]+)"/.exec(response.body)?.[1] ?? null, sent: bodies.slice(before).filter((body) => body.max_tokens !== 1) };
}
const lists = async (headers: Record<string, string>) => {
  const body = (await app.inject({ url: "/api/v1/projects", headers })).json() as unknown;
  return Array.isArray(body) && (body as Array<{ id: string }>).some((project) => project.id === tessane.id);
};

test("the person's iPhone, through its own tunnel: lists the project, opens it (no path of the computer), its notes and conversations", async () => {
  assert.equal(await lists(phone.headers), true);
  const detail = await app.inject({ url: `/api/v1/projects/${tessane.id}`, headers: phone.headers });
  assert.equal(detail.statusCode, 200, detail.body);
  const project = detail.json().project as { isolated: boolean; notes: Array<{ content: string }>; conversations: Array<{ id: string }>; folders: Array<Record<string, unknown>> };
  assert.equal(project.isolated, true);
  assert.ok(project.notes.some((note) => /Varlin/.test(note.content)));
  assert.ok(project.conversations.some((conversation) => conversation.id === macConversation));
  assert.equal(project.folders.length, 1);
  assert.equal(project.folders[0]!.path, undefined, "the computer's paths stay on it");
  assert.doesNotMatch(detail.body, new RegExp(firm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const conversations = (await app.inject({ url: `/discussions?project=${tessane.id}`, headers: phone.headers })).json().discussions as Array<{ id: string; isolated: boolean }>;
  assert.ok(conversations.some((row) => row.id === macConversation && row.isolated));
  const opened = await app.inject({ url: `/discussions/${macConversation}`, headers: phone.headers });
  assert.equal(opened.statusCode, 200);
  assert.equal(opened.json().isolated_project.id, tessane.id);
  assert.doesNotMatch(opened.body, new RegExp(firm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no path in its sources");
  // A note added from it.
  assert.equal((await app.inject({ method: "POST", url: `/api/v1/projects/${tessane.id}/notes`, headers: phone.headers, payload: { content: "Inventaire le 28 octobre." } })).statusCode, 201);
});

test("the person's iPhone continues one and starts one: its documents and notes, never sealed, nothing learned", async () => {
  const continued = await ask(phone.headers, { content: "Et les honoraires ?", discussion_id: macConversation, document_access: { mode: "all" }, vault_ref: "phone-ref-1" });
  assert.equal(continued.response.statusCode, 200, continued.response.body);
  assert.match(continued.sent.map((body) => JSON.stringify(body.messages)).join(), /7 450/);
  const started = await ask(phone.headers, { content: "Qui est la DAF ?", force_new_discussion: true, project_id: tessane.id, document_access: { mode: "all" } });
  assert.equal(started.response.statusCode, 200, started.response.body);
  assert.match(started.sent[0]!.messages[0]!.content, /walled-off project « Tessane SAS »/);
  assert.match(started.sent[0]!.messages[0]!.content, /Varlin/);
  const row = sqlite.prepare("SELECT d.project_id, d.vault_id FROM discussions d WHERE d.id = ?").get(started.discussionId) as { project_id: string; vault_id: string | null };
  assert.equal(row.project_id, tessane.id);
  assert.equal(row.vault_id, null);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE vault_ref = 'phone-ref-1'").get() as { n: number }).n, 0, "nothing kept for the encrypted history");
});

test("the person's iPhone gets the answer word by word: message events before the final one, in its own sealed reply", async () => {
  const streamed = await ask(phone.headers, { content: "Et la clôture ?", discussion_id: macConversation, document_access: { mode: "all" }, stream: true });
  assert.equal(streamed.response.statusCode, 200, streamed.response.body);
  assert.match(String(streamed.response.headers["content-type"]), /text\/event-stream/);
  const events = [...streamed.response.body.matchAll(/^event: (\w+)\ndata: (.*)$/gm)].map((match) => ({ type: match[1]!, data: match[2]! }));
  const pieces = events.filter((event) => event.type === "message");
  assert.ok(pieces.length >= 2, "the answer comes in pieces, as the model writes it");
  assert.equal(pieces.map((event) => event.data).join(""), "La clôture est fixée au 31 mars. Le bilan suit en avril.");
  const finalAt = events.findIndex((event) => event.type === "final");
  assert.ok(finalAt > events.indexOf(pieces.at(-1)!), "the words come before the final event");
  assert.equal(JSON.parse(events[finalAt]!.data).discussion_id, macConversation);
  // The same turn, asked without the tunnel of the phone's own key: nothing streams.
  const inClear = await app.inject({ method: "POST", url: "/queries", headers: phone.bare, payload: { channel: "keyboard", content: "Et la clôture ?", discussion_id: macConversation, stream: true } });
  assert.doesNotMatch(inClear.body, /event: message/);
  assert.doesNotMatch(inClear.body, /clôture est fixée/);
});

test("the phone cannot widen the walls: what reaches outside, the web, a vault conversation", async () => {
  await app.inject({ method: "PATCH", url: "/api/v1/local_capabilities/contacts", headers: mac, payload: { enabled: true } });
  const at = Date.now();
  sqlite.prepare("INSERT INTO contacts (id, user_id, name, phones, emails, created_at, updated_at) VALUES ('c1', ?, 'René Garnier', '[{\"label\":\"mobile\",\"value\":\"+33 6 00 00 00 07\"}]', '[]', ?, ?)").run(userId, at, at);
  const widened = await ask(phone.headers, { content: "Quel est le numéro de René Garnier ?", discussion_id: macConversation, capabilities_on: ["contacts", "web", "email", "connectors"], web: true, vault_conversation_id: "6f1c2b9e-4d3a-4e8b-9c1d-2a3b4c5d6e7f", document_access: { mode: "all" } });
  assert.equal(widened.response.statusCode, 200, widened.response.body);
  assert.doesNotMatch(widened.sent.map((body) => JSON.stringify(body.messages)).join(), /00 00 00 07/, "capabilities_on is this computer's app's only");
  // The same from this computer's app: switched on for the message.
  const fromApp = await ask(mac, { content: "Quel est le numéro de René Garnier ?", discussion_id: macConversation, capabilities_on: ["contacts"], document_access: { mode: "off" } });
  assert.match(fromApp.sent.map((body) => JSON.stringify(body.messages)).join(), /00 00 00 07/);
});

test("what stays on the computer: making one, its folder, its export, renaming, archiving, deleting it, a conversation moved", async () => {
  for (const [method, url, payload] of [
    ["POST", "/api/v1/projects", { title: "Lefèvre", isolated: true }],
    ["POST", `/api/v1/projects/${tessane.id}/folders`, { path: firm }],
    ["GET", `/api/v1/projects/${tessane.id}/export`],
    ["PATCH", `/api/v1/projects/${tessane.id}`, { title: "Renommé" }],
    ["PATCH", `/api/v1/projects/${tessane.id}`, { status: "done" }],
    ["DELETE", `/api/v1/projects/${tessane.id}`],
    ["POST", `/api/v1/projects/${tessane.id}/unlink`, { discussion_id: macConversation }],
  ] as Array<[string, string, Record<string, unknown>?]>) {
    const response = await app.inject({ method: method as "GET", url, headers: phone.headers, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, 403, `${method} ${url}: ${response.statusCode} ${response.body.slice(0, 160)}`);
  }
  const row = sqlite.prepare("SELECT title, status FROM projects WHERE id = ?").get(tessane.id) as { title: string; status: string };
  assert.deepEqual(row, { title: "Tessane SAS", status: "active" });
});

test("attacks: nobody but the person's own device reaches it — no tunnel, another key's tunnel, a household member's phone, a device paired by code, another computer, the owner's token from the network", async () => {
  const otherKey = { ...phone.bare, ...sealedFrom(randomBytes(32).toString("hex")) };
  for (const [who, headers] of [
    ["the phone's token without its tunnel (the account, or the local network in clear)", phone.bare],
    ["the phone's token through another key's tunnel", otherKey],
    ["a device paired by code, no member of the history", kitchen.headers],
    ["a household member's phone", household],
    ["another computer's peer session", peer],
    ["the owner's token forwarded by a proxy", ownerFromNetwork],
    ["a session made by hand, no tunnel", { authorization: `Bearer ${createAuthSession(userId, "pair:Ordinateur").token}` }],
  ] as const) {
    assert.equal(await lists(headers).catch(() => false), false, who);
    for (const url of [`/api/v1/projects/${tessane.id}`, `/api/v1/projects/${tessane.id}/notes`, `/discussions/${macConversation}`, `/discussions/${macConversation}/memory_notices`]) {
      const status = (await app.inject({ url, headers })).statusCode;
      assert.ok([401, 403, 404].includes(status), `${who} ${url}: ${status}`);
    }
    const compacted = await app.inject({ method: "POST", url: `/discussions/${macConversation}/compact`, headers, payload: {} });
    assert.ok([401, 403, 404].includes(compacted.statusCode), `${who}: compact ${compacted.statusCode}`);
    const listed = await app.inject({ url: "/discussions", headers });
    if (listed.statusCode === 200) assert.ok(!(listed.json().discussions as Array<{ id: string }>).some((row) => row.id === macConversation), who);
    assert.ok([401, 403].includes((await ask(headers, { content: "Et ensuite ?", discussion_id: macConversation })).response.statusCode), `${who}: continue`);
    assert.ok([401, 403].includes((await ask(headers, { content: "Bonjour", force_new_discussion: true, project_id: tessane.id })).response.statusCode), `${who}: start`);
  }
  // The owner's own session on this machine's loopback stays this computer's app.
  assert.equal(await lists(ownerOnLan), true);
});

test("attacks on the statement: forged by a key the history does not list, expired, or the device removed from the history", async () => {
  const row = db.select().from(authSessions).where(eq(authSessions.id, phone.sessionId)).all()[0]!;
  const kept = row.deviceAccessJson;
  const forged = { ...meshVault(userId).deviceAccess(outsider, phone.key, MAC, nowS() + 3600), vault_device_id: iphone.id };
  db.update(authSessions).set({ deviceAccessJson: JSON.stringify(forged) }).where(eq(authSessions.id, phone.sessionId)).run();
  assert.equal(await lists(phone.headers), false, "forged");
  assert.equal((await app.inject({ url: `/discussions/${macConversation}`, headers: phone.headers })).statusCode, 404);
  const expired = vault.deviceAccess(iphone, phone.key, MAC, nowS() - 1);
  db.update(authSessions).set({ deviceAccessJson: JSON.stringify(expired) }).where(eq(authSessions.id, phone.sessionId)).run();
  assert.equal(await lists(phone.headers), false, "expired");
  assert.equal((await ask(phone.headers, { content: "Et ensuite ?", discussion_id: macConversation })).response.statusCode, 403);
  db.update(authSessions).set({ deviceAccessJson: kept }).where(eq(authSessions.id, phone.sessionId)).run();
  assert.equal(await lists(phone.headers), true, "its own statement again");
  // Removed from the history: at once.
  await setRosterSource(async () => vault.input([])).refresh();
  assert.equal(await lists(phone.headers), false, "removed");
  await setRosterSource(async () => vault.input([iphone])).refresh();
  assert.equal(await lists(phone.headers), true);
});

test("its tasks, reminders and traces follow the same rule; the diagnostics shared to the account never carry them", async () => {
  const at = Date.now();
  sqlite.prepare("INSERT INTO tasks (id, user_id, title, project_id, created_at, updated_at) VALUES ('t-w', ?, 'Relancer la DAF', ?, ?, ?)").run(userId, tessane.id, at, at);
  const seen = async (headers: Record<string, string>) => ((await app.inject({ url: "/api/v1/tasks", headers })).json() as Array<{ id: string }>).some((task) => task.id === "t-w");
  assert.equal(await seen(phone.headers), true);
  assert.equal(await seen(household), false);
  assert.equal(await seen(kitchen.headers), false);
  const full = await app.inject({ url: "/diagnostics/full?after=0&limit=50", headers: mac });
  assert.ok(!(full.json().traces as Array<{ discussion_id: string | null }>).some((trace) => trace.discussion_id === macConversation));
});
