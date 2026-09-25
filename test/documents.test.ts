import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkSections, CHUNK_TARGET_CHARS } from "../src/documents/chunk.js";
import { extractSections, isSupported } from "../src/documents/extract.js";
import { buildMatchQuery, queryTerms, selectPassages, termsFound } from "../src/documents/query.js";
import { buildChatMessages } from "../src/chatContext.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test("a PDF yields its text page by page, accents intact", async () => {
  const sections = await extractSections(fixture("contrat-dupont.pdf"));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].page, 1);
  assert.match(sections[0].text, /CONTRAT DE LICENCE DE BREVET/);
  assert.match(sections[0].text, /préavis de six mois/);
});

test("a .docx yields its paragraphs", async () => {
  const [section] = await extractSections(fixture("contrat-dupont.docx"));
  assert.equal(section.page, null);
  assert.match(section.text, /Valvex SAS, représentée par Madame Claire Dupont/);
  assert.match(section.text, /Article 9 — Durée et résiliation\n/);
});

test("RTF, HTML and legacy encodings are read as text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-extract-"));
  try {
    // The em dash is RTF's decimal escape for U+2014, spelled with a
    // variable so no tool along the way reads it as a JS escape.
    const emDash = "\\" + "u8212?";
    writeFileSync(
      join(dir, "note.rtf"),
      String.raw`{\rtf1\ansi{\fonttbl{\f0 Helvetica;}}\f0 D\'e9lai de pr\'e9avis\par Six mois ` + emDash + " ferme.}",
    );
    writeFileSync(join(dir, "page.html"), "<html><style>p{color:red}</style><body><p>Caf&eacute; &amp; th&#233;</p><script>x()</script></body></html>");
    writeFileSync(join(dir, "ancien.txt"), Buffer.from("Société générale", "latin1"));

    assert.equal((await extractSections(join(dir, "note.rtf")))[0].text, "Délai de préavis\nSix mois — ferme.");
    assert.equal((await extractSections(join(dir, "page.html")))[0].text, "Caf&eacute; & thé");
    assert.equal((await extractSections(join(dir, "ancien.txt")))[0].text, "Société générale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only document formats are indexed", () => {
  for (const name of ["a.pdf", "b.DOCX", "c.md", "d.rtf", "e.odt"]) assert.equal(isSupported(name), true, name);
  for (const name of ["photo.jpg", "app.exe", "archive.zip", "Makefile", "data.sqlite"]) assert.equal(isSupported(name), false, name);
});

test("chunks respect the target size, keep page numbers and overlap", () => {
  const paragraph = (n: number) => `Article ${n}. ` + "Le licencié s'engage à respecter les conditions prévues. ".repeat(12);
  const chunks = chunkSections([
    { page: 1, text: [1, 2, 3].map(paragraph).join("\n\n") },
    { page: 2, text: paragraph(4) },
  ]);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.text.length <= CHUNK_TARGET_CHARS + 200), "a chunk is far over target");
  assert.deepEqual(chunks.map((chunk) => chunk.position), chunks.map((_, index) => index));
  assert.equal(chunks[0].page, 1);
  assert.equal(chunks[chunks.length - 1].page, 2);
  assert.match(chunks[chunks.length - 1].text, /^Article 4\./, "a new page starts a new chunk");
});

test("a single oversized sentence is still cut", () => {
  const chunks = chunkSections([{ page: null, text: "x".repeat(5_000) }]);
  assert.ok(chunks.length >= 4);
  assert.ok(chunks.every((chunk) => chunk.text.length <= CHUNK_TARGET_CHARS));
});

test("questions become OR-ed FTS5 terms without stopwords", () => {
  assert.deepEqual(queryTerms("Quel est le délai de préavis pour résilier le contrat ?"), ["delai", "preavis", "resilier", "contrat"]);
  assert.equal(buildMatchQuery("Quel est le délai de préavis ?"), '"delai" OR "preavi"*');
  assert.equal(buildMatchQuery("et le la de ?"), null);
});

test("long words match as stems; numbers and codes match exactly", () => {
  assert.equal(buildMatchQuery("redevances"), '"redevanc"*');
  assert.equal(buildMatchQuery("brevet EP 3456789"), '"brevet"* OR "3456789"');
  assert.equal(buildMatchQuery("article R2"), '"articl"* OR "r2"');
});

test("FTS5 operators typed by the user stay literal", () => {
  const query = buildMatchQuery('contrat NEAR("x") AND NOT brevet OR *')!;
  assert.doesNotMatch(query, /NEAR\(|\bAND\b|\bNOT\b/);
  assert.match(query, /^("[a-z0-9]+"\*?)( OR "[a-z0-9]+"\*?)*$/);
});

test("a passage far behind the best one still goes to the model when it holds several of the question's words", () => {
  // Scores as FTS5 gave them in a folder of three documents, where
  // "contrat", "préavis" and "Dupont" are in nearly every passage.
  const terms = queryTerms("Mme Dupont veut résilier le contrat de prestation avant la fin de l'année. Quel préavis doit-elle respecter ?");
  const rows = [
    { document_id: "note", text: "Rendez-vous avec Mme Dupont : elle souhaite résilier le contrat de prestation avant la fin de l'année. Vérifier le préavis.", score: -4.39 },
    { document_id: "contrat", text: "Article 4 — Durée et préavis. Chaque partie peut le résilier par lettre recommandée avec un préavis de trois mois. Madame Claire Dupont.", score: -0.000002 },
    { document_id: "avenant", text: "Au contrat de prestation de services : le préavis prévu à l'article 4 est ramené à un mois.", score: -0.000001 },
    { document_id: "tarif", text: "Le prix de la maintenance est revu chaque année.", score: -0.0000005 },
  ];
  assert.deepEqual(selectPassages(rows, terms, 6, 3).map((row) => row.document_id), ["note", "contrat", "avenant"]);
  assert.equal(termsFound("Le préavis de résiliation", ["preavis", "resilier", "contrat"]), 2);
});

test("excerpts are numbered on the last message and announced in the system prompt", () => {
  const messages = buildChatMessages({
    userName: null,
    prefs: {},
    history: [],
    memories: [],
    content: "Quel est le préavis ?",
    hasDocuments: true,
    excerpts: [
      { name: "contrat.pdf", page: 3, text: "Préavis de six mois." },
      { name: "note.docx", page: null, text: "Voir l'article 9." },
    ],
    local: true,
  });
  assert.match(messages[0].content, /cite the ones you used like \[1\]/);
  const prompt = messages[1].content;
  assert.match(prompt, /^\[Excerpts from the user's documents\]\n\[1\] contrat\.pdf, p\. 3\nPréavis de six mois\.\n\n\[2\] note\.docx\nVoir l'article 9\.\n\[End of excerpts\]\n\nQuel est le préavis \?$/);
});

test("without an index the system prompt says nothing about documents", () => {
  const [system] = buildChatMessages({ userName: null, prefs: {}, history: [], memories: [], content: "Bonjour", local: true });
  assert.doesNotMatch(system.content, /documents/);
});
