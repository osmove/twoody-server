import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Isolated projects — client files (Jimmy, 04/10/2026, Twoody Pro:
// « dossiers clients cloisonnés », built on Project): a project's documents,
// conversations and notes reach nothing outside it — another one, a
// conversation outside any, another computer, the account, the person's
// memory, the learner, the chat's actions. Every name, date and amount here
// is made up.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-isolated-projects-"));
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
const { isolatedProjectContext } = await import("../src/projects/isolation.js");
const { knownProjects, projectsLine } = await import("../src/projects/projects.js");
const { resolveProject, runAction } = await import("../src/projects/actions.js");
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
const cabinet = mkdtempSync(join(process.cwd(), "tmp-isolated-projects-"));
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
const created = await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Dupont c/ SCI Les Lilas", reference: "2026-014", brief: "Bail d'habitation, impayés depuis mars.", isolated: true, folder_path: join(cabinet, "Dupont") } });
const dupont = created.json().project as { id: string; isolated: boolean; folders: Array<{ id: string; path: string }> };
const martin = (await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Martin", isolated: true, size: "critical", folder_path: join(cabinet, "Martin") } })).json().project as { id: string };

test("migration 6: projects are isolated or not, keep notes, own folders", () => {
  assert.ok(SCHEMA_VERSION >= 6);
  const columns = (table: string) => (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(columns("projects").includes("isolated") && columns("projects").includes("reference"));
  assert.ok(columns("project_notes").includes("content"));
  assert.ok(columns("document_folders").includes("project_id"));
});

test("an isolated project is made with the folder of its documents; its documents are its own at once", async () => {
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(dupont.isolated, true);
  assert.equal(dupont.folders.length, 1);
  assert.equal(dupont.folders[0]!.path.endsWith("Dupont"), true);
  // Indexed under Cabinet before: moved to the file's folder before the next pass.
  const holder = sqlite.prepare("SELECT folder_id FROM documents WHERE name = 'assignation.txt'").get() as { folder_id: string };
  assert.equal(holder.folder_id, dupont.folders[0]!.id);
  await indexed();
  const folders = listFolders(owner);
  assert.equal(folders.find((folder) => folder.path === cabinet)?.project_id, null);
  assert.equal(folders.find((folder) => folder.path.endsWith("Dupont"))?.project_id, dupont.id);
  // Searched by no one else: another computer, the account's tools.
  assert.deepEqual(scopedFolders(owner, { mode: "all" }).map((folder) => folder.path), [cabinet]);
  assert.equal(scopedFolders(owner, { mode: "all" }, { project: dupont.id }).length, 1);
  assert.equal(scopedFolders(owner, { mode: "all" }, { withIsolated: true }).length, 3);
  // A folder inside another isolated project's, or holding it: refused.
  const clash = await app.inject({ method: "POST", url: `/api/v1/projects/${martin.id}/folders`, headers: desktop, payload: { path: join(cabinet, "Dupont") } });
  assert.equal(clash.statusCode, 409);
  assert.equal(clash.json().error, "other_project_folder");
  // Only an isolated project owns folders.
  const plain = (await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Achat d'un Mac mini" } })).json().project as { id: string; isolated: boolean };
  assert.equal(plain.isolated, false);
  assert.equal((await app.inject({ method: "POST", url: `/api/v1/projects/${plain.id}/folders`, headers: desktop, payload: { path: join(cabinet, "Martin") } })).json().error, "not_isolated");
});

test("this computer's app only: a phone neither lists them nor sees their folders, documents or conversations", async () => {
  const seen = (await app.inject({ method: "GET", url: "/api/v1/projects", headers: phone })).json() as Array<{ id: string }>;
  assert.ok(!seen.some((project) => project.id === dupont.id || project.id === martin.id));
  assert.equal((await app.inject({ method: "GET", url: `/api/v1/projects/${dupont.id}`, headers: phone })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/projects", headers: phone, payload: { title: "Bernard", isolated: true } })).statusCode, 403);
  const listed = (await app.inject({ method: "GET", url: "/local_documents/folders", headers: phone })).json().folders as Array<{ path: string }>;
  assert.deepEqual(listed.map((folder) => folder.path), [cabinet]);
  const mine = (await app.inject({ method: "GET", url: "/local_documents/folders", headers: desktop })).json().folders as Array<{ project_id: string | null }>;
  assert.equal(mine.filter((folder) => folder.project_id).length, 2);
  const document = sqlite.prepare("SELECT id FROM documents WHERE name = 'assignation.txt'").get() as { id: string };
  assert.equal((await app.inject({ method: "GET", url: `/local_documents/files/${document.id}`, headers: phone })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/local_documents/files/${document.id}`, headers: desktop })).statusCode, 200);
  // The context a conversation held elsewhere asks for: never a file's documents.
  const context = await app.inject({ method: "POST", url: "/local_documents/context", headers: desktop, payload: { question: "clause pénale", document_access: { mode: "all" } } });
  assert.doesNotMatch(context.json().context, /4 800|9 300/);
  // A conversation started in one from the phone: refused.
  const fromPhone = await ask({ text: "Bonjour", force_new_discussion: true, project_id: dupont.id }, phone);
  assert.equal(fromPhone.response.statusCode, 403);
});

test("documents: an isolated project's conversation reads its own only; one outside any, none of theirs", async () => {
  const inDupont = await ask({ text: "Que prévoit la clause pénale ?", force_new_discussion: true, project_id: dupont.id, document_access: { mode: "only" } });
  assert.equal(inDupont.response.statusCode, 200, inDupont.response.body);
  assert.match(lastUser(inDupont.sent), /4 800 euros/);
  assert.doesNotMatch(lastUser(inDupont.sent), /9 300|Modèle de lettre/);
  const outside = await ask({ text: "Que prévoit la clause pénale ?", force_new_discussion: true, document_access: { mode: "only" } });
  assert.doesNotMatch(lastUser(outside.sent), /4 800|9 300/);
  // The folder named outside its file is not granted there.
  const inMartin = await ask({ text: "Que prévoit la clause pénale ?", force_new_discussion: true, project_id: martin.id, document_access: { mode: "only" } });
  assert.match(lastUser(inMartin.sent), /9 300 euros/);
  assert.doesNotMatch(lastUser(inMartin.sent), /4 800/);
});

test("in an isolated project with documents, a question is read against them up front; small talk is not", async () => {
  const asked = await ask({ text: "Combien prévoit la clause pénale ?", force_new_discussion: true, project_id: dupont.id });
  assert.match(lastUser(asked.sent), /4 800 euros/);
  const hello = await ask({ text: "Bonjour !", force_new_discussion: true, project_id: dupont.id });
  assert.doesNotMatch(lastUser(hello.sent), /4 800/);
});

test("memory: the project's notes in its conversations only; of the person's memory, only what they wrote or pinned themselves", async () => {
  const now = Date.now();
  sqlite.prepare("INSERT INTO memories (id, user_id, kind, title, content, tags, source, created_at, updated_at) VALUES (?, ?, 'user', ?, ?, '[]', 'manual', ?, ?)")
    .run("m-own", owner, "Signature", "Signe ses courriers « Maître Claire Martin ».", now, now);
  sqlite.prepare("INSERT INTO memories (id, user_id, kind, title, content, tags, source, created_at, updated_at) VALUES (?, ?, 'user', ?, ?, '[\"learned\"]', 'conversation', ?, ?)")
    .run("m-learned", owner, "Lefèvre", "Lefèvre conteste la facture de travaux de 3 150 euros.", now, now);
  const note = await app.inject({ method: "POST", url: `/api/v1/projects/${dupont.id}/notes`, headers: desktop, payload: { content: "Le bailleur refuse toute transaction avant l'audience." } });
  assert.equal(note.statusCode, 201, note.body);
  assert.equal((await app.inject({ method: "POST", url: `/api/v1/projects/${dupont.id}/notes`, headers: desktop, payload: { content: "Le bailleur refuse toute transaction avant l'audience." } })).json().note, null, "the same words once");

  const inDupont = await ask({ text: "Où en est-on ?", force_new_discussion: true, project_id: dupont.id, document_access: { mode: "off" } });
  const prompt = system(inDupont.sent);
  assert.match(prompt, /Maître Claire Martin/);
  assert.doesNotMatch(prompt, /Lefèvre/, "learned in another conversation: maybe another client's");
  assert.match(prompt, /client file « Dupont c\/ SCI Les Lilas » \(ref\. 2026-014\)/);
  assert.match(prompt, /Bail d'habitation, impayés depuis mars\./);
  assert.match(prompt, /- Le bailleur refuse toute transaction avant l'audience\./);
  assert.ok(prompt.trimEnd().endsWith("- Le bailleur refuse toute transaction avant l'audience."), "the file's block is the end of the system prompt");

  const outside = await ask({ text: "Où en est-on ?", force_new_discussion: true, document_access: { mode: "off" } });
  assert.doesNotMatch(system(outside.sent), /Dupont|bailleur refuse/);
  const inMartin = await ask({ text: "Où en est-on ?", force_new_discussion: true, project_id: martin.id, document_access: { mode: "off" } });
  assert.doesNotMatch(system(inMartin.sent), /Dupont|bailleur refuse/);
});

test("« Retiens que… » in an isolated project: a note of the project, never a memory of the person", async () => {
  const before = (sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
  const asked = await ask({ text: "Retiens que le juge rapporteur est Mme Roussel.", force_new_discussion: true, project_id: dupont.id, document_access: { mode: "off" } });
  assert.equal(asked.response.statusCode, 200, asked.response.body);
  assert.match(lastUser(asked.sent), /Just saved in this client file's notes/);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n, before);
  const notes = (await app.inject({ method: "GET", url: `/api/v1/projects/${dupont.id}`, headers: desktop })).json().project.notes as Array<{ content: string; source: string }>;
  assert.ok(notes.some((note) => /Mme Roussel/.test(note.content) && note.source === "conversation"));
});

test("what reaches outside an isolated project — contacts, the agenda… — is left out unless the message switches it on", async () => {
  await app.inject({ method: "PATCH", url: "/api/v1/local_capabilities/contacts", headers: desktop, payload: { enabled: true } });
  const now = Date.now();
  sqlite.prepare("INSERT INTO contacts (id, user_id, name, phones, emails, created_at, updated_at) VALUES ('c1', ?, 'René Garnier', '[{\"label\":\"mobile\",\"value\":\"+33 6 00 00 00 01\"}]', '[]', ?, ?)").run(owner, now, now);
  const left = await ask({ text: "Quel est le numéro de René Garnier ?", force_new_discussion: true, project_id: dupont.id, document_access: { mode: "off" } });
  assert.doesNotMatch(lastUser(left.sent), /00 00 00 01/);
  const asked = await ask({ text: "Quel est le numéro de René Garnier ?", force_new_discussion: true, project_id: dupont.id, document_access: { mode: "off" }, capabilities_on: ["contacts"] });
  assert.match(lastUser(asked.sent), /00 00 00 01/);
  const outside = await ask({ text: "Quel est le numéro de René Garnier ?", force_new_discussion: true, document_access: { mode: "off" } });
  assert.match(lastUser(outside.sent), /00 00 00 01/);
});

test("an isolated project's conversations: listed apart, never learned from, never searched from elsewhere, never synchronised", async () => {
  const filed = await ask({ text: "La partie adverse s'appelle Lilas Gestion.", force_new_discussion: true, project_id: dupont.id, document_access: { mode: "off" } });
  const id = filed.discussionId!;
  assert.ok(id);
  const all = (await app.inject({ method: "GET", url: "/discussions", headers: desktop })).json().discussions as Array<{ id: string; project_id: string | null; isolated: boolean }>;
  assert.equal(all.find((row) => row.id === id)?.project_id, dupont.id);
  assert.equal(all.find((row) => row.id === id)?.isolated, true);
  const outside = (await app.inject({ method: "GET", url: "/discussions?outside_isolated=1", headers: desktop })).json().discussions as Array<{ id: string }>;
  assert.ok(!outside.some((row) => row.id === id));
  const inProject = (await app.inject({ method: "GET", url: `/discussions?project=${dupont.id}`, headers: desktop })).json().discussions as Array<{ id: string; project_id: string }>;
  assert.ok(inProject.length > 0 && inProject.every((row) => row.project_id === dupont.id));
  assert.ok(!((await app.inject({ method: "GET", url: "/discussions", headers: phone })).json().discussions as Array<{ id: string }>).some((row) => row.id === id));
  assert.equal((await app.inject({ method: "GET", url: `/discussions/${id}`, headers: phone })).statusCode, 404);
  const opened = (await app.inject({ method: "GET", url: `/discussions/${id}`, headers: desktop })).json();
  assert.equal(opened.isolated_project.title, "Dupont c/ SCI Les Lilas");

  assert.ok(!pendingDiscussions({ userId: owner, idleMs: 0 }).includes(id));
  assert.equal(await learnDiscussion(id, { ask: async () => "{\"facts\":[{\"text\":\"x\"}]}" }), null);
  assert.ok(!searchConversations(owner, { q: "Lilas Gestion" }).some((hit) => hit.discussion_id === id));

  const imported = await app.inject({ method: "POST", url: "/discussions/import", headers: desktop, payload: { vault_id: "6f1c2b9e-4d3a-4e8b-9c1d-2a3b4c5d6e7f", discussion_id: id, turns: [] } });
  assert.equal(imported.statusCode, 409);
  assert.equal(imported.json().error, "isolated_conversation");
  // Never taken out of it, nor brought into it, by the Projects screen.
  const plain = (await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Rénovation de la cuisine" } })).json().project as { id: string };
  assert.equal((await app.inject({ method: "POST", url: `/api/v1/projects/${plain.id}/link`, headers: desktop, payload: { discussion_id: id } })).json().error, "isolated_conversation");
  assert.equal((await app.inject({ method: "POST", url: `/api/v1/projects/${dupont.id}/unlink`, headers: desktop, payload: { discussion_id: id } })).json().error, "isolated_conversation");
  const general = await ask({ text: "Bonjour", force_new_discussion: true, document_access: { mode: "off" } });
  assert.equal((await app.inject({ method: "POST", url: `/api/v1/projects/${dupont.id}/link`, headers: desktop, payload: { discussion_id: general.discussionId } })).json().error, "isolated_conversation");
});

test("done (« Archiver »), an isolated project takes no new message; reopened, it does; exported, everything of it; deleted only while empty", async () => {
  const filed = await ask({ text: "Prépare la chronologie.", force_new_discussion: true, project_id: martin.id, document_access: { mode: "off" } });
  const archived = await app.inject({ method: "PATCH", url: `/api/v1/projects/${martin.id}`, headers: desktop, payload: { status: "done" } });
  assert.equal(archived.json().project.status, "done");
  assert.ok(archived.json().project.done_at);
  const closed = await ask({ text: "Et ensuite ?", discussion_id: filed.discussionId, document_access: { mode: "off" } });
  assert.equal(closed.response.statusCode, 409);
  assert.equal(closed.response.json().error, "project_closed");
  assert.equal((await ask({ text: "Bonjour", force_new_discussion: true, project_id: martin.id })).response.statusCode, 409);
  await app.inject({ method: "PATCH", url: `/api/v1/projects/${martin.id}`, headers: desktop, payload: { status: "active" } });
  assert.equal((await ask({ text: "Et ensuite ?", discussion_id: filed.discussionId, document_access: { mode: "off" } })).response.statusCode, 200);
  // Isolated once and for all; deleted only while it holds nothing.
  assert.equal((await app.inject({ method: "PATCH", url: `/api/v1/projects/${martin.id}`, headers: desktop, payload: { isolated: false } })).json().error, "isolated_fixed");
  assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/projects/${martin.id}`, headers: desktop })).json().error, "isolated_not_empty");
  const empty = (await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Créé par erreur", isolated: true } })).json().project as { id: string };
  assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/projects/${empty.id}`, headers: desktop })).statusCode, 204);

  const exported = (await app.inject({ method: "GET", url: `/api/v1/projects/${dupont.id}/export`, headers: desktop })).json();
  assert.equal(exported.project.title, "Dupont c/ SCI Les Lilas");
  assert.ok(exported.notes.some((note: { content: string }) => /Mme Roussel/.test(note.content)));
  assert.ok(exported.conversations.some((conversation: { messages: Array<{ role: string; content: string }> }) => conversation.messages.some((message) => message.content === "La partie adverse s'appelle Lilas Gestion.")));
  assert.deepEqual(exported.documents.map((document: { name: string }) => document.name), ["assignation.txt"]);
});

test("read ahead: an isolated project's start is its own, with its summary and notes; the person's other conversations start without them", async () => {
  await ask({ text: "Bonjour", force_new_discussion: true, project_id: dupont.id, document_access: { mode: "off" } });
  const filed = newConversationSystem(`${owner}|project:${dupont.id}`);
  assert.match(filed?.system ?? "", /client file « Dupont c\/ SCI Les Lilas »/);
  await ask({ text: "Bonjour", force_new_discussion: true, document_access: { mode: "off" } });
  assert.doesNotMatch(newConversationSystem(owner)?.system ?? "", /Dupont/);
  // One asked for the first time starts as another one's did.
  const third = (await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Bernard", isolated: true } })).json().project as { id: string };
  assert.equal((await app.inject({ method: "POST", url: "/queries/warm", headers: desktop, payload: { project_id: third.id } })).statusCode, 202);
  assert.match(newConversationSystem(`${owner}|project:${third.id}`)?.system ?? "", /client file « Bernard »/);
  assert.ok(isolatedProjectContext(owner, third.id)?.startsWith("This conversation is in the user's client file « Bernard »."));
});

test("nothing of an isolated project spreads: no profile line, never shown to the learner, never named by the chat's actions", () => {
  // Martin is « critical »: a personal project of that size is in every conversation.
  assert.doesNotMatch(projectsLine(owner) ?? "", /Martin|Dupont/);
  assert.ok(!knownProjects(owner).some((project) => project.id === dupont.id || project.id === martin.id));
  assert.equal(resolveProject(owner, "Dupont c/ SCI Les Lilas"), null);
  assert.equal(resolveProject(owner, "Martin"), null);
  assert.equal((sqlite.prepare("SELECT entity_id FROM projects WHERE id = ?").get(dupont.id) as { entity_id: string | null }).entity_id, null, "no entity in the memory graph");
});

test("in its conversations, a reminder or a task asked for is the isolated project's own (its deadlines); no other project is changed from there", () => {
  const within = { id: dupont.id, title: "Dupont c/ SCI Les Lilas" };
  const task = runAction(owner, "create_task", { title: "Relancer Me Durand", project: "Achat d'un Mac mini" }, "Europe/Paris", new Date("2026-10-04T10:00:00Z"), "", within);
  assert.equal(task.project?.id, dupont.id);
  assert.equal((sqlite.prepare("SELECT project_id FROM tasks WHERE id = ?").get(task.id) as { project_id: string }).project_id, dupont.id);
  assert.throws(() => runAction(owner, "update_project", { project: "Achat d'un Mac mini", status: "done" }, "Europe/Paris", new Date(), "", within), /no_such_project/);
});

// 10/10/2026: client files retired. Those made before keep their walls
// and are closed — read, never written in again — nothing deleted.
test("retiring the client files closes the open ones, keeps their walls and deletes nothing", async () => {
  const { retireClientFiles } = await import("../src/migrations/0007_retire_client_files.js");
  const open = sqlite.prepare("SELECT id, status, isolated FROM projects WHERE user_id = ? AND isolated = 1").all(owner) as Array<{ id: string; status: string; isolated: number }>;
  assert.ok(open.length > 0);
  const notes = (sqlite.prepare("SELECT COUNT(*) AS n FROM project_notes").get() as { n: number }).n;
  retireClientFiles(sqlite);
  for (const project of open) {
    const row = sqlite.prepare("SELECT status, isolated, done_at FROM projects WHERE id = ?").get(project.id) as { status: string; isolated: number; done_at: number | null };
    assert.equal(row.isolated, 1, "still walled off");
    assert.ok(row.status === "done" || row.status === "dropped");
    assert.ok(row.done_at);
  }
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM project_notes").get() as { n: number }).n, notes);
  assert.ok(SCHEMA_VERSION >= 7, "migration 7 is there (8 and later follow it)");
  // Its conversations are refused a new message: closed.
  const discussion = sqlite.prepare("SELECT d.id FROM discussions d JOIN projects p ON p.id = d.project_id WHERE p.isolated = 1 LIMIT 1").get() as { id: string } | undefined;
  if (discussion) {
    const refused = await app.inject({ method: "POST", url: "/queries", headers: desktop, payload: { text: "Et ensuite ?", discussion_id: discussion.id, stream: false } });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, "project_closed");
  }
});
