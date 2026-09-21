import type { Section } from "./extract.js";

// Splits a document into passages small enough to hand a local model a
// few of them at once, and large enough to carry a clause with its
// context. Splits follow the text's own structure — paragraphs, then
// sentences — and consecutive chunks overlap slightly so a sentence cut
// at a boundary is still whole in one of them.

export interface Chunk {
  page: number | null;
  position: number;
  text: string;
}

export const CHUNK_TARGET_CHARS = 1_200;
const CHUNK_OVERLAP_CHARS = 150;

export function chunkSections(sections: Section[], target = CHUNK_TARGET_CHARS): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of sections) {
    for (const text of chunkText(section.text, target)) {
      chunks.push({ page: section.page, position: chunks.length, text });
    }
  }
  return chunks;
}

function chunkText(text: string, target: number): string[] {
  const pieces = splitToFit(text, target);
  const chunks: string[] = [];
  let current = "";

  for (const piece of pieces) {
    if (current && current.length + piece.length + 1 > target) {
      chunks.push(current);
      // Start the next chunk with the tail of this one.
      const tail = current.slice(-CHUNK_OVERLAP_CHARS);
      const boundary = tail.search(/[\s.;:!?]\S/);
      current = boundary === -1 ? "" : tail.slice(boundary + 1).trimStart();
    }
    current = current ? `${current}\n${piece}` : piece;
  }
  if (current.trim()) chunks.push(current);
  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
}

/// Paragraphs first; a paragraph longer than the target is cut into
/// sentences, and a sentence longer than the target into hard slices.
function splitToFit(text: string, target: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n{2,}|\n(?=\S)/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (trimmed.length <= target) {
      out.push(trimmed);
      continue;
    }
    for (const sentence of trimmed.split(/(?<=[.!?…])\s+/)) {
      if (sentence.length <= target) {
        out.push(sentence);
        continue;
      }
      for (let start = 0; start < sentence.length; start += target) {
        out.push(sentence.slice(start, start + target));
      }
    }
  }
  return out;
}
