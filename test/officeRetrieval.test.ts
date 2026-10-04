import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// A granted folder's spreadsheet and presentation are indexed like its
// PDFs, and an answer drawn from them cites the sheet and its rows, or the
// slide, the way a PDF's is cited by its page.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-office-retrieval-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

type Body = { messages: Array<{ role: string; content: string }>; tools?: unknown[]; max_tokens?: number };
const bodies: Body[] = [];
const model = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "qwen" }] }));
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    bodies.push(JSON.parse(raw) as Body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "D'après vos documents [1]." } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { ensureLocalUser } = await import("../src/pairing.js");
const { addFolder, reindex, listFolders } = await import("../src/documents/library.js");
const { folderRisk } = await import("../src/documents/folderRisk.js");
const { setSpotlightEnabled } = await import("../src/documents/spotlight.js");
setSpotlightEnabled(false);

// A folder where folderRisk lets it be granted (not under /private/var on a Mac).
const home = realpathSync(homedir());
const tmpBase = realpathSync(tmpdir());
const base = folderRisk(join(tmpBase, "x"), home) === null ? tmpBase : home;
const docs = realpathSync(mkdtempSync(join(base, "twoody-office-docs-test-")));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
copyFileSync(fixture("budget-tessane.xlsx"), join(docs, "budget-tessane.xlsx"));
copyFileSync(fixture("presentation-tessane.pptx"), join(docs, "presentation-tessane.pptx"));
copyFileSync(fixture("contrat-dupont.pdf"), join(docs, "contrat-dupont.pdf"));

const app = await buildApp();
test.after(async () => {
  await app.close();
  await new Promise((resolve) => model.close(resolve));
  const trash = join(homedir(), ".Trash");
  mkdirSync(trash, { recursive: true });
  renameSync(docs, join(trash, `${basename(docs)}-${Date.now()}`));
});
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`, model: "qwen", name: "llama.cpp" } });
await app.inject({ method: "PATCH", url: "/me", headers, payload: { user: { memory_enabled: false } } });
const user = ensureLocalUser();
await addFolder(user.id, docs);
await reindex(user.id);

async function ask(text: string) {
  const before = bodies.length;
  const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { text, channel: "desktop", force_new_discussion: true } });
  assert.equal(response.statusCode, 200, response.body);
  const block = response.body.split("\n\n").find((part) => part.startsWith("event: final"))!;
  const sent = bodies.slice(before).filter((body) => body.max_tokens !== 1);
  return { final: JSON.parse(block.slice(block.indexOf("data: ") + 6)), prompt: sent.at(-1)!.messages.filter((message) => message.role === "user").at(-1)!.content };
}

test("the folder's workbook, deck and PDF are indexed", () => {
  const [folder] = listFolders(user.id);
  assert.equal(folder!.documents, 3);
  assert.equal(folder!.indexed, 3);
  assert.equal(folder!.failed, 0);
});

test("an answer from a spreadsheet cites its sheet and rows; the excerpt carries the header", async () => {
  const { final, prompt } = await ask("Dans budget-tessane.xlsx, combien Atelier Lumière a-t-il payé pour le matériel ?");
  const source = final.sources.find((item: { name: string }) => item.name === "budget-tessane.xlsx");
  assert.ok(source, JSON.stringify(final.sources));
  assert.deepEqual(source.location, { kind: "sheet", sheet: "Ventes T1", rows: [1, 9] });
  assert.equal(source.page, null);
  assert.match(prompt, /\[\d\] budget-tessane\.xlsx — in twoody-office-docs-test-\w+\n\[Sheet "Ventes T1", rows 1–9 of 9\]\nVentes du premier trimestre 2026 — Tessane\n\| Row \| Date \| Client \| Produit \| Quantité \| Prix unitaire \| Montant \|/);
  assert.match(prompt, /\| 7 \| 09\/03\/2026 \| Atelier Lumière \| Matériel \| 4 \| 312\.25 € \| 1249\.00 € \|/);
});

test("an answer from a presentation cites its slide, speaker notes included", async () => {
  const { final, prompt } = await ask("Que disent les notes de presentation-tessane.pptx sur la formation de mars ?");
  const source = final.sources.find((item: { name: string }) => item.name === "presentation-tessane.pptx" && item.location?.slide === 2);
  assert.ok(source, JSON.stringify(final.sources));
  assert.deepEqual(source.location, { kind: "slide", slide: 2 });
  assert.equal(source.page, 2);
  assert.match(prompt, /\[\d\] presentation-tessane\.pptx, slide 2 — in twoody-office-docs-test-\w+\nCe qui a marché\n[\s\S]*Speaker notes:\nDire que la formation de mars a été la plus rentable/);
});

test("a PDF's citation keeps its page", async () => {
  const { final } = await ask("Quel est le préavis du contrat-dupont.pdf ?");
  const source = final.sources.find((item: { name: string }) => item.name === "contrat-dupont.pdf");
  assert.deepEqual(source.location, { kind: "page", page: 1 });
});

test("a message about a spreadsheet or a deck reads the documents with it; a question about Excel itself does not", async () => {
  const { aboutDocuments } = await import("../src/routes/queries.js");
  for (const said of [
    "Dans budget-tessane.xlsx, combien a payé Claire Martin ?", "Que dit mon tableau des ventes ?", "le total de ma feuille de calcul", "dans le classeur des congés",
    "Résume mes diapos", "la diapositive sur le budget", "What's in my spreadsheet about Q1?", "Summarize my slides", "the pitch.pptx deck", "the slide deck for Tessane",
  ]) assert.equal(aboutDocuments(said), true, said);
  for (const said of [
    "Comment faire une RECHERCHEV dans Excel ?", "How do I add a transition in PowerPoint?", "Fais-moi une présentation de Lyon",
    "Make a presentation about Rome", "Quel tableau de Monet préfères-tu ?", "un tableau des capitales d'Europe", "Explique les tableaux croisés dynamiques",
  ]) assert.equal(aboutDocuments(said), false, said);
});

test("the context for a conversation kept elsewhere, and the Documents screen's search, say where too", async () => {
  const context = await app.inject({ method: "POST", url: "/local_documents/context", headers, payload: { question: "budget-tessane.xlsx Synthèse marge", document_access: { mode: "all" } } });
  assert.equal(context.statusCode, 200, context.body);
  const sheets = context.json().sources.filter((item: { name: string }) => item.name === "budget-tessane.xlsx");
  assert.ok(sheets.some((item: { location: unknown }) => JSON.stringify(item.location) === JSON.stringify({ kind: "sheet", sheet: "Synthèse", rows: [1, 6] })), JSON.stringify(sheets));
  const search = await app.inject({ url: `/local_documents/search?q=${encodeURIComponent("Recruter un formateur")}`, headers });
  const slide = search.json().passages.find((passage: { name: string }) => passage.name === "presentation-tessane.pptx");
  assert.deepEqual(slide.location, { kind: "slide", slide: 5 });
  assert.equal(slide.text, undefined, "the passage's text stays on the server");
});
