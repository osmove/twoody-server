import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { startFakeRuntime } from "./helpers/fakeBackend.js";

// « Synthèse du projet » (docs/project-overview-design.md, Jimmy,
// 27/10/2026): a project's documents read once each by this computer's
// model, each point standing on the document's own words; each section
// written from the points, each line on the points it names; once made,
// brought up to date by proposals — only the documents that changed read
// again, only the sections whose points changed written again. A walled-off
// project's stays its own.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-overview-"));
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BACKEND_URL;

/// What each point's kind is, from the words of a line of a document.
const KINDS: Array<[RegExp, string]> = [
  [/entschieden|gewählt/i, "decision"],
  [/^offen|ungeklärt/i, "open_question"],
  [/nächster schritt/i, "next_step"],
  [/stand|engeren wahl/i, "status"],
  [/soll|muss|abgabe/i, "brief"],
];

/// A fake model that answers as the overview asks: a document's points
/// (each line of the document worth one, its own words as the quote, and one
/// made up that no document says), a section's lines (each point's text with
/// its id, and two lines on nothing).
function fakeModel(body: { messages: Array<{ role: string; content: string }> }): string {
  const system = body.messages[0]?.content ?? "";
  const user = body.messages[body.messages.length - 1]?.content ?? "";
  if (system.startsWith("You read one document")) {
    const text = user.split("\n\n").slice(1).join("\n\n");
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const points = lines.flatMap((line) => {
      const kind = KINDS.find(([pattern]) => pattern.test(line))?.[1];
      return kind ? [`${kind} | ${line.replace(/\.$/, "")} (laut Dokument). | ${line}`] : [];
    });
    return [...points, "decision | Der Kunde hat den Namen Zirkon gewählt. | Der Kunde hat sich endgültig für Zirkon entschieden"].join("\n");
  }
  if (system.startsWith("You write one section")) {
    const own = user.split("\n\nPoints of the other sections:")[0]!.split("\n\nThe section as it stands:")[0]!;
    const points = [...own.matchAll(/^\[(i\d+)\] \([^)]*\) (.+)$/gm)].map((match) => `- ${match[2]} [${match[1]}]`);
    // A line on another section's point only: never kept in this one.
    const other = /Points of the other sections:\n\[(i\d+)\]/.exec(user)?.[1];
    return [...points, "- Eine Zeile ohne Quelle [i99]", "- Eine Zeile ohne Klammer", ...(other ? [`- Eine fremde Zeile [${other}]`] : [])].join("\n");
  }
  return "Antwort.";
}

const runtime = await startFakeRuntime({ models: ["qwen3.5:9b"], reply: (_model, body) => fakeModel(body) });

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { indexStatus, reindex } = await import("../src/documents/library.js");
const { setSpotlightEnabled } = await import("../src/documents/spotlight.js");
const { beginGeneration } = await import("../src/account/inflight.js");
const { findQuote, foldQuote } = await import("../src/projects/overview/quotes.js");
const { readLines, readPointLines, readPoints } = await import("../src/projects/overview/prompts.js");
const { overviewsIdle, piecesOf, setQuietForTests, startOverviewUpdates, PIECE_CHARS } = await import("../src/projects/overview/run.js");
setSpotlightEnabled(false);
setQuietForTests(5, 0, 0);

const app = await buildApp();
await app.ready();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const owner = paired.json().user_id as string;
const desktop = { authorization: `Bearer ${paired.json().token}` };
// Not « the person » here (no tunnel of its own key): a walled-off project does not exist for it.
const stranger = { authorization: `Bearer ${createAuthSession(owner, "pair:iPhone").token}` };
await app.inject({ method: "POST", url: "/providers/local", headers: desktop, payload: { url: runtime.url, model: "qwen3.5:9b", name: "llama.cpp" } });
await app.inject({ method: "PATCH", url: "/me", headers: desktop, payload: { user: { memory_enabled: false } } });
startOverviewUpdates();

const home = mkdtempSync(join(process.cwd(), "tmp-overview-"));
const docs = join(home, "Documents");
const velora = join(docs, "Kunde Velora");
const agentur = join(docs, "Agentur");
for (const dir of [velora, agentur]) mkdirSync(dir, { recursive: true });
let clock = Date.UTC(2026, 9, 1);
const write = (path: string, text: string) => {
  writeFileSync(path, text);
  clock += 60_000;
  utimesSync(path, new Date(clock), new Date(clock));
};
write(join(velora, "Briefing.txt"), "Briefing Velora\nDatum: 03.02.2026\nDer Name soll kurz sein, höchstens drei Silben.\nDer Name muss auch auf Englisch funktionieren.\nAbgabe der Shortlist bis 15.03.2026.");
write(join(velora, "Protokoll.txt"), "Protokoll Workshop\nDatum: 20.02.2026\nWir haben uns für die Richtung Natur entschieden.\nOffen ist noch, ob die Domain frei ist.\nNächster Schritt: Markenrecherche durch Anna bis 01.03.2026.");
write(join(velora, "Mail Kunde.txt"), "Von: Kunde\nDatum: 25.02.2026\nDer Stand: drei Namen sind in der engeren Wahl.");
write(join(agentur, "Jahresplanung.txt"), "Jahresplanung der Agentur\nDatum: 05.01.2026\nWir haben uns für zwei neue Stellen entschieden.");

test.after(async () => {
  await app.close();
  await runtime.close();
  rmSync(home, { recursive: true, force: true });
});

async function indexed() {
  await reindex(owner);
  while (indexStatus(owner).running) await new Promise((resolve) => setTimeout(resolve, 20));
}
const documentCalls = () => runtime.calls.filter((call) => call.body.messages?.[0]?.content?.startsWith("You read one document"));
const sectionCalls = () => runtime.calls.filter((call) => call.body.messages?.[0]?.content?.startsWith("You write one section"));
const overviewOf = async (id: string, headers = desktop) => {
  const response = await app.inject({ method: "GET", url: `/projects/${id}/overview`, headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().overview;
};
const lineTexts = (overview: { sections: Array<{ kind: string; lines: Array<{ text: string }> }> }, kind: string) => overview.sections.find((section) => section.kind === kind)!.lines.map((line) => line.text);

test("a quote stands only when the document says it", () => {
  const document = "Protokoll\nWir haben uns für die Richtung „Natur“ entschieden.\nOffen ist noch, ob die Domain frei ist.";
  assert.ok(findQuote(document, "Wir haben uns für die Richtung \"Natur\" entschieden")?.exact);
  assert.ok(findQuote(document, "wir haben uns für die richtung natur entschieden."));
  // A word's ending, a word dropped: most of its words in a row of the document.
  assert.ok(findQuote(document, "Offen ist noch ob die Domains frei sind"));
  assert.equal(findQuote(document, "Der Kunde hat sich endgültig für Zirkon entschieden"), null);
  // Shorter than three words: as written only.
  assert.ok(findQuote(document, "Natur")?.exact);
  assert.equal(findQuote(document, "die Richtungen"), null);
  assert.equal(findQuote(document, "Zirkon Natur"), null);
  assert.equal(foldQuote("« Velora » — gewählt"), "velora - gewählt");
  assert.ok(findQuote("会議で名前はベローラに決定しました。", "名前はベローラに決定しました"));
  assert.equal(findQuote("会議で名前はベローラに決定しました。", "名前はジルコンに決定しました"), null);
});

test("the model's lines are read strictly", () => {
  assert.deepEqual(readPoints("decision | Natur gewählt. | Wir haben uns für Natur entschieden\nnonsense line\nfoo | bar | baz\nnext step | Recherche | Nächster Schritt: Recherche"), [
    { kind: "decisions", text: "Natur gewählt.", quote: "Wir haben uns für Natur entschieden" },
    { kind: "next_steps", text: "Recherche", quote: "Nächster Schritt: Recherche" },
  ]);
  assert.deepEqual(readPoints("none"), []);
  // The form copied with its own word first, or the point left out: read all the same (Qwen3.5 9B in Dutch,
  // Spanish and French, 27/10/2026: every line « kind | brief | … », every one lost before).
  assert.deepEqual(readPointLines("kind | decision | Wir haben uns für Natur entschieden\nbrief | <Der Name hat drei Silben.> | <Der Name soll drei Silben haben>\nbesluit | Natur gekozen | We hebben gekozen\nfoo bar"), {
    points: [
      { kind: "decisions", text: "Wir haben uns für Natur entschieden", quote: "Wir haben uns für Natur entschieden" },
      { kind: "brief", text: "Der Name hat drei Silben.", quote: "Der Name soll drei Silben haben" },
    ],
    unread: 1,
  });
  const known = new Set(["i1", "i2", "i3"]);
  assert.deepEqual(readLines("- Natur gewählt [i1, i3]\n- Erfunden [i9]\n- Ohne\n1. Domain offen (i2).\n- Natur gewählt [i1]\n- Velora statt Natur (i3) gewählt [i1]", known), [
    { text: "Natur gewählt", refs: ["i1", "i3"] },
    { text: "Domain offen", refs: ["i2"] },
    { text: "Velora statt Natur gewählt", refs: ["i1", "i3"] },
  ]);
  assert.deepEqual(readLines("- Lumo statt Aurin, was die Entscheidung i1 ersetzt. [i2]\n- Version i9 bleibt [i3]", known), [
    { text: "Lumo statt Aurin, was die Entscheidung ersetzt.", refs: ["i2", "i1"] },
    { text: "Version i9 bleibt", refs: ["i3"] },
  ]);
  const long = Array.from({ length: 30 }, (_, i) => `Absatz ${i} ${"x".repeat(900)}`).join("\n");
  const pieces = piecesOf(long);
  assert.ok(pieces.length >= 2 && pieces.every((piece) => piece.length <= PIECE_CHARS));
  assert.equal(pieces.join(""), long);
});

let walled = "";
let plain = "";

test("a walled-off project's overview: every document read, every line on its sources, nothing made up kept", async () => {
  const made = await app.inject({ method: "POST", url: "/projects", headers: desktop, payload: { project: { title: "Velora", isolated: true }, folder_path: velora } });
  assert.equal(made.statusCode, 201, made.body);
  walled = made.json().project.id;
  await indexed();
  assert.equal(await overviewOf(walled), null);

  const asked = await app.inject({ method: "POST", url: `/projects/${walled}/overview`, headers: desktop, payload: { language: "de-DE" } });
  assert.equal(asked.statusCode, 202, asked.body);
  await overviewsIdle();
  const overview = await overviewOf(walled);
  assert.equal(overview.error, null);
  assert.equal(overview.language, "de");
  assert.equal(overview.documents.read, 3);
  assert.equal(documentCalls().length, 3);
  // Five sections, each written once (every one has points).
  assert.equal(sectionCalls().length, 5);
  assert.deepEqual(overview.sections.map((section: { kind: string }) => section.kind), ["brief", "decisions", "status", "next_steps", "open_questions"]);
  assert.ok(lineTexts(overview, "decisions").some((text: string) => text.includes("Richtung Natur")));
  assert.ok(lineTexts(overview, "next_steps").some((text: string) => text.includes("Markenrecherche")));
  // The point made up has no quote to stand on; the lines on nothing are dropped.
  const all = overview.sections.flatMap((section: { lines: Array<{ text: string; sources: Array<{ name: string; quote: string; path?: string }> }> }) => section.lines);
  assert.ok(all.every((line: { text: string }) => !/Zirkon|ohne Quelle|ohne Klammer|fremde Zeile/i.test(line.text)));
  assert.ok(all.every((line: { sources: unknown[] }) => line.sources.length > 0));
  const decision = all.find((line: { text: string }) => line.text.includes("Richtung Natur"))!;
  assert.equal(decision.sources[0]!.name, "Protokoll.txt");
  assert.equal(decision.sources[0]!.quote, "Wir haben uns für die Richtung Natur entschieden.");
  assert.ok(decision.sources[0]!.path?.endsWith("Protokoll.txt"), "this computer's app gets the path to open it");
  assert.equal(overview.last_run.dropped, 3, "one made-up point per document");
  assert.equal(overview.last_run.lines_dropped, 15, "two lines on nothing and one on another section's point only, per section");
  assert.equal(overview.proposal, null);

  // Nothing changed: nothing read nor written again.
  const before = runtime.calls.length;
  await app.inject({ method: "POST", url: `/projects/${walled}/overview/refresh`, headers: desktop });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await overviewsIdle();
  assert.equal(runtime.calls.length, before);
  assert.equal((await overviewOf(walled)).proposal, null);
});

test("a document changed: only it is read again, the sections written again from their lines, as a proposal", async () => {
  const documentsBefore = documentCalls().length;
  const sectionsBefore = sectionCalls().length;
  write(join(velora, "Protokoll.txt"), "Protokoll Workshop\nDatum: 20.02.2026\nWir haben uns für die Richtung Technik entschieden.\nOffen ist noch, ob die Domain frei ist.\nNächster Schritt: Markenrecherche durch Anna bis 01.03.2026.");
  await indexed();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await overviewsIdle();
  assert.equal(documentCalls().length - documentsBefore, 1);
  // Every section written again from its lines (a point of one may change
  // another's); only the decision's lines changed.
  assert.equal(sectionCalls().length - sectionsBefore, 5);
  assert.ok(sectionCalls().slice(sectionsBefore).every((call) => /The section as it stands:/.test(call.body.messages[1].content)));
  assert.ok(sectionCalls().slice(sectionsBefore).every((call) => /Points of the other sections:/.test(call.body.messages[1].content)));
  const overview = await overviewOf(walled);
  assert.ok(lineTexts(overview, "decisions").some((text: string) => text.includes("Richtung Natur")), "the overview stays until the person applies");
  assert.ok(overview.proposal);
  assert.deepEqual(overview.proposal.changes.documents, { added: [], changed: ["Protokoll.txt"], removed: [] });
  const decisions = overview.proposal.changes.sections.find((section: { kind: string }) => section.kind === "decisions");
  assert.ok(decisions.added.some((text: string) => text.includes("Richtung Technik")));
  assert.ok(decisions.removed.some((text: string) => text.includes("Richtung Natur")));
  assert.equal(overview.proposal.changes.sections.length, 1);

  const applied = await app.inject({ method: "POST", url: `/projects/${walled}/overview/proposal/apply`, headers: desktop });
  assert.equal(applied.statusCode, 200, applied.body);
  const now = applied.json().overview;
  assert.equal(now.proposal, null);
  assert.ok(lineTexts(now, "decisions").some((text: string) => text.includes("Richtung Technik")));
  assert.ok(!lineTexts(now, "decisions").some((text: string) => text.includes("Richtung Natur")));
});

test("a proposal ignored is not proposed again until something else changes", async () => {
  write(join(velora, "Mail Kunde.txt"), "Von: Kunde\nDatum: 27.02.2026\nDer Stand: zwei Namen sind in der engeren Wahl.");
  await indexed();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await overviewsIdle();
  assert.ok((await overviewOf(walled)).proposal);
  const ignored = await app.inject({ method: "POST", url: `/projects/${walled}/overview/proposal/ignore`, headers: desktop });
  assert.equal(ignored.statusCode, 200, ignored.body);
  assert.ok(lineTexts(ignored.json().overview, "status").some((text: string) => text.includes("drei Namen")));
  const before = runtime.calls.length;
  await app.inject({ method: "POST", url: `/projects/${walled}/overview/refresh`, headers: desktop });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await overviewsIdle();
  assert.equal(runtime.calls.length, before);
  assert.equal((await overviewOf(walled)).proposal, null);
  assert.equal((await app.inject({ method: "POST", url: `/projects/${walled}/overview/proposal/apply`, headers: desktop })).statusCode, 404);
});

test("a walled-off project's overview does not exist for anyone else, and its Word export is this computer's app's", async () => {
  for (const [method, url] of [["GET", "overview"], ["POST", "overview"], ["POST", "overview/refresh"], ["GET", "overview/document"], ["POST", "overview/proposal/apply"]] as const) {
    const response = await app.inject({ method, url: `/projects/${walled}/${url}`, headers: stranger, payload: method === "POST" ? {} : undefined });
    assert.equal(response.statusCode, 404, `${method} ${url}: ${response.body}`);
  }
  const document = await app.inject({ method: "GET", url: `/projects/${walled}/overview/document`, headers: desktop });
  assert.equal(document.statusCode, 200);
  const xml = strFromU8(unzipSync(new Uint8Array(document.rawPayload))["word/document.xml"]!);
  assert.match(xml, /Projektübersicht/);
  assert.match(xml, /Entscheidungen/);
  assert.match(xml, /Richtung Technik/);
  assert.match(xml, /Quelle: Protokoll\.txt/);
});

test("another project reads the folder chosen for it, never a walled-off project's documents inside it", async () => {
  const made = await app.inject({ method: "POST", url: "/projects", headers: desktop, payload: { project: { title: "Agenturplanung" } } });
  plain = made.json().project.id;
  const without = await app.inject({ method: "POST", url: `/projects/${plain}/overview`, headers: desktop, payload: { language: "de" } });
  assert.equal(without.statusCode, 409);
  assert.equal(without.json().error, "no_folder");
  // Never a walled-off project's folder, never from a device.
  assert.equal((await app.inject({ method: "PUT", url: `/projects/${plain}/overview/folder`, headers: desktop, payload: { path: velora } })).json().error, "walled_folder");
  assert.equal((await app.inject({ method: "PUT", url: `/projects/${plain}/overview/folder`, headers: stranger, payload: { path: docs } })).statusCode, 403);
  // Documents (holding Kunde Velora): granted now, it was not.
  const chosen = await app.inject({ method: "PUT", url: `/projects/${plain}/overview/folder`, headers: desktop, payload: { path: docs, language: "de" } });
  assert.equal(chosen.statusCode, 200, chosen.body);
  assert.equal(chosen.json().overview.folder_name, "Documents");
  await indexed();
  const before = documentCalls().length;
  await app.inject({ method: "POST", url: `/projects/${plain}/overview`, headers: desktop, payload: { language: "de" } });
  await overviewsIdle();
  const overview = await overviewOf(plain);
  assert.equal(overview.error, null);
  assert.equal(overview.documents.read, 1);
  const read = documentCalls().slice(before).map((call) => call.body.messages[1].content as string);
  assert.equal(read.length, 1);
  assert.match(read[0]!, /Jahresplanung/);
  assert.ok(read.every((text) => !/Velora|Natur|Technik|Markenrecherche/.test(text)), "nothing of the walled-off project reaches another project's overview");
  // A device of the person's gets it, never a path.
  assert.equal((await overviewOf(plain, stranger)).folder, undefined);
  const sources = (await overviewOf(plain, stranger)).sections.flatMap((section: { lines: Array<{ sources: Array<Record<string, unknown>> }> }) => section.lines.flatMap((line) => line.sources));
  assert.ok(sources.length && sources.every((source: Record<string, unknown>) => !("path" in source)));
});

test("an answer goes first: the overview waits while the computer answers", async () => {
  const done = beginGeneration("chat");
  const before = runtime.calls.length;
  write(join(agentur, "Jahresplanung.txt"), "Jahresplanung der Agentur\nDatum: 06.01.2026\nWir haben uns für drei neue Stellen entschieden.");
  await indexed();
  await app.inject({ method: "POST", url: `/projects/${plain}/overview/refresh`, headers: desktop });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(runtime.calls.length, before, "nothing asked of the model during an answer");
  assert.equal((await overviewOf(plain)).progress?.stage, "reading");
  done();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await overviewsIdle();
  assert.ok(runtime.calls.length > before);
  assert.ok((await overviewOf(plain)).proposal);
});

test("Documents switched off: no overview is made", async () => {
  await app.inject({ method: "PATCH", url: "/local_capabilities/documents", headers: desktop, payload: { enabled: false } });
  const refused = await app.inject({ method: "POST", url: `/projects/${walled}/overview`, headers: desktop, payload: { language: "de" } });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, "documents_off");
  await app.inject({ method: "PATCH", url: "/local_capabilities/documents", headers: desktop, payload: { enabled: true } });
});
