// Documents joined to a message by the desktop app travel inside the
// message itself, one block each, before what the person typed (the
// question reads best after the text it is about):
//
//   <<document name="rapport.pdf" pages="12">>
//   [page 1]
//   …
//   <</document>>
//
// The model reads them in full. Everything else — the discussion's
// title, the search in the user's indexed documents, the memories
// matched to the question, the trimming of the history — works on what
// was typed, so a forty-page contract does not become a title or a
// search query.

// A web search the desktop ran for a question travels the same way:
//
//   <<web query="quartiers Lisbonne">>
//   [1] Title
//   https://…
//   passages of the page…
//   <</web>>

const BLOCK = /<<(document|web) (?:name|query)="([^"]*)"(?: pages="(\d+)")?>>\n[\s\S]*?\n<<\/\1>>/g;

export interface DocumentBlock {
  kind: "document" | "web";
  /// A document's name, or what was searched for.
  name: string;
  pages: number | null;
  /// The whole block, markers included, as the model reads it.
  block: string;
}

export function splitDocuments(content: string): { text: string; documents: DocumentBlock[] } {
  const documents: DocumentBlock[] = [];
  const text = content
    .replace(BLOCK, (block, kind: "document" | "web", name: string, pages?: string) => {
      documents.push({ kind, name, pages: pages ? Number(pages) : null, block });
      return "";
    })
    .trim();
  return { text, documents };
}

export function typedText(content: string): string {
  return splitDocuments(content).text;
}

export function hasDocuments(content: string): boolean {
  return content.includes("<<document name=\"") && splitDocuments(content).documents.some((block) => block.kind === "document");
}

export function hasWebResults(content: string): boolean {
  return content.includes("<<web query=\"") && splitDocuments(content).documents.some((block) => block.kind === "web");
}

/// What a discussion is called: what was typed, led by the names of the
/// documents it carried.
export function discussionTitle(content: string): string {
  const { text, documents } = splitDocuments(content);
  const names = documents.filter((document) => document.kind === "document").map((document) => document.name).join(", ");
  return [names, text].filter(Boolean).join(" — ").replace(/\s+/g, " ").trim().slice(0, 60);
}
