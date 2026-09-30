import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Twoody remembers what it is asked to, and the lasting facts said in
// passing (28/09/2026: the Memories screen stayed empty).

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-learning-"));

const { db, memories, users } = await import("../src/db.js");
const { askedToRemember, learnFromMessage, parseFacts, saysSomethingPersonal } = await import("../src/memoryLearning.js");

db.insert(users).values({ id: "u1", email: "u1@self-hosted.twoody", name: "Jimmy", createdAt: new Date() } as typeof users.$inferInsert).run();
const kept = () => db.select().from(memories).all().map((row) => row.content);

test("what the person asks to be remembered is kept as said", () => {
  assert.equal(askedToRemember("Retiens que ma fille s'appelle Claire-Sophie."), "Ma fille s'appelle Claire-Sophie");
  assert.equal(askedToRemember("souviens-toi que je suis allergique aux noix"), "Je suis allergique aux noix");
  assert.equal(askedToRemember("Remember that my dentist is on Friday"), "My dentist is on Friday");
  assert.equal(askedToRemember("Quelle est la capitale de l'Italie ?"), null);
  assert.equal(askedToRemember("Salut ça va ?"), null);
});

test("a message that says nothing personal asks nothing of the model", async () => {
  let asked = 0;
  const added = await learnFromMessage({ userId: "u1", message: "Combien font 2 + 3 ?", ask: async () => { asked += 1; return "- nothing"; } });
  assert.equal(added, 0);
  assert.equal(asked, 0);
  assert.equal(saysSomethingPersonal("Je m'appelle Jimmy et je travaille chez Osmove"), true);
});

test("facts said in passing are kept once, never twice", async () => {
  const ask = async () => "<think>…</think>\n- Il s'appelle Jimmy.\n- Il travaille chez Osmove.";
  assert.equal(await learnFromMessage({ userId: "u1", message: "Je m'appelle Jimmy et je travaille chez Osmove", ask }), 2);
  assert.equal(await learnFromMessage({ userId: "u1", message: "Je m'appelle Jimmy, je travaille chez Osmove", ask }), 0);
  assert.deepEqual(kept().filter((text) => /Osmove|Jimmy/.test(text)).length, 2);
  assert.deepEqual(parseFacts("NONE"), []);
});

test("an explicit request is kept without the model", async () => {
  const added = await learnFromMessage({ userId: "u1", message: "Retiens que je préfère le thé au café", ask: async () => { throw new Error("not asked"); } });
  assert.equal(added, 1);
  assert.ok(kept().includes("Je préfère le thé au café"));
});

test("a phone's curly apostrophe is an apostrophe: « j’habite », « n’oublie pas »", () => {
  assert.equal(saysSomethingPersonal("Tu sais, j’habite à Antony depuis cinq ans"), true);
  assert.equal(saysSomethingPersonal("Je m’appelle Jimmy"), true);
  assert.equal(saysSomethingPersonal("Mon anniversaire est le 12 mars"), true);
  assert.equal(askedToRemember("N’oublie pas que je suis végétarien"), "Je suis végétarien");
  assert.equal(saysSomethingPersonal("Quel âge j’ai ?"), false);
});
