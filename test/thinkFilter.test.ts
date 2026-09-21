import { test } from "node:test";
import assert from "node:assert/strict";
import { createThinkFilter } from "../src/thinkFilter.js";

function run(deltas: string[]): string {
  let out = "";
  const filter = createThinkFilter((text) => {
    out += text;
  });
  for (const delta of deltas) filter.push(delta);
  filter.flush();
  return out;
}

test("plain replies pass through unchanged", () => {
  assert.equal(run(["Bon", "jour", " !"]), "Bonjour !");
});

test("a leading think block is dropped", () => {
  assert.equal(run(["<think>", "let me see", "</think>", "\n\nBonjour"]), "Bonjour");
});

test("tags split across deltas are still recognised", () => {
  assert.equal(run(["<th", "ink>rea", "soning</th", "ink>\n", "\nRéponse"]), "Réponse");
});

test("whitespace before the think block is tolerated", () => {
  assert.equal(run(["\n", "<think>x</think>", "ok"]), "ok");
});

test("an unterminated think block emits nothing", () => {
  assert.equal(run(["<think>", "never closed"]), "");
});

test("a literal <think> after real text is kept", () => {
  assert.equal(run(["La balise ", "<think>", " existe."]), "La balise <think> existe.");
});

test("a reply that merely starts like the tag is not swallowed", () => {
  assert.equal(run(["<th", "ead> est une balise HTML"]), "<thead> est une balise HTML");
  assert.equal(run(["<"]), "<");
});

test("indentation of a normal reply is preserved", () => {
  assert.equal(run(["  indented"]), "  indented");
});

test("blank lines left by a runtime that strips reasoning itself are dropped", () => {
  assert.equal(run(["\n", "\n", "Je comprends."]), "Je comprends.");
  assert.equal(run(["\n\n  code"]), "  code");
});
