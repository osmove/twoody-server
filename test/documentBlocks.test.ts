import { test } from "node:test";
import assert from "node:assert/strict";
import { discussionTitle, hasDocuments, splitDocuments, typedText } from "../src/documentBlocks.js";
import { buildChatMessages, type ChatContextInput } from "../src/chatContext.js";

const block = (name: string, text: string, pages?: number) =>
  `<<document name="${name}"${pages ? ` pages="${pages}"` : ""}>>\n${text}\n<</document>>`;

test("a message is split into what was typed and its documents", () => {
  const content = `${block("bail.pdf", "[page 1]\nLe preneur…", 3)}\n\n${block("notes.md", "# Notes")}\n\nRésume ce contrat`;
  const { text, documents } = splitDocuments(content);
  assert.equal(text, "Résume ce contrat");
  assert.deepEqual(documents.map(({ name, pages }) => ({ name, pages })), [
    { name: "bail.pdf", pages: 3 },
    { name: "notes.md", pages: null },
  ]);
  assert.equal(typedText("Bonjour"), "Bonjour");
  assert.ok(hasDocuments(content));
  assert.ok(!hasDocuments("Bonjour <<document name=\"x\">> sans fin"));
});

test("a discussion is titled by its documents and the question, never by their text", () => {
  assert.equal(discussionTitle(`${block("bail.pdf", "x".repeat(5000), 12)}\n\nQuelles clauses de résiliation ?`), "bail.pdf — Quelles clauses de résiliation ?");
  assert.equal(discussionTitle("  Une   question  "), "Une question");
  assert.ok(discussionTitle(`Résume\n\n${block("a-very-long-name-for-a-scanned-contract-2026.pdf", "x")}`).length <= 60);
});

function input(overrides: Partial<ChatContextInput>): ChatContextInput {
  return { userName: null, prefs: {}, history: [], memories: [], content: "Bonjour", local: true, now: new Date(2026, 8, 24), ...overrides };
}

test("a document stays readable to the questions that follow", () => {
  const document = block("bail.pdf", "[page 1]\n" + "Le preneur s'engage… ".repeat(400), 1);
  const messages = buildChatMessages(input({
    history: [
      { role: "user", content: `${document}\n\nRésume ce bail` },
      { role: "assistant", content: "C'est un bail d'habitation." },
    ],
    content: "Quelle est la durée du préavis ?",
  }));
  // Replayed whole, not cut at the 4 000 characters of an ordinary message.
  assert.equal(messages[1].content, `${document}\n\nRésume ce bail`);
  assert.match(messages[0].content, /<<document name=/);
});

test("an older document beyond the share is named, not cut in the middle", () => {
  const old = block("ancien.pdf", "a".repeat(20_000));
  const fresh = block("nouveau.pdf", "b".repeat(20_000));
  const messages = buildChatMessages(input({
    history: [
      { role: "user", content: `${old}\n\nLis` },
      { role: "assistant", content: "Lu." },
    ],
    content: `${fresh}\n\nEt celui-ci ?`,
  }));
  assert.equal(messages[1].content, "[ancien.pdf: a document sent earlier in this conversation, too long to be repeated here.]\n\nLis");
  assert.ok(messages[3].content.endsWith(`${fresh}\n\nEt celui-ci ?`));
});

test("without documents, the system prompt says nothing about them", () => {
  const [system] = buildChatMessages(input({}));
  assert.doesNotMatch(system.content, /<<document/);
});
