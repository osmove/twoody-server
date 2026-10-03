import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Four sizes of project (Jimmy, 02/10/2026): small, medium, large,
// critical — the large and critical ones in every conversation, a critical
// one first.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-project-sizes-"));
const { sqlite } = await import("../src/db.js");
const { createProject, projectsLine, PROJECT_SIZES } = await import("../src/projects/projects.js");

test("a critical project comes first in what every conversation knows; a medium one does not come", () => {
  const seconds = Date.now();
  sqlite.prepare("INSERT INTO users (id, email, name, prefs, created_at) VALUES ('u', 'u@example.com', 'Jimmy', '{}', ?)").run(seconds);
  assert.deepEqual([...PROJECT_SIZES], ["small", "medium", "large", "critical"]);
  createProject("u", { title: "Achat d'un Mac mini", size: "large", status: "active" }, "manual", Date.now() - 2000);
  createProject("u", { title: "Déménagement", size: "medium", status: "active" }, "manual", Date.now() - 1000);
  createProject("u", { title: "Lancement de Twoody", size: "critical", status: "active" });
  assert.equal(projectsLine("u"), "Projects under way: Lancement de Twoody (critical); Achat d'un Mac mini.");
});
