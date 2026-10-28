import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

// Files only online (28/10/2026, Namestorm's project folders in OneDrive):
// reading one makes the system download it, so the index pass leaves them
// unread — counted and named — unless the person has the folder's files only
// online downloaded and read. Here the system's answer is stood in for
// (setOnlineOnlyForTests); the readers of the helper's and stat's lines are
// tested as they are.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-cloud-files-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;
delete process.env.TWOODY_OCR_BIN;

const { sqlite } = await import("../src/db.js");
const { addFolder, listFolders, reindex, searchPassages, setCloudFiles } = await import("../src/documents/library.js");
const { folderRisk } = await import("../src/documents/folderRisk.js");
const { setSpotlightEnabled } = await import("../src/documents/spotlight.js");
const { macFromLines, setOnlineOnlyForTests, windowsFromLines, WINDOWS_ONLINE_ONLY } = await import("../src/documents/cloudFiles.js");
setSpotlightEnabled(false);

const home = realpathSync(homedir());
const tmpBase = realpathSync(tmpdir());
const base = folderRisk(join(tmpBase, "x"), home) === null ? tmpBase : home;
const docs = realpathSync(mkdtempSync(join(base, "twoody-cloud-files-docs-")));
test.after(() => {
  setOnlineOnlyForTests(null);
  const trash = join(homedir(), ".Trash");
  mkdirSync(trash, { recursive: true });
  renameSync(docs, join(trash, `${basename(docs)}-${Date.now()}`));
});

const userId = "owner";
sqlite.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(userId, "owner@test.invalid", Date.now());
writeFileSync(join(docs, "Briefing.txt"), "Briefing Velora : le nom doit tenir en trois syllabes.");
writeFileSync(join(docs, "Contrat signé.txt"), "Contrat Velora : honoraires de 18 000 euros.");
const online = new Set([join(docs, "Contrat signé.txt")]);
const asked: string[][] = [];
setOnlineOnlyForTests(async (paths) => {
  asked.push(paths);
  return new Set(paths.filter((path) => online.has(path)));
});
const status = (name: string) => (sqlite.prepare("SELECT status FROM documents WHERE name = ?").get(name) as { status: string } | undefined)?.status;
const folderNow = () => listFolders(userId)[0]!;

test("a file only online is left unread, counted, and never searched", async () => {
  await addFolder(userId, docs);
  await reindex(userId);
  assert.equal(status("Briefing.txt"), "indexed");
  assert.equal(status("Contrat signé.txt"), "online_only");
  assert.equal(folderNow().online_only, 1);
  assert.equal(folderNow().cloud_files, null);
  assert.equal(searchPassages(userId, "honoraires").length, 0);
  assert.equal(searchPassages(userId, "syllabes").length, 1);
});

test("an unchanged file read before is not asked about again; one left unread is, at every pass", async () => {
  asked.length = 0;
  await reindex(userId);
  assert.deepEqual(asked, [[join(docs, "Contrat signé.txt")]]);
  assert.equal(status("Contrat signé.txt"), "online_only");
});

test("downloaded on the computer since, it is read at the next pass", async () => {
  online.clear();
  await reindex(userId);
  assert.equal(status("Contrat signé.txt"), "indexed");
  assert.equal(searchPassages(userId, "honoraires").length, 1);
  assert.equal(folderNow().online_only, 0);
});

test("« Les télécharger et les lire »: the folder's files only online are read, and the system is not even asked", async () => {
  writeFileSync(join(docs, "Mail.txt"), "Le client préfère Lumo.");
  online.add(join(docs, "Mail.txt"));
  await reindex(userId);
  assert.equal(status("Mail.txt"), "online_only");
  assert.ok(setCloudFiles(userId, folderNow().id, true));
  assert.equal(folderNow().cloud_files, "read");
  asked.length = 0;
  await reindex(userId);
  assert.equal(status("Mail.txt"), "indexed");
  assert.deepEqual(asked, []);
  assert.ok(setCloudFiles(userId, folderNow().id, false));
  assert.equal(folderNow().cloud_files, null);
  assert.equal(setCloudFiles("someone-else", folderNow().id, true), false);
});

test("the Windows helper's lines and stat's lines are read as the system writes them", () => {
  const paths = ["C:\\a.docx", "C:\\b.docx", "C:\\c.docx", "C:\\d.docx"];
  // ARCHIVE; RECALL_ON_DATA_ACCESS | ARCHIVE; unreadable; OFFLINE.
  const found = windowsFromLines(paths, `32\r\n${0x400000 | 32}\r\n-1\r\n${0x1000}\r\n`);
  assert.deepEqual([...found], ["C:\\b.docx", "C:\\d.docx"]);
  assert.ok(WINDOWS_ONLINE_ONLY & 0x40000, "recall on open too");
  const mac = macFromLines(["/Users/x/iCloud/a.pdf", "/Users/x/iCloud/b.pdf", "/Users/x/iCloud/c pdf\tx.pdf"], `0\t/Users/x/iCloud/a.pdf\n${0x40000000}\t/Users/x/iCloud/b.pdf\n${0x40000000}\t/Users/x/iCloud/c pdf\tx.pdf\n`);
  assert.deepEqual([...mac], ["/Users/x/iCloud/b.pdf", "/Users/x/iCloud/c pdf\tx.pdf"]);
});
