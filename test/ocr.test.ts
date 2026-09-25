import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSections } from "../src/documents/extract.js";

// Scanned pages are read by the helper TWOODY_OCR_BIN names (twoody-ocr on
// a Mac, Apple's Vision); here a stand-in answers instead. The fixture's
// first page is a picture of text, its second has real text.
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function withHelper<T>(env: Record<string, string | undefined>, run: (log: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "twoody-ocr-"));
  const log = join(dir, "calls.log");
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, { FAKE_OCR_LOG: log, ...env });
  try {
    return await run(log);
  } finally {
    for (const [key, value] of Object.entries({ ...saved, FAKE_OCR_LOG: undefined })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const calls = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

test("without a helper, a scanned page stays unread and the page with text is kept", async () => {
  await withHelper({ TWOODY_OCR_BIN: undefined }, async () => {
    const sections = await extractSections(fixture("contrat-dupont-scan.pdf"));
    assert.deepEqual(sections.map((section) => section.page), [2]);
    assert.match(sections[0].text, /ramené à un mois/);
  });
});

test("with a helper, only the page without text is read by OCR, and says so", async () => {
  await withHelper({ TWOODY_OCR_BIN: fixture("fake-ocr.mjs") }, async (log) => {
    const sections = await extractSections(fixture("contrat-dupont-scan.pdf"));
    assert.deepEqual(sections.map((section) => [section.page, Boolean(section.ocr)]), [[1, true], [2, false]]);
    assert.match(sections[0].text, /Texte lu par OCR, page 1/);
    assert.match(sections[1].text, /ramené à un mois/);
    const [call] = calls(log);
    assert.equal(call[0], fixture("contrat-dupont-scan.pdf"));
    assert.deepEqual(call.slice(1, 3), ["--pages", "1"]);
  });
});

test("a PDF that has its text is never sent to the helper", async () => {
  await withHelper({ TWOODY_OCR_BIN: fixture("fake-ocr.mjs") }, async (log) => {
    const sections = await extractSections(fixture("contrat-dupont.pdf"));
    assert.match(sections[0].text, /CONTRAT DE LICENCE DE BREVET/);
    assert.equal(sections[0].ocr, undefined);
    assert.deepEqual(calls(log), []);
  });
});

test("a helper that fails leaves the scan unread, without failing the document", async () => {
  await withHelper({ TWOODY_OCR_BIN: fixture("fake-ocr.mjs"), FAKE_OCR_FAIL: "1" }, async () => {
    const sections = await extractSections(fixture("contrat-dupont-scan.pdf"));
    assert.deepEqual(sections.map((section) => section.page), [2]);
  });
});
