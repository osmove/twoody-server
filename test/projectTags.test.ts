import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";

// A project's name, description and tags (Jimmy, 28/10/2026: in place of
// the four sizes and the kind picked from a list). Tags are the person's own
// words, each once, without its « # »; they reach the project's card.

const dir = mkdtempSync(join(tmpdir(), "twoody-project-tags-"));
process.env.TWOODY_DATA_DIR = dir;
const { sqlite } = await import("../src/db.js");
const { createProject, projectDetail, readProjectInput, updateProject } = await import("../src/projects/projects.js");
after(() => { sqlite.close(); const trash = join(homedir(), ".Trash"); mkdirSync(trash, { recursive: true }); renameSync(dir, join(trash, basename(dir))); });
sqlite.prepare("INSERT INTO users (id, email, name, prefs, created_at) VALUES ('u', 'u@example.com', 'Jimmy', '{}', ?)").run(Date.now());

test("tags are kept as typed, each once, without « # »; a description too", () => {
  const input = readProjectInput({ project: { title: "Achat d'un Mac mini", brief: "Pour faire tourner Twoody à la maison.", tags: [" Maison ", "#achat", "maison", ""] } }, true);
  assert.deepEqual(input.tags, ["Maison", "achat"]);
  const id = createProject("u", input);
  const project = projectDetail("u", id) as { tags: string[]; brief: string | null };
  assert.deepEqual(project.tags, ["Maison", "achat"]);
  assert.equal(project.brief, "Pour faire tourner Twoody à la maison.");
  updateProject("u", id, readProjectInput({ tags: ["2026"] }, false));
  assert.deepEqual((projectDetail("u", id) as { tags: string[] }).tags, ["2026"]);
  // Left out of a change, they stay.
  updateProject("u", id, readProjectInput({ title: "Mac mini M5" }, false));
  assert.deepEqual((projectDetail("u", id) as { tags: string[] }).tags, ["2026"]);
});

test("too many, too long or not words: refused", () => {
  assert.throws(() => readProjectInput({ tags: Array.from({ length: 13 }, (_, i) => `t${i}`) }, false), /invalid_tags/);
  assert.throws(() => readProjectInput({ tags: ["x".repeat(41)] }, false), /invalid_tags/);
  assert.throws(() => readProjectInput({ tags: "maison" }, false), /invalid_tags/);
  assert.throws(() => readProjectInput({ tags: [3] }, false), /invalid_tags/);
});
