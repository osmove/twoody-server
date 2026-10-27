import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Scans read since the index was made (27/10/2026). Windows reads scanned
// pages from Desktop 0.13.115 on; the upgrade check on a real Windows machine
// found the scanned contract 0.13.114 had indexed still unread after the
// update: the file was unchanged, so the pass never read it again. Once scans
// are read, a pass reads the PDFs again, once, and indexes again only those
// with a page read by OCR.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-ocr-reread-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;
delete process.env.TWOODY_OCR_BIN;
delete process.env.TWOODY_OCR_ENGINE;

const { sqlite } = await import("../src/db.js");
const { addFolder, reindex } = await import("../src/documents/library.js");
const { folderRisk } = await import("../src/documents/folderRisk.js");
const { setSpotlightEnabled } = await import("../src/documents/spotlight.js");
const { ocrEngine } = await import("../src/documents/ocr.js");
setSpotlightEnabled(false);

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const home = realpathSync(homedir());
const tmpBase = realpathSync(tmpdir());
const base = folderRisk(join(tmpBase, "x"), home) === null ? tmpBase : home;
const docs = realpathSync(mkdtempSync(join(base, "twoody-ocr-reread-docs-")));
const work = mkdtempSync(join(tmpdir(), "twoody-ocr-reread-log-"));
const log = join(work, "calls.log");
test.after(() => {
  const trash = join(homedir(), ".Trash");
  mkdirSync(trash, { recursive: true });
  renameSync(docs, join(trash, `${basename(docs)}-${Date.now()}`));
  rmSync(work, { recursive: true, force: true });
});

const userId = "owner";
sqlite.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(userId, "owner@test.invalid", Date.now());
copyFileSync(fixture("contrat-dupont-scan.pdf"), join(docs, "contrat-scanne.pdf"));
copyFileSync(fixture("contrat-dupont.pdf"), join(docs, "contrat-texte.pdf"));

const pages = (name: string) =>
  (sqlite.prepare("SELECT c.page AS page, c.text AS text FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.name = ? ORDER BY c.page").all(name) as Array<{ page: number; text: string }>);
const indexedAt = (name: string) => (sqlite.prepare("SELECT indexed_at AS at FROM documents WHERE name = ?").get(name) as { at: number }).at;
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : []);
const marks = () => JSON.parse(readFileSync(join(process.env.TWOODY_DATA_DIR!, "documents-ocr.json"), "utf8"));

test("a scanned page indexed without OCR is read once scans are, and a PDF with all its text keeps its index", async () => {
  await addFolder(userId, docs);
  await reindex(userId);
  assert.deepEqual(pages("contrat-scanne.pdf").map((chunk) => chunk.page), [2]);
  const textIndexed = indexedAt("contrat-texte.pdf");

  // The update: the helper is there now (Windows' own OCR).
  Object.assign(process.env, { TWOODY_OCR_BIN: fixture("fake-ocr.mjs"), TWOODY_OCR_ENGINE: "windows", FAKE_OCR_LOG: log });
  try {
    await reindex(userId);
    const read = pages("contrat-scanne.pdf");
    assert.deepEqual(read.map((chunk) => chunk.page), [1, 2]);
    assert.match(read[0].text, /Texte lu par OCR, page 1/);
    assert.equal(indexedAt("contrat-texte.pdf"), textIndexed, "the PDF with its text is not indexed again");
    assert.deepEqual(calls().map((call) => basename(call[0])), ["contrat-scanne.pdf"], "only the page without text goes to the helper");
    assert.deepEqual(marks(), { owner: "windows" });

    // Once only.
    await reindex(userId);
    assert.equal(calls().length, 1);
  } finally {
    for (const key of ["TWOODY_OCR_BIN", "TWOODY_OCR_ENGINE", "FAKE_OCR_LOG"]) delete process.env[key];
  }
});

test("an index from before the mark was made with Vision on a Mac, and is not read again there", () => {
  assert.equal(ocrEngine({}), "none");
  assert.equal(ocrEngine({ TWOODY_OCR_BIN: "/x/twoody-ocr", TWOODY_OCR_ENGINE: "vision" }), "vision");
  assert.equal(ocrEngine({ TWOODY_OCR_BIN: "/x/twoody-ocr", TWOODY_OCR_ENGINE: "Windows" }), "windows");
  assert.equal(ocrEngine({ TWOODY_OCR_BIN: "/x/twoody-ocr", TWOODY_OCR_ENGINE: "../x" }), process.platform === "win32" ? "windows" : process.platform === "darwin" ? "vision" : "other");
});

test("on a Mac, an index made before the mark is taken as read with Vision: no PDF read again", async () => {
  rmSync(join(process.env.TWOODY_DATA_DIR!, "documents-ocr.json"));
  rmSync(log, { force: true });
  Object.assign(process.env, { TWOODY_OCR_BIN: fixture("fake-ocr.mjs"), TWOODY_OCR_ENGINE: "vision", FAKE_OCR_LOG: log });
  try {
    await reindex(userId);
    assert.deepEqual(calls(), []);
  } finally {
    for (const key of ["TWOODY_OCR_BIN", "TWOODY_OCR_ENGINE", "FAKE_OCR_LOG"]) delete process.env[key];
  }
});
