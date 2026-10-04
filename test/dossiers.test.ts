import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Client files (Jimmy, 04/10/2026, Twoody Pro: « dossiers clients
// cloisonnés »): a file's documents, conversations and notes reach none of
// its other conversations' neighbours — another file, a conversation outside
// any, another computer, the account, the person's memory. Every name, date
// and amount here is made up.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-dossiers-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

// ── A local runtime that answers « Réponse. » and keeps what it was sent ────

type Body = { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }>; max_tokens?: number };
const bodies: Body[] = [];
const runtime = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "qwen" }] })); return; }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    bodies.push(JSON.parse(raw) as Body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Réponse." } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => runtime.listen(0, "127.0.0.1", resolve));
const runtimeUrl = `http://127.0.0.1:${(runtime.address() as AddressInfo).port}/v1`;

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { indexStatus, listFolders, reindex } = await import("../src/documents/library.js");
const { scopedFolders } = await import("../src/documents/retrieval.js");
const { dossierContext } = await import("../src/dossiers/dossiers.js");
const { pendingDiscussions, learnDiscussion } = await import("../src/memory/learner.js");
const { searchConversations } = await import("../src/memory/search.js");
const { newConversationSystem } = await import("../src/routes/queries.js");
const { SCHEMA_VERSION } = await import("../src/migrations/index.js");

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const owner = paired.json().user_id as string;
const desktop = { authorization: `Bearer ${paired.json().token}` };
const phone = { authorization: `Bearer ${createAuthSession(owner, "pair:iPhone").token}` };
await app.inject({ method: "POST", url: "/providers/local", headers: desktop, payload: { url: runtimeUrl, model: "qwen", name: "llama.cpp" } });

// The firm's folders: not under the system's temporary folder, which is
// never searched. Cabinet holds a template; Cabinet/Dupont the Dupont file's
// documents; Cabinet/Martin the Martin file's.
const cabinet = mkdtempSync(join(process.cwd(), "tmp-dossiers-"));
mkdirSync(join(cabinet, "Dupont"));
mkdirSync(join(cabinet, "Martin"));
writeFileSync(join(cabinet, "modele-lettre.txt"), "Modèle de lettre de mise en demeure. Formule de politesse du cabinet : veuillez agréer.");
writeFileSync(join(cabinet, "Dupont", "assignation.txt"), "Assignation Dupont contre SCI Les Lilas. La clause pénale prévoit 4 800 euros. Audience le 12 novembre 2026.");
writeFileSync(join(cabinet, "Martin", "bail.txt"), "Bail commercial Martin. La clause pénale du bail prévoit 9 300 euros.");

test.after(async () => {
  await app.close();
  await new Promise((resolve) => runtime.close(resolve));
  rmSync(cabinet, { recursive: true, force: true });
});

async function indexed() {
  await reindex(owner);
  while (indexStatus(owner).running) await new Promise((resolve) => setTimeout(resolve, 20));
}

/// A message, as the desktop sends it: what it answered, and what the
/// runtime was given (warm-ups left out).
async function ask(payload: Record<string, unknown>, headers: Record<string, string> = desktop) {
  const before = bodies.length;
  const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { channel: "desktop", time_zone: "Europe/Paris", ...payload } });
  const discussionId = /"discussion_id":"([^"]+)"/.exec(response.body)?.[1] ?? null;
  return { response, discussionId, sent: bodies.slice(before).filter((body) => body.max_tokens !== 1) };
}
const system = (sent: Body[]) => sent[0]!.messages[0]!.content;
const lastUser = (sent: Body[]) => sent[0]!.messages.at(-1)!.content;

// The general folder first, as a firm would have it; then the files.
const general = await app.inject({ method: "POST", url: "/local_documents/folders", headers: desktop, payload: { path: cabinet } });
assert.equal(general.statusCode, 201, general.body);
await indexed();
const created = await app.inject({ method: "POST", url: "/api/v1/dossiers", headers: desktop, payload: { title: "Dupont c/ SCI Les Lilas", reference: "2026-014", brief: "Bail d'habitation, impayés depuis mars.", folder_path: join(cabinet, "Dupont") } });
const dupont = created.json().dossier as { id: string; folders: Array<{ id: string; path: string }> };
const martin = (await app.inject({ method: "POST", url: "/api/v1/dossiers", headers: desktop, payload: { title: "Martin", folder_path: join(cabinet, "Martin") } })).json().dossier as { id: string };

test("migration 6 brings the client files' tables and columns", () => {
  assert.ok(SCHEMA_VERSION >= 6);
  const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dossier%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  assert.deepEqual(tables, ["dossier_notes", "dossiers"]);
  const columns = (table: string) => (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(columns("discussions").includes("dossier_id"));
  assert.ok(columns("document_folders").includes("dossier_id"));
});

test("a client file is made with the folder of its documents; its documents are its own at once", async () => {
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(dupont.folders.length, 1);
  assert.equal(dupont.folders[0]!.path.endsWith("Dupont"), true);
  // Indexed under Cabinet before: moved to the file's folder before the next pass.
  const holder = sqlite.prepare("SELECT folder_id FROM documents WHERE name = 'assignation.txt'").get() as { folder_id: string };
  assert.equal(holder.folder_id, dupont.folders[0]!.id);
  await indexed();
  const folders = listFolders(owner);
  assert.equal(folders.find((folder) => folder.path === cabinet)?.dossier_id, null);
  assert.equal(folders.find((folder) => folder.path.endsWith("Dupont"))?.dossier_id, dupont.id);
  // Searched by no one else: another computer, the account's tools.
  assert.deepEqual(scopedFolders(owner, { mode: "all" }).map((folder) => folder.path), [cabinet]);
  assert.equal(scopedFolders(owner, { mode: "all" }, { dossier: dupont.id }).length, 1);
  assert.equal(scopedFolders(owner, { mode: "all" }, { withDossiers: true }).length, 3);
  // A folder inside another file's, or holding it: refused.
  const clash = await app.inject({ method: "POST", url: `/api/v1/dossiers/${martin.id}/folders`, headers: desktop, payload: { path: join(cabinet, "Dupont") } });
  assert.equal(clash.statusCode, 409);
  assert.equal(clash.json().error, "other_dossier_folder");
});

test("this computer's app only: a phone neither lists the files nor sees their folders, documents or conversations", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/dossiers", headers: phone })).statusCode, 403);
  const listed = (await app.inject({ method: "GET", url: "/local_documents/folders", headers: phone })).json().folders as Array<{ path: string }>;
  assert.deepEqual(listed.map((folder) => folder.path), [cabinet]);
  const mine = (await app.inject({ method: "GET", url: "/local_documents/folders", headers: desktop })).json().folders as Array<{ dossier_id: string | null }>;
  assert.equal(mine.filter((folder) => folder.dossier_id).length, 2);
  const document = sqlite.prepare("SELECT id FROM documents WHERE name = 'assignation.txt'").get() as { id: string };
  assert.equal((await app.inject({ method: "GET", url: `/local_documents/files/${document.id}`, headers: phone })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/local_documents/files/${document.id}`, headers: desktop })).statusCode, 200);
  // The context a conversation held elsewhere asks for: never a file's documents.
  const context = await app.inject({ method: "POST", url: "/local_documents/context", headers: desktop, payload: { question: "clause pénale", document_access: { mode: "all" } } });
  assert.doesNotMatch(context.json().context, /4 800|9 300/);
  // A conversation started in a file from the phone: refused.
  const fromPhone = await ask({ text: "Bonjour", force_new_discussion: true, dossier_id: dupont.id }, phone);
  assert.equal(fromPhone.response.statusCode, 403);
});

test("documents: a file's conversation reads its own only; one outside any file, none of the files'", async () => {
  const inDupont = await ask({ text: "Que prévoit la clause pénale ?", force_new_discussion: true, dossier_id: dupont.id, document_access: { mode: "only" } });
  assert.equal(inDupont.response.statusCode, 200, inDupont.response.body);
  assert.match(lastUser(inDupont.sent), /4 800 euros/);
  assert.doesNotMatch(lastUser(inDupont.sent), /9 300|Modèle de lettre/);
  const outside = await ask({ text: "Que prévoit la clause pénale ?", force_new_discussion: true, document_access: { mode: "only" } });
  assert.doesNotMatch(lastUser(outside.sent), /4 800|9 300/);
  // The folder named outside its file is not granted there.
  const inMartin = await ask({ text: "Que prévoit la clause pénale ?", force_new_discussion: true, dossier_id: martin.id, document_access: { mode: "only" } });
  assert.match(lastUser(inMartin.sent), /9 300 euros/);
  assert.doesNotMatch(lastUser(inMartin.sent), /4 800/);
});

test("memory: the file's notes in its conversations only; of the person's memory, only what they wrote or pinned themselves", async () => {
  const now = Date.now();
  sqlite.prepare("INSERT INTO memories (id, user_id, kind, title, content, tags, source, created_at, updated_at) VALUES (?, ?, 'user', ?, ?, '[]', 'manual', ?, ?)")
    .run("m-own", owner, "Signature", "Signe ses courriers « Maître Claire Martin ».", now, now);
  sqlite.prepare("INSERT INTO memories (id, user_id, kind, title, content, tags, source, created_at, updated_at) VALUES (?, ?, 'user', ?, ?, '[\"learned\"]', 'conversation', ?, ?)")
    .run("m-learned", owner, "Lefèvre", "Lefèvre conteste la facture de travaux de 3 150 euros.", now, now);
  const note = await app.inject({ method: "POST", url: `/api/v1/dossiers/${dupont.id}/notes`, headers: desktop, payload: { content: "Le bailleur refuse toute transaction avant l'audience." } });
  assert.equal(note.statusCode, 201, note.body);
  assert.equal((await app.inject({ method: "POST", url: `/api/v1/dossiers/${dupont.id}/notes`, headers: desktop, payload: { content: "Le bailleur refuse toute transaction avant l'audience." } })).json().note, null, "the same words once");

  const inDupont = await ask({ text: "Où en est-on ?", force_new_discussion: true, dossier_id: dupont.id, document_access: { mode: "off" } });
  const prompt = system(inDupont.sent);
  assert.match(prompt, /Maître Claire Martin/);
  assert.doesNotMatch(prompt, /Lefèvre/, "learned in another conversation: maybe another client's");
  assert.match(prompt, /client file « Dupont c\/ SCI Les Lilas » \(ref\. 2026-014\)/);
  assert.match(prompt, /Bail d'habitation, impayés depuis mars\./);
  assert.match(prompt, /- Le bailleur refuse toute transaction avant l'audience\./);
  assert.ok(prompt.trimEnd().endsWith("- Le bailleur refuse toute transaction avant l'audience."), "the file's block is the end of the system prompt");

  const outside = await ask({ text: "Où en est-on ?", force_new_discussion: true, document_access: { mode: "off" } });
  assert.doesNotMatch(system(outside.sent), /Dupont|bailleur refuse/);
  const inMartin = await ask({ text: "Où en est-on ?", force_new_discussion: true, dossier_id: martin.id, document_access: { mode: "off" } });
  assert.doesNotMatch(system(inMartin.sent), /Dupont|bailleur refuse/);
});

test("« Retiens que… » in a file: a note of the file, never a memory of the person", async () => {
  const before = (sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
  const asked = await ask({ text: "Retiens que le juge rapporteur est Mme Roussel.", force_new_discussion: true, dossier_id: dupont.id, document_access: { mode: "off" } });
  assert.equal(asked.response.statusCode, 200, asked.response.body);
  assert.match(lastUser(asked.sent), /Just saved in this client file's notes/);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n, before);
  const notes = (await app.inject({ method: "GET", url: `/api/v1/dossiers/${dupont.id}`, headers: desktop })).json().notes as Array<{ content: string; source: string }>;
  assert.ok(notes.some((note) => /Mme Roussel/.test(note.content) && note.source === "conversation"));
});

test("what reaches outside a file — contacts, the agenda… — is left out unless the message switches it on", async () => {
  await app.inject({ method: "PATCH", url: "/api/v1/local_capabilities/contacts", headers: desktop, payload: { enabled: true } });
  const now = Date.now();
  sqlite.prepare("INSERT INTO contacts (id, user_id, name, phones, emails, created_at, updated_at) VALUES ('c1', ?, 'René Garnier', '[{\"label\":\"mobile\",\"value\":\"+33 6 00 00 00 01\"}]', '[]', ?, ?)").run(owner, now, now);
  const left = await ask({ text: "Quel est le numéro de René Garnier ?", force_new_discussion: true, dossier_id: dupont.id, document_access: { mode: "off" } });
  assert.doesNotMatch(lastUser(left.sent), /00 00 00 01/);
  const asked = await ask({ text: "Quel est le numéro de René Garnier ?", force_new_discussion: true, dossier_id: dupont.id, document_access: { mode: "off" }, capabilities_on: ["contacts"] });
  assert.match(lastUser(asked.sent), /00 00 00 01/);
  const outside = await ask({ text: "Quel est le numéro de René Garnier ?", force_new_discussion: true, document_access: { mode: "off" } });
  assert.match(lastUser(outside.sent), /00 00 00 01/);
});

test("a file's conversations: listed apart, never learned from, never searched from elsewhere, never synchronised", async () => {
  const filed = await ask({ text: "La partie adverse s'appelle Lilas Gestion.", force_new_discussion: true, dossier_id: dupont.id, document_access: { mode: "off" } });
  const id = filed.discussionId!;
  assert.ok(id);
  const all = (await app.inject({ method: "GET", url: "/discussions", headers: desktop })).json().discussions as Array<{ id: string; dossier_id: string | null }>;
  assert.equal(all.find((row) => row.id === id)?.dossier_id, dupont.id);
  const outside = (await app.inject({ method: "GET", url: "/discussions?dossier=none", headers: desktop })).json().discussions as Array<{ id: string }>;
  assert.ok(!outside.some((row) => row.id === id));
  const inFile = (await app.inject({ method: "GET", url: `/discussions?dossier=${dupont.id}`, headers: desktop })).json().discussions as Array<{ id: string; dossier_id: string }>;
  assert.ok(inFile.length > 0 && inFile.every((row) => row.dossier_id === dupont.id));
  assert.ok(!((await app.inject({ method: "GET", url: "/discussions", headers: phone })).json().discussions as Array<{ id: string }>).some((row) => row.id === id));
  assert.equal((await app.inject({ method: "GET", url: `/discussions/${id}`, headers: phone })).statusCode, 404);
  const opened = (await app.inject({ method: "GET", url: `/discussions/${id}`, headers: desktop })).json();
  assert.equal(opened.dossier.title, "Dupont c/ SCI Les Lilas");

  assert.ok(!pendingDiscussions({ userId: owner, idleMs: 0 }).includes(id));
  assert.equal(await learnDiscussion(id, { ask: async () => "{\"facts\":[{\"text\":\"x\"}]}" }), null);
  assert.ok(!searchConversations(owner, { q: "Lilas Gestion" }).some((hit) => hit.discussion_id === id));

  const imported = await app.inject({ method: "POST", url: "/discussions/import", headers: desktop, payload: { vault_id: "6f1c2b9e-4d3a-4e8b-9c1d-2a3b4c5d6e7f", discussion_id: id, turns: [] } });
  assert.equal(imported.statusCode, 409);
  assert.equal(imported.json().error, "dossier_conversation");
});

test("archived, a file takes no new message; reopened, it does; exported, everything of it", async () => {
  const filed = await ask({ text: "Prépare la chronologie.", force_new_discussion: true, dossier_id: martin.id, document_access: { mode: "off" } });
  const archived = await app.inject({ method: "PATCH", url: `/api/v1/dossiers/${martin.id}`, headers: desktop, payload: { status: "archived" } });
  assert.equal(archived.json().dossier.status, "archived");
  assert.ok(archived.json().dossier.archived_at);
  assert.equal((await ask({ text: "Et ensuite ?", discussion_id: filed.discussionId, document_access: { mode: "off" } })).response.statusCode, 409);
  assert.equal((await ask({ text: "Bonjour", force_new_discussion: true, dossier_id: martin.id })).response.statusCode, 409);
  const open = (await app.inject({ method: "GET", url: "/api/v1/dossiers", headers: desktop })).json().dossiers as Array<{ id: string }>;
  assert.ok(!open.some((dossier) => dossier.id === martin.id));
  const listed = (await app.inject({ method: "GET", url: "/api/v1/dossiers?status=archived", headers: desktop })).json().dossiers as Array<{ id: string }>;
  assert.ok(listed.some((dossier) => dossier.id === martin.id));
  await app.inject({ method: "PATCH", url: `/api/v1/dossiers/${martin.id}`, headers: desktop, payload: { status: "open" } });
  assert.equal((await ask({ text: "Et ensuite ?", discussion_id: filed.discussionId, document_access: { mode: "off" } })).response.statusCode, 200);

  const exported = (await app.inject({ method: "GET", url: `/api/v1/dossiers/${dupont.id}/export`, headers: desktop })).json();
  assert.equal(exported.dossier.title, "Dupont c/ SCI Les Lilas");
  assert.ok(exported.notes.some((note: { content: string }) => /Mme Roussel/.test(note.content)));
  assert.ok(exported.conversations.some((conversation: { messages: Array<{ role: string; content: string }> }) => conversation.messages.some((message) => message.content === "La partie adverse s'appelle Lilas Gestion.")));
  assert.deepEqual(exported.documents.map((document: { name: string }) => document.name), ["assignation.txt"]);
});

test("read ahead: a file's start is its own, with its summary and notes; the person's other conversations start without them", async () => {
  await ask({ text: "Bonjour", force_new_discussion: true, dossier_id: dupont.id, document_access: { mode: "off" } });
  const filed = newConversationSystem(`${owner}|dossier:${dupont.id}`);
  assert.match(filed?.system ?? "", /client file « Dupont c\/ SCI Les Lilas »/);
  await ask({ text: "Bonjour", force_new_discussion: true, document_access: { mode: "off" } });
  assert.doesNotMatch(newConversationSystem(owner)?.system ?? "", /Dupont/);
  // A file asked for the first time starts as another file's did.
  const third = (await app.inject({ method: "POST", url: "/api/v1/dossiers", headers: desktop, payload: { title: "Bernard" } })).json().dossier as { id: string };
  assert.equal((await app.inject({ method: "POST", url: "/queries/warm", headers: desktop, payload: { dossier_id: third.id } })).statusCode, 202);
  assert.match(newConversationSystem(`${owner}|dossier:${third.id}`)?.system ?? "", /client file « Bernard »/);
  assert.ok(dossierContext(owner, third.id)?.startsWith("This conversation is in the user's client file « Bernard »."));
});
