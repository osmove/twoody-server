import { strToU8, zipSync } from "fflate";

// A Word document (.docx) from simple Markdown, for « Agir dans vos
// dossiers » (docs/agent-in-chat.md of twoody-desktop): a copy of the
// Agent's writer (twoody-desktop src/main/code/office.ts, 16/10/2026) — the
// server writes it without the Desktop (a Pi, `twoody serve`), and the
// Desktop's is not shared code. Headings, paragraphs, lists, tables,
// quotes, code; in Arial, which every Mac and every PC has. Keep both in
// step.

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type RunFormat = { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; size?: number };

/// A character escaped in Markdown (\* \_ \| …) is kept aside, in the
/// private-use area, until it is written: no emphasis, link or table
/// cell is read in it. Inside `code`, a backslash is a backslash.
const ESCAPED = /(`[^`]*`)|\\([\\`*_{}[\]()#+\-.!|~<>])/g;
const protect = (text: string) => text.replace(ESCAPED, (_match, code: string | undefined, char: string) => code ?? String.fromCharCode(0xe000 + char.charCodeAt(0)));
const restore = (text: string) => text.replace(/[\ue000-\ue07f]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xe000));

/// The font and size go on every run: Pages, Quick Look and TextEdit
/// read no other (a style's, the document's defaults), and fall back to
/// Times.
function run(text: string, format: RunFormat = {}): string {
  const font = format.code ? "Menlo" : "Arial";
  const size = format.size ?? 22;
  const props = `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>${format.bold ? "<w:b/>" : ""}${format.italic ? "<w:i/>" : ""}${format.strike ? "<w:strike/>" : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`;
  // A line break inside a paragraph stays one (an address, a signature).
  const lines = restore(text).split("\n");
  const body = lines.map((line, i) => `${i > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${xml(line)}</w:t>`).join("");
  return `<w:r><w:rPr>${props}</w:rPr>${body}</w:r>`;
}

/// **bold**, *italic* or _italic_ (not inside a word: file_name_v2 stays
/// as it is), ***both***, ~~struck~~, `code`, a link as its text and its
/// address, an image as its description; emphasis inside emphasis too.
export function inlineRuns(text: string, base: RunFormat = {}): string {
  const source = protect(text).replace(/<br\s*\/?>/gi, "\n");
  const out: string[] = [];
  // Bold may hold italic (**le contrat de *Tessane***), italic bold.
  const pattern = /(\*\*\*[^*]+\*\*\*|\*\*(?=\S)(?:[^*]|\*[^*\s][^*]*\*)+?\*\*|(?<![\p{L}\p{N}])__[^_]+__(?![\p{L}\p{N}])|~~[^~]+~~|\*(?=[^*\s])(?:[^*]|\*\*[^*]+\*\*)+?(?<!\s)\*(?!\*)|(?<![\p{L}\p{N}])_[^_\s][^_]*_(?![\p{L}\p{N}])|`[^`]+`|!?\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)|<https?:\/\/[^>\s]+>)/gu;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (match.index > last) out.push(run(source.slice(last, match.index), base));
    const token = match[0];
    if (token.startsWith("***")) out.push(inlineRuns(token.slice(3, -3), { ...base, bold: true, italic: true }));
    else if (token.startsWith("**") || token.startsWith("__")) out.push(inlineRuns(token.slice(2, -2), { ...base, bold: true }));
    else if (token.startsWith("~~")) out.push(inlineRuns(token.slice(2, -2), { ...base, strike: true }));
    else if (token.startsWith("`")) out.push(run(token.slice(1, -1), { ...base, code: true }));
    else if (token.startsWith("<")) out.push(run(token.slice(1, -1), base));
    else if (token.startsWith("[") || token.startsWith("![")) {
      const link = /^!?\[([^\]]*)\]\(([^)\s]+)/.exec(token)!;
      const label = link[1] ?? "";
      if (token.startsWith("!")) out.push(run(label, base));
      else {
        if (label) out.push(inlineRuns(label, base));
        if (label !== link[2]) out.push(run(label ? ` (${link[2]})` : link[2]!, base));
      }
    } else out.push(inlineRuns(token.slice(1, -1), { ...base, italic: true }));
    last = match.index + token.length;
  }
  if (last < source.length) out.push(run(source.slice(last), base));
  return out.join("");
}

function paragraph(text: string, props = "", format: RunFormat = {}): string {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${inlineRuns(text, format)}</w:p>`;
}

/// Heading sizes, in half-points: 16, 14 and 12 pt.
const HEADING_SIZES = [32, 28, 24];

/// The width of the text on an A4 page with the margins below, in
/// twentieths of a point.
const TEXT_WIDTH = 11906 - 2 * 1417;
const BORDER = 'w:val="single" w:sz="4" w:space="0" w:color="808080"';

/// Borders and widths set on the table itself: Pages and Quick Look do
/// not apply a table style's.
function tableXml(rows: string[][]): string {
  const columns = Math.max(...rows.map((row) => row.length));
  const width = Math.floor(TEXT_WIDTH / columns);
  const cell = (text: string, header: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="EFEFEF"/>' : ""}</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${inlineRuns(text, { bold: header, size: 20 })}</w:p></w:tc>`;
  const body = rows
    .map((row, i) => `<w:tr>${i === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ""}${Array.from({ length: columns }, (_, j) => cell(row[j] ?? "", i === 0)).join("")}</w:tr>`)
    .join("");
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join("");
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} ${BORDER}/>`).join("");
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${width * columns}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl><w:p/>`;
}

/// A table row's cells: split on its bars, not on an escaped one (\|).
export function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/// Simple Markdown as the body of a Word document: headings, paragraphs,
/// lists (by indentation, tasks ☐ ☑ too), tables, quotes, code, rules.
export function markdownToWordBody(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length) blocks.push(paragraph(buffer.join("\n")));
    buffer = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    // Code, as it is: in a fixed-width font, on a light background.
    const fence = /^(```|~~~)/.exec(trimmed);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i += 1; i < lines.length && !lines[i].trim().startsWith(fence[1]); i += 1) code.push(lines[i]);
      blocks.push(`<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F3F3"/><w:spacing w:after="160"/></w:pPr>${run(code.join("\n"), { code: true, size: 18 })}</w:p>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)(?:\s+#+)?$/.exec(trimmed);
    if (heading) {
      flush();
      const level = Math.min(3, heading[1].length);
      blocks.push(paragraph(heading[2].trim(), `<w:pStyle w:val="Heading${level}"/>`, { bold: true, size: HEADING_SIZES[level - 1] }));
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed.replace(/\s+/g, ""))) {
      flush();
      blocks.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>');
      continue;
    }
    if (trimmed.startsWith("|")) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = tableCells(lines[i]);
        if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) rows.push(cells);
        i += 1;
      }
      i -= 1;
      if (rows.length) blocks.push(tableXml(rows));
      continue;
    }
    // A quotation: set in, a rule on its left.
    if (trimmed.startsWith(">")) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) quoted.push(lines[i++].trim().replace(/^>\s?/, ""));
      i -= 1;
      blocks.push(paragraph(quoted.join("\n"), '<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="BBBBBB"/></w:pBdr><w:ind w:left="400"/>', { italic: true }));
      continue;
    }
    const list = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(line);
    if (list) {
      flush();
      const level = Math.min(4, Math.floor(list[1].replace(/\t/g, "    ").length / 2));
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(list[3]);
      const marker = task ? (task[1] === " " ? "☐" : "☑") : /\d/.test(list[2]) ? list[2].replace(")", ".") : "•";
      const left = 720 + level * 360;
      blocks.push(`<w:p><w:pPr><w:spacing w:after="60"/><w:ind w:left="${left}" w:hanging="360"/></w:pPr>${run(`${marker}\t`)}${inlineRuns(task ? task[2] : list[3])}</w:p>`);
      continue;
    }
    buffer.push(trimmed);
  }
  flush();
  return blocks.join("") || "<w:p/>";
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

/// A Word document (.docx): the few parts Word, Pages and LibreOffice
/// need, zipped. In Arial, which every Mac and every PC has, Office or
/// not (Calibri, Word's own, is missing where Office is).
export function wordDocument(markdown: string, title: string, now = new Date()): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${markdownToWordBody(markdown)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(document),
    "word/styles.xml": strToU8(STYLES),
    "docProps/core.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>Twoody</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`,
    ),
    "docProps/app.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Twoody</Application></Properties>`,
    ),
  };
  return zipSync(files, { level: 6 });
}
