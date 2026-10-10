import assert from "node:assert/strict";
import test from "node:test";
import { ocrLanguageArgs } from "../src/documents/ocr.ts";
import { languagesFrom } from "../src/executors/ocr.ts";

// Scanned pages in the app's ten languages (10/10/2026: a Japanese scan
// came out as garbage, French and English were the only languages asked).

test("the Mac's helper detects the language unless a list is set; the person's language goes first", () => {
  assert.deepEqual(ocrLanguageArgs({}), [], "no list: Vision detects the language");
  assert.deepEqual(ocrLanguageArgs({ TWOODY_OCR_PREFER: "ja" }), ["--prefer", "ja"]);
  assert.deepEqual(ocrLanguageArgs({ TWOODY_OCR_PREFER: "zh-Hant-TW" }), ["--prefer", "zh-Hant-TW"]);
  assert.deepEqual(ocrLanguageArgs({ TWOODY_OCR_LANGUAGES: "fr-FR,en-US" }), ["--languages", "fr-FR,en-US"]);
  assert.deepEqual(ocrLanguageArgs({ TWOODY_OCR_PREFER: "--languages x" }), [], "never an option of its own");
});

test("Tesseract is given the app's languages it has, never one it would refuse", () => {
  const listing = 'List of available languages in "/usr/share/tesseract-ocr/5/tessdata/" (6):\neng\nfra\njpn\nkor\nosd\nchi_sim\n';
  assert.equal(languagesFrom(listing), "eng+fra+jpn+chi_sim+kor");
  assert.equal(languagesFrom("eng\nosd\n"), "eng");
  assert.equal(languagesFrom(null), "fra+eng");
});
