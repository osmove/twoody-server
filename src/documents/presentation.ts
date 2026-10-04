import type { Section } from "./extract.js";
import { attribute, attributes, mainPart, odfParagraphs, ofType, relationships, xmlText } from "./officeXml.js";
import type { ZipParts } from "./zipParts.js";

// Presentations — PowerPoint (.pptx, .pptm, .ppsx) and OpenDocument
// (.odp) — slide by slide: each slide is a section numbered like a PDF's
// page, so an answer cites « pitch.pptx, slide 4 ». A slide gives its
// text in reading order (a table row by row, a SmartArt's words after),
// then its speaker notes, which often say more than the slide.

const MAX_SLIDES = 2_000;
const MAX_PART_BYTES = 16 * 1024 * 1024;

export async function readPptx(zip: ZipParts): Promise<Section[]> {
  const presentationPart = await mainPart(zip, "ppt/presentation.xml");
  const presentation = (await zip.text(presentationPart, MAX_PART_BYTES))?.text ?? "";
  const relations = await relationships(zip, presentationPart);
  const slides = [...presentation.matchAll(/<(?:\w+:)?sldId(?=[\s/>])([^>]*?)\/?>/g)]
    .map((match) => relations.get(attribute(attributes(match[1]!), "id", true) ?? ""))
    .filter((relation) => relation !== undefined && relation.type.endsWith("/slide") && zip.has(relation.target))
    .slice(0, MAX_SLIDES);

  const sections: Section[] = [];
  for (const [index, slide] of slides.entries()) {
    const xml = (await zip.text(slide!.target, MAX_PART_BYTES))?.text ?? "";
    const own = await relationships(zip, slide!.target);
    const parts: string[] = [];
    const text = drawingText(withoutFooters(xml));
    if (text) parts.push(text);
    // A SmartArt keeps its words in a part of its own.
    for (const diagram of ofType(own.values(), "diagramData")) {
      const words = drawingText((await zip.text(diagram.target, MAX_PART_BYTES))?.text ?? "");
      if (words) parts.push(words);
    }
    const notes = ofType(own.values(), "notesSlide")[0];
    if (notes) {
      const said = notesText((await zip.text(notes.target, MAX_PART_BYTES))?.text ?? "");
      if (said) parts.push(`Speaker notes:\n${said}`);
    }
    // A hidden slide says so; one without any text gives no passage.
    if (parts.length > 0 && /<(?:\w+:)?sld\b[^>]*\bshow="(?:0|false)"/.test(xml)) parts.unshift("(Hidden slide)");
    sections.push({ page: index + 1, unit: "slide", text: parts.join("\n\n") });
  }
  return sections;
}

/// The slide without its footer, date and number placeholders: the same
/// on every slide, they say nothing of it.
function withoutFooters(xml: string): string {
  return xml.replace(/<p:sp(?=[\s>])[\s\S]*?<\/p:sp>/g, (shape) => (/<p:ph\b[^>]*\btype="(?:sldNum|dt|ftr)"/.test(shape) ? "" : shape));
}

/// The notes of a slide: its body placeholder, not the slide's picture
/// or its number.
function notesText(xml: string): string {
  const bodies = [...xml.matchAll(/<p:sp(?=[\s>])[\s\S]*?<\/p:sp>/g)].map((match) => match[0]).filter((shape) => /<p:ph\b[^>]*\btype="body"/.test(shape));
  return bodies.map(drawingText).filter(Boolean).join("\n");
}

/// DrawingML text in reading order: one line per paragraph, a table one
/// line per row with its cells between bars.
export function drawingText(xml: string): string {
  const lines: string[] = [];
  for (const match of xml.matchAll(/<a:tbl\b[^>]*>[\s\S]*?<\/a:tbl>|<a:p(?=[\s>/])[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)) {
    if (match[0].startsWith("<a:tbl")) {
      for (const row of match[0].matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)) {
        const cells = [...row[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((cell) => paragraphs(cell[0]).join(" ").replace(/\s+/g, " ").trim());
        if (cells.some(Boolean)) lines.push(cells.join(" | "));
      }
      continue;
    }
    const line = paragraph(match[1] ?? "");
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join("\n");
}

function paragraphs(xml: string): string[] {
  return [...xml.matchAll(/<a:p(?=[\s>/])[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)].map((match) => paragraph(match[1] ?? "")).filter((line) => line.trim());
}

/// A paragraph's runs, fields (a date typed in) and line breaks.
function paragraph(xml: string): string {
  let text = "";
  for (const match of xml.matchAll(/<a:t(?=[\s>/])[^>]*?(?:\/>|>([\s\S]*?)<\/a:t>)|<a:br\b[^>]*\/?>/g)) {
    text += match[0].startsWith("<a:br") ? "\n" : xmlText(match[1] ?? "");
  }
  return text;
}

// ─── OpenDocument ───────────────────────────────────────────────────────────

/// An .odp file: each <draw:page> a slide, its <presentation:notes> its
/// speaker notes.
export async function readOdp(zip: ZipParts): Promise<Section[]> {
  const xml = (await zip.text("content.xml", 64 * 1024 * 1024))?.text ?? "";
  const sections: Section[] = [];
  let number = 0;
  for (const match of xml.matchAll(/<draw:page(?=[\s>])[^>]*>([\s\S]*?)<\/draw:page>/g)) {
    number += 1;
    if (number > MAX_SLIDES) break;
    const body = match[1]!;
    const notesXml = /<presentation:notes\b[\s\S]*?<\/presentation:notes>/.exec(body)?.[0] ?? "";
    const slide = odfParagraphs(body.replace(notesXml, "")).map((line) => line.trim()).filter(Boolean).join("\n");
    const notes = odfParagraphs(notesXml).map((line) => line.trim()).filter(Boolean).join("\n");
    const parts = [slide, notes ? `Speaker notes:\n${notes}` : ""].filter(Boolean);
    sections.push({ page: number, unit: "slide", text: parts.join("\n\n") });
  }
  return sections;
}
