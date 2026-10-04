import { posix } from "node:path";
import type { ZipParts } from "./zipParts.js";

// What the readers of Office files share: XML text and attributes, and
// the relationships that say which part is where (Office Open XML keeps a
// `_rels` file beside each part).

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/// XML character data as text: entities, and the _xHHHH_ escapes Office
/// writes for control characters (_x000D_ for a carriage return).
export function xmlText(text: string): string {
  return text
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
      try {
        if (body.startsWith("#x")) return String.fromCodePoint(parseInt(body.slice(2), 16));
        if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
      } catch {
        return match;
      }
      return ENTITIES[body] ?? match;
    })
    .replace(/_x([0-9a-fA-F]{4})_/g, (_match, hex: string) => {
      const code = parseInt(hex, 16);
      return code === 0x0d || code === 0x0a ? "\n" : code === 0x09 ? "\t" : code < 0x20 ? "" : String.fromCharCode(code);
    });
}

/// A tag's attributes by name, prefix included (« r:id »), values as text.
export function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[match[1]!] = xmlText(match[2] ?? match[3] ?? "");
  return out;
}

/// The value of a namespaced attribute whatever its prefix (« r:id »,
/// « ns0:id »), or of a plain one.
export function attribute(attrs: Record<string, string>, local: string, namespaced = false): string | undefined {
  if (!namespaced) return attrs[local];
  for (const [name, value] of Object.entries(attrs)) if (name.endsWith(`:${local}`)) return value;
  return undefined;
}

export interface Relationship {
  id: string;
  type: string;
  /// The part it points at, from the root of the zip.
  target: string;
}

const MAX_RELS_BYTES = 4 * 1024 * 1024;

/// The relationships of a part (« xl/workbook.xml » → xl/_rels/workbook.xml.rels),
/// by id. External targets (a link to a web page) are left out.
export async function relationships(zip: ZipParts, part: string): Promise<Map<string, Relationship>> {
  const dir = posix.dirname(part);
  const path = posix.join(dir === "." ? "" : dir, "_rels", `${posix.basename(part)}.rels`);
  const found = await zip.text(path, MAX_RELS_BYTES);
  const out = new Map<string, Relationship>();
  for (const match of found?.text.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g) ?? []) {
    const attrs = attributes(match[1]!);
    if (!attrs.Id || !attrs.Target || /^external$/i.test(attrs.TargetMode ?? "")) continue;
    const target = attrs.Target.startsWith("/") ? attrs.Target.slice(1) : posix.normalize(posix.join(dir === "." ? "" : dir, attrs.Target));
    out.set(attrs.Id, { id: attrs.Id, type: attrs.Type ?? "", target });
  }
  return out;
}

/// The main part of an Office file, as its root relationships name it
/// (« xl/workbook.xml », « ppt/presentation.xml »).
export async function mainPart(zip: ZipParts, fallback: string): Promise<string> {
  const root = await relationships(zip, "");
  for (const relation of root.values()) if (/\/officeDocument$/.test(relation.type) && zip.has(relation.target)) return relation.target;
  return fallback;
}

/// The relationship of a kind (« /worksheet », « /notesSlide »): the end
/// of its type, the same in transitional and strict Office files.
export function ofType(relations: Iterable<Relationship>, kind: string): Relationship[] {
  return [...relations].filter((relation) => relation.type.endsWith(`/${kind}`));
}

/// The text of OpenDocument paragraphs (<text:p>, <text:h>): spaces
/// (<text:s text:c="3"/>), tabs and line breaks kept, the rest of the
/// markup dropped; one line per paragraph.
export function odfParagraphs(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<text:(p|h)\b[^>]*?(?:\/>|>([\s\S]*?)<\/text:\1>)/g)) {
    const inner = (match[2] ?? "")
      .replace(/<text:s\b([^>]*)\/>/g, (_whole, attrs: string) => " ".repeat(Math.min(Number(/text:c="(\d+)"/.exec(attrs)?.[1] ?? 1), 100)))
      .replace(/<text:tab\b[^>]*\/>/g, "\t")
      .replace(/<text:line-break\b[^>]*\/>/g, "\n")
      .replace(/<text:note\b[\s\S]*?<\/text:note>/g, "")
      .replace(/<[^>]+>/g, "");
    out.push(xmlText(inner));
  }
  return out;
}
