import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Twoody remembers what it is asked to, at once (28/09/2026: the Memories
// screen stayed empty). What is said in passing: test/memoryLearner.test.ts.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-learning-"));

const { db, memories, users } = await import("../src/db.js");
const { askedToRemember, rememberFacts } = await import("../src/memoryLearning.js");

db.insert(users).values({ id: "u1", email: "u1@self-hosted.twoody", name: "Jimmy", createdAt: new Date() } as typeof users.$inferInsert).run();
const kept = () => db.select().from(memories).all().map((row) => row.content);

test("what the person asks to be remembered is kept as said", () => {
  assert.equal(askedToRemember("Retiens que ma fille s'appelle Claire-Sophie."), "Ma fille s'appelle Claire-Sophie");
  assert.equal(askedToRemember("souviens-toi que je suis allergique aux noix"), "Je suis allergique aux noix");
  assert.equal(askedToRemember("Remember that my dentist is on Friday"), "My dentist is on Friday");
  assert.equal(askedToRemember("Quelle est la capitale de l'Italie ?"), null);
  assert.equal(askedToRemember("Salut ça va ?"), null);
});

test("an explicit request is kept once, never twice", () => {
  assert.equal(rememberFacts("u1", [askedToRemember("Retiens que je préfère le thé au café")!]), 1);
  assert.equal(rememberFacts("u1", [askedToRemember("Retiens que je préfère le thé au café.")!]), 0);
  assert.ok(kept().includes("Je préfère le thé au café"));
});

test("a phone's curly apostrophe is an apostrophe: « n’oublie pas »", () => {
  assert.equal(askedToRemember("N’oublie pas que je suis végétarien"), "Je suis végétarien");
});
