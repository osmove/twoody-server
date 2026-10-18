import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import test from "node:test";

// Walled-off projects whose folder is renamed or moved outside Twoody — in
// the Finder, the Explorer, by a sync client (Jimmy, 16/10/2026;
// docs/projects-design.md §8 « Moved outside Twoody »,
// src/documents/wallPlaces.ts) — attack-style. Until then a walled-off folder
// was known by its path only: renamed in place, its parent renamed, or moved
// under the firm's general folder, it was listed and acted on from the
// general folder at once, indexed under it at the next pass — found by the
// general chat, the phone, the other computers, a shared folder — and its
// project lost its documents (all three attacks fail on the code of d7c7c92).
// Here every reader that walks a folder — the index pass, the listings and
// list_files, browsing (the Documents screen, a share, another computer),
// Spotlight's candidates, « Agir dans vos dossiers » — is tried after each
// move, before and after the next pass. Every name and amount is made up.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-walled-moved-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BACKEND_URL;

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { indexStatus, listFolders, reindex, searchPassages } = await import("../src/documents/library.js");
const { scopedFolders } = await import("../src/documents/retrieval.js");
const { listGrantedFiles, walledAt } = await import("../src/documents/fileListing.js");
const { listFolder, readFolderRequest } = await import("../src/documents/folderListing.js");
const { browseGranted } = await import("../src/documents/browse.js");
const { spotlightOwner } = await import("../src/documents/spotlightRetrieval.js");
const { setSpotlightEnabled } = await import("../src/documents/spotlight.js");
const { isolatedInside } = await import("../src/shares/policy.js");
const { actionRoots, findFolder, touchesWall } = await import("../src/fileActions/plan.js");
const { realPathOf, within } = await import("../src/documents/samePath.js");
const { checkWalls, onWallAway } = await import("../src/documents/wallPlaces.js");

setSpotlightEnabled(false);
const app = await buildApp();
await app.ready();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const owner = paired.json().user_id as string;
const desktop = { authorization: `Bearer ${paired.json().token as string}` };
const phone = { authorization: `Bearer ${createAuthSession(owner, "pair:iPhone").token}` };

// A walled-off folder found away from its path outside a pass asks for one
// (library.ts starts it); here the test runs each pass itself.
const askedToLook: string[] = [];
onWallAway((userId) => askedToLook.push(userId));

// The firm's folders, under the working directory (the system's temporary
// folder is never granted): Cabinet (general) holds Courant/, Tessane/ and
// Clients/Varlin/ (walled off); Externe/Lefevre/ (walled off) is outside it.
const base = realPathOf(mkdtempSync(join(process.cwd(), "tmp-walled-moved-")));
const cabinet = join(base, "Cabinet");
const tessane = join(cabinet, "Tessane");
const varlin = join(cabinet, "Clients", "Varlin");
const lefevre = join(base, "Externe", "Lefevre");
for (const dir of [join(cabinet, "Courant"), join(tessane, "Pieces"), varlin, lefevre]) mkdirSync(dir, { recursive: true });
writeFileSync(join(cabinet, "Courant", "note-interne.txt"), "Note interne : la photocopieuse est en panne.");
writeFileSync(join(tessane, "lettre-de-mission.txt"), "Lettre de mission Tessane SAS. Honoraires forfaitaires de 7 450 euros hors taxes.");
writeFileSync(join(tessane, "Pieces", "bilan-tessane.txt"), "Bilan Tessane : provision pour litige de 26 000 euros.");
writeFileSync(join(varlin, "contrat-varlin.txt"), "Contrat Varlin : honoraires de 11 300 euros.");
writeFileSync(join(varlin, "avenant-varlin.txt"), "Avenant Varlin : honoraires complémentaires de 4 120 euros.");
writeFileSync(join(lefevre, "devis-lefevre.txt"), "Devis Lefèvre : honoraires de 2 980 euros.");
writeFileSync(join(lefevre, "facture-lefevre.txt"), "Facture Lefèvre : honoraires de 1 640 euros.");
test.after(async () => {
  await app.close();
  rmSync(base, { recursive: true, force: true });
});

async function indexed() {
  await reindex(owner);
  while (indexStatus(owner).running) await new Promise((resolve) => setTimeout(resolve, 20));
}

assert.equal((await app.inject({ method: "POST", url: "/local_documents/folders", headers: desktop, payload: { path: cabinet } })).statusCode, 201);
await indexed();
const projects: Record<string, string> = {};
for (const [title, folder] of [["Tessane SAS", tessane], ["Varlin", varlin], ["Lefèvre", lefevre]] as const) {
  const made = await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title, isolated: true, folder_path: folder } });
  assert.equal(made.statusCode, 201, made.body);
  projects[title] = (made.json().project as { id: string }).id;
}
await indexed();
const QUESTION = "honoraires lettre de mission bilan provision contrat avenant devis facture";
/// Each project's walled-off folder as it was linked (document_folders.id).
const wallIds = Object.fromEntries(Object.values(projects).map((project) => [project, listFolders(owner).find((folder) => folder.project_id === project)!.id]));

type Folder = ReturnType<typeof listFolders>[number];
const generalRoots = () => listFolders(owner).filter((folder) => folder.project_id === null);
const generalId = () => generalRoots().find((folder) => folder.path === cabinet)!.id;
const wallOf = (project: string) => listFolders(owner).find((folder) => folder.id === wallIds[project]) as Folder & { state: string; found: string | null; found_by: string | null };
/// What the general chat's search finds (the phone and the other computers search the same folders: scopedFolders).
const generalSearch = (question = QUESTION) => JSON.stringify(searchPassages(owner, question, 30, scopedFolders(owner, { mode: "all" }).map((folder) => folder.id)));
/// What a walled-off project's conversation finds.
const projectSearch = (project: string, question = QUESTION) => JSON.stringify(searchPassages(owner, question, 30, scopedFolders(owner, { mode: "all" }, { project }).map((folder) => folder.id)));
const documentIds = (project: string) =>
  (sqlite.prepare("SELECT d.id FROM documents d JOIN document_folders f ON f.id = d.folder_id WHERE d.user_id = ? AND f.project_id = ? ORDER BY d.id").all(owner, project) as Array<{ id: string }>).map((row) => row.id);

/// Every reader of the general folder, asked about `moved` (a walled-off
/// folder's new place) and the names of its documents: what reached it.
async function leaks(moved: string, names: RegExp): Promise<string[]> {
  const found: string[] = [];
  const roots = generalRoots();
  const listed = await listGrantedFiles({ intent: { folder: null, folderName: null, sort: "name", kinds: [], limit: 30 }, roots, granted: roots });
  if (names.test(JSON.stringify(listed.files))) found.push("listed with the general folder's files");
  const rel = relative(cabinet, moved).split(/[\\/]/).join("/");
  for (const folder of [`Cabinet/${rel}`, basename(moved)]) {
    const one = await listFolder({ request: readFolderRequest({ folder, recursive: true })!, roots, granted: roots });
    if (names.test(JSON.stringify(one))) found.push(`list_files « ${folder} »`);
  }
  // Browsed (a share, another computer, the Documents screen): not among
  // its parent's entries, not entered.
  const outside = scopedFolders(owner, { mode: "all" });
  const segments = rel.split("/");
  const browse = (path: string) => browseGranted(owner, outside, { root: generalId(), path, sort: "name", order: "asc", offset: 0, limit: 100, q: null });
  const parent = await browse(segments.slice(0, -1).join("/"));
  if ("entries" in parent && parent.entries.some((entry) => entry.name === segments.at(-1))) found.push(`listed when browsing « ${segments.slice(0, -1).join("/") || "/"} »`);
  if ("entries" in (await browse(rel))) found.push(`browsed « ${rel} »`);
  const searched = await browseGranted(owner, outside, { root: generalId(), path: "", sort: "name", order: "asc", offset: 0, limit: 100, q: "lettre" });
  if ("entries" in searched && names.test(JSON.stringify(searched.entries))) found.push("found by the browser's search");
  for (const file of [join(moved, "lettre-de-mission.txt"), join(moved, "contrat-varlin.txt"), join(moved, "devis-lefevre.txt")]) {
    if (spotlightOwner(file, roots)) found.push(`Spotlight's candidate ${basename(file)} read under the general folder`);
  }
  const { roots: acting } = actionRoots(owner);
  const general = acting.find((root) => root.path === cabinet)!;
  if (!walledAt(general, moved)) found.push("« Agir dans vos dossiers » may act in it");
  const asked = await findFolder(owner, [basename(moved)], null);
  if (asked.status === "ok") found.push(`« Agir dans vos dossiers » found « ${basename(moved)} »`);
  return found;
}

test("before: nothing of the three walled-off folders from the general folder", async () => {
  assert.deepEqual(await leaks(tessane, /lettre-de-mission|bilan-tessane/), []);
  assert.doesNotMatch(generalSearch(), /7 450|26 000|11 300|4 120|2 980|1 640/);
  assert.match(generalSearch("photocopieuse"), /photocopieuse/);
  assert.match(projectSearch(projects["Tessane SAS"]!), /7 450/);
  // Each walled-off folder is known by its identity from the moment it is linked.
  const rows = sqlite.prepare("SELECT path, identity, volume FROM document_folders WHERE user_id = ? AND project_id IS NOT NULL").all(owner) as Array<{ path: string; identity: string | null; volume: string | null }>;
  assert.equal(rows.length, 3);
  for (const row of rows) assert.ok(row.identity && /^\d+:\d+$/.test(row.identity) && row.volume, JSON.stringify(row));
});

test("attack 1: the walled-off folder renamed in place (Tessane → Tessane-2026), and a new Tessane made beside it", async () => {
  const project = projects["Tessane SAS"]!;
  const ids = documentIds(project);
  const moved = join(cabinet, "Tessane-2026");
  renameSync(tessane, moved);
  // At once, before Twoody has looked: walled off where it is now.
  assert.deepEqual(await leaks(moved, /lettre-de-mission|bilan-tessane/), []);
  // The firm starts the year's folder under the old name.
  mkdirSync(tessane);
  writeFileSync(join(tessane, "piece-2027.txt"), "Pièce Tessane 2027 : acompte de 3 310 euros.");
  await indexed();
  // Followed: the project's folder is where it is now, its index kept as it was.
  const wall = wallOf(project);
  assert.equal(wall.path, moved);
  assert.equal(wall.state, "ok");
  assert.deepEqual(documentIds(project).filter((id) => ids.includes(id)).sort(), [...ids].sort(), "its documents' index kept, not read again");
  assert.match(projectSearch(project), /7 450/);
  assert.match(projectSearch(project), /26 000/);
  // The folder left under the old name stays the project's, never the general folder's.
  const kept = listFolders(owner).find((folder) => folder.path === tessane);
  assert.equal(kept?.project_id, project);
  assert.match(projectSearch(project, "pièce acompte"), /3 310/);
  assert.doesNotMatch(generalSearch(), /7 450|26 000/);
  assert.doesNotMatch(generalSearch("pièce acompte"), /3 310/);
  assert.deepEqual(await leaks(moved, /lettre-de-mission|bilan-tessane/), []);
  assert.deepEqual(await leaks(tessane, /piece-2027/), []);
  // A share of the general folder and « Agir dans vos dossiers » keep out of both.
  for (const path of [moved, join(moved, "Pieces"), tessane]) {
    assert.ok(isolatedInside(owner, cabinet).some((wall) => within(wall, path)), path);
    assert.equal(touchesWall(path, actionRoots(owner).walls), true, path);
  }
  // The Desktop (the Agent and Twoody Code take their walls from here) is
  // told the new place; a phone never gets the walls.
  const mine = (await app.inject({ method: "GET", url: "/local_documents/folders", headers: desktop })).json().folders as Array<Record<string, unknown>>;
  assert.ok(mine.some((folder) => folder.project_id === project && folder.path === moved && folder.state === "ok"));
  assert.ok(mine.every((folder) => !("walledIds" in folder) && !("walledPrints" in folder)));
  const theirs = (await app.inject({ method: "GET", url: "/local_documents/folders", headers: phone })).json().folders as Array<Record<string, unknown>>;
  assert.ok(theirs.length > 0 && theirs.every((folder) => folder.project_id === null && !("walled" in folder) && !("walledIds" in folder) && !("walledPrints" in folder)));
  const searched = await app.inject({ method: "GET", url: `/local_documents/search?q=${encodeURIComponent(QUESTION)}`, headers: phone });
  assert.doesNotMatch(searched.body, /7 450|26 000|3 310/);
});

test("attack 2: its parent renamed (Clients → Dossiers)", async () => {
  const project = projects["Varlin"]!;
  const ids = documentIds(project);
  renameSync(join(cabinet, "Clients"), join(cabinet, "Dossiers"));
  const moved = join(cabinet, "Dossiers", "Varlin");
  assert.deepEqual(await leaks(moved, /contrat-varlin|avenant-varlin/), []);
  await indexed();
  assert.equal(wallOf(project).path, moved);
  assert.deepEqual(documentIds(project).sort(), [...ids].sort());
  assert.match(projectSearch(project), /11 300/);
  assert.doesNotMatch(generalSearch(), /11 300|4 120/);
  assert.deepEqual(await leaks(moved, /contrat-varlin|avenant-varlin/), []);
  assert.ok(isolatedInside(owner, cabinet).some((wall) => within(wall, join(moved, "contrat-varlin.txt"))));
});

test("attack 3: moved under the general folder from outside it (Externe/Lefevre → Cabinet/Archives/Lefevre)", async () => {
  const project = projects["Lefèvre"]!;
  const ids = documentIds(project);
  mkdirSync(join(cabinet, "Archives"));
  const moved = join(cabinet, "Archives", "Lefevre");
  renameSync(lefevre, moved);
  assert.deepEqual(await leaks(moved, /devis-lefevre|facture-lefevre/), []);
  await indexed();
  assert.equal(wallOf(project).path, moved);
  assert.deepEqual(documentIds(project).sort(), [...ids].sort());
  assert.match(projectSearch(project), /2 980/);
  assert.doesNotMatch(generalSearch(), /2 980|1 640/);
  assert.deepEqual(await leaks(moved, /devis-lefevre|facture-lefevre/), []);
  assert.ok(isolatedInside(owner, cabinet).some((wall) => within(wall, moved)));
});

test("attack 4: moved with a new identity — a copy, then the original removed (as to another disk): nothing new is read until its documents are found; walled there, proposed, never followed alone", async () => {
  const project = projects["Tessane SAS"]!;
  const original = wallOf(project).path;
  const copy = join(cabinet, "Archives", "Tessane-copie");
  cpSync(original, copy, { recursive: true, preserveTimestamps: true });
  rmSync(original, { recursive: true });
  // Missing, before any pass: an index pass is asked for, and nothing new is
  // read anywhere outside the project meanwhile.
  await checkWalls(owner);
  assert.ok(askedToLook.includes(owner), "a pass is asked to look for it");
  assert.equal(wallOf(project).state, "missing");
  const roots = generalRoots();
  assert.ok(roots.every((folder) => folder.paused));
  assert.equal((await listGrantedFiles({ intent: { folder: null, folderName: null, sort: "name", kinds: [], limit: 30 }, roots, granted: roots })).status, "paused");
  assert.equal((await listFolder({ request: readFolderRequest({ folder: "Cabinet/Archives", recursive: true })!, roots, granted: roots })).status, "paused");
  assert.deepEqual(await browseGranted(owner, scopedFolders(owner, { mode: "all" }), { root: generalId(), path: "", sort: "name", order: "asc", offset: 0, limit: 100, q: null }), { error: "paused" });
  assert.equal((await findFolder(owner, ["Archives"], null)).status, "paused");
  assert.ok(isolatedInside(owner, cabinet).some((wall) => within(wall, join(copy, "lettre-de-mission.txt")) && within(wall, join(cabinet, "Courant"))));
  const browsed = await app.inject({ method: "GET", url: `/local_documents/browse?root=${generalId()}&path=`, headers: desktop });
  assert.equal(browsed.json().error, "folder_paused", browsed.body);
  // What was indexed before stays searchable; its project keeps its index.
  assert.match(generalSearch("photocopieuse"), /photocopieuse/);
  assert.match(projectSearch(project), /7 450/);
  // The next pass finds it by its documents.
  await indexed();
  const wall = wallOf(project);
  assert.equal(wall.state, "elsewhere");
  assert.equal(wall.found, copy);
  assert.equal(wall.found_by, "documents");
  assert.equal(wall.path, original, "never followed on its documents alone");
  assert.ok(generalRoots().every((folder) => !folder.paused), "found: nothing waits any more");
  assert.doesNotMatch(generalSearch(), /7 450|26 000/);
  assert.deepEqual(await leaks(copy, /lettre-de-mission|bilan-tessane/), []);
  assert.ok(isolatedInside(owner, cabinet).some((wall) => within(wall, join(copy, "Pieces", "bilan-tessane.txt"))));
  assert.match(projectSearch(project), /7 450/);
  // The project's page says so — where, to this computer's app only.
  const page = (await app.inject({ method: "GET", url: `/api/v1/projects/${project}`, headers: desktop })).json().project as { folders: Array<{ id: string; path: string; state: string; found: string | null; found_by: string | null }> };
  const folder = page.folders.find((each) => each.path === original)!;
  assert.deepEqual({ state: folder.state, found: folder.found, found_by: folder.found_by }, { state: "elsewhere", found: copy, found_by: "documents" });
  // A device that is not the person's own does not know the project exists.
  assert.equal((await app.inject({ method: "GET", url: `/api/v1/projects/${project}`, headers: phone })).statusCode, 404);
  // « Retrouver le dossier »: from this computer's app only.
  const refused = await app.inject({ method: "PUT", url: `/api/v1/projects/${project}/folders/${folder.id}`, headers: phone, payload: { path: copy } });
  assert.equal(refused.statusCode, 404);
  const relinked = await app.inject({ method: "PUT", url: `/api/v1/projects/${project}/folders/${folder.id}`, headers: desktop, payload: { path: copy } });
  assert.equal(relinked.statusCode, 200, relinked.body);
  await indexed();
  assert.deepEqual({ path: wallOf(project).path, state: wallOf(project).state }, { path: copy, state: "ok" });
  assert.match(projectSearch(project), /7 450/);
  assert.match(projectSearch(project), /26 000/);
  assert.doesNotMatch(generalSearch(), /7 450|26 000/);
  assert.deepEqual(await leaks(copy, /lettre-de-mission|bilan-tessane/), []);
});

test("found nowhere, its disk connected: nothing new is read outside its project until it is found again; then everything goes on", async () => {
  const project = projects["Varlin"]!;
  const away = join(base, "Ailleurs", "Varlin");
  mkdirSync(join(base, "Ailleurs"));
  renameSync(wallOf(project).path, away);
  writeFileSync(join(cabinet, "Courant", "nouvelle-note.txt"), "Note nouvelle : réunion d'équipe jeudi.");
  await indexed();
  assert.equal(wallOf(project).state, "missing");
  // Nothing new under the general folder, nor in another walled-off project.
  assert.doesNotMatch(generalSearch("réunion équipe jeudi"), /réunion d'équipe/);
  assert.match(generalSearch("photocopieuse"), /photocopieuse/);
  assert.ok(generalRoots().every((folder) => folder.paused));
  assert.ok(listFolders(owner).filter((folder) => folder.project_id === projects["Lefèvre"]).every((folder) => folder.paused));
  assert.ok(listFolders(owner).filter((folder) => folder.project_id === project).every((folder) => !folder.paused), "its own folders do not wait");
  // Its project keeps its index meanwhile.
  assert.match(projectSearch(project), /11 300/);
  // Found again where the person says it is.
  const id = wallOf(project).id;
  const relinked = await app.inject({ method: "PUT", url: `/api/v1/projects/${project}/folders/${id}`, headers: desktop, payload: { path: away } });
  assert.equal(relinked.statusCode, 200, relinked.body);
  await indexed();
  assert.equal(wallOf(project).state, "ok");
  assert.ok(generalRoots().every((folder) => !folder.paused));
  assert.match(generalSearch("réunion équipe jeudi"), /réunion d'équipe/);
  assert.match(projectSearch(project), /11 300/);
  assert.doesNotMatch(generalSearch(), /11 300|4 120/);
});

test("« Retrouver le dossier » pointed at another folder: said first (folder_not_same) and nothing changes; linked once the person confirms", async () => {
  const garnier = join(base, "Externe", "Garnier");
  mkdirSync(garnier, { recursive: true });
  writeFileSync(join(garnier, "mandat-garnier.txt"), "Mandat Garnier : honoraires de 6 210 euros.");
  const made = await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Garnier", isolated: true, folder_path: garnier } });
  assert.equal(made.statusCode, 201, made.body);
  const project = (made.json().project as { id: string }).id;
  await indexed();
  const id = listFolders(owner).find((folder) => folder.project_id === project)!.id;
  const folder = () => listFolders(owner).find((each) => each.id === id) as Folder & { state: string };
  // Put where Twoody does not look (the Trash, say): found nowhere, everything else waits.
  mkdirSync(join(base, "Corbeille"));
  renameSync(garnier, join(base, "Corbeille", "Garnier"));
  await indexed();
  assert.equal(folder().state, "missing");
  assert.ok(generalRoots().every((each) => each.paused));
  // Another folder, neither the same one nor holding its documents: said, nothing done.
  const other = join(base, "Autre-dossier");
  mkdirSync(other);
  writeFileSync(join(other, "sans-rapport.txt"), "Rien à voir avec Garnier.");
  const asked = await app.inject({ method: "PUT", url: `/api/v1/projects/${project}/folders/${id}`, headers: desktop, payload: { path: other } });
  assert.equal(asked.statusCode, 409, asked.body);
  assert.equal(asked.json().error, "folder_not_same");
  assert.deepEqual({ path: folder().path, state: folder().state }, { path: garnier, state: "missing" });
  assert.ok(generalRoots().every((each) => each.paused), "still waiting: nothing was linked");
  // Neither from a phone, confirmed or not.
  assert.equal((await app.inject({ method: "PUT", url: `/api/v1/projects/${project}/folders/${id}`, headers: phone, payload: { path: other, confirm: true } })).statusCode, 404);
  // The person says it is the one: linked, and nothing waits any more.
  const linked = await app.inject({ method: "PUT", url: `/api/v1/projects/${project}/folders/${id}`, headers: desktop, payload: { path: other, confirm: true } });
  assert.equal(linked.statusCode, 200, linked.body);
  await indexed();
  assert.deepEqual({ path: folder().path, state: folder().state }, { path: other, state: "ok" });
  assert.ok(generalRoots().every((each) => !each.paused));
  assert.match(projectSearch(project, "rien à voir"), /Rien à voir/);
  assert.doesNotMatch(generalSearch("rien à voir"), /Rien à voir/);
});

test("its disk not connected: nothing waits, and none of its documents is read elsewhere meanwhile", async () => {
  const project = projects["Lefèvre"]!;
  const wall = wallOf(project);
  // As if it were on a network drive out of reach: its disk's root is not there.
  sqlite.prepare("UPDATE document_folders SET volume = ? WHERE id = ?").run(join(base, "Volumes", "NAS"), wall.id);
  mkdirSync(join(base, "Hors-ligne"));
  const away = join(base, "Hors-ligne", "Lefevre");
  renameSync(wall.path, away);
  // One of its documents copied into the general folder, as it was.
  cpSync(join(away, "devis-lefevre.txt"), join(cabinet, "Courant", "devis-lefevre.txt"), { preserveTimestamps: true });
  writeFileSync(join(cabinet, "Courant", "compte-rendu.txt"), "Compte rendu : nouveau fournisseur de papier.");
  await checkWalls(owner);
  assert.equal(wallOf(project).state, "unreachable");
  assert.ok(generalRoots().every((folder) => !folder.paused));
  const roots = generalRoots();
  const listed = await listGrantedFiles({ intent: { folder: null, folderName: null, sort: "name", kinds: [], limit: 30 }, roots, granted: roots });
  assert.equal(listed.status, "ok");
  assert.match(JSON.stringify(listed.files), /note-interne/);
  assert.doesNotMatch(JSON.stringify(listed.files), /devis-lefevre/);
  await indexed();
  assert.equal(wallOf(project).state, "unreachable", "one copy of two documents is not the folder");
  assert.match(generalSearch("fournisseur papier"), /nouveau fournisseur/);
  assert.doesNotMatch(generalSearch(), /2 980/);
  assert.match(projectSearch(project), /2 980/);
});

test("a disk mounted again under another device number: still known by its file number, followed when moved", async () => {
  const morel = join(cabinet, "Morel");
  mkdirSync(morel);
  writeFileSync(join(morel, "statuts-morel.txt"), "Statuts Morel SARL : capital de 9 870 euros.");
  const made = await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Morel", isolated: true, folder_path: morel } });
  assert.equal(made.statusCode, 201, made.body);
  const project = (made.json().project as { id: string }).id;
  await indexed();
  const row = sqlite.prepare("SELECT id, identity FROM document_folders WHERE project_id = ? AND user_id = ?").get(project, owner) as { id: string; identity: string };
  const [device, number] = row.identity.split(":") as [string, string];
  const before = `${BigInt(device) + 1n}:${number}`;
  // Seen last under another device number: the same folder, its number kept.
  sqlite.prepare("UPDATE document_folders SET identity = ? WHERE id = ?").run(before, row.id);
  await checkWalls(owner);
  assert.equal((sqlite.prepare("SELECT identity FROM document_folders WHERE id = ?").get(row.id) as { identity: string }).identity, row.identity);
  // Moved while known under the other number: walled off by its file number.
  sqlite.prepare("UPDATE document_folders SET identity = ? WHERE id = ?").run(before, row.id);
  const moved = join(cabinet, "Courant", "Morel-archive");
  renameSync(morel, moved);
  await checkWalls(owner);
  assert.deepEqual(await leaks(moved, /statuts-morel/), []);
  await indexed();
  assert.equal(listFolders(owner).find((folder) => folder.id === row.id)?.path, moved);
  assert.match(projectSearch(project, "statuts capital"), /9 870/);
  assert.doesNotMatch(generalSearch("statuts capital"), /9 870/);
});

test("where a walled-off folder's document says the folder is, and whether a disk is there", async () => {
  const { placeFromDocument, volumeConnected, volumeOf, walledIdentity, printMatch } = await import("../src/documents/wallIdentity.js");
  // Its documents as they were in it: the folder holding them the same way.
  assert.equal(placeFromDocument(join(base, "X", "Tessane", "Pieces", "bilan.txt"), join("Pieces", "bilan.txt")), join(base, "X", "Tessane"));
  // Moved elsewhere inside it: the file's own folder.
  assert.equal(placeFromDocument(join(base, "X", "Autre", "bilan.txt"), join("Pieces", "bilan.txt")), join(base, "X", "Autre"));
  // A disk's root is connected; a plain folder (an empty mount point left behind) or nothing is not.
  const volume = volumeOf(base)!;
  assert.ok(volume && within(volume, base));
  assert.equal(volumeConnected(volume), true);
  assert.equal(volumeConnected(cabinet), false);
  assert.equal(volumeConnected(join(base, "Volumes", "NAS")), false);
  // By its identity, or by its file number on any device.
  assert.equal(walledIdentity(new Set(["5:42"]), "5:42"), true);
  assert.equal(walledIdentity(new Set(["5:42"]), "6:42"), false);
  assert.equal(walledIdentity(new Set(["5:42", "*:42"]), "6:42"), true);
  assert.equal(walledIdentity(new Set(["*:42"]), null), false);
  // A document by its name, size and date — to two seconds, as FAT keeps it.
  const prints = { names: new Set(["bilan.txt"]), byName: new Map([["bilan.txt", [{ size: 10, mtime: 1_000_000, wall: "w", rel: "bilan.txt" }]]]), counts: new Map([["w", 1]]) };
  assert.ok(printMatch(prints, "bilan.txt", 10, 1_001_999));
  assert.equal(printMatch(prints, "bilan.txt", 10, 1_002_500), null);
  assert.equal(printMatch(prints, "bilan.txt", 11, 1_000_000), null);
});

test("moved into another walled-off project's folder: walled there, never followed, never read by that project", async () => {
  const roussel = join(cabinet, "Roussel");
  mkdirSync(roussel);
  writeFileSync(join(roussel, "bail-roussel.txt"), "Bail Roussel : loyer de 5 550 euros.");
  const made = await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Roussel", isolated: true, folder_path: roussel } });
  assert.equal(made.statusCode, 201, made.body);
  const project = (made.json().project as { id: string }).id;
  await indexed();
  const id = listFolders(owner).find((folder) => folder.project_id === project)!.id;
  const morel = listFolders(owner).find((folder) => folder.path.endsWith("Morel-archive"))!;
  const moved = join(morel.path, "Roussel");
  renameSync(roussel, moved);
  // Morel's own conversations do not see it, at once.
  const morelRoots = scopedFolders(owner, { mode: "all" }, { project: morel.project_id! });
  const listed = await listGrantedFiles({ intent: { folder: null, folderName: null, sort: "name", kinds: [], limit: 30 }, roots: morelRoots, granted: morelRoots });
  assert.match(JSON.stringify(listed.files), /statuts-morel/);
  assert.doesNotMatch(JSON.stringify(listed.files), /bail-roussel/);
  await indexed();
  const wall = listFolders(owner).find((folder) => folder.id === id) as Folder & { state: string; found: string | null; found_by: string | null };
  assert.deepEqual({ path: wall.path, state: wall.state, found: wall.found, found_by: wall.found_by }, { path: roussel, state: "elsewhere", found: moved, found_by: "identity" });
  assert.doesNotMatch(projectSearch(morel.project_id!, "bail loyer"), /5 550/);
  assert.doesNotMatch(generalSearch("bail loyer"), /5 550/);
  assert.match(projectSearch(project, "bail loyer"), /5 550/);
  // Pointed there by the person: refused, a document belongs to one project.
  const relinked = await app.inject({ method: "PUT", url: `/api/v1/projects/${project}/folders/${id}`, headers: desktop, payload: { path: moved } });
  assert.equal(relinked.statusCode, 409);
  assert.equal(relinked.json().error, "other_project_folder");
  // The Desktop is told what it is and where it was found.
  const mine = (await app.inject({ method: "GET", url: "/local_documents/folders", headers: desktop })).json().folders as Array<Record<string, unknown>>;
  const told = mine.find((folder) => folder.id === id)!;
  assert.equal(told.found, moved);
  assert.match(String(told.identity), /^\d+:\d+$/);
});
