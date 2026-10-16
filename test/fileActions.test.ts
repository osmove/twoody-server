import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import { startFakeRuntime } from "./helpers/fakeBackend.js";

// « Agir dans vos dossiers » (twoody-desktop docs/agent-in-chat.md, Jimmy,
// 16/10/2026): a request to sort, rename or write in a folder of Documents
// gets a proposal written by the server, and nothing is done before the
// person agrees — on the device that asked or this computer's app. Never a
// file deleted, never one written over, never in a walled-off project.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-file-actions-"));
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BACKEND_URL;

let reply = "Réponse.";
const runtime = await startFakeRuntime({ models: ["qwen3.5:9b"], reply: () => reply });

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { indexStatus, reindex } = await import("../src/documents/library.js");
const { setSpotlightEnabled } = await import("../src/documents/spotlight.js");
const { fileActionIntent, saysNo, saysYes } = await import("../src/fileActions/intent.js");
const { documentDate } = await import("../src/fileActions/dates.js");
const { excerptFor, markdownTables } = await import("../src/fileActions/run.js");
setSpotlightEnabled(false);

const app = await buildApp();
await app.ready();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const owner = paired.json().user_id as string;
const desktop = { authorization: `Bearer ${paired.json().token}` };
// A phone of the person's paired by code is not « the person » here (no
// tunnel of its own key): it is refused like a household member's.
const stranger = { authorization: `Bearer ${createAuthSession(owner, "pair:iPhone").token}` };
await app.inject({ method: "POST", url: "/providers/local", headers: desktop, payload: { url: runtime.url, model: "qwen3.5:9b", name: "llama.cpp" } });
await app.inject({ method: "PATCH", url: "/me", headers: desktop, payload: { user: { memory_enabled: false } } });

// The person's folders, under the working directory (the system's temporary
// folder is never granted): Documents/Factures, Scans, Contrats, and a
// walled-off project's folder Tessane.
const home = mkdtempSync(join(process.cwd(), "tmp-file-actions-"));
const docs = join(home, "Documents");
const factures = join(docs, "Factures");
const scans = join(docs, "Scans");
const contrats = join(docs, "Contrats");
const tessane = join(docs, "Tessane");
for (const dir of [factures, scans, contrats, tessane]) mkdirSync(dir, { recursive: true });
const write = (path: string, text: string, at = Date.UTC(2026, 9, 1)) => {
  writeFileSync(path, text);
  utimesSync(path, new Date(at), new Date(at));
};
write(join(factures, "Facture EDF.txt"), "EDF\nFacture n° F-101 du 12/09/2026\nMontant : 92,40 €\nÉchéance : 30/10/2026");
write(join(factures, "Facture Orange.txt"), "Orange\nDate de facture : 3 août 2026\nTotal 39,99 €");
write(join(factures, "Facture Free.txt"), "Free\nInvoice date: 2026-07-21\nTotal 29.99");
write(join(factures, "Note sans date.txt"), "Pas de date ici.", Date.UTC(2026, 5, 15, 12));
write(join(scans, "Scan 001.txt"), "Attestation d'assurance habitation, établie le 14 mars 2026.");
write(join(scans, "Scan 002.txt"), "Courrier de la banque. Paris, le 2 février 2026.");
write(join(scans, "2026-01-05 déjà daté.txt"), "Déjà daté.");
write(join(contrats, "Contrat Tessane.txt"), "Contrat de prestation Tessane. Article 9 : le contrat peut être résilié avec un préavis de trois mois.");
write(join(contrats, "Contrat Orvane.txt"), "Contrat de bail Orvane. Le preneur peut donner congé avec un préavis d'un mois.");
write(join(tessane, "lettre-de-mission.txt"), "Lettre de mission Tessane SAS, honoraires 7 450 euros. Facture du 01/09/2026.");

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/// Every file under the home folder, by relative path, with its digest.
function tree(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(home, path).normalize("NFC"), sha(path));
    }
  };
  walk(home);
  return out;
}
/// Every digest that was there is still there (nothing deleted, nothing written over).
function nothingLost(before: Map<string, string>, after: Map<string, string>) {
  const now = new Set(after.values());
  for (const [path, digest] of before) assert.ok(now.has(digest), `${path} is gone or changed`);
}

test.after(async () => {
  await app.close();
  await runtime.close();
  rmSync(home, { recursive: true, force: true });
});

async function indexed() {
  await reindex(owner);
  while (indexStatus(owner).running) await new Promise((resolve) => setTimeout(resolve, 20));
}

function final(payload: string) {
  const block = payload.split("\n\n").find((part) => part.startsWith("event: final"));
  assert.ok(block, payload.slice(-800));
  return JSON.parse(block!.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
}
async function ask(text: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = desktop) {
  const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { content: text, locale: "fr-FR", ...extra } });
  assert.equal(response.statusCode, 200, response.body);
  return final(response.payload);
}
const modelCalls = () => runtime.calls.filter((call) => call.body.max_tokens !== 1 && call.body.x_purpose !== "background").length;

async function settled(id: string, headers = desktop) {
  for (let i = 0; i < 200; i += 1) {
    const action = (await app.inject({ method: "GET", url: `/file_actions/${id}`, headers })).json().action;
    if (action.status !== "running" && action.status !== "proposed") return action;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("still running");
}

assert.equal((await app.inject({ method: "POST", url: "/local_documents/folders", headers: desktop, payload: { path: docs } })).statusCode, 201);
await app.inject({ method: "PATCH", url: "/local_capabilities/documents", headers: desktop, payload: { enabled: true } });
await indexed();
// Tessane's folder becomes a walled-off project's, inside Documents.
const walledProject = await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Tessane SAS", isolated: true, folder_path: tessane } });
assert.equal(walledProject.statusCode, 201);
const walledProjectId = walledProject.json().project.id as string;
await indexed();

test("requests to act on files are read without the model, in the ten languages; questions, advice and the past are not", () => {
  const kinds = (text: string) => fileActionIntent(text)?.kind ?? null;
  for (const text of ["range mes factures par mois", "Peux-tu trier le dossier « Factures » par année ?", "Sort my invoices by month", "Kannst du meine Rechnungen nach Monat sortieren?", "Ordena mis facturas por mes", "Organize minhas faturas por mês", "Sorteer mijn facturen per maand", "請求書を月ごとに整理して", "把发票按月整理一下", "청구서를 월별로 정리해 줘"]) {
    assert.equal(kinds(text), "sort", text);
  }
  assert.equal(fileActionIntent("Peux-tu trier le dossier « Factures » par année ?")?.kind === "sort" && (fileActionIntent("Peux-tu trier le dossier « Factures » par année ?") as { by: string }).by, "year");
  for (const text of ["renomme ces scans avec leur date", "Can you rename the scans with their date?", "Rinomina le scansioni con la loro data"]) assert.equal(kinds(text), "rename", text);
  assert.equal(kinds("fais-moi un Word avec les délais de préavis de mes contrats"), "draft");
  assert.equal(kinds("Erstelle ein Word-Dokument mit den Kündigungsfristen meiner Verträge"), "draft");
  assert.equal(kinds("compare ces deux contrats et fais un tableau Excel"), "table");
  assert.equal(kinds("supprime mes vieux scans"), "delete");
  assert.equal(kinds("delete the duplicates in Downloads"), "delete");
  for (const text of ["comment ranger mes factures ?", "How should I organize my invoices?", "j'ai rangé mes factures par mois", "What's the price range of my invoices?", "qu'est-ce qu'il y a dans Documents/Factures ?", "supprime ce rappel", "Quel est le délai de préavis du contrat Tessane ?", "fais un tableau des délais de préavis", "Résume mes contrats"]) {
    assert.equal(kinds(text), null, text);
  }
  assert.ok(saysYes("oui") && saysYes("Oui, vas-y") && saysYes("はい") && saysYes("yes please") && !saysYes("oui mais pas les PDF"));
  assert.ok(saysNo("non") && saysNo("nein danke") && !saysNo("oui"));
});

test("a document's own date: the labelled one first, the language deciding 03/04", () => {
  assert.deepEqual(documentDate("EDF\nFacture n° F-101 du 12/09/2026\nÉchéance : 30/10/2026"), { year: 2026, month: 9, day: 12 });
  assert.deepEqual(documentDate("Échéance 30/10/2026. Date : 03/04/2026"), { year: 2026, month: 4, day: 3 });
  assert.deepEqual(documentDate("Invoice date: 03/04/2026", { language: "en" }), { year: 2026, month: 3, day: 4 });
  assert.deepEqual(documentDate("Rechnungsdatum: 7. Oktober 2026"), { year: 2026, month: 10, day: 7 });
  assert.deepEqual(documentDate("請求日：2026年9月12日"), { year: 2026, month: 9, day: 12 });
  assert.equal(documentDate("Pas de date ici."), null);
});

test("what the model is given of a long document: its start and its passages about the request", () => {
  const long = ["Contrat de prestation entre A et B.", ...Array.from({ length: 80 }, (_, i) => `Article ${i} : clauses générales sans intérêt particulier pour la question posée ici.`), "Article 99 : résiliation avec un préavis de trois mois."].join("\n\n");
  const excerpt = excerptFor(long, "les délais de préavis de mes contrats", 600);
  assert.match(excerpt, /^Contrat de prestation/);
  assert.match(excerpt, /préavis de trois mois/);
  assert.ok(excerpt.length <= 800);
  assert.deepEqual(markdownTables("Voici :\n| Contrat | Préavis |\n|---|---|\n| Tessane | 3 mois |\n| Orvane | 1 mois |"), [{ header: ["Contrat", "Préavis"], rows: [["Tessane", "3 mois"], ["Orvane", "1 mois"]] }]);
  assert.deepEqual(markdownTables("Pas de tableau."), []);
});

test("switched off, the answer says how to switch it on — no model, nothing proposed, nothing touched", async () => {
  const before = tree();
  const calls = modelCalls();
  const answer = await ask("range mes factures par mois", { force_new_discussion: true });
  assert.match(answer.text, /Agir dans vos dossiers/);
  assert.equal(answer.file_action, undefined);
  assert.equal(modelCalls(), calls);
  assert.deepEqual(tree(), before);
});

test("a delete request is refused, whatever is switched on", async () => {
  await app.inject({ method: "PATCH", url: "/local_capabilities/agent", headers: desktop, payload: { enabled: true } });
  const before = tree();
  const answer = await ask("supprime mes vieux scans", { force_new_discussion: true });
  assert.match(answer.text, /ne supprime jamais/);
  assert.equal(answer.file_action, undefined);
  assert.deepEqual(tree(), before);
});

test("sorting: proposed with each file's date, nothing moved before « Faire », then moved without a file lost", async () => {
  const before = tree();
  const answer = await ask("range mes factures par mois", { force_new_discussion: true });
  assert.equal(answer.provider, "twoody");
  assert.match(answer.text, /Voici ce que je propose dans « Documents\/Factures » : ranger 4 fichiers dans 4 dossiers/);
  assert.match(answer.text, /Rien n'est fait tant que vous n'avez pas accepté/);
  const action = answer.file_action;
  assert.equal(action.status, "proposed");
  assert.equal(action.may_decide, true);
  const moves = Object.fromEntries(action.moves.map((move: { from: string; to: string; date_from: string }) => [move.from, `${move.to} ${move.date_from}`]));
  assert.deepEqual(moves, {
    "Facture EDF.txt": "2026-09/Facture EDF.txt content",
    "Facture Free.txt": "2026-07/Facture Free.txt content",
    "Facture Orange.txt": "2026-08/Facture Orange.txt content",
    "Note sans date.txt": "2026-06/Note sans date.txt file",
  });
  assert.ok(!JSON.stringify(action).includes(home), "never an absolute path");
  assert.deepEqual(tree(), before, "nothing done before the person agrees");
  // Another device than the one that asked, or anyone not the person: nothing waits.
  assert.equal((await app.inject({ method: "POST", url: `/file_actions/${action.id}/approve`, headers: stranger })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/file_actions/${action.id}`, headers: stranger })).statusCode, 404);
  // The conversation keeps the card with its message.
  const conversation = (await app.inject({ method: "GET", url: `/discussions/${answer.discussion_id}`, headers: desktop })).json();
  assert.equal(conversation.messages.at(-1).file_action.id, action.id);

  const started = await app.inject({ method: "POST", url: `/file_actions/${action.id}/approve`, headers: desktop });
  assert.equal(started.statusCode, 200, started.body);
  const done = await settled(action.id);
  assert.equal(done.status, "done");
  assert.equal(done.result.done, 4);
  assert.ok(existsSync(join(factures, "2026-09", "Facture EDF.txt")));
  assert.ok(!existsSync(join(factures, "Facture EDF.txt")));
  nothingLost(before, tree());
  // Approved once: never twice.
  assert.equal((await app.inject({ method: "POST", url: `/file_actions/${action.id}/approve`, headers: desktop })).statusCode, 409);
  // The result is said in the conversation, from what was done.
  const after = (await app.inject({ method: "GET", url: `/discussions/${answer.discussion_id}`, headers: desktop })).json();
  assert.match(after.messages.at(-1).content, /C'est fait : 4 fichiers rangés dans 4 dossiers de « Documents\/Factures »\. Aucun fichier n'a été supprimé ni remplacé\./);
  // « Ouvrir »: the real path for this computer's app only.
  const path = await app.inject({ method: "GET", url: `/file_actions/${action.id}/path?item=0`, headers: desktop });
  assert.equal(path.json().path.normalize("NFC"), join(factures, "2026-09", "Facture EDF.txt").normalize("NFC"));
  assert.equal((await app.inject({ method: "GET", url: `/file_actions/${action.id}/path?item=0`, headers: stranger })).statusCode, 404);
  // « Annuler »: each file back in its place, the folders made removed.
  const undone = await app.inject({ method: "POST", url: `/file_actions/${action.id}/undo`, headers: desktop });
  assert.equal(undone.statusCode, 200, undone.body);
  assert.equal(undone.json().action.result.undo.restored, 4);
  assert.deepEqual(tree(), before);
  assert.ok(!existsSync(join(factures, "2026-09")));
});

test("renaming with their dates, agreed by a typed « oui »; a name already dated is left", async () => {
  const before = tree();
  const proposed = await ask("renomme ces scans avec leur date", { force_new_discussion: true });
  const action = proposed.file_action;
  assert.deepEqual(action.moves.map((move: { to: string }) => move.to).sort(), ["2026-02-02 Scan 002.txt", "2026-03-14 Scan 001.txt"]);
  assert.deepEqual(tree(), before);
  const yes = await ask("oui", { discussion_id: proposed.discussion_id });
  assert.equal(yes.file_action.status, "done");
  assert.match(yes.text, /C'est fait : 2 fichiers de « Documents\/Scans » renommés avec leur date/);
  assert.ok(existsSync(join(scans, "2026-03-14 Scan 001.txt")));
  nothingLost(before, tree());
});

test("« non » after a proposal: nothing done; a « oui » later in the conversation answers nothing", async () => {
  const before = tree();
  const proposed = await ask("Sort my invoices by year", { force_new_discussion: true, locale: "en-US" });
  assert.match(proposed.text, /^Here is what I propose in “Documents\/Factures”: move 4 files into 1 folder, one per year\./);
  const no = await ask("non", { discussion_id: proposed.discussion_id });
  assert.equal(no.file_action.status, "declined");
  assert.deepEqual(tree(), before);
  const calls = modelCalls();
  await ask("oui", { discussion_id: proposed.discussion_id });
  assert.equal(modelCalls(), calls + 1, "a « oui » to nothing is the model's to answer");
  assert.deepEqual(tree(), before);
});

test("a Word document from the contracts: written by the model after approval, never over an existing file", async () => {
  write(join(contrats, "Délais de préavis.docx"), "an existing document");
  const before = tree();
  const proposed = await ask("fais-moi un Word avec les délais de préavis de mes contrats", { force_new_discussion: true });
  const action = proposed.file_action;
  assert.equal(action.create.name, "Délais de préavis (2).docx");
  assert.deepEqual(action.reads, ["Contrat Orvane.txt", "Contrat Tessane.txt"]);
  const calls = modelCalls();
  reply = "# Délais de préavis\n\n| Contrat | Préavis |\n|---|---|\n| Tessane | 3 mois |\n| Orvane | 1 mois |";
  await app.inject({ method: "POST", url: `/file_actions/${action.id}/approve`, headers: desktop });
  const done = await settled(action.id);
  assert.equal(done.status, "done", JSON.stringify(done.result));
  assert.equal(modelCalls(), calls + 1);
  const sent = JSON.stringify(runtime.calls.at(-1)!.body.messages);
  assert.match(sent, /préavis de trois mois/);
  assert.doesNotMatch(sent, /7 450/, "never a walled-off project's document");
  const docx = unzipSync(readFileSync(join(contrats, "Délais de préavis (2).docx")));
  assert.match(strFromU8(docx["word/document.xml"]!), /Tessane/);
  assert.equal(readFileSync(join(contrats, "Délais de préavis.docx"), "utf8"), "an existing document");
  nothingLost(before, tree());
  const conversation = (await app.inject({ method: "GET", url: `/discussions/${proposed.discussion_id}`, headers: desktop })).json();
  assert.match(conversation.messages.at(-1).content, /j'ai créé « Délais de préavis \(2\)\.docx » dans « Documents\/Contrats », à partir de 2 documents/);
});

test("an Excel table: the model's answer that is no table creates nothing, and says so", async () => {
  const before = tree();
  const proposed = await ask("compare ces deux contrats et fais un tableau Excel", { force_new_discussion: true });
  reply = "Les deux contrats diffèrent par leur préavis.";
  await app.inject({ method: "POST", url: `/file_actions/${proposed.file_action.id}/approve`, headers: desktop });
  const failed = await settled(proposed.file_action.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.result.failure.reason, "no_table");
  assert.deepEqual(tree(), before);
  const conversation = (await app.inject({ method: "GET", url: `/discussions/${proposed.discussion_id}`, headers: desktop })).json();
  assert.match(conversation.messages.at(-1).content, /Je n'ai pas pu le faire : le modèle n'a pas fait de tableau\. Rien n'a été modifié\./);
  // Asked again, with a table this time.
  const again = await ask("compare ces deux contrats et fais un tableau Excel", { force_new_discussion: true });
  reply = "| Contrat | Préavis |\n|---|---|\n| Tessane | 3 mois |\n| Orvane | 1 mois |";
  await app.inject({ method: "POST", url: `/file_actions/${again.file_action.id}/approve`, headers: desktop });
  assert.equal((await settled(again.file_action.id)).status, "done");
  const name = again.file_action.create.name as string;
  assert.match(name, /^Comparaison – Contrats\.xlsx$/);
  const xlsx = unzipSync(readFileSync(join(contrats, name)));
  assert.match(strFromU8(xlsx["xl/sharedStrings.xml"]!), /Orvane/);
});

test("a walled-off project's folder is never acted on, nor from its conversations", async () => {
  const before = tree();
  const outside = await ask("range le dossier Tessane par mois", { force_new_discussion: true });
  assert.equal(outside.file_action, undefined);
  assert.match(outside.text, /Je ne trouve pas de dossier « Tessane »/);
  const inside = await ask("range mes factures par mois", { force_new_discussion: true, project_id: walledProjectId });
  assert.equal(inside.file_action, undefined);
  assert.match(inside.text, /n'est pas disponible dans un projet cloisonné/);
  assert.deepEqual(tree(), before);
});

test("left out in « Outils » for a message, or asked by someone who is not the person: nothing proposed", async () => {
  const before = tree();
  const left = await ask("range mes factures par mois", { force_new_discussion: true, capabilities_off: ["agent"] });
  assert.match(left.text, /désactivé pour ce message/);
  assert.equal(left.file_action, undefined);
  const strangers = await ask("range mes factures par mois", { force_new_discussion: true }, stranger);
  assert.match(strangers.text, /Seule la personne/);
  assert.equal(strangers.file_action, undefined);
  assert.deepEqual(tree(), before);
  assert.ok(statSync(factures).isDirectory());
});
