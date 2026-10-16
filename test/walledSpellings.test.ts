import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Walled-off projects whose folders were granted under another spelling than
// the folder holding them — attack-style. On Windows, Node's JavaScript
// realpath keeps what it is given: a mapped drive (« Z:\Cabinet ») next to the
// share it stands for (« \\nas\cabinet »), a short 8.3 name next to the long
// one, another case. Here a link stands for that other spelling: the firm's
// general folder is granted through it, the walled-off folders through the
// real path or through it too, rows written as such a computer would have
// kept them. Whichever way, a walled-off folder is never walked, indexed,
// searched, listed, browsed, shared nor acted on from the general folder
// (src/documents/samePath.ts, library.ts folderLayout). Every name and amount
// is made up.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-walled-spellings-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BACKEND_URL;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { forgetGrantedPlace, indexStatus, listFolders, reindex, searchPassages } = await import("../src/documents/library.js");
const { scopedFolders } = await import("../src/documents/retrieval.js");
const { listGrantedFiles } = await import("../src/documents/fileListing.js");
const { listFolder, readFolderRequest } = await import("../src/documents/folderListing.js");
const { browseGranted } = await import("../src/documents/browse.js");
const { spotlightOwner } = await import("../src/documents/spotlightRetrieval.js");
const { setSpotlightEnabled } = await import("../src/documents/spotlight.js");
const { isolatedInside } = await import("../src/shares/policy.js");
const { actionRoots, touchesWall } = await import("../src/fileActions/plan.js");
const { realPathOf, within } = await import("../src/documents/samePath.js");

setSpotlightEnabled(false);
const app = await buildApp();
await app.ready();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const owner = paired.json().user_id as string;
const desktop = { authorization: `Bearer ${paired.json().token as string}` };

// The firm: Cabinet holds Tessane/ and Lefevre/ (walled off), Courant/ (not).
const scratch = mkdtempSync(join(process.cwd(), "tmp-walled-spellings-"));
const cabinet = join(realPathOf(scratch), "Cabinet");
const tessane = join(cabinet, "Tessane");
const lefevre = join(cabinet, "Lefevre");
for (const dir of [join(tessane, "Pieces"), lefevre, join(cabinet, "Courant")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(cabinet, "Courant", "note-interne.txt"), "Note interne : la photocopieuse est en panne.");
writeFileSync(join(tessane, "lettre-de-mission.txt"), "Lettre de mission Tessane SAS. Honoraires forfaitaires de 7 450 euros hors taxes.");
writeFileSync(join(tessane, "Pieces", "bilan-tessane.txt"), "Bilan Tessane : provision pour litige de 26 000 euros.");
writeFileSync(join(lefevre, "devis-lefevre.txt"), "Devis Lefèvre : honoraires de 2 980 euros.");
// The other spelling of the firm (a mapped drive, a short name on Windows).
const alias = join(realPathOf(scratch), "Z");
symlinkSync(cabinet, alias);
test.after(async () => {
  await app.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function indexed() {
  await reindex(owner);
  while (indexStatus(owner).running) await new Promise((resolve) => setTimeout(resolve, 20));
}
/// A folder row as a computer whose realpath keeps a spelling would have kept it.
function grantAs(path: string, projectId: string | null = null): string {
  const id = randomUUID();
  sqlite.prepare("INSERT INTO document_folders (id, user_id, path, created_at, project_id) VALUES (?, ?, ?, ?, ?)").run(id, owner, path, Date.now(), projectId);
  forgetGrantedPlace(path);
  return id;
}
const SECRET = /7 450|26 000|2 980|lettre-de-mission|bilan-tessane|devis-lefevre/;

// The general folder, through the other spelling; Tessane's through the real
// path (the project's page); Lefevre's through the other spelling too.
await app.inject({ method: "POST", url: "/local_documents/folders", headers: desktop, payload: { path: join(cabinet, "Courant") } });
const general = grantAs(alias);
const tessaneProject = (await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Tessane SAS", isolated: true, folder_path: tessane } })).json().project as { id: string };
const lefevreProject = (await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Lefèvre", isolated: true } })).json().project as { id: string };
grantAs(join(alias, "Lefevre"), lefevreProject.id);
// Tessane's folder granted again, plain, under the other spelling: still Tessane's.
const duplicate = grantAs(join(alias, "Tessane"));
await indexed();

test("the general folder carries each walled-off folder the way its own walk meets it", () => {
  const folders = listFolders(owner);
  const generalFolder = folders.find((folder) => folder.id === general)!;
  assert.equal(generalFolder.project_id, null);
  for (const path of [join(alias, "Tessane", "lettre-de-mission.txt"), join(alias, "Lefevre"), join(tessane, "Pieces"), join(lefevre, "devis-lefevre.txt")]) {
    assert.ok(generalFolder.walled.some((wall) => within(wall, path)), `${path} walled from ${JSON.stringify(generalFolder.walled)}`);
  }
  assert.ok(!generalFolder.walled.some((wall) => within(wall, join(alias, "Courant"))), "Courant stays open");
  // The same folder granted again under another spelling is the project's too.
  assert.equal(folders.find((folder) => folder.id === duplicate)?.project_id, tessaneProject.id);
});

test("indexed: nothing of a walled-off folder under the general folder; the general chat's search finds none of it", () => {
  const rows = sqlite.prepare("SELECT d.path, d.folder_id AS folderId, f.project_id AS projectId FROM documents d JOIN document_folders f ON f.id = d.folder_id WHERE d.user_id = ?").all(owner) as Array<{ path: string; folderId: string; projectId: string | null }>;
  assert.ok(rows.length > 0);
  const projectOf = new Map(listFolders(owner).map((folder) => [folder.id, folder.project_id]));
  for (const row of rows) {
    if (/Tessane|Lefevre/.test(row.path)) assert.notEqual(projectOf.get(row.folderId) ?? null, null, `${row.path} kept under a folder outside its project`);
  }
  const outside = scopedFolders(owner, { mode: "all" });
  assert.ok(outside.some((folder) => folder.id === general));
  assert.ok(!outside.some((folder) => folder.id === duplicate), "the duplicate grant is walled off with its project");
  const found = searchPassages(owner, "honoraires lettre de mission devis bilan provision", 20, outside.map((folder) => folder.id));
  assert.doesNotMatch(JSON.stringify(found), SECRET);
  // In its own project, it is there.
  const own = scopedFolders(owner, { mode: "all" }, { project: tessaneProject.id });
  assert.match(JSON.stringify(searchPassages(owner, "honoraires lettre de mission", 20, own.map((folder) => folder.id))), /7 450/);
});

test("listed, found by name, browsed, read by Spotlight from the general folder: never", async () => {
  const outside = listFolders(owner).filter((folder) => folder.project_id === null);
  const every = await listGrantedFiles({ intent: { folder: null, folderName: null, sort: "name", kinds: [], limit: 30 }, roots: outside, granted: outside });
  assert.ok(every.files.some((file) => file.name === "note-interne.txt"));
  assert.doesNotMatch(JSON.stringify(every.files), SECRET);
  for (const folder of ["Tessane", "Pieces", "Lefevre", "Z/Tessane", "Z/Lefevre", tessane, join(alias, "Tessane")]) {
    const one = await listFolder({ request: readFolderRequest({ folder, recursive: true })!, roots: outside, granted: outside });
    assert.equal(one.files.length, 0, folder);
    assert.doesNotMatch(JSON.stringify(one), SECRET, folder);
  }
  const all = scopedFolders(owner, { mode: "all" }, { withIsolated: true });
  for (const path of ["", "Tessane", "Lefevre", "Tessane/Pieces"]) {
    const browsed = await browseGranted(owner, all, { root: general, path, sort: "name", order: "asc", offset: 0, limit: 50, q: null });
    assert.doesNotMatch(JSON.stringify(browsed), SECRET, path);
    if ("entries" in browsed) assert.ok(!browsed.entries.some((entry) => entry.name === "Tessane" || entry.name === "Lefevre"), path);
  }
  for (const file of [join(tessane, "lettre-de-mission.txt"), join(alias, "Tessane", "Pieces", "bilan-tessane.txt"), join(lefevre, "devis-lefevre.txt")]) {
    assert.equal(spotlightOwner(file, outside), null, file);
  }
});

test("a share of the general folder and « Agir dans vos dossiers » keep out of them, however they are written", () => {
  const isolated = isolatedInside(owner, alias);
  for (const path of [join(alias, "Tessane", "lettre-de-mission.txt"), join(tessane, "Pieces"), join(alias, "Lefevre"), lefevre]) {
    assert.ok(isolated.some((wall) => within(wall, path)), `${path} in ${JSON.stringify(isolated)}`);
  }
  const { roots, walls } = actionRoots(owner);
  assert.ok(roots.some((root) => root.id === general));
  for (const path of [tessane, join(alias, "Tessane"), join(alias, "Tessane", "Pieces"), lefevre, join(alias, "Lefevre"), alias, cabinet]) {
    assert.equal(touchesWall(path, walls), true, path);
  }
  assert.equal(touchesWall(join(alias, "Courant"), walls), false);
});

test("another case on a disk that does not mind it (macOS, Windows): still the walled-off folder", { skip: process.platform !== "darwin" && process.platform !== "win32" && "Linux tells case apart: another case is another folder" }, async () => {
  const varlin = join(cabinet, "Varlin");
  mkdirSync(varlin);
  writeFileSync(join(varlin, "contrat-varlin.txt"), "Contrat Varlin : 11 300 euros.");
  const project = (await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Varlin", isolated: true } })).json().project as { id: string };
  grantAs(join(cabinet, "VARLIN").toLowerCase().replace(cabinet.toLowerCase(), cabinet.toLowerCase()), project.id);
  await indexed();
  const outside = scopedFolders(owner, { mode: "all" });
  assert.doesNotMatch(JSON.stringify(searchPassages(owner, "contrat Varlin", 20, outside.map((folder) => folder.id))), /11 300/);
  const every = await listGrantedFiles({ intent: { folder: null, folderName: null, sort: "name", kinds: [], limit: 30 }, roots: outside, granted: outside });
  assert.doesNotMatch(JSON.stringify(every.files), /contrat-varlin/);
});
