import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { folderReadable, skipDirectory, skipFile, walk } from "../src/documents/walk.js";

// What the walk of a granted folder — the home folder above all — never
// enters or reads.

const root = mkdtempSync(join(tmpdir(), "twoody-walk-"));
after(() => {
  try { chmodSync(join(root, "Locked"), 0o755); } catch { /* the permission test was skipped */ }
  rmSync(root, { recursive: true, force: true });
});

function file(path: string, text = "Un document.") {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

test("keys, application data, developer trees, caches, libraries and applications are skipped", () => {
  for (const name of [".ssh", ".gnupg", ".aws", ".git", ".cache", ".Trash", "Library", "library", "AppData", "Keychains", "node_modules", "__pycache__", "Caches", "Applications",
    "Photos Library.photoslibrary", "Music Library.musiclibrary", "Twoody.app", "Morceau.logicx", "Chanson.band"]) {
    assert.equal(skipDirectory(name), true, name);
  }
  for (const name of ["Documents", "Downloads", "Desktop", "Factures 2026", "OneDrive", "Mobile Documents", "Photos", "Music", "app", "Rapport.appendix"]) {
    assert.equal(skipDirectory(name), false, name);
  }
  for (const name of [".env.txt", "~$rapport.docx", "credentials.txt", "secrets.md", "token-github.txt", "passwords.csv", "service-account.json"]) {
    assert.equal(skipFile(name), true, name);
  }
  for (const name of ["Rapport.pdf", "Contrat.docx", "notes.txt"]) assert.equal(skipFile(name), false, name);
});

test("walking a home folder reads the documents and leaves the rest", async () => {
  for (const kept of ["Documents/Contrat.txt", "Downloads/Facture.txt", "Desktop/Notes.md", "Documents/Projets/site/README.md"]) file(kept);
  for (const left of [
    ".ssh/id_ed25519.txt", ".aws/credentials.txt", "Library/Keychains/login.txt", "Library/Mail/message.txt",
    "Documents/Projets/site/node_modules/pkg/README.md", "Documents/Projets/site/.git/HEAD.txt",
    "Pictures/Photos Library.photoslibrary/database/notes.txt", "Music/Music Library.musiclibrary/notes.txt",
    "Applications/Outil.app/Contents/notes.txt", "Documents/secrets.txt", ".notes.txt",
  ]) file(left);
  symlinkSync(join(root, "Library"), join(root, "Documents", "raccourci"));

  const { files, limited, denied } = await walk(root);
  assert.deepEqual(files.map((path) => relative(root, path)).sort(), ["Desktop/Notes.md", "Documents/Contrat.txt", "Documents/Projets/site/README.md", "Downloads/Facture.txt"]);
  assert.equal(limited, false);
  assert.deepEqual(denied, []);
});

test("a folder the system refuses is named, not silently empty", { skip: process.getuid?.() === 0 }, async () => {
  file("Locked/Secret.txt");
  chmodSync(join(root, "Locked"), 0o000);
  assert.equal(await folderReadable(join(root, "Locked")), false);
  assert.equal(await folderReadable(join(root, "Documents")), true);
  assert.equal(await folderReadable(join(root, "Absent")), true); // left to canonicalFolder: not_found
  const { denied } = await walk(root);
  assert.deepEqual(denied, [join(root, "Locked")]);
});
