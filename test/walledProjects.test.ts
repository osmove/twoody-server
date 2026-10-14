import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Walled-off projects (« Cloisonner ce projet », Jimmy, 14/10/2026 — the
// isolated projects of src/projects/isolation.ts brought back as an option
// of Projects): attack-style tests. Each one is someone or something trying
// to reach a walled-off project's documents, notes, conversations, tasks or
// traces — the general chat, another walled-off project, a phone of the
// person's, another computer of the network, the account (the diagnostics
// it receives, the read-ahead seeds kept on disk), a browser on the
// network — and finding nothing. What test/isolatedProjects.test.ts covers
// (the conversation's own walls) is not repeated; folders shared with
// someone are in test/folderShares.test.ts and folderSharesRead.test.ts
// (« attack 8 », the isolated folder inside a shared one). Every name,
// date and amount here is made up.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-walled-projects-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BACKEND_URL;

// ── A local runtime: « Réponse. », or a list_files call when asked ─────────

type Body = { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }>; max_tokens?: number };
const bodies: Body[] = [];
let nextToolCall: { name: string; arguments: Record<string, unknown> } | null = null;
const runtime = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "qwen" }] })); return; }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw) as Body;
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const call = nextToolCall;
    if (call && body.tools?.some((tool) => tool.function.name === call.name) && !body.messages.some((message) => message.role === "tool")) {
      nextToolCall = null;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Réponse." } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => runtime.listen(0, "127.0.0.1", resolve));
const runtimeUrl = `http://127.0.0.1:${(runtime.address() as AddressInfo).port}/v1`;

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { accountComputers, db, sqlite } = await import("../src/db.js");
const { indexStatus, listFolders, reindex } = await import("../src/documents/library.js");
const { scopedFolders } = await import("../src/documents/retrieval.js");
const { listGrantedFiles } = await import("../src/documents/fileListing.js");
const { listFolder, readFolderRequest } = await import("../src/documents/folderListing.js");
const { browseGranted } = await import("../src/documents/browse.js");
const { spotlightOwner } = await import("../src/documents/spotlightRetrieval.js");
const { setSpotlightEnabled } = await import("../src/documents/spotlight.js");
const { executeLocalTool } = await import("../src/tools.js");
const { pairDevice } = await import("../src/pairing.js");
const { setTrustCheck } = await import("../src/peerDocuments/trust.js");
const { setDesktopAccount } = await import("../src/account/service.js");
const { warmNewConversation } = await import("../src/routes/queries.js");
const { recordTrace } = await import("../src/diagnostics/traces.js");
const { readSecretFile } = await import("../src/secretFile.js");
const { DATA_DIR } = await import("../src/db.js");

setSpotlightEnabled(false);
const SELF = "4c7d1e2a-9b3f-4e8a-a1d2-6f5e4d3c2b1a";
setDesktopAccount({ backendUrl: "http://127.0.0.1:9", userToken: "unused", computerId: SELF, computerName: "Mac" });

const app = await buildApp();
await app.ready();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const owner = paired.json().user_id as string;
const desktopToken = paired.json().token as string;
const desktop = { authorization: `Bearer ${desktopToken}` };
const phoneToken = createAuthSession(owner, "pair:iPhone").token;
const phone = { authorization: `Bearer ${phoneToken}` };
await app.inject({ method: "POST", url: "/providers/local", headers: desktop, payload: { url: runtimeUrl, model: "qwen", name: "llama.cpp" } });

// The firm's folders, under the working directory (the system's temporary
// folder is never searched): Cabinet holds Tessane/ (the walled-off
// project's documents), Courant/ and a template.
const cabinet = mkdtempSync(join(process.cwd(), "tmp-walled-projects-"));
const tessaneDir = join(cabinet, "Tessane");
const tessaneSub = join(tessaneDir, "Pieces");
const lefevreDir = join(cabinet, "Lefevre");
for (const dir of [tessaneDir, tessaneSub, lefevreDir, join(cabinet, "Courant")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(cabinet, "modele-lettre.txt"), "Modèle de lettre. Formule de politesse du cabinet.");
writeFileSync(join(cabinet, "Courant", "note-interne.txt"), "Note interne : la photocopieuse est en panne.");
writeFileSync(join(tessaneDir, "lettre-de-mission.txt"), "Lettre de mission Tessane SAS. Honoraires forfaitaires de 7 450 euros hors taxes. Clôture de l'exercice le 31 mars.");
writeFileSync(join(tessaneSub, "bilan-tessane.txt"), "Bilan Tessane : stocks de 182 300 euros, provision pour litige prud'homal de 26 000 euros.");
writeFileSync(join(lefevreDir, "devis-lefevre.txt"), "Devis Lefèvre : honoraires de 2 980 euros.");

test.after(async () => {
  await app.close();
  await new Promise((resolve) => runtime.close(resolve));
  rmSync(cabinet, { recursive: true, force: true });
});

async function indexed() {
  await reindex(owner);
  while (indexStatus(owner).running) await new Promise((resolve) => setTimeout(resolve, 20));
}

async function ask(payload: Record<string, unknown>, headers: Record<string, string> = desktop) {
  const before = bodies.length;
  const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { channel: "desktop", time_zone: "Europe/Paris", ...payload } });
  const discussionId = /"discussion_id":"([^"]+)"/.exec(response.body)?.[1] ?? null;
  return { response, discussionId, sent: bodies.slice(before).filter((body) => body.max_tokens !== 1) };
}
const everything = (sent: Body[]) => sent.map((body) => body.messages.map((message) => message.content).join("\n")).join("\n");
const SECRET = /7 450|182 300|26 000|Tessane|lettre-de-mission|bilan-tessane|Pieces/;

// The general folder first, as a firm would have it; then the projects.
assert.equal((await app.inject({ method: "POST", url: "/local_documents/folders", headers: desktop, payload: { path: cabinet } })).statusCode, 201);
await indexed();
const made = await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Tessane SAS", isolated: true, brief: "Mission de révision des comptes 2026.", folder_path: tessaneDir } });
const tessane = made.json().project as { id: string; status: string; isolated: boolean; folders: Array<{ id: string }> };
const lefevre = (await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Lefèvre", isolated: true, folder_path: lefevreDir } })).json().project as { id: string };
await indexed();
const cabinetId = listFolders(owner).find((folder) => folder.path === cabinet)!.id;
const tessaneFolderId = tessane.folders[0]!.id;
// A conversation, a note, a task and a reminder of the project.
const inside = await ask({ text: "Retiens que l'expert-comptable de Tessane est Mme Aubert.", force_new_discussion: true, project_id: tessane.id, document_access: { mode: "off" } });
const insideId = inside.discussionId!;
const insideMessage = sqlite.prepare("SELECT id FROM messages WHERE discussion_id = ? AND role = 'assistant' LIMIT 1").get(insideId) as { id: string };
const now = Date.now();
sqlite.prepare("INSERT INTO tasks (id, user_id, title, project_id, created_at, updated_at) VALUES ('t-tessane', ?, 'Relancer Tessane pour le grand livre', ?, ?, ?)").run(owner, tessane.id, now, now);
sqlite.prepare("INSERT INTO reminders (id, user_id, project_id, text, status, channel, reminder_type, created_at, updated_at) VALUES ('r-tessane', ?, ?, 'Inventaire Tessane', 'active', 'push', 'once', ?, ?)").run(owner, tessane.id, now, now);

test("made now, a walled-off project is open (migration 7 closed only those of before); it is walled off once and for all", async () => {
  assert.equal(made.statusCode, 201, made.body);
  assert.equal(tessane.isolated, true);
  assert.equal(tessane.status, "active");
  assert.equal(inside.response.statusCode, 200, inside.response.body);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/v1/projects/${tessane.id}`, headers: desktop, payload: { isolated: false } })).json().error, "isolated_fixed");
  // A project made plain is never walled off afterwards: what it learned is elsewhere already.
  const plain = (await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Déménagement" } })).json().project as { id: string };
  assert.equal((await app.inject({ method: "PATCH", url: `/api/v1/projects/${plain.id}`, headers: desktop, payload: { isolated: true } })).json().error, "isolated_fixed");
});

test("the general chat: its documents, its listing and the list_files tool never reach the project's folder inside a granted one", async () => {
  const asked = await ask({ text: "Quels sont les honoraires de la lettre de mission ?", force_new_discussion: true, document_access: { mode: "all" } });
  assert.equal(asked.response.statusCode, 200);
  assert.doesNotMatch(everything(asked.sent), /7 450|182 300/);
  // « Liste les fichiers de Cabinet », the tool asked for the project's folder by its path, its name, recursively.
  const listed = await ask({ text: `Quels fichiers y a-t-il dans le dossier ${cabinet.split("/").pop()} ?`, force_new_discussion: true, document_access: { mode: "all" } });
  assert.doesNotMatch(everything(listed.sent), SECRET);
  for (const folder of [`${cabinet.split("/").pop()}/Tessane`, "Tessane", "Pieces", tessaneDir, `${cabinet.split("/").pop()}`]) {
    nextToolCall = { name: "list_files", arguments: { folder, recursive: true } };
    const tool = await ask({ text: "Montre-moi ce dossier.", force_new_discussion: true, document_access: { mode: "all" } });
    const toolResult = tool.sent.flatMap((body) => body.messages.filter((message) => message.role === "tool").map((message) => message.content)).join("\n");
    assert.ok(tool.sent.some((body) => body.messages.some((message) => message.role === "tool")), `list_files called for ${folder}`);
    assert.doesNotMatch(toolResult, /lettre-de-mission|bilan-tessane|devis-lefevre|- Pieces|Pieces\//, folder);
  }
  nextToolCall = null;
});

test("the walkers themselves: listings, folders found by name, browsing and Spotlight's reading stop at the wall", async () => {
  const outside = listFolders(owner).filter((folder) => folder.project_id === null);
  assert.deepEqual(outside.find((folder) => folder.id === cabinetId)?.walled.sort(), [lefevreDir, tessaneDir].sort());
  const every = await listGrantedFiles({ intent: { folder: null, folderName: null, sort: "name", kinds: [], limit: 30 }, roots: outside, granted: listFolders(owner) });
  assert.ok(every.files.some((file) => file.name === "note-interne.txt"));
  assert.ok(!every.files.some((file) => /tessane|lettre-de-mission|lefevre/i.test(file.name)), JSON.stringify(every.files));
  const named = await listGrantedFiles({ intent: { folder: null, folderName: "Pieces", sort: "name", kinds: [], limit: 30 }, roots: outside, granted: outside });
  assert.equal(named.files.length, 0);
  assert.notEqual(named.status, "ok");
  for (const folder of ["Tessane", `${cabinet.split("/").pop()}/Tessane/Pieces`, tessaneSub]) {
    const one = await listFolder({ request: readFolderRequest({ folder, recursive: true })!, roots: outside, granted: outside });
    assert.notEqual(one.status, "ok", folder);
    assert.equal(one.files.length, 0, folder);
  }
  const top = await listFolder({ request: readFolderRequest({ folder: cabinet.split("/").pop()!, recursive: false })!, roots: outside, granted: outside });
  assert.equal(top.status, "ok");
  assert.deepEqual(top.folders.map((folder) => folder.name), ["Courant"]);
  // Inside its own project, it is all there.
  const own = scopedFolders(owner, { mode: "all" }, { project: tessane.id });
  const mine = await listGrantedFiles({ intent: { folder: null, folderName: null, sort: "name", kinds: [], limit: 30 }, roots: own, granted: own });
  assert.deepEqual(mine.files.map((file) => file.name).sort(), ["bilan-tessane.txt", "lettre-de-mission.txt"]);
  // Browsing the general folder (this computer's app, every folder).
  const all = scopedFolders(owner, { mode: "all" }, { withIsolated: true });
  const browsed = await browseGranted(owner, all, { root: cabinetId, path: "", sort: "name", order: "asc", offset: 0, limit: 50, q: null });
  assert.ok("entries" in browsed);
  assert.ok(!browsed.entries.some((entry) => entry.name === "Tessane" || entry.name === "Lefevre"));
  assert.deepEqual(await browseGranted(owner, all, { root: cabinetId, path: "Tessane", sort: "name", order: "asc", offset: 0, limit: 50, q: null }), { error: "not_found" });
  const searched = await browseGranted(owner, all, { root: cabinetId, path: "", sort: "name", order: "asc", offset: 0, limit: 50, q: "tessane" });
  assert.ok("entries" in searched && searched.entries.length === 0, JSON.stringify(searched));
  // Through the project's own folder, it is browsed.
  const own2 = await browseGranted(owner, all, { root: tessaneFolderId, path: "", sort: "name", order: "asc", offset: 0, limit: 50, q: null });
  assert.ok("entries" in own2 && own2.entries.some((entry) => entry.name === "lettre-de-mission.txt"));
  // A file Spotlight finds there is no file of the general folder.
  assert.equal(spotlightOwner(join(tessaneSub, "bilan-tessane.txt"), outside), null);
  assert.equal(spotlightOwner(join(cabinet, "modele-lettre.txt"), outside)?.id, cabinetId);
  // An MCP client's list_files (src/tools.ts), the general folder's way.
  const tool = await executeLocalTool("list_files", { folder: "Tessane" }, { userId: owner }) as { files: Array<{ name: string }> };
  assert.equal(tool.files.length, 0);
});

test("another walled-off project's conversation: none of the first one's documents, notes or summary", async () => {
  const asked = await ask({ text: "Quels sont les honoraires de la lettre de mission ? Qui est l'expert-comptable ?", force_new_discussion: true, project_id: lefevre.id, document_access: { mode: "all" } });
  assert.equal(asked.response.statusCode, 200);
  assert.doesNotMatch(everything(asked.sent), /7 450|182 300|Aubert|révision des comptes/);
  assert.match(everything(asked.sent), /2 980/, "its own documents");
  nextToolCall = { name: "list_files", arguments: { folder: "Tessane", recursive: true } };
  const tool = await ask({ text: "Liste ce dossier.", force_new_discussion: true, project_id: lefevre.id, document_access: { mode: "all" } });
  nextToolCall = null;
  assert.doesNotMatch(tool.sent.flatMap((body) => body.messages.filter((message) => message.role === "tool").map((message) => message.content)).join("\n"), /lettre-de-mission|bilan/);
});

test("the person's phone (a pair: session): the project, its notes, conversations, tasks, reminders, documents and traces do not exist", async () => {
  const projects = (await app.inject({ url: "/api/v1/projects", headers: phone })).json() as Array<{ id: string }>;
  assert.ok(!projects.some((project) => project.id === tessane.id));
  assert.deepEqual((await app.inject({ url: "/api/v1/projects?isolated=1", headers: phone })).json(), []);
  for (const [method, url, payload] of [
    ["GET", `/api/v1/projects/${tessane.id}`],
    ["GET", `/api/v1/projects/${tessane.id}/notes`],
    ["POST", `/api/v1/projects/${tessane.id}/notes`, { content: "Une note glissée depuis ailleurs." }],
    ["PATCH", `/api/v1/projects/${tessane.id}`, { title: "Renommé" }],
    ["DELETE", `/api/v1/projects/${tessane.id}`],
    ["GET", `/api/v1/projects/${tessane.id}/export`],
    ["GET", `/discussions/${insideId}`],
    ["PATCH", `/discussions/${insideId}`, { memory_mode: "none" }],
    ["DELETE", `/discussions/${insideId}`],
    ["GET", `/discussions/${insideId}/memory_notices`],
    ["GET", "/api/v1/tasks/t-tessane"],
    ["PATCH", "/api/v1/tasks/t-tessane", { task: { title: "x" } }],
    ["DELETE", "/api/v1/tasks/t-tessane"],
    ["GET", "/api/v1/reminders/r-tessane"],
    ["PATCH", "/api/v1/reminders/r-tessane", { reminder: { text: "x" } }],
    ["DELETE", "/api/v1/reminders/r-tessane"],
  ] as Array<[string, string, Record<string, unknown>?]>) {
    const response = await app.inject({ method: method as "GET", url, headers: phone, ...(payload ? { payload } : {}) });
    assert.ok(response.statusCode === 404 || response.statusCode === 403, `${method} ${url}: ${response.statusCode} ${response.body.slice(0, 200)}`);
  }
  assert.ok(sqlite.prepare("SELECT 1 FROM discussions WHERE id = ?").get(insideId), "still there");
  assert.ok(sqlite.prepare("SELECT 1 FROM tasks WHERE id = 't-tessane'").get(), "still there");
  assert.equal((sqlite.prepare("SELECT status FROM reminders WHERE id = 'r-tessane'").get() as { status: string }).status, "active");
  assert.ok(!((await app.inject({ url: "/api/v1/tasks", headers: phone })).json() as Array<{ id: string }>).some((task) => task.id === "t-tessane"));
  assert.ok(!((await app.inject({ url: "/api/v1/reminders", headers: phone })).json() as Array<{ id: string }>).some((reminder) => reminder.id === "r-tessane"));
  assert.ok(((await app.inject({ url: "/api/v1/tasks", headers: desktop })).json() as Array<{ id: string }>).some((task) => task.id === "t-tessane"), "this computer's app sees them");
  // A reminder put into it from elsewhere, or taken out of it.
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/reminders", headers: phone, payload: { reminder: { text: "Glissé", project_id: tessane.id } } })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/v1/reminders/r-tessane", headers: desktop, payload: { reminder: { project_id: null } } })).json().error, "isolated_reminder");
  // Conversations: not listed, not found, not continued, not started there.
  assert.ok(!((await app.inject({ url: "/discussions", headers: phone })).json().discussions as Array<{ id: string }>).some((row) => row.id === insideId));
  assert.equal((await ask({ text: "Et ensuite ?", discussion_id: insideId }, phone)).response.statusCode, 403);
  assert.equal((await ask({ text: "Bonjour", force_new_discussion: true, project_id: tessane.id }, phone)).response.statusCode, 403);
  // Its documents: not searched, not read, not browsed, not known.
  const passages = (await app.inject({ url: "/local_documents/search?q=honoraires", headers: phone })).json().passages as Array<{ name: string }>;
  assert.ok(!passages.some((passage) => /tessane|lettre-de-mission/i.test(passage.name)));
  const document = sqlite.prepare("SELECT id, path FROM documents WHERE name = 'lettre-de-mission.txt'").get() as { id: string; path: string };
  for (const url of [`/local_documents/files/${document.id}`, `/local_documents/files/${document.id}/raw`, `/local_documents/files?folder_id=${tessaneFolderId}`, `/local_documents/browse?root=${tessaneFolderId}&path=`, `/local_documents/browse?root=${cabinetId}&path=Tessane`, `/local_documents/browse/raw?root=${cabinetId}&path=${encodeURIComponent("Tessane/lettre-de-mission.txt")}`]) {
    const response = await app.inject({ url, headers: phone });
    assert.ok(response.statusCode === 404 || response.statusCode === 400, `${url}: ${response.statusCode}`);
  }
  assert.equal((await app.inject({ url: `/local_documents/known?path=${encodeURIComponent(document.path)}`, headers: phone })).json().known, false);
  assert.equal((await app.inject({ url: `/local_documents/known?path=${encodeURIComponent(document.path)}`, headers: desktop })).json().known, true);
  const folders = (await app.inject({ url: "/local_documents/folders", headers: phone })).json().folders as Array<{ id: string }>;
  assert.ok(!folders.some((folder) => folder.id === tessaneFolderId));
  // Its traces: neither the list nor an answer's.
  const traces = (await app.inject({ url: "/diagnostics/turns?limit=200", headers: phone })).json().traces as Array<{ discussion_id: string | null }>;
  assert.ok(traces.length > 0, "the others are listed");
  assert.ok(!traces.some((trace) => trace.discussion_id === insideId));
  assert.equal((await app.inject({ url: `/diagnostics/turns?message_id=${insideMessage.id}`, headers: phone })).statusCode, 404);
  assert.equal((await app.inject({ url: `/diagnostics/messages/${insideMessage.id}`, headers: phone })).statusCode, 404);
  assert.equal((await app.inject({ url: `/diagnostics/messages/${insideMessage.id}`, headers: desktop })).statusCode, 200, "this computer's app sees them");
});

test("the person's phone over the websocket: no event of a walled-off conversation; this computer's app gets them", async () => {
  const listen = (token: string) => {
    const received: Array<{ type: string; discussion_id?: string }> = [];
    let socket: { terminate(): void } | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      void app.injectWS(`/ws?token=${encodeURIComponent(token)}`, {}, {
        onInit: (ws) => {
          socket = ws;
          ws.on("message", (raw: Buffer) => {
            const message = JSON.parse(raw.toString()) as { type: string; discussion_id?: string };
            if (message.type === "hello") resolve();
            received.push(message);
          });
          ws.once("error", reject);
        },
      }).catch(reject);
    });
    return { ready, received, close: () => (socket as { terminate(): void } | null)?.terminate() };
  };
  // Injected, a socket has no address: it is never this machine here, so
  // the phone's socket is the real one and this computer's app is asked of
  // the filter itself (a socket of this machine reaches them, routes/ws.ts).
  const { eventReaches } = await import("../src/routes/ws.js");
  const event = { kind: "message.appended" as const, userId: owner, discussionId: insideId, role: "user" as const };
  assert.equal(eventReaches(event, owner, true), true);
  assert.equal(eventReaches(event, owner, false), false);
  assert.equal(eventReaches({ ...event, discussionId: "elsewhere" }, owner, false), true);
  assert.equal(eventReaches(event, "someone-else", true), false);
  const onPhone = listen(phoneToken);
  await onPhone.ready;
  await ask({ text: "Prépare le dossier de révision.", discussion_id: insideId, document_access: { mode: "off" } });
  const general = await ask({ text: "Bonjour", force_new_discussion: true, document_access: { mode: "off" } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  onPhone.close();
  assert.ok(!onPhone.received.some((event) => event.discussion_id === insideId), JSON.stringify(onPhone.received));
  assert.ok(onPhone.received.some((event) => event.discussion_id === general.discussionId), "the others still reach it");
});

test("another computer of the person's network (a trusted peer): nothing of the project in a search, a listing, a browse, a file", async () => {
  const inRoster = new Set<string>(["5001"]);
  setTrustCheck(async (id: string) => inRoster.has(id));
  const tunnelKey = randomBytes(32).toString("hex");
  const session = pairDevice({ deviceName: "Mac mini", role: "peer", origin: "account", requesterComputerId: "5001", tunnelPublicKey: tunnelKey });
  const at = new Date();
  db.insert(accountComputers).values({ computerId: "5001", userId: owner, name: "Mac mini", state: "linked", trusted: true, enabled: true, createdAt: at, updatedAt: at }).run();
  const peer = { authorization: `Bearer ${session.token}`, "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": tunnelKey };
  const searched = await app.inject({ method: "POST", url: "/api/v1/peer/documents/search", headers: peer, payload: { q: "honoraires lettre de mission bilan", scope: { mode: "all" } } });
  assert.equal(searched.statusCode, 200, searched.body);
  assert.doesNotMatch(searched.body, /7 450|182 300|2 980|lettre-de-mission|bilan-tessane/);
  const folders = await app.inject({ url: "/api/v1/peer/documents/folders", headers: peer });
  assert.equal(folders.statusCode, 200);
  assert.doesNotMatch(folders.body, /Tessane|Lefevre/);
  for (const payload of [{ folder_name: "Tessane", scope: { mode: "all" } }, { folder_name: "Pieces", scope: { mode: "all" } }, { scope: { mode: "all" } }]) {
    const listed = await app.inject({ method: "POST", url: "/api/v1/peer/documents/list", headers: peer, payload });
    assert.doesNotMatch(listed.body, /lettre-de-mission|bilan-tessane|devis-lefevre/, JSON.stringify(payload));
  }
  const browsed = await app.inject({ url: `/api/v1/peer/documents/browse?root=${cabinetId}&path=`, headers: peer });
  assert.equal(browsed.statusCode, 200, browsed.body);
  assert.doesNotMatch(browsed.body, /Tessane|Lefevre/);
  for (const url of [
    `/api/v1/peer/documents/browse?root=${cabinetId}&path=Tessane`,
    `/api/v1/peer/documents/browse?root=${tessaneFolderId}&path=`,
    `/api/v1/peer/documents/browse/raw?root=${cabinetId}&path=${encodeURIComponent("Tessane/lettre-de-mission.txt")}`,
    `/api/v1/peer/documents/files/${(sqlite.prepare("SELECT id FROM documents WHERE name = 'lettre-de-mission.txt'").get() as { id: string }).id}`,
    `/api/v1/peer/documents/files/${(sqlite.prepare("SELECT id FROM documents WHERE name = 'lettre-de-mission.txt'").get() as { id: string }).id}/raw`,
  ]) {
    const response = await app.inject({ url, headers: peer });
    assert.ok(response.statusCode === 404 || response.statusCode === 400, `${url}: ${response.statusCode} ${response.body.slice(0, 200)}`);
  }
  // Its conversations, memories and history: a peer session reaches /api/v1/peer/* only (test/peerScope.test.ts).
  assert.ok([401, 403].includes((await app.inject({ url: `/discussions/${insideId}`, headers: peer })).statusCode));
});

test("what goes to the account: the diagnostics shared never carry a walled-off project's traces, even when every detail is ticked", async () => {
  // A trace of its conversation, and one of its start read ahead.
  recordTrace(owner, { kind: "warm", model: "qwen", outcome: "answered", totalMs: 5, detail: { system_chars: 10, tools: [], isolated: true } });
  const all = sqlite.prepare("SELECT COUNT(*) AS n FROM message_traces WHERE discussion_id = ?").get(insideId) as { n: number };
  assert.ok(all.n > 0, "traced here, for this computer's Diagnostic screen");
  for (const url of ["/diagnostics/telemetry?after=0&limit=50", "/diagnostics/full?after=0&limit=50"]) {
    let after = 0;
    for (let page = 0; page < 20; page += 1) {
      const response = await app.inject({ url: url.replace("after=0", `after=${after}`), headers: desktop });
      assert.equal(response.statusCode, 200);
      const body = response.json() as { events?: Array<{ metadata: Record<string, unknown> }>; traces?: Array<{ discussion_id: string | null; trace: Record<string, unknown> }>; next: number };
      // What the general chat asked (« la lettre de mission ») is its own;
      // nothing the project holds or was told is there.
      assert.doesNotMatch(response.body, /7 450|182 300|26 000|Aubert|révision des comptes|lettre-de-mission\.txt|bilan-tessane\.txt|clôture/, url);
      for (const trace of body.traces ?? []) {
        assert.notEqual(trace.discussion_id, insideId);
        assert.notEqual(trace.trace.isolated, true);
      }
      if (page === 0) assert.ok((body.events ?? body.traces ?? []).length > 0, `the others are shared: ${url}`);
      if (body.next === after) break;
      after = body.next;
    }
  }
});

test("the read-ahead seeds kept on disk: nothing of a walled-off project, not even its id", async () => {
  const file = join(DATA_DIR, "warm-seeds.json");
  const seeds = () => readSecretFile(file) ?? readFileSync(file, "utf8");
  await ask({ text: "Bonjour", force_new_discussion: true, document_access: { mode: "off" } });
  assert.ok(existsSync(file), "the person's own start is kept");
  // Right after a turn inside it, and its start read ahead.
  await ask({ text: "Et la clôture ?", discussion_id: insideId, document_access: { mode: "off" } });
  await app.inject({ method: "POST", url: "/queries/warm", headers: desktop, payload: { project_id: tessane.id } });
  await warmNewConversation(`${owner}|project:${tessane.id}`, { wake: true });
  assert.doesNotMatch(seeds(), new RegExp(`${tessane.id}|${lefevre.id}|Tessane|project:`));
  await ask({ text: "Bonjour", force_new_discussion: true, document_access: { mode: "off" } });
  assert.doesNotMatch(seeds(), new RegExp(`${tessane.id}|${lefevre.id}|Tessane|project:`));
});

test("nothing comes in: a conversation of elsewhere, a memory of elsewhere, a project's card", async () => {
  // A fact learned elsewhere, a project card's project.
  sqlite.prepare("INSERT INTO memories (id, user_id, kind, title, content, tags, source, created_at, updated_at) VALUES ('m-elsewhere', ?, 'user', 'Garage', 'La voiture de Jimmy est au garage Durand.', '[\"learned\"]', 'conversation', ?, ?)").run(owner, now, now);
  const asked = await ask({ text: "Où est la voiture ?", discussion_id: insideId, document_access: { mode: "off" } });
  assert.doesNotMatch(everything(asked.sent), /garage Durand/);
  const general = await ask({ text: "Qui est l'expert-comptable ? Où en est la mission ?", force_new_discussion: true, document_access: { mode: "all" } });
  assert.doesNotMatch(everything(general.sent), /Aubert|révision des comptes|Tessane/);
  // « Retiens que » inside went to its notes, never to memories.
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM memories WHERE content LIKE '%Aubert%'").get() as { n: number }).n, 0);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM project_notes WHERE project_id = ? AND content LIKE '%Aubert%'").get(tessane.id) as { n: number }).n, 1);
});

test("a folder shared with someone (the account relays it, sealed): the project's folder is never shared, nor served from a folder holding it", async () => {
  // The sealed requests themselves: test/folderShares.test.ts and
  // folderSharesRead.test.ts (« attack 8 », an isolated folder inside the
  // shared one: not listed, searched, browsed nor read). The account's
  // bridge in clear: refused before it runs (test/bridgePlaintext.test.ts).
  const { folderUnshareable, isolatedInside } = await import("../src/shares/policy.js");
  assert.equal(folderUnshareable(owner, tessaneFolderId), "isolated");
  const sub = listFolders(owner).find((folder) => folder.path === tessaneSub);
  assert.equal(sub, undefined, "its sub-folder is no grant of its own");
  assert.deepEqual(isolatedInside(owner, cabinet).sort(), [lefevreDir, tessaneDir].sort());
  assert.equal(folderUnshareable(owner, cabinetId), null, "the general folder may be shared — without them");
});
