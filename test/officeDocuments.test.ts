import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChatMessages } from "../src/chatContext.js";
import { chunkSections } from "../src/documents/chunk.js";
import { extractSections, isSupported, maxBytesFor, MAX_FILE_BYTES } from "../src/documents/extract.js";
import { excerptPlace, passageLocation } from "../src/documents/location.js";
import { formatValue, generalNumber } from "../src/documents/numberFormat.js";
import { MAX_SHEET_ROWS, readDelimited, sheetMarker } from "../src/documents/spreadsheet.js";
import { ZipError } from "../src/documents/zipParts.js";
import { openDocumentFile, worksheet, xlsxFile } from "./helpers/officeFiles.js";

// Excel and PowerPoint read like PDFs and Word files (owner's request,
// 04/10/2026: « tout le monde s'en sert »). The fixtures budget-tessane.xlsx
// and presentation-tessane.pptx were written by XlsxWriter and python-pptx
// (test/fixtures/office-fixtures.py), not by Twoody; the other files are
// built here. Fictional data throughout.

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "twoody-office-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, bytes: Uint8Array | string) => {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
};

test("Excel, PowerPoint and OpenDocument files are indexed; zipped ones up to their own size", () => {
  for (const name of ["a.xlsx", "b.XLSM", "c.ods", "d.pptx", "e.pptm", "f.ppsx", "g.odp", "h.csv", "i.tsv"]) assert.equal(isSupported(name), true, name);
  for (const name of ["a.xls", "b.ppt", "c.numbers", "d.key", "e.xlsb"]) assert.equal(isSupported(name), false, name);
  assert.ok(maxBytesFor("deck.pptx") > MAX_FILE_BYTES, "a deck full of photos is read part by part");
  assert.equal(maxBytesFor("report.pdf"), MAX_FILE_BYTES);
});

test("a workbook: each sheet its own passages, named, with its header, computed results and formatted cells", async () => {
  const sections = await extractSections(fixture("budget-tessane.xlsx"));
  assert.ok(sections.every((section) => section.table && section.page === null));
  const [sales, summary, notes] = sections.map((section) => section.text);

  // The merged title stays a line; the header row heads the table.
  assert.match(sales!, /^\[Sheet "Ventes T1", rows 1–9 of 9\]\nVentes du premier trimestre 2026 — Tessane\n\| Row \| Date \| Client \| Produit \| Quantité \| Prix unitaire \| Montant \|\n\| --- \|/);
  // Dates as the format writes them, amounts with their decimals and symbol, formulas' results.
  assert.match(sales!, /\| 3 \| 05\/01\/2026 \| Claire Martin \| Abonnement annuel \| 2 \| 120\.00 € \| 240\.00 € \|/);
  assert.match(sales!, /\| 7 \| 09\/03\/2026 \| Atelier Lumière \| Matériel \| 4 \| 312\.25 € \| 1249\.00 € \|/);
  assert.match(sales!, /\| 9 \| \| \| \| \| Total \| 3535\.50 € \|/);
  assert.doesNotMatch(sales!, /46027|D3\*E3|SUM\(/, "no serial dates, no formulas when their results are stored");

  // Years as a header; a label merged down two rows is in each; percent, a French long date, a boolean, an error.
  assert.match(summary!, /^\[Sheet "Synthèse", rows 1–6 of 6\]\n\| Row \| Indicateur \| 2025 \| 2026 \|/);
  assert.match(summary!, /\| 2 \| Chiffre d'affaires \| 9800\.00 € \| 3535\.50 € \|\n\| 3 \| Chiffre d'affaires \| 12\.0% \| 15\.3% \|/);
  assert.match(summary!, /\| 4 \| Clôture de l'exercice \| \| 31 décembre 2026 \|/);
  assert.match(summary!, /\| 5 \| Objectif atteint \| \| TRUE \|\n\| 6 \| Marge sur remise \| \| #DIV\/0! \|/);

  // A hidden sheet says so; a cell's line break and bar stay inside its column.
  assert.match(notes!, /^\[Sheet "Notes" \(hidden\), rows 1–3 of 3\]/);
  assert.match(notes!, /\| 2 \| Relancer Claire Martin pour le renouvellement\. \/ Devis envoyé le 2 mars\. \|/);
  assert.match(notes!, /\| 3 \| Prix \\\| remise négociée : voir le contrat \|/);

  // One passage per block, never cut again.
  assert.equal(chunkSections(sections).length, sections.length);
});

test("a presentation: one section per slide with text, its table and its speaker notes; a slide without text gives none", async () => {
  const sections = await extractSections(fixture("presentation-tessane.pptx"));
  assert.deepEqual(sections.map((section) => [section.page, section.unit]), [[1, "slide"], [2, "slide"], [3, "slide"], [5, "slide"]]);
  assert.equal(sections[0]!.text, "Tessane — bilan du premier trimestre\nRéunion du 2 avril 2026");
  assert.match(sections[1]!.text, /^Ce qui a marché\nTrois nouveaux clients, dont Atelier Lumière\nLes formations : 1700 € sur le trimestre\n/);
  assert.match(sections[1]!.text, /\n\nSpeaker notes:\nDire que la formation de mars a été la plus rentable : marge de 41 %\.$/);
  assert.match(sections[2]!.text, /Client \| Montant\nClaire Martin \| 1316\.50 €\nAtelier Lumière \| 2099\.00 €/);
  assert.match(sections[3]!.text, /Speaker notes:\nBudget prévu : 3 000 € par mois/);
  // Each slide its own passage, as a PDF's page is.
  assert.deepEqual(chunkSections(sections).map((chunk) => chunk.page), [1, 2, 3, 5]);
});

test("cells written by other programs: prefixed elements, inline strings, ISO dates, rich text, rows and cells without references", async () => {
  const xml = `<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>` +
    `<x:row><x:c t="inlineStr"><x:is><x:t>Client</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:t>Échéance</x:t></x:is></x:c><x:c t="s"><x:v>0</x:v></x:c></x:row>` +
    `<x:row><x:c t="inlineStr"><x:is><x:t>Claire &amp; Martin</x:t></x:is></x:c><x:c t="d"><x:v>2026-04-30T00:00:00</x:v></x:c><x:c t="str"><x:f>"OK"</x:f><x:v>OK</x:v></x:c></x:row>` +
    `</x:sheetData></x:worksheet>`;
  const path = file("prefixes.xlsx", xlsxFile({ sheets: [{ name: "Échéances", xml }], sharedStrings: ["<r><t>Sta</t></r><r><rPr><b/></rPr><t>tut</t></r><rPh sb=\"0\" eb=\"1\"><t>ス</t></rPh>"] }));
  const [section] = await extractSections(path);
  assert.equal(section!.text, `[Sheet "Échéances", rows 1–2 of 2]\n| Row | Client | Échéance | Statut |\n| --- | --- | --- | --- |\n| 2 | Claire & Martin | 2026-04-30 | OK |`);
});

test("a formula whose result was never computed is said as a formula; 1904 dates and times keep their day and hour", async () => {
  const rows =
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>` +
    `<row r="2"><c r="A2" s="1"><v>0</v></c><c r="B2" s="2"><v>0.75</v></c><c r="C2"><f>SUM(D2:D9)</f><v>0</v></c></row>` +
    `<row r="3"><c r="A3" s="1"><v>1</v></c><c r="B3" s="3"><v>0.0625</v></c><c r="C3"><f>D3*2</f></c></row>`;
  const path = file("calc.xlsx", xlsxFile({
    sheets: [{ name: "Calc", xml: worksheet(rows) }],
    sharedStrings: ["Jour", "Heure", "Total"],
    numFmts: [[164, "yyyy-mm-dd"]],
    cellFormats: [0, 164, 20, 46],
    workbookPr: `<workbookPr date1904="1"/>`,
    calcPr: `<calcPr calcId="0" fullCalcOnLoad="1"/>`,
  }));
  const [section] = await extractSections(path);
  assert.match(section!.text, /\| 2 \| 1904-01-01 \| 18:00 \| =SUM\(D2:D9\) \|\n\| 3 \| 1904-01-02 \| 1:30:00 \| =D3\*2 \|/);
});

test("a sheet past the cap: every block repeats its header, and says which rows were not read", async () => {
  const total = MAX_SHEET_ROWS + 120;
  let rows = `<row r="1"><c r="A1" t="inlineStr"><is><t>Date</t></is></c><c r="B1" t="inlineStr"><is><t>Client</t></is></c><c r="C1" t="inlineStr"><is><t>Montant</t></is></c></row>`;
  for (let r = 2; r <= total; r += 1) rows += `<row r="${r}"><c r="A${r}" s="1"><v>${46000 + (r % 300)}</v></c><c r="B${r}" t="inlineStr"><is><t>Client ${r}</t></is></c><c r="C${r}" s="2"><v>${r * 1.5}</v></c></row>`;
  const path = file("grand-livre.xlsx", xlsxFile({ sheets: [{ name: "Écritures", xml: worksheet(rows, "", `A1:C${total}`) }], numFmts: [[164, "dd/mm/yyyy"]], cellFormats: [0, 164, 4] }));
  const started = Date.now();
  const sections = await extractSections(path);
  assert.ok(Date.now() - started < 10_000, "read in a few seconds");
  assert.ok(sections.length > 100);
  for (const section of sections) {
    assert.match(section.text, /\n\| Row \| Date \| Client \| Montant \|\n\| --- \| --- \| --- \| --- \|\n/, "the header in each block");
    assert.match(section.text, new RegExp(`^\\[Sheet "Écritures", rows \\d+–\\d+ of ${total}; rows after ${MAX_SHEET_ROWS} not read: the sheet is too large\\]`));
    assert.ok(section.text.length <= 4_000);
  }
  const last = sections[sections.length - 1]!.text;
  assert.match(last, new RegExp(`\\| ${MAX_SHEET_ROWS} \\| \\d\\d/\\d\\d/\\d{4} \\| Client ${MAX_SHEET_ROWS} \\| ${(MAX_SHEET_ROWS * 1.5).toFixed(2)} \\|$`));
  assert.doesNotMatch(last, new RegExp(`Client ${MAX_SHEET_ROWS + 1}\\b`));
  // Blocks follow each other without a gap or an overlap.
  const ranges = sections.map((section) => passageLocation("grand-livre.xlsx", null, section.text));
  for (let i = 1; i < ranges.length; i += 1) {
    const [previous, current] = [ranges[i - 1], ranges[i]];
    assert.ok(previous?.kind === "sheet" && current?.kind === "sheet");
    assert.equal(current.rows[0], previous.rows[1] + 1);
  }
});

test("OpenDocument: a spreadsheet's tables with repeated rows and columns, a presentation's pages and notes", async () => {
  const cell = (text: string, type = "string", value = "") => `<table:table-cell office:value-type="${type}"${value ? ` office:value="${value}"` : ""}><text:p>${text}</text:p></table:table-cell>`;
  const ods = file("suivi.ods", openDocumentFile("spreadsheet",
    `<table:table table:name="Suivi 2026"><table:table-column table:number-columns-repeated="3"/>` +
    `<table:table-row>${cell("Client")}${cell("Montant")}${cell("Payé")}</table:table-row>` +
    `<table:table-row>${cell("Tessane")}${cell("1 250,00 €", "currency", "1250")}<table:table-cell office:value-type="boolean" office:boolean-value="true"><text:p>VRAI</text:p><office:annotation><text:p>vérifié</text:p></office:annotation></table:table-cell></table:table-row>` +
    `<table:table-row table:number-rows-repeated="2">${cell("Claire Martin")}<table:covered-table-cell/>${cell("À relancer")}</table:table-row>` +
    `<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>` +
    `</table:table><table:table table:name="Vide"><table:table-row><table:table-cell/></table:table-row></table:table>`));
  const [sheet, ...rest] = await extractSections(ods);
  assert.equal(rest.length, 0, "an empty table gives nothing");
  assert.equal(sheet!.text, `[Sheet "Suivi 2026", rows 1–4 of 4]\n| Row | Client | Montant | Payé |\n| --- | --- | --- | --- |\n| 2 | Tessane | 1 250,00 € | VRAI |\n| 3 | Claire Martin | | À relancer |\n| 4 | Claire Martin | | À relancer |`);

  const odp = file("atelier.odp", openDocumentFile("presentation",
    `<draw:page draw:name="page1"><draw:frame><draw:text-box><text:p>Atelier Lumière</text:p><text:p>Plan<text:s text:c="2"/>2026</text:p></draw:text-box></draw:frame><presentation:notes><draw:frame><draw:text-box><text:p>Parler du devis de Tessane.</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>` +
    `<draw:page draw:name="page2"><draw:frame><draw:text-box><text:h>Calendrier</text:h><text:p>Livraison en juin</text:p></draw:text-box></draw:frame></draw:page>`));
  const slides = await extractSections(odp);
  assert.deepEqual(slides.map((section) => [section.page, section.unit, section.text]), [
    [1, "slide", "Atelier Lumière\nPlan 2026\n\nSpeaker notes:\nParler du devis de Tessane."],
    [2, "slide", "Calendrier\nLivraison en juin"],
  ]);
});

test("CSV and TSV: tables whatever their separator, quotes kept whole; text that is no table stays text", async () => {
  const csv = file("releve.csv", "\uFEFFDate;Libellé;Montant\n03/01/2026;\"Abonnement; Tessane\";-12,50\n05/01/2026;Virement Claire Martin;250,00\n");
  const [table] = await extractSections(csv);
  assert.equal(table!.text, `[Rows 1–3 of 3]\n| Row | Date | Libellé | Montant |\n| --- | --- | --- | --- |\n| 2 | 03/01/2026 | Abonnement; Tessane | -12,50 |\n| 3 | 05/01/2026 | Virement Claire Martin | 250,00 |`);
  const tsv = file("export.tsv", "Nom\tVille\nTessane\tLyon\nClaire Martin\tNantes\n");
  assert.match((await extractSections(tsv))[0]!.text, /^\[Rows 1–3 of 3\]\n\| Row \| Nom \| Ville \|/);
  const prose = "Bonjour, voici mes notes.\nRien de plus, merci.\nÀ demain.";
  assert.equal(readDelimited(prose), null);
  assert.deepEqual(await extractSections(file("notes.csv", prose)), [{ page: null, text: prose }]);
});

test("a protected or damaged Office file is refused with its reason, never read as text", async () => {
  // A file protected by a password is a compound file, not a zip.
  const compound = new Uint8Array(512);
  compound.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  await assert.rejects(extractSections(file("protege.xlsx", compound)), (err) => err instanceof ZipError && err.reason === "encrypted");
  await assert.rejects(extractSections(file("abime.pptx", "PK\u0003\u0004 not really a zip")), (err) => err instanceof ZipError && err.reason === "not_a_zip");
});

test("numbers as their format shows them, without grouping, with a point", () => {
  const cases: Array<[number, string, string]> = [
    [1250, '#,##0.00\\ "€"', "1250.00 €"],
    [1250, "#,##0.00 [$€-40C]", "1250.00 €"],
    [-1250.5, '_-* #,##0.00 €_-;-* #,##0.00 €_-;_-* "-"?? €_-;_-@_-', "-1250.50 €"],
    [0, '_-* #,##0.00 €_-;-* #,##0.00 €_-;_-* "-"?? €_-;_-@_-', "0.00 €"],
    [0.153, "0.0%", "15.3%"],
    [1.005, "0.00", "1.01"],
    [-42, "#,##0 ;(#,##0)", "(42)"],
    [123456, "0.00E+00", "1.23E+05"],
    [1500, '#,##0.0,"k"', "1.5k"],
    [7, "00", "07"],
    [-1250, "$#,##0.00", "-$1250.00"],
    [45295, "yyyy-mm-dd", "2024-01-04"],
    [45295.75, "dd/mm/yyyy hh:mm", "04/01/2024 18:00"],
    [45295, "[$-40C]dddd d mmmm yyyy", "jeudi 4 janvier 2024"],
    [45295, "d mmm yy", "4 Jan 24"],
    [0.5, "h:mm AM/PM", "12:00 PM"],
    [1.5, "[h]:mm:ss", "36:00:00"],
    [0.0104166, "mm:ss", "15:00"],
    [45295, "[$-F800]dddd, mmmm dd, yyyy", "2024-01-04"],
    [2.5, "# ?/?", "2.5"],
  ];
  for (const [value, code, shown] of cases) assert.equal(formatValue(value, code), shown, code);
  assert.equal(generalNumber(0.1 + 0.2), "0.3");
  assert.equal(formatValue(42, null), "42");
});

test("citations name the page, the slide, or the sheet and its rows", () => {
  const sales = `${sheetMarker("Ventes T1", 3, 14, 40, [])}\n| Row | Date |`;
  assert.deepEqual(passageLocation("budget.xlsx", null, sales), { kind: "sheet", sheet: "Ventes T1", rows: [3, 14] });
  assert.deepEqual(passageLocation("releve.csv", null, `${sheetMarker(null, 2, 31, 500, ["rows after 31 not read: the file is too large"])}\n| Row |`), { kind: "sheet", sheet: null, rows: [2, 31] });
  assert.deepEqual(passageLocation("odd.xlsx", null, `${sheetMarker('Prix "nets"', 1, 2, null, [], true)}\nx`), { kind: "sheet", sheet: 'Prix "nets"', rows: [1, 2] });
  assert.deepEqual(passageLocation("pitch.pptx", 4, "Prochaines étapes"), { kind: "slide", slide: 4 });
  assert.deepEqual(passageLocation("contrat.pdf", 2, "Article 9"), { kind: "page", page: 2 });
  assert.equal(passageLocation("notes.docx", null, "texte"), null);
  // A PDF that happens to start like a sheet is still a PDF.
  assert.deepEqual(passageLocation("rapport.pdf", 1, sales), { kind: "page", page: 1 });
  assert.equal(excerptPlace("pitch.pptx", 4, "x"), "slide 4");
  assert.equal(excerptPlace("budget.xlsx", null, sales), null);

  const prompt = buildChatMessages({
    userName: null,
    prefs: {},
    history: [],
    memories: [],
    content: "Combien a payé Claire Martin ?",
    hasDocuments: true,
    excerpts: [
      { name: "budget.xlsx", page: null, text: sales },
      { name: "pitch.pptx", page: 2, text: "Ce qui a marché" },
      { name: "contrat.pdf", page: 3, text: "Préavis de six mois." },
    ],
    local: true,
  })[1]!.content;
  assert.match(prompt, /\[1\] budget\.xlsx\n\[Sheet "Ventes T1", rows 3–14 of 40\]\n\| Row \| Date \|\n\n\[2\] pitch\.pptx, slide 2\nCe qui a marché\n\n\[3\] contrat\.pdf, p\. 3\n/);
});
