import { strToU8, zipSync } from "fflate";

// Office files built in a test, for what the fixtures made by other
// programs (test/fixtures/*-tessane.*) do not show: namespace prefixes,
// inline strings, dates kept as text, formulas left to compute, a sheet
// past the cap, OpenDocument files. Fictional data only.

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export interface TestSheet {
  name: string;
  /// The worksheet's XML, whole.
  xml: string;
}

/// An .xlsx: its sheets' XML as given, shared strings and styles optional.
export function xlsxFile(options: { sheets: TestSheet[]; sharedStrings?: string[]; numFmts?: Array<[number, string]>; cellFormats?: number[]; workbookPr?: string; calcPr?: string }): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
  };
  const rels: string[] = [];
  const sheets: string[] = [];
  options.sheets.forEach((sheet, index) => {
    rels.push(`<Relationship Id="rId${index + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`);
    sheets.push(`<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`);
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheet.xml);
  });
  if (options.sharedStrings) {
    rels.push(`<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`);
    files["xl/sharedStrings.xml"] = strToU8(
      `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${options.sharedStrings.length}">${options.sharedStrings.map((text) => (text.startsWith("<") ? `<si>${text}</si>` : `<si><t xml:space="preserve">${text}</t></si>`)).join("")}</sst>`,
    );
  }
  if (options.cellFormats) {
    rels.push(`<Relationship Id="rIdT" Type="${REL}/styles" Target="styles.xml"/>`);
    const numFmts = options.numFmts?.length ? `<numFmts count="${options.numFmts.length}">${options.numFmts.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"/>`).join("")}</numFmts>` : "";
    files["xl/styles.xml"] = strToU8(
      `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts}<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="${options.cellFormats.length}">${options.cellFormats.map((id) => `<xf numFmtId="${id}" applyNumberFormat="1"/>`).join("")}</cellXfs></styleSheet>`,
    );
  }
  files["xl/_rels/workbook.xml.rels"] = strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}">${options.workbookPr ?? ""}<sheets>${sheets.join("")}</sheets>${options.calcPr ?? ""}</workbook>`,
  );
  return zipSync(files, { level: 1 });
}

/// A worksheet whose rows are given as XML.
export function worksheet(rows: string, extra = "", dimension?: string): string {
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${dimension ? `<dimension ref="${dimension}"/>` : ""}<sheetData>${rows}</sheetData>${extra}</worksheet>`;
}

/// An OpenDocument file (.ods, .odp) from its content.xml body.
export function openDocumentFile(kind: "spreadsheet" | "presentation", body: string): Uint8Array {
  const mime = kind === "spreadsheet" ? "application/vnd.oasis.opendocument.spreadsheet" : "application/vnd.oasis.opendocument.presentation";
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" office:version="1.3"><office:body><office:${kind}>${body}</office:${kind}></office:body></office:document-content>`;
  return zipSync({ mimetype: [strToU8(mime), { level: 0 }], "content.xml": strToU8(content) }, { level: 1 });
}
