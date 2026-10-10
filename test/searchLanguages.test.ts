import assert from "node:assert/strict";
import test from "node:test";
import { languageStem, searchLanguage } from "../src/documents/languages.ts";
import { buildMatchQuery, queryTerms, termsFound } from "../src/documents/query.ts";

// German, Spanish, Italian, Portuguese and Dutch in the documents' keyword
// search (10/10/2026): their small words left out, their plurals met, as
// French and English ones already were — French and English unchanged
// (test/cjkSearch.test.ts holds their expressions from before).

test("German: small words left out, plurals and inflections met", () => {
  assert.equal(buildMatchQuery("Wie lang ist die Kündigungsfrist im Mietvertrag?"), '"kundigungsfrist"* OR "mietvertrag"*');
  assert.equal(buildMatchQuery("Welche Rechnungen habe ich von der Telekom?"), '"rechnung"* OR "telekom"*');
  assert.equal(termsFound("Rechnung Nr. 4 der Telekom", queryTerms("Welche Rechnungen habe ich von der Telekom?")), 2);
  assert.equal(languageStem("de", "vertrage"), "vertrag", "Verträge, accents folded");
});

test("Spanish: small words left out, plurals met", () => {
  assert.equal(buildMatchQuery("¿Cuál es el plazo de preaviso del contrato?"), '"plazo" OR "preaviso"* OR "contrato"*');
  assert.equal(buildMatchQuery("¿Dónde están las facturas de la luz?"), '"factura"* OR "luz"');
  assert.equal(termsFound("Factura n.º 12 — luz", queryTerms("¿Dónde están las facturas de la luz?")), 2);
  assert.equal(languageStem("es", "rescisiones"), "rescision");
});

test("Italian: small words left out, singular and plural share their stem", () => {
  assert.equal(buildMatchQuery("Qual è il preavviso nel contratto di affitto?"), '"preavvis"* OR "contratt"* OR "affitt"*');
  assert.equal(buildMatchQuery("Quanto ho pagato nelle fatture della luce?"), '"pagat"* OR "fattur"* OR "luce"');
  assert.equal(termsFound("La fattura della luce di ottobre", queryTerms("Quanto ho pagato nelle fatture della luce?")), 2);
});

test("Portuguese: small words left out, -ão / -ões and plurals met", () => {
  assert.equal(buildMatchQuery("Qual é o prazo de aviso prévio da rescisão do contrato?"), '"prazo" OR "aviso" OR "previo"* OR "rescis"* OR "contrato"*');
  assert.equal(buildMatchQuery("Quais são as faturas de energia?"), '"fatura"* OR "energia"*');
  assert.equal(languageStem("pt", "rescisoes"), languageStem("pt", "rescisao"));
});

test("Dutch: small words left out, a doubled vowel and its plural met", () => {
  assert.equal(buildMatchQuery("Wat is de opzegtermijn van het huurcontract?"), '"opzegtermij"* OR "huurcontrac"*');
  assert.equal(buildMatchQuery("Welke facturen heb ik van Eneco?"), '"factu"* OR "eneco"');
  assert.equal(termsFound("De factuur van Eneco", queryTerms("Welke facturen heb ik van Eneco?")), 2);
});

test("a question is taken for one of these languages only when its small words say so, more than French or English ones", () => {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const frenchOrEnglish = new Set(["de", "le", "la", "du", "est", "quel", "the", "is", "what", "was", "in", "of"]);
  assert.equal(searchLanguage(fold("Wie lang ist die Kündigungsfrist?"), frenchOrEnglish), "de");
  assert.equal(searchLanguage(fold("Quel est le délai de préavis du contrat ?"), frenchOrEnglish), null);
  assert.equal(searchLanguage(fold("What was in the contract of the van?"), frenchOrEnglish), null);
  assert.equal(searchLanguage(fold("Kündigungsfrist"), frenchOrEnglish), null, "one word says nothing");
});
