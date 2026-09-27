import { mkdtempSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import assert from "node:assert/strict";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (
  !process.env.TWOODY_EMBEDDING_BINARY ||
  !process.env.TWOODY_EMBEDDING_MODEL ||
  !process.env.TWOODY_SEMANTIC_TEST_PARENT
)
  throw Error(
    "Set embedding binary/model and TWOODY_SEMANTIC_TEST_PARENT first",
  );
const profile = mkdtempSync(join(tmpdir(), "twoody-desktop-ui-semantic-"));
const docs = mkdtempSync(
  join(
    process.env.TWOODY_SEMANTIC_TEST_PARENT,
    "twoody-desktop-ui-semantic-files-",
  ),
);
process.env.TWOODY_DATA_DIR = profile;
process.env.TWOODY_LOCAL_ONLY = "1";
const { sqlite } = await import(root + "/dist/db.js");
const lib = await import(root + "/dist/documents/library.js");
const sem = await import(root + "/dist/documents/semantic.js");
try {
  sqlite
    .prepare("INSERT INTO users(id,email,created_at) VALUES(?,?,?)")
    .run("test", "fixture@example.invalid", 0);
  writeFileSync(
    join(docs, "contrat.txt"),
    "Bail commercial. La résiliation exige un préavis de six mois adressé au propriétaire par courrier recommandé.",
  );
  writeFileSync(
    join(docs, "parcours.txt"),
    "I led software product teams, defined a product roadmap and launched digital services for business customers.",
  );
  writeFileSync(
    join(docs, "recette.txt"),
    "Pour préparer un gâteau au chocolat, mélanger les œufs, la farine et le beurre puis enfourner trente minutes.",
  );
  const folder = lib.addFolder("test", docs);
  await lib.reindex("test");
  const started = Date.now();
  sem.setSemantic("test", true);
  for (let i = 0; i < 180 && sem.semanticStatus("test").running; i++)
    await new Promise((r) => setTimeout(r, 500));
  const status = sem.semanticStatus("test");
  assert.equal(status.error, false);
  assert.equal(status.indexed, 3);
  const cases = [
    ["Comment mettre fin à la location de mes bureaux ?", "contrat.txt"],
    ["Mon expérience en pilotage de produits numériques", "parcours.txt"],
  ];
  for (const [question, name] of cases) {
    const before = Date.now();
    const result = await sem.semanticPassages("test", question, [folder.id]);
    assert.equal(result[0]?.name, name);
    console.log(
      JSON.stringify({
        question,
        top: result[0].name,
        ms: Date.now() - before,
        lexical: lib.searchPassages("test", question).map((p) => p.name),
      }),
    );
  }
  assert.deepEqual(
    await sem.semanticPassages("test", "résiliation", ["not-granted"]),
    [],
  );
  assert.deepEqual(
    await sem.semanticPassages("another-user", "résiliation", [folder.id]),
    [],
  );
  const vectors = sqlite
    .prepare(
      "SELECT hex(vector) AS v FROM document_embeddings ORDER BY document_id",
    )
    .all();
  await sem.indexSemantic("test");
  assert.deepEqual(
    sqlite
      .prepare(
        "SELECT hex(vector) AS v FROM document_embeddings ORDER BY document_id",
      )
      .all(),
    vectors,
  );
  const labels = lib.listDocuments("test", folder.id, 0, 100, "category").files;
  assert.ok(labels.every((row) => typeof row.category === "string"));
  sem.setSemantic("test", false);
  assert.deepEqual(
    await sem.semanticPassages("test", "location de bureaux", [folder.id]),
    [],
  );
  assert.ok(
    lib
      .listDocuments("test", folder.id)
      .files.every((row) => row.category === null),
  );
  writeFileSync(
    join(docs, "contrat.txt"),
    "Bail modifié : préavis de douze mois.",
  );
  await lib.reindex("test");
  assert.equal(sem.semanticStatus("test").indexed, 2);
  sem.setSemantic("test", true);
  for (let i = 0; i < 180 && sem.semanticStatus("test").running; i++)
    await new Promise((r) => setTimeout(r, 500));
  assert.equal(sem.semanticStatus("test").indexed, 3);
  lib.removeFolder("test", folder.id);
  assert.equal(sem.semanticStatus("test").indexed, 0);
  console.log(
    JSON.stringify({ ok: true, indexingMs: Date.now() - started, profile }),
  );
} finally {
  sem.stopSemantic();
  sqlite.close();
  renameSync(docs, join(homedir(), ".Trash", docs.split("/").pop()));
}
